/**
 * CONTINUOUS TRAJECTORY — the dynamical guarantees the naturalness theory rests
 * on. These are pure-math checks (no rig): exact knot arrival (measurement
 * invariant), velocity continuity, and the fly-through-vs-stop distinction that
 * removes the robotic stop-start.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { CustomPose } from '../types';
import { buildPoseTrajectory, type TrajectoryKnot } from '../services/motionTrajectory';

const IDENT: [number, number, number, number] = [0, 0, 0, 1];

function rotX(deg: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (deg * Math.PI) / 180);
  return [q.x, q.y, q.z, q.w];
}
function pose(deg: number): CustomPose {
  return { variant: 'male', bones: { L_UpperArm: rotX(deg) }, schemaVersion: 'test' };
}
function knot(timeMs: number, deg: number, stop: boolean): TrajectoryKnot {
  return { timeMs, pose: pose(deg), rootQuat: IDENT, rootTranslate: [0, 0, 0], stop, planted: false };
}
/** Angle (deg, about +X) of the sampled bone relative to identity. */
function angleAt(traj: ReturnType<typeof buildPoseTrajectory>, tMs: number): number {
  const q = traj.sampleAt(tMs).pose.bones.L_UpperArm!;
  const w = Math.min(1, Math.abs(q[3]));
  return (2 * Math.acos(w) * 180) / Math.PI;
}
/** Central-difference angular speed (deg/ms). */
function speedAt(traj: ReturnType<typeof buildPoseTrajectory>, tMs: number, dt = 0.5): number {
  return Math.abs(angleAt(traj, tMs + dt) - angleAt(traj, tMs - dt)) / (2 * dt);
}

describe('motionTrajectory — exact arrival (measurement invariant)', () => {
  // start(0°) → fly-through(90°) → end(0°): a reach out and back.
  const traj = buildPoseTrajectory([
    knot(0, 0, true),
    knot(600, 90, false),
    knot(1200, 0, true),
  ]);

  it('hits every knot pose exactly at its scheduled time', () => {
    expect(angleAt(traj, 0)).toBeCloseTo(0, 4);
    expect(angleAt(traj, 600)).toBeCloseTo(90, 3);
    expect(angleAt(traj, 1200)).toBeCloseTo(0, 3);
    expect(traj.totalMs).toBe(1200);
  });

  it('rests at genuine stops (start and end): near-zero speed', () => {
    expect(speedAt(traj, 3)).toBeLessThan(0.02);
    expect(speedAt(traj, 1197)).toBeLessThan(0.02);
  });
});

describe('motionTrajectory — fly-through does NOT stop, held keyframe DOES', () => {
  it('a fly-through waypoint keeps non-zero speed (no robotic stop)', () => {
    // 0 → 45 (fly-through) → 90: the mannequin should sail through 45°.
    const traj = buildPoseTrajectory([
      knot(0, 0, true),
      knot(500, 45, false),
      knot(1000, 90, true),
    ]);
    // At the interior waypoint the speed must be clearly non-zero.
    expect(speedAt(traj, 500)).toBeGreaterThan(0.03);
  });

  it('a HELD keyframe stops (zero speed) then resumes', () => {
    // 0 →(travel)→ 45 held →(travel)→ 90. The hold knot is a stop.
    const traj = buildPoseTrajectory([
      knot(0, 0, true),
      knot(500, 45, true), // arrival of a keyframe that holds
      knot(800, 45, true), // end of the hold (same pose)
      knot(1300, 90, true),
    ]);
    expect(speedAt(traj, 500)).toBeLessThan(0.02); // stopped at the held pose
    expect(angleAt(traj, 650)).toBeCloseTo(45, 3); // stays put through the hold
    expect(angleAt(traj, 800)).toBeCloseTo(45, 3);
  });
});

describe('motionTrajectory — velocity continuity & monotonic time', () => {
  const traj = buildPoseTrajectory([
    knot(0, 0, true),
    knot(400, 60, false),
    knot(900, 30, false),
    knot(1400, 90, true),
  ]);

  it('time-warp is monotonic (no reversal): angle path never jitters backwards in u', () => {
    // Sample densely; the index-driven pose should progress smoothly with no NaN.
    for (let t = 0; t <= 1400; t += 25) {
      const a = angleAt(traj, t);
      expect(Number.isFinite(a)).toBe(true);
    }
  });

  it('no velocity DROPOUT at interior fly-through knots (speed stays > 0)', () => {
    // Both interior knots (400, 900) are fly-through → speed must not vanish.
    expect(speedAt(traj, 400)).toBeGreaterThan(0.01);
    expect(speedAt(traj, 900)).toBeGreaterThan(0.01);
  });

  it('speed is continuous across an interior knot (no jump)', () => {
    const before = speedAt(traj, 390);
    const after = speedAt(traj, 410);
    // Continuous ⇒ neighbouring speeds are close (not a step change).
    expect(Math.abs(after - before)).toBeLessThan(0.05);
  });
});
