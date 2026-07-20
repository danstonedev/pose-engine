/**
 * PROXIMAL-TO-DISTAL ONSET STAGGERING — the naturalism pass that sits on top of
 * the composed-motion tween WITHOUT touching the clamp-and-measure contract.
 *
 * The composed system historically moved every joint on one shared easing curve
 * with a single, simultaneous onset: hips, shoulder, elbow, wrist and fingers
 * all started and stopped at the same instant. That lockstep is the dominant
 * reason a composed exercise reads as "robotic" next to a mocap clip — real
 * human movement sequences down the kinetic chain (the trunk leads, the hand
 * follows).
 *
 * This module warps the per-bone interpolation parameter so a bone deeper in
 * the chain starts its arc slightly later. Two invariants are preserved exactly:
 *
 *   1. At `local == 1` EVERY bone's parameter is 1, so the pose still arrives
 *      precisely on target. Keyframe boundaries, holds, and every settled
 *      goniometric measurement are byte-identical to the un-staggered path —
 *      only the trajectory BETWEEN keyframes changes.
 *   2. The delay scheme is defined ONCE, here. The simple exam-command pose
 *      tween (ExamStage3D.stepTween) consumes it via
 *      {@link stagedBlendWithBaseline}; COMPOSED trajectory playback (the SQUAD
 *      spline both the live stage and the offline sampler evaluate through
 *      motionTrajectory.sampleAt) consumes it via {@link trajectoryBoneDelay} —
 *      the same delayed-and-renormalized per-bone parameter warp, applied to
 *      each bone's segment-local spline parameter. Stage and sampler share one
 *      trajectory builder, so a headless recording remains frame-for-frame what
 *      the stage shows.
 *
 * The root transform (pelvis / whole-body carriage) is the most proximal thing
 * of all and deliberately leads — callers keep driving it on the plain
 * {@link composedTweenEase} scalar, not through here.
 */

import type { CustomPose } from '../types';
import { blendCustomPosePerBone } from './poseRig';

/**
 * The composed-motion tween easing — ease-in-out cubic. This is THE one curve
 * the stage tween and the offline sampler share; keep it here so the stagger
 * warp and the base curve can never drift apart.
 */
export function composedTweenEase(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Fraction of the tween window the MOST distal joints (fingers / toes) lag the
 * trunk by. 0 disables staggering (pure lockstep). 0.18 gives a clearly human
 * proximal→distal sequence while keeping the induced peak-velocity bump on the
 * most-delayed joints modest (~1/(1-0.18) ≈ 1.22×, well inside the velocity
 * governor's clinical ceilings, and only on low-ROM digits).
 */
export const PROXIMAL_TO_DISTAL_STAGGER = 0.18;

// Rank along the kinetic chain, proximal (0) → distal. Keyed by the canonical
// bone name (the pose key with any L_/R_ side prefix stripped). Fingers, toes,
// and any unmapped-but-clearly-distal segment fall to CHAIN_MAX_RANK.
const CHAIN_RANK: Record<string, number> = {
  Hips: 0,
  Pelvis: 0,
  Waist: 1,
  Spine01: 1,
  Spine02: 2,
  Clavicle: 3,
  Neck: 3,
  Shoulder: 4,
  Thigh: 4,
  UpperArm: 5,
  Upperarm: 5,
  Calf: 5,
  Forearm: 6,
  Foot: 6,
  Head: 6,
  Hand: 7,
  ToeBase: 7,
};
const CHAIN_MAX_RANK = 8; // fingers / toes — the chain tips

function chainRank(poseKey: string): number {
  const canonical = poseKey.replace(/^[LR]_/, '');
  const exact = CHAIN_RANK[canonical];
  if (exact !== undefined) return exact;
  if (/^(Thumb|Index|Mid|Middle|Ring|Pinky|Little)/.test(canonical)) return CHAIN_MAX_RANK;
  if (/Toe/.test(canonical)) return CHAIN_MAX_RANK;
  if (/^Spine/.test(canonical)) return 2;
  return 3; // unknown → mid-chain (neutral; never the earliest or the latest)
}

/** Normalized onset delay in [0,1] for a pose key: 0 = leads, 1 = trails most. */
export function chainOnsetDelay(poseKey: string): number {
  return chainRank(poseKey) / CHAIN_MAX_RANK;
}

/** Fraction of the ARM-chain delay the axial column (spine / neck / head)
 *  receives in trajectory playback. The trunk is the driver, not the dragged
 *  segment — it gets only a whisper of lag (enough to soften the column, small
 *  enough that gaze stabilization's authored trunk↔neck counter-rotation phase
 *  is perturbed by ≲2% of a segment). */
const AXIAL_TRAJECTORY_FRACTION = 0.25;

/**
 * Segment-local onset delay (fraction of one trajectory SEGMENT, in [0,1)) a
 * bone receives in COMPOSED TRAJECTORY playback — the proximal→distal
 * follow-through warp (roadmap 2.2). motionTrajectory warps each bone's
 * segment-local SQUAD parameter `local` to `clamp((local − d)/(1 − d))` with
 * `d = trajectoryBoneDelay(key)`: both endpoints are preserved (0→0, 1→1), so
 * every bone still reaches every knot EXACTLY at its knot time (the
 * settle/measurement contract is untouched) and the lag lives mid-segment,
 * where the eye reads overlap.
 *
 * Scope (deliberately narrower than the tween-path {@link chainOnsetDelay}):
 *   - ARM chains (clavicle → fingers) get the full chain-ranked delay — the
 *     visible follow-through cue.
 *   - The AXIAL column (spine/neck/head) gets a tiny fraction of its rank.
 *   - LEGS + TOES get ZERO. Composed motions keep planted stance / foot-plant
 *     IK contacts / foot-driven travel through virtually their whole timeline;
 *     re-timing a leg mid-segment would drag the feet against the plant
 *     solvers and the slide-budget gates. (The stagger stays desirable there
 *     someday, but only with contact-aware gating — Wave 3 territory.)
 *   - ROOT motion is exempt by construction (the trajectory warps only bone
 *     series; root quat/translate ride the shared parameter).
 *   - UNKNOWN keys get zero (never delay what we cannot classify).
 *
 * Delay magnitude: chain rank × {@link PROXIMAL_TO_DISTAL_STAGGER} (0.18), the
 * same constant the tween path ships — hands ~0.16, fingers 0.18, clavicle
 * 0.09 of a segment. NOT mass-weighted: Winter's segment mass fractions
 * (centerOfMass.ts) would hand the heavy upper arm MORE lag than the light
 * hand, which is backwards for follow-through — the visible signature is the
 * light distal end trailing the driven proximal end. Chain rank encodes that
 * directly; mass-proportional settle stays a Wave-3 item (audit Phase C).
 */
export function trajectoryBoneDelay(poseKey: string): number {
  const canonical = poseKey.replace(/^[LR]_/, '');
  // Legs and toes: zero — do not fight the foot-plant IK / slide gates.
  if (/^(UpLeg|Leg$|Thigh|Calf|Foot|Toe)/.test(canonical)) return 0;
  // Arm chains (canonical 'Shoulder' IS the clavicle on this rig) + digits.
  if (
    /^(Shoulder|Clavicle|UpperArm|Upperarm|Forearm|Hand)/.test(canonical) ||
    /^(Thumb|Index|Mid|Middle|Ring|Pinky|Little|Finger)/.test(canonical)
  ) {
    return chainOnsetDelay(poseKey) * PROXIMAL_TO_DISTAL_STAGGER;
  }
  // Axial column: a whisper.
  if (/^(Spine|Waist|Neck|Head)/.test(canonical)) {
    return chainOnsetDelay(poseKey) * PROXIMAL_TO_DISTAL_STAGGER * AXIAL_TRAJECTORY_FRACTION;
  }
  return 0; // Hips/Pelvis/root-adjacent/unknown: the chain origin leads.
}

/**
 * Blend `from`→`to` (treating `null` as `baseline`, exactly like
 * {@link blendCustomPoseWithBaseline}) at raw progress `local` ∈ [0,1], applying
 * a proximal→distal onset stagger. The base easing (ease-in-out cubic) is
 * applied to each bone's own delayed-and-renormalized parameter, so distal
 * bones start later yet all bones still reach the target at `local == 1`.
 *
 * Pass `stagger = 0` to recover the exact original lockstep blend.
 */
export function stagedBlendWithBaseline(
  from: CustomPose | null | undefined,
  to: CustomPose | null | undefined,
  baseline: CustomPose | null | undefined,
  local: number,
  stagger: number = PROXIMAL_TO_DISTAL_STAGGER,
): CustomPose | null {
  const effectiveFrom = from ?? baseline ?? null;
  const effectiveTo = to ?? baseline ?? null;
  const l = clamp01(local);
  if (stagger <= 0) {
    const eased = composedTweenEase(l);
    return blendCustomPosePerBone(effectiveFrom, effectiveTo, () => eased);
  }
  return blendCustomPosePerBone(effectiveFrom, effectiveTo, (poseKey) => {
    const delay = chainOnsetDelay(poseKey) * stagger;
    const span = 1 - delay;
    // At l == 1 the numerator equals the denominator → jl == 1 for every bone,
    // guaranteeing exact on-target arrival regardless of delay.
    const jl = span <= 0 ? (l >= 1 ? 1 : 0) : clamp01((l - delay) / span);
    return composedTweenEase(jl);
  });
}
