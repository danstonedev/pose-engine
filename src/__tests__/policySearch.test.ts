/**
 * POLICY SEARCH — the optimizer itself, against synthetic objectives.
 *
 * Separated from the rig run on purpose: this file proves the SEARCH is correct
 * (it finds a known optimum, it is reproducible, it respects bounds), and
 * gaitTuning.test.ts proves the search moves the REAL objective on the REAL rig.
 * Mixing them would leave a failure ambiguous between "the optimizer is broken"
 * and "the engine objective is flat", which is precisely the confusion this whole
 * effort exists to resolve.
 */
import { describe, expect, it } from 'vitest';
import {
  searchParameters,
  identityVector,
  type Parameter,
  type Vector,
} from '../services/policySearch';

const PARAMS: readonly Parameter[] = [
  { name: 'a', min: -1, max: 1, identity: 0 },
  { name: 'b', min: -1, max: 1, identity: 0 },
];

/** A smooth bowl with its optimum away from the identity point. */
const bowl = (target: Vector) => async (v: Vector) =>
  -((v.a! - target.a!) ** 2 + (v.b! - target.b!) ** 2);

describe('the search finds a known optimum', () => {
  it('moves from the identity point toward the target', async () => {
    const r = await searchParameters(PARAMS, bowl({ a: 0.5, b: -0.4 }), { budget: 300, seed: 7 });
    expect(r.bestReward).toBeGreaterThan(r.baselineReward);
    expect(r.best.a).toBeCloseTo(0.5, 1);
    expect(r.best.b).toBeCloseTo(-0.4, 1);
  });

  it('reports the baseline it started from, so any gain is attributable', async () => {
    const r = await searchParameters(PARAMS, bowl({ a: 0.5, b: -0.4 }), { budget: 60, seed: 3 });
    // identity (0,0) against target (0.5,-0.4) ⇒ -(0.25 + 0.16)
    expect(r.baselineReward).toBeCloseTo(-0.41, 5);
  });

  it('leaves a vector alone when the identity point IS the optimum', async () => {
    const r = await searchParameters(PARAMS, bowl({ a: 0, b: 0 }), { budget: 120, seed: 11 });
    expect(r.best.a).toBeCloseTo(0, 1);
    expect(r.best.b).toBeCloseTo(0, 1);
  });
});

describe('reproducibility — a tuning result nobody can rerun is not evidence', () => {
  it('the same seed gives the same trajectory', async () => {
    const run = () => searchParameters(PARAMS, bowl({ a: 0.3, b: 0.3 }), { budget: 80, seed: 42 });
    const [x, y] = await Promise.all([run(), run()]);
    expect(x.best).toEqual(y.best);
    expect(x.bestReward).toBe(y.bestReward);
    expect(x.history.map((h) => h.reward)).toEqual(y.history.map((h) => h.reward));
  });

  it('different seeds explore differently', async () => {
    const a = await searchParameters(PARAMS, bowl({ a: 0.3, b: 0.3 }), { budget: 40, seed: 1 });
    const b = await searchParameters(PARAMS, bowl({ a: 0.3, b: 0.3 }), { budget: 40, seed: 2 });
    expect(a.history.map((h) => h.reward)).not.toEqual(b.history.map((h) => h.reward));
  });
});

describe('bounds are respected — a search must not widen its own constraints', () => {
  it('never proposes outside [min, max], even chasing an out-of-bounds optimum', async () => {
    const r = await searchParameters(PARAMS, bowl({ a: 99, b: -99 }), { budget: 200, seed: 5 });
    for (const h of r.history) {
      expect(h.candidate.a).toBeGreaterThanOrEqual(-1);
      expect(h.candidate.a).toBeLessThanOrEqual(1);
      expect(h.candidate.b).toBeGreaterThanOrEqual(-1);
      expect(h.candidate.b).toBeLessThanOrEqual(1);
    }
  });
});

describe('an invalid candidate is a bad step, not a crash', () => {
  it('treats -Infinity as rejected and keeps searching', async () => {
    let calls = 0;
    const r = await searchParameters(
      PARAMS,
      async (v) => {
        calls += 1;
        if (v.a! > 0.1) return -Infinity; // a hard constraint the caller enforces
        return -((v.a! - 0.05) ** 2 + v.b! ** 2);
      },
      { budget: 120, seed: 9 },
    );
    expect(calls).toBeGreaterThan(50);
    expect(r.best.a).toBeLessThanOrEqual(0.1);
    expect(Number.isFinite(r.bestReward)).toBe(true);
  });
});

describe('it stops when it stops learning', () => {
  it('converges on a flat objective rather than burning the budget', async () => {
    // It costs ~100 evaluations to CONFIRM flatness, and that is the honest
    // number: the step has to shrink from 0.15 to the 0.01 convergence floor
    // (x0.75 per 10 evaluations) before "no improvement" means "localized"
    // rather than "still stepping too far". Stopping sooner is how the first
    // version quit a third of the way to a known optimum.
    const r = await searchParameters(PARAMS, async () => 1, { budget: 500, seed: 4 });
    expect(r.stoppedBy).toBe('converged');
    expect(r.evaluations).toBeLessThan(150);
    expect(r.evaluations).toBeGreaterThan(80);
  });

  it('a flat objective returns the identity point unchanged', async () => {
    // The honest outcome when there is nothing to learn: no movement, not noise.
    const r = await searchParameters(PARAMS, async () => 1, { budget: 200, seed: 6 });
    expect(r.best).toEqual(identityVector(PARAMS));
    expect(r.accepted).toBe(0);
  });
});
