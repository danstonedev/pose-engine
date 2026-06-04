import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { blendCustomPose, blendCustomPoseWithBaseline } from '../services/poseRig';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';

const IDENTITY_QUAT: [number, number, number, number] = [0, 0, 0, 1];

/** Quaternion for `angleRad` rotation about world +Y. */
function yQuat(angleRad: number): [number, number, number, number] {
  const half = angleRad / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

function makePose(
  bones: Record<string, [number, number, number, number]>,
  variant = 'male',
  positions?: Record<string, [number, number, number]>,
): CustomPose {
  return {
    variant,
    bones,
    ...(positions ? { positions } : {}),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}

describe('blendCustomPose', () => {
  it('returns null when both inputs are nullish', () => {
    expect(blendCustomPose(null, null, 0.5)).toBeNull();
    expect(blendCustomPose(undefined, undefined, 0.5)).toBeNull();
  });

  it('snaps one-sided transitions to the target side', () => {
    const only = makePose({ Hips: yQuat(0.3) });
    const fromOnly = blendCustomPose(only, null, 0.5);
    expect(fromOnly).toBeNull();
    const toOnly = blendCustomPose(null, only, 0.5);
    expect(toOnly?.bones.Hips).toEqual(only.bones.Hips);
  });

  it('blends custom -> neutral against a full baseline pose', () => {
    const baseline = makePose({ Hips: yQuat(0) });
    const custom = makePose({ Hips: yQuat(Math.PI / 2) });
    const blended = blendCustomPoseWithBaseline(custom, null, baseline, 0.5)!;
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 4,
    );
    const got = new THREE.Quaternion(
      blended.bones.Hips[0],
      blended.bones.Hips[1],
      blended.bones.Hips[2],
      blended.bones.Hips[3],
    );
    expect(got.angleTo(expected)).toBeLessThan(1e-6);
    expect(blendCustomPoseWithBaseline(custom, null, baseline, 1)?.bones.Hips).toEqual(
      baseline.bones.Hips,
    );
  });

  it('blends neutral -> custom against a full baseline pose', () => {
    const baseline = makePose({ Hips: yQuat(0) });
    const custom = makePose({ Hips: yQuat(Math.PI / 2) });
    const blended = blendCustomPoseWithBaseline(null, custom, baseline, 0.5)!;
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 4,
    );
    const got = new THREE.Quaternion(
      blended.bones.Hips[0],
      blended.bones.Hips[1],
      blended.bones.Hips[2],
      blended.bones.Hips[3],
    );
    expect(got.angleTo(expected)).toBeLessThan(1e-6);
    expect(blendCustomPoseWithBaseline(null, custom, baseline, 0)?.bones.Hips).toEqual(
      baseline.bones.Hips,
    );
  });

  it('blends custom -> custom against a baseline (passthrough to blendCustomPose)', () => {
    // The history-scrubbing case: both sides are real poses, baseline is
    // present but unused. Verifies the gate fix at PainBody3D's pose tween
    // is safe — the underlying math interpolates pose↔pose correctly.
    const baseline = makePose({ Hips: yQuat(0) });
    const a = makePose({ Hips: yQuat(0) });
    const b = makePose({ Hips: yQuat(Math.PI / 2) });
    const mid = blendCustomPoseWithBaseline(a, b, baseline, 0.5)!;
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 4,
    );
    const got = new THREE.Quaternion(
      mid.bones.Hips[0],
      mid.bones.Hips[1],
      mid.bones.Hips[2],
      mid.bones.Hips[3],
    );
    expect(got.angleTo(expected)).toBeLessThan(1e-6);
    expect(blendCustomPoseWithBaseline(a, b, baseline, 0)?.bones.Hips).toEqual(a.bones.Hips);
    expect(blendCustomPoseWithBaseline(a, b, baseline, 1)?.bones.Hips).toEqual(b.bones.Hips);
  });

  it('snaps to `from` at t=0 and `to` at t=1', () => {
    const a = makePose({ Hips: yQuat(0) });
    const b = makePose({ Hips: yQuat(Math.PI / 2) });
    const at0 = blendCustomPose(a, b, 0)!;
    const at1 = blendCustomPose(a, b, 1)!;
    expect(at0.bones.Hips).toEqual(a.bones.Hips);
    expect(at1.bones.Hips).toEqual(b.bones.Hips);
  });

  it('slerps quaternions at t=0.5 to the angular midpoint', () => {
    const a = makePose({ Hips: yQuat(0) });
    const b = makePose({ Hips: yQuat(Math.PI / 2) });
    const blended = blendCustomPose(a, b, 0.5)!;
    // Expected midpoint: 45° about +Y.
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 4,
    );
    const got = new THREE.Quaternion(
      blended.bones.Hips[0],
      blended.bones.Hips[1],
      blended.bones.Hips[2],
      blended.bones.Hips[3],
    );
    expect(got.angleTo(expected)).toBeLessThan(1e-6);
  });

  it('holds a bone present only in `from` across the entire transition', () => {
    const a = makePose({ Hips: yQuat(0), L_UpperArm: yQuat(0.5) });
    const b = makePose({ Hips: yQuat(Math.PI / 2) });
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const blended = blendCustomPose(a, b, t)!;
      expect(blended.bones.L_UpperArm).toEqual(a.bones.L_UpperArm);
    }
  });

  it('holds a bone present only in `to` across the entire transition', () => {
    const a = makePose({ Hips: yQuat(0) });
    const b = makePose({ Hips: yQuat(Math.PI / 2), R_UpperArm: yQuat(0.7) });
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const blended = blendCustomPose(a, b, t)!;
      expect(blended.bones.R_UpperArm).toEqual(b.bones.R_UpperArm);
    }
  });

  it('lerps positions for keys present on both sides', () => {
    const a = makePose({ Hips: IDENTITY_QUAT }, 'male', { Hips: [0, 0, 0] });
    const b = makePose({ Hips: IDENTITY_QUAT }, 'male', { Hips: [10, 4, -2] });
    const mid = blendCustomPose(a, b, 0.5)!;
    expect(mid.positions?.Hips).toEqual([5, 2, -1]);
  });

  it('always stamps the current POSE_SCHEMA_VERSION on the output', () => {
    const a = makePose({ Hips: yQuat(0.1) });
    a.schemaVersion = 'cc-old-baseline';
    const b = makePose({ Hips: yQuat(0.4) });
    b.schemaVersion = 'cc-some-other';
    const blended = blendCustomPose(a, b, 0.5)!;
    expect(blended.schemaVersion).toBe(POSE_SCHEMA_VERSION);
  });

  it('snaps to `to` when the two sides are different variants', () => {
    const a = makePose({ Hips: yQuat(0) }, 'male');
    const b = makePose({ Hips: yQuat(Math.PI / 2) }, 'female');
    const blended = blendCustomPose(a, b, 0.5)!;
    expect(blended.variant).toBe('female');
    expect(blended.bones.Hips).toEqual(b.bones.Hips);
  });

  it('clamps t outside [0,1] before slerping', () => {
    const a = makePose({ Hips: yQuat(0) });
    const b = makePose({ Hips: yQuat(Math.PI / 2) });
    const below = blendCustomPose(a, b, -0.5)!;
    const above = blendCustomPose(a, b, 1.5)!;
    expect(below.bones.Hips).toEqual(a.bones.Hips);
    expect(above.bones.Hips).toEqual(b.bones.Hips);
  });

  it('returns a deep copy at t=0 / t=1 so callers can mutate without aliasing', () => {
    const a = makePose({ Hips: yQuat(0.2) });
    const b = makePose({ Hips: yQuat(0.6) });
    const at0 = blendCustomPose(a, b, 0)!;
    at0.bones.Hips[0] = 99;
    expect(a.bones.Hips[0]).not.toBe(99);
  });
});
