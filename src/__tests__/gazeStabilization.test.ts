/**
 * UNIVERSAL GAZE STABILIZATION — the eyes stay forward through ANY upright trunk motion,
 * not just the gait stride. `stabilizeGaze` counter-rotates the neck by exactly what the
 * head would inherit from the authored trunk rotation / lateral tilt; it runs
 * automatically inside `resolveComposedMotion`, skips motions that drive the head
 * themselves or reorient to lying / all-fours ("…unless otherwise specified"), and is
 * idempotent with the gait coordinator (which already writes the neck counter).
 */
import { describe, expect, it } from 'vitest';
import {
  stabilizeGaze,
  resolveComposedMotion,
  SPINE_NECK_MAX,
  type ComposedMotion,
} from '../services/motionSequence';
import { spinalGaitCoordination } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const neck = (m: ComposedMotion, kf: number, motion: string): number | undefined =>
  m.keyframes[kf]!.targets?.find((t) => t.joint === 'Neck' && t.motion === motion)?.targetDegrees;

const trunkTwist = (deg: number): ComposedMotion => ({
  name: 'trunk rotation',
  keyframes: [{ targets: [{ joint: 'Spine_Upper', motion: 'rotation', targetDegrees: deg }], durationMs: 800 }],
});

describe('stabilizeGaze (pure)', () => {
  it('counter-rotates the neck to hold the eyes forward through a trunk AXIAL rotation', () => {
    // The head would inherit the trunk's +20° → the neck counters −20° (within the cap).
    expect(neck(stabilizeGaze(trunkTwist(20)), 0, 'rotation')).toBeCloseTo(-20, 5);
  });

  it('counters trunk LATERAL tilt too, so the head stays level', () => {
    const out = stabilizeGaze({
      keyframes: [{ targets: [{ joint: 'Spine_Lower', motion: 'lateralTilt', targetDegrees: 12 }], durationMs: 800 }],
    });
    expect(neck(out, 0, 'lateralTilt')).toBeCloseTo(-12, 5);
  });

  it('sums thoracic + lumbar rotation and CAPS the counter at the cervical ROM', () => {
    const out = stabilizeGaze({
      keyframes: [{ targets: [
        { joint: 'Spine_Upper', motion: 'rotation', targetDegrees: 30 },
        { joint: 'Spine_Lower', motion: 'rotation', targetDegrees: 15 },
      ], durationMs: 800 }],
    });
    expect(neck(out, 0, 'rotation')).toBe(-SPINE_NECK_MAX); // 45° inherited, clamped to the cap
  });

  it('LEAVES a head-driving motion exactly as authored ("look left" — otherwise specified)', () => {
    const lookLeft: ComposedMotion = { keyframes: [{ targets: [
      { joint: 'Neck', motion: 'rotation', targetDegrees: 40 },
      { joint: 'Spine_Upper', motion: 'rotation', targetDegrees: 10 },
    ], durationMs: 800 }] };
    expect(stabilizeGaze(lookLeft)).toBe(lookLeft); // untouched — same reference
    expect(neck(lookLeft, 0, 'rotation')).toBe(40); // the authored gaze is preserved
  });

  it('LEAVES a lying / reoriented motion untouched (gaze-forward is an upright concept)', () => {
    const supineTwist: ComposedMotion = { endPosture: 'supine', keyframes: [
      { durationMs: 1000, root: { orient: { pitchDeg: -90 } } },
      { targets: [{ joint: 'Spine_Upper', motion: 'rotation', targetDegrees: 15 }], durationMs: 800 },
    ] };
    expect(stabilizeGaze(supineTwist)).toBe(supineTwist);
  });

  it('is a no-op for a motion with no trunk rotation or tilt (arm-only)', () => {
    const armOnly: ComposedMotion = {
      keyframes: [{ targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90 }], durationMs: 800 }],
    };
    expect(stabilizeGaze(armOnly)).toBe(armOnly);
  });

  it('is IDEMPOTENT with the gait coordinator (gait already writes the neck counter → skipped)', () => {
    // A coordinated keyframe carries a Neck counter from spinalGaitCoordination; the
    // universal pass sees an authored Neck target and returns the motion unchanged.
    const gait = spinalGaitCoordination({
      keyframes: [{ targets: [
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 20 },
        { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: -20 },
      ], durationMs: 600 }],
    });
    expect(gait.keyframes[0]!.targets!.some((t) => t.joint === 'Neck'), 'gait wrote the neck counter').toBe(true);
    expect(stabilizeGaze(gait), 'universal pass is a no-op on gait').toBe(gait);
  });
});

describe('gaze stabilization is automatic in resolveComposedMotion', () => {
  it('injects a Neck counter for an upright trunk-rotation motion (resolved on the truth path)', () => {
    const r = resolveComposedMotion(trunkTwist(18), BODY_VARIANTS.male);
    expect(r.status).toBe('ok');
    const neckOut = r.outcomes.find((o) => o.joint === 'Neck' && o.motion === 'rotation');
    expect(neckOut, 'a neck rotation counter was injected + resolved').toBeDefined();
    expect(neckOut!.requestedDegrees).toBeCloseTo(-18, 5);
  });

  it('does NOT inject a second counter when the motion already drives the neck', () => {
    const r = resolveComposedMotion(
      { keyframes: [{ targets: [
        { joint: 'Neck', motion: 'rotation', targetDegrees: 30 },
        { joint: 'Spine_Upper', motion: 'rotation', targetDegrees: 10 },
      ], durationMs: 800 }] },
      BODY_VARIANTS.male,
    );
    const neckOuts = r.outcomes.filter((o) => o.joint === 'Neck' && o.motion === 'rotation');
    expect(neckOuts).toHaveLength(1); // only the authored one
    expect(neckOuts[0]!.requestedDegrees).toBe(30);
  });
});
