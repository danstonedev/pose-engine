/**
 * Gait-deviation transforms — widenStep (a wide, unsteady base: sustained bilateral
 * hip abduction) and antalgicLean (a sustained lateral trunk lean over the involved
 * limb). Both hold a constant offset through the whole gait; ROM-clamped + measured
 * on resolve, so the deviation reads back on the goniometry chart.
 */
import { describe, expect, it } from 'vitest';
import {
  widenStep,
  antalgicLean,
  paceGait,
  templateToComposedMotion,
  MOVEMENT_TEMPLATES,
} from '../services/movementTemplates';
import { resolveComposedMotion } from '../services/motionSequence';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { ComposedMotion } from '../services/motionSequence';

const walk = (): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

/** Min targetDegrees of a joint.motion across the motion (absent → null). */
const targetOf = (m: ComposedMotion, joint: string, motion: string): number[] =>
  m.keyframes.flatMap((kf) => (kf.targets ?? []).filter((t) => t.joint === joint && t.motion === motion).map((t) => t.targetDegrees));

describe('widenStep', () => {
  it('holds both hips in abduction through every keyframe; identity at 0', () => {
    const base = walk();
    expect(targetOf(base, 'L_UpLeg', 'hipAbduction')).toHaveLength(0); // walk has none
    const wide = widenStep(base, 14);
    const lAbd = targetOf(wide, 'L_UpLeg', 'hipAbduction');
    const rAbd = targetOf(wide, 'R_UpLeg', 'hipAbduction');
    expect(lAbd.length).toBe(base.keyframes.length); // one per keyframe (sustained)
    expect(rAbd.length).toBe(base.keyframes.length);
    expect(lAbd.every((d) => d === 14)).toBe(true);
    expect(rAbd.every((d) => d === 14)).toBe(true);
    expect(widenStep(base, 0)).toEqual(base);
    // resolves without refusal / clamp surprise (14° is well within hip abd ROM)
    expect(resolveComposedMotion(wide, BODY_VARIANTS.male).status).toBe('ok');
  });
});

describe('antalgicLean', () => {
  it('leans the trunk toward the involved side (lumbar leads, thoracic half)', () => {
    const base = walk();
    const left = antalgicLean(base, 'left', 16);
    expect(targetOf(left, 'Spine_Lower', 'lateralTilt').every((d) => d === 16)).toBe(true); // + = left
    expect(targetOf(left, 'Spine_Upper', 'lateralTilt').every((d) => d === 8)).toBe(true); // half
    const right = antalgicLean(base, 'right', 16);
    expect(targetOf(right, 'Spine_Lower', 'lateralTilt').every((d) => d === -16)).toBe(true); // − = right
    expect(resolveComposedMotion(left, BODY_VARIANTS.male).status).toBe('ok');
  });

  it('composes with pace + adds onto any pre-existing lateralTilt', () => {
    const paced = paceGait(walk(), 1.2);
    const leaned = antalgicLean(paced, 'right', 10);
    expect(targetOf(leaned, 'Spine_Lower', 'lateralTilt').every((d) => d === -10)).toBe(true);
    // pace's leg scaling is preserved (lean didn't touch the legs)
    expect(targetOf(leaned, 'R_UpLeg', 'hipFlexion')).toEqual(targetOf(paced, 'R_UpLeg', 'hipFlexion'));
  });
});
