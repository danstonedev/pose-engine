/**
 * NORMATIVE RUNNING GROUND-TRUTH — the running sibling of `normativeGait`, and
 * the reference `runSpatiotemporal.test.ts` grades the engine's run against.
 * PURE data + math: no rig, no three.js, no `Date.now`/`Math.random`.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * The run shipped for a long time with run.test.ts, runParity.test.ts and
 * floorMargin.test.ts all green while travelling at 0.59 m/s — slower than the
 * engine's own walk (1.35 m/s) and a factor of ~7 below the Froude number at
 * which humans stop walking. Every one of those gates checked a STRUCTURAL
 * property (does it have a flight phase, does the foot stay put, does it
 * absorb); none compared a measured running variable to a normative band, so
 * nothing could see it. Bands live here, as engine data, for the same reason
 * normativeGait's do: a test file is the wrong place to keep ground truth.
 *
 * ── DUTY FACTOR HAS TWO CONVENTIONS AND A NUMBER WITHOUT ITS CONVENTION IS NOT
 *    A NUMBER ────────────────────────────────────────────────────────────────
 * Everything here uses Alexander & Jayes' DF = ground-contact time / STRIDE
 * time (a stride = two steps). The GCT/step-time convention silently doubles
 * it; GCT/(GCT+flight) turns an elite sprinter's 0.22 into 0.44. DF < 0.5 is
 * the DEFINITION of running: it is exactly the statement that there is no
 * double support, i.e. an aerial phase exists.
 *
 * ── WHAT IS PHYSICS AND WHAT IS CONVENTION ───────────────────────────────────
 * Only ONE boundary here is physically discrete: the walk↔run transition, which
 * occurs at a dimensionless speed (Froude ≈ 0.5) because it is the point where
 * an inverted-pendulum vault can no longer be completed under gravity. The
 * jog|run and run|sprint boundaries are NOT discrete — gait varies continuously
 * with speed above the transition. They are declared conventions, chosen here
 * so the three patterns are distinguishable and defensible, and they are
 * labelled as such rather than dressed up as findings.
 *
 * ── SCALING ──────────────────────────────────────────────────────────────────
 * Literature values are for a ~0.90 m leg. The rig's is ~1.056 m, so absolute
 * speeds do NOT transfer — under dynamic similarity, speed ∝ √L, cadence ∝
 * 1/√L, step ∝ L. Froude is dimensionless and transfers directly, which is why
 * the gates below are written in Froude and duty factor wherever possible.
 * `scaleSpeedToLeg` does the transfer explicitly rather than leaving it implied.
 *
 * ── SOURCE & HONESTY ─────────────────────────────────────────────────────────
 * Representative bands compiled from Novacheck ("The biomechanics of running"),
 * Alexander & Jayes (dynamic similarity / duty factor), Cavanagh & Kram, and
 * Weyand et al. (sprint ground-contact / limb-repositioning). These are
 * REPRESENTATIVE bands, not a measured cohort, and no kinetic (GRF, moment,
 * metabolic) claim is made or implied.
 */

import { froudeNumber, FROUDE_WALK_RUN_TRANSITION_BAND } from './normativeGait';

/** Leg length (m) the literature bands below are quoted for. */
export const NORMATIVE_RUN_REF_LEG_M = 0.9;

/** Dynamic similarity: an absolute speed quoted for `NORMATIVE_RUN_REF_LEG_M`
 *  transferred to a leg of `legM`. Speed ∝ √L (equal Froude). */
export function scaleSpeedToLeg(speedMps: number, legM: number): number {
  return speedMps * Math.sqrt(legM / NORMATIVE_RUN_REF_LEG_M);
}

/** Dynamic similarity: a cadence quoted for `NORMATIVE_RUN_REF_LEG_M`
 *  transferred to a leg of `legM`. Cadence ∝ 1/√L. */
export function scaleCadenceToLeg(cadenceSpm: number, legM: number): number {
  return cadenceSpm * Math.sqrt(NORMATIVE_RUN_REF_LEG_M / legM);
}

/**
 * The dimensionless-speed floor for running: below this a walk's inverted-pendulum
 * vault is completable and humans walk.
 *
 * This is the LOWER edge of {@link FROUDE_WALK_RUN_TRANSITION_BAND}, imported
 * rather than re-declared — the band is normativeGait's single declaration of the
 * transition and the literature's ~0.45-0.50 spread lives there. Taking the lower
 * edge here is deliberate: {@link isRunning} is CONJUNCTIVE (no double support,
 * duty factor, flight phase, and this floor), so its job is only to exclude what
 * is unambiguously not running; the conservative upper edge belongs to the
 * REPORTING path (normativeGait's classifyFroude), which should not call a motion
 * a run until it has cleared the whole band.
 */
export const FROUDE_RUN_FLOOR = FROUDE_WALK_RUN_TRANSITION_BAND[0];

/** Duty factor at or above this is not running — it means both feet are on the
 *  ground at once somewhere in the cycle. Definitional, not stylistic. */
export const DUTY_FACTOR_RUN_CEILING = 0.5;

/** One running pattern's normative band. Speeds are quoted at
 *  `NORMATIVE_RUN_REF_LEG_M` — run them through {@link scaleSpeedToLeg}. */
export interface RunPatternBand {
  /** Duty factor (GCT / stride time — see the module note). */
  dutyFactor: readonly [number, number];
  /** Cadence, steps/min, at the reference leg length. */
  cadenceSpm: readonly [number, number];
  /** Ground contact time, ms. */
  gctMs: readonly [number, number];
  /** Froude number — dimensionless, transfers to any leg length directly. */
  froude: readonly [number, number];
  /** What the pattern IS, in one line. */
  note: string;
}

/**
 * The three patterns, ordered. JOG|RUN and RUN|SPRINT are DECLARED CONVENTIONS
 * (see the module note) — the bands are chosen to be adjacent and
 * non-overlapping in duty factor, which is the variable that separates them
 * most cleanly, and deliberately overlapping in Froude, which is continuous.
 */
export const RUN_PATTERN_BANDS: Readonly<Record<'jog' | 'run' | 'sprint', RunPatternBand>> = {
  jog: {
    dutyFactor: [0.36, 0.46],
    cadenceSpm: [130, 160],
    gctMs: [280, 400],
    froude: [0.45, 0.95],
    note: 'Long ground contact, small aerial phase, near the walk-run transition.',
  },
  run: {
    dutyFactor: [0.27, 0.38],
    cadenceSpm: [150, 185],
    gctMs: [190, 290],
    froude: [0.8, 2.0],
    note: 'The distance-running middle: contact and flight comparable, upright trunk.',
  },
  sprint: {
    dutyFactor: [0.16, 0.28],
    cadenceSpm: [200, 270],
    gctMs: [85, 150],
    froude: [3.0, 8.0],
    note: 'Ground contact collapses, flight dominates, large forward lean and knee lift.',
  },
};

/** A measured run, in the variables the bands are written in. */
export interface RunSpatiotemporalMeasured {
  legM: number;
  cadenceSpm: number;
  gctMs: number;
  dutyFactor: number;
  speedMps: number;
  froude: number;
  /** Fraction of the steady window with NEITHER foot down. */
  flightFraction: number;
  /** Milliseconds of the steady window with BOTH feet down. Running: 0. */
  doubleSupportMs: number;
}

/** Is this measurement running AT ALL — as opposed to a fast walk? The two
 *  definitional tests (no double support / DF < 0.5) plus the dimensionless
 *  speed floor. Deliberately independent of which PATTERN it is. */
export function isRunning(m: RunSpatiotemporalMeasured): boolean {
  return (
    m.doubleSupportMs <= 0 &&
    m.dutyFactor < DUTY_FACTOR_RUN_CEILING &&
    m.flightFraction > 0 &&
    m.froude >= FROUDE_RUN_FLOOR
  );
}

/** Which declared pattern a measurement's DUTY FACTOR places it in, or null if
 *  it falls between the declared bands. Duty factor is the discriminator
 *  because it is dimensionless and does not need leg-length scaling. */
export function classifyRunPattern(dutyFactor: number): 'jog' | 'run' | 'sprint' | null {
  for (const [name, band] of Object.entries(RUN_PATTERN_BANDS) as [
    'jog' | 'run' | 'sprint',
    RunPatternBand,
  ][])
    if (dutyFactor >= band.dutyFactor[0] && dutyFactor <= band.dutyFactor[1]) return name;
  return null;
}

/** Froude of a measurement (re-exported convenience so callers don't need to
 *  reach into normativeGait for the running case). */
export function runFroude(speedMps: number, legM: number): number {
  return froudeNumber(speedMps, legM);
}
