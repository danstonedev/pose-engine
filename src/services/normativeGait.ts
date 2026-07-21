/**
 * NORMATIVE GAIT GROUND-TRUTH — the bundled kinematic reference the unified
 * Validity Gate (Workstream A, `docs/design-benchmark-redteam.md` §3) grades
 * authored / AI-composed motion against. This module is PURE data + math: no
 * rig, no three.js, no dependency on the gate itself, no `Date.now`/`Math.random`.
 * Everything here is deterministic.
 *
 * What it bundles (target numbers from the doc's target-set §3):
 *   • Normative sagittal joint-angle curves (hip / knee / ankle) over one gait
 *     cycle as mean ± 1 SD bands  ...................... targets #1 #2 #3
 *   • `jointAngleRmsVsNormative` — RMS / mean-abs-dev / within-±1-SD-band check
 *     of a motion's own trajectory against those curves  target #1–#3 (the
 *     "±1 SD / RMS" gate the claims boundary §4 promises)
 *   • Froude number + walk / walk-run / ceiling constants + classifier  target #10
 *   • Spatiotemporal norms + walk-ratio  ............... target #5
 *   • Vertical CoM excursion band  .................... target #6
 *   • Pelvic-obliquity reference constant  ............ target #7
 *
 * ── SIGN CONVENTION (must match `jointAngles.ts` / `romRegistry.ts`) ──────────
 * These curves are stored in the SAME signed convention the engine's
 * `computeJointAngles` emits, so a measured trajectory can be compared directly:
 *   • hipFlexion   : +flexion (thigh forward) / −extension          [rom −30..120]
 *   • kneeFlexion  : +flexion (knee bends)     / −(hyper)extension   [rom −15..140]
 *   • ankleFlexion : +DORSIflexion             / −PLANTARflexion     [rom −50..20]
 * (See `romRegistry.ts` ROM_JOINT_ROWS: L/R_UpLeg.hipFlexion Flex/Ext,
 *  L/R_Leg.kneeFlexion Flex/Ext, L/R_Foot.ankleFlexion Dorsi/Plantar.)
 *
 * ── SOURCE & HONESTY ─────────────────────────────────────────────────────────
 * The curves are REPRESENTATIVE normative means with ±1 SD bands digitized /
 * approximated from Winter's "Biomechanics and Motor Control of Human Movement"
 * and the Perry / CGA (Clinical Gait Analysis) normative sagittal curves cited
 * in the design doc (podiapaedia angular-kinematics-of-gait; Perry gait phases).
 * They are NOT a specific subject and NOT a claim of a measured cohort — they
 * are a bundled ground-truth shape adequate for a ±1 SD auditable gate over a
 * normal free-speed adult walk (~1.3 m/s). No dynamic / GRF / moment / EMG claim
 * is made or implied (doc §4 claims boundary).
 *
 * Landmarks the shape reproduces (doc target-set):
 *   • knee : ~5° IC → ~18° loading-response wave → ~6° mid-stance → ~42° toe-off
 *            → PEAK SWING ~63° (target 60–65° ±5) → back to ~5° at IC.
 *   • hip  : ~30° flex at IC → ~−10° extension in terminal stance (~40° arc).
 *   • ankle: ~0° IC → slight PF (foot-flat) → ~+10° DF terminal stance →
 *            ~−18° PF at toe-off (target 15–25° PF; ~30° arc).
 */

// ── Curve types ──────────────────────────────────────────────────────────────

/** One sample of a normative joint curve: the population mean and ±1 SD band
 *  at a phase of the gait cycle. `phasePct` is 0..100 (initial contact = 0). */
export interface NormativeGaitPoint {
  /** Percent of the gait cycle, 0 (initial contact) .. 100 (next IC). */
  phasePct: number;
  /** Population-mean joint angle in degrees, engine sign convention. */
  meanDeg: number;
  /** ±1 standard-deviation band half-width in degrees (always ≥ 0). */
  sdDeg: number;
}

/** A full normative curve: samples on a monotonic phase grid, endpoints
 *  (0 and 100) cyclically consistent. */
export type NormativeGaitCurve = readonly NormativeGaitPoint[];

/** The sagittal joints for which a bundled normative curve exists. Keys match
 *  the engine's `computeJointAngles` field names + ROM registry field keys. */
export type NormativeSagittalJoint = 'hipFlexion' | 'kneeFlexion' | 'ankleFlexion';

/** Compact constructor keeps the data tables readable. */
const pt = (phasePct: number, meanDeg: number, sdDeg: number): NormativeGaitPoint => ({
  phasePct,
  meanDeg,
  sdDeg,
});

// ── Normative sagittal curves (5% grid, 0..100) ──────────────────────────────

/**
 * KNEE FLEXION over the gait cycle (+flexion). Winter / Perry normative shape:
 * ~0–5° at IC, a 15–20° loading-response flexion wave (~15%), extension back
 * toward ~5° in mid-stance (~35%), a rapid pre-swing/swing flexion to the peak
 * ~60–65° at ~70% (toe-off ~40° at ~62%), then terminal-swing extension back to
 * IC. SDs ~5–7° (larger through swing) [Winter; podiapaedia CGA].
 */
export const NORMATIVE_KNEE_FLEXION: NormativeGaitCurve = [
  pt(0, 5, 5),
  pt(5, 12, 5),
  pt(10, 17, 6),
  pt(15, 18, 6), // loading-response flexion wave
  pt(20, 15, 6),
  pt(25, 12, 6),
  pt(30, 8, 6),
  pt(35, 6, 6), // mid-stance near-extension
  pt(40, 8, 6),
  pt(45, 12, 6),
  pt(50, 20, 7),
  pt(55, 31, 7),
  pt(60, 42, 7), // ~toe-off
  pt(65, 55, 7),
  pt(70, 63, 8), // PEAK SWING flexion (target 60–65° ±5)
  pt(75, 62, 8),
  pt(80, 52, 8),
  pt(85, 35, 7),
  pt(90, 18, 6),
  pt(95, 8, 5),
  pt(100, 5, 5),
];

/**
 * HIP FLEXION over the gait cycle (+flexion / −extension). Winter / Perry:
 * ~30° flexion at IC, progressive extension through stance to ~−10° in terminal
 * stance (~50–55%), then flexion through swing back to ~+32° near next IC
 * (~40° total arc). SDs ~5–6° [Winter; podiapaedia CGA].
 */
export const NORMATIVE_HIP_FLEXION: NormativeGaitCurve = [
  pt(0, 30, 5),
  pt(5, 28, 5),
  pt(10, 25, 5),
  pt(15, 22, 5),
  pt(20, 18, 5),
  pt(25, 14, 5),
  pt(30, 10, 5),
  pt(35, 6, 5),
  pt(40, 2, 5),
  pt(45, -3, 5),
  pt(50, -8, 6),
  pt(55, -10, 6), // peak extension (terminal stance)
  pt(60, -8, 6),
  pt(65, -2, 6),
  pt(70, 6, 6),
  pt(75, 15, 6),
  pt(80, 23, 6),
  pt(85, 29, 5),
  pt(90, 32, 5), // peak flexion (mid-swing)
  pt(95, 32, 5),
  pt(100, 30, 5),
];

/**
 * ANKLE DORSI(+)/PLANTAR(−)FLEXION over the gait cycle. Winter / Perry:
 * ~0° (neutral) at IC → slight controlled plantarflexion to foot-flat (~−5° at
 * ~10%) → progressive dorsiflexion as the tibia advances, peaking ~+10–11° in
 * terminal stance (~45%) → rapid push-off plantarflexion to ~−18° at toe-off
 * (~62%) → swing recovery toward neutral. ~30° arc; SDs ~3–5° [Winter; CGA].
 */
export const NORMATIVE_ANKLE_FLEXION: NormativeGaitCurve = [
  pt(0, 0, 4),
  pt(5, -3, 4),
  pt(10, -5, 4), // loading-response PF (foot flat)
  pt(15, -2, 4),
  pt(20, 2, 4),
  pt(25, 5, 4),
  pt(30, 7, 4),
  pt(35, 9, 4),
  pt(40, 10, 4),
  pt(45, 11, 4), // peak dorsiflexion (terminal stance)
  pt(50, 8, 5),
  pt(55, 0, 5),
  pt(60, -12, 5),
  pt(65, -18, 5), // peak plantarflexion (toe-off / pre-swing)
  pt(70, -12, 5),
  pt(75, -5, 4),
  pt(80, -2, 4),
  pt(85, 0, 4),
  pt(90, 1, 4),
  pt(95, 0, 4),
  pt(100, 0, 4),
];

/** Registry: normative curve per supported sagittal joint. */
export const NORMATIVE_GAIT_CURVES: Readonly<Record<NormativeSagittalJoint, NormativeGaitCurve>> = {
  hipFlexion: NORMATIVE_HIP_FLEXION,
  kneeFlexion: NORMATIVE_KNEE_FLEXION,
  ankleFlexion: NORMATIVE_ANKLE_FLEXION,
};

/** Fetch the bundled normative curve for a joint. */
export function normativeCurve(joint: NormativeSagittalJoint): NormativeGaitCurve {
  return NORMATIVE_GAIT_CURVES[joint];
}

/** Peak (max mean) of a curve — e.g. knee peak-swing flexion. */
export function curvePeak(curve: NormativeGaitCurve): NormativeGaitPoint {
  return curve.reduce((best, p) => (p.meanDeg > best.meanDeg ? p : best), curve[0]);
}

/** Trough (min mean) of a curve — e.g. hip terminal-stance extension. */
export function curveTrough(curve: NormativeGaitCurve): NormativeGaitPoint {
  return curve.reduce((best, p) => (p.meanDeg < best.meanDeg ? p : best), curve[0]);
}

/** Total sagittal excursion (max mean − min mean) of a curve, degrees. */
export function curveArcDeg(curve: NormativeGaitCurve): number {
  return curvePeak(curve).meanDeg - curveTrough(curve).meanDeg;
}

// ── Cyclic linear interpolation of a sparse trajectory ───────────────────────

/** One sample of a motion's own joint trajectory over one gait cycle. */
export interface GaitAngleSample {
  /** Percent of the gait cycle, 0..100 (values outside are wrapped mod 100). */
  phasePct: number;
  /** Measured joint angle in degrees (engine sign convention). */
  deg: number;
}

/** Internal: a phase-sorted trajectory with an extra wrapped point on each end
 *  so any query in [0,100] is bracketed (handles sparse input + phase wrap). */
interface CyclicInterpolator {
  sample(phasePct: number): number;
}

function buildCyclicInterpolator(samples: readonly GaitAngleSample[]): CyclicInterpolator {
  if (samples.length === 0) {
    throw new Error('jointAngleRmsVsNormative: at least one trajectory sample is required');
  }
  // Normalize phase into [0,100) and sort ascending.
  const pts = samples
    .map((s) => ({ p: ((s.phasePct % 100) + 100) % 100, d: s.deg }))
    .sort((a, b) => a.p - b.p);
  if (pts.length === 1) {
    const only = pts[0].d;
    return { sample: () => only };
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  // Wrap-around guards: last point mapped one cycle earlier, first point one
  // cycle later, so [ext[0].p ≤ 0, ext[end].p ≥ 100] brackets every query.
  const ext = [{ p: last.p - 100, d: last.d }, ...pts, { p: first.p + 100, d: first.d }];
  return {
    sample(phasePct: number): number {
      const q = ((phasePct % 100) + 100) % 100;
      // Linear scan is fine: curves are ~21 points, trajectories modest.
      for (let i = 0; i < ext.length - 1; i += 1) {
        const a = ext[i];
        const b = ext[i + 1];
        if (q >= a.p && q <= b.p) {
          const span = b.p - a.p;
          if (span < 1e-9) return a.d; // coincident phases (e.g. 0 and 100)
          const t = (q - a.p) / span;
          return a.d + (b.d - a.d) * t;
        }
      }
      return ext[ext.length - 1].d; // unreachable given the wrap guards
    },
  };
}

// ── RMS vs normative (targets #1–#3, the ±1 SD gate) ─────────────────────────

/** Options for {@link jointAngleRmsVsNormative}. */
export interface JointRmsOptions {
  /** Band width in SDs to count as "within band". Default 1 (the ±1 SD gate). */
  sdMultiplier?: number;
}

/** Result of grading a trajectory against a normative curve. */
export interface JointRmsResult {
  /** Root-mean-square deviation from the normative mean, degrees. */
  rmsDeg: number;
  /** Mean absolute deviation from the normative mean, degrees. */
  meanAbsDevDeg: number;
  /** Fraction (0..1) of normative phase points where the trajectory lies
   *  within meanDeg ± sdMultiplier·sdDeg — the ±1 SD "within band" score. */
  withinBandFraction: number;
  /** Phase (%) of the single worst (largest |deviation|) grid point. */
  worstPhasePct: number;
  /** Signed deviation (trajectory − mean) at the worst grid point, degrees. */
  worstDevDeg: number;
}

/**
 * Grade a motion's own joint trajectory against the bundled normative curve for
 * that joint (targets #1–#3). The trajectory is resampled onto the normative
 * phase grid by cyclic linear interpolation (sparse input + phase wrap handled),
 * then compared point-by-point to mean ± SD.
 *
 * `samples` is one gait cycle as `{ phasePct (0..100), deg }[]` in the ENGINE
 * sign convention (see the module header) — for the ankle, +dorsi / −plantar.
 */
export function jointAngleRmsVsNormative(
  samples: readonly GaitAngleSample[],
  joint: NormativeSagittalJoint,
  opts: JointRmsOptions = {},
): JointRmsResult {
  const sdMultiplier = opts.sdMultiplier ?? 1;
  const curve = normativeCurve(joint);
  const interp = buildCyclicInterpolator(samples);

  let sumSq = 0;
  let sumAbs = 0;
  let within = 0;
  let worstPhasePct = curve[0].phasePct;
  let worstAbs = -Infinity;
  let worstDevDeg = 0;

  for (const point of curve) {
    const value = interp.sample(point.phasePct);
    const dev = value - point.meanDeg;
    const absDev = Math.abs(dev);
    sumSq += dev * dev;
    sumAbs += absDev;
    if (absDev <= point.sdDeg * sdMultiplier) within += 1;
    if (absDev > worstAbs) {
      worstAbs = absDev;
      worstPhasePct = point.phasePct;
      worstDevDeg = dev;
    }
  }

  const n = curve.length;
  return {
    rmsDeg: Math.sqrt(sumSq / n),
    meanAbsDevDeg: sumAbs / n,
    withinBandFraction: within / n,
    worstPhasePct,
    worstDevDeg,
  };
}

// ── Froude number (target #10) ───────────────────────────────────────────────

/** Gravitational acceleration used for the Froude number, m/s². */
export const FROUDE_G = 9.81;

/**
 * Dimensionless walking speed (Froude number) = v² / (g·L), with `L` the leg
 * length (hip-joint height). A dimensionless-speed sanity check: dynamically
 * similar gaits share a Froude number regardless of body size (target #10).
 * Returns `NaN` for a non-positive leg length.
 */
export function froudeNumber(speedMps: number, legLengthM: number): number {
  if (!(legLengthM > 0)) return NaN;
  return (speedMps * speedMps) / (FROUDE_G * legLengthM);
}

/** Comfortable free-speed walk target (~preferred walking speed) [Fr≈0.25]. */
export const FROUDE_WALK_TARGET = 0.25;
/** Empirical walk→run transition (dynamic gait change) [Fr≈0.5]. */
export const FROUDE_WALK_RUN_TRANSITION = 0.5;
/** Theoretical inverted-pendulum walking ceiling [Fr≈1.0]. */
export const FROUDE_WALK_CEILING = 1.0;

/** Coarse gait-regime label for a Froude number. */
export type FroudeRegime = 'slow' | 'comfortable' | 'fast' | 'run-regime';

/**
 * Classify a Froude number into a gait regime. Boundaries: <0.15 slow,
 * 0.15–0.35 comfortable (target ≈0.25), 0.35 up to the walk→run transition
 * (0.5) fast, ≥ transition run-regime. `NaN`/negative → 'slow'.
 */
export function classifyFroude(fr: number): FroudeRegime {
  if (!(fr > 0.15)) return 'slow';
  if (fr < 0.35) return 'comfortable';
  if (fr < FROUDE_WALK_RUN_TRANSITION) return 'fast';
  return 'run-regime';
}

// ── Spatiotemporal norms + walk-ratio (target #5) ────────────────────────────

/** Inclusive normative band `[lo, hi]`. */
export type NormativeBand = readonly [number, number];

/** Is `value` within an inclusive normative band? */
export function inBand(value: number, band: NormativeBand): boolean {
  return value >= band[0] && value <= band[1];
}

/** Free-speed comfortable walking speed, m/s [normative ~1.2–1.4]. */
export const SPEED_MPS: NormativeBand = [1.2, 1.4];
/** Cadence, steps/min [normative ~100–120, "cadence ~110" in the doc]. */
export const CADENCE_SPM: NormativeBand = [100, 120];
/** Stride length (one full cycle, both feet), m [normative ~1.3–1.5]. */
export const STRIDE_M: NormativeBand = [1.3, 1.5];
/** Step width (lateral base of support), m [normative ~0.08–0.17]. */
export const STEP_WIDTH_M: NormativeBand = [0.08, 0.17];

/**
 * Walk ratio = step length (m) ÷ cadence (steps/min). This ratio is ~constant
 * across the comfortable speed range (~1.0–1.6 m/s) because step length and
 * cadence co-vary — a speed-independent index of the walking pattern
 * [Sekiya & Nagasaki]. Normal ≈ 0.0065 m/(steps·min⁻¹). Returns `NaN` for a
 * non-positive cadence.
 */
export function walkRatio(stepLengthM: number, cadenceSpm: number): number {
  if (!(cadenceSpm > 0)) return NaN;
  return stepLengthM / cadenceSpm;
}

/** Normative walk-ratio band, m/(steps·min⁻¹) (≈0.0065 ± ) [Sekiya & Nagasaki]. */
export const WALK_RATIO_M_PER_SPM: NormativeBand = [0.0055, 0.0075];

/** Is a step-length/cadence pair's walk ratio within the normative band? */
export function walkRatioInBand(stepLengthM: number, cadenceSpm: number): boolean {
  const wr = walkRatio(stepLengthM, cadenceSpm);
  return Number.isFinite(wr) && inBand(wr, WALK_RATIO_M_PER_SPM);
}

// ── Vertical CoM excursion band (target #6) ──────────────────────────────────

/**
 * Vertical CoM / pelvis excursion at normal free walking speed, cm [normative
 * ~4–5 cm]. The engine already calibrates its walk to the upper end of this band
 * via `NORMAL_GAIT_VERTICAL_CM = 5` in `movementTemplates.ts` — referenced here
 * (NOT imported, to avoid a service import cycle). This band is the gate/faults
 * reference for measured pelvis rise-and-fall [Winter; Orendurff et al. 2004].
 */
export const VERTICAL_COM_CM: NormativeBand = [4, 5];

// ── Pelvic obliquity reference (target #7) ───────────────────────────────────

/**
 * Peak pelvic obliquity (frontal-plane pelvic list) in normal gait, degrees
 * (~4–6°; exceeded in Trendelenburg). REFERENCE CONSTANT ONLY: the engine's rig
 * has NO pelvic-list DOF today (design doc "Known rig caveats" — rejected on
 * Kuo/Gard inverted-pendulum grounds), so obliquity is NOT yet measurable. The
 * gate/faults may cite this constant but must carry the honest caveat until a
 * pelvic-list DOF exists.
 */
export const PELVIC_OBLIQUITY_NORMAL_DEG = 6;
