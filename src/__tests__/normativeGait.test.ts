/**
 * NORMATIVE GAIT GROUND-TRUTH — the bundled kinematic reference for the unified
 * Validity Gate (Workstream A). Asserts the curves reproduce the documented
 * landmark values (doc §3 targets #1–#3), carry the engine's sign convention,
 * are monotonic where the gait cycle expects it, and that the comparison /
 * Froude / walk-ratio math behaves (targets #5, #6, #10).
 */
import { describe, expect, it } from 'vitest';
import {
  NORMATIVE_KNEE_FLEXION,
  NORMATIVE_HIP_FLEXION,
  NORMATIVE_ANKLE_FLEXION,
  NORMATIVE_GAIT_CURVES,
  normativeCurve,
  curvePeak,
  curveTrough,
  curveArcDeg,
  jointAngleRmsVsNormative,
  froudeNumber,
  classifyFroude,
  FROUDE_G,
  FROUDE_WALK_TARGET,
  FROUDE_WALK_RUN_TRANSITION,
  FROUDE_WALK_CEILING,
  walkRatio,
  walkRatioInBand,
  inBand,
  SPEED_MPS,
  CADENCE_SPM,
  STRIDE_M,
  STEP_WIDTH_M,
  WALK_RATIO_M_PER_SPM,
  VERTICAL_COM_CM,
  PELVIC_OBLIQUITY_NORMAL_DEG,
  type NormativeGaitCurve,
  type GaitAngleSample,
} from '../services/normativeGait';

const between = (v: number, lo: number, hi: number): void => {
  expect(v).toBeGreaterThanOrEqual(lo);
  expect(v).toBeLessThanOrEqual(hi);
};

// Values of a curve over a phase sub-range [from,to] inclusive.
const rangeMeans = (curve: NormativeGaitCurve, from: number, to: number): number[] =>
  curve.filter((p) => p.phasePct >= from && p.phasePct <= to).map((p) => p.meanDeg);

const isMonotoneIncreasing = (xs: number[]): boolean =>
  xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-9);
const isMonotoneDecreasing = (xs: number[]): boolean =>
  xs.every((x, i) => i === 0 || x <= xs[i - 1] + 1e-9);

describe('normative gait curves — structure + cyclic sanity', () => {
  it('every curve is on a 0..100 grid, cyclically consistent, with non-negative SDs', () => {
    for (const joint of ['hipFlexion', 'kneeFlexion', 'ankleFlexion'] as const) {
      const curve = normativeCurve(joint);
      expect(curve).toBe(NORMATIVE_GAIT_CURVES[joint]);
      expect(curve[0].phasePct).toBe(0);
      expect(curve[curve.length - 1].phasePct).toBe(100);
      // phase strictly increasing
      for (let i = 1; i < curve.length; i += 1) {
        expect(curve[i].phasePct).toBeGreaterThan(curve[i - 1].phasePct);
      }
      // every SD ≥ 0
      for (const p of curve) expect(p.sdDeg).toBeGreaterThanOrEqual(0);
      // cyclic: IC and next-IC means within a couple degrees
      expect(Math.abs(curve[0].meanDeg - curve[curve.length - 1].meanDeg)).toBeLessThanOrEqual(3);
    }
  });
});

describe('knee curve — landmarks + monotonicity (target #1)', () => {
  it('peak-swing flexion lands in the documented 60–65° ±5 window ([58,67])', () => {
    const peak = curvePeak(NORMATIVE_KNEE_FLEXION);
    between(peak.meanDeg, 58, 67);
    // peak is in swing (~60–75% of the cycle)
    between(peak.phasePct, 60, 80);
  });

  it('shows the loading-response flexion wave (~15–20°) early in stance', () => {
    const loading = NORMATIVE_KNEE_FLEXION.find((p) => p.phasePct === 15)!;
    between(loading.meanDeg, 14, 22);
  });

  it('starts near extension at initial contact (0–10° flexion)', () => {
    between(NORMATIVE_KNEE_FLEXION[0].meanDeg, 0, 10);
  });

  it('rises monotonically from mid-stance (35%) to the swing peak (70%)', () => {
    expect(isMonotoneIncreasing(rangeMeans(NORMATIVE_KNEE_FLEXION, 35, 70))).toBe(true);
  });

  it('is +flexion signed (all means ≥ 0 — knee never hyperextends in normal gait)', () => {
    expect(NORMATIVE_KNEE_FLEXION.every((p) => p.meanDeg >= 0)).toBe(true);
  });
});

describe('hip curve — landmarks + monotonicity (target #2)', () => {
  it('starts ~30° flexion at IC and reaches ~10° extension in terminal stance', () => {
    between(NORMATIVE_HIP_FLEXION[0].meanDeg, 25, 35); // IC flexion
    const trough = curveTrough(NORMATIVE_HIP_FLEXION);
    between(trough.meanDeg, -14, -6); // terminal-stance extension (negative)
    between(trough.phasePct, 45, 60);
  });

  it('has a total sagittal arc of ~40° (doc: ~40° arc)', () => {
    between(curveArcDeg(NORMATIVE_HIP_FLEXION), 36, 46);
  });

  it('extends monotonically through stance (IC → terminal stance, 0..55%)', () => {
    expect(isMonotoneDecreasing(rangeMeans(NORMATIVE_HIP_FLEXION, 0, 55))).toBe(true);
  });

  it('flexes monotonically through swing (55 → 90%)', () => {
    expect(isMonotoneIncreasing(rangeMeans(NORMATIVE_HIP_FLEXION, 55, 90))).toBe(true);
  });
});

describe('ankle curve — landmarks + sign convention (target #3)', () => {
  it('is neutral at IC (±3°) with +dorsi / −plantar sign convention', () => {
    between(NORMATIVE_ANKLE_FLEXION[0].meanDeg, -3, 3);
  });

  it('peaks in dorsiflexion (~+10°, positive) in terminal stance', () => {
    const peak = curvePeak(NORMATIVE_ANKLE_FLEXION);
    expect(peak.meanDeg).toBeGreaterThan(0); // dorsiflexion is POSITIVE
    between(peak.meanDeg, 8, 15);
    between(peak.phasePct, 40, 50);
  });

  it('drives into plantarflexion (15–25° PF, negative) around toe-off', () => {
    const trough = curveTrough(NORMATIVE_ANKLE_FLEXION);
    expect(trough.meanDeg).toBeLessThan(0); // plantarflexion is NEGATIVE
    between(-trough.meanDeg, 15, 25); // magnitude of PF
    between(trough.phasePct, 58, 68);
  });

  it('has a total sagittal arc of ~30° (doc: ~30° arc)', () => {
    between(curveArcDeg(NORMATIVE_ANKLE_FLEXION), 25, 34);
  });

  it('dorsiflexes monotonically through single support (foot-flat 10% → terminal stance 45%)', () => {
    expect(isMonotoneIncreasing(rangeMeans(NORMATIVE_ANKLE_FLEXION, 10, 45))).toBe(true);
  });
});

describe('jointAngleRmsVsNormative — the ±1 SD / RMS gate (targets #1–#3)', () => {
  it('a trajectory equal to the normative mean → rms≈0, withinBandFraction=1', () => {
    const samples: GaitAngleSample[] = NORMATIVE_KNEE_FLEXION.map((p) => ({
      phasePct: p.phasePct,
      deg: p.meanDeg,
    }));
    const r = jointAngleRmsVsNormative(samples, 'kneeFlexion');
    expect(r.rmsDeg).toBeCloseTo(0, 6);
    expect(r.meanAbsDevDeg).toBeCloseTo(0, 6);
    expect(r.withinBandFraction).toBe(1);
    expect(r.worstDevDeg).toBeCloseTo(0, 6);
  });

  it('a trajectory offset +10° everywhere → rms≈10, band fraction low, worstDev≈+10', () => {
    const samples: GaitAngleSample[] = NORMATIVE_HIP_FLEXION.map((p) => ({
      phasePct: p.phasePct,
      deg: p.meanDeg + 10,
    }));
    const r = jointAngleRmsVsNormative(samples, 'hipFlexion');
    expect(r.rmsDeg).toBeCloseTo(10, 6);
    expect(r.meanAbsDevDeg).toBeCloseTo(10, 6);
    // hip SDs are ~5–6°, so a +10° offset is outside the ±1 SD band everywhere
    expect(r.withinBandFraction).toBeLessThan(0.2);
    expect(r.worstDevDeg).toBeCloseTo(10, 6);
  });

  it('a real-ish knee curve wobbling within the band → passes (rms small, fully in band)', () => {
    // normative mean plus a deterministic ±1.5° wobble (well inside the ~5–8° SD).
    const samples: GaitAngleSample[] = NORMATIVE_KNEE_FLEXION.map((p) => ({
      phasePct: p.phasePct,
      deg: p.meanDeg + 1.5 * Math.sin((p.phasePct / 100) * 2 * Math.PI),
    }));
    const r = jointAngleRmsVsNormative(samples, 'kneeFlexion');
    expect(r.rmsDeg).toBeLessThan(2);
    expect(r.withinBandFraction).toBe(1);
  });

  it('sparse input is linearly interpolated onto the normative grid', () => {
    // only 3 samples across the cycle, but the mean line is ~flat here so interp
    // lands close; use ankle IC/neutral region.
    const samples: GaitAngleSample[] = [
      { phasePct: 0, deg: 0 },
      { phasePct: 50, deg: 0 },
      { phasePct: 100, deg: 0 },
    ];
    const r = jointAngleRmsVsNormative(samples, 'ankleFlexion');
    // a flat-zero line vs the real ankle curve is clearly off, but the call must
    // succeed and produce finite, sensible numbers.
    expect(Number.isFinite(r.rmsDeg)).toBe(true);
    expect(r.rmsDeg).toBeGreaterThan(0);
    between(r.withinBandFraction, 0, 1);
  });

  it('handles phase wrap (unsorted + out-of-range phases) without blowing up', () => {
    const samples: GaitAngleSample[] = [
      { phasePct: 70, deg: 63 },
      { phasePct: -10, deg: 5 }, // wraps to 90
      { phasePct: 110, deg: 12 }, // wraps to 10
      { phasePct: 35, deg: 6 },
    ];
    const r = jointAngleRmsVsNormative(samples, 'kneeFlexion');
    expect(Number.isFinite(r.rmsDeg)).toBe(true);
    between(r.withinBandFraction, 0, 1);
  });

  it('sdMultiplier widens the band (a ±2 SD gate admits more points)', () => {
    const samples: GaitAngleSample[] = NORMATIVE_KNEE_FLEXION.map((p) => ({
      phasePct: p.phasePct,
      deg: p.meanDeg + 8, // ~just outside ±1 SD, inside ±2 SD
    }));
    const oneSd = jointAngleRmsVsNormative(samples, 'kneeFlexion', { sdMultiplier: 1 });
    const twoSd = jointAngleRmsVsNormative(samples, 'kneeFlexion', { sdMultiplier: 2 });
    expect(twoSd.withinBandFraction).toBeGreaterThan(oneSd.withinBandFraction);
  });

  it('throws on empty input', () => {
    expect(() => jointAngleRmsVsNormative([], 'kneeFlexion')).toThrow();
  });
});

describe('Froude number + regime classification (target #10)', () => {
  it('computes v²/(g·L) with g=9.81', () => {
    expect(FROUDE_G).toBe(9.81);
    expect(froudeNumber(1.3, 0.9)).toBeCloseTo((1.3 * 1.3) / (9.81 * 0.9), 6);
  });

  it('a comfortable authored walk (1.3 m/s, leg 0.9 m) is ~0.2 and classified comfortable', () => {
    const fr = froudeNumber(1.3, 0.9);
    between(fr, 0.18, 0.25); // ≈0.19; near the 0.25 comfortable target
    expect(classifyFroude(fr)).toBe('comfortable');
  });

  it('the comfortable target ≈0.25 classifies comfortable', () => {
    expect(FROUDE_WALK_TARGET).toBe(0.25);
    expect(classifyFroude(FROUDE_WALK_TARGET)).toBe('comfortable');
  });

  it('running speed (3 m/s) is in the run regime (above the walk→run transition)', () => {
    const fr = froudeNumber(3, 0.9);
    expect(fr).toBeGreaterThan(FROUDE_WALK_RUN_TRANSITION);
    expect(classifyFroude(fr)).toBe('run-regime');
  });

  it('regime boundaries are ordered slow < comfortable < fast < run-regime', () => {
    expect(classifyFroude(0.1)).toBe('slow');
    expect(classifyFroude(0.25)).toBe('comfortable');
    expect(classifyFroude(0.45)).toBe('fast');
    expect(classifyFroude(0.8)).toBe('run-regime');
    expect(FROUDE_WALK_RUN_TRANSITION).toBe(0.5);
    expect(FROUDE_WALK_CEILING).toBe(1.0);
  });

  it('returns NaN for a non-positive leg length', () => {
    expect(Number.isNaN(froudeNumber(1.3, 0))).toBe(true);
    expect(Number.isNaN(froudeNumber(1.3, -1))).toBe(true);
  });
});

describe('spatiotemporal norms + walk-ratio (target #5)', () => {
  it('exposes the normative bands', () => {
    expect(SPEED_MPS).toEqual([1.2, 1.4]);
    expect(CADENCE_SPM).toEqual([100, 120]);
    expect(STRIDE_M).toEqual([1.3, 1.5]);
    expect(STEP_WIDTH_M).toEqual([0.08, 0.17]);
  });

  it('inBand is inclusive on both ends', () => {
    expect(inBand(1.2, SPEED_MPS)).toBe(true);
    expect(inBand(1.4, SPEED_MPS)).toBe(true);
    expect(inBand(1.3, SPEED_MPS)).toBe(true);
    expect(inBand(1.5, SPEED_MPS)).toBe(false);
    expect(inBand(1.1, SPEED_MPS)).toBe(false);
  });

  it('walk ratio = step length ÷ cadence, ~0.0065 for normal gait, and in band', () => {
    // stride 1.44 m → step 0.72 m, cadence 110 → ratio ≈ 0.00655
    const wr = walkRatio(0.72, 110);
    expect(wr).toBeCloseTo(0.72 / 110, 8);
    between(wr, WALK_RATIO_M_PER_SPM[0], WALK_RATIO_M_PER_SPM[1]);
    expect(walkRatioInBand(0.72, 110)).toBe(true);
  });

  it('walk ratio is ~constant across the comfortable speed range (1.0–1.6 m/s)', () => {
    // co-varying step length & cadence at three speeds keep the ratio in band.
    expect(walkRatioInBand(0.62, 96)).toBe(true); // slower
    expect(walkRatioInBand(0.72, 110)).toBe(true); // comfortable
    expect(walkRatioInBand(0.82, 124)).toBe(true); // faster
  });

  it('an abnormal short-shuffle (tiny steps, high cadence) falls out of band', () => {
    expect(walkRatioInBand(0.25, 140)).toBe(false);
  });

  it('walkRatio returns NaN for non-positive cadence', () => {
    expect(Number.isNaN(walkRatio(0.7, 0))).toBe(true);
    expect(walkRatioInBand(0.7, 0)).toBe(false);
  });
});

describe('vertical CoM band + pelvic obliquity reference (targets #6, #7)', () => {
  it('vertical CoM band is 4–5 cm (engine calibrates walk to NORMAL_GAIT_VERTICAL_CM=5)', () => {
    expect(VERTICAL_COM_CM).toEqual([4, 5]);
    expect(inBand(5, VERTICAL_COM_CM)).toBe(true);
    expect(inBand(4.5, VERTICAL_COM_CM)).toBe(true);
    expect(inBand(8, VERTICAL_COM_CM)).toBe(false);
  });

  it('pelvic-obliquity reference constant is ~6° (reference only — no pelvic-list DOF yet)', () => {
    expect(PELVIC_OBLIQUITY_NORMAL_DEG).toBe(6);
  });
});
