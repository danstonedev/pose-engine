/**
 * EXERTION-SCALED BREATHING (Wave 5 · life-signals) — the audit's polish
 * finding: breathing was "context-blind — identical 15 bpm at rest and
 * mid-run". Gates:
 *   • the exertion accumulator RISES during vigorous work and DECAYS over the
 *     ~30–60 s recovery window at rest (frame-rate-independent exact step);
 *   • the breathing rate maps 12–15 bpm at rest → 24–30 bpm at full exertion,
 *     amplitude up to 1.6×;
 *   • the frequency modulation is PHASE-CONTINUOUS — a rate change mid-breath
 *     can never jump, because the phase is INTEGRATED (φ += 2π·hz·dt), never
 *     computed as t×rate;
 *   • `motionWorkIntensity` separates a walk from a run off their resolved
 *     keyframes (the signal the stage feeds the accumulator);
 *   • clean mode (amount 0) is exactly zero at ANY exertion; everything is
 *     deterministic.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceBreathPhase,
  breathAmpScale,
  breathHz,
  breathingLean,
  breathingLeanFM,
  motionWorkIntensity,
  stepExertion,
  BREATH_AMP_MAX_SCALE,
  BREATH_MAX_HZ,
  BREATH_REST_HZ,
  EXERTION_DECAY_TAU_S,
  EXERTION_RISE_TAU_S,
} from '../services/liveliness';
import { buildTravelRun, buildTravelWalk } from '../services/movementTemplates';
import { resolveComposedMotion } from '../services/motionSequence';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const BREATH_PEAK_DEG = 2.2; // the module's stated resting peak (contract)

describe('stepExertion — the recent-work accumulator', () => {
  it('rises during vigorous work: ~10 s at intensity 1 gets you breathing hard', () => {
    let level = 0;
    for (let t = 0; t < 10; t += 1 / 60) level = stepExertion(level, 1, 1 / 60);
    expect(level).toBeGreaterThan(0.6);
    expect(level).toBeLessThan(0.95);
  });

  it('decays over ~30–60 s of rest (the audit recovery window): still elevated at 30 s, mostly recovered by 60 s, gone by 2 min', () => {
    const decayFor = (sec: number): number => {
      let level = 1;
      for (let t = 0; t < sec; t += 1 / 60) level = stepExertion(level, 0, 1 / 60);
      return level;
    };
    expect(decayFor(30)).toBeGreaterThan(0.4); // not an instant reset…
    expect(decayFor(30)).toBeLessThan(0.6);
    expect(decayFor(60)).toBeGreaterThan(0.18); // …meaningfully recovered by a minute…
    expect(decayFor(60)).toBeLessThan(0.35);
    expect(decayFor(120)).toBeLessThan(0.1); // …and essentially gone after two.
  });

  it('recovery is SLOWER than onset (asymmetric time constants)', () => {
    expect(EXERTION_DECAY_TAU_S).toBeGreaterThan(EXERTION_RISE_TAU_S * 2);
  });

  it('is an exact exponential step — frame-rate-independent (two half-steps ≡ one full step)', () => {
    const one = stepExertion(0.3, 1, 1 / 30);
    const two = stepExertion(stepExertion(0.3, 1, 1 / 60), 1, 1 / 60);
    expect(two).toBeCloseTo(one, 12);
  });

  it('clamps to [0,1], guards non-finite, and is deterministic', () => {
    expect(stepExertion(0.5, 1, Number.NaN)).toBe(0.5);
    expect(stepExertion(0.5, 1, -1)).toBe(0.5);
    expect(stepExertion(Number.NaN, 1, 1)).toBeGreaterThan(0); // level coerces to 0, then rises
    expect(stepExertion(0.5, 5, 1)).toBe(stepExertion(0.5, 1, 1)); // intensity clamps to 1
    expect(stepExertion(0.4, 0.8, 0.5)).toBe(stepExertion(0.4, 0.8, 0.5));
    // Never leaves the unit interval.
    expect(stepExertion(1, 1, 100)).toBeLessThanOrEqual(1);
    expect(stepExertion(0, 0, 100)).toBeGreaterThanOrEqual(0);
  });
});

describe('breathing rate + amplitude mapping', () => {
  it('rest sits in the 12–15 bpm band; full exertion in the 24–30 bpm band', () => {
    const restBpm = breathHz(0) * 60;
    const maxBpm = breathHz(1) * 60;
    expect(restBpm).toBeGreaterThanOrEqual(12);
    expect(restBpm).toBeLessThanOrEqual(15);
    expect(maxBpm).toBeGreaterThanOrEqual(24);
    expect(maxBpm).toBeLessThanOrEqual(30);
    expect(breathHz(0)).toBe(BREATH_REST_HZ);
    expect(breathHz(1)).toBe(BREATH_MAX_HZ);
  });

  it('rate and amplitude both rise monotonically with exertion; amplitude caps at 1.6×', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(breathHz((i + 1) / 10)).toBeGreaterThan(breathHz(i / 10));
      expect(breathAmpScale((i + 1) / 10)).toBeGreaterThan(breathAmpScale(i / 10));
    }
    expect(breathAmpScale(0)).toBe(1);
    expect(breathAmpScale(1)).toBe(BREATH_AMP_MAX_SCALE);
    expect(breathAmpScale(9)).toBe(BREATH_AMP_MAX_SCALE); // clamped
  });

  it('breathingLeanFM is bounded by amount × peak × ampScale, and amount 0 is EXACTLY 0 at any exertion (clean mode)', () => {
    for (let phi = 0; phi < 20; phi += 0.13) {
      expect(Math.abs(breathingLeanFM(phi, 1, 1))).toBeLessThanOrEqual(
        BREATH_PEAK_DEG * BREATH_AMP_MAX_SCALE + 1e-9,
      );
      expect(breathingLeanFM(phi, 0, 1)).toBe(0);
      expect(breathingLeanFM(phi, 0, 0)).toBe(0);
    }
  });

  it('at exertion 0 the FM path reproduces the legacy resting breath exactly (φ = 2π·rest·t)', () => {
    // The legacy breathingLean runs at the OLD fixed 0.25 Hz; the FM rest rate
    // is 0.23 Hz — so compare against the FM's own φ(t), and against the
    // legacy function only at t=0 (both sin(0)=0) plus equal amplitudes.
    for (const t of [0, 0.7, 2.3, 9.1]) {
      const phi = 2 * Math.PI * BREATH_REST_HZ * t;
      expect(breathingLeanFM(phi, 0.4, 0)).toBeCloseTo(0.4 * BREATH_PEAK_DEG * Math.sin(phi), 12);
    }
    expect(breathingLeanFM(0, 1, 0)).toBe(breathingLean(0, 1));
  });
});

describe('phase-continuous frequency modulation (the FM math)', () => {
  it('NO discontinuity when the rate changes mid-breath: the lean stays slope-bounded through an intensity step', () => {
    // Simulate the stage: intensity jumps 0→1 at t=5 s; exertion follows via
    // stepExertion (smooth); phase INTEGRATES at the varying rate. The lean
    // must never jump more than its worst-case slope allows per frame.
    const dt = 1 / 60;
    let level = 0;
    let phase = 0;
    let prev = breathingLeanFM(phase, 1, level);
    // Worst-case |d lean/dt| = peak·ampMax·2π·maxHz (+ the slow amp ramp) —
    // ≈ 9.95 °/s ⇒ ~0.166°/frame; 0.25° is a safe per-frame ceiling.
    const frameBound = 0.25;
    for (let t = dt; t <= 30; t += dt) {
      const intensity = t >= 5 ? 1 : 0;
      level = stepExertion(level, intensity, dt);
      phase = advanceBreathPhase(phase, dt, level);
      const cur = breathingLeanFM(phase, 1, level);
      expect(Math.abs(cur - prev), `continuous at t=${t.toFixed(2)}s`).toBeLessThan(frameBound);
      prev = cur;
    }
  });

  it('the breath period genuinely SHORTENS under exertion (rate rises from ~4.3 s to ~2.2 s cycles)', () => {
    const dt = 1 / 120;
    let level = 0;
    let phase = 0;
    let prevLean = 0;
    const upCrossings: number[] = [];
    for (let t = dt; t <= 60; t += dt) {
      const intensity = t >= 10 ? 1 : 0;
      level = stepExertion(level, intensity, dt);
      phase = advanceBreathPhase(phase, dt, level);
      const lean = breathingLeanFM(phase, 1, level);
      if (prevLean <= 0 && lean > 0) upCrossings.push(t);
      prevLean = lean;
    }
    expect(upCrossings.length).toBeGreaterThan(6);
    const firstPeriod = upCrossings[1]! - upCrossings[0]!; // rest
    const lastPeriod = upCrossings[upCrossings.length - 1]! - upCrossings[upCrossings.length - 2]!; // exerted
    expect(firstPeriod).toBeGreaterThan(1 / BREATH_MAX_HZ + 0.3); // clearly a resting breath…
    expect(firstPeriod).toBeLessThan(1 / BREATH_REST_HZ + 0.3);
    expect(lastPeriod).toBeLessThan(1 / BREATH_MAX_HZ + 0.25); // …vs a hard-breathing cycle
  });

  it('advanceBreathPhase integrates (φ accumulates 2π·hz·dt) and guards non-finite/negative dt', () => {
    expect(advanceBreathPhase(1, 0.5, 0)).toBeCloseTo(1 + 2 * Math.PI * BREATH_REST_HZ * 0.5, 12);
    expect(advanceBreathPhase(1, Number.NaN, 0)).toBe(1);
    expect(advanceBreathPhase(1, -0.1, 0)).toBe(1);
    expect(advanceBreathPhase(Number.NaN, 0.1, 0)).toBeCloseTo(2 * Math.PI * BREATH_REST_HZ * 0.1, 12);
    // Deterministic.
    expect(advanceBreathPhase(2, 0.25, 0.7)).toBe(advanceBreathPhase(2, 0.25, 0.7));
  });
});

describe('motionWorkIntensity — the intensity signal the stage feeds', () => {
  it('a resolved travelling RUN reads vigorous; a resolved travelling WALK reads mild; a run > a walk', () => {
    const walk = resolveComposedMotion(buildTravelWalk(), variantCfg);
    const run = resolveComposedMotion(buildTravelRun(), variantCfg);
    expect(walk.status).toBe('ok');
    expect(run.status).toBe('ok');
    const walkIntensity = motionWorkIntensity(walk.keyframes);
    const runIntensity = motionWorkIntensity(run.keyframes);
    // eslint-disable-next-line no-console
    console.log(`work intensity: walk ${walkIntensity.toFixed(3)}, run ${runIntensity.toFixed(3)}`);
    expect(walkIntensity).toBeGreaterThan(0.02); // a walk IS work…
    expect(walkIntensity).toBeLessThan(0.55); // …but mild
    expect(runIntensity).toBeGreaterThan(0.5); // a run is vigorous
    expect(runIntensity).toBeGreaterThan(walkIntensity + 0.2); // clear separation
  });

  it('empty/degenerate input ⇒ 0; deterministic; result always in [0,1]', () => {
    expect(motionWorkIntensity([])).toBe(0);
    expect(motionWorkIntensity([{ durationMs: 0 }])).toBe(0);
    const walk = resolveComposedMotion(buildTravelWalk(), variantCfg);
    expect(motionWorkIntensity(walk.keyframes)).toBe(motionWorkIntensity(walk.keyframes));
    const run = resolveComposedMotion(buildTravelRun(), variantCfg);
    expect(motionWorkIntensity(run.keyframes)).toBeLessThanOrEqual(1);
    expect(motionWorkIntensity(run.keyframes)).toBeGreaterThanOrEqual(0);
  });

  it('holds dilute intensity (a long dwell after a move is rest, not work)', () => {
    const move = [{ durationMs: 500, targets: [{ joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 60 }] }];
    const moveThenHold = [
      { ...move[0]!, holdMs: 4000 },
    ];
    expect(motionWorkIntensity(moveThenHold)).toBeLessThan(motionWorkIntensity(move));
  });
});
