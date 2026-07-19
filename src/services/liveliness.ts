// simMOVE Clinical Motion Engine — the LIVELINESS overlay (naturalistic motion prior).
//
// WHY: a kinematic clip, looped, is byte-identical cycle to cycle — the body
// reads as a mannequin, not a person. Real resting posture is never frozen: the
// chest rises and falls with respiration (~12–18 breaths/min at rest) and quiet
// stance carries a small, continuous postural sway (the centre-of-pressure never
// truly stops — a real, measured physiological signal). This module supplies
// that missing prior PURELY KINEMATICALLY: tiny additive trunk rotations, no
// forces, no clip edit. It is the naturalistic-motion prior the engine lacked.
//
// SCOPE: these are the pure angle functions ONLY, so they unit-test off the rAF
// loop. The phase is driven by WALL-CLOCK seconds by the caller (like the
// clinical balanceSway) — incommensurate with any motion loop, so cycle K never
// equals cycle K+1 and no two frozen frames repeat. It is LIVE-ONLY: it never
// enters the offline sampler, so byte-identity/determinism stays intact.
//
// `amount` is a 0..1 realism dial: 0 ⇒ EXACTLY the clean, repeatable motion
// (zero perturbation); ~0.4 reads as unforced natural life. Both functions clamp
// amount to [0,1] and guard non-finite inputs so a bad dt or NaN dial can never
// throw or inject a wild lean into the trunk.

/** Respiration rate of the breathing oscillation, Hz. 0.25 Hz ≈ 15 breaths/min
 *  — mid resting range (12–18/min), the slow chest rise/fall that never stops. */
const BREATH_HZ = 0.25;
/** Peak thoracic flex/extend at amount = 1, degrees. Deliberately small: a chest
 *  rise you feel more than see, never a nod. */
const BREATH_PEAK_DEG = 2.2;

// Micro-sway: quiet-stance postural sway is small and continuous. These freqs
// are LOWER and the peaks MUCH smaller than the clinical SWAY_* (which signals a
// balance deficit); they are also chosen DISTINCT from the clinical freqs so the
// two never beat into a shared period and look metronomic when layered.
/** Medial/lateral micro-sway rate, Hz (the slower, slightly larger component). */
const SWAY_ML_HZ = 0.23;
/** Anterior/posterior micro-sway rate, Hz — incommensurate with ML above. */
const SWAY_AP_HZ = 0.31;
/** Peak M/L lean at amount = 1, degrees. */
const SWAY_ML_PEAK_DEG = 1.3;
/** Peak A/P lean at amount = 1, degrees. */
const SWAY_AP_PEAK_DEG = 0.9;
/** Phase offset on the A/P sine so M/L and A/P do not cross zero together (a
 *  shared zero-crossing reads as a single diagonal rock, not free sway). */
const SWAY_AP_PHASE = 0.9;

/** Clamp to [0,1] and coerce non-finite to 0 — a bad dial can never perturb. */
function safeAmount(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return amount < 0 ? 0 : amount > 1 ? 1 : amount;
}

/**
 * Slow respiration oscillation for the thorax (Spine_Upper), in DEGREES — a
 * gentle chest rise/fall at ~15 breaths/min. Positive/negative = flex/extend.
 * `amount` 0 ⇒ exactly 0; bounded by `amount * BREATH_PEAK_DEG`.
 */
export function breathingLean(tSec: number, amount: number): number {
  const a = safeAmount(amount);
  if (a === 0 || !Number.isFinite(tSec)) return 0;
  return a * BREATH_PEAK_DEG * Math.sin(2 * Math.PI * BREATH_HZ * tSec);
}

/**
 * Always-on postural micro-sway for the low back (Spine_Lower), in DEGREES on
 * two incommensurate low frequencies (M/L + A/P). Much smaller than the clinical
 * balanceSway — this is life, not a deficit. `amount` 0 ⇒ {0,0}; each component
 * bounded by its stated peak × amount.
 */
export function livelinessSwayDeg(
  tSec: number,
  amount: number,
): { mlDeg: number; apDeg: number } {
  const a = safeAmount(amount);
  if (a === 0 || !Number.isFinite(tSec)) return { mlDeg: 0, apDeg: 0 };
  return {
    mlDeg: a * SWAY_ML_PEAK_DEG * Math.sin(2 * Math.PI * SWAY_ML_HZ * tSec),
    apDeg: a * SWAY_AP_PEAK_DEG * Math.sin(2 * Math.PI * SWAY_AP_HZ * tSec + SWAY_AP_PHASE),
  };
}

// Cadence variability: real gait is not metronomic — stride TIME drifts cycle to
// cycle with a coefficient of variation of ~2–4% in healthy adults (and MORE with
// age / neurological disease — a future clinical dial). `cadenceRate` is a slow,
// bounded multiplier on how fast a LOOPING motion's phase clock advances, so the
// cadence gently speeds/slows and no two cycles take the same time. Two
// incommensurate low frequencies (mean 0) drift over ~12–27 s — far slower than a
// ~1 s gait cycle — so it never reads as a single wobble and the loop seam stays
// smooth (the rate is continuous, so the warped clock is C¹).
/** Cadence drift frequencies, Hz (incommensurate — no shared period). */
const CADENCE_HZ_A = 0.08;
const CADENCE_HZ_B = 0.037;
const CADENCE_PHASE_B = 1.7;
/** Peak fractional cadence deviation at amount = 1 (±6%); at the ~0.4 natural
 *  default this is ±~2.4%, squarely in the healthy stride-time CV band. */
export const CADENCE_CV_MAX = 0.06;

/**
 * Bounded, slowly-drifting multiplier (mean 1) for a LOOPING motion's phase-clock
 * advance — natural stride-time variability. `amount` 0 ⇒ exactly 1 (a perfectly
 * metronomic clean loop); otherwise strictly within `1 ± amount·CADENCE_CV_MAX`.
 * Continuous in `tSec`, so the warped loop clock stays C¹ and the seam is smooth.
 * Timing only — it warps WHEN the pose is reached, never the pose itself, so foot
 * placement and every measured angle are untouched.
 */
export function cadenceRate(tSec: number, amount: number): number {
  const a = safeAmount(amount);
  if (a === 0 || !Number.isFinite(tSec)) return 1;
  // ½·(sinA + sinB) ∈ [−1, 1] ⇒ the deviation is bounded by a·CADENCE_CV_MAX.
  const drift =
    0.5 *
    (Math.sin(2 * Math.PI * CADENCE_HZ_A * tSec) +
      Math.sin(2 * Math.PI * CADENCE_HZ_B * tSec + CADENCE_PHASE_B));
  return 1 + a * CADENCE_CV_MAX * drift;
}
