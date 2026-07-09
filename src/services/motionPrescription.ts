// simMOVE Clinical Motion Engine — L2 motion prescription (the shared contract).
//
// A MotionPrescription is the structured request that sits ABOVE the named-clip
// vocabulary (MotionCommand) and BELOW the command surface (voice/text → intent).
// It says "perform THIS motion, with THESE clinical modifiers" and resolves to a
// base MotionCommand plus a residual modifier set the runtime applies per frame.
//
// INTEGRITY (mirrors movementTools.js `request_movement`, deliberately):
//   - A prescription is a REQUEST, not a result. The stage clamps every motion
//     through normative ROM + the scenario's authored constraints regardless of
//     what was asked; the caller only learns what the mannequin visibly did.
//   - The LLM-facing tool is a NARROW subset — it may pick a `motion` (and at
//     most coarse intent), never author `modifiers`. Clinical modifiers come
//     from the scenario/preset SERVER-SIDE, so a patient can't widen its own
//     capabilities or leak authored values. Keep this file free of answers:
//     no findings, no expected angles, no scenario constraint values.
//
// This is the pure contract + resolver. The per-frame application of the
// residual modifiers (ROM caps, overlays) lives in the stage runtime.

import type { MovementClipId } from '../types';
import type { MotionCommand } from './motionCommand';
import { getRomJointDefinition, getRomFieldDefinition } from './romRegistry';
import type { RomScenarioConstraints } from './romConstraints';

export type ClinicalRegion =
  | 'neck'
  | 'shoulder'
  | 'trunk'
  | 'low_back'
  | 'hip'
  | 'knee'
  | 'ankle';
export type Side = 'left' | 'right' | 'bilateral';

/** A ceiling/floor on one ROM field, enforced while the motion plays. Keys are
 *  ROM-registry canonical keys (joint) + field keys — the same vocabulary the
 *  live angle HUD grades against, so a cap and its readout always agree. */
export interface RomCap {
  /** ROM canonical joint key, e.g. 'R_Leg' (right knee), 'Spine_Lower'. */
  joint: string;
  /** ROM field key, e.g. 'flexion'. */
  field: string;
  /** Max degrees the field may reach (per the field's sign convention). */
  maxDeg?: number;
  /** Min degrees the field may reach. */
  minDeg?: number;
}

/**
 * Deterministic clinical modifiers. Only `timeScale` and `romCaps` are wired in
 * the first runtime pass (Build B); the rest are typed now so the schema is the
 * stable contract as later builds implement them.
 */
export interface ClinicalModifiers {
  /** Playback speed: 1 = normal, <1 slower, >1 faster. Folds into MotionCommand.speed. */
  timeScale?: number;
  /** Per-joint excursion limits enforced each frame during playback. */
  romCaps?: RomCap[];
  // ── typed for later builds (not yet applied by the runtime) ──
  /** 0..1 trunk stiffness + reduced angular velocity. */
  guarding?: number;
  /** Per-side weight-bearing bias. */
  weightBearing?: Partial<Record<Side, 'reduced' | 'normal' | 'increased'>>;
  /** Lateral pelvis shift in cm (weight-shift away from a painful limb). */
  pelvisShiftCm?: number;
  /** 0..1 low-frequency postural sway. */
  balanceSway?: number;
  /** Props the hands/feet contact during the motion (drives IK contact targets). */
  assistiveSupport?: ('armrests' | 'walker' | 'cane' | 'table' | 'rail')[];
}

export type MotionExecutionMode = 'play' | 'modify' | 'generate';

/** The L2 request. `generate` is reserved for L3 (produces a candidate offline). */
export interface MotionPrescription {
  /** Base named motion (or the first step of {@link sequence}). */
  motion: MovementClipId;
  /** 'play' = unmodified catalog clip; 'modify' = apply {@link modifiers}. */
  mode: MotionExecutionMode;
  /** Optional multi-step transfer (sit → side-lying → supine). Played in order. */
  sequence?: MovementClipId[];
  modifiers?: ClinicalModifiers;
  /** Human-readable clinical label for logging/telemetry — never an answer. */
  label?: string;
}

/** What the runtime needs: the base command, plus the residual modifiers it
 *  applies per frame (timing already folded into the command's speed). */
export interface ResolvedPrescription {
  command: MotionCommand;
  /** ROM caps to enforce each frame (validated against the registry). */
  romCaps: RomCap[];
  /** Residual overlay modifiers (guarding / sway / weight-shift) for later builds. */
  overlays: Omit<ClinicalModifiers, 'timeScale' | 'romCaps'>;
  sequence: MovementClipId[];
}

export interface PrescriptionIssue {
  path: string;
  message: string;
}

/** Validate a prescription against the motion catalog + ROM registry. Pure. */
export function validateMotionPrescription(
  rx: MotionPrescription,
  isKnownMotion: (id: string) => boolean,
): PrescriptionIssue[] {
  const issues: PrescriptionIssue[] = [];
  if (!rx.motion) issues.push({ path: 'motion', message: 'motion is required' });
  else if (!isKnownMotion(rx.motion))
    issues.push({ path: 'motion', message: `unknown motion "${rx.motion}"` });
  for (const [i, step] of (rx.sequence ?? []).entries()) {
    if (!isKnownMotion(step))
      issues.push({ path: `sequence[${i}]`, message: `unknown motion "${step}"` });
  }
  const ts = rx.modifiers?.timeScale;
  if (ts != null && (!(ts > 0) || ts > 4))
    issues.push({ path: 'modifiers.timeScale', message: 'timeScale must be in (0, 4]' });
  for (const [i, cap] of (rx.modifiers?.romCaps ?? []).entries()) {
    const def = getRomJointDefinition(cap.joint);
    if (!def) {
      issues.push({ path: `romCaps[${i}].joint`, message: `unknown joint "${cap.joint}"` });
      continue;
    }
    if (!getRomFieldDefinition(cap.joint, cap.field))
      issues.push({
        path: `romCaps[${i}].field`,
        message: `"${cap.field}" is not a field of ${cap.joint}`,
      });
    if (cap.maxDeg == null && cap.minDeg == null)
      issues.push({ path: `romCaps[${i}]`, message: 'a cap needs maxDeg and/or minDeg' });
  }
  return issues;
}

/**
 * Fold ROM caps into the engine's scenario-constraint shape, so the SAME clamp
 * path that enforces a case-authored restriction ("elbow stops at 95°") enforces
 * a clinical cap during motion. `availableRange` only restricts, never extends.
 */
export function romCapsToConstraints(caps: RomCap[]): RomScenarioConstraints {
  const out: RomScenarioConstraints = {};
  for (const cap of caps) {
    const range: { min?: number; max?: number } = {};
    if (cap.maxDeg != null) range.max = cap.maxDeg;
    if (cap.minDeg != null) range.min = cap.minDeg;
    if (range.min == null && range.max == null) continue;
    (out[cap.joint] ??= {})[cap.field] = { availableRange: range };
  }
  return out;
}

/** The canonical joint keys a cap set touches (for the runtime's per-frame clamp). */
export function romCapJointKeys(caps: RomCap[]): string[] {
  return [...new Set(caps.map((c) => c.joint))];
}

/**
 * Resolve a prescription into what the runtime executes: a base
 * `play-motion` command (with timing folded into `speed`), the validated ROM
 * caps, and the residual overlays. `play` mode drops modifiers entirely.
 */
export function resolveMotionPrescription(rx: MotionPrescription): ResolvedPrescription {
  const mods = rx.mode === 'modify' ? (rx.modifiers ?? {}) : {};
  const { timeScale, romCaps, ...overlays } = mods;
  const command: MotionCommand = {
    action: 'play-motion',
    motion: rx.motion,
    // Timing folds into the existing speed override; the definition's default
    // speed still applies when timeScale is absent.
    ...(timeScale != null ? { speed: timeScale } : {}),
  };
  return {
    command,
    romCaps: romCaps ?? [],
    overlays,
    sequence: rx.sequence ?? [rx.motion],
  };
}

// ── L1 tool schema (the shared prescribe_motion contract) ───────────────────
// The tool schema an AI calls to request a motion. Both DevPT apps build it from
// HERE so the vocabulary never drifts. Two variants from one builder:
//   - full  (allowModifiers: true)  — the AUTHORING variant (simMOVE): the user
//     IS the clinician-author, so motion + all clinical modifiers are theirs.
//   - intent-only (allowModifiers: false) — the EXAM-PATIENT variant (simLAB):
//     the roleplay patient may pick only WHAT to attempt; the clinical modifiers
//     ARE the exam findings and are supplied by the scenario, merged server-side
//     (mergeAuthoredPrescription). The patient can never author its own findings.
// Same MotionPrescription result either way.

/** One ROM-cap joint offered by the full tool variant. */
export interface MotionCapJoint {
  /** ROM canonical joint key, e.g. 'R_Leg'. */
  joint: string;
  /** ROM field key, e.g. 'kneeFlexion'. */
  field: string;
  /** Human label for the tool description, e.g. 'right knee flexion'. */
  label: string;
  /** Upper bound (degrees) the field may be capped to. */
  maxDeg: number;
}

export interface PrescribeMotionToolOptions {
  /** Allowed motion ids — becomes the `motion` enum. */
  motions: readonly string[];
  /** Optional per-motion hint text woven into the description. */
  motionHints?: Partial<Record<string, string>>;
  /** false / undefined → intent-only (motion only); true → full modifiers. */
  allowModifiers?: boolean;
  /** ROM-cap joints offered by the full variant. */
  capJoints?: readonly MotionCapJoint[];
  /** Override the tool name (defaults per variant). */
  name?: string;
}

export interface PrescribeMotionToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const PRESCRIBE_INTENT_DESC =
  'Perform a movement on the 3D mannequin. Pick the closest base motion, and only when the clinician asks for a movement. The simulation — not you — decides what the body actually does: every request is clamped to the body’s real joint limits and any authored restriction, and you receive back what the mannequin actually performed. Describe that honestly; never claim a motion or angle that was not returned. One call per instruction.';

const PRESCRIBE_FULL_DESC =
  'Perform a movement on the 3D mannequin. Pick the closest base motion and layer any clinical modifiers requested (slower/faster, a restricted joint range in degrees, guarding/stiffness, or reduced balance). The engine clamps every request to real joint limits and returns what the mannequin actually performed. Describe the result honestly; never claim a motion or angle that was not returned. One call per instruction.';

/** Build the `prescribe_motion` (full) / `attempt_motion` (intent-only) schema. */
export function buildPrescribeMotionTool(
  opts: PrescribeMotionToolOptions,
): PrescribeMotionToolSchema {
  const full = opts.allowModifiers === true;
  const motionEnum = [...opts.motions];
  const motionDesc =
    'Base motion to play.' +
    (opts.motionHints
      ? ' Options: ' +
        motionEnum.map((m) => `${m} (${opts.motionHints?.[m] ?? m})`).join(', ') +
        '.'
      : '');
  const properties: Record<string, unknown> = {
    motion: { type: 'string', enum: motionEnum, description: motionDesc },
  };
  if (full) {
    properties.timeScale = {
      type: 'number',
      description:
        'Playback speed. 1 = normal, 0.4 = very slow/cautious, 1.5 = fast/brisk. Clamped to [0.4, 1.5]. Omit for normal.',
    };
    const capJoints = opts.capJoints ?? [];
    if (capJoints.length) {
      properties.romCapJoint = {
        type: 'string',
        enum: capJoints.map((c) => c.joint),
        description:
          'Optionally restrict one joint: ' +
          capJoints.map((c) => `${c.joint} = ${c.label} (0–${c.maxDeg}°)`).join('; ') +
          '. Requires romCapMaxDeg.',
      };
      properties.romCapMaxDeg = {
        type: 'number',
        description: 'Maximum degrees for the restricted joint. Requires romCapJoint.',
      };
    }
    properties.guarding = {
      type: 'number',
      description:
        '0–1 trunk + arm stiffness (guarded, protective, reduced-excursion pattern). Omit or 0 for none.',
    };
    properties.balanceSway = {
      type: 'number',
      description:
        '0–1 slow postural wobble over the planted feet (unsteady / reduced-balance pattern). Omit or 0 for none.',
    };
  }
  return {
    name: opts.name ?? (full ? 'prescribe_motion' : 'attempt_motion'),
    description: full ? PRESCRIBE_FULL_DESC : PRESCRIBE_INTENT_DESC,
    parameters: {
      type: 'object',
      properties,
      required: ['motion'],
      additionalProperties: false,
    },
  };
}

/** Raw tool-call arguments (wire form is a JSON string, parsed by the SDK). */
export interface PrescribeMotionArgs {
  motion?: string;
  timeScale?: number;
  romCapJoint?: string;
  romCapMaxDeg?: number;
  guarding?: number;
  balanceSway?: number;
}

const clampNum = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Map raw tool args → MotionPrescription. `capJoints` supplies the joint→field
 * mapping for a ROM cap. When `allowModifiers` is falsy (the exam-patient
 * variant), ANY modifier fields in the args are ignored — the patient can never
 * author findings; the scenario does, via {@link mergeAuthoredPrescription}.
 * Returns null on an unknown/missing motion (a hallucinated call) so callers can
 * refuse cleanly.
 */
export function toolArgsToPrescription(
  args: PrescribeMotionArgs,
  opts: {
    motions: readonly string[];
    capJoints?: readonly MotionCapJoint[];
    allowModifiers?: boolean;
  },
): MotionPrescription | null {
  const motion = args?.motion;
  if (!motion || !opts.motions.includes(motion)) return null;
  if (!opts.allowModifiers) {
    return { motion: motion as MovementClipId, mode: 'play' };
  }
  const modifiers: ClinicalModifiers = {};
  if (typeof args.timeScale === 'number' && args.timeScale !== 1) {
    modifiers.timeScale = clampNum(args.timeScale, 0.4, 1.5);
  }
  const cap = args.romCapJoint
    ? opts.capJoints?.find((c) => c.joint === args.romCapJoint)
    : undefined;
  if (cap && typeof args.romCapMaxDeg === 'number') {
    modifiers.romCaps = [
      { joint: cap.joint, field: cap.field, maxDeg: clampNum(args.romCapMaxDeg, 0, cap.maxDeg) },
    ];
  }
  if (typeof args.guarding === 'number' && args.guarding > 0) {
    modifiers.guarding = clampNum(args.guarding, 0, 1);
  }
  if (typeof args.balanceSway === 'number' && args.balanceSway > 0) {
    modifiers.balanceSway = clampNum(args.balanceSway, 0, 1);
  }
  const hasMods = Object.keys(modifiers).length > 0;
  return {
    motion: motion as MovementClipId,
    mode: hasMods ? 'modify' : 'play',
    ...(hasMods ? { modifiers } : {}),
  };
}

/**
 * Merge scenario-authored modifiers onto a patient-chosen (intent-only)
 * prescription. The patient supplies `motion`; the SCENARIO supplies the clinical
 * presentation — so the exam patient never authors its own findings. Authored
 * modifiers replace whatever was on the base (the patient shouldn't have set any).
 */
export function mergeAuthoredPrescription(
  base: MotionPrescription,
  authored: ClinicalModifiers | null | undefined,
): MotionPrescription {
  const hasMods = !!authored && Object.keys(authored).length > 0;
  return {
    motion: base.motion,
    mode: hasMods ? 'modify' : 'play',
    ...(base.sequence ? { sequence: base.sequence } : {}),
    ...(base.label ? { label: base.label } : {}),
    ...(hasMods ? { modifiers: authored } : {}),
  };
}
