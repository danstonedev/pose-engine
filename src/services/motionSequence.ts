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
 * achievable travel) are DROPPED from their keyframe but fully REPORTED in
 * `outcomes`; the surviving siblings still play. The WHOLE motion refuses
 * only when the shape is invalid (limits, malformed keyframes) or when zero
 * targets survive anywhere — mirroring the single-command contract where the
 * patient does what they can and tells you what they couldn't.
 */
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';
import type { JointAngleRestReference } from './jointAngles';
import {
  buildCommandPose,
  resolveCommandTarget,
  type ExamMovementLimiter,
  type ExamMovementRefusalReason,
} from './movementCommand';

// ── Composed-motion types (structural — hosts mirror these shapes) ──────────

/** One absolute joint target inside a keyframe (registry clinical degrees). */
export interface SequenceTarget {
  /** ROM-registry canonical joint key, e.g. 'R_UpperArm'. */
  joint: string;
  /** That joint's registry motion/field key, e.g. 'shoulderFlexion'. */
  motion: string;
  /** Absolute target in the registry's clinical sign convention. */
  targetDegrees: number;
}

/** One timed keyframe: the targets to reach, how long the travel takes, and
 *  an optional hold at the reached position (assessment moments, end-range). */
export interface SequenceKeyframe {
  targets: SequenceTarget[];
  /** Travel time into this keyframe, ms (raised to a realistic floor). */
  durationMs: number;
  /** Optional dwell at the keyframe once reached, ms. */
  holdMs?: number;
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

/** A novel movement composed as timed keyframes over the command vocabulary. */
export interface ComposedMotion {
  /** Short human label the author/AI gives its creation. */
  name?: string;
  keyframes: SequenceKeyframe[];
  /** Cycle the keyframes until stopped (the last keyframe tweens back into
   *  the first). Default false: play once and settle at the last keyframe. */
  loop?: boolean;
  modifiers?: ComposedMotionModifiers;
}

// ── Limits (exported so hosts + tool schemas cite the same numbers) ─────────

/** Most keyframes a composed motion may hold. */
export const MAX_KEYFRAMES = 12;
/** Most joint targets a single keyframe may hold. */
export const MAX_TARGETS_PER_KEYFRAME = 8;
/** Fast clinical motion bound — no commanded joint may be asked to travel
 *  faster than this; keyframe durations are raised to respect it. */
export const MAX_ANGULAR_VELOCITY_DEG_S = 240;
/** Shortest a keyframe's travel may be, ms. */
export const MIN_KEYFRAME_MS = 150;

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
  reason?: ExamMovementRefusalReason;
}

/** A keyframe after clamping + timing enforcement. `targets` carry the
 *  CLAMPED degrees; refused targets are gone (see `outcomes`). */
export interface ResolvedSequenceKeyframe {
  targets: { joint: string; motion: string; clampedDegrees: number }[];
  durationMs: number;
  holdMs: number;
  /** True when durationMs was raised to the realistic-velocity floor. */
  timingAdjusted?: boolean;
}

export interface ResolvedComposedMotion {
  status: 'ok' | 'refused';
  name?: string;
  keyframes: ResolvedSequenceKeyframe[];
  /** Every requested target's outcome, in keyframe order. */
  outcomes: SequenceTargetOutcome[];
  loop: boolean;
  modifiers?: ComposedMotionModifiers;
  /** Why the WHOLE motion refused (invalid shape / nothing achievable). */
  reason?: string;
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
    reason,
  };
}

/**
 * Validate a composed motion's shape + limits, clamp every target through
 * {@link resolveCommandTarget} (the SAME truth path as single commands:
 * normative ROM ∩ scenario constraints, refusal rule, painful arc), and
 * enforce realistic timing per keyframe. Pure — reads the module-level
 * scenario-constraint store, writes nothing.
 */
export function resolveComposedMotion(
  motion: ComposedMotion,
  variantCfg?: BodyVariantConfig,
): ResolvedComposedMotion {
  if (!motion || !Array.isArray(motion.keyframes)) return refuse(motion, 'invalid-shape');
  if (motion.keyframes.length === 0) return refuse(motion, 'no-keyframes');
  if (motion.keyframes.length > MAX_KEYFRAMES) {
    return refuse(motion, `too-many-keyframes (max ${MAX_KEYFRAMES})`);
  }

  const outcomes: SequenceTargetOutcome[] = [];
  const resolvedKeyframes: ResolvedSequenceKeyframe[] = [];
  /** Last clamped value per `joint.motion` — the previous keyframe's position
   *  for the velocity check. Joints never commanded start at neutral 0°. */
  const lastClamped = new Map<string, number>();
  let survivors = 0;

  for (const [ki, kf] of motion.keyframes.entries()) {
    if (!kf || !Array.isArray(kf.targets) || kf.targets.length === 0) {
      return refuse(motion, `keyframe ${ki}: needs at least one target`);
    }
    if (kf.targets.length > MAX_TARGETS_PER_KEYFRAME) {
      return refuse(motion, `keyframe ${ki}: too many targets (max ${MAX_TARGETS_PER_KEYFRAME})`);
    }
    if (!isFiniteNum(kf.durationMs) || kf.durationMs < 0) {
      return refuse(motion, `keyframe ${ki}: durationMs must be a non-negative number`);
    }
    if (kf.holdMs != null && (!isFiniteNum(kf.holdMs) || kf.holdMs < 0)) {
      return refuse(motion, `keyframe ${ki}: holdMs must be a non-negative number`);
    }

    const targets: ResolvedSequenceKeyframe['targets'] = [];
    let maxDeltaDeg = 0;
    for (const t of kf.targets) {
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

    // Realistic timing: the fastest joint may not exceed the velocity bound.
    const floorMs = Math.max(MIN_KEYFRAME_MS, (maxDeltaDeg / MAX_ANGULAR_VELOCITY_DEG_S) * 1000);
    const timingAdjusted = kf.durationMs < floorMs;
    resolvedKeyframes.push({
      targets,
      durationMs: timingAdjusted ? Math.ceil(floorMs) : kf.durationMs,
      holdMs: kf.holdMs ?? 0,
      ...(timingAdjusted ? { timingAdjusted: true } : {}),
    });
  }

  if (survivors === 0) {
    // Whole-motion refusal — but every target's individual refusal is still
    // reported so the caller can narrate WHY nothing was achievable.
    return { ...refuse(motion, 'no-achievable-targets'), outcomes };
  }

  return {
    status: 'ok',
    ...(motion.name ? { name: motion.name } : {}),
    keyframes: resolvedKeyframes,
    outcomes,
    loop: !!motion.loop,
    ...(motion.modifiers ? { modifiers: motion.modifiers } : {}),
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
   *  are from the first pass); 'refused' = stage unavailable / bad input. */
  status: 'completed' | 'playing' | 'refused';
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

/** The built playback plan: one target CustomPose per keyframe plus its
 *  timing. Poses persist unmentioned joints across keyframes. */
export interface ComposedMotionPoses {
  poses: CustomPose[];
  durationsMs: number[];
  holdsMs: number[];
  loop: boolean;
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
): ComposedMotionPoses {
  const poses: CustomPose[] = [];
  const durationsMs: number[] = [];
  const holdsMs: number[] = [];
  let prev: CustomPose = baselinePose;
  // Trunk sagittal state across the fold (clamped clinical degrees). The
  // shoulder-flexion readout is WORLD-anchored while its construction swings
  // from the REST world orientation, so a flexed/extended trunk shifts the
  // measured arm elevation by exactly the trunk's sagittal angle
  // (rig-verified in motionSequence.test.ts: trunk −5° read as +5° extra
  // shoulder flexion). Compensate at the MOTOR level — command
  // clamped + trunkSum so the humerothoracic readout lands ON the clamped
  // target — the same pre-compensation family as the finger fits. Other
  // proximal→distal couplings (lateral tilt vs abduction) are small and left
  // uncompensated.
  const trunkFlex = new Map<string, number>();
  for (const kf of resolved.keyframes) {
    // The keyframe's trunk end-state first — all its targets settle together.
    for (const t of kf.targets) {
      if ((t.joint === 'Spine_Lower' || t.joint === 'Spine_Upper') && t.motion === 'flexion') {
        trunkFlex.set(t.joint, t.clampedDegrees);
      }
    }
    const trunkSum = (trunkFlex.get('Spine_Lower') ?? 0) + (trunkFlex.get('Spine_Upper') ?? 0);
    let pose: CustomPose = prev;
    for (const t of kf.targets) {
      const buildDeg =
        t.motion === 'shoulderFlexion' ? t.clampedDegrees + trunkSum : t.clampedDegrees;
      const built = buildCommandPose(
        baselinePose,
        { action: 'set-joint', joint: t.joint, motion: t.motion, targetDegrees: buildDeg },
        buildDeg,
        variantCfg,
        pose,
        rest,
      );
      if (built) pose = built; // null only for unsupported motions — already dropped
    }
    poses.push(pose);
    durationsMs.push(kf.durationMs);
    holdsMs.push(kf.holdMs);
    prev = pose;
  }
  return { poses, durationsMs, holdsMs, loop: resolved.loop };
}
