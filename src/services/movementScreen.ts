/**
 * THE MOVEMENT SCREEN — the FMS and SFMA patterns every DevPT app plays.
 *
 * Moved here from simMOVE (`src/screen/positions.ts`), with the two motion files
 * beside it (`assessmentBodyMotions.ts`, `assessmentUpperMotions.ts`), so that
 * simMOVE's Screen and simLAB play the same movements. simMOVE is still where
 * they are authored, physics-checked and signed off: its movement files and
 * their acceptance, its impairment cases and its scoring stay there. What lives
 * here is only what the patterns ARE — the motion behind each test, how an
 * ankle restriction reshapes a squat, the held assessed position, and the
 * {@link MOVEMENT_SCREEN} registry saying where each pattern is performed and
 * with which part of the screening kit.
 *
 * Every position resolves to one of these sources:
 *
 *   `template`  an authored clinician movement template already in the engine
 *               (`MOVEMENT_TEMPLATES`).
 *   `builder`   a posture/transfer factory (`buildSquat`, `buildSupineLegRaise`,
 *               …). Takes a side where the movement is one-sided.
 *   `authored`  an assessment-specific motion written as a few rows of joint
 *               targets (the two motion files).
 *   `pose`      a hand-authored `CustomPose` an app keeps for itself (simMOVE's
 *               `src/screen/poses/`). It is not resolved here.
 *
 * Anything with no source yet is `unposed`, and says so rather than showing the
 * mannequin standing still and letting a student think that IS the position. An
 * honest gap beats a silent wrong answer.
 *
 * WHAT A ROM CONSTRAINT DOES, and the distinction that matters. At RESOLVE time
 * a constraint only RESTRICTS: `resolveComposedMotion` clamps or drops targets
 * the case's available range cannot honour, and it does not redistribute that
 * range to the joints above. Compensation comes from the BUILDER instead —
 * `buildSquat` runs a calibrated solver that trades a blocked ankle for hip
 * hinge and spine flexion. So a constraint produces a visible compensation only
 * where a builder is given it, which today means the two squats and nothing else
 * (the authored SFMA squat borrows the same solver; see `withSquatCompensation`).
 * That is why `BUILDERS` takes the constraints rather than a hardcoded number.
 */
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  buildSquat,
  buildSupineLegRaise,
  buildPushUp,
  buildBirdDog,
  buildGetDownToQuadruped,
  buildLowerToProne,
} from './movementTemplates';
import { resolveComposedMotion, type ComposedMotion, type ResolvedComposedMotion } from './motionSequence';
import type { RomScenarioConstraints } from './romConstraints';
import { UPPER_ASSESSMENT_MOTIONS, UPPER_ASSESSMENT_NOTES } from './assessmentUpperMotions';
import { BODY_ASSESSMENT_MOTIONS, BODY_ASSESSMENT_NOTES } from './assessmentBodyMotions';

export { UPPER_ASSESSMENT_MOTIONS, UPPER_ASSESSMENT_NOTES } from './assessmentUpperMotions';
export { BODY_ASSESSMENT_MOTIONS, BODY_ASSESSMENT_NOTES } from './assessmentBodyMotions';

/** The side a one-sided pattern is performed on; what it names is the pattern's
 *  own ({@link MovementScreenPattern.side}). */
export type ScreenSide = 'L' | 'R';

export type PositionSource =
  | { kind: 'template'; templateId: string }
  | { kind: 'builder'; builderId: BuilderId }
  | { kind: 'authored'; motionId: AuthoredId }
  | { kind: 'pose'; poseId: string }
  | { kind: 'unposed'; note: string };

export type AuthoredId = 'cervical-flexion' | 'cervical-extension' | 'cervical-rotation' | 'shoulder-mobility' | 'shoulder-clearing' | 'ue-pattern1' | 'ue-pattern2' | 'hurdle-step' | 'in-line-lunge' | 'trunk-stability-push-up' | 'rotary-stability' | 'extension-clearing' | 'flexion-clearing' | 'multisegmental-flexion' | 'multisegmental-extension' | 'multisegmental-rotation' | 'single-leg-stance' | 'sfma-overhead-deep-squat-legacy';

export type BuilderId =
  | 'squat'
  | 'supine-leg-raise'
  | 'push-up'
  | 'bird-dog'
  | 'quadruped'
  | 'prone';

/**
 * The dorsiflexion cap the UNIMPAIRED squat demonstration uses.
 *
 * 32°, which is `buildSquat`'s own default and the top of its WEIGHT-BEARING
 * domain (`SQUAT_DF_CAP_MAX_DEG` is 35; `romRegistry` publishes
 * `weightBearingMax: 35` for ankle dorsiflexion). The 20° figure that belongs to
 * ankle DF is the seated OPEN-CHAIN AROM norm and is the wrong domain for a
 * squat: authored at 20 the compensation solver has already spent its entire
 * 20° hip budget before any impairment is applied, so a clean squat and a badly
 * restricted one come out identical. Measured, that is exactly what happened.
 */
export const SQUAT_CLEAN_DF_DEG = 32;

/**
 * The dorsiflexion the case actually leaves available, in `buildSquat`'s
 * weight-bearing domain. The tightest of the two ankles wins: a squat is
 * bilateral and the more restricted side is what forces the compensation.
 */
export function squatDorsiflexionCap(constraints: RomScenarioConstraints | null): number {
  const caps = (['R_Foot', 'L_Foot'] as const)
    .map((k) => constraints?.[k]?.ankleFlexion?.availableRange?.max)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return caps.length ? Math.min(SQUAT_CLEAN_DF_DEG, ...caps) : SQUAT_CLEAN_DF_DEG;
}

/**
 * Builders take the case, not just the side.
 *
 * THIS IS THE WHOLE IMPAIRMENT MECHANISM and it is easy to get wrong.
 * `buildSquat`'s docstring is explicit: "Pass the SAME number a scenario
 * constraint will clamp the ankle to, so the authored forward incline matches
 * the ankle that is actually realized." Its `squatCompensation` solver keys a
 * forward hip-hinge and bounded spine flexion off that cap.
 *
 * Give it a hardcoded cap and the constraint still clamps the ANKLE at resolve
 * time, so the motion looks restricted — but the hip and spine were authored
 * against the wrong ankle and never move. Measured, at a hardcoded 32: clean
 * hip 100 / lumbar 27 / thoracic 10, and an 8° case hip 120 / lumbar 60 /
 * thoracic 39.7. Wire it and the torso visibly folds; hardcode it and clean and
 * impaired come back byte-identical.
 */
const BUILDERS: Record<BuilderId, (side: ScreenSide, constraints: RomScenarioConstraints | null) => ComposedMotion> = {
  squat: (_side, constraints) =>
    buildSquat({ dorsiflexionCapDeg: squatDorsiflexionCap(constraints) }),
  'supine-leg-raise': (side) => buildSupineLegRaise({ side, reps: 1 }),
  'push-up': () => buildPushUp({ reps: 1 }),
  'bird-dog': (side) => buildBirdDog({ side, reps: 1 }),
  quadruped: () => buildGetDownToQuadruped(),
  prone: () => buildLowerToProne(),
};

/**
 * Authored squats that must carry the SAME dorsiflexion-keyed compensation.
 *
 * The SFMA overhead squat moved from `buildSquat` to its own feet-together,
 * no-dowel source. Authored sources take no constraints, so simMOVE's
 * `ods-ankle-block` case — which targets exactly this pattern — was left
 * clamping the ankle to 8° while hip and spine stayed where the clean squat put
 * them: clean and impaired resolved identically, the failure the BUILDERS note
 * above describes. The fix reuses `buildSquat`'s calibrated solver rather than
 * inventing gains: the increments it authors between the clean cap and the
 * case's cap are added to the authored squat, in proportion to each keyframe's
 * hip depth so the setup and the return stay clean.
 */
const SQUAT_COMPENSATED_AUTHORED: ReadonlySet<string> = new Set(['sfma-overhead-deep-squat-legacy']);

/** `buildSquat`'s verified hip-flexion ceiling. The authored squat already sits
 *  deeper than the builder's, so its share of the solver's hip increment is
 *  bounded here instead of being clamped silently at resolve time. */
const HIP_FLEXION_CEILING_DEG = 120;

function squatLean(dfCap: number): { hip: number; lumbar: number; thoracic: number } {
  const descent = buildSquat({ dorsiflexionCapDeg: dfCap }).keyframes[0]?.targets ?? [];
  const deg = (joint: string, motion: string) =>
    descent.find((t) => t.joint === joint && t.motion === motion)?.targetDegrees ?? 0;
  return { hip: deg('R_UpLeg', 'hipFlexion'), lumbar: deg('Spine_Lower', 'flexion'), thoracic: deg('Spine_Upper', 'flexion') };
}

function withSquatCompensation(motion: ComposedMotion, constraints: RomScenarioConstraints | null): ComposedMotion {
  const cap = squatDorsiflexionCap(constraints);
  if (cap >= SQUAT_CLEAN_DF_DEG) return motion;
  const clean = squatLean(SQUAT_CLEAN_DF_DEG), impaired = squatLean(cap);
  const hipOf = (kf: ComposedMotion['keyframes'][number]) =>
    Math.max(0, ...(kf.targets ?? []).filter((t) => t.motion === 'hipFlexion').map((t) => t.targetDegrees));
  const deepest = Math.max(0, ...motion.keyframes.map(hipOf));
  if (deepest <= 0) return motion;
  return {
    ...motion,
    keyframes: motion.keyframes.map((kf) => {
      const share = hipOf(kf) / deepest;
      if (!kf.targets || share <= 0) return kf;
      return {
        ...kf,
        targets: kf.targets.map((t) =>
          t.motion === 'hipFlexion'
            ? { ...t, targetDegrees: Math.min(HIP_FLEXION_CEILING_DEG, t.targetDegrees + share * (impaired.hip - clean.hip)) }
            : t.joint === 'Spine_Lower' && t.motion === 'flexion'
              ? { ...t, targetDegrees: t.targetDegrees + share * (impaired.lumbar - clean.lumbar) }
              : t.joint === 'Spine_Upper' && t.motion === 'flexion'
                ? { ...t, targetDegrees: t.targetDegrees + share * (impaired.thoracic - clean.thoracic) }
                : t,
        ),
      };
    }),
  };
}

/**
 * AUTHORED POSITIONS — a movement written as a few rows of clinical data.
 *
 * The engine's template library has no sagittal cervical movement, but `Neck` is
 * directly commandable: `romRegistry` publishes `Neck.flexion` spanning -60
 * (extension) to +50 (flexion), and a `SequenceTarget` naming it resolves and
 * ROM-clamps like any other. So "no template" was never the same as "cannot be
 * shown".
 *
 * This is the cheapest authoring path and should be the default for anything
 * the rig can already reach: it is a handful of joint/motion/degree rows,
 * readable and correctable by a clinician, rather than an opaque quaternion
 * capture.
 */
const AUTHORED: Record<string, (side:ScreenSide) => ComposedMotion> = {...UPPER_ASSESSMENT_MOTIONS,...BODY_ASSESSMENT_MOTIONS};
const ASSESSMENT_NOTES:Record<string,string[]> = {...UPPER_ASSESSMENT_NOTES,...BODY_ASSESSMENT_NOTES};
export function assessmentSourceNotes(source?:PositionSource): readonly string[] {
  return source?.kind==='authored' ? ASSESSMENT_NOTES[source.motionId] ?? [] : [];
}

/**
 * Humerothoracic elevation for a dowel pressed overhead, authored as ABDUCTION.
 *
 * 160°, which measures 176.3° of true elevation — 3.7° off vertical, hands
 * 0.440 m apart over a 0.401 m shoulder gap. Above ~163 the readout wraps past
 * 180 and the panel starts printing negative abduction, so this sits below that.
 */
const OVERHEAD_ABDUCTION_DEG = 160;

/**
 * Put the arms OVERHEAD, correctly, which took three attempts and two wrong
 * theories. Recorded here because every one of the wrong turns is a trap the
 * next authored position can fall into.
 *
 * WHY OVERRIDE AT ALL. `buildSquat` authors a 60° arm-forward reach as a
 * counterweight — right for a plain bodyweight squat, wrong for both squat
 * SCREENS, where the dowel is pressed overhead and losing that counterweight is
 * exactly what makes the test hard. Arm position is also the criterion the
 * student grades, so 60° demonstrates a different movement from the one we name.
 *
 * WRONG TURN 1 — write 170 onto the humerus in flexion. Measured on the rig:
 * `FLEX —`, `ABD 147`, arms in a wide V, hands 0.716 m apart. The cause is not
 * the shoulder model: `armSwingDelta` realizes flexion as a swing about WORLD_X,
 * which PRESERVES the arm's x component, and the rig's anatomic rest hangs the
 * humerus 16.4° lateral of vertical (rest worldDir x = -0.2824). Flexion can
 * never remove that splay, so it survives all the way to full elevation.
 *
 * WRONG TURN 2 — hand-author the scapular share alongside it. Two mistakes at
 * once. First it is unnecessary: the composed path ALREADY applies the rhythm
 * automatically, through the `girdle` hook on the shoulder specs and
 * `writeGirdle` inside `buildComposedCommandPose` — an authored flexion 170
 * writes scapularTilt 40 by itself. Second it is actively harmful: an authored
 * `R_Shoulder` target in the same keyframe as a humeral one CLOBBERS, and which
 * way depends on build order. Arm-last silently discards the scapula; scapula-
 * last leaves the humerus wrung by up to -142.9° of phantom axial rotation
 * because `unparentGirdle` corrected for a girdle value that was then replaced.
 * Every target still reports `complied`. NEVER author a scapula target on a limb
 * whose humerus this motion also commands.
 *
 * WHAT WORKS — abduction. It elevates toward vertical instead of preserving the
 * lateral offset. Measured at 160: 176.3° elevation, 3.7° off vertical, hands
 * 0.440 m apart, and upRotation 43.3° arriving automatically, which is the
 * correct scapular channel for overhead elevation and the one the panel shows
 * first. Flexion's girdle hook is hard-wired to scapularTilt and would never
 * produce it.
 *
 * The flexion target is REPLACED, not supplemented. Two shoulder fields in one
 * keyframe route through `composeShoulderDelta`, which cannot represent any arm
 * above horizontal at all — measured, flexion 170 + abduction 0 lands the arm
 * HANGING DOWN at -10° while both targets report `complied`.
 *
 * THE BALANCE COST, measured rather than feared. `squatCompensation`'s constants
 * were fitted against the 60° reach, so moving the arms was expected to wreck
 * the margin. Swept through this exact path against plain `buildSquat`, it does
 * not: df32 3.41 → 2.39 cm, df26 2.27 → 1.67, df20 2.85 → 2.44, df18 2.12 →
 * 1.90, df16 0.48 → 0.39, and BELOW the crossover it is marginally better
 * (df14 −1.18 → −1.16, df8 −6.22 → −6.06). The compensate-else-fall crossover
 * moves from df≈15.6 to df≈15.5 — inside the noise.
 *
 * That is a property of authoring the press as ABDUCTION. The earlier
 * flexion-based override did cost about 2.3 cm and pushed the crossover to
 * df≈18.3, which would have made the engine's own asserted-balanced case fall
 * over. `__tests__/movementScreen.test.ts` pins the current numbers so a future
 * re-authoring of the arms cannot quietly reintroduce that.
 */
function armsOverhead(motion: ComposedMotion): ComposedMotion {
  return {
    ...motion,
    keyframes: motion.keyframes.map((kf) => {
      if (!kf.targets) return kf;
      const elevating = kf.targets.some(
        (t) => t.motion === 'shoulderFlexion' && t.targetDegrees > 0,
      );
      if (!elevating) return kf;
      return {
        ...kf,
        targets: kf.targets.map((t) =>
          t.motion === 'shoulderFlexion'
            ? { joint: t.joint, motion: 'shoulderAbduction', targetDegrees: OVERHEAD_ABDUCTION_DEG }
            : t,
        ),
      };
    }),
  };
}

/**
 * FMS test id → editable position source. Squat and ASLR retain their existing
 * builders; the remaining tests and clearings have assessment-specific stages.
 * Mapping supplies authoring coverage, not verified contacts or assessment scores.
 */
export const FMS_POSITIONS: Record<string, PositionSource> = {
  'deep-squat': { kind: 'builder', builderId: 'squat' },
  'hurdle-step': { kind: 'authored', motionId: 'hurdle-step' },
  'in-line-lunge': { kind: 'authored', motionId: 'in-line-lunge' },
  'shoulder-mobility': { kind: 'authored', motionId: 'shoulder-mobility' },
  aslr: { kind: 'builder', builderId: 'supine-leg-raise' },
  'trunk-stability-push-up': { kind: 'authored', motionId: 'trunk-stability-push-up' },
  'rotary-stability': { kind: 'authored', motionId: 'rotary-stability' },
  'shoulder-clearing': { kind: 'authored', motionId: 'shoulder-clearing' },
  'extension-clearing': { kind: 'authored', motionId: 'extension-clearing' },
  'flexion-clearing': { kind: 'authored', motionId: 'flexion-clearing' },
};

/** SFMA top-tier `patternId` → position source. */
export const TOP_TIER_POSITIONS: Record<string, PositionSource> = {
  'cervical-flexion': { kind: 'authored', motionId: 'cervical-flexion' },
  'cervical-extension': { kind: 'authored', motionId: 'cervical-extension' },
  'cervical-rotation': { kind: 'authored', motionId: 'cervical-rotation' },
  'upper-extremity-pattern-one': { kind: 'authored', motionId: 'ue-pattern1' },
  'upper-extremity-pattern-two': { kind: 'authored', motionId: 'ue-pattern2' },
  'multisegmental-flexion': { kind: 'authored', motionId: 'multisegmental-flexion' },
  'multisegmental-extension': { kind: 'authored', motionId: 'multisegmental-extension' },
  'multisegmental-rotation': { kind: 'authored', motionId: 'multisegmental-rotation' },
  'single-leg-stance': { kind: 'authored', motionId: 'single-leg-stance' },
  'overhead-deep-squat': { kind: 'authored', motionId: 'sfma-overhead-deep-squat-legacy' },
};

/**
 * The 81 SFMA breakouts have no dedicated sources yet. Their active, passive,
 * stabilized and sensory conditions need separate procedure/contact definitions.
 * A second rendered actor is not required to model external assistance forces.
 * Do not reuse a top-tier source as evidence that a breakout is implemented.
 */
export const BREAKOUT_POSITIONS: Record<string, PositionSource> = {};

export function positionFor(testId: string): PositionSource {
  return (
    FMS_POSITIONS[testId] ??
    TOP_TIER_POSITIONS[testId] ??
    BREAKOUT_POSITIONS[testId] ?? {
      kind: 'unposed',
      note: 'No position authored for this test yet.',
    }
  );
}

/**
 * Whether this library can play a position. A `pose` source is the app's own
 * captured pose, which this library does not hold, so it answers false and the
 * app answers for its poses itself (simMOVE's `isPosed`).
 */
export const screenSourceAvailable = (src: PositionSource): boolean =>
  src.kind === 'authored' ? !!AUTHORED[src.motionId] : src.kind !== 'unposed' && src.kind !== 'pose';

/**
 * How the position is shown.
 *
 * `movement` performs the whole thing and returns to neutral — what the test
 * looks like being done. `hold` descends into the assessed position and STAYS
 * there, which is what an assessment actually needs: a student grading a deep
 * squat is reading torso angle against shin angle, whether the heels are down,
 * where the dowel sits. None of that can be judged from a mannequin that has
 * already stood back up, and orbiting the held position is the closest this
 * gets to walking around a patient.
 */
export type ShowMode = 'movement' | 'hold';

/**
 * The motion a position plays, with the case's ROM constraints applied where a
 * builder compensates for them, before it is resolved. An app that resolves
 * motions itself (simLAB's sampler, which starts a motion from the pose before
 * it) takes this; {@link resolvePosition} resolves it as simMOVE's Screen does.
 *
 * Returns null for an unposed position, an app-held `pose`, or a source naming a
 * template or builder that no longer exists — a rename in the engine surfaces as
 * "no position" rather than as a crash.
 */
export function composeScreenMotion(
  src: PositionSource,
  side: ScreenSide,
  constraints: RomScenarioConstraints | null,
  /** The test being shown. Two of them need the arms overhead rather than the
   *  builder's counterweight reach — see {@link armsOverhead}. */
  testId?: string,
  mode: ShowMode = 'movement',
): ComposedMotion | null {
  let motion = composeFor(src, side, constraints);
  if (!motion) return null;
  if (testId && OVERHEAD_ARM_TESTS.has(testId)) motion = armsOverhead(motion);
  if (mode === 'hold') motion = holdAtAssessedPosition(motion);
  return motion;
}

/**
 * Turn a position into something the stage can play, with the case's ROM
 * constraints applied. Constraints ride the SAME resolve path the Studio uses
 * (`resolveComposedMotion(..., { constraints })`), so an impaired case is
 * clamped by the engine rather than by anything the page invents.
 */
export function resolvePosition(
  src: PositionSource,
  side: ScreenSide,
  constraints: RomScenarioConstraints | null,
  testId?: string,
  mode: ShowMode = 'movement',
): ResolvedComposedMotion | null {
  const motion = composeScreenMotion(src, side, constraints, testId, mode);
  return motion ? resolveComposedMotion(motion, undefined, { constraints }) : null;
}

/**
 * Trim a motion so it ENDS in the position being assessed instead of returning
 * to neutral.
 *
 * The assessed position is the keyframe the author already marked as the one
 * worth dwelling on — the largest `holdMs`. Everything after it is the way back
 * out, which for a screen is the part nobody grades. Failing an explicit hold,
 * the deepest keyframe by total joint excursion is used, which is the same frame
 * for every builder in the library.
 *
 * The hold is then extended so the mannequin stays there rather than freezing on
 * the last frame of a finished motion — a settled pose the student can orbit.
 */
function holdAtAssessedPosition(motion: ComposedMotion): ComposedMotion {
  const kfs = motion.keyframes;
  if (kfs.length <= 1) return motion;

  // The authored dwell marks the assessed frame. NOTE the index can legitimately
  // be 0 — buildSquat's descent keyframe carries the holdMs and its ascent does
  // not — so this must distinguish "not found" from "found at zero". Treating
  // index 0 as not-found kept the ascent and held the mannequin STANDING, which
  // is precisely the bug this function exists to prevent.
  let peak = -1, longestHold = 0;
  kfs.forEach((kf,index)=>{if((kf.holdMs??0)>longestHold){peak=index;longestHold=kf.holdMs!;}});
  if (peak < 0) {
    let best = -1;
    kfs.forEach((kf, i) => {
      const excursion = (kf.targets ?? []).reduce((a, t) => a + Math.abs(t.targetDegrees), 0);
      if (excursion > best) {
        best = excursion;
        peak = i;
      }
    });
  }
  if (peak < 0) return motion;

  // A motion needs somewhere to travel FROM, so a peak at index 0 keeps the
  // frame after it rather than collapsing to a single keyframe — and that frame
  // is then rewritten to the assessed pose so the dwell lands in position
  // instead of on the way back out.
  const assessed = kfs[peak];
  const kept =
    peak === 0
      ? [assessed, { ...assessed, durationMs: Math.max(assessed.durationMs, 1), holdMs: HOLD_MS }]
      : kfs.slice(0, peak + 1).map((kf, i, a) =>
          i === a.length - 1 ? { ...kf, holdMs: Math.max(kf.holdMs ?? 0, HOLD_MS) } : kf,
        );

  const { reps: _reps, ...rest } = motion;
  // A held position is a destination, not a rep — reps would take it back out.
  return { ...rest, keyframes: kept };
}

/** How long a held assessment position dwells before the motion is considered
 *  done. Long enough to orbit the mannequin and read the position off it. The
 *  resolver caps a keyframe at `MAX_KEYFRAME_MS` (10 s), so it plays as 10 s. */
const HOLD_MS = 20000;

/** Tests with overhead arms; only FMS specifies an overhead dowel. */
export const OVERHEAD_ARM_TESTS = new Set(['deep-squat', 'overhead-deep-squat']);

function composeFor(
  src: PositionSource,
  side: ScreenSide,
  constraints: RomScenarioConstraints | null,
): ComposedMotion | null {
  switch (src.kind) {
    case 'template': {
      const t = MOVEMENT_TEMPLATES.find((x) => x.id === src.templateId);
      return t ? templateToComposedMotion(t) : null;
    }
    case 'builder': {
      const b = BUILDERS[src.builderId];
      return b ? b(side, constraints) : null;
    }
    case 'authored': {
      const a = AUTHORED[src.motionId];
      if (!a) return null;
      return SQUAT_COMPENSATED_AUTHORED.has(src.motionId) ? withSquatCompensation(a(side), constraints) : a(side);
    }
    // An authored pose is applied by the app that holds it, not resolved as a
    // motion — the caller checks for this kind before asking for a resolve.
    case 'pose':
    case 'unposed':
      return null;
  }
}

// ─── The registry: which patterns there are, and how each is performed ───────

/** Where a pattern starts and is performed. `supine`, `prone` and `quadruped`
 *  are on the floor: none of these patterns uses a plinth. */
export type ScreenPosture = 'standing' | 'supine' | 'prone' | 'quadruped';

/**
 * A piece of the screening kit, as the protocol places it. pose-engine draws
 * none of it; an app that shows the kit places it from the body (the hands, the
 * spine, the tibial tuberosity) and sizes it from {@link SCREEN_KIT}.
 *
 * - dowel `overhead`: pressed overhead in both hands (the FMS deep squat).
 * - dowel `across-shoulders`: held in both hands across the shoulders, behind
 *   the neck (the hurdle step).
 * - dowel `along-spine`: held vertically behind the back, touching the head, the
 *   thoracic spine and the sacrum (the in-line lunge).
 * - dowel `upright-by-thigh`: stood on the floor beside the resting leg, midway
 *   between the anterior superior iliac spine and the knee's joint line (the
 *   active straight-leg raise).
 * - `hurdle`: a cord across two uprights at the height of the tibial tuberosity,
 *   the feet together behind it at the start.
 * - board `under-feet`: both feet in line on it (the in-line lunge).
 * - board `under-knees`: across the floor under both knees (the active
 *   straight-leg raise).
 * - board `between-hands-and-knees`: along the floor under the trunk, the hands
 *   and knees either side of it (rotary stability).
 */
export type ScreenEquipment =
  | { kind: 'dowel'; hold: 'overhead' | 'across-shoulders' | 'along-spine' | 'upright-by-thigh' }
  | { kind: 'hurdle' }
  | { kind: 'board'; placement: 'under-feet' | 'under-knees' | 'between-hands-and-knees' };

/**
 * The screening kit's nominal sizes, in metres: a 4 ft dowel an inch across, a
 * nominal 2x6 board (1.5 × 5.5 in) about 5 ft long, and a hurdle whose uprights
 * stand wide enough for the stepping foot to pass between them.
 */
export const SCREEN_KIT = {
  dowel: { lengthM: 1.22, radiusM: 0.0127 },
  board: { lengthM: 1.52, widthM: 0.14, thicknessM: 0.038 },
  hurdle: { widthM: 0.66, uprightRadiusM: 0.0127, cordRadiusM: 0.003 },
} as const;

/** One pattern of the screen: an FMS test or clearing test, or an SFMA top-tier
 *  pattern. */
export interface MovementScreenPattern {
  /** simMOVE's movement id: the key of its movement files, their acceptance and
   *  its Coverage page, and of simLAB's Exam audit row (`move:<id>`). */
  id: string;
  system: 'fms' | 'sfma';
  kind: 'test' | 'clearing' | 'top-tier';
  /** The id {@link positionFor} takes: the FMS test id or the SFMA pattern id. */
  testId: string;
  name: string;
  posture: ScreenPosture;
  /** What the chosen side names (`'stepping leg'`), or null when the motion is
   *  the same whichever side is chosen. */
  side: string | null;
  equipment: readonly ScreenEquipment[];
}

const fms = (testId: string, name: string, posture: ScreenPosture, side: string | null, equipment: ScreenEquipment[] = []): MovementScreenPattern =>
  ({ id: `fms-repo-legacy-v1/${testId}/${testId}`, system: 'fms', kind: 'test', testId, name, posture, side, equipment });
const clearing = (testId: string, clears: string, name: string, posture: ScreenPosture, side: string | null): MovementScreenPattern =>
  ({ id: `fms-repo-legacy-v1/${clears}/${testId}`, system: 'fms', kind: 'clearing', testId, name, posture, side, equipment: [] });
const topTier = (testId: string, name: string, side: string | null): MovementScreenPattern =>
  ({ id: `sfma-repo-legacy-v1/${testId}/top-tier`, system: 'sfma', kind: 'top-tier', testId, name, posture: 'standing', side, equipment: [] });

/**
 * The 20 patterns with a motion: the seven FMS tests, the three FMS clearing
 * tests and the ten SFMA top-tier patterns. The 81 SFMA breakouts have none yet
 * ({@link BREAKOUT_POSITIONS}).
 */
export const MOVEMENT_SCREEN: readonly MovementScreenPattern[] = [
  fms('deep-squat', 'Deep Squat', 'standing', null, [{ kind: 'dowel', hold: 'overhead' }]),
  fms('hurdle-step', 'Hurdle Step', 'standing', 'stepping leg', [{ kind: 'hurdle' }, { kind: 'dowel', hold: 'across-shoulders' }]),
  fms('in-line-lunge', 'In-Line Lunge', 'standing', 'front foot', [{ kind: 'board', placement: 'under-feet' }, { kind: 'dowel', hold: 'along-spine' }]),
  fms('shoulder-mobility', 'Shoulder Mobility', 'standing', 'overhead arm'),
  fms('aslr', 'Active Straight-Leg Raise', 'supine', 'raised leg', [{ kind: 'board', placement: 'under-knees' }, { kind: 'dowel', hold: 'upright-by-thigh' }]),
  fms('trunk-stability-push-up', 'Trunk Stability Push-Up', 'prone', null),
  fms('rotary-stability', 'Rotary Stability', 'quadruped', 'moving arm and leg', [{ kind: 'board', placement: 'between-hands-and-knees' }]),
  clearing('shoulder-clearing', 'shoulder-mobility', 'Shoulder Clearing', 'standing', 'reaching arm'),
  clearing('extension-clearing', 'trunk-stability-push-up', 'Spinal Extension Clearing', 'prone', null),
  clearing('flexion-clearing', 'rotary-stability', 'Spinal Flexion Clearing', 'quadruped', null),
  topTier('cervical-flexion', 'Cervical Flexion', null),
  topTier('cervical-extension', 'Cervical Extension', null),
  topTier('cervical-rotation', 'Cervical Rotation', 'direction turned'),
  topTier('upper-extremity-pattern-one', 'Upper Extremity Pattern 1', 'reaching arm'),
  topTier('upper-extremity-pattern-two', 'Upper Extremity Pattern 2', 'reaching arm'),
  topTier('multisegmental-flexion', 'Multi-Segmental Flexion', null),
  topTier('multisegmental-extension', 'Multi-Segmental Extension', null),
  topTier('multisegmental-rotation', 'Multi-Segmental Rotation', 'direction turned'),
  topTier('single-leg-stance', 'Single-Leg Stance', 'lifted leg'),
  topTier('overhead-deep-squat', 'Overhead Deep Squat', null),
];

/** The pattern with this simMOVE movement id, if the screen has a motion for it. */
export function movementScreenPattern(id: string): MovementScreenPattern | undefined {
  return MOVEMENT_SCREEN.find((pattern) => pattern.id === id);
}

/**
 * The motion a pattern plays, as simMOVE's Screen plays it with no case: the
 * overhead dowel press where the test has one, and either the whole movement or
 * the held assessed position. For a pattern whose `side` is null, the side is
 * ignored.
 */
export function movementScreenMotion(pattern: MovementScreenPattern, side: ScreenSide, mode: ShowMode = 'movement', constraints: RomScenarioConstraints | null = null): ComposedMotion | null {
  return composeScreenMotion(positionFor(pattern.testId), side, constraints, pattern.testId, mode);
}
