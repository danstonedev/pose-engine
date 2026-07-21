/**
 * RESOLVE-TIME GAIT PLUMBING (services/gaitEnrichment — AI-PLUMB-01/02/03,
 * AI-SEAM-01), pure layer.
 *
 * 1. `looksLikeGaitPlan` — the conservative STRUCTURAL predicate: an 8-phase
 *    reciprocal walk reads true; squat / lunge / kick / single-leg-stand /
 *    sit-to-stand / 2-keyframe sketches / floating or lying plans read false
 *    (false positives are worse than false negatives).
 * 2. `planGaitEnrichment` via `resolveComposedMotion` — a gait-shaped,
 *    plumbing-free plan with net root travel converts onto the deterministic
 *    machinery (footDrivenTravel + calibrated vertical + shuttle + settleEnds
 *    + derived stance windows/contacts + entry/brake ramps), all reported on
 *    `notes`; a LOOPING travel plan resolves as one pass (AI-SEAM-01).
 * 3. BYTE-IDENTITY guards — deterministic builders (buildTravelWalk, the raw
 *    in-place walk template, the run) and every non-gait plan resolve exactly
 *    as before: proven by deep-equality against an enrichment-proof twin
 *    (`inheritHeading: true` counts as authored plumbing and leaves no other
 *    trace in resolution when no live root is threaded).
 *
 * The rig-measured acceptance gates (slide / vertical / shuttle / entry /
 * wrap) live in gaitEnrichmentRig.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeGaitPlan,
  deriveGaitStanceSchedule,
  GAIT_ENRICH_BRAKE_MS,
  GAIT_ENRICH_ENTRY_MS,
  GAIT_ENRICH_SHUTTLE_CM,
  GAIT_ENRICH_VERTICAL_CM,
  hasAuthoredGaitPlumbing,
  looksLikeGaitPlan,
} from '../services/gaitEnrichment';
import {
  resolveComposedMotion,
  type ComposedMotion,
  type SequenceKeyframe,
} from '../services/motionSequence';
import {
  buildTravelRun,
  buildTravelWalk,
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;

const t = (cmd: string, deg: number) => {
  const [joint, motion] = cmd.split('.') as [string, string];
  return { joint, motion, targetDegrees: deg };
};

/** The 8 walk phases exactly as the compose prompt's reference template
 *  presents them — what a faithful AI copy looks like (probe fixture F01/F03). */
function walkPhases(): SequenceKeyframe[] {
  const P = (durationMs: number, targets: ReturnType<typeof t>[]): SequenceKeyframe => ({
    durationMs,
    targets,
  });
  const side = (S: 'R' | 'L') => {
    const O = S === 'R' ? 'L' : 'R';
    return [
      P(168, [
        t(`${S}_UpLeg.hipFlexion`, 30), t(`${S}_Leg.kneeFlexion`, 5),
        t(`${O}_UpLeg.hipFlexion`, -10), t(`${O}_Leg.kneeFlexion`, 40),
        t(`${O}_UpperArm.shoulderFlexion`, 20), t(`${S}_UpperArm.shoulderFlexion`, -20),
      ]),
      P(160, [
        t(`${S}_UpLeg.hipFlexion`, 25), t(`${S}_Leg.kneeFlexion`, 18),
        t(`${O}_UpLeg.hipFlexion`, 5), t(`${O}_Leg.kneeFlexion`, 60),
        t(`${O}_UpperArm.shoulderFlexion`, 14), t(`${S}_UpperArm.shoulderFlexion`, -14),
      ]),
      P(236, [
        t(`${S}_UpLeg.hipFlexion`, 5), t(`${S}_Leg.kneeFlexion`, 8),
        t(`${O}_UpLeg.hipFlexion`, 20), t(`${O}_Leg.kneeFlexion`, 45),
        t(`${O}_UpperArm.shoulderFlexion`, 0), t(`${S}_UpperArm.shoulderFlexion`, 0),
      ]),
      P(236, [
        t(`${S}_UpLeg.hipFlexion`, -10), t(`${S}_Leg.kneeFlexion`, 5),
        t(`${O}_UpLeg.hipFlexion`, 30), t(`${O}_Leg.kneeFlexion`, 5),
        t(`${O}_UpperArm.shoulderFlexion`, -14), t(`${S}_UpperArm.shoulderFlexion`, 14),
      ]),
    ];
  };
  return [...side('R'), ...side('L')];
}

/** Probe fixture F03: one-shot 8-phase walk with authored per-keyframe root
 *  travel (the prompt-sanctioned way an AI walks forward). */
const aiTravelWalk = (): ComposedMotion => ({
  name: 'walk forward',
  stance: 'planted',
  keyframes: walkPhases().map((k, i) => ({
    ...k,
    root: { translateM: [0, 0, +(0.175 * (i + 1)).toFixed(3)] as [number, number, number] },
  })),
});

/** Probe fixture F04: the same plan with loop:true (net travel per cycle —
 *  the AI-SEAM-01 glide-snap wrap). */
const aiLoopTravelWalk = (): ComposedMotion => ({
  ...aiTravelWalk(),
  name: 'walk forward loop',
  loop: true,
});

/** Probe fixture F01: faithful in-place looping copy of the walk template. */
const aiInPlaceLoopWalk = (): ComposedMotion => ({
  name: 'walk',
  loop: true,
  keyframes: walkPhases().map((k) => ({ ...k, stance: 'planted' as const })),
});

// ── Non-gait plans that must NEVER trip the predicate or the enrichment ─────

const squatPlan = (): ComposedMotion => ({
  name: 'squat',
  stance: 'planted',
  keyframes: [
    { durationMs: 900, targets: [t('L_UpLeg.hipFlexion', 100), t('R_UpLeg.hipFlexion', 100), t('L_Leg.kneeFlexion', 110), t('R_Leg.kneeFlexion', 110)] },
    { durationMs: 500, holdMs: 300, targets: [t('L_UpLeg.hipFlexion', 100), t('R_UpLeg.hipFlexion', 100), t('L_Leg.kneeFlexion', 110), t('R_Leg.kneeFlexion', 110)] },
    { durationMs: 900, targets: [t('L_UpLeg.hipFlexion', 0), t('R_UpLeg.hipFlexion', 0), t('L_Leg.kneeFlexion', 0), t('R_Leg.kneeFlexion', 0)] },
    { durationMs: 400, targets: [t('L_UpLeg.hipFlexion', 0), t('R_UpLeg.hipFlexion', 0)] },
  ],
});

const lungePlan = (): ComposedMotion => ({
  name: 'lunge',
  stance: 'planted',
  keyframes: [
    { durationMs: 700, targets: [t('R_UpLeg.hipFlexion', 40), t('L_UpLeg.hipFlexion', -15), t('R_Leg.kneeFlexion', 60), t('L_Leg.kneeFlexion', 30)] },
    { durationMs: 600, holdMs: 400, targets: [t('R_UpLeg.hipFlexion', 45), t('L_UpLeg.hipFlexion', -18), t('R_Leg.kneeFlexion', 80), t('L_Leg.kneeFlexion', 45)] },
    { durationMs: 600, targets: [t('R_UpLeg.hipFlexion', 40), t('L_UpLeg.hipFlexion', -15), t('R_Leg.kneeFlexion', 60), t('L_Leg.kneeFlexion', 30)] },
    { durationMs: 700, targets: [t('R_UpLeg.hipFlexion', 0), t('L_UpLeg.hipFlexion', 0), t('R_Leg.kneeFlexion', 0), t('L_Leg.kneeFlexion', 0)] },
  ],
});

/** Repetitive kick: the kicking hip alternates flexion/extension, but the
 *  SUPPORT hip never leaves neutral — no reciprocal anti-phase. */
const kickPlan = (): ComposedMotion => ({
  name: 'kick',
  stance: 'planted',
  loop: true,
  keyframes: [
    { durationMs: 400, targets: [t('R_UpLeg.hipFlexion', -15), t('R_Leg.kneeFlexion', 45), t('L_UpLeg.hipFlexion', 0)] },
    { durationMs: 300, targets: [t('R_UpLeg.hipFlexion', 60), t('R_Leg.kneeFlexion', 10), t('L_UpLeg.hipFlexion', 0)] },
    { durationMs: 400, targets: [t('R_UpLeg.hipFlexion', 0), t('R_Leg.kneeFlexion', 5), t('L_UpLeg.hipFlexion', 0)] },
    { durationMs: 300, targets: [t('R_UpLeg.hipFlexion', -15), t('R_Leg.kneeFlexion', 45), t('L_UpLeg.hipFlexion', 0)] },
  ],
});

const singleLegStandPlan = (): ComposedMotion => ({
  name: 'single-leg stand',
  stance: 'planted',
  keyframes: [
    { durationMs: 600, targets: [t('L_UpLeg.hipFlexion', 45), t('L_Leg.kneeFlexion', 45), t('R_UpLeg.hipFlexion', 0)] },
    { durationMs: 500, holdMs: 2000, targets: [t('L_UpLeg.hipFlexion', 50), t('L_Leg.kneeFlexion', 50)] },
    { durationMs: 500, targets: [t('L_UpLeg.hipFlexion', 45), t('L_Leg.kneeFlexion', 45)] },
    { durationMs: 600, targets: [t('L_UpLeg.hipFlexion', 0), t('L_Leg.kneeFlexion', 0)] },
  ],
});

/** Sit-to-stand: hips/knees flex TOGETHER and a grounding posture appears. */
const sitToStandPlan = (): ComposedMotion => ({
  name: 'sit to stand',
  stance: 'planted',
  keyframes: [
    { durationMs: 900, groundingPosture: 'sitting', targets: [t('L_UpLeg.hipFlexion', 85), t('R_UpLeg.hipFlexion', 85), t('L_Leg.kneeFlexion', 90), t('R_Leg.kneeFlexion', 90)] },
    { durationMs: 500, groundingPosture: 'sitting', targets: [t('L_UpLeg.hipFlexion', 95), t('R_UpLeg.hipFlexion', 95)] },
    { durationMs: 800, targets: [t('L_UpLeg.hipFlexion', 40), t('R_UpLeg.hipFlexion', 40), t('L_Leg.kneeFlexion', 45), t('R_Leg.kneeFlexion', 45)] },
    { durationMs: 700, targets: [t('L_UpLeg.hipFlexion', 0), t('R_UpLeg.hipFlexion', 0), t('L_Leg.kneeFlexion', 0), t('R_Leg.kneeFlexion', 0)] },
  ],
});

/** BYTE-IDENTITY twin: `inheritHeading: true` counts as authored gait plumbing
 *  (enrichment never runs) and — with no live root threaded — leaves NO other
 *  trace in resolution. So `resolve(plan) === resolve(twin)` proves the plain
 *  plan was resolved without any enrichment either. */
function expectResolvesUntouched(plan: ComposedMotion): void {
  const plain = resolveComposedMotion(structuredClone(plan), variantCfg);
  const twin = resolveComposedMotion(
    { ...structuredClone(plan), inheritHeading: true },
    variantCfg,
  );
  expect(plain).toEqual(twin);
  expect(plain.notes).toBeUndefined();
}

describe('looksLikeGaitPlan — conservative structural gait detection', () => {
  it('reads the faithful AI 8-phase cycles as gait (in place, travelling, looping)', () => {
    expect(looksLikeGaitPlan(aiInPlaceLoopWalk())).toBe(true);
    expect(looksLikeGaitPlan(aiTravelWalk())).toBe(true);
    expect(looksLikeGaitPlan(aiLoopTravelWalk())).toBe(true);
  });

  it('reads a looping HALF cycle (4 keyframes, one alternation) as gait', () => {
    const half: ComposedMotion = {
      loop: true,
      stance: 'planted',
      keyframes: walkPhases().slice(0, 4),
    };
    expect(looksLikeGaitPlan(half)).toBe(true);
    // …but the same half cycle WITHOUT the loop is not enough evidence.
    expect(looksLikeGaitPlan({ ...half, loop: false })).toBe(false);
  });

  it('reads the deterministic in-place walk template as gait (the predicate is structural)', () => {
    const walk = MOVEMENT_TEMPLATES.find((m) => m.id === 'walk')!;
    expect(looksLikeGaitPlan(templateToComposedMotion(walk))).toBe(true);
  });

  it('never trips on squat / lunge / kick / single-leg-stand / sit-to-stand', () => {
    expect(looksLikeGaitPlan(squatPlan()), 'squat').toBe(false);
    expect(looksLikeGaitPlan(lungePlan()), 'lunge').toBe(false);
    expect(looksLikeGaitPlan(kickPlan()), 'kick').toBe(false);
    expect(looksLikeGaitPlan(singleLegStandPlan()), 'single-leg stand').toBe(false);
    expect(looksLikeGaitPlan(sitToStandPlan()), 'sit-to-stand').toBe(false);
  });

  it('never trips on a 2-keyframe walk sketch, a floating walk, or a lying plan', () => {
    const sketch: ComposedMotion = {
      loop: true,
      stance: 'planted',
      keyframes: [
        { durationMs: 400, targets: [t('L_UpLeg.hipFlexion', 30), t('R_UpLeg.hipFlexion', -10)] },
        { durationMs: 400, targets: [t('L_UpLeg.hipFlexion', -10), t('R_UpLeg.hipFlexion', 30)] },
      ],
    };
    expect(looksLikeGaitPlan(sketch), '2-keyframe sketch').toBe(false);
    const floating: ComposedMotion = { loop: true, keyframes: walkPhases() }; // forgot stance
    expect(looksLikeGaitPlan(floating), 'floating walk').toBe(false);
    const lying: ComposedMotion = {
      stance: 'planted',
      keyframes: walkPhases().map((k, i) => (i === 0 ? { ...k, posture: 'supine' as const } : k)),
    };
    expect(looksLikeGaitPlan(lying), 'supine plan').toBe(false);
  });

  it('analyzeGaitPlan derives the stance sides the deterministic schedule implies (L entry, R first half, L second half)', () => {
    const a = analyzeGaitPlan(aiTravelWalk());
    expect(a.isGait).toBe(true);
    expect(a.alternations).toBeGreaterThanOrEqual(2);
    expect(a.stanceByKf).toEqual(['L', 'R', 'R', 'R', 'L', 'L', 'L', 'L']);
    expect(a.netTravelM.z).toBeCloseTo(1.4, 5);
  });
});

describe('hasAuthoredGaitPlumbing — builder-grade plans are never touched', () => {
  it('is true for the gait builders and false for schema-shaped AI plans', () => {
    expect(hasAuthoredGaitPlumbing(buildTravelWalk())).toBe(true);
    expect(hasAuthoredGaitPlumbing(buildTravelRun())).toBe(true);
    expect(hasAuthoredGaitPlumbing(aiTravelWalk())).toBe(false);
    expect(hasAuthoredGaitPlumbing(aiInPlaceLoopWalk())).toBe(false);
  });

  it('pins the enrichment defaults to the deterministic walk’s authored values', () => {
    const walk = buildTravelWalk();
    expect(walk.verticalCalibrationCm).toBe(GAIT_ENRICH_VERTICAL_CM);
    expect(walk.lateralShuttleCm).toBe(GAIT_ENRICH_SHUTTLE_CM);
  });
});

describe('gait enrichment — a gait-shaped travel plan gets the deterministic plumbing', () => {
  it('converts authored root travel to footDrivenTravel with vertical + shuttle + settleEnds, reported on notes', () => {
    const resolved = resolveComposedMotion(aiTravelWalk(), variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.footDrivenTravel).toBe(true);
    expect(resolved.settleEnds).toBe(true);
    expect(resolved.verticalCalibrationCm).toBe(GAIT_ENRICH_VERTICAL_CM);
    expect(resolved.lateralShuttleCm).toBe(GAIT_ENRICH_SHUTTLE_CM);
    expect(resolved.loop).toBe(false);
    // The authored horizontal drift is gone from every keyframe root (travel is
    // re-derived from foot placement — one source of truth).
    for (const k of resolved.keyframes) {
      const xz = k.root?.translateM;
      if (xz) {
        expect(xz[0]).toBe(0);
        expect(xz[2]).toBe(0);
      }
    }
    // Honesty: every attachment is narrated.
    expect(resolved.notes?.some((n) => n.includes('footDrivenTravel'))).toBe(true);
    expect(resolved.notes?.some((n) => n.includes('calibrated vertical'))).toBe(true);
    expect(resolved.notes?.some((n) => n.includes('shuttle'))).toBe(true);
    expect(resolved.notes?.some((n) => n.includes('stance windows'))).toBe(true);
  });

  it('derives an alternating stance schedule + matching contacts covering the whole resolved span', () => {
    const resolved = resolveComposedMotion(aiTravelWalk(), variantCfg);
    const windows = resolved.gaitStanceWindowsMs!;
    expect(windows.map((w) => w.foot)).toEqual(['L_Foot', 'R_Foot', 'L_Foot']);
    expect(windows[0]!.fromMs).toBe(0);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]!.fromMs).toBe(windows[i - 1]!.toMs); // contiguous
    }
    const total = resolved.keyframes.reduce((s, k) => s + k.durationMs + (k.holdMs ?? 0), 0);
    expect(windows[windows.length - 1]!.toMs).toBe(total);
    // Contacts mirror the windows exactly — the pinned foot and the travel/
    // shuttle derivations follow ONE schedule.
    expect(resolved.contacts).toEqual(
      windows.map((w) => ({ foot: w.foot, fromMs: w.fromMs, toMs: w.toMs })),
    );
  });

  it('eases a mid-stride entry and brakes a mid-stride ending (the template’s initiation/termination timing class)', () => {
    const resolved = resolveComposedMotion(aiTravelWalk(), variantCfg);
    expect(resolved.keyframes[0]!.durationMs).toBe(GAIT_ENRICH_ENTRY_MS);
    expect(resolved.keyframes[resolved.keyframes.length - 1]!.durationMs).toBe(
      GAIT_ENRICH_BRAKE_MS,
    );
    expect(resolved.notes?.some((n) => n.includes('entry eased'))).toBe(true);
    expect(resolved.notes?.some((n) => n.includes('braked'))).toBe(true);
  });

  it('converts travel authored via the semantic sugar the same way (sugar dropped, foot-driven attached)', () => {
    const sugar: ComposedMotion = {
      name: 'walk forward (sugar)',
      stance: 'planted',
      keyframes: walkPhases().map((k, i) => ({
        ...k,
        travel: { direction: 'forward' as const, meters: +(0.175 * (i + 1)).toFixed(3) },
      })),
    };
    const resolved = resolveComposedMotion(sugar, variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.footDrivenTravel).toBe(true);
    for (const k of resolved.keyframes) expect(k.root?.translateM).toBeUndefined();
  });

  it('AI-SEAM-01: a LOOPING gait travel plan resolves as one traveled pass (no glide-snap wrap), with a note', () => {
    const resolved = resolveComposedMotion(aiLoopTravelWalk(), variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.loop).toBe(false);
    expect(resolved.footDrivenTravel).toBe(true);
    expect(resolved.notes?.some((n) => n.includes('loop-travel'))).toBe(true);
  });

  it('AI-SEAM-01: a NON-gait looping plan with net travel resolves non-looping, roots kept, nothing else attached', () => {
    const plan: ComposedMotion = {
      name: 'drifting arm loop',
      stance: 'planted',
      loop: true,
      keyframes: [0.3, 0.6, 0.9, 1.2].map((z, i) => ({
        durationMs: 500,
        targets: [t('R_UpperArm.shoulderFlexion', i % 2 === 0 ? 60 : 10)],
        root: { translateM: [0, 0, z] as [number, number, number] },
      })),
    };
    const resolved = resolveComposedMotion(plan, variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.loop).toBe(false);
    expect(resolved.notes?.some((n) => n.includes('loop-travel'))).toBe(true);
    // No gait machinery was invented for a non-gait plan…
    expect(resolved.footDrivenTravel).toBeUndefined();
    expect(resolved.verticalCalibrationCm).toBeUndefined();
    expect(resolved.lateralShuttleCm).toBeUndefined();
    expect(resolved.contacts).toBeUndefined();
    // …and the authored travel is kept (it plays once, honestly).
    expect(resolved.keyframes[3]!.root?.translateM).toEqual([0, 0, 1.2]);
  });

  it('an in-place gait loop resolves exactly like the raw in-place walk template does (no travel ⇒ no enrichment)', () => {
    expectResolvesUntouched(aiInPlaceLoopWalk());
  });

  it('never overrides an authored plumbing field — any authored gait machinery disables enrichment entirely', () => {
    const authored: ComposedMotion = { ...aiTravelWalk(), lateralShuttleCm: 4 };
    const resolved = resolveComposedMotion(structuredClone(authored), variantCfg);
    expect(resolved.notes).toBeUndefined();
    expect(resolved.lateralShuttleCm).toBe(4);
    expect(resolved.footDrivenTravel).toBeUndefined();
    expect(resolved.verticalCalibrationCm).toBeUndefined();
    // The authored roots are untouched.
    expect(resolved.keyframes[7]!.root?.translateM).toEqual([0, 0, 1.4]);
  });
});

describe('byte-identity — deterministic builders and non-gait plans resolve unchanged', () => {
  it('buildTravelWalk resolves with no notes and its own authored plumbing verbatim', () => {
    const m = buildTravelWalk();
    const resolved = resolveComposedMotion(structuredClone(m), variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.notes).toBeUndefined();
    expect(resolved.contacts).toEqual(m.contacts);
    expect(resolved.gaitStanceWindowsMs).toEqual(m.gaitStanceWindowsMs);
    expect(resolved.verticalCalibrationCm).toBe(m.verticalCalibrationCm);
    expect(resolved.lateralShuttleCm).toBe(m.lateralShuttleCm);
    // No entry/brake re-timing: the resolved durations are the authored ones.
    expect(resolved.keyframes.map((k) => k.durationMs)).toEqual(
      m.keyframes.map((k) => k.durationMs),
    );
  });

  it('the raw in-place walk template resolves byte-identical (no vertical, no contacts, no notes)', () => {
    const walk = MOVEMENT_TEMPLATES.find((x) => x.id === 'walk')!;
    const m = templateToComposedMotion(walk);
    expectResolvesUntouched(m);
    const resolved = resolveComposedMotion(structuredClone(m), variantCfg);
    expect(resolved.verticalCalibrationCm).toBeUndefined();
    expect(resolved.contacts).toBeUndefined();
    expect(resolved.gaitStanceWindowsMs).toBeUndefined();
    expect(resolved.footDrivenTravel).toBeUndefined();
    expect(resolved.loop).toBe(true);
    expect(resolved.keyframes.map((k) => k.durationMs)).toEqual(
      m.keyframes.map((k) => k.durationMs),
    );
  });

  it('the travelling run keeps its DELIBERATE absence of a calibrated vertical', () => {
    const resolved = resolveComposedMotion(buildTravelRun(), variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.notes).toBeUndefined();
    expect(resolved.verticalCalibrationCm).toBeUndefined();
  });

  it('squat / lunge / kick / single-leg-stand / sit-to-stand resolve byte-identical (deep-equal to the enrichment-proof twin)', () => {
    for (const plan of [squatPlan(), lungePlan(), kickPlan(), singleLegStandPlan(), sitToStandPlan()]) {
      expectResolvesUntouched(plan);
    }
  });

  it('a one-shot NON-gait plan with authored travel is untouched (authored travel is legitimate there)', () => {
    const twoSteps: ComposedMotion = {
      name: 'two steps',
      stance: 'planted',
      keyframes: [
        { durationMs: 600, targets: [t('R_UpLeg.hipFlexion', 30), t('R_Leg.kneeFlexion', 15)], travel: { direction: 'forward', meters: 0.4 } },
        { durationMs: 600, targets: [t('R_UpLeg.hipFlexion', 0), t('L_UpLeg.hipFlexion', 30), t('L_Leg.kneeFlexion', 15)], travel: { direction: 'forward', meters: 0.4 } },
        { durationMs: 600, targets: [t('L_UpLeg.hipFlexion', 0)] },
      ],
    };
    expectResolvesUntouched(twoSteps);
  });
});

describe('deriveGaitStanceSchedule — resolved-clock windows', () => {
  it('merges consecutive same-side spans and mirrors contacts exactly', () => {
    const schedule = deriveGaitStanceSchedule(
      [
        { durationMs: 100 },
        { durationMs: 200 },
        { durationMs: 200, holdMs: 50 },
        { durationMs: 300 },
      ],
      ['L', 'R', 'R', 'L'],
    )!;
    expect(schedule.gaitStanceWindowsMs).toEqual([
      { foot: 'L_Foot', fromMs: 0, toMs: 100 },
      { foot: 'R_Foot', fromMs: 100, toMs: 550 },
      { foot: 'L_Foot', fromMs: 550, toMs: 850 },
    ]);
    expect(schedule.contacts).toEqual(schedule.gaitStanceWindowsMs);
  });

  it('returns null on a keyframe-count mismatch (never guesses a schedule)', () => {
    expect(deriveGaitStanceSchedule([{ durationMs: 100 }], ['L', 'R'])).toBeNull();
    expect(deriveGaitStanceSchedule([], [])).toBeNull();
  });
});
