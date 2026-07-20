// simMOVE Clinical Motion Engine — the EYE MICRO-GAZE overlay (Wave 5 · 5.1).
//
// WHY: the runtime GLBs ship real eye bones (CC_Base_L_Eye / CC_Base_R_Eye) but
// until this wave they were unmapped and frozen in-socket — taxidermy at
// tutorial camera distances. Real eyes are never still: they counter-rotate
// against small head movements (the vestibulo-ocular reflex — gaze stays ON the
// thing being looked at) and make small, irregular saccades between fixations
// with a slow drift in between. Blink morphs were stripped at export (a hard
// ceiling — no blinks), so rotation-in-socket is the whole budget, and it is
// enough to end the statue read.
//
// SCOPE: pure angle functions ONLY, so they unit-test off the rAF loop — the
// same charter as services/liveliness. The stage (ExamStage3D) accumulates
// wall-clock time, measures the head's residual yaw/pitch in the MODEL-ROOT
// frame (so travel heading and root reorientation never register as residual),
// and applies the returned gaze angles to both eye bones inside the same
// undo/reapply sandwich as idle liveliness — recordings, goniometry, pose
// serialization and GLB export always see the eyes at rest. LIVE-ONLY: never
// enters the offline sampler; determinism/byte-identity stays intact.
//
// `amount` is the same 0..1 realism dial as liveliness: 0 ⇒ EXACTLY zero (a
// clean statue eye — no absorb, no saccade), ~0.4 is the shipped default.
// Deterministic per (tSec, amount, seed) like idleWeightShift, so tests pin it
// and two stages never sync up (per-boot random seed).

/** Saccade fixation-interval bounds, seconds — irregular, never metronomic. */
export const EYE_SACCADE_MIN_INTERVAL_S = 0.8;
export const EYE_SACCADE_MAX_INTERVAL_S = 3;
/** Saccade settle time, seconds (~150 ms — the fast conjugate jump). */
export const EYE_SACCADE_SETTLE_S = 0.15;
/** Saccade step amplitude bounds at amount = 1, degrees (the size of one
 *  gaze SHIFT, before the fixation walk reflects off its range bounds). */
export const EYE_SACCADE_MIN_DEG = 1;
export const EYE_SACCADE_MAX_DEG = 4;
/** Fixation-target range, degrees: the random walk of fixation points stays
 *  within ±this in yaw (pitch scaled by EYE_PITCH_SCALE). */
export const EYE_GAZE_RANGE_DEG = 4;
/** Vertical saccades are smaller than horizontal ones (human eyes favour the
 *  horizontal meridian) — pitch amplitude/range scale. */
export const EYE_PITCH_SCALE = 0.6;
/** Peak slow inter-saccadic drift at amount = 1, degrees per axis. */
export const EYE_DRIFT_PEAK_DEG = 0.35;
/** Cap on the gaze-absorb counter-rotation (per axis), degrees. The
 *  stabilizeGaze head residual in gait is ~0.7–1.5°; this cap only matters for
 *  large authored head excursions (trunk flexion etc.), where a partial,
 *  capped counter still reads natural. */
export const EYE_ABSORB_CAP_DEG = 8;
/** Hard cap on the TOTAL eye rotation per axis, degrees — the in-socket
 *  budget. Nothing this module returns ever exceeds it. */
export const EYE_TOTAL_CAP_DEG = 8;
/** Number of fixation intervals in the repeating saccade super-cycle. The
 *  cycle period is seed-derived (~15–30 s); the slow drift runs on
 *  incommensurate wall-clock sines, so repeats never align visibly. */
export const EYE_SACCADE_CYCLE_N = 16;

/** Clamp to [0,1] and coerce non-finite to 0 — a bad dial can never perturb. */
function safeAmount(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return amount < 0 ? 0 : amount > 1 ? 1 : amount;
}

/** Deterministic seed → [0, 1) hash (the classic fract-sin lattice hash) —
 *  same construction as liveliness.idleWeightShift, duplicated locally so this
 *  module stays dependency-free of the trunk overlay. */
function seedUnit(seed: number): number {
  const s = Number.isFinite(seed) ? seed : 0;
  const v = Math.sin(s * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function clampDeg(v: number, cap: number): number {
  return v < -cap ? -cap : v > cap ? cap : v;
}

/** Reflect `v` back into [−bound, bound] (preserves step size at the range
 *  edge instead of flattening against it). Valid for |v| ≤ 3·bound. */
function reflect(v: number, bound: number): number {
  if (v > bound) return 2 * bound - v;
  if (v < -bound) return -2 * bound - v;
  return v;
}

/** The seed-derived fixation-interval durations of one saccade super-cycle,
 *  seconds — each strictly within [EYE_SACCADE_MIN_INTERVAL_S,
 *  EYE_SACCADE_MAX_INTERVAL_S], irregular per index. Exported so tests can pin
 *  the interval distribution directly. */
export function saccadeIntervalsS(seed: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < EYE_SACCADE_CYCLE_N; k += 1) {
    out.push(
      EYE_SACCADE_MIN_INTERVAL_S +
        (EYE_SACCADE_MAX_INTERVAL_S - EYE_SACCADE_MIN_INTERVAL_S) * seedUnit(seed + 3 * k + 5),
    );
  }
  return out;
}

/** The seed-derived fixation targets of one super-cycle, degrees — a bounded
 *  random walk (step amplitude 1–4°, direction seed-hashed, reflected off the
 *  ±EYE_GAZE_RANGE_DEG range so fixations never pile up at an edge). Exported
 *  for tests. */
export function saccadeTargetsDeg(seed: number): Array<{ yawDeg: number; pitchDeg: number }> {
  const out: Array<{ yawDeg: number; pitchDeg: number }> = [];
  let yaw = 0;
  let pitch = 0;
  const pitchBound = EYE_GAZE_RANGE_DEG * EYE_PITCH_SCALE;
  for (let k = 0; k < EYE_SACCADE_CYCLE_N; k += 1) {
    const ampl =
      EYE_SACCADE_MIN_DEG + (EYE_SACCADE_MAX_DEG - EYE_SACCADE_MIN_DEG) * seedUnit(seed + 7 * k + 40);
    const dir = 2 * Math.PI * seedUnit(seed + 11 * k + 80);
    yaw = reflect(yaw + ampl * Math.cos(dir), EYE_GAZE_RANGE_DEG);
    pitch = reflect(pitch + ampl * EYE_PITCH_SCALE * Math.sin(dir), pitchBound);
    out.push({ yawDeg: yaw, pitchDeg: pitch });
  }
  return out;
}

/**
 * Saccadic gaze offset at time `tSec`, degrees — fixation-to-fixation jumps
 * with a ~150 ms smoothstep settle, plus a slow incommensurate drift between
 * them. Deterministic per (tSec, amount, seed); continuous in `tSec` except
 * for the intended fast (but still C0) saccade ramps. `amount` 0 ⇒ exactly
 * {0, 0}. Bounded per axis by amount × (EYE_GAZE_RANGE_DEG + EYE_DRIFT_PEAK_DEG).
 */
export function saccadeGaze(
  tSec: number,
  amount: number,
  seed: number,
): { yawDeg: number; pitchDeg: number } {
  const a = safeAmount(amount);
  if (a === 0 || !Number.isFinite(tSec)) return { yawDeg: 0, pitchDeg: 0 };
  const intervals = saccadeIntervalsS(seed);
  const targets = saccadeTargetsDeg(seed);
  const periodS = intervals.reduce((s, d) => s + d, 0);
  let local = tSec % periodS;
  if (local < 0) local += periodS; // negative t is still deterministic
  let k = 0;
  while (k < EYE_SACCADE_CYCLE_N - 1 && local >= intervals[k]!) {
    local -= intervals[k]!;
    k += 1;
  }
  const prev = targets[(k + EYE_SACCADE_CYCLE_N - 1) % EYE_SACCADE_CYCLE_N]!;
  const tgt = targets[k]!;
  const s = Math.min(1, Math.max(0, local / EYE_SACCADE_SETTLE_S));
  const ease = s * s * (3 - 2 * s); // smoothstep — the ~150 ms settle
  const driftYaw =
    EYE_DRIFT_PEAK_DEG * Math.sin(2 * Math.PI * 0.087 * tSec + 2 * Math.PI * seedUnit(seed + 7));
  const driftPitch =
    EYE_DRIFT_PEAK_DEG *
    EYE_PITCH_SCALE *
    Math.sin(2 * Math.PI * 0.061 * tSec + 2 * Math.PI * seedUnit(seed + 11));
  return {
    yawDeg: a * (prev.yawDeg + (tgt.yawDeg - prev.yawDeg) * ease + driftYaw),
    pitchDeg: a * (prev.pitchDeg + (tgt.pitchDeg - prev.pitchDeg) * ease + driftPitch),
  };
}

/**
 * TOTAL eye gaze offset relative to the head, degrees — the one call the stage
 * makes per frame. Combines:
 *
 *  1. GAZE ABSORB — the vestibulo-ocular counter: minus the head's residual
 *     yaw/pitch (the stabilizeGaze leftover, measured by the caller in the
 *     model-root frame), capped ±EYE_ABSORB_CAP_DEG per axis. Full-strength
 *     whenever the dial is on (stabilization is function, not texture), zero
 *     in clean mode.
 *  2. SACCADES + DRIFT — {@link saccadeGaze}, scaled by `amount`.
 *
 * The sum is hard-clamped to ±EYE_TOTAL_CAP_DEG per axis — the in-socket
 * budget nothing can exceed. Sign convention: +yawDeg = gaze toward the
 * patient's left (+X in the root frame), +pitchDeg = gaze up. `amount` 0 ⇒
 * exactly {0, 0}. Deterministic and side-effect free.
 */
export function eyeGazeAngles(
  tSec: number,
  amount: number,
  seed: number,
  residualYawDeg: number,
  residualPitchDeg: number,
): { yawDeg: number; pitchDeg: number } {
  const a = safeAmount(amount);
  if (a === 0 || !Number.isFinite(tSec)) return { yawDeg: 0, pitchDeg: 0 };
  const ry = Number.isFinite(residualYawDeg) ? residualYawDeg : 0;
  const rp = Number.isFinite(residualPitchDeg) ? residualPitchDeg : 0;
  const absorbYaw = -clampDeg(ry, EYE_ABSORB_CAP_DEG);
  const absorbPitch = -clampDeg(rp, EYE_ABSORB_CAP_DEG);
  const sac = saccadeGaze(tSec, a, seed);
  return {
    yawDeg: clampDeg(absorbYaw + sac.yawDeg, EYE_TOTAL_CAP_DEG),
    pitchDeg: clampDeg(absorbPitch + sac.pitchDeg, EYE_TOTAL_CAP_DEG),
  };
}
