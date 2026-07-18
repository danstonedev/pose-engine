/**
 * applyAsymmetry — the per-side laterality axis. A unilateral (involved-vs-
 * uninvolved) reshape: it scales ONLY the involved side's targets (matched by the
 * L_/R_ joint-key prefix), leaving the uninvolved side as the authored reference —
 * the between-side comparison a PT movement exam is built on. Pure keyframe reshape;
 * ROM-clamped on resolve, so the asymmetry is measurable.
 */
import { describe, expect, it } from 'vitest';
import { applyAsymmetry, templateToComposedMotion, MOVEMENT_TEMPLATES } from '../services/movementTemplates';
import type { ComposedMotion } from '../services/motionSequence';

const walk = (): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

/** Peak |targetDegrees| of a joint.motion across the motion (0 if absent). */
const peak = (m: ComposedMotion, joint: string, motion: string): number => {
  let mx = 0;
  for (const kf of m.keyframes) for (const t of kf.targets ?? []) {
    if (t.joint === joint && t.motion === motion) mx = Math.max(mx, Math.abs(t.targetDegrees));
  }
  return mx;
};

describe('applyAsymmetry', () => {
  it('reduced arm swing on ONE side scales that shoulder, leaves the other + the legs', () => {
    const base = walk();
    const left = applyAsymmetry(base, { side: 'left', armSwing: 0.5 });
    expect(peak(base, 'L_UpperArm', 'shoulderFlexion')).toBeGreaterThan(0);
    expect(peak(left, 'L_UpperArm', 'shoulderFlexion')).toBeCloseTo(
      peak(base, 'L_UpperArm', 'shoulderFlexion') * 0.5,
      4,
    );
    // uninvolved (right) arm and both legs are the authored reference
    expect(peak(left, 'R_UpperArm', 'shoulderFlexion')).toBeCloseTo(peak(base, 'R_UpperArm', 'shoulderFlexion'), 6);
    expect(peak(left, 'L_UpLeg', 'hipFlexion')).toBeCloseTo(peak(base, 'L_UpLeg', 'hipFlexion'), 6);
  });

  it('a short step scales only the involved LEG stride, not the arms', () => {
    const base = walk();
    const right = applyAsymmetry(base, { side: 'right', stepLength: 0.6 });
    expect(peak(right, 'R_UpLeg', 'hipFlexion')).toBeCloseTo(peak(base, 'R_UpLeg', 'hipFlexion') * 0.6, 4);
    expect(peak(right, 'R_Leg', 'kneeFlexion')).toBeCloseTo(peak(base, 'R_Leg', 'kneeFlexion') * 0.6, 4);
    expect(peak(right, 'L_UpLeg', 'hipFlexion')).toBeCloseTo(peak(base, 'L_UpLeg', 'hipFlexion'), 6); // other leg
    expect(peak(right, 'R_UpperArm', 'shoulderFlexion')).toBeCloseTo(peak(base, 'R_UpperArm', 'shoulderFlexion'), 6); // arm
  });

  it('rom scales the whole involved side; overlapping scales compose', () => {
    const base = walk();
    const stiff = applyAsymmetry(base, { side: 'left', rom: 0.5 });
    expect(peak(stiff, 'L_UpLeg', 'hipFlexion')).toBeCloseTo(peak(base, 'L_UpLeg', 'hipFlexion') * 0.5, 4);
    expect(peak(stiff, 'L_UpperArm', 'shoulderFlexion')).toBeCloseTo(peak(base, 'L_UpperArm', 'shoulderFlexion') * 0.5, 4);
    expect(peak(stiff, 'R_UpLeg', 'hipFlexion')).toBeCloseTo(peak(base, 'R_UpLeg', 'hipFlexion'), 6);
    // rom (0.5, whole side) × armSwing (0.5, that arm) compose on the shoulder
    const both = applyAsymmetry(base, { side: 'left', rom: 0.5, armSwing: 0.5 });
    expect(peak(both, 'L_UpperArm', 'shoulderFlexion')).toBeCloseTo(peak(base, 'L_UpperArm', 'shoulderFlexion') * 0.25, 4);
  });

  it('is identity for no asymmetry / all-1 scales', () => {
    const base = walk();
    expect(applyAsymmetry(base, undefined)).toBe(base);
    expect(applyAsymmetry(base, { side: 'left' })).toBe(base);
    expect(applyAsymmetry(base, { side: 'right', armSwing: 1 })).toBe(base);
  });
});
