/**
 * THE OBJECTIVE'S ORIENTATION — the property that decides whether a search is
 * useful or actively harmful.
 *
 * A reward function is not "roughly right". It is the thing an optimizer will
 * exploit to the limit of its bounds, so every term has to be pointed the correct
 * way or the search will reliably find the direction that is wrong. This file
 * exists because that failure actually happened here: `vertical-com` was graded
 * `higher-is-better` against a threshold that is the UPPER EDGE of a two-sided
 * band, and the first real tuning run on the rig spent its entire measured gain
 * (+0.199, of which +0.190 was this one term) pushing pelvis excursion from 5.50 cm
 * toward 9 cm — away from the 4–5 cm norm, toward a bounce — while the shipped
 * token score sat at 0.80 and reported nothing.
 *
 * The tests below are written against SYNTHETIC reports rather than the rig, so
 * they state the orientation claims directly and fail for exactly one reason.
 */
import { describe, expect, it } from 'vitest';
import { motionObjective, gradedCheckIds } from '../services/motionObjective';
import { VERTICAL_COM_CM } from '../services/normativeGait';
import type { ValidityCheck, ValidityReport } from '../services/validityGate';

/** A report carrying exactly the checks named, so one term can be isolated. */
function reportOf(checks: Partial<ValidityCheck>[]): ValidityReport {
  return {
    overall: 'pass',
    score: 1,
    skipped: [],
    checks: checks.map((c) => ({
      id: 'x',
      pass: true,
      severity: 'warn',
      measured: 0,
      threshold: 0,
      unit: '',
      note: '',
      ...c,
    })) as ValidityCheck[],
  };
}

const rewardFor = (id: string, measured: number, threshold = 0): number =>
  motionObjective(reportOf([{ id, measured, threshold }])).reward;

describe('two-sided checks are graded as bands, from BOTH sides', () => {
  it('vertical-com peaks inside the physiologic band, not at the gate edge', () => {
    const [lo, hi] = VERTICAL_COM_CM; // 4–5 cm
    const inside = rewardFor('vertical-com', (lo + hi) / 2, 9);
    // The gate tolerates up to 9 cm. The objective must NOT prefer 9 to 4.5 — that
    // preference is what paid the search to make the walk bouncier.
    expect(rewardFor('vertical-com', 9, 9)).toBeLessThan(inside);
    // …and must not prefer a glide either. A one-sided fix that only capped the
    // top would leave this direction broken.
    expect(rewardFor('vertical-com', 2, 9)).toBeLessThan(inside);
    // Monotone as it leaves the band, so there is a gradient pointing home.
    expect(rewardFor('vertical-com', 7, 9)).toBeLessThan(rewardFor('vertical-com', 6, 9));
    expect(rewardFor('vertical-com', 6, 9)).toBeLessThan(rewardFor('vertical-com', hi, 9));
  });

  it('anywhere inside the band scores the same — no invented preference', () => {
    const [lo, hi] = VERTICAL_COM_CM;
    expect(rewardFor('vertical-com', lo, 9)).toBe(rewardFor('vertical-com', hi, 9));
    expect(rewardFor('vertical-com', (lo + hi) / 2, 9)).toBe(rewardFor('vertical-com', lo, 9));
  });

  it('froude is penalized for a shuffle AND for creeping toward the run regime', () => {
    const comfortable = rewardFor('froude', 0.25, 0.5);
    expect(rewardFor('froude', 0.03, 0.5)).toBeLessThan(comfortable); // barely moving
    expect(rewardFor('froude', 0.48, 0.5)).toBeLessThan(comfortable); // nearly a run
    // The old orientation made 0.48 the best available walk. Pin that it is not.
    expect(rewardFor('froude', 0.48, 0.5)).toBeLessThan(rewardFor('froude', 0.35, 0.5));
  });

  it('a band term reports its band and no misleading threshold', () => {
    const t = motionObjective(reportOf([{ id: 'vertical-com', measured: 5, threshold: 9 }])).terms[0]!;
    expect(t.band).toEqual(VERTICAL_COM_CM);
    expect(Number.isNaN(t.threshold)).toBe(true);
  });
});

describe('a band is graded against the regime the motion is TRYING to be', () => {
  // Second real finding from the harness, on the second job. The run was charged a
  // −5.84 Froude penalty for correctly being a run — walking bands applied to a
  // running motion — and the search responded rationally by trying to flatten it
  // back into a walk, pinning `axial` and `pelvis` at their bounds on the way.
  it('a correct run is not penalized for being one', () => {
    const asWalk = motionObjective(reportOf([{ id: 'froude', measured: 1.518, threshold: 0.5 }]));
    const asRun = motionObjective(reportOf([{ id: 'froude', measured: 1.518, threshold: 0.5 }]), {
      regime: 'run',
    });
    expect(asWalk.reward).toBeLessThan(-5);
    expect(asRun.reward).toBe(0); // inside RUN_PATTERN_BANDS.run.froude
    expect(asRun.reward).toBeGreaterThan(asWalk.reward);
  });

  it('a walk that has become a run is still penalized', () => {
    // The regime must not be a way to switch the check off — declaring 'walk' has
    // to keep catching the thing the gate cares about.
    const r = motionObjective(reportOf([{ id: 'froude', measured: 1.518, threshold: 0.5 }]));
    expect(r.reward).toBeLessThan(
      motionObjective(reportOf([{ id: 'froude', measured: 0.25, threshold: 0.5 }])).reward,
    );
  });

  it('a run below its own band is penalized too — the band is still two-sided', () => {
    const slow = motionObjective(reportOf([{ id: 'froude', measured: 0.2, threshold: 0.5 }]), {
      regime: 'run',
    });
    expect(slow.reward).toBeLessThan(0);
  });

  it('a check with no cited band for the regime is UNGRADED, not silently zero', () => {
    // vertical-com's running figure in this engine is the grounded stance arc, a
    // different quantity from whole-motion excursion. Rather than invent a number
    // for an optimizer to push against, the term drops out and says so.
    const r = motionObjective(reportOf([{ id: 'vertical-com', measured: 9.01, threshold: 9 }]), {
      regime: 'run',
    });
    expect(r.terms).toEqual([]);
    expect(r.ungraded).toContain('vertical-com');
    // …and it IS graded for a walk, so this is regime-specific, not a dead term.
    const w = motionObjective(reportOf([{ id: 'vertical-com', measured: 9.01, threshold: 9 }]));
    expect(w.terms).toHaveLength(1);
    expect(w.ungraded).not.toContain('vertical-com');
  });

  it('defaults to walk, so an un-declared caller gets the stricter reading', () => {
    const explicit = motionObjective(reportOf([{ id: 'froude', measured: 1.518, threshold: 0.5 }]), {
      regime: 'walk',
    });
    expect(motionObjective(reportOf([{ id: 'froude', measured: 1.518, threshold: 0.5 }])).reward).toBe(
      explicit.reward,
    );
  });
});

describe('one-sided checks keep their orientation', () => {
  it('less foot-skate, penetration, seam-jerk and ROM violation is better', () => {
    for (const id of ['foot-skate', 'penetration', 'seam-jerk', 'rom-violation']) {
      expect(rewardFor(id, 0.5, 1), id).toBeLessThan(rewardFor(id, 0.1, 1));
    }
  });

  it('more CoM margin and normative-band coverage is better', () => {
    expect(rewardFor('com-in-base', 0.01, 0)).toBeLessThan(rewardFor('com-in-base', 0.05, 0));
    for (const j of ['kneeFlexion', 'hipFlexion', 'ankleFlexion']) {
      const id = `normative-${j}`;
      expect(rewardFor(id, 0.3, 0.5), id).toBeLessThan(rewardFor(id, 0.9, 0.5));
    }
  });
});

describe('clearance is a constraint to satisfy, not a quantity to hoard', () => {
  // Third real finding from the harness. As `higher-is-better` this term paid
  // without limit for extra hand-to-thigh clearance, so on the run the search
  // maxed out `axial` and `pelvis` to fling the arms outward and banked the whole
  // gain from 6.6 cm → 7.0 cm of air that nobody asked for.
  const CLEAR = 0.01; // the gate's clearance threshold

  it('interpenetration is punished, and harder the deeper it goes', () => {
    expect(rewardFor('self-intersection', -0.05, CLEAR)).toBeLessThan(
      rewardFor('self-intersection', -0.01, CLEAR),
    );
    expect(rewardFor('self-intersection', -0.01, CLEAR)).toBeLessThan(0);
  });

  it('a WORSE motion never scores better, even when the gate moves its threshold', () => {
    // checkSelfIntersection reports threshold 0.01 normally and −0.05 once it calls
    // a limb BURIED. The shipped walk sits at −4.73 cm, 2.7 mm from that line. Read
    // naively, crossing it would move the comparison point along with the motion and
    // pay +2.29 for getting worse. Monotonicity across the switch is the property.
    const nearBurial = rewardFor('self-intersection', -0.0473, 0.01);
    const buried = rewardFor('self-intersection', -0.0501, -0.05); // gate flips threshold
    expect(buried).toBeLessThan(nearBurial);
    const deeper = rewardFor('self-intersection', -0.09, -0.05);
    expect(deeper).toBeLessThan(buried);
  });

  it('once clear, MORE clearance buys nothing — the exploit is closed', () => {
    const atThreshold = rewardFor('self-intersection', CLEAR, CLEAR);
    expect(atThreshold).toBe(0);
    expect(rewardFor('self-intersection', 0.07, CLEAR)).toBe(atThreshold);
    // The specific move the search made on the run must now be worth exactly zero.
    expect(rewardFor('self-intersection', 0.0702, CLEAR)).toBe(
      rewardFor('self-intersection', 0.0663, CLEAR),
    );
  });
});

describe('the objective cannot silently stop grading something', () => {
  it('every graded id is reachable, and unknown ids are reported not ignored', () => {
    const ids = gradedCheckIds();
    expect(ids.length).toBeGreaterThan(8);
    const o = motionObjective(reportOf([...ids.map((id) => ({ id })), { id: 'brand-new-check' }]));
    expect(o.terms.map((t) => t.id).sort()).toEqual([...ids].sort());
    expect(o.ungraded).toEqual(['brand-new-check']);
  });

  it('a skipped check contributes nothing rather than a free pass', () => {
    // Denominator gaming is the failure mode of the token score; the objective must
    // not reproduce it by scoring absent checks as satisfied.
    expect(motionObjective(reportOf([])).reward).toBe(0);
    expect(motionObjective(reportOf([])).terms).toEqual([]);
  });

  it('a non-finite measurement degrades to 0 rather than poisoning the sum', () => {
    const o = motionObjective(reportOf([{ id: 'foot-skate', measured: NaN, threshold: 0.5 }]));
    expect(Number.isFinite(o.reward)).toBe(true);
  });
});
