/**
 * MOMENTUM-PRESERVING SEAMS (roadmap 4.4) — the opt-in `flowIn` flag.
 *
 * Every cross-command seam used to brake to zero: buildComposedTrajectory marks
 * the START knot a stop, so a motion chained after a walk/kick eases in from
 * rest and the carried momentum dies at the seam. With `flowIn` the FIRST knot
 * becomes a fly-through (stop:false — the same boundary mechanics `cyclicEnds`
 * uses, applied to the entry only): the chained motion ENTERS with velocity
 * while its FINAL keyframe still settles to a genuine stop.
 *
 * Gated at the TRAJECTORY level (entry velocity nonzero with the flag, final
 * settle still stops, knot arrival / measurement contract byte-exact, and an
 * unflagged build byte-identical to today) plus the resolveComposedMotion
 * threading (pass-through like settleEnds). This is the ENGINE primitive —
 * nothing app-side sets it.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';
import { resolveComposedMotion } from '../services/motionSequence';
import {
  buildComposedTrajectory,
  type SequenceBuildLike,
} from '../services/motionTrajectory';

const IDENT: [number, number, number, number] = [0, 0, 0, 1];

function rotX(deg: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (deg * Math.PI) / 180,
  );
  return [q.x, q.y, q.z, q.w];
}

/** SIGNED rotation (deg) about +X of a pose quaternion (small-angle safe). */
function signedXDeg(q: [number, number, number, number]): number {
  return (2 * Math.atan2(q[0], q[3]) * 180) / Math.PI;
}

function pose(keys: string[], deg: number): CustomPose {
  return {
    variant: 'male',
    bones: Object.fromEntries(keys.map((k) => [k, rotX(deg)])),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}

function built(keys: string[], degs: number[], durationsMs: number[]): SequenceBuildLike {
  return {
    poses: degs.map((d) => pose(keys, d)),
    roots: degs.map((_, i) => ({
      quat: [...IDENT] as [number, number, number, number],
      // Forward travel from the very first segment, so the entry-velocity gate
      // can read the root channel too.
      translateM: [0, 0, (i + 1) * 0.1] as [number, number, number],
      stance: 'planted' as const,
    })),
    durationsMs,
    holdsMs: degs.map(() => 0),
  };
}

// Hips carries zero follow-through delay, so its samples read the raw time-warp.
const KEYS = ['Hips'];
const START = {
  startPose: pose(KEYS, 0),
  startQuat: [...IDENT] as [number, number, number, number],
  startTranslate: [0, 0, 0] as [number, number, number],
  timeScale: 1,
};

/** |d(pose)/dt| of the Hips X rotation (deg/ms) around tMs. */
function boneSpeedAt(
  traj: ReturnType<typeof buildComposedTrajectory>['trajectory'],
  tMs: number,
  dt = 8,
): number {
  const a = signedXDeg(traj.sampleAt(tMs).pose.bones.Hips!);
  const b = signedXDeg(traj.sampleAt(tMs + dt).pose.bones.Hips!);
  return Math.abs(b - a) / dt;
}

/** |d(rootZ)/dt| (m/ms) around tMs. */
function rootSpeedAt(
  traj: ReturnType<typeof buildComposedTrajectory>['trajectory'],
  tMs: number,
  dt = 8,
): number {
  const a = traj.sampleAt(tMs).rootTranslate[2];
  const b = traj.sampleAt(tMs + dt).rootTranslate[2];
  return Math.abs(b - a) / dt;
}

describe('flowIn — trajectory-level momentum seam', () => {
  const mk = (opts: { flowIn?: boolean; cyclicEnds?: boolean } = {}) =>
    buildComposedTrajectory(built(KEYS, [60, 0], [500, 500]), { ...START, ...opts });

  it('with flowIn the FIRST segment enters at nonzero velocity; without it the entry eases from rest', () => {
    const flow = mk({ flowIn: true }).trajectory;
    const brake = mk().trajectory;
    const entryFlow = boneSpeedAt(flow, 0);
    const entryBrake = boneSpeedAt(brake, 0);
    const midSpeed = boneSpeedAt(brake, 250); // steady mid-segment reference
    // eslint-disable-next-line no-console
    console.log(
      `entry speed: flowIn ${(entryFlow * 1000).toFixed(1)}°/s vs stop ${(entryBrake * 1000).toFixed(1)}°/s (mid ${(midSpeed * 1000).toFixed(1)}°/s)`,
    );
    // Braking entry: the ease-in slope at t=0 is ~0 (a genuine stop knot).
    expect(entryBrake, 'default entry starts from rest').toBeLessThan(midSpeed * 0.15);
    // Flowing entry: a real fraction of the mid-segment PEAK speed from t=0
    // (the PCHIP entry slope is the segment secant — ~1/2 the eased peak),
    // and an order of magnitude above the braking entry.
    expect(entryFlow, 'flowIn enters with velocity').toBeGreaterThan(midSpeed * 0.25);
    expect(entryFlow, 'flowIn entry dwarfs the braking entry').toBeGreaterThan(entryBrake * 8);
    // Root travel flows in too (the seam carries whole-body momentum).
    expect(rootSpeedAt(flow, 0), 'root travel enters moving').toBeGreaterThan(
      rootSpeedAt(brake, 0) * 3,
    );
  });

  it('the FINAL settle still stops with flowIn — only the entry is freed', () => {
    const flow = mk({ flowIn: true }).trajectory;
    // Velocity at the very end ≈ 0 (the last knot keeps its stop), and the
    // final pose is exact.
    const endSpeed = boneSpeedAt(flow, flow.totalMs - 8);
    const midSpeed = boneSpeedAt(flow, 750);
    expect(endSpeed, 'the ending still brakes to rest').toBeLessThan(midSpeed * 0.15);
    expect(signedXDeg(flow.sampleAt(flow.totalMs).pose.bones.Hips!)).toBeCloseTo(0, 4);
  });

  it('knot arrival (the settle/measurement contract) is exact with flowIn', () => {
    const { trajectory, settleAtMs } = mk({ flowIn: true });
    expect(settleAtMs).toEqual([500, 1000]);
    expect(signedXDeg(trajectory.sampleAt(500).pose.bones.Hips!), 'kf0 pose at its knot').toBeCloseTo(60, 4);
    expect(signedXDeg(trajectory.sampleAt(1000).pose.bones.Hips!), 'final pose at its knot').toBeCloseTo(0, 4);
    expect(trajectory.sampleAt(500).rootTranslate[2]).toBeCloseTo(0.1, 6);
    expect(trajectory.sampleAt(1000).rootTranslate[2]).toBeCloseTo(0.2, 6);
  });

  it('WITHOUT the flag the build is byte-identical to an explicit flowIn:false (today)', () => {
    const a = mk().trajectory;
    const b = mk({ flowIn: false }).trajectory;
    expect(a.totalMs).toBe(b.totalMs);
    for (let t = 0; t <= a.totalMs; t += 37) {
      const sa = a.sampleAt(t);
      const sb = b.sampleAt(t);
      expect(sa.pose.bones).toEqual(sb.pose.bones);
      expect(sa.rootTranslate).toEqual(sb.rootTranslate);
      expect(sa.rootQuat).toEqual(sb.rootQuat);
    }
  });

  it('interior HOLDS remain genuine stops under flowIn', () => {
    const held: SequenceBuildLike = {
      ...built(KEYS, [60, 0], [500, 500]),
      holdsMs: [200, 0],
    };
    const { trajectory } = buildComposedTrajectory(held, { ...START, flowIn: true });
    // Mid-hold (kf0 arrives at 500, holds to 700): pose constant at 60°.
    expect(signedXDeg(trajectory.sampleAt(550).pose.bones.Hips!)).toBeCloseTo(60, 3);
    expect(signedXDeg(trajectory.sampleAt(650).pose.bones.Hips!)).toBeCloseTo(60, 3);
    expect(boneSpeedAt(trajectory, 590), 'held keyframe stays a stop').toBeLessThan(1e-4);
  });
});

describe('flowIn — resolveComposedMotion threading (like settleEnds)', () => {
  const plan = (extra: Record<string, unknown> = {}) => ({
    name: 'chained squat',
    keyframes: [
      {
        durationMs: 600,
        targets: [
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 60 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 60 },
        ],
      },
      {
        durationMs: 600,
        targets: [
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
        ],
      },
    ],
    ...extra,
  });

  it('passes flowIn through on the resolved motion; absent when unflagged', () => {
    const flagged = resolveComposedMotion(plan({ flowIn: true }));
    expect(flagged.status).toBe('ok');
    expect(flagged.flowIn).toBe(true);
    const plain = resolveComposedMotion(plan());
    expect(plain.status).toBe('ok');
    expect(plain.flowIn).toBeUndefined();
    // The flag never changes the resolved keyframes themselves (timing,
    // clamped targets and the velocity-floor contract are entry-shape-agnostic).
    expect(flagged.keyframes).toEqual(plain.keyframes);
    expect(flagged.outcomes).toEqual(plain.outcomes);
  });
});
