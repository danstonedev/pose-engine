/**
 * scaleArmSwing — the decreased-arm-swing modifier. A build-time keyframe reshape
 * (the paceGait/gaitBounce family), NOT a live overlay: it scales only the
 * shoulderFlexion swing amplitude, holds cadence (no timeScale) and every leg /
 * trunk / elbow angle, and is identity at amount 1.
 */
import { describe, expect, it } from 'vitest';
import { scaleArmSwing, templateToComposedMotion, MOVEMENT_TEMPLATES } from '../services/movementTemplates';
import type { ComposedMotion } from '../services/motionSequence';

const walk = (): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

const peakAbs = (m: ComposedMotion, motion: string): number => {
  let mx = 0;
  for (const kf of m.keyframes) for (const t of kf.targets ?? []) {
    if (t.motion === motion) mx = Math.max(mx, Math.abs(t.targetDegrees));
  }
  return mx;
};

describe('scaleArmSwing', () => {
  it('scales shoulderFlexion amplitude by the factor', () => {
    const base = walk();
    const half = scaleArmSwing(base, 0.5);
    expect(peakAbs(base, 'shoulderFlexion')).toBeGreaterThan(0); // the walk swings the arms
    expect(peakAbs(half, 'shoulderFlexion')).toBeCloseTo(peakAbs(base, 'shoulderFlexion') * 0.5, 4);
  });

  it('holds every non-arm angle and adds no timeScale (unlike paceGait)', () => {
    const base = walk();
    const quiet = scaleArmSwing(base, 0.2);
    // Legs untouched…
    expect(peakAbs(quiet, 'hipFlexion')).toBeCloseTo(peakAbs(base, 'hipFlexion'), 6);
    expect(peakAbs(quiet, 'kneeFlexion')).toBeCloseTo(peakAbs(base, 'kneeFlexion'), 6);
    // …the reciprocal elbow pump untouched (not in ARM_SWING_MOTIONS)…
    expect(peakAbs(quiet, 'elbowFlexion')).toBeCloseTo(peakAbs(base, 'elbowFlexion'), 6);
    // …and cadence unchanged (no timeScale side effect).
    expect(quiet.modifiers?.timeScale).toBe(base.modifiers?.timeScale);
  });

  it('amount 0 stills the arms; amount 1 is identity', () => {
    const base = walk();
    expect(peakAbs(scaleArmSwing(base, 0), 'shoulderFlexion')).toBe(0);
    expect(scaleArmSwing(base, 1)).toBe(base); // identity returns the same object
  });

  it('clamps out-of-range amounts', () => {
    const base = walk();
    expect(peakAbs(scaleArmSwing(base, 5), 'shoulderFlexion')).toBeCloseTo(
      peakAbs(base, 'shoulderFlexion'),
      6,
    ); // clamped to 1 (identity)
    expect(peakAbs(scaleArmSwing(base, -2), 'shoulderFlexion')).toBe(0); // clamped to 0
  });
});
