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
 * the chain starts its arc slightly later. Three invariants are preserved
 * exactly:
 *
 *   1. At `local == 1` EVERY bone's parameter is 1, so the pose still arrives
 *      precisely on target. Keyframe boundaries, holds, and every settled
 *      goniometric measurement are byte-identical to the un-staggered path —
 *      only the trajectory BETWEEN keyframes changes. The one exception reads
 *      the path itself: the hand-reach plant (footContact.solveHandReach)
 *      latches the floor point where the hand first reaches the floor, so a
 *      hand-planted settle (quadruped, plank, push-up, bird-dog) moves with any
 *      re-timing of the arm's PATH — making this warp C¹ moved it up to
 *      2.9° / 10 mm. It does not move with the sample rate: the latch finds the
 *      moment of contact between frames, so 30, 60 and 120 Hz and a jittered
 *      clock settle within 0.8 mm / 0.4° (male rig; 10.4 mm / 2.0° when it
 *      latched on the first frame inside the floor band).
 *   2. A delayed bone's motion stays C¹: the delay is a DWELL in raw TIME that
 *      precedes the ease ({@link delayedOnset}), so the bone leaves rest with
 *      zero velocity, and it only ever dwells where it is already at rest.
 *   3. The delay scheme is defined ONCE, here. The simple exam-command pose
 *      tween (ExamStage3D.stepTween) consumes it via
 *      {@link stagedBlendWithBaseline}; COMPOSED trajectory playback (the SQUAD
 *      spline both the live stage and the offline sampler evaluate through
 *      motionTrajectory.sampleAt) consumes {@link trajectoryBoneDelay},
 *      {@link delayedOnset} and {@link followThroughKnotSlope}. Stage and
 *      sampler share one trajectory builder, so a headless recording remains
 *      frame-for-frame what the stage shows.
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
 * Onset delay (fraction of one trajectory SEGMENT, in [0,1)) a bone receives in
 * COMPOSED TRAJECTORY playback — the proximal→distal follow-through warp
 * (roadmap 2.2). motionTrajectory gives each delayed bone its own copy of the
 * shared time-warp: leaving a STOP it dwells for `d` of the segment's TIME and
 * then eases out ({@link delayedOnset} — the tween path's own scheme), and
 * through a fly-through knot it keeps a C¹ share of the shared slope that shrinks
 * where its own path reverses ({@link followThroughKnotSlope}). Every knot is
 * still reached EXACTLY at its knot time (the settle/measurement contract is
 * untouched, bar the reach-plant latch noted above, which plants where the
 * arm's path reaches the floor) and the lag lives mid-segment, where the eye
 * reads overlap.
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
 * THE onset warp both playback paths share: raw, time-linear progress `sigma` ∈
 * [0,1] of a stroke that leaves REST → the delayed bone's own raw progress, held
 * at 0 for the first `delay` of the window and renormalized over the rest (so
 * sigma = 1 still maps to exactly 1).
 *
 * It must be applied to TIME, BEFORE the ease. Every ease the engine starts from
 * rest with has zero slope at 0 (ease-in-out cubic, the time-warp's Hermite from
 * a stop), so the bone leaves its dwell with zero velocity. Applied AFTER the
 * ease — to the already-moving eased parameter, as the trajectory once did — the
 * dwell ends mid-acceleration and the bone jumps from still to 1/(1 − d) × the
 * chain's speed in one frame (measured on the DDx chair stand's folded forearms
 * at 120 Hz: still until 133 ms, then 43 → 235°/s from one frame to the next).
 */
export function delayedOnset(sigma: number, delay: number): number {
  if (delay <= 0) return clamp01(sigma);
  const span = 1 - delay;
  // At sigma == 1 the numerator equals the denominator → exactly 1 for every
  // delay, guaranteeing on-target arrival.
  return span <= 0 ? (sigma >= 1 ? 1 : 0) : clamp01((sigma - delay) / span);
}

/**
 * Share of the shared time-warp slope a delayed bone keeps THROUGH a fly-through
 * knot, where `reversal` ∈ [0,1] says how much its own path turns back there (0 =
 * it passes straight on, 1 = it reverses, e.g. the top of an out-and-back).
 *
 * A bone moving through a knot cannot dwell there without stopping dead — the
 * old per-segment warp did exactly that at every keyframe of a gait cycle — so
 * its C¹ follow-through is a slowdown instead: the same slope on both sides of
 * the knot, reduced where it reverses. It lingers at its extreme and trails the
 * chain out of the turn (the "wrist reverses after the shoulder" cue); a bone
 * passing straight through keeps the chain's own speed (1).
 *
 * The floor 3 − 2/(1 − d) caps the cost: a stroke between two full reversals
 * then peaks at exactly 1/(1 − d) × the lockstep speed — the same bound the onset
 * dwell has (≈1.22× for the fingers, d = 0.18). Only a first stroke out of rest
 * INTO a full reversal pays both (fingers 1.31×, hand 1.26×; the old per-segment
 * dwell 1.27× / 1.23×). A gentler slowdown buys little: at 3/4 of this one or
 * less, the rig's fast arm wave shows the wrist leaving its turn one 120 Hz frame
 * after the shoulder — what plain lockstep shows — against two frames here.
 */
export function followThroughKnotSlope(delay: number, reversal: number): number {
  if (delay <= 0) return 1;
  const floor = Math.max(0, 3 - 2 / (1 - delay));
  return 1 - clamp01(reversal) * (1 - floor);
}

/**
 * Blend `from`→`to` (treating `null` as `baseline`, exactly like
 * {@link blendCustomPoseWithBaseline}) at raw progress `local` ∈ [0,1], applying
 * a proximal→distal onset stagger. The base easing (ease-in-out cubic) is
 * applied to each bone's own {@link delayedOnset} progress, so distal bones
 * start later — from rest, with zero velocity — yet all bones still reach the
 * target at `local == 1`.
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
  return blendCustomPosePerBone(effectiveFrom, effectiveTo, (poseKey) =>
    composedTweenEase(delayedOnset(l, chainOnsetDelay(poseKey) * stagger)),
  );
}
