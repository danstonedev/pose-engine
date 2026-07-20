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

// Idle weight shift: nobody stands perfectly centred for long — quiet standing
// carries a slow, subtle side-to-side redistribution of load (the hips drift
// over one foot, then the other) on top of the small continuous micro-sway.
// This is the SLOW component the micro-sway alone lacks: a 4–8 s cycle, so the
// body visibly "settles" onto a side instead of only trembling about centre.
// The cycle period and phase are SEED-derived (deterministic per seed, so a
// test can pin it; randomized per stage boot, so two stages never sync up) and
// the amplitude is modulated by a slow incommensurate sine so consecutive
// cycles never repeat exactly.
/** Idle weight-shift cycle period bounds, seconds (seed-mapped inside). */
export const IDLE_SHIFT_PERIOD_MIN_S = 4;
export const IDLE_SHIFT_PERIOD_MAX_S = 8;
/** Peak lateral pelvis (model-root) travel at amount = 1, meters. ~1.2 cm —
 *  a settle you notice only when looking for it, far under the ±15 cm the
 *  antalgic pelvis-shift actuator allows. */
export const IDLE_SHIFT_PEAK_M = 0.012;
/** Peak low-back lateral lean at amount = 1, degrees — IN PHASE with the
 *  pelvis travel, so the upper body visibly moves over the loaded side.
 *  Positive = toward the patient's left (+X), the pelvis-shift sign. */
export const IDLE_SHIFT_LEAN_PEAK_DEG = 1.1;
/** Amplitude modulation: mean and depth of the slow per-cycle variation
 *  (mod ∈ [0.6, 1.0], so the stated peaks above remain hard bounds). */
const IDLE_SHIFT_MOD_MEAN = 0.8;
const IDLE_SHIFT_MOD_DEPTH = 0.2;
/** The modulation runs ~3.7 cycles slower than the shift itself — an
 *  incommensurate ratio, so no two shift cycles carry the same amplitude. */
const IDLE_SHIFT_MOD_RATIO = 3.7;

/** Deterministic seed → [0, 1) hash (the classic fract-sin lattice hash) —
 *  spreads ANY finite seed to a usable unit value with no RNG state. */
function seedUnit(seed: number): number {
  const s = Number.isFinite(seed) ? seed : 0;
  const v = Math.sin(s * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Slow idle weight shift: the pelvis travel (`shiftM`, meters on the model-root
 * lateral axis, + = the patient's left/+X) plus an IN-PHASE low-back lateral
 * lean (`leanDeg`, same sign convention), cycling over a seed-derived 4–8 s
 * period. `amount` 0 ⇒ exactly {0, 0} (clean mode is zero perturbation); both
 * components are hard-bounded by `amount ×` their stated peaks. Deterministic:
 * same (tSec, amount, seed) ⇒ same output. Continuous in `tSec` (product of
 * sines), so the live overlay can never pop frame to frame.
 */
export function idleWeightShift(
  tSec: number,
  amount: number,
  seed = 0,
): { shiftM: number; leanDeg: number } {
  const a = safeAmount(amount);
  if (a === 0 || !Number.isFinite(tSec)) return { shiftM: 0, leanDeg: 0 };
  const sd = Number.isFinite(seed) ? seed : 0;
  const periodS =
    IDLE_SHIFT_PERIOD_MIN_S + (IDLE_SHIFT_PERIOD_MAX_S - IDLE_SHIFT_PERIOD_MIN_S) * seedUnit(sd);
  const phase = (2 * Math.PI * tSec) / periodS + 2 * Math.PI * seedUnit(sd + 1);
  // mod ∈ [0.6, 1.0]: the SAME factor scales both components, so the lean
  // always accompanies the travel and the bounds stay hard.
  const mod =
    IDLE_SHIFT_MOD_MEAN +
    IDLE_SHIFT_MOD_DEPTH *
      Math.sin(phase / IDLE_SHIFT_MOD_RATIO + 2 * Math.PI * seedUnit(sd + 2));
  const s = Math.sin(phase) * mod;
  return {
    shiftM: a * IDLE_SHIFT_PEAK_M * s,
    leanDeg: a * IDLE_SHIFT_LEAN_PEAK_DEG * s,
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

// ════════════════════════════════════════════════════════════════════════════
// EXERTION-SCALED BREATHING (Wave 5 · life-signals). The audit's finding:
// breathing is context-blind — "identical 15 bpm at rest and mid-run". Real
// respiration follows recent WORK: rate and depth climb during vigorous motion
// and recover over tens of seconds of rest. Three pure pieces supply that:
//
//  1. `motionWorkIntensity` — a 0..1 intensity signal derived from a motion's
//     keyframes (mean joint speed + ballistic share), computed once when the
//     stage starts a composed motion (the stage knows what's playing).
//  2. `stepExertion` — a first-order accumulator the stage feeds per frame:
//     rises toward the playing motion's intensity over ~EXERTION_RISE_TAU_S,
//     decays toward 0 over ~EXERTION_DECAY_TAU_S (~30–60 s) at rest.
//  3. Frequency-modulated breathing — `advanceBreathPhase` INTEGRATES phase
//     (φ += 2π·hz(exertion)·dt) so a rate change mid-breath is PHASE-
//     CONTINUOUS; `breathingLeanFM(φ, …)` maps the phase to degrees. Never
//     multiply wall time by the current rate — sin(2π·hz(t)·t) jumps when hz
//     changes; the integral formulation cannot.
//
// All pure + deterministic (same inputs ⇒ same outputs); `amount` 0 (clean
// mode) still yields EXACTLY 0 lean regardless of exertion.

/** Resting breathing rate, Hz. 0.23 Hz ≈ 13.8 bpm — inside the 12–15 bpm
 *  resting band (slightly under the legacy fixed 15 bpm: rest reads calmer). */
export const BREATH_REST_HZ = 0.23;
/** Full-exertion breathing rate, Hz. 0.45 Hz = 27 bpm — mid the 24–30 bpm
 *  vigorous band. */
export const BREATH_MAX_HZ = 0.45;
/** Breathing amplitude multiplier at full exertion (rest = 1). */
export const BREATH_AMP_MAX_SCALE = 1.6;
/** Exertion accumulator rise time constant, s — vigorous work "gets you
 *  breathing hard" over roughly this horizon. */
export const EXERTION_RISE_TAU_S = 8;
/** Exertion accumulator decay time constant, s — at rest the level falls to
 *  ~51% in 30 s and ~26% in 60 s (the audit's ~30–60 s recovery window). */
export const EXERTION_DECAY_TAU_S = 45;

/** Clamp a unit-interval signal; non-finite coerces to 0. */
function safeUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Advance the exertion accumulator one frame: a first-order lag of `level`
 * toward `intensity` (both 0..1) with an ASYMMETRIC time constant — quick to
 * rise while working (EXERTION_RISE_TAU_S), slow to recover at rest
 * (EXERTION_DECAY_TAU_S). Exact exponential step, so the result is
 * frame-rate-independent (two 1/120 s steps ≡ one 1/60 s step). Pure +
 * deterministic; a non-finite/negative dt returns `level` unchanged.
 */
export function stepExertion(level: number, intensity: number, dtSec: number): number {
  const lv = safeUnit(level);
  const it = safeUnit(intensity);
  if (!Number.isFinite(dtSec) || dtSec <= 0) return lv;
  const tau = it > lv ? EXERTION_RISE_TAU_S : EXERTION_DECAY_TAU_S;
  return lv + (it - lv) * (1 - Math.exp(-dtSec / tau));
}

/** Breathing rate at an exertion level: linear BREATH_REST_HZ → BREATH_MAX_HZ.
 *  Exertion 0 ⇒ the resting rate exactly. */
export function breathHz(exertion: number): number {
  return BREATH_REST_HZ + (BREATH_MAX_HZ - BREATH_REST_HZ) * safeUnit(exertion);
}

/** Breathing amplitude scale at an exertion level: 1 → BREATH_AMP_MAX_SCALE. */
export function breathAmpScale(exertion: number): number {
  return 1 + (BREATH_AMP_MAX_SCALE - 1) * safeUnit(exertion);
}

/**
 * Integrate the breath phase one frame at the exertion-scaled rate:
 * φ' = φ + 2π·breathHz(exertion)·dt. Because the RATE is what varies and the
 * PHASE is accumulated, any exertion change bends the breath's frequency
 * mid-cycle without a positional jump (phase-continuous FM). Pure; a
 * non-finite/negative dt (or non-finite phase) returns the phase unchanged
 * (a fresh accumulator should start at 0).
 */
export function advanceBreathPhase(phaseRad: number, dtSec: number, exertion: number): number {
  const p = Number.isFinite(phaseRad) ? phaseRad : 0;
  if (!Number.isFinite(dtSec) || dtSec <= 0) return p;
  return p + 2 * Math.PI * breathHz(exertion) * dtSec;
}

/**
 * Exertion-scaled respiration lean for the thorax, DEGREES, from an
 * ACCUMULATED phase (see {@link advanceBreathPhase}) — the FM sibling of
 * {@link breathingLean}. Amplitude = amount · BREATH_PEAK_DEG ·
 * breathAmpScale(exertion) (≤ 1.6× the resting peak). `amount` 0 ⇒ exactly 0
 * (clean mode) regardless of exertion. At exertion 0 and φ = 2π·BREATH_REST_HZ·t
 * this reproduces a plain resting breath.
 */
export function breathingLeanFM(phaseRad: number, amount: number, exertion: number): number {
  const a = safeAmount(amount);
  if (a === 0 || !Number.isFinite(phaseRad)) return 0;
  return a * BREATH_PEAK_DEG * breathAmpScale(exertion) * Math.sin(phaseRad);
}

/** Top-channel mean joint speed (deg/s) at which a motion reads as VIGOROUS
 *  (intensity 1). The travelling walk's busiest joints (hips/knees/shoulders)
 *  average ~50-75 deg/s; a run's touchdown→drive cycle well above 150. */
const INTENSITY_FULL_DEG_S = 150;
/** Top-channel mean joint speed at/below which a motion is restful (0). */
const INTENSITY_REST_DEG_S = 25;
/** Intensity boost per unit BALLISTIC time share (explosive motions read more
 *  strenuous than their mean joint speed alone suggests). */
const INTENSITY_BALLISTIC_BOOST = 0.25;
/** How many of the motion's BUSIEST channels the mean is taken over. Resolved
 *  gait keyframes carry dozens of near-constant decorative channels (finger
 *  curl, pronation, scapular glide…) that would dilute an all-channel mean to
 *  ~0; the locomotor effort lives in the few big movers. */
const INTENSITY_TOP_CHANNELS = 6;

/** The minimal keyframe shape {@link motionWorkIntensity} reads — matches both
 *  authored (`targetDegrees`) and resolved (`clampedDegrees`) keyframes, so the
 *  stage can feed whichever it holds without importing this module's deps. */
export interface WorkIntensityKeyframe {
  durationMs?: number;
  holdMs?: number;
  velocityClass?: string;
  targets?: readonly {
    joint: string;
    motion: string;
    targetDegrees?: number;
    clampedDegrees?: number;
  }[];
}

/**
 * Derive a 0..1 WORK-INTENSITY signal from a motion's keyframes — the simple
 * "how hard is the body working" scalar the exertion accumulator is fed while
 * the motion plays. Two ingredients:
 *   • the mean speed of the motion's BUSIEST joint channels: per channel
 *     ("joint.motion", carry-forward semantics — an unmentioned channel holds
 *     its last value), the total |Δ°| across the whole motion over the total
 *     motion time (travel + holds — a long dwell after a fast move correctly
 *     dilutes the intensity), averaged over the INTENSITY_TOP_CHANNELS
 *     fastest channels and mapped linearly from INTENSITY_REST_DEG_S →
 *     INTENSITY_FULL_DEG_S;
 *   • ballistic share: the fraction of motion time in 'ballistic' keyframes,
 *     as a small additive boost.
 * Pure + deterministic; [] ⇒ 0; non-finite fields are ignored.
 */
export function motionWorkIntensity(keyframes: readonly WorkIntensityKeyframe[]): number {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return 0;
  const last = new Map<string, number>();
  const travelDeg = new Map<string, number>(); // per-channel Σ|Δ°| over the motion
  let totalS = 0;
  let ballisticS = 0;
  for (const kf of keyframes) {
    const travelS = Math.max(0, Number.isFinite(kf.durationMs ?? 0) ? (kf.durationMs ?? 0) : 0) / 1000;
    const holdS = Math.max(0, Number.isFinite(kf.holdMs ?? 0) ? (kf.holdMs ?? 0) : 0) / 1000;
    for (const t of kf.targets ?? []) {
      const raw = t.clampedDegrees ?? t.targetDegrees;
      if (!Number.isFinite(raw)) continue;
      const key = `${t.joint}.${t.motion}`;
      travelDeg.set(key, (travelDeg.get(key) ?? 0) + Math.abs((raw as number) - (last.get(key) ?? 0)));
      last.set(key, raw as number);
    }
    totalS += travelS + holdS;
    if (kf.velocityClass === 'ballistic') ballisticS += travelS + holdS;
  }
  if (totalS <= 0 || travelDeg.size === 0) return 0;
  const speeds = [...travelDeg.values()].map((deg) => deg / totalS).sort((a, b) => b - a);
  const top = speeds.slice(0, INTENSITY_TOP_CHANNELS);
  const meanDegPerSec = top.reduce((s, v) => s + v, 0) / top.length;
  const speedTerm =
    (meanDegPerSec - INTENSITY_REST_DEG_S) / (INTENSITY_FULL_DEG_S - INTENSITY_REST_DEG_S);
  return safeUnit(speedTerm + INTENSITY_BALLISTIC_BOOST * (ballisticS / totalS));
}

// ════════════════════════════════════════════════════════════════════════════
// ANKLE-PIVOT IDLE SWAY (Wave 5 · life-signals). The audit's finding: "rest
// sway is lumbar angle-noise above a dead-still pelvis, not an ankle-pivot
// inverted pendulum". Real quiet-stance sway IS an inverted pendulum: the body
// rotates as a near-rigid column about the ANKLES, so the pelvis (and COM)
// translates while the ankle angle changes by atan(shift/height) — the lumbar
// spine barely participates. `idleSwaySplit` re-shapes the existing idle sway
// accordingly: the SAME bounded livelinessSwayDeg signal is split into
//   • an ankle-pivot component (IDLE_ANKLE_PIVOT_SHARE) the stage applies as a
//     whole-body roll/pitch about the ankle line (root rotation at floor level
//     with the feet counter-rotated so the soles stay flat — the ankle joint
//     angle changes by exactly the pivot angle and the pelvis rides
//     ~tan(angle)·height laterally), and
//   • a residual lumbar component (the remainder — real sway keeps some
//     spinal texture; it is not a perfectly rigid column).
// The split PARTITIONS the original amplitudes (shares sum to 1), so the total
// lean stays inside the pre-existing idle bounds; composes with the (slower,
// unchanged) idleWeightShift. Pure, deterministic, amount 0 ⇒ all zeros.

/** Share of the idle sway carried at the ankles (the rest stays lumbar). */
export const IDLE_ANKLE_PIVOT_SHARE = 0.6;
/** Effective inverted-pendulum height, m (ankle → COM, ~55% of stature): the
 *  lateral COM travel predicted from a pivot angle θ is ≈ tan(θ)·this. */
export const IDLE_PIVOT_HEIGHT_M = 0.95;

/**
 * Split the idle micro-sway into its ankle-pivot and residual-lumbar parts.
 * `ankleRollDeg` (+ about the A/P axis — same _swayAxisML convention as the
 * lumbar term) and `anklePitchDeg` are the whole-body pivot angles;
 * `lumbarMlDeg`/`lumbarApDeg` the remaining spinal texture; `comShiftM` the
 * lateral COM travel the roll pivot implies (tan(roll)·IDLE_PIVOT_HEIGHT_M) —
 * exported so the rig gate can assert the atan(shift/height) relation.
 * Bounds: |ankle + lumbar| per axis ≤ the original livelinessSwayDeg peaks ×
 * amount. `amount` 0 ⇒ exactly all-zero (clean mode).
 */
export function idleSwaySplit(
  tSec: number,
  amount: number,
): {
  ankleRollDeg: number;
  anklePitchDeg: number;
  lumbarMlDeg: number;
  lumbarApDeg: number;
  comShiftM: number;
} {
  const { mlDeg, apDeg } = livelinessSwayDeg(tSec, amount);
  const s = IDLE_ANKLE_PIVOT_SHARE;
  const ankleRollDeg = s * mlDeg;
  return {
    ankleRollDeg,
    anklePitchDeg: s * apDeg,
    lumbarMlDeg: (1 - s) * mlDeg,
    lumbarApDeg: (1 - s) * apDeg,
    comShiftM: Math.tan((ankleRollDeg * Math.PI) / 180) * IDLE_PIVOT_HEIGHT_M,
  };
}
