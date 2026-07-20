// simMOVE Clinical Motion Engine — the HEALTHY-ASYMMETRY signature.
//
// WHY (audit · polish lens): "the default gait is a perfect L/R mirror — no
// 2-4% bilateral signature of a healthy human". Real healthy gait is NOT
// symmetric: limb dominance, small leg-length and strength differences leave a
// stable few-percent left/right signature (healthy-adult gait-asymmetry
// literature puts spatiotemporal + kinematic asymmetry around 2–6%; arm-swing
// amplitude asymmetry is the most visible of them). A mirror-perfect walk reads
// synthetic on long observation even when every joint curve is physiologic.
//
// WHAT: `healthySignature(motion, seed)` — a build-time transform in the house
// additive-pattern family (spinalGaitCoordination / stabilizeGaze): pure,
// per-keyframe, deterministic, opt-out. It scales the LEFT and RIGHT arm-swing
// amplitude (`shoulderFlexion` on L_/R_UpperArm) by 1 ± asym/2, where asym is
// a seed-derived 2–4% — so the two arms' swings differ by exactly asym of
// their mean while their SUM is preserved.
//
// AMPLITUDE-ONLY — the timing half was evaluated and deliberately REJECTED
// (the roadmap's "scale only amplitudes if timing proves too entangled"
// escape hatch). Two hard entanglements:
//   1. The Perry-timed walk's initial-contact keyframe (168 ms) sits 1 ms
//      above the 240°/s deliberate velocity-governor floor (≥167 ms for its
//      40° knee delta — see the walk template's timing note). ANY per-side
//      shortening trips the resolver's re-timing, and the travel builders'
//      `gaitStanceWindowsMs` / `contacts` are authored in ms on the assumption
//      the resolver passes durations through VERBATIM — a re-timed keyframe
//      silently desyncs the stance schedule from the foot plants.
//   2. Stride-TIME variability already ships live via `cadenceRate` (a global
//      C¹ clock warp); adding a second, build-time timing warp would double-
//      apply timing texture while risking the schedule desync above.
// Amplitude asymmetry has neither problem: durations, stance windows, foot
// contacts, and every leg channel are byte-untouched.
//
// WHY ARMS ONLY: leg-channel asymmetry (hip/knee amplitude) feeds the
// foot-driven travel derivation, the stance-foot plant IK, and the slide
// budgets — a 2-4% stride-length asymmetry would push against rig gates that
// exist to keep the feet honest. Arm swing is the most VISIBLE bilateral
// signature, drives nothing downstream but the (additive) trunk coordination,
// and — because every walk arm target comes as a ±mirror pair and the two
// scales sum to exactly 2 — the reciprocal arm-swing DIFFERENCE that powers
// `spinalGaitCoordination`'s thoracic counter-rotation is preserved exactly:
//   diff' = R·(1∓a/2) − L·(1±a/2) = diff  whenever L = −R.
// So head-steadiness / gaze gates measure the same trunk drive to the degree.
//
// CLEAN-MODE OPT-OUT: the gait builders apply this with a FIXED default seed;
// passing `asymmetry: false` to a builder (the same opt-out shape as
// `heelStrikeAccent: false`) skips it entirely for a textbook-symmetric,
// mirror-exact clinical reference gait.

import type { ComposedMotion } from './motionSequence';

/** Fixed default seed the gait builders use — ONE stable healthy signature
 *  per engine build (deterministic; recordings and gates can pin it). */
export const HEALTHY_SIGNATURE_SEED = 17;
/** Bounds of the seed-derived L/R arm-swing amplitude difference (fraction of
 *  the mean): the healthy-human 2–4% band. */
export const HEALTHY_ASYM_MIN = 0.02;
export const HEALTHY_ASYM_MAX = 0.04;

/** Deterministic seed → [0, 1) hash — the same fract-sin lattice hash the
 *  liveliness overlay uses (duplicated locally: one constant, zero coupling). */
function seedUnit(seed: number): number {
  const s = Number.isFinite(seed) ? seed : 0;
  const v = Math.sin(s * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * The seed's bilateral arm-swing scales: the DOMINANT side swings
 * (1 + asym/2)× its authored amplitude, the other (1 − asym/2)× — so
 * (dominant − other) / mean = asym exactly, and dominant + other = 2 (the
 * sum-preserving split that keeps the reciprocal swing difference intact).
 * `asym` ∈ [HEALTHY_ASYM_MIN, HEALTHY_ASYM_MAX); dominant side is seed-drawn.
 */
export function healthyArmAsymmetry(seed: number = HEALTHY_SIGNATURE_SEED): {
  asym: number;
  leftScale: number;
  rightScale: number;
} {
  const asym = HEALTHY_ASYM_MIN + (HEALTHY_ASYM_MAX - HEALTHY_ASYM_MIN) * seedUnit(seed);
  const leftDominant = seedUnit(seed + 1) < 0.5;
  return {
    asym,
    leftScale: leftDominant ? 1 + asym / 2 : 1 - asym / 2,
    rightScale: leftDominant ? 1 - asym / 2 : 1 + asym / 2,
  };
}

/**
 * Apply the healthy-asymmetry signature to a motion: per-side scaling of the
 * arm-swing amplitude (see module header for the full rationale and the
 * documented amplitude-only choice). Pure — fresh keyframe/target objects,
 * the input is never mutated; deterministic per seed; touches ONLY
 * `L_UpperArm.shoulderFlexion` / `R_UpperArm.shoulderFlexion` targets (all
 * durations, holds, roots, stance windows, contacts and every other channel
 * are carried through byte-identical).
 */
export function healthySignature(
  motion: ComposedMotion,
  seed: number = HEALTHY_SIGNATURE_SEED,
): ComposedMotion {
  const { leftScale, rightScale } = healthyArmAsymmetry(seed);
  const keyframes = motion.keyframes.map((kf) => {
    if (!kf.targets?.length) return kf;
    let touched = false;
    const targets = kf.targets.map((t) => {
      if (t.motion !== 'shoulderFlexion') return t;
      if (t.joint !== 'L_UpperArm' && t.joint !== 'R_UpperArm') return t;
      touched = true;
      const scale = t.joint === 'L_UpperArm' ? leftScale : rightScale;
      return { ...t, targetDegrees: t.targetDegrees * scale };
    });
    return touched ? { ...kf, targets } : kf;
  });
  return { ...motion, keyframes };
}
