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
  READY_POSE_TOLERANCE_DEG,
  READY_ROOT_TOLERANCE_M,
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
});
