/**
 * CONTINUOUS MOTION OBJECTIVE — a dense scalar reward over a graded motion.
 *
 * WHY THIS EXISTS. {@link ValidityReport.score} is a mean of per-check {1, 0.5, 0}
 * tokens over the 5-6 checks that ran, so it takes ~10 distinct values and is flat
 * almost everywhere. Measured directly: sweeping the four spinalGaitCoordination
 * gains across 14 settings leaves the score at exactly 0.80 for every one of them.
 * A search driven by that number is a search over a constant.
 *
 * The continuous information was there the whole time — every ValidityCheck
 * carries `measured` and `threshold` — it was just being collapsed to a token
 * before anyone could use it. This module keeps the margin.
 *
 * SIGNED MARGINS, NOT CLIPPED VIOLATIONS. Each check contributes
 * `(threshold - measured) / scale`, oriented so POSITIVE always means safer. It is
 * deliberately NOT clipped at zero: clipping would flatten the objective again
 * across the whole safe region, which is exactly where a well-behaved motion
 * lives and exactly where an optimizer needs to be able to tell better from good.
 *
 * WHAT THIS IS NOT. It is a shaping signal for search, not a verdict. Gate
 * decisions stay with {@link assessValidity}, which is the auditable pass/fail a
 * clinician and the test suite read. Nothing here changes what ships or what the
 * verdict card says — a reward that could flip a gate would let a search argue
 * its way past a safety check.
 */

import type { ValidityCheck, ValidityReport } from './validityGate';

/** How a check's `measured` value relates to goodness. */
type Direction = 'lower-is-better' | 'higher-is-better';

/**
 * Per-check orientation and the scale that normalizes its margin into roughly
 * [-1, 1] over the range a motion realistically explores. The scale is a UNIT
 * CONVERTER, not a preference: it exists so metres and m/s and ratios can be
 * summed at all, and changing one re-weights that check.
 */
const CHECK_TERMS: Record<string, { dir: Direction; scale: number; weight: number }> = {
  // Every resolved target inside its ROM band. A structural invariant — a
  // violation means resolution failed, so it dominates.
  'rom-violation': { dir: 'lower-is-better', scale: 5, weight: 3 },
  // Fraction of planted-contact frames that slide.
  'foot-skate': { dir: 'lower-is-better', scale: 0.5, weight: 2 },
  // Signed margin of the CoM inside the base of support, metres. Already signed
  // the right way round: bigger is more stable.
  'com-in-base': { dir: 'higher-is-better', scale: 0.1, weight: 1.5 },
  // Deepest tracked bone below the floor, metres.
  penetration: { dir: 'lower-is-better', scale: 0.06, weight: 2 },
  // Max velocity discontinuity, m/s.
  'seam-jerk': { dir: 'lower-is-better', scale: 12, weight: 1.5 },
  // Worst capsule clearance, metres. Positive is clear.
  'self-intersection': { dir: 'higher-is-better', scale: 0.05, weight: 2 },
  // Biomech hook (gaitBiomechCheck). These grade a WITHIN-BAND FRACTION, which is
  // a count over 21 curve points and therefore its own step function — they are
  // included at low weight so they steer without dominating, and the RMS behind
  // them is the number a future revision should grade instead.
  'normative-kneeFlexion': { dir: 'higher-is-better', scale: 0.5, weight: 1 },
  'normative-hipFlexion': { dir: 'higher-is-better', scale: 0.5, weight: 1 },
  'normative-ankleFlexion': { dir: 'higher-is-better', scale: 0.5, weight: 1 },
  'vertical-com': { dir: 'higher-is-better', scale: 0.5, weight: 0.5 },
  froude: { dir: 'higher-is-better', scale: 0.5, weight: 0.5 },
};

/** One check's contribution, for auditing why a candidate scored as it did. */
export interface ObjectiveTerm {
  id: string;
  measured: number;
  threshold: number;
  /** Signed, normalized: positive = safer than threshold. */
  margin: number;
  weight: number;
  /** margin × weight — what actually entered the sum. */
  contribution: number;
}

export interface MotionObjective {
  /** The scalar to MAXIMIZE. Higher is better; unbounded both ways. */
  reward: number;
  /** True when the underlying gate says this motion is shippable. A search may
   *  read this to reject a candidate outright, but must not treat `reward` as
   *  authority over it. */
  valid: boolean;
  terms: ObjectiveTerm[];
  /** Checks present in the report that carry no term here — reported so an added
   *  gate check cannot silently fall out of the objective. */
  ungraded: string[];
}

const margin = (c: ValidityCheck, dir: Direction, scale: number): number => {
  const raw = dir === 'lower-is-better' ? c.threshold - c.measured : c.measured - c.threshold;
  const m = raw / (scale === 0 ? 1 : scale);
  return Number.isFinite(m) ? m : 0;
};

/**
 * Turn a {@link ValidityReport} into a dense scalar plus its per-term breakdown.
 *
 * A check the report SKIPPED contributes nothing — not zero, not a penalty.
 * Scoring a skip as a failure would punish every non-gait motion for not being a
 * gait; scoring it as a pass is the denominator-gaming hole the token score has,
 * where flipping `loop` to true raises the score by deleting a failing check.
 * Omitting it means the reward is only comparable BETWEEN candidates that ran the
 * same checks — which is true within one search, where the motion's shape is
 * fixed and only the gains move.
 */
export function motionObjective(report: ValidityReport): MotionObjective {
  const terms: ObjectiveTerm[] = [];
  const ungraded: string[] = [];
  for (const c of report.checks) {
    const t = CHECK_TERMS[c.id];
    if (!t) {
      ungraded.push(c.id);
      continue;
    }
    const m = margin(c, t.dir, t.scale);
    terms.push({
      id: c.id,
      measured: c.measured,
      threshold: c.threshold,
      margin: m,
      weight: t.weight,
      contribution: m * t.weight,
    });
  }
  return {
    reward: terms.reduce((a, t) => a + t.contribution, 0),
    valid: report.overall !== 'fail',
    terms,
    ungraded,
  };
}

/** Every check id the objective knows how to grade — for coverage assertions. */
export function gradedCheckIds(): string[] {
  return Object.keys(CHECK_TERMS);
}
