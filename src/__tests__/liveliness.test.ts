import { describe, expect, it } from 'vitest';
import { breathingLean, livelinessSwayDeg, cadenceRate, CADENCE_CV_MAX } from '../services/liveliness';

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
