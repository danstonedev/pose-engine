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
 * SIGNED MARGINS. Each check contributes a normalized distance from its threshold,
 * oriented so POSITIVE always means safer. Where a quantity genuinely has "more is
 * better" semantics the margin is left unclipped, because clipping there would
 * flatten the objective across the whole safe region — exactly where a well-behaved
 * motion lives and exactly where an optimizer needs to tell better from good.
 *
 * BUT AN UNBOUNDED DIRECTION IS AN INSTRUCTION. Every term that keeps paying past
 * the point of clinical meaning will be ridden to the bounds, because that is what
 * search does. Three of the eleven terms here were originally written that way and
 * all three were caught by running the loop and reading what it chose:
 * `vertical-com` paid to make the walk bouncier, `froude` paid to make a run stop
 * being a run, and `self-intersection` paid to fling the arms wide. The two shapes
 * that fix it are {@link Direction}'s `band` (correct in a range, worse on either
 * side) and `at-least` (a constraint to satisfy, with no prize for exceeding it).
 * Choosing between unbounded, banded and satisficing is the whole design of this
 * file; the weights are the easy part.
 *
 * WHAT THIS IS NOT. It is a shaping signal for search, not a verdict. Gate
 * decisions stay with {@link assessValidity}, which is the auditable pass/fail a
 * clinician and the test suite read. Nothing here changes what ships or what the
 * verdict card says — a reward that could flip a gate would let a search argue
 * its way past a safety check.
 */

import { DEFAULT_VALIDITY_THRESHOLDS } from './validityGate';
import type { ValidityCheck, ValidityReport } from './validityGate';
import { VERTICAL_COM_CM } from './normativeGait';
import { RUN_PATTERN_BANDS } from './normativeRun';

/**
 * What the motion is TRYING to be.
 *
 * Band terms are meaningless without this. "Normal vertical excursion" and
 * "normal Froude" are different numbers for a walk and a run — a run at Fr 1.5 is
 * a correct run and a walk at Fr 1.5 is a walk that has become a run — and no
 * measurement can tell the two apart, because the difference is intent. Grading a
 * run against walking norms is not a small error: measured on the rig, it charged
 * the run a −5.84 Froude penalty for correctly being a run and then paid the search
 * to flatten it back toward a walk, pinning two gains at their bounds on the way.
 */
export type MotionRegime = 'walk' | 'run';

/**
 * How a check's `measured` value relates to goodness.
 *
 * `band` is the one that is easy to get wrong and expensive to get wrong. Some
 * gate checks are TWO-SIDED — they pass inside a range and fail on either side —
 * but a {@link ValidityCheck} has only one `threshold` field, so a band check
 * reports its UPPER edge there. Grading such a check as `higher-is-better` against
 * that field produces a reward that climbs monotonically toward the edge and keeps
 * climbing past it, which is precisely an optimizer being paid to break the check.
 * That is not hypothetical: `vertical-com` shipped as `higher-is-better`, and the
 * first real tuning run spent its entire measured gain pushing CoM excursion from
 * 5.50 cm toward 9 cm — away from the 4–5 cm physiologic norm and toward a visible
 * bounce, while the token score sat unchanged at 0.80 and hid it.
 */
type Direction = 'lower-is-better' | 'higher-is-better' | 'at-least' | 'band';

/**
 * `at-least` is the SATISFICING direction, and it exists for the same reason
 * `band` does: an unbounded reward direction is an instruction to an optimizer to
 * go as far as the bounds allow.
 *
 * `self-intersection` shipped as `higher-is-better`, which says "more clearance is
 * always better, without limit". On the run that is a live exploit and the harness
 * caught it: the search drove `axial` and `pelvis` to their maxima and took its
 * entire gain from hand-to-thigh clearance climbing 6.6 cm → 7.0 cm — a caricature
 * arm swing, bought at no cost because nothing said when clear is clear enough.
 *
 * Clearance is a CONSTRAINT, not a quantity to accumulate. Once a limb is past the
 * clearance line there is no clinical value in more, so the term saturates at 0
 * there and only bites when the constraint is violated.
 *
 * THE SATURATION POINT IS STATED IN THE SPEC, NOT READ FROM THE CHECK, and that is
 * not a style choice. `checkSelfIntersection` reports a MOVING threshold: 0.01 m
 * normally, but −0.05 m once it decides a limb is BURIED, because it is describing
 * the line it actually judged against. An objective reading that field inherits the
 * jump. On the shipped walk, which sits at −4.73 cm — 2.7 mm from the burial line —
 * a candidate that got WORSE and crossed into burial would have its comparison
 * point move with it and score +2.29 better for it. The only thing standing between
 * that reward hack and the search is the caller's `valid` guard, which turns the
 * burial verdict into −Infinity. Depending on a safety check to cover for a
 * mis-specified reward is how you get an optimizer that is one refactor away from
 * driving straight into the thing the reward was supposed to discourage.
 */

/**
 * Per-check orientation and the scale that normalizes its margin into roughly
 * [-1, 1] over the range a motion realistically explores. The scale is a UNIT
 * CONVERTER, not a preference: it exists so metres and m/s and ratios can be
 * summed at all, and changing one re-weights that check.
 *
 * A `band` term carries its own target range and IGNORES the check's `threshold`
 * field, because that field holds one edge of a two-sided range (see Direction).
 * The band used is the PHYSIOLOGIC one, which is narrower than the gate's
 * tolerance: the gate decides what is shippable, the objective steers toward what
 * is normal. Rewarding a motion for drifting away from normal merely because the
 * gate still tolerates it is the mistake this distinction prevents.
 */
type TermSpec =
  | { dir: 'lower-is-better' | 'higher-is-better'; scale: number; weight: number }
  | {
      dir: 'at-least';
      /** The saturation point, stated HERE rather than read from the check. See
       *  `at-least` above for why reading `c.threshold` is unsafe for this shape. */
      target: number;
      scale: number;
      weight: number;
    }
  | {
      dir: 'band';
      /** Target range per regime. `null` means the engine carries no cited band for
       *  that regime, so the term is NOT graded there and is reported as ungraded.
       *  Inventing a plausible number instead would put an unsourced constant into
       *  the one place an optimizer is guaranteed to push against. */
      bands: Readonly<Record<MotionRegime, readonly [number, number] | null>>;
      scale: number;
      weight: number;
    };

const CHECK_TERMS: Record<string, TermSpec> = {
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
  // Worst capsule clearance, metres. SATISFICING: bites hard on interpenetration,
  // saturates at 0 once the limbs are clear. See `at-least`.
  'self-intersection': {
    dir: 'at-least',
    target: DEFAULT_VALIDITY_THRESHOLDS.selfIntersectionMinM,
    scale: 0.05,
    weight: 2,
  },
  // Biomech hook (gaitBiomechCheck). These grade a WITHIN-BAND FRACTION, which is
  // a count over 21 curve points and therefore its own step function — they are
  // included at low weight so they steer without dominating, and the RMS behind
  // them is the number a future revision should grade instead.
  'normative-kneeFlexion': { dir: 'higher-is-better', scale: 0.5, weight: 1 },
  'normative-hipFlexion': { dir: 'higher-is-better', scale: 0.5, weight: 1 },
  'normative-ankleFlexion': { dir: 'higher-is-better', scale: 0.5, weight: 1 },
  // TWO-SIDED. Pelvis rise-and-fall, cm. The gate tolerates 2–9 (glide and bounce
  // both stay shippable); normal free WALKING is 4–5 [Winter; Orendurff 2004], and
  // that narrower band is what a search should be pulled toward from either side.
  // scale 1 cm ⇒ a centimetre off-norm costs one unit of margin.
  // No run entry: the engine's cited running figure (~7–9 cm, runParity.test.ts) is
  // the GROUNDED stance arc, not whole-motion excursion, which also includes the
  // flight parabola. Those are different quantities and the second is not sourced
  // here, so the run is left ungraded on this check rather than measured against a
  // number chosen to look reasonable.
  'vertical-com': {
    dir: 'band',
    bands: { walk: VERTICAL_COM_CM, run: null },
    scale: 1,
    weight: 0.5,
  },
  // TWO-SIDED. The gate only asks "is this secretly a run?" (fr < 0.5), but a walk
  // can be wrong in the other direction too — below ~0.15 is a shuffle, not a gait.
  // Walk band is classifyFroude's own comfortable range (target ≈ 0.25); run band is
  // RUN_PATTERN_BANDS.run, so a correct run is not charged for being one.
  froude: {
    dir: 'band',
    bands: { walk: [0.15, 0.35], run: RUN_PATTERN_BANDS.run.froude },
    scale: 0.1,
    weight: 0.5,
  },
};

/** One check's contribution, for auditing why a candidate scored as it did. */
export interface ObjectiveTerm {
  id: string;
  measured: number;
  /** The check's own threshold, or NaN for a band term — a band is not graded
   *  against it (see {@link Direction}) and reporting it would misdescribe the
   *  number that entered the sum. */
  threshold: number;
  /** Present only for band terms: the physiologic range being steered toward. */
  band?: readonly [number, number];
  /** Signed, normalized: positive = safer. 0 is the ceiling for a band term. */
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

/**
 * Signed, normalized margin — positive always means safer.
 *
 * A band term measures the distance OUTSIDE its target range, so it is 0 anywhere
 * inside and falls away linearly on both sides. Flat-inside is the correct shape
 * here, not a loss of gradient: 4.2 cm and 4.8 cm of CoM excursion are both simply
 * normal, and inventing a preference between them would be the objective asserting
 * a clinical opinion the literature does not support.
 */
const margin = (c: ValidityCheck, spec: TermSpec, band: readonly [number, number] | null): number => {
  const scale = spec.scale === 0 ? 1 : spec.scale;
  const raw =
    spec.dir === 'band'
      ? -Math.max(0, band![0] - c.measured, c.measured - band![1])
      : spec.dir === 'lower-is-better'
        ? c.threshold - c.measured
        : spec.dir === 'at-least'
          ? Math.min(0, c.measured - spec.target)
          : c.measured - c.threshold;
  const m = raw / scale;
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
export function motionObjective(
  report: ValidityReport,
  opts: { regime?: MotionRegime } = {},
): MotionObjective {
  // Defaulting to 'walk' matches the gate's own default posture and every motion
  // graded before regimes existed. A caller tuning a run MUST say so; see
  // {@link MotionRegime} for what silently accepting the default costs.
  const regime = opts.regime ?? 'walk';
  const terms: ObjectiveTerm[] = [];
  const ungraded: string[] = [];
  for (const c of report.checks) {
    const t = CHECK_TERMS[c.id];
    if (!t) {
      ungraded.push(c.id);
      continue;
    }
    const band = t.dir === 'band' ? t.bands[regime] : null;
    if (t.dir === 'band' && !band) {
      // Graded in some regimes, not this one. Reported rather than dropped, so a
      // caller can see the objective is blind here instead of reading a confident
      // total that quietly omits a check.
      ungraded.push(c.id);
      continue;
    }
    const m = margin(c, t, band);
    terms.push({
      id: c.id,
      measured: c.measured,
      // A band term is not graded against the check's threshold, so reporting that
      // field would make the breakdown table lie about what the reward measured.
      threshold: t.dir === 'band' ? NaN : t.dir === 'at-least' ? t.target : c.threshold,
      ...(band ? { band } : {}),
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
