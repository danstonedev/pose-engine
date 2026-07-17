/**
 * Generative motion composition (simMOVE L3) — timed keyframe sequences over
 * the calibrated movement-command vocabulary.
 *
 * A {@link ComposedMotion} is a NOVEL movement an AI (or author) creates as a
 * list of keyframes, each holding absolute joint targets in the SAME
 * joint/motion vocabulary as {@link resolveCommandTarget} — so every target
 * runs through the identical truth path: normative ROM ∩ scenario constraints,
 * the documented refusal rule, and the painful-arc flag. Composition never
 * widens what a single command could do; it only sequences it in time.
 *
 * Pure math on plain data (no scene, no Svelte): `resolveComposedMotion`
 * validates + clamps + enforces realistic timing, `buildSequencePoses` folds
 * {@link buildCommandPose} into one CustomPose per keyframe. The stage
 * (ExamStage3D / simMOVE's MotionStage) is a thin animator over the result.
 *
 * TIMING HONESTY — a composed motion may not teleport: each keyframe's
 * duration is raised to at least the time the fastest-moving joint needs at
 * {@link MAX_ANGULAR_VELOCITY_DEG_S} (a fast but clinical bound), measured
 * against that joint's clamped value in the PREVIOUS keyframe (first
 * keyframe: from neutral 0°, the registry's clinical zero). Keyframes whose
 * duration had to be bumped are flagged `timingAdjusted` so the caller can
 * narrate honestly ("I did it, but not that fast").
 *
 * REFUSAL GRANULARITY — refused targets (unknown/unsupported motion, no
 * achievable travel, or overflow past {@link MAX_TARGETS_PER_KEYFRAME},
 * reason 'target-limit') are DROPPED from their keyframe but fully REPORTED
 * in `outcomes`; the surviving siblings still play. A POSTURE-ONLY keyframe
 * (root orient/translate or a stance change, zero targets — e.g. "lie down")
 * is valid: it carries the previous joint pose forward. The WHOLE motion
 * refuses only when the shape is invalid (limits, malformed keyframes) or
 * when zero targets survive anywhere AND no keyframe carries a root/stance
 * directive — mirroring the single-command contract where the patient does
 * what they can and tells you what they couldn't.
 */
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';
import type { JointAngleRestReference } from './jointAngles';
import {
  buildComposedCommandPose,
  resolveCommandTarget,
  type ComposedJointTarget,
  type ExamMovementLimiter,
  type ExamMovementRefusalReason,
} from './movementCommand';
import { rootOrientQuatTuple, type RootOrient, type RootTransform } from './rootMotion';

// ── Composed-motion types (structural — hosts mirror these shapes) ──────────

/** One absolute joint target inside a keyframe (registry clinical degrees). */
export interface SequenceTarget {
  /** ROM-registry canonical joint key, e.g. 'R_UpperArm'. */
  joint: string;
  /** That joint's registry motion/field key, e.g. 'shoulderFlexion'. */
  motion: string;
  /** Absolute target in the registry's clinical sign convention. */
  targetDegrees: number;
  /**
   * OPTIONAL intra-phase timing: the fraction (0..1] of THIS keyframe's travel at
   * which this joint reaches its target and then HOLDS. Default 1 (arrive at the
   * keyframe boundary — the current lockstep behavior). A value < 1 makes the
   * joint LEAD the others within the phase — e.g. the ankle dorsiflexes to ~0.87
   * while the knee/hip complete at ~0.99 in a squat descent. This is a declarative
   * annotation only; it takes effect when the plan is run through
   * {@link expandPeakTiming} (which realizes it as sub-keyframes on the existing
   * trajectory), and is otherwise ignored, so back-compat is total.
   */
  peakAt?: number;
}

/** Angular-velocity CLASS for a keyframe — the cap the timing governor enforces.
 *  DEFAULT is 'deliberate' (clinical honesty: exams never silently go
 *  ballistic). 'functional' unlocks everyday speed (a front kick), 'ballistic'
 *  the athletic power a throw/kick spike needs. The governor still raises the
 *  duration to the chosen class's floor and still flags `timingAdjusted`. */
export type VelocityClass = 'deliberate' | 'functional' | 'ballistic';

/** Per-class angular-velocity cap, °/s. */
export const VELOCITY_CLASS_CAPS: Record<VelocityClass, number> = {
  deliberate: 240,
  functional: 600,
  ballistic: 2000,
};

/** How a keyframe (or the whole motion) grounds: 'floating' = today's open-chain
 *  behavior (limbs swing free; the body never touches the floor). 'planted' =
 *  the closed-chain approximation — the lower foot is pinned to floor level, so
 *  hip/knee/ankle flexion becomes a squat, plantarflexion a heel raise, trunk+hip
 *  flexion a real hip-hinge toe-touch. Default 'floating' (back-compat). */
export type StanceMode = 'floating' | 'planted';

// ── Semantic direction vocabulary (the anti-reversal layer) ─────────────────
// The model authors DIRECTIONS by clinical name ('forward', 'supine'), never a
// raw signed root axis. resolveComposedMotion() is the ONE place the sign
// convention is applied, so a model can never pick the wrong sign and send the
// avatar the wrong way.
//
// TWO FRAMES — do not conflate them (conflating them WAS the reversal bug):
//   1. PHYSICAL WORLD FACING of the loaded GLB — what TRAVEL uses. Measured on
//      the male rig (toes point +Z; a forward arm-raise, hip flexion, and trunk
//      flexion all carry the limb/head toward +Z): the mannequin FACES +Z.
//        forward / anterior = +Z   (backward / posterior = −Z)
//        superior / up      = +Y   (inferior  / down      = −Y)
//        subject's LEFT     = +X   (subject's RIGHT       = −X)
//   2. GONIOMETRIC READOUT convention in jointAngles.ts labels anterior as −Z.
//      That is a MEASUREMENT-frame naming choice for the clinical angle readout;
//      it does NOT match the mesh's physical facing and is NOT used for travel.
// So "walk forward" must move the root the way the body faces (+Z). An earlier
// build mapped forward→−Z (the readout label) and the avatar moonwalked — the
// exact forward/back reversal this vocabulary exists to prevent. left/right and
// up/down were always correct; only the sagittal (Z) sign was wrong.

/** A whole-body TRAVEL direction, by anatomic name. Maps to a SIGNED world axis
 *  in {@link TRAVEL_DIRECTION_AXIS} — the model never writes the sign itself. */
export type TravelDirection = 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down';

/** A whole-body POSTURE, by clinical name. Maps to a root {@link RootOrient} in
 *  {@link postureRootOrient} (supine face-up, prone face-down, side-lying). */
export type SemanticPosture = 'upright' | 'supine' | 'prone' | 'sidelying-left' | 'sidelying-right';

/** Every travel direction, for host capability discovery / tool enums. */
export const TRAVEL_DIRECTIONS: readonly TravelDirection[] = [
  'forward',
  'backward',
  'left',
  'right',
  'up',
  'down',
];

/** Every posture, for host capability discovery / tool enums. */
export const SEMANTIC_POSTURES: readonly SemanticPosture[] = [
  'upright',
  'supine',
  'prone',
  'sidelying-left',
  'sidelying-right',
];

/**
 * SIGNED unit world axis each travel direction moves the model root along, per
 * the authoritative body-axis convention above. This is the ONLY table that
 * turns a direction NAME into a Z/X/Y sign — resolveComposedMotion scales it by
 * the requested meters, and {@link movementDirection} validates measured travel
 * against it, so intent and check read the same signs.
 */
export const TRAVEL_DIRECTION_AXIS: Record<TravelDirection, readonly [number, number, number]> = {
  forward: [0, 0, 1], // the way the body faces = +Z (physical rig facing, measured)
  backward: [0, 0, -1], // away from facing = −Z
  left: [1, 0, 0], // subject's left = +X
  right: [-1, 0, 0], // subject's right = −X
  up: [0, 1, 0], // superior = +Y
  down: [0, -1, 0], // inferior = −Y
};

/** A semantic whole-body translation for a keyframe (sugar over root.translateM).
 *  `meters` is the travel distance along the named direction's signed axis. */
export interface SemanticTravel {
  direction: TravelDirection;
  /** Distance traveled along `direction`, meters (finite; may be 0). */
  meters: number;
}

/** Roll SIGN (degrees, about the anterior-posterior Z axis) that lays the body
 *  onto its LEFT side (left-side-down). PINNED EMPIRICALLY on the male rig in
 *  movementDirection.test.ts, NOT guessed: a −90° roll about the A-P Z axis
 *  rotates the subject's left (+X) toward the floor (−Y). sidelying-right is the
 *  exact opposite sign. */
export const SIDELYING_LEFT_ROLL_DEG = -90;

/**
 * The root {@link RootOrient} a semantic posture resolves to. supine/prone pitch
 * the body about the medio-lateral X axis (−90 face-up / +90 face-down, matching
 * {@link RootOrient}); side-lying rolls about the A-P Z axis by the empirically
 * pinned {@link SIDELYING_LEFT_ROLL_DEG}. Every posture pins BOTH pitch and roll
 * (yaw is left free — a body can face any direction while lying/standing), so
 * re-posturing from one lie to another fully overrides the previous orientation
 * rather than leaving a stale axis carried forward.
 */
export function postureRootOrient(posture: SemanticPosture): RootOrient {
  switch (posture) {
    case 'upright':
      return { pitchDeg: 0, rollDeg: 0 };
    case 'supine':
      return { pitchDeg: -90, rollDeg: 0 };
    case 'prone':
      return { pitchDeg: 90, rollDeg: 0 };
    case 'sidelying-left':
      return { pitchDeg: 0, rollDeg: SIDELYING_LEFT_ROLL_DEG };
    case 'sidelying-right':
      return { pitchDeg: 0, rollDeg: -SIDELYING_LEFT_ROLL_DEG };
  }
}

/** One timed keyframe: the targets to reach, how long the travel takes, and
 *  an optional hold at the reached position (assessment moments, end-range). */
export interface SequenceKeyframe {
  /** Joint targets. OPTIONAL: a posture-only keyframe (lie down, roll, stance
   *  change) may omit targets entirely — it carries the previous joint pose
   *  forward and applies its `root`/`stance`. A keyframe must have at least
   *  one target OR a root directive OR a stance change. */
  targets?: SequenceTarget[];
  /** Travel time into this keyframe, ms (raised to a realistic floor). */
  durationMs: number;
  /** Optional dwell at the keyframe once reached, ms. */
  holdMs?: number;
  /** Velocity class governing this keyframe's timing floor. Default 'deliberate'. */
  velocityClass?: VelocityClass;
  /** Whole-body root posture + travel for this keyframe (persists forward until
   *  a later keyframe overrides it). Distinct from any joint AROM. RAW, signed —
   *  authoring this directly is fully supported (back-compat), but prefer the
   *  semantic {@link SequenceKeyframe.travel}/{@link SequenceKeyframe.posture}
   *  sugar below so the engine (not the model) owns the anatomic axis signs. */
  root?: RootTransform;
  /** SEMANTIC travel sugar: move the whole body by name ('forward' 0.4 m) and
   *  let resolveComposedMotion apply the signed axis (forward → −Z). Fills
   *  `root.translateM` ONLY when this keyframe has no explicit raw translate —
   *  a raw `root.translateM` on the same keyframe WINS (see the precedence note
   *  on resolveComposedMotion). */
  travel?: SemanticTravel;
  /** SEMANTIC posture sugar: reorient the whole body by clinical name ('supine',
   *  'sidelying-left') and let resolveComposedMotion apply the signed root
   *  orient. Fills `root.orient` ONLY when this keyframe has no explicit raw
   *  orient — a raw `root.orient` on the same keyframe WINS. */
  posture?: SemanticPosture;
  /** Per-keyframe stance override (else the motion-level stance applies). */
  stance?: StanceMode;
}

/** Qualitative overlay modifiers — same semantics as prescribe_motion's. */
export interface ComposedMotionModifiers {
  /** 0..1 trunk + arm stiffness (guarded, protective pattern). */
  guarding?: number;
  /** Playback speed: 1 = normal, <1 slower, >1 faster (scales durations). */
  timeScale?: number;
  /** 0..1 slow postural wobble over the planted feet. */
  balanceSway?: number;
}

/** A weight-bearing foot contact: pin `foot` to the ground while it bears
 *  weight. `fromMs`/`toMs` scope it to a stance WINDOW (heel-strike → toe-off)
 *  so an alternating gait declares one entry per stance phase; omit both for a
 *  whole-motion pin. Consumed by the offline sampler (`contacts`) AND the live
 *  stage, which IK-plants each declared foot per frame so it does not slide as
 *  the body travels over it (closed-chain ground truth). */
export interface StanceContact {
  foot: string;
  fromMs?: number;
  toMs?: number;
}

/** A novel movement composed as timed keyframes over the command vocabulary. */
export interface ComposedMotion {
  /** Short human label the author/AI gives its creation. */
  name?: string;
  keyframes: SequenceKeyframe[];
  /** Cycle the keyframes until stopped (the last keyframe tweens back into
   *  the first). Default false: play once and settle at the last keyframe. */
  loop?: boolean;
  modifiers?: ComposedMotionModifiers;
  /** Where the motion begins. 'current' (DEFAULT): compose onto the CURRENT
   *  on-stage pose — unmentioned joints hold where they are, so a second motion
   *  never teleports the rest of the body back to rest. 'neutral': return to
   *  anatomic first, then play (unmentioned joints reset to 0°). */
  startFrom?: 'current' | 'neutral';
  /** Default grounding for every keyframe that doesn't set its own `stance`.
   *  Default 'floating' (back-compat open-chain behavior). */
  stance?: StanceMode;
  /** Weight-bearing foot contacts to IK-plant during playback (closed-chain
   *  ground truth: the stance foot stays world-fixed while the body travels over
   *  it, instead of sliding). Alternating gait declares one windowed entry per
   *  stance phase. Consumed by the live stage and the offline sampler; omit for
   *  the default open-chain / vertical-pin behaviour. */
  contacts?: StanceContact[];
}

// ── Limits (exported so hosts + tool schemas cite the same numbers) ─────────

/** Most keyframes a composed motion may hold. */
export const MAX_KEYFRAMES = 12;
/** Most joint targets a single keyframe may hold. 12 covers a legitimate
 *  full-body keyframe (2 hips + 2 knees + 2 ankles + trunk×2 + 2 shoulders + 2
 *  more); overflow beyond it is NON-FATAL — the first 12 play, the rest are
 *  refused per-target with reason 'target-limit' (bake-off evidence: an 8-cap
 *  with fatal overflow refused whole anatomically-reasonable plans). */
export const MAX_TARGETS_PER_KEYFRAME = 12;
/** Fast clinical motion bound — the DEFAULT ('deliberate') velocity-class cap;
 *  no commanded joint may be asked to travel faster than this unless a keyframe
 *  opts into a higher {@link VelocityClass}. Keyframe durations are raised to
 *  respect the active cap. */
export const MAX_ANGULAR_VELOCITY_DEG_S = VELOCITY_CLASS_CAPS.deliberate;
/** Shortest a keyframe's travel may be, ms. */
export const MIN_KEYFRAME_MS = 150;
/** Longest a keyframe's travel — or its hold — may be, ms. Caps requested
 *  durations (and even the velocity floor at pathological angular travel) so a
 *  single keyframe can never freeze a host's serialized command chain. */
export const MAX_KEYFRAME_MS = 10_000;

// ── Resolution result types ─────────────────────────────────────────────────

/** Per-target outcome, tagged with its keyframe index. Refused targets are
 *  dropped from playback but still reported here. */
export interface SequenceTargetOutcome {
  keyframe: number;
  joint: string;
  motion: string;
  status: 'complied' | 'modified' | 'refused';
  requestedDegrees: number;
  /** ROM-clamped planned target (absent when refused). */
  clampedDegrees?: number;
  limitedBy?: ExamMovementLimiter;
  painful?: boolean;
  /** Command-level refusal reason, or 'target-limit' when the target overflowed
   *  {@link MAX_TARGETS_PER_KEYFRAME} (the first 12 still play). */
  reason?: ExamMovementRefusalReason | 'target-limit';
}

/** A keyframe after clamping + timing enforcement. `targets` carry the
 *  CLAMPED degrees; refused targets are gone (see `outcomes`). */
export interface ResolvedSequenceKeyframe {
  targets: { joint: string; motion: string; clampedDegrees: number }[];
  durationMs: number;
  holdMs: number;
  /** True when durationMs was raised to the realistic-velocity floor. */
  timingAdjusted?: boolean;
  /** Whole-body root posture + travel for this keyframe (validated pass-through). */
  root?: RootTransform;
  /** Resolved effective stance for this keyframe. */
  stance: StanceMode;
}

export interface ResolvedComposedMotion {
  status: 'ok' | 'refused';
  name?: string;
  keyframes: ResolvedSequenceKeyframe[];
  /** Every requested target's outcome, in keyframe order. */
  outcomes: SequenceTargetOutcome[];
  loop: boolean;
  modifiers?: ComposedMotionModifiers;
  /** Resolved start mode ('current' unless the motion asked for 'neutral'). */
  startFrom: 'current' | 'neutral';
  /** Weight-bearing foot contacts to IK-plant during playback (pass-through from
   *  the authored motion; the stage/sampler pin each declared foot per frame). */
  contacts?: StanceContact[];
  /** Why the WHOLE motion refused (invalid shape / nothing achievable). */
  reason?: string;
}

/** Options threading the CURRENT on-stage state into resolution (cross-motion
 *  continuity): a second motion is timed + composed from where the body IS. */
export interface ResolveComposedOptions {
  /** Current MEASURED joint angles keyed `joint.motion` (registry clinical
   *  degrees) — seeds each target's velocity 'from' value so a keyframe's timing
   *  floor is measured from the live pose, not neutral. Ignored when the motion's
   *  `startFrom` is 'neutral'. */
  currentAngles?: Record<string, number>;
}

const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Refuse the whole motion with a shape/limits reason. */
function refuse(motion: ComposedMotion | null | undefined, reason: string): ResolvedComposedMotion {
  return {
    status: 'refused',
    ...(motion?.name ? { name: motion.name } : {}),
    keyframes: [],
    outcomes: [],
    loop: !!motion?.loop,
    startFrom: motion?.startFrom === 'neutral' ? 'neutral' : 'current',
    reason,
  };
}

const isFiniteOpt = (n: unknown): boolean => n == null || (typeof n === 'number' && Number.isFinite(n));

/** Validate + normalize a keyframe's root transform (finite orient angles, a
 *  3-number translate). Returns the cleaned transform or undefined. Throws a
 *  string reason via the caller's refuse path is avoided — returns `'invalid'`. */
function validateRoot(root: RootTransform | undefined): RootTransform | undefined | 'invalid' {
  if (root == null) return undefined;
  if (typeof root !== 'object') return 'invalid';
  const out: RootTransform = {};
  if (root.orient != null) {
    const o = root.orient;
    if (!isFiniteOpt(o.pitchDeg) || !isFiniteOpt(o.rollDeg) || !isFiniteOpt(o.yawDeg)) return 'invalid';
    const orient: RootOrient = {};
    if (o.pitchDeg != null) orient.pitchDeg = o.pitchDeg;
    if (o.rollDeg != null) orient.rollDeg = o.rollDeg;
    if (o.yawDeg != null) orient.yawDeg = o.yawDeg;
    if (Object.keys(orient).length) out.orient = orient;
  }
  if (root.translateM != null) {
    const t = root.translateM;
    if (!Array.isArray(t) || t.length !== 3 || !t.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return 'invalid';
    }
    out.translateM = [t[0], t[1], t[2]];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validate a keyframe's semantic {@link SemanticTravel} into a signed
 *  translate, or 'invalid' for a malformed one (unknown direction / non-finite
 *  meters) so the caller refuses through the SAME path as other shape errors. */
function semanticTravelToTranslate(
  travel: SemanticTravel | undefined,
): [number, number, number] | undefined | 'invalid' {
  if (travel == null) return undefined;
  if (typeof travel !== 'object') return 'invalid';
  const { direction, meters } = travel;
  if (!(TRAVEL_DIRECTIONS as readonly string[]).includes(direction)) return 'invalid';
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return 'invalid';
  const axis = TRAVEL_DIRECTION_AXIS[direction];
  return [axis[0] * meters, axis[1] * meters, axis[2] * meters];
}

/**
 * Resolve a keyframe's EFFECTIVE root transform from its raw {@link RootTransform}
 * and its semantic {@link SequenceKeyframe.travel}/{@link SequenceKeyframe.posture}
 * sugar. Returns the cleaned transform, `undefined` (no root directive), or
 * `'invalid'` (malformed raw root OR malformed semantic input — the caller
 * refuses through the same path as every other shape error).
 *
 * PRECEDENCE (documented contract): the explicit RAW value WINS per component.
 * Semantic sugar only FILLS the component the keyframe left unspecified:
 *   - orient    ← raw `root.orient`    when present, else `posture`'s orient
 *   - translate ← raw `root.translateM` when present, else `travel`'s translate
 * So a keyframe may combine e.g. `posture:'supine'` (fills orient) with a raw
 * `root.translateM` (kept verbatim), and a keyframe that sets BOTH `travel` and
 * a raw `root.translateM` keeps the raw one (the sugar is ignored for that
 * component). This lets a host expose direction NAMES to the model while a
 * calibration author can still pin a raw axis when needed.
 */
function resolveKeyframeRoot(kf: SequenceKeyframe): RootTransform | undefined | 'invalid' {
  const raw = validateRoot(kf.root);
  if (raw === 'invalid') return 'invalid';

  const semTranslate = semanticTravelToTranslate(kf.travel);
  if (semTranslate === 'invalid') return 'invalid';

  let semOrient: RootOrient | undefined;
  if (kf.posture != null) {
    if (!(SEMANTIC_POSTURES as readonly string[]).includes(kf.posture)) return 'invalid';
    semOrient = postureRootOrient(kf.posture);
  }

  const out: RootTransform = {};
  const orient = raw?.orient ?? semOrient; // raw component wins over sugar
  if (orient) out.orient = orient;
  const translateM = raw?.translateM ?? semTranslate; // raw component wins over sugar
  if (translateM) out.translateM = translateM;
  return Object.keys(out).length ? out : undefined;
}

/** Host-facing description of the semantic direction vocabulary — the enum
 *  lists plus ready-to-embed tool/prompt text — so a host exposes
 *  'direction: forward|backward|…' to the LLM instead of a signed Z axis. */
export interface SemanticMotionVocabulary {
  travelDirections: readonly TravelDirection[];
  postures: readonly SemanticPosture[];
  /** One-line-per-concept prose a host can paste into a tool description /
   *  system prompt. States the vocabulary WITHOUT ever exposing an axis sign. */
  promptText: string;
}

/**
 * Describe the semantic direction vocabulary for a host to surface to an LLM.
 * The whole point of the vocabulary is that the MODEL names a direction and the
 * ENGINE owns the sign, so this text deliberately never mentions X/Y/Z — it
 * hands the model clinical words ('forward', 'supine') and nothing to get
 * backwards.
 */
export function describeSemanticMotionVocabulary(): SemanticMotionVocabulary {
  return {
    travelDirections: TRAVEL_DIRECTIONS,
    postures: SEMANTIC_POSTURES,
    promptText: [
      'Whole-body movement uses NAMED directions — never raw coordinates.',
      "travel: move the body a distance by name — { direction: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down', meters: number }. " +
        "'left'/'right' are the SUBJECT's left/right; the engine applies the correct anatomic axis, so just say the direction.",
      "posture: reorient the whole body by name — 'upright' | 'supine' (lying face-up) | 'prone' (lying face-down) | 'sidelying-left' (on the left side) | 'sidelying-right' (on the right side).",
      'Prefer these over any raw root translate/orient so travel can never come out reversed.',
    ].join('\n'),
  };
}

const stripPeak = (t: SequenceTarget): SequenceTarget => ({
  joint: t.joint,
  motion: t.motion,
  targetDegrees: t.targetDegrees,
});

/**
 * Expand a plan's intra-phase {@link SequenceTarget.peakAt} annotations into
 * ordinary sub-keyframes on the EXISTING trajectory — the low-risk way to give a
 * joint a within-phase LEAD (the ankle dorsiflexing ahead of the knee in a squat
 * descent) without touching the SQUAD trajectory or the timing governor. Pure;
 * returns a new motion.
 *
 * For each keyframe, the distinct `peakAt` fractions (plus the 1.0 boundary)
 * become ordered sub-keyframes; at fraction τ each joint sits at
 * `min(1, τ / peakAt_j)` of the way from its previous settled value toward its
 * target, so a joint reaches its target at its OWN `peakAt` and holds. The final
 * sub-keyframe is the original boundary (every joint at full target), so the
 * SETTLED pose, holds, and goniometric measurements are UNCHANGED — only the path
 * and timing BETWEEN keyframes shift. Keyframes with no `peakAt < 1` (or no
 * targets) pass through untouched, so a plan that never sets `peakAt` is
 * byte-identical to today.
 *
 * How directives ride the split (informed by an adversarial review):
 *   - `stance` is a per-phase MODE (planted = closed-chain foot-pin), not a
 *     boundary event, so it rides EVERY sub-keyframe — otherwise a planted squat
 *     would descend un-pinned (floating) through the lead and snap at the end.
 *   - `velocityClass` rides every sub (leads must not be throttled to the
 *     default class); `holdMs` rides the final sub only.
 *   - A keyframe carrying a WHOLE-BODY transform (`root`/`travel`/`posture`) is
 *     NOT expanded (kept lockstep, directive intact): splitting would compress
 *     the whole-body motion into the final slice and desync it from the limbs.
 *     peakAt is for intra-phase JOINT coordination; author whole-body travel in
 *     its own keyframe.
 *
 * BASELINE: the intermediate lead shape is measured from `opts.fromAngles` (keyed
 * `joint.motion`) or neutral 0° when absent. Pass the live angles when the motion
 * uses `startFrom:'current'`, else the first keyframe's lead is shaped from 0
 * (final targets are exact regardless — this only affects the transient shape).
 *
 * LIMITS: expansion is budgeted against {@link MAX_KEYFRAMES} — a keyframe whose
 * sub-frames wouldn't fit stays lockstep (its lead is dropped) so the motion
 * stays valid instead of being refused. And each sub-duration is still subject to
 * the velocity governor's floor in {@link resolveComposedMotion}, so an
 * AGGRESSIVE lead (a large excursion crammed into a short slice) will be
 * lengthened/reshaped by the governor and the phase total may grow; a subtle lead
 * (the intended use — a few percent) is unaffected.
 */
export function expandPeakTiming(
  motion: ComposedMotion,
  opts?: { fromAngles?: Record<string, number> },
): ComposedMotion {
  if (!motion || !Array.isArray(motion.keyframes)) return motion;
  const clampP = (p: number | undefined): number => {
    const v = typeof p === 'number' && Number.isFinite(p) ? p : 1;
    return v <= 0 || v > 1 ? 1 : v; // (0,1]; non-positive / absent / >1 → 1
  };
  const key = (t: SequenceTarget): string => `${t.joint}.${t.motion}`;
  // Baseline for the lead interpolation: live angles for startFrom:'current',
  // else neutral 0. Final targets are exact regardless of this seed.
  const prev = new Map<string, number>();
  for (const [k, v] of Object.entries(opts?.fromAngles ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) prev.set(k, v);
  }
  const out: SequenceKeyframe[] = [];
  const kfs = motion.keyframes;

  for (let idx = 0; idx < kfs.length; idx += 1) {
    const kf = kfs[idx]!;
    const targets = Array.isArray(kf.targets) ? kf.targets : [];
    const wholeBody = !!(kf.root || kf.travel || kf.posture);
    const hasLead = targets.some((t) => clampP(t.peakAt) < 1 - 1e-9);
    const times = hasLead
      ? (() => {
          const s = [...new Set(targets.map((t) => clampP(t.peakAt)))];
          if (!s.some((x) => Math.abs(x - 1) < 1e-9)) s.push(1);
          return s.sort((a, b) => a - b);
        })()
      : [1];
    // Budget: reserve one slot for each not-yet-emitted keyframe so the total
    // never exceeds MAX_KEYFRAMES; a keyframe that wouldn't fit stays lockstep.
    const remainingAfter = kfs.length - idx - 1;
    const fits = out.length + times.length + remainingAfter <= MAX_KEYFRAMES;

    if (targets.length === 0 || !hasLead || wholeBody || !fits) {
      out.push(targets.length ? { ...kf, targets: targets.map(stripPeak) } : { ...kf });
      for (const t of targets) prev.set(key(t), t.targetDegrees);
      continue;
    }

    let prevT = 0;
    for (let i = 0; i < times.length; i += 1) {
      const tau = times[i]!;
      const isLast = i === times.length - 1;
      const subTargets: SequenceTarget[] = targets.map((t) => {
        const p = clampP(t.peakAt);
        const start = prev.get(key(t)) ?? 0;
        const frac = Math.min(1, tau / p);
        return { joint: t.joint, motion: t.motion, targetDegrees: start + (t.targetDegrees - start) * frac };
      });
      const sub: SequenceKeyframe = { targets: subTargets, durationMs: kf.durationMs * (tau - prevT) };
      if (kf.velocityClass) sub.velocityClass = kf.velocityClass;
      if (kf.stance) sub.stance = kf.stance; // per-phase mode → every sub
      if (isLast && kf.holdMs != null) sub.holdMs = kf.holdMs;
      out.push(sub);
      prevT = tau;
    }
    for (const t of targets) prev.set(key(t), t.targetDegrees);
  }
  return { ...motion, keyframes: out };
}

/**
 * Validate a composed motion's shape + limits, clamp every target through
 * {@link resolveCommandTarget} (the SAME truth path as single commands:
 * normative ROM ∩ scenario constraints, refusal rule, painful arc), and
 * enforce realistic timing per keyframe. Pure — reads the module-level
 * scenario-constraint store, writes nothing.
 *
 * ROOT DIRECTIVES — each keyframe's whole-body posture/travel is resolved by
 * {@link resolveKeyframeRoot}: the SEMANTIC sugar ({@link SequenceKeyframe.travel}
 * / {@link SequenceKeyframe.posture}) is mapped to the correct SIGNED
 * root.translateM / root.orient here (forward → +Z, the way the body faces;
 * supine → pitch −90, …), so
 * the model authors a direction NAME and never a raw axis sign. A raw
 * `root` value WINS per component (semantic sugar only fills the component the
 * keyframe left unspecified), keeping every existing raw-root plan working
 * unchanged. Malformed semantic input refuses through the same shape-error path.
 */
export function resolveComposedMotion(
  motion: ComposedMotion,
  variantCfg?: BodyVariantConfig,
  opts?: ResolveComposedOptions,
): ResolvedComposedMotion {
  if (!motion || !Array.isArray(motion.keyframes)) return refuse(motion, 'invalid-shape');
  if (motion.keyframes.length === 0) return refuse(motion, 'no-keyframes');
  if (motion.keyframes.length > MAX_KEYFRAMES) {
    return refuse(motion, `too-many-keyframes (max ${MAX_KEYFRAMES})`);
  }

  // INTRA-PHASE TIMING: realize any `peakAt` leads NOW, before validation, so a
  // within-phase joint lead (the ankle dorsiflexing ahead of the knee in a squat
  // descent) becomes ordered sub-keyframes on the same trajectory — the SAME
  // truth path (ROM clamp, velocity floor, measurement) then runs on the
  // expanded plan. `expandPeakTiming` is budget-guarded (never exceeds
  // MAX_KEYFRAMES, which the check above already guaranteed for the input) and
  // its output carries no `peakAt`, so this is idempotent and a plan that sets
  // no lead is byte-identical. The lead's transient shape is seeded from the
  // live angles on a startFrom:'current' composition (final peaks are exact
  // regardless).
  const startFrom: 'current' | 'neutral' = motion.startFrom === 'neutral' ? 'neutral' : 'current';
  motion =
    startFrom === 'current' && opts?.currentAngles
      ? expandPeakTiming(motion, { fromAngles: opts.currentAngles })
      : expandPeakTiming(motion);

  const motionStance: StanceMode = motion.stance === 'planted' ? 'planted' : 'floating';
  const outcomes: SequenceTargetOutcome[] = [];
  const resolvedKeyframes: ResolvedSequenceKeyframe[] = [];
  /** Last clamped value per `joint.motion` — the previous keyframe's position
   *  for the velocity check. Seeded from the CURRENT measured angle (cross-motion
   *  continuity) when startFrom==='current'; otherwise from neutral 0°. */
  const lastClamped = new Map<string, number>();
  if (startFrom === 'current' && opts?.currentAngles) {
    for (const [key, deg] of Object.entries(opts.currentAngles)) {
      if (typeof deg === 'number' && Number.isFinite(deg)) lastClamped.set(key, deg);
    }
  }
  let survivors = 0;
  /** Keyframes carrying a root directive or explicit stance change — a motion
   *  built only of those (e.g. "lie down on your back": root pitch −90, zero
   *  joint targets) is a VALID posture-only movement, never a refusal. */
  let postureDirectives = 0;

  for (const [ki, kf] of motion.keyframes.entries()) {
    if (!kf || typeof kf !== 'object') {
      return refuse(motion, `keyframe ${ki}: needs at least one target, root, or stance change`);
    }
    // EFFECTIVE root = raw root.orient/translateM merged with the semantic
    // travel/posture sugar (raw wins per component; see resolveKeyframeRoot).
    // A malformed raw root OR a malformed semantic input refuses here, through
    // the SAME shape-error path as everything else.
    const kfRoot = resolveKeyframeRoot(kf);
    if (kfRoot === 'invalid') {
      return refuse(motion, `keyframe ${ki}: malformed root transform or travel/posture`);
    }
    const hasStanceChange = kf.stance === 'planted' || kf.stance === 'floating';
    const requestedTargets = Array.isArray(kf.targets) ? kf.targets : [];
    // A keyframe is valid with ≥1 target OR a root directive OR a stance
    // change (posture-only keyframes carry the previous joint pose forward).
    if (requestedTargets.length === 0 && !kfRoot && !hasStanceChange) {
      return refuse(motion, `keyframe ${ki}: needs at least one target, root, or stance change`);
    }
    if (kfRoot || hasStanceChange) postureDirectives += 1;
    if (!isFiniteNum(kf.durationMs) || kf.durationMs < 0) {
      return refuse(motion, `keyframe ${ki}: durationMs must be a non-negative number`);
    }
    if (kf.holdMs != null && (!isFiniteNum(kf.holdMs) || kf.holdMs < 0)) {
      return refuse(motion, `keyframe ${ki}: holdMs must be a non-negative number`);
    }
    if (kf.velocityClass != null && VELOCITY_CLASS_CAPS[kf.velocityClass] == null) {
      return refuse(motion, `keyframe ${ki}: unknown velocityClass`);
    }
    const velCap = VELOCITY_CLASS_CAPS[kf.velocityClass ?? 'deliberate'];

    // Overflow beyond MAX_TARGETS_PER_KEYFRAME is NON-FATAL: the first 12 (in
    // the deterministic order received) play; the rest are refused per-target
    // with reason 'target-limit' — the keyframe and plan survive.
    const keptTargets = requestedTargets.slice(0, MAX_TARGETS_PER_KEYFRAME);
    const overflowTargets = requestedTargets.slice(MAX_TARGETS_PER_KEYFRAME);

    const targets: ResolvedSequenceKeyframe['targets'] = [];
    let maxDeltaDeg = 0;
    for (const t of keptTargets) {
      if (!t || typeof t.joint !== 'string' || typeof t.motion !== 'string') {
        return refuse(motion, `keyframe ${ki}: malformed target`);
      }
      const r = resolveCommandTarget(
        { action: 'set-joint', joint: t.joint, motion: t.motion, targetDegrees: t.targetDegrees },
        variantCfg,
      );
      const outcome: SequenceTargetOutcome = {
        keyframe: ki,
        joint: t.joint,
        motion: t.motion,
        status: r.status,
        requestedDegrees: t.targetDegrees,
      };
      if (r.clampedDegrees != null) outcome.clampedDegrees = r.clampedDegrees;
      if (r.limitedBy != null) outcome.limitedBy = r.limitedBy;
      if (r.painful != null) outcome.painful = r.painful;
      if (r.reason != null) outcome.reason = r.reason;
      outcomes.push(outcome);

      if (r.status === 'refused' || r.clampedDegrees == null) continue; // dropped, reported

      const key = `${t.joint}.${t.motion}`;
      const from = lastClamped.get(key) ?? 0; // first command of a joint: from neutral
      maxDeltaDeg = Math.max(maxDeltaDeg, Math.abs(r.clampedDegrees - from));
      lastClamped.set(key, r.clampedDegrees);
      // A joint.motion re-commanded within one keyframe: last wins (absolute).
      const dup = targets.findIndex((x) => x.joint === t.joint && x.motion === t.motion);
      if (dup >= 0) targets.splice(dup, 1);
      targets.push({ joint: t.joint, motion: t.motion, clampedDegrees: r.clampedDegrees });
      survivors += 1;
    }
    for (const t of overflowTargets) {
      outcomes.push({
        keyframe: ki,
        joint: t && typeof t.joint === 'string' ? t.joint : '',
        motion: t && typeof t.motion === 'string' ? t.motion : '',
        status: 'refused',
        requestedDegrees: t && typeof t.targetDegrees === 'number' ? t.targetDegrees : Number.NaN,
        reason: 'target-limit',
      });
    }

    // Realistic timing: the fastest joint may not exceed this keyframe's
    // velocity-class cap (default 'deliberate' = 240°/s).
    const floorMs = Math.max(MIN_KEYFRAME_MS, (maxDeltaDeg / velCap) * 1000);
    let durationMs = kf.durationMs < floorMs ? Math.ceil(floorMs) : kf.durationMs;
    // Any adjustment away from the request — raised to the floor OR lowered to
    // the playability cap — is reported so the caller can narrate honestly.
    let timingAdjusted = kf.durationMs < floorMs;
    // Playability beats both the request AND the velocity floor: a keyframe may
    // never exceed MAX_KEYFRAME_MS (an unbounded duration would freeze a host's
    // serialized command chain forever).
    if (durationMs > MAX_KEYFRAME_MS) {
      durationMs = MAX_KEYFRAME_MS;
      timingAdjusted = true;
    }
    const holdMs = Math.min(kf.holdMs ?? 0, MAX_KEYFRAME_MS);
    if ((kf.holdMs ?? 0) > MAX_KEYFRAME_MS) timingAdjusted = true;
    resolvedKeyframes.push({
      targets,
      durationMs,
      holdMs,
      ...(timingAdjusted ? { timingAdjusted: true } : {}),
      ...(kfRoot ? { root: kfRoot } : {}),
      stance: kf.stance === 'planted' || kf.stance === 'floating' ? kf.stance : motionStance,
    });
  }

  if (survivors === 0 && postureDirectives === 0) {
    // Whole-motion refusal — but every target's individual refusal is still
    // reported so the caller can narrate WHY nothing was achievable. A motion
    // whose keyframes carry root/stance directives still plays (posture-only).
    return { ...refuse(motion, 'no-achievable-targets'), outcomes };
  }

  return {
    status: 'ok',
    ...(motion.name ? { name: motion.name } : {}),
    keyframes: resolvedKeyframes,
    outcomes,
    loop: !!motion.loop,
    startFrom,
    ...(motion.modifiers ? { modifiers: motion.modifiers } : {}),
    ...(Array.isArray(motion.contacts) && motion.contacts.length
      ? { contacts: motion.contacts.filter((c) => c && typeof c.foot === 'string') }
      : {}),
  };
}

/** One target's MEASURED landing at its keyframe (computeJointAngles readback
 *  after the tween settles — what the patient actually did, not the plan). */
export interface ComposedKeyframeMeasurement {
  keyframe: number;
  joint: string;
  motion: string;
  /** The planned (ROM-clamped) target. */
  clampedDegrees: number;
  /** The measured angle at settle (absent when the stage couldn't measure). */
  measuredDegrees?: number;
}

/** What the stage answers after playing a composed motion (structural — the
 *  stage implements it, hosts narrate from it). */
export interface ComposedMotionPlaybackResult {
  /** 'completed' = one-shot settled; 'playing' = loop started (measurements
   *  are from the first pass); 'interrupted' = playback was superseded
   *  mid-play (a newer command / variant switch / unmount) — `measurements`
   *  hold only the keyframes that settled before the interruption and
   *  `reason` says why; 'refused' = stage unavailable / bad input. */
  status: 'completed' | 'playing' | 'interrupted' | 'refused';
  name?: string;
  reason?: string;
  measurements: ComposedKeyframeMeasurement[];
  /** Final measured angles at the LAST keyframe for every joint.motion the
   *  sequence touched, keyed `joint.motion`. */
  finalAngles: Record<string, number>;
  loop: boolean;
  /** True when any keyframe's duration was raised to the velocity floor. */
  timingAdjusted: boolean;
}

/** Resolved whole-body root state for one keyframe (what the stage tweens the
 *  MODEL ROOT to). `quat`/`translateM` carry FORWARD across keyframes — a
 *  keyframe that doesn't set a root posture keeps the previous one. */
export interface KeyframeRootState {
  /** Model-root orientation quaternion [x,y,z,w] (identity when upright). */
  quat: [number, number, number, number];
  /** Model-root translation in meters [x,y,z] from the anatomic stance origin
   *  (the PLANTED foot-pin Y drop is applied by the stage ON TOP of this). */
  translateM: [number, number, number];
  /** Effective stance for this keyframe. */
  stance: StanceMode;
}

/** The built playback plan: one target CustomPose per keyframe plus its
 *  timing and whole-body root state. Poses persist unmentioned joints across
 *  keyframes; root state persists posture/travel across keyframes. */
export interface ComposedMotionPoses {
  poses: CustomPose[];
  /** Parallel to `poses`: the root orientation/translation/stance per keyframe. */
  roots: KeyframeRootState[];
  durationsMs: number[];
  holdsMs: number[];
  loop: boolean;
  /** Resolved start mode carried through for the stage/host. */
  startFrom: 'current' | 'neutral';
}

/** Options threading the CURRENT on-stage pose into the build (continuity). */
export interface BuildSequenceOptions {
  /** The pose the body is CURRENTLY in. When the motion's startFrom is
   *  'current' (default), keyframe poses fold onto this so unmentioned joints
   *  persist across compositions instead of snapping back to anatomic rest. */
  currentPose?: CustomPose | null;
  /** The root state the body is CURRENTLY in (orientation/translation), so a
   *  second motion continues from the live posture rather than upright origin. */
  currentRoot?: { quat?: [number, number, number, number]; translateM?: [number, number, number] } | null;
}

/**
 * Build one target CustomPose per resolved keyframe by folding
 * {@link buildCommandPose} over the keyframe's targets (chained via
 * `fromPose`). Each keyframe's fold STARTS from the previous keyframe's
 * built pose, so joints a keyframe doesn't mention persist — and because
 * commanded targets are absolute (built from the anatomic-rest local, not
 * incremental), re-commanding a joint REPLACES its angle.
 *
 * @param baselinePose Full-skeleton anatomic-rest pose (the rest-local source
 *   every command builds from — same contract as buildCommandPose).
 * @param resolved A status-'ok' result from {@link resolveComposedMotion}.
 * @param variantCfg Variant the poses are stamped against.
 * @param rest Rest reference (REQUIRED for shoulder flexion/abduction —
 *   their world-plane swing needs the rest world orientation).
 */
export function buildSequencePoses(
  baselinePose: CustomPose,
  resolved: ResolvedComposedMotion,
  variantCfg: BodyVariantConfig,
  rest?: JointAngleRestReference | null,
  opts?: BuildSequenceOptions,
): ComposedMotionPoses {
  const poses: CustomPose[] = [];
  const roots: KeyframeRootState[] = [];
  const durationsMs: number[] = [];
  const holdsMs: number[] = [];
  // CROSS-MOTION CONTINUITY: fold onto the CURRENT pose (unmentioned joints
  // persist across compositions) unless startFrom==='neutral' (return to
  // anatomic rest first). A fresh motion with no currentPose degrades to the
  // anatomic baseline — identical to the pre-continuity behavior.
  let prev: CustomPose =
    resolved.startFrom === 'neutral' ? baselinePose : opts?.currentPose ?? baselinePose;
  // Root state carried forward across keyframes. Seeds from the current root
  // (continuity) unless returning to neutral.
  let curQuat: [number, number, number, number] =
    resolved.startFrom !== 'neutral' && opts?.currentRoot?.quat
      ? [...opts.currentRoot.quat]
      : [0, 0, 0, 1];
  let curTranslate: [number, number, number] =
    resolved.startFrom !== 'neutral' && opts?.currentRoot?.translateM
      ? [...opts.currentRoot.translateM]
      : [0, 0, 0];
  // Trunk sagittal state across the fold (clamped clinical degrees). The
  // shoulder-flexion readout is WORLD-anchored while its construction swings
  // from the REST world orientation, so a flexed/extended trunk shifts the
  // measured arm elevation by exactly the trunk's sagittal angle
  // (rig-verified: trunk −5° read as +5° extra shoulder flexion). Compensate at
  // the MOTOR level — command clamped + trunkSum so the humerothoracic readout
  // lands ON the clamped target.
  const trunkFlex = new Map<string, number>();
  for (const kf of resolved.keyframes) {
    for (const t of kf.targets) {
      if ((t.joint === 'Spine_Lower' || t.joint === 'Spine_Upper') && t.motion === 'flexion') {
        trunkFlex.set(t.joint, t.clampedDegrees);
      }
    }
    const trunkSum = (trunkFlex.get('Spine_Lower') ?? 0) + (trunkFlex.get('Spine_Upper') ?? 0);

    // GROUP targets by joint, then COMPOSE each joint's motions into ONE pose —
    // the fix for the same-bone overwrite bug (two motions on one bone used to
    // clobber each other, e.g. shoulder flexion + abduction).
    const byJoint = new Map<string, ComposedJointTarget[]>();
    for (const t of kf.targets) {
      const deg = t.motion === 'shoulderFlexion' ? t.clampedDegrees + trunkSum : t.clampedDegrees;
      const list = byJoint.get(t.joint) ?? [];
      list.push({ motion: t.motion, degrees: deg });
      byJoint.set(t.joint, list);
    }
    let pose: CustomPose = prev;
    for (const [joint, group] of byJoint) {
      const built = buildComposedCommandPose(baselinePose, joint, group, variantCfg, pose, rest);
      if (built) pose = built; // null only for wholly-unsupported joints — already dropped
    }

    // Root posture/travel carry forward; a keyframe that sets them overrides.
    if (kf.root?.orient) curQuat = rootOrientQuatTuple(kf.root.orient);
    if (kf.root?.translateM) curTranslate = [...kf.root.translateM];

    poses.push(pose);
    roots.push({ quat: [...curQuat], translateM: [...curTranslate], stance: kf.stance });
    durationsMs.push(kf.durationMs);
    holdsMs.push(kf.holdMs);
    prev = pose;
  }
  return { poses, roots, durationsMs, holdsMs, loop: resolved.loop, startFrom: resolved.startFrom };
}
