import { describe, expect, it } from 'vitest';
import {
  breathingLean,
  livelinessSwayDeg,
  cadenceRate,
  CADENCE_CV_MAX,
  idleWeightShift,
  IDLE_SHIFT_PEAK_M,
  IDLE_SHIFT_LEAN_PEAK_DEG,
  IDLE_SHIFT_PERIOD_MIN_S,
  IDLE_SHIFT_PERIOD_MAX_S,
} from '../services/liveliness';

// The stated peaks (mirror the module constants so the bounds are asserted
// against the CONTRACT, not re-derived from it).
const BREATH_PEAK_DEG = 2.2;
const SWAY_ML_PEAK_DEG = 1.3;
const SWAY_AP_PEAK_DEG = 0.9;

// A time sweep long enough to walk each low-freq sine through several full
// cycles (the slowest is 0.23 Hz ≈ 4.3 s/cycle).
const SWEEP: number[] = [];
for (let t = 0; t <= 60; t += 0.05) SWEEP.push(t);

describe('breathingLean', () => {
  it('amount 0 ⇒ exactly 0 everywhere (clean mode is zero perturbation)', () => {
    for (const t of SWEEP) expect(breathingLean(t, 0)).toBe(0);
  });

  it('bounded by amount * peak across the sweep at amount 1', () => {
    for (const t of SWEEP) {
      expect(Math.abs(breathingLean(t, 1))).toBeLessThanOrEqual(BREATH_PEAK_DEG + 1e-9);
    }
  });

  it('actually oscillates (not a constant) and reaches near its peak', () => {
    const vals = SWEEP.map((t) => breathingLean(t, 1));
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    expect(max - min).toBeGreaterThan(1); // a real swing, not a flat line
    expect(max).toBeGreaterThan(BREATH_PEAK_DEG * 0.9); // the peak is reachable
  });

  it('deterministic: same (t, amount) ⇒ same value', () => {
    expect(breathingLean(3.14, 0.4)).toBe(breathingLean(3.14, 0.4));
  });

  it('clamps amount and guards non-finite', () => {
    expect(breathingLean(3.14, 5)).toBe(breathingLean(3.14, 1)); // over-1 clamps to 1
    expect(breathingLean(3.14, -2)).toBe(0); // negative clamps to 0
    expect(breathingLean(Number.NaN, 1)).toBe(0);
    expect(breathingLean(1, Number.NaN)).toBe(0);
  });
});

describe('livelinessSwayDeg', () => {
  it('amount 0 ⇒ {0,0} everywhere', () => {
    for (const t of SWEEP) expect(livelinessSwayDeg(t, 0)).toEqual({ mlDeg: 0, apDeg: 0 });
  });

  it('each component bounded by its stated peak at amount 1', () => {
    for (const t of SWEEP) {
      const { mlDeg, apDeg } = livelinessSwayDeg(t, 1);
      expect(Math.abs(mlDeg)).toBeLessThanOrEqual(SWAY_ML_PEAK_DEG + 1e-9);
      expect(Math.abs(apDeg)).toBeLessThanOrEqual(SWAY_AP_PEAK_DEG + 1e-9);
    }
  });

  it('both components oscillate (not constant)', () => {
    const ml = SWEEP.map((t) => livelinessSwayDeg(t, 1).mlDeg);
    const ap = SWEEP.map((t) => livelinessSwayDeg(t, 1).apDeg);
    expect(Math.max(...ml) - Math.min(...ml)).toBeGreaterThan(0.5);
    expect(Math.max(...ap) - Math.min(...ap)).toBeGreaterThan(0.3);
  });

  it('deterministic: same (t, amount) ⇒ same value', () => {
    expect(livelinessSwayDeg(7.5, 0.4)).toEqual(livelinessSwayDeg(7.5, 0.4));
  });

  it('clamps amount and guards non-finite', () => {
    expect(livelinessSwayDeg(2, 9)).toEqual(livelinessSwayDeg(2, 1));
    expect(livelinessSwayDeg(2, -1)).toEqual({ mlDeg: 0, apDeg: 0 });
    expect(livelinessSwayDeg(Number.NaN, 1)).toEqual({ mlDeg: 0, apDeg: 0 });
  });
});

describe('idleWeightShift — slow idle weight shift (4–8 s settle cycle)', () => {
  // A finer sweep than SWEEP: the zero-crossing period measurement below needs
  // sub-sample precision on a 4–8 s cycle.
  const FINE: number[] = [];
  for (let t = 0; t <= 120; t += 0.01) FINE.push(t);
  const SEEDS = [0, 1, 7.25, 42, 123.456, 999];

  it('amount 0 ⇒ exactly {0, 0} everywhere (clean mode is zero perturbation)', () => {
    for (const t of SWEEP) expect(idleWeightShift(t, 0, 42)).toEqual({ shiftM: 0, leanDeg: 0 });
  });

  it('hard-bounded by amount × the stated peaks, for any seed', () => {
    for (const seed of SEEDS) {
      for (const amount of [0.4, 1]) {
        for (const t of SWEEP) {
          const { shiftM, leanDeg } = idleWeightShift(t, amount, seed);
          expect(Math.abs(shiftM)).toBeLessThanOrEqual(amount * IDLE_SHIFT_PEAK_M + 1e-12);
          expect(Math.abs(leanDeg)).toBeLessThanOrEqual(amount * IDLE_SHIFT_LEAN_PEAK_DEG + 1e-12);
        }
      }
    }
  });

  it('actually shifts: a real side-to-side swing in BOTH directions', () => {
    for (const seed of SEEDS) {
      const vals = SWEEP.map((t) => idleWeightShift(t, 1, seed).shiftM);
      expect(Math.max(...vals), `seed ${seed} shifts one way`).toBeGreaterThan(IDLE_SHIFT_PEAK_M * 0.4);
      expect(Math.min(...vals), `seed ${seed} and the other`).toBeLessThan(-IDLE_SHIFT_PEAK_M * 0.4);
    }
  });

  it('the lean is IN PHASE with the travel — the trunk settles over the loaded side', () => {
    for (const seed of SEEDS) {
      for (const t of SWEEP) {
        const { shiftM, leanDeg } = idleWeightShift(t, 1, seed);
        // Same modulation scales both, so the signs can never disagree.
        if (Math.abs(shiftM) > 1e-9) expect(Math.sign(leanDeg)).toBe(Math.sign(shiftM));
      }
    }
  });

  it('the cycle period is seed-derived and lands inside the stated 4–8 s band', () => {
    for (const seed of SEEDS) {
      // The amplitude modulation never reaches 0 (mod ≥ 0.6), so the rising
      // zero-crossings of shiftM are exactly the base cycle boundaries.
      const rising: number[] = [];
      let prev = idleWeightShift(0, 1, seed).shiftM;
      for (let i = 1; i < FINE.length; i += 1) {
        const cur = idleWeightShift(FINE[i]!, 1, seed).shiftM;
        if (prev <= 0 && cur > 0) rising.push(FINE[i]!);
        prev = cur;
      }
      expect(rising.length, `seed ${seed} cycles several times over 2 min`).toBeGreaterThan(10);
      for (let i = 1; i < rising.length; i += 1) {
        const period = rising[i]! - rising[i - 1]!;
        expect(period, `seed ${seed} period`).toBeGreaterThanOrEqual(IDLE_SHIFT_PERIOD_MIN_S - 0.05);
        expect(period, `seed ${seed} period`).toBeLessThanOrEqual(IDLE_SHIFT_PERIOD_MAX_S + 0.05);
      }
    }
  });

  it('different seeds give different cycles (two stages never sync up)', () => {
    const period = (seed: number): number => {
      let prev = idleWeightShift(0, 1, seed).shiftM;
      const rising: number[] = [];
      for (let i = 1; i < FINE.length && rising.length < 2; i += 1) {
        const cur = idleWeightShift(FINE[i]!, 1, seed).shiftM;
        if (prev <= 0 && cur > 0) rising.push(FINE[i]!);
        prev = cur;
      }
      return rising[1]! - rising[0]!;
    };
    expect(Math.abs(period(0) - period(42))).toBeGreaterThan(0.1);
  });

  it('consecutive cycles differ (amplitude modulation) — never a metronome', () => {
    const peaks: number[] = [];
    let best = 0;
    let prevSign = 1;
    for (const t of FINE) {
      const { shiftM } = idleWeightShift(t, 1, 42);
      const sign = shiftM >= 0 ? 1 : -1;
      if (sign !== prevSign) {
        if (best > 0) peaks.push(best);
        best = 0;
        prevSign = sign;
      }
      best = Math.max(best, Math.abs(shiftM));
    }
    expect(peaks.length).toBeGreaterThan(8);
    expect(Math.max(...peaks) - Math.min(...peaks), 'half-cycle peaks vary').toBeGreaterThan(
      IDLE_SHIFT_PEAK_M * 0.05,
    );
  });

  it('continuous frame to frame — the live overlay can never pop', () => {
    let prev = idleWeightShift(0, 1, 42);
    for (let t = 1 / 60; t <= 30; t += 1 / 60) {
      const cur = idleWeightShift(t, 1, 42);
      expect(Math.abs(cur.shiftM - prev.shiftM)).toBeLessThan(IDLE_SHIFT_PEAK_M * 0.05);
      expect(Math.abs(cur.leanDeg - prev.leanDeg)).toBeLessThan(IDLE_SHIFT_LEAN_PEAK_DEG * 0.05);
      prev = cur;
    }
  });

  it('deterministic per (t, amount, seed); clamps amount; guards non-finite', () => {
    expect(idleWeightShift(3.14, 0.4, 42)).toEqual(idleWeightShift(3.14, 0.4, 42));
    expect(idleWeightShift(3.14, 9, 42)).toEqual(idleWeightShift(3.14, 1, 42));
    expect(idleWeightShift(3.14, -1, 42)).toEqual({ shiftM: 0, leanDeg: 0 });
    expect(idleWeightShift(Number.NaN, 1, 42)).toEqual({ shiftM: 0, leanDeg: 0 });
    expect(idleWeightShift(3.14, Number.NaN, 42)).toEqual({ shiftM: 0, leanDeg: 0 });
    // A non-finite seed falls back to seed 0 rather than exploding.
    expect(idleWeightShift(3.14, 1, Number.NaN)).toEqual(idleWeightShift(3.14, 1, 0));
  });
});

describe('cadenceRate — natural stride-time variability', () => {
  it('amount 0 ⇒ exactly 1 (a perfectly metronomic clean loop)', () => {
    for (const t of SWEEP) expect(cadenceRate(t, 0)).toBe(1);
  });

  it('is strictly bounded within 1 ± amount·CADENCE_CV_MAX', () => {
    for (const amount of [0.4, 1]) {
      for (const t of SWEEP) {
        expect(Math.abs(cadenceRate(t, amount) - 1)).toBeLessThanOrEqual(amount * CADENCE_CV_MAX + 1e-9);
      }
    }
  });

  it('has mean ≈ 1 over a long sweep (zero-mean drift — no cumulative speed-up/slow-down)', () => {
    const vals = SWEEP.map((t) => cadenceRate(t, 1));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    expect(Math.abs(mean - 1)).toBeLessThan(0.01);
  });

  it('actually drifts (not constant) and stays continuous frame-to-frame', () => {
    const vals = SWEEP.map((t) => cadenceRate(t, 1));
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(CADENCE_CV_MAX); // it varies
    // Continuity: adjacent 0.05 s steps never jump more than a small bound (C¹ clock).
    for (let i = 1; i < vals.length; i += 1) expect(Math.abs(vals[i]! - vals[i - 1]!)).toBeLessThan(0.01);
  });

  it('deterministic + guards non-finite / clamps amount', () => {
    expect(cadenceRate(7.5, 0.4)).toBe(cadenceRate(7.5, 0.4));
    expect(cadenceRate(Number.NaN, 1)).toBe(1);
    expect(cadenceRate(3, 9)).toBe(cadenceRate(3, 1));
    expect(cadenceRate(3, -1)).toBe(1);
  });
});
