/**
 * FLOOR-MARGIN GATE (SEAM-7, pipeline-diagnostics R4).
 *
 * The velocity governor raises any keyframe whose fastest joint would exceed its
 * class cap to a realistic-velocity floor (`maxDelta ÷ cap`, then `max` with the
 * fixed MIN_KEYFRAME_MS). When a SHIPPED template/builder authors a keyframe
 * that sits a hair ABOVE that velocity floor, a later ROM or velocity-cap retune
 * can silently push the floor over the authored duration — re-timing the
 * keyframe, and with it any ms-authored gait `contacts`/`gaitStanceWindowsMs`
 * hung off that clock (SEAM-7: the walk's contact keyframe used to sit 1.3 ms
 * above its floor; a paced walk then floored it one-sidedly → DET-RES-01 limp).
 *
 * This gate asserts every shipped keyframe (whose predecessor is AUTHORED — see
 * below) clears its VELOCITY floor by ≥ {@link FLOOR_MARGIN_MS}. The margin is
 * measured against the velocity floor, not the resolved floor, because a retune
 * moves the velocity floor — the MIN_KEYFRAME_MS constant does not. So the
 * run/hop/jump family, authored tight AT the immovable MIN floor by design
 * (ballistic airtime derived from physics; runStepTiming pre-floors at MIN), is
 * NOT a violator here: its velocity floor sits far below its duration (asserted
 * explicitly below). No shipped keyframe is exempted by name.
 *
 * kf0 SCOPE: a keyframe's floor needs a known "from" pose. kf0 has one only when
 * the motion starts from a fixed pose — `startFrom:'neutral'` (from rest) or a
 * `loop` (the wrap predecessor, which resolveComposedMotion now seeds kf0 from).
 * A `startFrom:'current'` non-loop motion's kf0 enters from a RUNTIME-chained /
 * posture-bridged pose (e.g. push-up enters from a plank, bird-dog from
 * quadruped), so its from-neutral floor is a resolve-from-nothing artifact, not
 * an authoring cliff — kf0 is skipped for those (kf1…kfN, seeded from their real
 * authored predecessors, are always checked).
 *
 * PACE: builders are gated at their CANONICAL (default) construction. Pacing is
 * a derived √speed scaling of the stride amplitude; a fast paced gait's
 * initial-contact keyframe legitimately approaches its velocity floor (the
 * authored Perry 168 ms interval carries a ~35° knee swing that grows with
 * pace) — that is ROM-floor-inherent, covered by gaitContactSync + the loop-wrap
 * symmetry, and the resolved-time window remap carries the windows if it ever
 * does floor.
 */
import { describe, expect, it } from 'vitest';
import {
  keyframeVelocityFloorsMs,
  resolveComposedMotion,
  type ComposedMotion,
} from '../services/motionSequence';
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  buildTravelWalk,
  buildTravelRun,
  buildRun,
  buildTurnInPlace,
  buildJump,
  buildSingleLegHop,
  buildFigureEightWalk,
  buildLieDown,
  buildGetUp,
  buildSupineLegRaise,
  buildSitDown,
  buildStandFromSit,
  buildSeatedKneeExtension,
  buildGetDownToPlank,
  buildPushUp,
  buildStandFromPlank,
  buildGetDownToQuadruped,
  buildStandFromQuadruped,
  buildBirdDog,
  buildKneelDown,
  buildStandFromKneel,
  buildLowerToProne,
  buildPressUpToQuadruped,
  buildPlankFromQuadruped,
  buildQuadrupedFromPlank,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;

/** The margin every shipped keyframe must clear above its velocity floor. */
const FLOOR_MARGIN_MS = 10;

/** Every shipped, standalone-playable motion, canonically constructed. */
function shippedMotions(): { label: string; motion: ComposedMotion }[] {
  const out: { label: string; motion: ComposedMotion }[] = [];
  for (const t of MOVEMENT_TEMPLATES) {
    out.push({ label: `template:${t.id}`, motion: templateToComposedMotion(t) });
  }
  const fe = buildFigureEightWalk();
  out.push(
    { label: 'buildTravelWalk', motion: buildTravelWalk() },
    { label: 'buildTravelWalk(turn90)', motion: buildTravelWalk({ turnDeg: 90 }) },
    { label: 'buildTravelRun', motion: buildTravelRun() },
    { label: 'buildRun', motion: buildRun() },
    { label: 'buildTurnInPlace(180)', motion: buildTurnInPlace() },
    { label: 'buildTurnInPlace(90)', motion: buildTurnInPlace({ degrees: 90 }) },
    { label: 'buildJump', motion: buildJump() },
    { label: 'buildSingleLegHop', motion: buildSingleLegHop() },
    { label: 'buildFigureEightWalk[0]', motion: fe[0] },
    { label: 'buildFigureEightWalk[1]', motion: fe[1] },
    { label: 'buildLieDown', motion: buildLieDown() },
    { label: 'buildGetUp', motion: buildGetUp() },
    { label: 'buildSupineLegRaise', motion: buildSupineLegRaise() },
    { label: 'buildSitDown', motion: buildSitDown() },
    { label: 'buildStandFromSit', motion: buildStandFromSit() },
    { label: 'buildSeatedKneeExtension', motion: buildSeatedKneeExtension() },
    { label: 'buildGetDownToPlank', motion: buildGetDownToPlank() },
    { label: 'buildPushUp', motion: buildPushUp() },
    { label: 'buildStandFromPlank', motion: buildStandFromPlank() },
    { label: 'buildGetDownToQuadruped', motion: buildGetDownToQuadruped() },
    { label: 'buildStandFromQuadruped', motion: buildStandFromQuadruped() },
    { label: 'buildBirdDog', motion: buildBirdDog() },
    { label: 'buildKneelDown', motion: buildKneelDown() },
    { label: 'buildStandFromKneel', motion: buildStandFromKneel() },
    { label: 'buildLowerToProne', motion: buildLowerToProne() },
    { label: 'buildPressUpToQuadruped', motion: buildPressUpToQuadruped() },
    { label: 'buildPlankFromQuadruped', motion: buildPlankFromQuadruped() },
    { label: 'buildQuadrupedFromPlank', motion: buildQuadrupedFromPlank() },
  );
  return out;
}

/** True when kf0's "from" pose is authored (rest, or the loop wrap) rather than
 *  a runtime-chained entry. */
const kf0HasAuthoredPredecessor = (m: ComposedMotion): boolean =>
  m.startFrom !== 'current' || m.loop === true;

describe('floor-margin gate — shipped keyframes clear their velocity floor (SEAM-7)', () => {
  it(`every shipped keyframe with an authored predecessor clears its velocity floor by ≥ ${FLOOR_MARGIN_MS} ms`, () => {
    const violators: string[] = [];
    for (const { label, motion } of shippedMotions()) {
      const r = resolveComposedMotion(motion, variantCfg);
      expect(r.status, `${label} resolved`).toBe('ok');
      const floors = keyframeVelocityFloorsMs(r);
      const checkKf0 = kf0HasAuthoredPredecessor(motion);
      floors.forEach((f, i) => {
        if (i === 0 && !checkKf0) return;
        if (f.velocityMarginMs < FLOOR_MARGIN_MS) {
          violators.push(
            `${label} kf${i}: margin ${f.velocityMarginMs.toFixed(2)} ms ` +
              `(dur ${r.keyframes[i]!.durationMs} − velFloor ${f.velocityFloorMs.toFixed(1)}), ` +
              `velocityBound=${f.velocityBound}`,
          );
        }
      });
    }
    expect(violators, `keyframes within ${FLOOR_MARGIN_MS} ms of their velocity floor:\n${violators.join('\n')}`).toEqual([]);
  });

  it('the run/jump/hop family sits AT the immovable MIN floor by design, but clears its VELOCITY floor', () => {
    // These author durations pre-floored at MIN_KEYFRAME_MS (ballistic airtime
    // from physics / runStepTiming's MIN clamp), so their resolved-floor margin
    // is ~0 — legitimately "at the floor". The gate does not flag them because a
    // ROM/velocity retune cannot move MIN, and their VELOCITY floor is far below
    // their duration (checked above). This test pins that reasoning: for each,
    // ≥1 keyframe sits at the MIN floor AND every keyframe keeps ≥10 ms velocity
    // headroom.
    for (const motion of [buildRun(), buildTravelRun(), buildJump(), buildSingleLegHop()]) {
      const r = resolveComposedMotion(motion, variantCfg);
      const floors = keyframeVelocityFloorsMs(r);
      const checkKf0 = kf0HasAuthoredPredecessor(motion);
      const atMinFloor = floors.filter((f) => !f.velocityBound && f.resolvedMarginMs < FLOOR_MARGIN_MS);
      expect(atMinFloor.length, `${motion.name}: authored tight at the MIN floor`).toBeGreaterThan(0);
      floors.forEach((f, i) => {
        if (i === 0 && !checkKf0) return;
        expect(
          f.velocityMarginMs,
          `${motion.name} kf${i}: velocity headroom (the retune-safety margin)`,
        ).toBeGreaterThanOrEqual(FLOOR_MARGIN_MS);
      });
    }
  });

  it('COUNTERFACTUAL — the gate catches a keyframe authored within 10 ms of its velocity floor', () => {
    // A single deliberate keyframe: 60° of knee flexion at the 240°/s deliberate
    // cap needs 250 ms; author it at 255 ms → a 5 ms velocity margin (< 10). The
    // wrist target opts out of the relaxedHands background adds so the floor
    // stays analytic.
    const near: ComposedMotion = {
      name: 'counterfactual near-floor',
      keyframes: [
        {
          durationMs: 255,
          targets: [
            { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 60 },
            { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 5 },
          ],
        },
      ],
    };
    const rNear = resolveComposedMotion(near, variantCfg);
    const fNear = keyframeVelocityFloorsMs(rNear)[0]!;
    expect(fNear.velocityFloorMs).toBeCloseTo(250, 0);
    expect(fNear.velocityMarginMs).toBeCloseTo(5, 0);
    expect(fNear.velocityMarginMs, 'the gate would flag this').toBeLessThan(FLOOR_MARGIN_MS);

    // Give it comfortable margin (270 ms → 20 ms) and the gate passes.
    const clear: ComposedMotion = {
      ...near,
      keyframes: [{ ...near.keyframes[0]!, durationMs: 270 }],
    };
    const fClear = keyframeVelocityFloorsMs(resolveComposedMotion(clear, variantCfg))[0]!;
    expect(fClear.velocityMarginMs).toBeCloseTo(20, 0);
    expect(fClear.velocityMarginMs).toBeGreaterThanOrEqual(FLOOR_MARGIN_MS);
  });
});
