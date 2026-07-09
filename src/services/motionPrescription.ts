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
