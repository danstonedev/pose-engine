import { describe, expect, it } from 'vitest';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { bilateralFootSetupMs } from '../services/motionSupport';
import { MOVEMENT_SCREEN, movementScreenMotion } from '../services/movementScreen';
import { withStandingStance } from '../services/stanceTransition';

const standingTargets = [
  { joint: 'L_UpLeg', motion: 'hipAbduction', targetDegrees: 8 },
  { joint: 'R_UpLeg', motion: 'hipAbduction', targetDegrees: 8 },
  { joint: 'L_Foot', motion: 'ankleInversion', targetDegrees: 8 },
  { joint: 'R_Foot', motion: 'ankleInversion', targetDegrees: 8 },
];

const genericStandingMotion = (): ComposedMotion => ({
  name: 'Generic standing task with a wider base',
  startFrom: 'neutral',
  stance: 'planted',
  keyframes: [
    { durationMs: 900, targets: standingTargets },
    { durationMs: 1000, targets: [
      ...standingTargets,
      { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 40 },
      { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 40 },
    ] },
    { durationMs: 800, targets: standingTargets },
  ],
  contacts: [{ foot: 'L_Foot', fromMs: 900 }, { foot: 'R_Foot', fromMs: 900 }],
});

describe('shared standing-foot placement', () => {
  it('rejects invalid layouts and preserves tasks with their own moving support', () => {
    const stance = { widthCm: 36, leftForwardCm: 8, rightForwardCm: -5 };
    const source = genericStandingMotion();
    expect(() => withStandingStance(source, { ...stance, widthCm: NaN })).toThrow(RangeError);
    expect(() => withStandingStance(source, { ...stance, rightForwardCm: 13 })).toThrow(RangeError);
    for (const motion of [source, { ...source, loop: true }, { ...source, startPosture: 'sitting' as const }])
      expect(withStandingStance(motion, stance)).toBe(motion);
  });

  it('replaces an existing setup once and leaves the input untouched', () => {
    const source = { ...genericStandingMotion(), contacts: undefined };
    const before = structuredClone(source);
    const first = withStandingStance(source, { widthCm: 36, leftForwardCm: 8, rightForwardCm: -5 });
    const second = withStandingStance(first, { widthCm: 36, leftForwardCm: 8, rightForwardCm: -5 });
    expect(source).toEqual(before);
    expect(first.keyframes).toHaveLength(source.keyframes.length + 8);
    // Reapplying a layout must not accumulate sagittal offsets.
    expect(second).toEqual(first);
  });

  it('offers the same foot layout to every stationary standing screen pattern', () => {
    for (const pattern of MOVEMENT_SCREEN.filter(item => item.posture === 'standing' &&
      !['hurdle-step', 'in-line-lunge', 'single-leg-stance', 'multisegmental-rotation'].includes(item.testId))) {
      const motion = movementScreenMotion(pattern, 'R')!;
      const custom = withStandingStance(motion, { widthCm: 36, leftForwardCm: 4, rightForwardCm: -3 }, 'male');
      expect(custom.footSupportSetup, pattern.id).toBe(true);
      expect(resolveComposedMotion(custom, BODY_VARIANTS.male).status, pattern.id).toBe('ok');
    }
  });
  it('bounds patient foot dimensions and leaves an authored stepping schedule alone', () => {
    const stance = { widthCm: 36, leftForwardCm: 4, rightForwardCm: -3 };
    expect(() => withStandingStance(genericStandingMotion(), { ...stance, widthCm: 70 })).toThrow(RangeError);
    const stepping = { ...genericStandingMotion(), contacts: [{ foot: 'L_Foot', fromMs: 0, toMs: 500 }] };
    expect(withStandingStance(stepping, stance)).toBe(stepping);
  });
  it('steps into a retained wide base for an otherwise unknown whole-body motion', () => {
    const source = genericStandingMotion();
    const resolved = resolveComposedMotion(source, BODY_VARIANTS.neutral);
    expect(resolved.status).toBe('ok');
    expect(resolved.footSupportSetup).toBe(true);
    expect(resolved.keyframes.length).toBe(source.keyframes.length + 7);
    expect(bilateralFootSetupMs(resolved)).toBeGreaterThan(3000);
    expect(resolved.contacts?.some(c => c.foot === 'R_Foot' && c.fromMs === 0 && c.toMs != null)).toBe(true);
    expect(resolved.contacts?.some(c => c.foot === 'L_Foot' && c.fromMs! > 0 && c.toMs == null)).toBe(true);
    const at = (frame: number, joint: string, motion: string) =>
      resolved.keyframes[frame]!.targets?.find(t => t.joint === joint && t.motion === motion)?.clampedDegrees ?? 0;
    expect(at(0, 'L_UpLeg', 'hipAbduction')).toBe(0);
    expect(at(0, 'R_UpLeg', 'hipAbduction')).toBe(0);
    expect(at(1, 'L_Leg', 'kneeFlexion')).toBeGreaterThan(20);
    expect(at(4, 'R_Leg', 'kneeFlexion')).toBeGreaterThan(20);
    expect(at(8, 'L_Leg', 'kneeFlexion')).toBe(40);
    expect(at(8, 'R_Leg', 'kneeFlexion')).toBe(40);
    expect(source.keyframes).toHaveLength(3);
  });

  it('does not add a stance step to an active hip exercise or a current-pose task', () => {
    const current = resolveComposedMotion({ ...genericStandingMotion(), startFrom: 'current' }, BODY_VARIANTS.neutral);
    expect(current.footSupportSetup).not.toBe(true);
    expect(current.keyframes).toHaveLength(3);
    const active = genericStandingMotion();
    active.keyframes[2] = { durationMs: 800, targets: standingTargets.map(t => ({ ...t,
      targetDegrees: t.joint === 'L_UpLeg' ? 0 : t.targetDegrees })) };
    const exercise = resolveComposedMotion(active, BODY_VARIANTS.neutral);
    expect(exercise.footSupportSetup).not.toBe(true);
    expect(exercise.keyframes).toHaveLength(3);
  });

  it('also steps from a measured neutral current pose, but preserves an already wide base', () => {
    const motion = { ...genericStandingMotion(), startFrom: 'current' as const };
    const neutral = resolveComposedMotion(motion, BODY_VARIANTS.neutral, { currentAngles: {
      'L_UpLeg.hipAbduction': 0, 'R_UpLeg.hipAbduction': 0,
    } });
    expect(neutral.footSupportSetup).toBe(true);
    expect(bilateralFootSetupMs(neutral)).toBeGreaterThan(3000);
    const alreadyPlaced = resolveComposedMotion(motion, BODY_VARIANTS.neutral, { currentAngles: {
      'L_UpLeg.hipAbduction': 8, 'R_UpLeg.hipAbduction': 8,
    } });
    expect(alreadyPlaced.footSupportSetup).not.toBe(true);
    expect(alreadyPlaced.keyframes).toHaveLength(3);
  });
});
