/**
 * PROXIMAL-TO-DISTAL ONSET STAGGER — invariants.
 *
 * The stagger changes the trajectory BETWEEN keyframes but must never change
 * where a bone arrives. These tests pin the two guarantees the whole design
 * rests on:
 *   1. Exact arrival: at local == 1 every bone is on target (== the lockstep
 *      blend), so keyframe boundaries, holds, and settled measurements are
 *      unchanged.
 *   2. Sequencing: mid-travel, a proximal bone (hips) is further along its arc
 *      than a distal bone (a finger) — the kinetic-chain lead.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';
import { blendCustomPose } from '../services/poseRig';
import {
  chainOnsetDelay,
  composedTweenEase,
  PROXIMAL_TO_DISTAL_STAGGER,
  stagedBlendWithBaseline,
} from '../services/motionStagger';

/** Rotation about +X by `deg`, as a pose quaternion tuple. */
function rotX(deg: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (deg * Math.PI) / 180,
  );
  return [q.x, q.y, q.z, q.w];
}

const IDENT: [number, number, number, number] = [0, 0, 0, 1];

/** A synthetic pose that rotates one bone per canonical key to 90° about X. */
function targetPose(keys: string[]): CustomPose {
  return {
    variant: 'male',
    bones: Object.fromEntries(
      keys.map((k): [string, [number, number, number, number]] => [k, rotX(90)]),
    ),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}

function restPose(keys: string[]): CustomPose {
  return {
    variant: 'male',
    bones: Object.fromEntries(
      keys.map((k): [string, [number, number, number, number]] => [k, IDENT]),
    ),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}

/** Realized interpolation fraction of a bone = its X-rotation / 90°. */
function realizedFraction(pose: CustomPose, key: string): number {
  const q = pose.bones[key]!;
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q[3]))); // magnitude of rotation, rad
  return (angle * 180) / Math.PI / 90;
}

const KEYS = ['Hips', 'L_Shoulder', 'L_Forearm', 'L_Hand', 'L_Index1'];

describe('motionStagger — onset delay ordering', () => {
  it('delay increases monotonically down the kinetic chain', () => {
    const d = (k: string) => chainOnsetDelay(k);
    expect(d('Hips')).toBe(0);
    expect(d('Hips')).toBeLessThan(d('L_Shoulder'));
    expect(d('L_Shoulder')).toBeLessThan(d('L_Forearm'));
    expect(d('L_Forearm')).toBeLessThan(d('L_Hand'));
    expect(d('L_Hand')).toBeLessThan(d('L_Index1')); // fingers trail most
    expect(d('L_Index1')).toBe(1);
  });

  it('left/right side prefixes map to the same rank', () => {
    expect(chainOnsetDelay('L_Forearm')).toBe(chainOnsetDelay('R_Forearm'));
  });
});

describe('motionStagger — exact arrival (measurement invariant)', () => {
  const from = restPose(KEYS);
  const to = targetPose(KEYS);

  it('local == 1 is byte-identical to the lockstep blend (on target)', () => {
    const staged = stagedBlendWithBaseline(from, to, from, 1)!;
    const lockstep = blendCustomPose(from, to, 1)!;
    for (const k of KEYS) {
      expect(realizedFraction(staged, k)).toBeCloseTo(1, 6);
      expect(staged.bones[k]).toEqual(lockstep.bones[k]);
    }
  });

  it('local == 0 leaves every bone at the start pose', () => {
    const staged = stagedBlendWithBaseline(from, to, from, 0)!;
    for (const k of KEYS) expect(realizedFraction(staged, k)).toBeCloseTo(0, 6);
  });

  it('stagger == 0 reproduces the exact lockstep curve at every local', () => {
    for (const l of [0.1, 0.37, 0.5, 0.83]) {
      const staged = stagedBlendWithBaseline(from, to, from, l, 0)!;
      const lockstep = blendCustomPose(from, to, composedTweenEase(l))!;
      for (const k of KEYS) expect(staged.bones[k]).toEqual(lockstep.bones[k]);
    }
  });
});

describe('motionStagger — proximal leads distal mid-travel', () => {
  it('at local 0.5 hips are further along than the shoulder, forearm, hand, finger', () => {
    const from = restPose(KEYS);
    const to = targetPose(KEYS);
    const staged = stagedBlendWithBaseline(from, to, from, 0.5)!;
    const f = (k: string) => realizedFraction(staged, k);
    expect(f('Hips')).toBeGreaterThan(f('L_Shoulder'));
    expect(f('L_Shoulder')).toBeGreaterThan(f('L_Forearm'));
    expect(f('L_Forearm')).toBeGreaterThan(f('L_Hand'));
    expect(f('L_Hand')).toBeGreaterThan(f('L_Index1'));
    // The lead is real but bounded — the most distal joint is not stalled.
    expect(f('L_Index1')).toBeGreaterThan(0);
    expect(PROXIMAL_TO_DISTAL_STAGGER).toBeGreaterThan(0);
  });
});
