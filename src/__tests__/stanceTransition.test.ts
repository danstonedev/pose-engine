import { describe, expect, it } from 'vitest';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { bilateralFootSetupMs } from '../services/motionSupport';

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
