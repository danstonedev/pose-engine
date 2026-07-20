/**
 * PER-VELOCITY-CLASS SETTLE SHAPES (Wave 5, roadmap 5.5).
 *
 * One symmetric cubic ease used to serve every weight and effort class: a
 * surgeon's deliberate reach and a kick's ballistic recovery braked into their
 * stops with the identical deceleration profile. The trajectory time-warp now
 * shapes the segment ARRIVING at a stop knot by the arriving keyframe's
 * velocity class — the within-segment parameter composes the late-brake warp
 * w(s) = s·(1 − b·s·(1−s)) (endpoints and the C¹ entry slope are fixed points):
 *
 *   • 'deliberate' (and unclassed)  b = 0     — today's symmetric ease,
 *     BYTE-IDENTICAL (asserted sample-for-sample);
 *   • 'functional'                  b = 0.75  — holds speed longer, brakes
 *     later and brisker;
 *   • 'ballistic'                   b = 1.5   — brakes latest, composing with
 *     the existing terminal overshoot knot (roadmap 2.3).
 *
 * Invariants gated here: u(t_k) = k EXACT (knot arrival — the measurement
 * contract), monotone progress (Fritsch–Carlson intact), zero velocity at the
 * stop, and the dv/dt ORDERING — the ballistic profile brakes later than
 * functional, functional later than deliberate.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';
import {
  buildComposedTrajectory,
  buildPoseTrajectory,
  type PoseTrajectory,
  type SequenceBuildLike,
  type TrajectoryKnot,
} from '../services/motionTrajectory';

const IDENT: [number, number, number, number] = [0, 0, 0, 1];

function rotX(deg: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (deg * Math.PI) / 180);
  return [q.x, q.y, q.z, q.w];
}
/** Measured on 'Hips' — zero follow-through delay, so these pin the shared
 *  time-warp core (same choice as motionTrajectory.test.ts). */
function pose(deg: number): CustomPose {
  return { variant: 'male', bones: { Hips: rotX(deg) }, schemaVersion: POSE_SCHEMA_VERSION };
}
function knot(
  timeMs: number,
  deg: number,
  stop: boolean,
  settleClass?: TrajectoryKnot['settleClass'],
): TrajectoryKnot {
  return {
    timeMs,
    pose: pose(deg),
    rootQuat: IDENT,
    rootTranslate: [0, 0, 0],
    stop,
    ...(settleClass ? { settleClass } : {}),
    planted: false,
  };
}
function angleAt(traj: PoseTrajectory, tMs: number): number {
  const q = traj.sampleAt(tMs).pose.bones.Hips!;
  const w = Math.min(1, Math.abs(q[3]));
  return (2 * Math.acos(w) * 180) / Math.PI;
}
function speedAt(traj: PoseTrajectory, tMs: number, dt = 0.5): number {
  return Math.abs(angleAt(traj, tMs + dt) - angleAt(traj, tMs - dt)) / (2 * dt);
}
/** Latest time in [t0, t1] whose speed is ≥ frac of the window's peak speed —
 *  "when does the profile stop holding speed and commit to the brake". */
function lastFastMs(traj: PoseTrajectory, t0: number, t1: number, frac = 0.9): number {
  let peak = 0;
  for (let t = t0 + 2; t <= t1 - 2; t += 2) peak = Math.max(peak, speedAt(traj, t));
  let last = t0;
  for (let t = t0 + 2; t <= t1 - 2; t += 2) if (speedAt(traj, t) >= frac * peak) last = t;
  return last;
}

/** start(0°, stop) → fly-through(45°) → final stop(90°) with the given class. */
function reach(settleClass?: TrajectoryKnot['settleClass']): PoseTrajectory {
  return buildPoseTrajectory([
    knot(0, 0, true),
    knot(500, 45, false),
    knot(1000, 90, true, settleClass),
  ]);
}

describe('settle shapes — deliberate keeps the symmetric ease BYTE-IDENTICAL', () => {
  it("an explicit 'deliberate' class samples bit-for-bit like an unclassed stop", () => {
    const base = reach();
    const explicit = reach('deliberate');
    for (let t = 0; t <= 1000; t += 7) {
      const a = base.sampleAt(t).pose.bones.Hips!;
      const b = explicit.sampleAt(t).pose.bones.Hips!;
      // Exact float equality — the b = 0 path is the pre-shape code path.
      expect(b[0]).toBe(a[0]);
      expect(b[1]).toBe(a[1]);
      expect(b[2]).toBe(a[2]);
      expect(b[3]).toBe(a[3]);
    }
  });

  it('a settle class on a NON-stop knot is ignored (fly-throughs never brake)', () => {
    const base = buildPoseTrajectory([
      knot(0, 0, true),
      knot(500, 45, false),
      knot(1000, 90, true),
    ]);
    const classedInterior = buildPoseTrajectory([
      knot(0, 0, true),
      { ...knot(500, 45, false), settleClass: 'ballistic' },
      knot(1000, 90, true),
    ]);
    for (let t = 0; t <= 1000; t += 11) {
      expect(angleAt(classedInterior, t)).toBe(angleAt(base, t));
    }
  });
});

describe('settle shapes — functional/ballistic brake LATER (dv/dt ordering)', () => {
  const deliberate = reach();
  const functional = reach('functional');
  const ballistic = reach('ballistic');

  it('knot arrival stays EXACT for every class (u(t_k) = k — the measurement contract)', () => {
    for (const [name, traj] of [
      ['deliberate', deliberate],
      ['functional', functional],
      ['ballistic', ballistic],
    ] as const) {
      expect(angleAt(traj, 0), `${name} start`).toBeCloseTo(0, 4);
      expect(angleAt(traj, 500), `${name} interior knot`).toBeCloseTo(45, 3);
      expect(angleAt(traj, 1000), `${name} final knot`).toBeCloseTo(90, 3);
      // …and the stop still arrives at rest.
      expect(speedAt(traj, 997), `${name} zero-velocity stop`).toBeLessThan(0.02);
    }
  });

  it('progress stays MONOTONE for every class (Fritsch–Carlson intact)', () => {
    for (const traj of [functional, ballistic]) {
      let prev = -1e-9;
      for (let t = 0; t <= 1000; t += 5) {
        const a = angleAt(traj, t);
        expect(a).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = a;
      }
    }
  });

  it('mid-approach progress LAGS in class order (speed is held longer before the stop)', () => {
    // 70% into the braking segment: the late-brake profiles are still behind.
    const t = 500 + 0.7 * 500;
    const dDel = angleAt(deliberate, t);
    const dFun = angleAt(functional, t);
    const dBal = angleAt(ballistic, t);
    expect(dFun, 'functional lags deliberate').toBeLessThan(dDel - 1);
    expect(dBal, 'ballistic lags functional').toBeLessThan(dFun - 1);
  });

  it('the deceleration commits LATER in class order (last ≥90%-of-peak-speed instant)', () => {
    const tDel = lastFastMs(deliberate, 500, 1000);
    const tFun = lastFastMs(functional, 500, 1000);
    const tBal = lastFastMs(ballistic, 500, 1000);
    // eslint-disable-next-line no-console
    console.log(`settle brake commit: deliberate ${tDel}ms · functional ${tFun}ms · ballistic ${tBal}ms`);
    expect(tFun, 'functional brakes later than deliberate').toBeGreaterThan(tDel + 20);
    expect(tBal, 'ballistic brakes latest').toBeGreaterThan(tFun + 20);
  });

  it('a HELD interior keyframe with a functional class shapes its approach too — arrival + hold exact', () => {
    const base = buildPoseTrajectory([
      knot(0, 0, true),
      knot(600, 45, true), // hold arrival (deliberate)
      knot(800, 45, true), // hold end
      knot(1300, 90, true),
    ]);
    const shaped = buildPoseTrajectory([
      knot(0, 0, true),
      knot(600, 45, true, 'functional'),
      knot(800, 45, true),
      knot(1300, 90, true),
    ]);
    // Approach into the hold lags mid-segment…
    expect(angleAt(shaped, 450)).toBeLessThan(angleAt(base, 450) - 0.5);
    // …but the hold arrival, the dwell, and everything after are exact.
    expect(angleAt(shaped, 600)).toBeCloseTo(45, 3);
    expect(angleAt(shaped, 700)).toBeCloseTo(45, 3);
    expect(angleAt(shaped, 1300)).toBeCloseTo(90, 3);
    for (let t = 810; t <= 1300; t += 10) expect(angleAt(shaped, t)).toBe(angleAt(base, t));
  });
});

// ── through buildComposedTrajectory (velocityClasses threading) ──────────────

function built(classes?: SequenceBuildLike['velocityClasses'], holdsMs?: number[]): SequenceBuildLike {
  const degs = [40, 90];
  return {
    poses: degs.map((d) => pose(d)),
    roots: degs.map(() => ({
      quat: [...IDENT] as [number, number, number, number],
      translateM: [0, 0, 0] as [number, number, number],
      stance: 'planted' as const,
    })),
    durationsMs: [400, 600],
    holdsMs: holdsMs ?? [0, 0],
    ...(classes ? { velocityClasses: classes } : {}),
  };
}

const START_OPTS = {
  startPose: pose(0),
  startQuat: [...IDENT] as [number, number, number, number],
  startTranslate: [0, 0, 0] as [number, number, number],
  timeScale: 1,
};

describe('settle shapes — threaded from the resolved keyframe velocity classes', () => {
  it('an all-deliberate build is byte-identical to an unclassed build', () => {
    const a = buildComposedTrajectory(built(), START_OPTS);
    const b = buildComposedTrajectory(built(['deliberate', 'deliberate']), START_OPTS);
    expect(b.settleAtMs).toEqual(a.settleAtMs);
    for (let t = 0; t <= a.trajectory.totalMs; t += 13) {
      expect(angleAt(b.trajectory, t)).toBe(angleAt(a.trajectory, t));
    }
  });

  it('a BALLISTIC final keyframe brakes later than deliberate AND still settles exactly (with its overshoot)', () => {
    const del = buildComposedTrajectory(built(), START_OPTS);
    const bal = buildComposedTrajectory(built([undefined, 'ballistic']), START_OPTS);
    const settle = bal.settleAtMs[1]!;
    expect(settle).toBe(1000);
    // The final pose is EXACT at the settle instant (the overshoot knot and the
    // late brake both live strictly before it).
    expect(angleAt(bal.trajectory, settle)).toBeCloseTo(90, 3);
    expect(speedAt(bal.trajectory, settle - 2)).toBeLessThan(0.03);
    // The ballistic ending overshoots (roadmap 2.3 composes with 5.5)…
    let peak = 0;
    for (let t = 400; t <= settle; t += 2) peak = Math.max(peak, angleAt(bal.trajectory, t));
    expect(peak, 'sails past the target before settling').toBeGreaterThan(90.5);
    // …and its deceleration commits later than the deliberate ending's.
    const tDel = lastFastMs(del.trajectory, 400, 1000);
    const tBal = lastFastMs(bal.trajectory, 400, 1000);
    // eslint-disable-next-line no-console
    console.log(`composed brake commit: deliberate ${tDel}ms · ballistic ${tBal}ms`);
    expect(tBal, 'ballistic brakes later than deliberate').toBeGreaterThan(tDel + 20);
  });

  it('a FUNCTIONAL held keyframe mid-motion shapes only its own approach', () => {
    const base = buildComposedTrajectory(built(undefined, [300, 0]), START_OPTS);
    const fun = buildComposedTrajectory(built(['functional', undefined], [300, 0]), START_OPTS);
    // Approach into the held keyframe (0..400ms) lags…
    expect(angleAt(fun.trajectory, 300)).toBeLessThan(angleAt(base.trajectory, 300) - 0.5);
    // …the hold arrival is exact and the dwell rests…
    expect(angleAt(fun.trajectory, 400)).toBeCloseTo(40, 3);
    expect(speedAt(fun.trajectory, 550)).toBeLessThan(0.001);
    // …and the segments AFTER the hold are byte-identical.
    for (let t = 705; t <= 1300; t += 11) {
      expect(angleAt(fun.trajectory, t)).toBe(angleAt(base.trajectory, t));
    }
  });
});
