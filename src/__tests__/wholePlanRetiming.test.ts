/**
 * WHOLE-PLAN RE-TIMING gate (AI-TIME-01, pipeline-diagnostics R3).
 *
 * The velocity governor used to floor each violating keyframe INDIVIDUALLY, so
 * a uniformly-too-fast plan (an AI's "quick" gait cycle) had its phases
 * stretched by DIFFERENT ratios — the Perry-style phase PROPORTIONS
 * (168/160/236/236 ms per half-cycle) flattened toward a uniform metronome and
 * the gait lost its rhythm. Now, when a STRICT MAJORITY of keyframes violate
 * their floors, the whole plan is re-timed by the single worst stretch ratio:
 * uniform dilation preserves the phase proportions, every re-timed keyframe is
 * flagged `timingAdjusted` (honesty), and the ms-authored artifacts
 * (`contacts`, `gaitStanceWindowsMs`, `headingProfileMs`) ride the SAME ratio
 * so they stay on their phases in the resolved clock — which keeps the shared
 * authored→trajectory totals mapping (`authoredToTrajectoryTimeScale`)
 * coherent by construction, pace included.
 *
 * Isolated violations (a minority) keep the LOCAL floor exactly as before —
 * dilating a slow plan wholesale to fix one rushed keyframe would needlessly
 * slow everything — and deterministic templates authored within their velocity
 * budgets resolve byte-identically.
 */
import { describe, expect, it } from 'vitest';
import {
  authoredToTrajectoryTimeScale,
  scaleStanceWindowsMs,
} from '../services/motionRecording';
import {
  MIN_KEYFRAME_MS,
  resolveComposedMotion,
  type ComposedMotion,
  type SequenceKeyframe,
} from '../services/motionSequence';
import {
  MOVEMENT_TEMPLATES,
  buildJump,
  buildRun,
  buildTravelWalk,
  templateToComposedMotion,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;

// ── A fast gait-SHAPED plan: half the Perry-timed walk's phase durations ─────
// (168/160/236/236 → 84/80/118/118 per half-cycle), 8 phases, looping, planted,
// with per-half-cycle stance windows + plant contacts authored on the SAME
// authored clock. Joint deltas are kept ≤ 20° so every velocity floor sits at
// MIN_KEYFRAME_MS (150) — i.e. ALL 8 phases violate, each by a DIFFERENT ratio
// (150/84 ≈ 1.79 … 150/118 ≈ 1.27): exactly the proportion-flattening setup.
// The authored wrist target opts the plan out of the relaxedHands background
// adds so the floors stay analytic (the same trick as motionSequence.test.ts).
const FAST_HALF = [84, 80, 118, 118] as const;
const FAST_DURATIONS = [...FAST_HALF, ...FAST_HALF];
const FAST_HALF_MS = FAST_HALF.reduce((a, b) => a + b, 0); // 400
const FAST_CYCLE_MS = FAST_HALF_MS * 2; // 800

function fastGaitPlan(): ComposedMotion {
  const leg = (side: 'L' | 'R', hip: number, knee: number) => [
    { joint: `${side}_UpLeg`, motion: 'hipFlexion', targetDegrees: hip },
    { joint: `${side}_Leg`, motion: 'kneeFlexion', targetDegrees: knee },
  ];
  // One half-cycle of a marching gait shape (R stance), mirrored for L stance.
  const half = (st: 'L' | 'R', sw: 'L' | 'R'): SequenceKeyframe[] => [
    { durationMs: FAST_HALF[0], targets: [...leg(st, 15, 5), ...leg(sw, -10, 20)] },
    { durationMs: FAST_HALF[1], targets: [...leg(st, 12, 12), ...leg(sw, 2, 30)] },
    { durationMs: FAST_HALF[2], targets: [...leg(st, 2, 5), ...leg(sw, 10, 25)] },
    { durationMs: FAST_HALF[3], targets: [...leg(st, -10, 3), ...leg(sw, 15, 5)] },
  ];
  const keyframes = [...half('R', 'L'), ...half('L', 'R')];
  keyframes[0]!.targets!.push({ joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 5 });
  return {
    name: 'fast 8-phase gait plan',
    loop: true,
    stance: 'planted',
    keyframes,
    contacts: [
      { foot: 'R_Foot', fromMs: 0, toMs: FAST_HALF_MS },
      { foot: 'L_Foot', fromMs: FAST_HALF_MS, toMs: FAST_CYCLE_MS },
    ],
    gaitStanceWindowsMs: [
      { foot: 'R_Foot', fromMs: 0, toMs: FAST_HALF_MS },
      { foot: 'L_Foot', fromMs: FAST_HALF_MS, toMs: FAST_CYCLE_MS },
    ],
  };
}

/** Phase fractions of a duration list (each duration / the total). */
const fractions = (ds: number[]): number[] => {
  const total = ds.reduce((a, b) => a + b, 0);
  return ds.map((d) => d / total);
};

/** Worst RELATIVE deviation between two fraction lists. */
const maxRelDev = (a: number[], b: number[]): number =>
  Math.max(...a.map((f, i) => Math.abs(b[i]! - f) / f));

describe('whole-plan re-timing preserves gait phase proportions (AI-TIME-01)', () => {
  it('a uniformly-too-fast 8-phase gait keeps its Perry proportions within 2%', () => {
    const r = resolveComposedMotion(fastGaitPlan(), variantCfg);
    expect(r.status).toBe('ok');
    const resolvedDur = r.keyframes.map((k) => k.durationMs);

    // Honesty: every keyframe was re-timed and says so.
    expect(r.keyframes.every((k) => k.timingAdjusted === true)).toBe(true);
    // Every duration cleared its floor (none may play faster than MIN here).
    for (const d of resolvedDur) expect(d).toBeGreaterThanOrEqual(MIN_KEYFRAME_MS);

    // THE gate: uniform dilation — resolved phase fractions match the authored
    // fractions within 2% (relative), so the rhythm survives.
    expect(maxRelDev(fractions(FAST_DURATIONS), fractions(resolvedDur))).toBeLessThan(0.02);
    // The rhythm is still a rhythm: the long/short phase ratio is preserved
    // (authored 118/80 = 1.475), not compressed toward 1.
    expect(Math.max(...resolvedDur) / Math.min(...resolvedDur)).toBeCloseTo(118 / 80, 1);

    // COUNTERFACTUAL — what the old PER-KEYFRAME flooring produced: every
    // phase raised to its own floor (here all floors are exactly
    // MIN_KEYFRAME_MS), i.e. a flat 150 ms metronome. That flattening is a
    // >15% relative proportion error — the rhythm the whole-plan re-time
    // exists to save.
    const flattened = FAST_DURATIONS.map((d) => Math.max(d, MIN_KEYFRAME_MS));
    expect(new Set(flattened).size, 'per-keyframe flooring flattens to a metronome').toBe(1);
    expect(maxRelDev(fractions(FAST_DURATIONS), fractions(flattened))).toBeGreaterThan(0.15);
    expect(resolvedDur, 'the resolver no longer produces the flattened timing').not.toEqual(
      flattened,
    );
  });

  it('re-times the ms-authored stance windows/contacts by the SAME ratio — they stay on their phases, pace included', () => {
    const r = resolveComposedMotion(fastGaitPlan(), variantCfg);
    expect(r.status).toBe('ok');
    const resolvedDur = r.keyframes.map((k) => k.durationMs);
    const halfBoundary = resolvedDur.slice(0, 4).reduce((a, b) => a + b, 0);
    const cycleEnd = resolvedDur.reduce((a, b) => a + b, 0);

    // The windows were dilated with the keyframes, so the R→L stance handoff
    // still sits ON the half-cycle keyframe boundary (± the ≤1 ms/keyframe
    // integer-ceil rounding) and the schedule still spans the full cycle.
    const w = r.gaitStanceWindowsMs!;
    expect(w).toHaveLength(2);
    expect(w[0]!.fromMs).toBe(0);
    expect(Math.abs(w[0]!.toMs - halfBoundary)).toBeLessThanOrEqual(4);
    expect(Math.abs(w[1]!.fromMs - halfBoundary)).toBeLessThanOrEqual(4);
    expect(Math.abs(w[1]!.toMs - cycleEnd)).toBeLessThanOrEqual(8);
    // The plant contacts share the same re-timed boundaries.
    const c = r.contacts!;
    expect(Math.abs(c[0]!.toMs! - w[0]!.toMs)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(c[1]!.fromMs! - w[1]!.fromMs)).toBeLessThanOrEqual(0.001);

    // TIME-BASE COHERENCE (the R1 shared helper): windows are now in the
    // RESOLVED keyframe clock, so the totals-derived authored→trajectory
    // factor maps them onto trajectory time exactly — identity at pace 1…
    expect(authoredToTrajectoryTimeScale({ keyframes: r.keyframes, loop: true }, cycleEnd)).toBe(1);
    // …and at a pace ≠ 1 (trajectory total = resolved total / timeScale) the
    // scaled windows still land on the scaled phase boundaries.
    const ts = 1.25;
    const trajTotal = cycleEnd / ts;
    const scale = authoredToTrajectoryTimeScale({ keyframes: r.keyframes, loop: true }, trajTotal);
    const scaled = scaleStanceWindowsMs(w, scale)!;
    expect(Math.abs(scaled[0]!.toMs - halfBoundary * scale)).toBeLessThanOrEqual(4);
    expect(Math.abs(scaled[1]!.toMs - cycleEnd * scale)).toBeLessThanOrEqual(8);
  });

  it('an isolated violation keeps the LOCAL floor — the rest of a slow plan is untouched', () => {
    // 1 of 3 keyframes violates (10 ms request): no majority → no dilation.
    const knee = (deg: number, durationMs: number): SequenceKeyframe => ({
      durationMs,
      targets: [
        { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: deg },
        // Author BOTH wrists so the per-side relaxedHands gate (DET-GATE-01)
        // adds no resting curl to EITHER hand — keeping these analytic MIN-floor
        // probes free of the 40° pinky-curl floor bump on the free side.
        { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 5 },
        { joint: 'L_Hand', motion: 'wristFlexion', targetDegrees: 5 },
      ],
    });
    const r = resolveComposedMotion(
      { keyframes: [knee(20, 600), knee(25, 10), knee(30, 800)] },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.keyframes.map((k) => k.durationMs)).toEqual([600, MIN_KEYFRAME_MS, 800]);
    expect(r.keyframes.map((k) => k.timingAdjusted ?? false)).toEqual([false, true, false]);
  });

  it('EXACTLY half violating is not a majority — local floors still rule', () => {
    const knee = (deg: number, durationMs: number): SequenceKeyframe => ({
      durationMs,
      targets: [
        { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: deg },
        // Author BOTH wrists so the per-side relaxedHands gate (DET-GATE-01)
        // adds no resting curl to EITHER hand — keeping these analytic MIN-floor
        // probes free of the 40° pinky-curl floor bump on the free side.
        { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 5 },
        { joint: 'L_Hand', motion: 'wristFlexion', targetDegrees: 5 },
      ],
    });
    const r = resolveComposedMotion(
      { keyframes: [knee(10, 60), knee(15, 60), knee(20, 500), knee(25, 500)] },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.keyframes.map((k) => k.durationMs)).toEqual([
      MIN_KEYFRAME_MS,
      MIN_KEYFRAME_MS,
      500,
      500,
    ]);
    expect(r.keyframes.map((k) => k.timingAdjusted ?? false)).toEqual([true, true, false, false]);
  });

  it('a strict majority triggers the whole-plan dilation even without gait plumbing, holds included', () => {
    // 3 of 4 violate (60 ms vs the 150 ms MIN floor) → the whole plan dilates
    // by 150/60 = 2.5: the slow keyframe stretches too (proportions, not
    // patches), and its hold rides the same single clock.
    const knee = (deg: number, durationMs: number, holdMs?: number): SequenceKeyframe => ({
      durationMs,
      ...(holdMs != null ? { holdMs } : {}),
      targets: [
        { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: deg },
        // Author BOTH wrists so the per-side relaxedHands gate (DET-GATE-01)
        // adds no resting curl to EITHER hand — keeping these analytic MIN-floor
        // probes free of the 40° pinky-curl floor bump on the free side.
        { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 5 },
        { joint: 'L_Hand', motion: 'wristFlexion', targetDegrees: 5 },
      ],
    });
    const r = resolveComposedMotion(
      { keyframes: [knee(10, 60), knee(15, 60), knee(20, 60), knee(25, 500, 100)] },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.keyframes.map((k) => k.durationMs)).toEqual([150, 150, 150, 1250]);
    expect(r.keyframes[3]!.holdMs).toBe(250); // 100 × 2.5 — one uniform clock
    expect(r.keyframes.every((k) => k.timingAdjusted === true)).toBe(true);
  });

  it('deterministic templates authored within their velocity budgets resolve byte-identically', () => {
    // The Perry-timed walk registry template: authored cadence untouched.
    const walk = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);
    const rw = resolveComposedMotion(walk, variantCfg);
    expect(rw.status).toBe('ok');
    expect(rw.keyframes.map((k) => k.durationMs)).toEqual(walk.keyframes.map((k) => k.durationMs));
    expect(rw.keyframes.some((k) => k.timingAdjusted)).toBe(false);

    // The travelling walk builder: durations, stance schedule AND contacts all
    // pass through exactly as authored (no silent re-time of the gait clock).
    const tw = buildTravelWalk();
    const rt = resolveComposedMotion(tw, variantCfg);
    expect(rt.status).toBe('ok');
    expect(rt.keyframes.map((k) => k.durationMs)).toEqual(tw.keyframes.map((k) => k.durationMs));
    expect(rt.keyframes.map((k) => k.holdMs)).toEqual(tw.keyframes.map((k) => k.holdMs ?? 0));
    expect(rt.keyframes.some((k) => k.timingAdjusted)).toBe(false);
    expect(rt.gaitStanceWindowsMs).toEqual(tw.gaitStanceWindowsMs);
    expect(rt.contacts).toEqual(tw.contacts);

    // The run authors its durations pre-floored at MIN_KEYFRAME_MS by design
    // ("the resolver never re-times a keyframe" — runStepTiming), so it too is
    // byte-identical.
    const run = buildRun();
    const rr = resolveComposedMotion(run, variantCfg);
    expect(rr.status).toBe('ok');
    expect(rr.keyframes.map((k) => k.durationMs)).toEqual(run.keyframes.map((k) => k.durationMs));
    expect(rr.keyframes.some((k) => k.timingAdjusted)).toBe(false);
  });

  it('the jump keeps its ISOLATED local floor exactly as before (no whole-plan dilation of a 1-of-7 violation)', () => {
    // buildJump's ballistic touchdown (flight × 0.2 ≈ 114 ms at the default
    // height) sits under the 150 ms MIN floor BY AUTHORSHIP — the one keyframe
    // the governor has always bumped locally. A single violator is a minority,
    // so the majority gate must leave the rest of the plan untouched.
    const jump = buildJump();
    const r = resolveComposedMotion(jump, variantCfg);
    expect(r.status).toBe('ok');
    const authored = jump.keyframes.map((k) => k.durationMs);
    const resolved = r.keyframes.map((k) => k.durationMs);
    for (let i = 0; i < authored.length; i += 1) {
      expect(resolved[i]).toBe(Math.max(authored[i]!, MIN_KEYFRAME_MS));
    }
    // Only the under-floor keyframes were touched (and flagged) — everything
    // else is byte-identical.
    expect(
      r.keyframes.map((k) => k.timingAdjusted ?? false),
    ).toEqual(authored.map((d) => d < MIN_KEYFRAME_MS));
  });
});
