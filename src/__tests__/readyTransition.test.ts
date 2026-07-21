/**
 * BETWEEN-COMMAND RETURN-TO-READY decision (pure). The live stage eases the body
 * back to a neutral ready stance and pauses a beat between two directed movements;
 * this pins the pure logic that decides WHEN that settle is warranted (the body has
 * drifted off ready in pose, travel, or orientation) vs. when it is already standing
 * ready and the next move can begin promptly.
 */
import { describe, expect, it } from 'vitest';
import {
  maxPoseAngleDiffDeg,
  readyTransitionNeeded,
  readyResetRootTarget,
  READY_POSE_TOLERANCE_DEG,
  READY_ROOT_TOLERANCE_M,
  READY_ROOT_VERTICAL_TOLERANCE_M,
} from '../services/readyTransition';
import type { CustomPose } from '../types';

const IDENT: [number, number, number, number] = [0, 0, 0, 1];
/** A quaternion of `deg` about X. */
const rotX = (deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 180 / 2;
  return [Math.sin(h), 0, 0, Math.cos(h)];
};
const pose = (bones: Record<string, [number, number, number, number]>): CustomPose => ({
  variant: 'male',
  bones,
});

describe('maxPoseAngleDiffDeg', () => {
  it('is 0 for identical poses', () => {
    const p = pose({ Hips: IDENT, L_UpLeg: rotX(40) });
    expect(maxPoseAngleDiffDeg(p, p)).toBeCloseTo(0, 3);
  });

  it('reports the largest per-bone rotation difference in degrees', () => {
    const a = pose({ Hips: IDENT, L_UpLeg: IDENT, Neck: rotX(5) });
    const b = pose({ Hips: IDENT, L_UpLeg: rotX(30), Neck: IDENT });
    expect(maxPoseAngleDiffDeg(a, b)).toBeGreaterThan(28);
    expect(maxPoseAngleDiffDeg(a, b)).toBeLessThan(32);
  });

  it('ignores bones missing from either pose (no false positive)', () => {
    const a = pose({ Hips: IDENT });
    const b = pose({ Hips: IDENT, L_Hand: rotX(90) });
    // Only shared bones (Hips) are compared → identical → 0.
    expect(maxPoseAngleDiffDeg(a, b)).toBeCloseTo(0, 3);
  });
});

describe('readyTransitionNeeded', () => {
  const atReady = { poseAngleDiffDeg: 0, rootHorizontalM: 0, rootUprightW: 1 };

  it('is false when the body is already at a neutral, grounded, upright ready stance', () => {
    expect(readyTransitionNeeded(atReady)).toBe(false);
    // A hair of drift, still within tolerance, stays false.
    expect(
      readyTransitionNeeded({
        poseAngleDiffDeg: READY_POSE_TOLERANCE_DEG - 1,
        rootHorizontalM: READY_ROOT_TOLERANCE_M / 2,
        rootUprightW: 0.9999,
      }),
    ).toBe(false);
  });

  it('is true when the pose has drifted off ready (e.g. a leg still held up)', () => {
    expect(readyTransitionNeeded({ ...atReady, poseAngleDiffDeg: 30 })).toBe(true);
  });

  it('is true when the body has travelled off origin (e.g. after a forward walk)', () => {
    expect(readyTransitionNeeded({ ...atReady, rootHorizontalM: 0.6 })).toBe(true);
  });

  it('is true when the root is reoriented (not upright — e.g. a lying posture)', () => {
    expect(readyTransitionNeeded({ ...atReady, rootUprightW: 0.7 })).toBe(true);
  });

  // SEAM-10: a body left off the grounded standing Y (pelvis raised/lowered) but
  // otherwise at ready must TWEEN back down, not snap via the resetRootToRest
  // else-branch — so the vertical drift warrants a settle too.
  it('is true when the root sits off the grounded standing Y (SEAM-10)', () => {
    // Counterfactual: without the vertical term the pose/horizontal/orientation are
    // all at ready, so the OLD decision returns false and the reset snaps the pelvis.
    expect(readyTransitionNeeded({ ...atReady, rootVerticalM: READY_ROOT_VERTICAL_TOLERANCE_M + 0.02 })).toBe(true);
  });

  it('a hair of vertical drift within tolerance stays false (byte-identical decision)', () => {
    expect(readyTransitionNeeded({ ...atReady, rootVerticalM: READY_ROOT_VERTICAL_TOLERANCE_M / 2 })).toBe(false);
    // Omitting rootVerticalM entirely is the pre-SEAM-10 decision (defaults to 0).
    expect(readyTransitionNeeded(atReady)).toBe(false);
  });
});

describe('readyResetRootTarget — grounded-standing tween end (SEAM-10)', () => {
  it('lands the root at the grounded standing Y, upright, in place (tween target)', () => {
    const from: [number, number, number] = [0.4, 0.073, -0.25]; // raised 7.3 cm, off-origin
    const { toQuat, toTranslateM } = readyResetRootTarget(from);
    // Vertical dropped to the grounded standing Y (0 relative to the grounded rest).
    expect(toTranslateM[1]).toBe(0);
    // Horizontal preserved — the body stands up IN PLACE, no teleport to origin.
    expect(toTranslateM[0]).toBe(from[0]);
    expect(toTranslateM[2]).toBe(from[2]);
    // Orientation returned upright.
    expect(toQuat).toEqual([0, 0, 0, 1]);
  });
});
