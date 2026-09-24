/**
 * FOLLOW-THROUGH CONTINUITY — the proximal→distal stagger must delay a bone,
 * never jerk it.
 *
 * The trajectory's follow-through warp used to be clamp((local − d)/(1 − d)),
 * applied to every segment's already-EASED parameter. That froze a delayed bone
 * for the first d of each segment and then started it at 1/(1 − d) × the
 * chain's current speed, so:
 *   • ONSET — a bone leaving rest jumped from still to full speed in one frame:
 *     measured on the DDx chair stand's folded forearms at 120 Hz, still until
 *     133 ms, then 43 → 235°/s from one frame to the next (the signed
 *     elbowFlexion readout shows a separate one-frame spike at onset: the hinge
 *     readout flips sign as the elbow leaves its rest pose, so read bone speed
 *     or |elbowFlexion| to see the motion);
 *   • KNOTS — every delayed bone stopped dead at every fly-through keyframe and
 *     restarted: on the engine's own travel walk, every one of the 35 left-arm
 *     bone/keyframe pairs moving through a keyframe dropped to 0°/s.
 * The dwell now runs in raw TIME before the ease (motionStagger.delayedOnset,
 * the stage tween's own scheme), only where the bone is at rest (a stop), and a
 * fly-through keyframe keeps one C¹ slope that shrinks where the bone's path
 * reverses (motionStagger.followThroughKnotSlope).
 *
 * Those two alone left no NET lag between keyframes: straight on through one a
 * bone kept the chain's speed, and a turn's slowdown made it reach the turn as
 * early as it left it late, so the travel walk's distal arm bones crossed
 * mid-swing −8 to +3.3 ms from a lockstep build. A stroke that flies through a
 * keyframe at both ends now also trails inside it
 * (motionStagger.followThroughStrokeLag), still C¹, exact at every knot, never
 * backwards and never faster than the onset dwell's own 1/(1 − d) × the chain —
 * gated here too.
 *
 * Gated PURE (single-axis chains, signed angle, 0.1 ms finite differences; one
 * curved loop) and ON THE RIG (the travel walk every gait task is built on,
 * across its 0.6–1.5 pace range; the run and sprint loops; a sit-down with the
 * arms folded, the DDx chair stand's shape). Exact knot arrival — the
 * measurement contract — is pinned alongside.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { buildSequencePoses, resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import {
  buildComposedTrajectory,
  buildLoopTrajectory,
  buildPoseTrajectory,
  type PoseTrajectory,
  type SequenceBuildLike,
  type TrajectoryKnot,
} from '../services/motionTrajectory';
import {
  chainOnsetDelay,
  followThroughKnotSlope,
  followThroughStrokeLag,
  PROXIMAL_TO_DISTAL_STAGGER,
  stagedBlendWithBaseline,
  trajectoryBoneDelay,
} from '../services/motionStagger';
import { clearFollowThroughStrokeMemo, strokeSquadTable } from '../services/followThroughStroke';
import { buildRun, buildSitDown, buildTravelWalk } from '../services/movementTemplates';
import { clampTimeScale } from '../services/motionConstants';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

type Q = [number, number, number, number];
const IDENT: Q = [0, 0, 0, 1];

/** Rotation of `deg` about `axis` (normalized here). */
function rot(deg: number, axis: [number, number, number]): Q {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), (deg * Math.PI) / 180);
  return [q.x, q.y, q.z, q.w];
}
const rotX = (deg: number): Q => rot(deg, [1, 0, 0]);
/** Signed rotation (deg) about +X — exact for the single-axis test chains. */
const xDeg = (q: Q): number => (2 * Math.atan2(q[0], q[3]) * 180) / Math.PI;
/** Geodesic angle (deg) of a→b, well conditioned at tiny angles (atan2 of the
 *  relative rotation — acos of a dot product rounds a 0.01° step to zero). */
function geoDeg(a: Q, b: Q): number {
  const [ax, ay, az, aw] = [-a[0], -a[1], -a[2], a[3]];
  const [bx, by, bz, bw] = b;
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  return (2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w)) * 180) / Math.PI;
}

// The arm chain proximal → distal, and the undelayed chain origin it is judged
// against (same authored series, delay 0).
const ARM = ['L_Shoulder', 'L_UpperArm', 'L_Forearm', 'L_Hand', 'L_Index1'];
const ORIGIN = 'Hips';
const KEYS = [ORIGIN, ...ARM];

function chainPose(deg: number): CustomPose {
  return {
    variant: 'male',
    bones: Object.fromEntries(KEYS.map((k) => [k, rotX(deg)])),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}
function built(
  degs: number[],
  durationsMs: number[],
  opts: { holdsMs?: number[]; velocityClasses?: SequenceBuildLike['velocityClasses'] } = {},
): SequenceBuildLike {
  return {
    poses: degs.map(chainPose),
    roots: degs.map(() => ({ quat: [...IDENT] as Q, translateM: [0, 0, 0] as [number, number, number], stance: 'planted' })),
    durationsMs,
    holdsMs: opts.holdsMs ?? degs.map(() => 0),
    ...(opts.velocityClasses ? { velocityClasses: opts.velocityClasses } : {}),
  };
}
const FROM_REST = {
  startPose: chainPose(0),
  startQuat: [...IDENT] as Q,
  startTranslate: [0, 0, 0] as [number, number, number],
  timeScale: 1,
};

/** Fine step (ms) for the finite differences: a velocity STEP survives any
 *  step size, while a C¹ motion's frame-to-frame velocity change shrinks with
 *  it (here to ≲0.2°/s against steps of 100°/s and more). */
const DT = 0.1;

/** Signed angular velocity (°/s) of a single-axis bone over [t0, t1]. */
function velocities(traj: PoseTrajectory, key: string, t0: number, t1: number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  let prev = xDeg(traj.sampleAt(t0).pose.bones[key] as Q);
  for (let t = t0 + DT; t <= t1 + 1e-9; t += DT) {
    const cur = xDeg(traj.sampleAt(t).pose.bones[key] as Q);
    out.push({ t: t - DT / 2, v: (cur - prev) / (DT / 1000) });
    prev = cur;
  }
  return out;
}
const maxStep = (vs: { v: number }[]): number => {
  let m = 0;
  for (let i = 1; i < vs.length; i += 1) m = Math.max(m, Math.abs(vs[i]!.v - vs[i - 1]!.v));
  return m;
};
const peakSpeed = (vs: { v: number }[]): number => Math.max(...vs.map((p) => Math.abs(p.v)));

describe('follow-through onset — a delayed bone leaves rest with zero velocity (C¹)', () => {
  const cases: [string, SequenceBuildLike][] = [
    // One stroke from rest: stop → stop.
    ['a reach from rest (stop → stop)', built([90], [600])],
    // The DDx arms-folded overlay: the fold is reached by the first keyframe and
    // then held through fly-through keyframes of a longer motion (stop → fly).
    ['arms folded from rest, then held through fly-through keyframes', built([110, 110, 110], [500, 500, 400])],
  ];
  for (const [label, motion] of cases) {
    it(label, () => {
      const { trajectory, settleAtMs } = buildComposedTrajectory(motion, FROM_REST);
      const end = settleAtMs[0]!; // the first stroke — out of rest
      const origin = velocities(trajectory, ORIGIN, 0, end);
      for (const key of ARM) {
        const d = trajectoryBoneDelay(key);
        expect(d, key).toBeGreaterThan(0);
        const vs = velocities(trajectory, key, 0, end);
        const peak = peakSpeed(vs);
        // It dwells at rest first — the sequencing is still there…
        const first = vs.findIndex((p) => Math.abs(p.v) > 1e-9);
        expect(vs[first]!.t, `${key} starts after the chain origin`).toBeGreaterThan(0.5 * d * end);
        // …and leaves it with ZERO velocity (base: a step — its first moving
        // 120 Hz frame ran at 41–70% of the bone's peak).
        expect(Math.abs(vs[first]!.v), `${key} first-moving speed vs peak ${peak.toFixed(0)}°/s`).toBeLessThan(0.02 * peak);
        // No velocity step anywhere: the delayed bone's worst change over 0.1 ms
        // is its compressed ease's (≤ 1/(1 − d)² ≈ 1.49× the origin's), never a
        // jump (base: 100–190°/s in one 0.1 ms step).
        expect(maxStep(vs), `${key} worst velocity change per ${DT} ms`).toBeLessThan(2 * maxStep(origin));
        // Peak inflation stays the documented 1/(1 − d), to within the 2% a
        // stroke that flows on (stop → fly) adds by arriving at the chain's speed.
        expect(peak / peakSpeed(origin), `${key} peak speed vs the origin's`).toBeLessThan(1.03 / (1 - d));
      }
    });
  }

  it('the trajectory and the stage tween dwell for the SAME raw time: delay × the stroke', () => {
    // One shared onset warp (motionStagger.delayedOnset). Base: the trajectory
    // applied it to the EASED parameter, so its fingers left rest at 27% of the
    // stroke while the stage tween's left at 18%.
    const T = 600;
    const { trajectory } = buildComposedTrajectory(built([90], [T]), FROM_REST);
    const rest = chainPose(0);
    const target = chainPose(90);
    const lastStill = (moved: (t: number) => boolean): number => {
      let t = 0;
      while (t < T && !moved(t + DT)) t += DT;
      return t;
    };
    for (const key of ARM) {
      const tweenDelay = chainOnsetDelay(key) * PROXIMAL_TO_DISTAL_STAGGER;
      expect(trajectoryBoneDelay(key), key).toBeCloseTo(tweenDelay, 12); // same delay on the arm chain
      const trajStill = lastStill((t) => Math.abs(xDeg(trajectory.sampleAt(t).pose.bones[key] as Q)) > 1e-9);
      const tweenStill = lastStill(
        (t) => Math.abs(xDeg(stagedBlendWithBaseline(rest, target, rest, t / T)!.bones[key] as Q)) > 1e-9,
      );
      expect(trajStill, `${key} trajectory dwell (ms)`).toBeCloseTo(tweenDelay * T, 0);
      expect(tweenStill, `${key} tween dwell (ms)`).toBeCloseTo(tweenDelay * T, 0);
    }
  });
});

describe('follow-through through fly-through keyframes — no stall, no velocity jump', () => {
  interface Case {
    label: string;
    traj: PoseTrajectory;
    knots: number[];
  }
  const cases = (): Case[] => {
    // Onward through two waypoints (the chain never turns back).
    const onward = buildComposedTrajectory(built([40, 80, 120], [400, 400, 400]), FROM_REST);
    // A gait-like swing flowing through every keyframe, both as the cyclic
    // composed pass a travelling walk plays and as the stage's looping form.
    const swingDegs = [20, 30, 20, 0, -20, -30, -20, 0, 20, 30, 20, 0];
    const swing = built(swingDegs, swingDegs.map(() => 130));
    const cyclic = buildComposedTrajectory(swing, { ...FROM_REST, cyclicEnds: true });
    const loop = buildLoopTrajectory(swing, { timeScale: 1 });
    const loopKnots: number[] = [];
    for (let i = 1, t = 0; i < swingDegs.length; i += 1) loopKnots.push((t += 130));
    return [
      { label: 'onward through two waypoints', traj: onward.trajectory, knots: onward.settleAtMs.slice(0, -1) },
      { label: 'gait-like swing, cyclic ends', traj: cyclic.trajectory, knots: cyclic.settleAtMs.slice(0, -1) },
      { label: 'gait-like swing, loop form', traj: loop.trajectory, knots: loopKnots.slice(0, -1) },
    ];
  };

  it('a delayed bone keeps the chain’s speed through every keyframe it passes straight through', () => {
    for (const { label, traj, knots } of cases()) {
      const vAt = (key: string, t: number) =>
        (xDeg(traj.sampleAt(t + 0.05).pose.bones[key] as Q) - xDeg(traj.sampleAt(t - 0.05).pose.bones[key] as Q)) / 0.1e-3;
      const originPeak = peakSpeed(velocities(traj, ORIGIN, 0, traj.totalMs));
      for (const tk of knots) {
        for (const at of [tk - 1, tk + 1]) {
          const vo = vAt(ORIGIN, at);
          if (Math.abs(vo) < 0.25 * originPeak) continue; // a turn: everyone is near rest
          for (const key of ARM) {
            // Base: 0°/s just after the knot (the delayed bone stopped dead).
            expect(vAt(key, at) / vo, `${label}: ${key} at ${at.toFixed(0)} ms (origin ${vo.toFixed(0)}°/s)`).toBeGreaterThan(0.9);
          }
        }
      }
    }
  });

  it('…and its velocity is continuous everywhere, turns included', () => {
    for (const { label, traj } of cases()) {
      const origin = velocities(traj, ORIGIN, 0, traj.totalMs);
      for (const key of ARM) {
        const vs = velocities(traj, key, 0, traj.totalMs);
        expect(maxStep(vs), `${label}: ${key} worst velocity change per ${DT} ms`).toBeLessThan(2 * maxStep(origin));
        expect(peakSpeed(vs) / peakSpeed(origin), `${label}: ${key} peak vs origin`).toBeLessThan(
          1.03 / (1 - trajectoryBoneDelay(key)),
        );
      }
    }
  });

  it('the slowdown through a turn costs exactly what the onset dwell does: a stroke between two turns peaks at 1/(1 − d)', () => {
    // 0 → 60 → 0 → 60 → 0: every interior keyframe is a full reversal, so the
    // two middle strokes run turn to turn on the floored slope at both ends.
    const { trajectory, settleAtMs } = buildComposedTrajectory(built([60, 0, 60, 0], [300, 300, 300, 300]), FROM_REST);
    const [from, to] = [settleAtMs[0]!, settleAtMs[2]!];
    const originPeak = peakSpeed(velocities(trajectory, ORIGIN, from, to));
    for (const key of ARM) {
      const ratio = peakSpeed(velocities(trajectory, key, from, to)) / originPeak;
      expect(ratio, key).toBeCloseTo(1 / (1 - trajectoryBoneDelay(key)), 3);
    }
  });

  it('where the path turns back, the distal bone trails the chain out of the turn (the follow-through cue)', () => {
    // Out and back through a fly-through reversal: after the turn the deeper a
    // bone sits in the chain, the further behind it runs.
    const { trajectory, settleAtMs } = buildComposedTrajectory(built([60, 0], [500, 500]), FROM_REST);
    const s = trajectory.sampleAt(settleAtMs[0]! + 120).pose.bones;
    const deg = (k: string) => xDeg(s[k] as Q);
    const order = [ORIGIN, ...ARM];
    for (let i = 1; i < order.length; i += 1) {
      expect(deg(order[i]!), `${order[i]} still further out than ${order[i - 1]}`).toBeGreaterThan(deg(order[i - 1]!));
    }
  });
});

describe('follow-through LAG — a flowing stroke keeps the chain sequenced, not just its turns', () => {
  // Time (ms) past the middle of [t0, t1] at which `key` reaches the angle the
  // undelayed origin has there — bisection on a stroke both sweep monotonically.
  function midStrokeLagMs(traj: PoseTrajectory, key: string, t0: number, t1: number): number {
    const at = (k: string, t: number) => xDeg(traj.sampleAt(t).pose.bones[k] as Q);
    const tm = (t0 + t1) / 2;
    const target = at(ORIGIN, tm);
    const dir = Math.sign(at(ORIGIN, t1) - at(ORIGIN, t0));
    let lo = t0;
    let hi = t1;
    for (let i = 0; i < 60; i += 1) {
      const m = (lo + hi) / 2;
      if ((at(key, m) - target) * dir < 0) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2 - tm;
  }

  it('an 8-keyframe swing loop: every delayed arm bone crosses the middle of every stroke late, deeper bones later', () => {
    // The stage's looping form of a gait-like swing (130 ms strokes; turns at
    // ±30°, straight on through ±20° and 0°). On the knot slopes alone the
    // fingers crossed the straight-on strokes in lockstep and the strokes into
    // a turn 6.4 ms EARLY (2504a7e): no net lag over the cycle. The per-segment
    // dwell of 5c1c9ac trailed 11.7 ms everywhere, by stopping at every knot.
    const degs = [20, 30, 20, 0, -20, -30, -20, 0];
    const T = 130;
    const { trajectory } = buildLoopTrajectory(built(degs, degs.map(() => T)), { timeScale: 1 });
    const fingerLags: number[] = [];
    for (let i = 0; i < degs.length; i += 1) {
      const [t0, t1] = [i * T, (i + 1) * T];
      let prevLag = 0;
      for (const key of ARM) {
        const lag = midStrokeLagMs(trajectory, key, t0, t1);
        expect(lag, `${key}, stroke ${degs[i]}° → ${degs[(i + 1) % degs.length]}°`).toBeGreaterThan(prevLag + 0.1);
        prevLag = lag;
      }
      fingerLags.push(prevLag);
    }
    // The budget is the onset dwell's own mid-stroke trail, d/2 of the stroke
    // (11.7 ms here), cut where it would run the bone faster than 1/(1 − d) ×
    // the chain (measured 4.3–9.4 ms, 7.9 on average); gate half the budget.
    const mean = fingerLags.reduce((a, b) => a + b, 0) / fingerLags.length;
    const budget = (trajectoryBoneDelay('L_Index1') / 2) * T;
    expect(mean, `fingers' mean mid-stroke lag, ms (budget ${budget.toFixed(1)})`).toBeGreaterThan(budget / 2);
    expect(Math.max(...fingerLags), 'never more than the budget').toBeLessThanOrEqual(budget + 1e-6);
  });

  it('…and never runs a bone faster than 1/(1 − d) × the chain through a stroke, however unevenly its path is paced', () => {
    // A curved, unevenly timed loop. SQUAD paces each stroke's path by its knot
    // tangents, so a bone's progress rate is not its speed: capping only the
    // rate (191256f) let the trail hurry the fingers along the fast end of a
    // stroke at 1.097 × 1/(1 − d) × the chain. The cap is on the angular speed
    // now too: measured ≤ 1.001 (the engine checks a sampled speed profile, the
    // 0.5% here allows for it); 2504a7e, with no trail, 0.95.
    const X: [number, number, number] = [1, 0, 0];
    const qs = [rot(0, X), rot(30, [1, 0.5, 0]), rot(40, [0.2, 1, 0]), rot(10, [0, 1, 1]), rot(-25, [1, 0, 0.4]), rot(-30, [1, 0.3, 0])];
    const durations = [150, 110, 180, 140, 100, 170];
    const { trajectory } = buildLoopTrajectory(
      {
        poses: qs.map((q) => ({ variant: 'male', bones: Object.fromEntries(KEYS.map((k) => [k, q])), schemaVersion: POSE_SCHEMA_VERSION })),
        roots: qs.map(() => ({ quat: [...IDENT] as Q, translateM: [0, 0, 0] as [number, number, number], stance: 'planted' })),
        durationsMs: durations,
        holdsMs: qs.map(() => 0),
      },
      { timeScale: 1 },
    );
    // The loop's keyframes sit at the running sum of the durations INTO them;
    // the wrap back to the first takes the first duration.
    const knots = [0];
    for (let i = 1; i < durations.length; i += 1) knots.push(knots[i - 1]! + durations[i]!);
    knots.push(knots[knots.length - 1]! + durations[0]!);
    const step = 0.05;
    for (let i = 0; i + 1 < knots.length; i += 1) {
      const [t0, t1] = [knots[i]!, knots[i + 1]!];
      const tm = (t0 + t1) / 2;
      // Per key: peak angular speed (°/ms) and the share of the stroke's path
      // covered by mid-stroke.
      const peak: Record<string, number> = {};
      const share: Record<string, number> = {};
      for (const key of KEYS) {
        let prev = trajectory.sampleAt(t0).pose.bones[key] as Q;
        let [top, path, toMid] = [0, 0, 0];
        for (let t = t0 + step; t <= t1 + 1e-9; t += step) {
          const cur = trajectory.sampleAt(t).pose.bones[key] as Q;
          const d = geoDeg(prev, cur);
          top = Math.max(top, d / step);
          path += d;
          if (t <= tm + 1e-9) toMid += d;
          prev = cur;
        }
        peak[key] = top;
        share[key] = toMid / path;
      }
      let ahead = share[ORIGIN]!;
      for (const key of ARM) {
        const where = `stroke ${i}, ${key}`;
        expect(peak[key]! / peak[ORIGIN]!, `${where}: peak speed vs the chain`).toBeLessThanOrEqual(
          1.005 / (1 - trajectoryBoneDelay(key)),
        );
        // Still trailing: behind the chain at mid-stroke, deeper bones further.
        expect(share[key]!, `${where}: path covered by mid-stroke`).toBeLessThan(ahead - 0.005);
        ahead = share[key]!;
      }
    }
  });

  it('…and the trail never runs a bone backwards or stops it: each stroke is swept monotonically', () => {
    const degs = [20, 30, 20, 0, -20, -30, -20, 0];
    const { trajectory } = buildLoopTrajectory(built(degs, degs.map(() => 130)), { timeScale: 1 });
    for (let i = 0; i < degs.length; i += 1) {
      const dir = Math.sign(degs[(i + 1) % degs.length]! - degs[i]!);
      for (const key of ARM) {
        let prev = xDeg(trajectory.sampleAt(i * 130).pose.bones[key] as Q);
        for (let t = i * 130 + 0.5; t <= (i + 1) * 130 - 0.5; t += 0.5) {
          const cur = xDeg(trajectory.sampleAt(t).pose.bones[key] as Q);
          expect((cur - prev) * dir, `${key} at ${t} ms`).toBeGreaterThan(0);
          prev = cur;
        }
      }
    }
  });
});

describe('follow-through keeps exact arrival — every knot, every bone (the measurement contract)', () => {
  it('holds, fly-throughs, a braked functional stop and its overshoot knot all land exactly', () => {
    const motion = built([60, 20, -30, 90], [450, 300, 350, 400], {
      holdsMs: [0, 200, 0, 0],
      velocityClasses: [undefined, undefined, 'functional', 'functional'],
    });
    const { trajectory, settleAtMs } = buildComposedTrajectory(motion, FROM_REST);
    const degs = [60, 20, -30, 90];
    settleAtMs.forEach((tMs, i) => {
      const at = trajectory.sampleAt(tMs).pose.bones;
      for (const key of KEYS) expect(xDeg(at[key] as Q), `${key} @ keyframe ${i}`).toBeCloseTo(degs[i]!, 9);
    });
    // The hold is held — exactly — by every bone, delayed or not.
    for (let t = settleAtMs[1]!; t <= settleAtMs[1]! + 200; t += 10) {
      const at = trajectory.sampleAt(t).pose.bones;
      for (const key of KEYS) expect(xDeg(at[key] as Q), `${key} holding @${t}`).toBeCloseTo(20, 9);
    }
  });

  it('a zero-length segment still lands every bone on the knot the shared parameter reaches', () => {
    // A delayed bone's copy of the time-warp runs on raw time progress, and a
    // zero-length segment's never leaves 0 (its span is floored at 1e-6 ms). The
    // first C¹ version of the warp read it on a knot anyway, so the arms of
    // rest → 60° → 20°-in-0-ms ended at 60° while the Hips ended at 20°. The
    // resolver floors durations, but buildComposedTrajectory is exported and
    // takes any timing.
    const cases: [string, SequenceBuildLike, number][] = [
      ['zero-length final keyframe', built([60, 20], [500, 0]), 20],
      ['…with a functional (braked) final stop', built([60, 20], [500, 0], { velocityClasses: [undefined, 'functional'] }), 20],
      ['sub-floor final keyframe (1e-7 ms)', built([60, 20], [500, 1e-7]), 20],
      ['zero-length interior keyframe', built([60, 20, -30], [400, 0, 400]), -30],
      ['zero-length first keyframe', built([60, 20], [0, 500]), 20],
      // Interior segments SHORTER than the 1e-6 ms floor: σ stops short of 1 in
      // them, so the arms' own copy of the warp left the fingers 6.5° off the
      // Hips at the second keyframe's settle (2504a7e; 15.5° on 5c1c9ac).
      ['sub-floor interior keyframes (5e-7 ms)', built([60, -30, 50, 0], [400, 5e-7, 5e-7, 400]), 0],
    ];
    for (const [label, motion, last] of cases) {
      const { trajectory, settleAtMs } = buildComposedTrajectory(motion, FROM_REST);
      for (const t of [...settleAtMs, trajectory.totalMs]) {
        const at = trajectory.sampleAt(t).pose.bones;
        const origin = xDeg(at[ORIGIN] as Q);
        for (const key of ARM) expect(xDeg(at[key] as Q), `${label}: ${key} @${t} ms vs ${ORIGIN}`).toBeCloseTo(origin, 9);
      }
      const end = trajectory.sampleAt(trajectory.totalMs).pose.bones;
      for (const key of KEYS) expect(xDeg(end[key] as Q), `${label}: ${key} at the end`).toBeCloseTo(last, 9);
    }
  });
});

describe('follow-through stroke cache — each distinct stroke solved once, and found in O(1)', () => {
  let seed = 20260924;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const randQ = (deg: number): Q => rot((rnd() - 0.5) * 2 * deg, [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
  const turn = (q: Q, deg: number): Q => {
    const r = new THREE.Quaternion(...q).multiply(new THREE.Quaternion(...rot(deg, [rnd() - 0.5, rnd() - 0.5, 1])));
    return [r.x, r.y, r.z, r.w];
  };
  const neg = (q: Q): Q => [-q[0], -q[1], -q[2], -q[3]];

  it('the path-speed table samples each stroke’s SQUAD exactly as three’s slerp does, to the bit', () => {
    // The table unrolls three's Quaternion.slerp so that a stroke's nine
    // samples share the work of the two slerps whose ends stay fixed — their
    // acos, and the sines, which at t = k/8 and 1 − t = (8 − k)/8 are the same
    // nine — and takes the outer slerp at its two t = 0 ends as the a·1 + b·0
    // three's arithmetic reduces to there. The c each bone trails by — and so
    // every sampled pose — is unchanged only while every sample is the very one
    // `squad` gives: a three upgrade that changes its slerp fails here first.
    const ts = [0, 1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8, 1];
    const misses: string[] = [];
    let compared = 0;
    for (let trial = 0; trial < 400; trial += 1) {
      const q0 = randQ(170);
      const kind = trial % 4;
      // Far apart; within three's small-angle (lerp) branch; across the
      // hemisphere; the same quaternion.
      const q1 = kind === 0 ? randQ(170) : kind === 1 ? turn(q0, 1.5) : kind === 2 ? neg(turn(q0, 20)) : q0;
      const s0 = kind === 3 ? q0 : turn(q0, 10 * rnd());
      const s1 = rnd() < 0.3 ? neg(turn(q1, 3)) : turn(q1, 10 * rnd());
      const got = strokeSquadTable(q0, q1, s0, s1);
      ts.forEach((t, j) => {
        const along = new THREE.Quaternion(...q0).slerp(new THREE.Quaternion(...q1), t);
        const controls = new THREE.Quaternion(...s0).slerp(new THREE.Quaternion(...s1), t);
        along.slerp(controls, 2 * t * (1 - t));
        const want = [along.x, along.y, along.z, along.w];
        want.forEach((w, d) => {
          if (!Object.is(got[j]![d], w)) misses.push(`trial ${trial}, t ${t}, [${d}]: ${got[j]![d]} vs ${w}`);
        });
        compared += 1;
      });
    }
    expect(compared).toBe(400 * ts.length);
    expect(misses.slice(0, 5), `${misses.length} components differ from three`).toEqual([]);
  });

  it('build time grows linearly with the number of distinct flowing strokes', () => {
    // A repeated cycle strokes through the same poses on the same slopes every
    // rep, so each distinct stroke's c is solved once and a repeat looked up by
    // its inputs. ec3d0eb looked it up by scanning every stroke solved so far,
    // so a motion of n DISTINCT strokes cost O(n²): with one delayed bone, 16×
    // the knots (500 → 8,000) took 85–122× the time when the bone holds still
    // on unevenly timed knots (strokes that differ only in their slopes, cheap
    // to solve, so the scan is all there is) and 31–48× when every knot is a
    // new pose. followThroughStroke.test.ts gates the lookups' own count, which
    // no load moves; this gates the time they take.
    //
    // Timed against the same knots on a bone with no delay (a leg: it rides the
    // chain's warp and solves no stroke), built interleaved with it: a build
    // that is linear in its knots is not linear in wall-clock time — memory and
    // the JIT make even that lockstep build read 15–25× for 16× the knots, and
    // load moves it further (an absolute 32× gate read 31.4× on a loaded
    // runner with the keyed lookups in place) — but both builds pay that alike,
    // so the delayed bone's share of the time holds still with the knots when
    // its strokes cost O(1) each and grows with them when they cost O(n). The
    // gate is twice linear: its share may at most double for 16× the strokes.
    // Every build here is cold: strokes solved in an earlier build would
    // otherwise be looked up, not solved.
    const knotAt = (t: number, q: Q, stop: boolean, bone: string): TrajectoryKnot => ({
      timeMs: t,
      pose: { variant: 'male', bones: { [bone]: q }, schemaVersion: POSE_SCHEMA_VERSION },
      rootQuat: [...IDENT],
      rootTranslate: [0, 0, 0],
      stop,
      planted: true,
    });
    const onBone = (knots: TrajectoryKnot[], bone: string): TrajectoryKnot[] =>
      knots.map((k) => knotAt(k.timeMs, Object.values(k.pose.bones!)[0] as Q, k.stop, bone));
    const moving = (n: number): TrajectoryKnot[] =>
      Array.from({ length: n }, (_, i) => knotAt(i * 120, randQ(35), i === 0 || i === n - 1, 'L_Forearm'));
    const held = (n: number): TrajectoryKnot[] => {
      const q = rot(17, [1, 2, 3]);
      let t = 0;
      return Array.from({ length: n }, (_, i) =>
        knotAt(i === 0 ? 0 : (t += 80 + 80 * rnd()), q, i === 0 || i === n - 1, 'L_Forearm'),
      );
    };
    // The 500-knot build is timed as sixteen of them in a row — the 8,000-knot
    // build's strokes, over as long a stretch. Least of five rounds, each round
    // timing all four builds back to back: preemption only ever adds time.
    const timeOf = (sets: TrajectoryKnot[][]): number => {
      let ms = 0;
      for (const knots of sets) {
        clearFollowThroughStrokeMemo();
        const t0 = performance.now();
        buildPoseTrajectory(knots);
        ms += performance.now() - t0;
      }
      return ms / sets.length;
    };
    expect(trajectoryBoneDelay('L_Forearm')).toBeGreaterThan(0);
    expect(trajectoryBoneDelay('L_UpLeg')).toBe(0);
    for (const [label, knotsOf] of [
      ['held still on unevenly timed knots', held],
      ['every knot a new pose', moving],
    ] as const) {
      const small = Array.from({ length: 16 }, () => knotsOf(500));
      const big = [knotsOf(8000)];
      const smallLock = small.map((k) => onBone(k, 'L_UpLeg'));
      const bigLock = big.map((k) => onBone(k, 'L_UpLeg'));
      buildPoseTrajectory(knotsOf(2000)); // warm the JIT on both shapes
      buildPoseTrajectory(onBone(knotsOf(2000), 'L_UpLeg'));
      const best = [Infinity, Infinity, Infinity, Infinity];
      for (let r = 0; r < 5; r += 1) {
        [small, smallLock, big, bigLock].forEach((sets, i) => {
          best[i] = Math.min(best[i]!, timeOf(sets));
        });
      }
      const [smallMs, smallLockMs, bigMs, bigLockMs] = best as [number, number, number, number];
      const growth = bigMs / bigLockMs / (smallMs / smallLockMs);
      // eslint-disable-next-line no-console
      console.log(
        `stroke cache, ${label}: 500 knots ${smallMs.toFixed(1)} ms (lockstep ${smallLockMs.toFixed(1)}), ` +
          `8,000 knots ${bigMs.toFixed(1)} ms (lockstep ${bigLockMs.toFixed(1)}): ` +
          `${(bigMs / smallMs).toFixed(1)}× against the lockstep's ${(bigLockMs / smallLockMs).toFixed(1)}× — share grows ${growth.toFixed(2)}×`,
      );
      expect(growth, `${label}: the delayed bone's share of the build time for 16× the strokes`).toBeLessThan(2);
    }
  });
});

describe('stage and sampler read the follow-through from ONE evaluator (source pins)', () => {
  // The continuity above lives entirely inside motionTrajectory.sampleAt and
  // motionStagger.delayedOnset. The stage cannot be mounted here, so these pin
  // the wiring that keeps it in lockstep with the sampler: both apply the
  // sample's pose as-is (no path re-times a bone of its own), and the exam
  // tween hands the shared onset warp RAW progress — easing first and then
  // delaying is exactly the step this file exists to catch.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const stage = read('../ExamStage3D.svelte');
  const sampler = read('../services/motionRecording.ts');

  it('the live composed player and the offline sampler both apply sampleAt’s pose unchanged', () => {
    expect(stage).toMatch(
      /const s = at\.traj\.sampleAt\(elapsed\);\s*if \(skinnedRef && variantCfgRef\) applyPoseComplete\(skinnedRef\.skeleton, variantCfgRef, s\.pose\);/,
    );
    expect(sampler).toMatch(
      /const sample = trajectory\.sampleAt\(tMs\);\s*const pose = sample\.pose;\s*applyCustomPose\(skinned\.skeleton, variantCfg, pose\);/,
    );
  });

  it('the exam tween delays on RAW progress (the ease comes after the dwell)', () => {
    expect(stage).toContain('const blended = stagedBlendWithBaseline(tw.from, tw.to, baselinePoseRef, t);');
    expect(stage).not.toMatch(/stagedBlendWithBaseline\([^)]*eased/);
  });
});

// ── Rig gates (real male GLB, headless) ──────────────────────────────────────

describe('follow-through on the rig', () => {
  const variantCfg = BODY_VARIANTS.male;
  let rest: JointAngleRestReference;
  let baselinePose: CustomPose;

  beforeAll(async () => {
    const buf = readFileSync(fileURLToPath(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url)));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
      const l = new GLTFLoader();
      l.setMeshoptDecoder(MeshoptDecoder);
      l.parse(ab, '', res as never, rej);
    });
    const root = gltf.scene;
    root.scale.setScalar(variantCfg.pose.rootScale);
    let skinned: THREE.SkinnedMesh | null = null;
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
    });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, variantCfg);
    root.updateMatrixWorld(true);
    rest = captureJointAngleRestReference(skinned!.skeleton, variantCfg);
    baselinePose = serializeCustomPose(skinned!.skeleton, variantCfg, 'male');
  });

  /** The composed trajectory exactly as the sampler and the stage build it. */
  function trajectoryOf(motion: ComposedMotion): { traj: PoseTrajectory; settleAtMs: number[] } {
    const resolved = resolveComposedMotion(motion, variantCfg);
    expect(resolved.status, motion.name).toBe('ok');
    const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest, { currentPose: null, currentRoot: null });
    const { trajectory, settleAtMs } = buildComposedTrajectory(built, {
      startPose: baselinePose,
      startQuat: [...IDENT],
      startTranslate: [0, 0, 0],
      timeScale: resolved.modifiers?.timeScale ?? 1,
      reps: resolved.reps,
      cyclicEnds: resolved.footDrivenTravel === true && resolved.settleEnds !== true,
      flowIn: resolved.flowIn === true,
    });
    return { traj: trajectory, settleAtMs };
  }
  /** Geodesic angular speed (°/s) of a bone over [t − h, t + h]. */
  const speedAt = (traj: PoseTrajectory, key: string, t: number, h = 0.25): number =>
    geoDeg(traj.sampleAt(t - h).pose.bones[key] as Q, traj.sampleAt(t + h).pose.bones[key] as Q) / ((2 * h) / 1000);

  it('the travel walk: no delayed arm bone stalls or jumps at a gait keyframe', () => {
    const { traj, settleAtMs } = trajectoryOf(buildTravelWalk());
    const arm = Object.keys(traj.sampleAt(0).pose.bones).filter(
      (k) => /^[LR]_(Shoulder|UpperArm|Forearm|Hand|Index1|Thumb1)$/.test(k) && trajectoryBoneDelay(k) > 0,
    );
    expect(arm.length).toBeGreaterThanOrEqual(10);
    let judged = 0;
    for (const tk of settleAtMs.slice(0, -1)) {
      for (const key of arm) {
        const before = speedAt(traj, key, tk - 1);
        const after = speedAt(traj, key, tk + 1);
        if (Math.max(before, after) < 20) continue; // not moving through this keyframe
        judged += 1;
        // Base: 0°/s just after the knot — the bone stopped dead (a 100% change).
        expect(Math.abs(after - before) / Math.max(before, after), `${key} @${tk.toFixed(0)} ms: ${before.toFixed(0)} → ${after.toFixed(0)}°/s`).toBeLessThan(0.15);
      }
    }
    expect(judged, 'arm bones moving through gait keyframes').toBeGreaterThanOrEqual(20);
  });

  // The same authored series under a key the stagger does not know (delay 0) is
  // the LOCKSTEP build, sampled from the very same trajectory.
  const TWIN = 'lockstep:';
  const twinned =
    (keys: string[]) =>
    (p: CustomPose): CustomPose => ({
      ...p,
      bones: { ...p.bones, ...Object.fromEntries(keys.filter((k) => p.bones[k]).map((k) => [`${TWIN}${k}`, p.bones[k]!])) },
    });

  /** Every mid-swing crossing of the travel walk's distal arm bones that falls
   *  inside a FLOWING stroke (one that flies through a keyframe at both ends),
   *  at least a fifth of the stroke from either keyframe: how late (ms) the bone
   *  crosses the middle of its swing after its lockstep twin. */
  function walkMidSwingLags(speed?: number): { key: string; lag: number; s: number; strokeMs: number }[] {
    const DISTAL = ['L_Forearm', 'L_Hand', 'L_Index1', 'R_Forearm', 'R_Hand', 'R_Index1'];
    expect(trajectoryBoneDelay(`${TWIN}L_Hand`)).toBe(0);
    const resolved = resolveComposedMotion(buildTravelWalk(speed == null ? {} : { speed }), variantCfg);
    const seq = buildSequencePoses(baselinePose, resolved, variantCfg, rest, { currentPose: null, currentRoot: null });
    const twin = twinned(DISTAL);
    const { trajectory: traj, settleAtMs } = buildComposedTrajectory(
      { ...seq, poses: seq.poses.map(twin) },
      {
        startPose: twin(baselinePose),
        startQuat: [...IDENT],
        startTranslate: [0, 0, 0],
        timeScale: resolved.modifiers?.timeScale ?? 1,
        reps: resolved.reps,
        cyclicEnds: resolved.footDrivenTravel === true && resolved.settleEnds !== true,
        flowIn: resolved.flowIn === true,
      },
    );
    // Knot 0 is the start and the last knot the settle (both stops).
    const knots = [0, ...settleAtMs];
    const logRel = (ref: Q, q: Q): number[] => {
      const r: Q = [-ref[0], -ref[1], -ref[2], ref[3]];
      let [x, y, z, w] = [
        r[3] * q[0] + r[0] * q[3] + r[1] * q[2] - r[2] * q[1],
        r[3] * q[1] - r[0] * q[2] + r[1] * q[3] + r[2] * q[0],
        r[3] * q[2] + r[0] * q[1] - r[1] * q[0] + r[2] * q[3],
        r[3] * q[3] - r[0] * q[0] - r[1] * q[1] - r[2] * q[2],
      ];
      if (w < 0) [x, y, z, w] = [-x, -y, -z, -w];
      const n = Math.hypot(x, y, z);
      const k = n > 1e-12 ? (2 * Math.atan2(n, w)) / n : 2;
      return [x * k, y * k, z * k];
    };
    const ts: number[] = [];
    const frames: Record<string, Q>[] = [];
    for (let t = 0; t <= traj.totalMs; t += 1) {
      ts.push(t);
      frames.push(traj.sampleAt(t).pose.bones as Record<string, Q>);
    }
    const out: { key: string; lag: number; s: number; strokeMs: number }[] = [];
    for (const key of DISTAL) {
      // The bone's swing on the principal axis of its lockstep path (1 ms grid).
      const ref = frames[0]![`${TWIN}${key}`]!;
      const lock = frames.map((f) => logRel(ref, f[`${TWIN}${key}`]!));
      const own = frames.map((f) => logRel(ref, f[key]!));
      const mean = [0, 1, 2].map((i) => lock.reduce((sum, v) => sum + v[i]!, 0) / lock.length);
      const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => lock.reduce((sum, v) => sum + (v[i]! - mean[i]!) * (v[j]! - mean[j]!), 0)));
      let axis = [1, 0.3, 0.2];
      for (let it = 0; it < 200; it += 1) {
        const next = [0, 1, 2].map((i) => cov[i]![0]! * axis[0]! + cov[i]![1]! * axis[1]! + cov[i]![2]! * axis[2]!);
        const n = Math.hypot(next[0]!, next[1]!, next[2]!);
        axis = next.map((x) => x / n);
      }
      const onAxis = (v: number[]) => v[0]! * axis[0]! + v[1]! * axis[1]! + v[2]! * axis[2]!;
      const sLock = lock.map(onAxis);
      const sOwn = own.map(onAxis);
      const mid = (Math.max(...sLock) + Math.min(...sLock)) / 2;
      const crossings = (series: number[]): [number, number][] => {
        const found: [number, number][] = [];
        for (let i = 1; i < series.length; i += 1) {
          if ((series[i - 1]! - mid) * (series[i]! - mid) >= 0) continue;
          found.push([ts[i - 1]! + (mid - series[i - 1]!) / (series[i]! - series[i - 1]!), Math.sign(series[i]! - series[i - 1]!)]);
        }
        return found;
      };
      const ownCross = crossings(sOwn);
      for (const [t, dir] of crossings(sLock)) {
        const k = knots.findIndex((kt, i) => i < knots.length - 1 && t >= kt && t < knots[i + 1]!);
        if (k <= 0 || k + 1 >= knots.length - 1) continue; // leaves or reaches a stop
        const strokeMs = knots[k + 1]! - knots[k]!;
        const s = (t - knots[k]!) / strokeMs;
        // ON a keyframe every bone is exactly its knot pose (the measurement
        // contract), so a crossing there has no lag to show; judge the ones at
        // least a fifth of the stroke inside it.
        if (s < 0.2 || s > 0.8) continue;
        const match = ownCross.filter(([t2, d2]) => d2 === dir && Math.abs(t2 - t) < 60);
        expect(match.length, `${key} crosses mid-swing near ${t.toFixed(0)} ms`).toBeGreaterThan(0);
        const lag = match.map(([t2]) => t2 - t).reduce((x, y) => (Math.abs(y) < Math.abs(x) ? y : x));
        out.push({ key, lag, s, strokeMs });
      }
    }
    return out;
  }
  function gateMidSwingLags(label: string, speed: number | undefined, meanMs: number, eachMs: number): void {
    const crossings = walkMidSwingLags(speed);
    expect(crossings.length, `${label}: mid-swing crossings judged`).toBeGreaterThanOrEqual(8);
    for (const { key, lag, s, strokeMs } of crossings) {
      expect(lag, `${label}: ${key}, ${strokeMs.toFixed(0)} ms stroke at s = ${s.toFixed(2)}`).toBeGreaterThanOrEqual(eachMs);
    }
    const lags = crossings.map((c) => c.lag);
    const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
    // eslint-disable-next-line no-console
    console.log(`${label}: distal arm bones cross mid-swing ${mean.toFixed(1)} ms after lockstep (${lags.length} crossings, ${Math.min(...lags).toFixed(1)}–${Math.max(...lags).toFixed(1)} ms)`);
    expect(mean, `${label}: mean mid-swing lag behind the lockstep build, ms`).toBeGreaterThanOrEqual(meanMs);
  }

  it('the travel walk: distal arm bones cross mid-swing 8 ms after a lockstep build on average, each at least 4 ms', () => {
    // At the default pace. 8 ms on average: one 120 Hz frame (8.3 ms), the rate
    // the engine's rig gates sample motion at (the fast-wave gate asks the
    // same), and under the design's own budget, d/2 of a stroke at mid-stroke —
    // 7.7–11.4 ms for the forearm, 10.3–15.2 ms for the fingers over the walk's
    // 114–169 ms strokes. 4 ms at each crossing: half a frame. The lag term
    // fades toward both keyframes (to 0.41 of its mid-stroke trail at the edge
    // of the judged window) and the speed cap trims it into a turn, so a single
    // crossing sits well under the mean. Measured 10.3 ms over 12 crossings
    // (4.3–22.8; the least the left forearm at s = 0.67 of a stroke into a
    // turn); 191256f, capping the progress rate only, 10.9 (4.3–22.8); a
    // lockstep build 0; round 2's warp −1.4 (−8.0 to +7.3); 5c1c9ac's
    // per-segment dwell 16.1.
    // This flat floor holds at the pace it was set at (and 1.5×, below), not at
    // every pace: where a crossing falls in its stroke moves with the pace, and
    // late in a stroke into a turn the slowed arrival takes the trail back by
    // design (0.6×: the left forearm at s = 0.80, 1.35 ms). The pace sweep below
    // judges each crossing against the trail the design leaves at its point.
    gateMidSwingLags('travel walk', undefined, 8, 4);
  });

  it('…and at 1.5× pace, scaled to its shorter strokes: 6.5 ms on average, each at least 3.3 ms', () => {
    // The trail is budgeted as a SHARE of the stroke (d/2 at mid-stroke), and
    // paceGait splits speed evenly into stride and cadence, so at 1.5× every
    // stroke lasts 1/√1.5 = 0.816 as long (93–367 ms against 114–450) and both
    // thresholds scale with it: 8 → 6.5 ms, 4 → 3.3 ms. Measured 7.2 ms over 13
    // crossings (3.8–11.0); 191256f 7.6 (3.8–11.0); a lockstep build 0; round
    // 2's warp −1.8 (−10.4 to +0.5). The mean scales so at every pace; the flat
    // per-crossing floor only where the crossings fall where they do at 1× and
    // 1.5× — see the pace sweep below.
    gateMidSwingLags('travel walk at 1.5×', 1.5, 8 / Math.sqrt(1.5), 4 / Math.sqrt(1.5));
  });

  /** The design's delay d for each distal arm bone the walk gates judge: chain
   *  rank × 0.18 / 8 (forearm 6, hand 7, finger 8). Fixed here, not read off
   *  the engine, so the floor below does not move with the code it checks. */
  const DESIGN_DELAY: Record<string, number> = { Forearm: 0.135, Hand: 0.1575, Index1: 0.18 };

  it('the walk gates’ design delays are the engine’s', () => {
    for (const [bone, d] of Object.entries(DESIGN_DELAY)) {
      for (const side of ['L_', 'R_']) expect(trajectoryBoneDelay(`${side}${bone}`)).toBeCloseTo(d, 12);
      // The budget the floor below is written from: d/2 at mid-stroke, and a
      // full turn's knot slope cut to 3 − 2/(1 − d).
      expect(followThroughStrokeLag(d).midLag).toBeCloseTo(d / 2, 12);
      expect(followThroughKnotSlope(d, 1)).toBeCloseTo(3 - 2 / (1 - d), 12);
    }
  });

  /** The trail (ms) the design leaves a bone at point s of a flowing stroke of
   *  `strokeMs` — even one that arrives at a full turn of its path, at an even
   *  pace. The lag term puts it c·s²(1 − s)² of the stroke behind, c = 16 × d/2
   *  (the budget of motionStagger.followThroughStrokeLag). Arriving at a turn,
   *  its own knot slope is cut by 2d/(1 − d) of the chain's at a full turn
   *  (motionStagger.followThroughKnotSlope's floor 3 − 2/(1 − d)), and an
   *  arrival that slows must come in ahead: s²(1 − s) × that cut. So
   *  2d·s²(1 − s)·(4(1 − s) − 1/(1 − d)) of the stroke — positive until about
   *  0.7 of the way through it, and past that a bone arriving at a full turn
   *  may reach mid-swing with the chain. Written from the fixed constants of
   *  {@link DESIGN_DELAY}, pinned to the engine's by the test above. */
  function designTrailMs(key: string, s: number, strokeMs: number): number {
    const d = DESIGN_DELAY[key.replace(/^[LR]_/, '')]!;
    const trail = 16 * (d / 2) * s * s * (1 - s) * (1 - s);
    const lead = s * s * (1 - s) * ((2 * d) / (1 - d));
    return (trail - lead) * strokeMs;
  }

  it.each([0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5])(
    'the travel walk at %s× pace: each mid-swing crossing trails by half the design’s trail at its point of the stroke, 8 ms / √pace on average',
    (pace) => {
      // Across the walk's speed range. The flat per-crossing floor above holds
      // only at the paces it was set at: where the middle of a bone's swing
      // falls in its stroke moves with the pace (the left forearm's from s =
      // 0.53 at 1.2× to 0.80 at 0.6×), and the trail fades toward the keyframe
      // while a slowed arrival into a turn takes it back. So each crossing is
      // held to half of what the design keeps at ITS point even into a full turn
      // (designTrailMs — the other half for the rate and speed caps and an
      // uneven pace through the stroke); within ~0.3 of the stroke of a
      // keyframe it arrives at, where that is nothing, it must still trail —
      // never cross ahead of the chain — and the mean holds it (those trail by
      // 1.35 ms, the left forearm at s = 0.80 at 0.6×, to 8.9 ms; 5c1c9ac 5.6
      // ms at that crossing). The mean scales with the strokes, 8 ms at 1×.
      // Every floor here is written from the design's constants, not read off
      // the helpers it checks (DESIGN_DELAY). Measured (male, female
      // and neutral rigs alike): least crossing 1.26–1.83 × the design's trail
      // (0.8×: the left forearm at s = 0.20 of a stroke out of a turn, 4.3 ms
      // against 3.4), mean 1.11–1.51 × 8 ms / √pace (1.5×: 7.2 ms against 6.5).
      // 5c1c9ac, which trailed by stopping every bone at every keyframe, 2.06–
      // 2.69 × and 1.73–2.11 ×. A lockstep build crosses with the chain, 0 at
      // every pace; round 2's warp (2504a7e) fails at every pace too.
      const crossings = walkMidSwingLags(pace);
      let judged = 0;
      for (const { key, lag, s, strokeMs } of crossings) {
        expect(lag, `${pace}×: ${key}, ${strokeMs.toFixed(0)} ms stroke at s = ${s.toFixed(2)} trails the chain`).toBeGreaterThan(0);
        const floor = designTrailMs(key, s, strokeMs) / 2;
        if (!(floor > 0)) continue;
        judged += 1;
        expect(lag, `${pace}×: ${key}, ${strokeMs.toFixed(0)} ms stroke at s = ${s.toFixed(2)} (half the design's trail ${floor.toFixed(2)} ms)`).toBeGreaterThanOrEqual(floor);
      }
      expect(judged, `${pace}×: crossings the design keeps a trail at`).toBeGreaterThanOrEqual(8);
      const mean = crossings.reduce((a, c) => a + c.lag, 0) / crossings.length;
      expect(mean, `${pace}×: mean mid-swing lag behind the lockstep build, ms`).toBeGreaterThanOrEqual(8 / Math.sqrt(pace));
    },
  );

  it('run and sprint loops: no delayed arm bone moves faster than 1/(1 − d) × its lockstep twin through any stroke', () => {
    // The trail hurries a bone through the back half of a stroke, and a SQUAD
    // path is not uniform in its parameter, so a cap on the progress rate alone
    // (191256f) let it through at the path's fast end: the run's fingers peaked
    // 1.211×, the sprint's 1.228× over 1/(1 − d) × their lockstep twin inside a
    // stroke (the sprint's fingers 1.50× the twin). Capped on angular speed too:
    // measured 1.001 / 1.000; 2504a7e, with no trail, 0.969.
    for (const pattern of ['run', 'sprint'] as const) {
      const resolved = resolveComposedMotion(buildRun({ pattern }), variantCfg);
      expect(resolved.status, pattern).toBe('ok');
      expect(resolved.loop, pattern).toBe(true);
      const seq = buildSequencePoses(baselinePose, resolved, variantCfg, rest, { currentPose: null, currentRoot: null });
      // No holds: every keyframe of the loop is flown through, every stroke flows.
      expect(seq.holdsMs.every((h) => !(h > 0)), `${pattern}: no held keyframe`).toBe(true);
      const arm = Object.keys(seq.poses[0]!.bones).filter(
        (k) => trajectoryBoneDelay(k) > 0 && /^[LR]_(Shoulder|UpperArm|Forearm|Hand|Thumb|Index|Mid|Ring|Pinky)/.test(k),
      );
      expect(arm.length, `${pattern}: delayed arm bones`).toBeGreaterThanOrEqual(30);
      const timeScale = resolved.modifiers?.timeScale ?? 1;
      const { trajectory } = buildLoopTrajectory({ ...seq, poses: seq.poses.map(twinned(arm)) }, { timeScale });
      // The loop's keyframes sit at the running sum of the durations INTO them
      // (buildLoopTrajectory's layout); the wrap back to the first takes the first.
      const dur = seq.durationsMs.map((d) => Math.max(1e-3, d / clampTimeScale(timeScale)));
      const knots = [0];
      for (let i = 1; i < dur.length; i += 1) knots.push(knots[i - 1]! + dur[i]!);
      knots.push(knots[knots.length - 1]! + dur[0]!);
      expect(knots[knots.length - 1]!, pattern).toBeCloseTo(trajectory.totalMs, 6);
      const step = 0.25;
      let judged = 0;
      let worst = 0;
      for (let i = 0; i + 1 < knots.length; i += 1) {
        const [t0, t1] = [knots[i]!, knots[i + 1]!];
        const peak: Record<string, number> = {};
        const path: Record<string, number> = {};
        let prev = trajectory.sampleAt(t0).pose.bones as Record<string, Q>;
        for (let t = t0 + step; t <= t1 + 1e-9; t += step) {
          const cur = trajectory.sampleAt(t).pose.bones as Record<string, Q>;
          for (const key of arm) {
            for (const k of [key, `${TWIN}${key}`]) {
              const d = geoDeg(prev[k]!, cur[k]!);
              peak[k] = Math.max(peak[k] ?? 0, d / step);
              path[k] = (path[k] ?? 0) + d;
            }
          }
          prev = cur;
        }
        for (const key of arm) {
          if (path[`${TWIN}${key}`]! < 3) continue; // a stroke the bone barely moves in
          judged += 1;
          const ratio = (peak[key]! / peak[`${TWIN}${key}`]!) * (1 - trajectoryBoneDelay(key));
          worst = Math.max(worst, ratio);
          // 1% for the 0.25 ms finite differences and the engine's sampled cap.
          expect(ratio, `${pattern}, stroke ${i}: ${key} peak speed over 1/(1 − d) × its twin`).toBeLessThanOrEqual(1.01);
        }
      }
      expect(judged, `${pattern}: bone-strokes judged`).toBeGreaterThanOrEqual(40);
      // eslint-disable-next-line no-console
      console.log(`${pattern} loop: worst stroke peak speed = ${worst.toFixed(3)} × 1/(1 − d) × lockstep over ${judged} bone-strokes`);
    }
  });

  it('arms folded over a sit-down from rest: the elbow leaves rest with zero velocity', () => {
    // The DDx chair stand's shape: the arms-folded targets on EVERY keyframe of a
    // sit-down that starts from the rest pose.
    const folded: ComposedMotion = {
      ...buildSitDown(),
      keyframes: buildSitDown().keyframes.map((kf) => ({
        ...kf,
        targets: [
          ...(kf.targets ?? []),
          ...(['L', 'R'] as const).flatMap((side) => [
            { joint: `${side}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: 25 },
            { joint: `${side}_UpperArm`, motion: 'shoulderRotation', targetDegrees: 45 },
            { joint: `${side}_Forearm`, motion: 'elbowFlexion', targetDegrees: 110 },
          ]),
        ],
      })),
    };
    const { traj, settleAtMs } = trajectoryOf(folded);
    const keys = ['L_Forearm', 'R_Forearm', 'L_UpperArm'];
    const series = new Map<string, number[]>(keys.map((k) => [k, []]));
    let prev = traj.sampleAt(0).pose.bones;
    for (let t = DT; t <= settleAtMs[0]!; t += DT) {
      const cur = traj.sampleAt(t).pose.bones;
      for (const k of keys) series.get(k)!.push(geoDeg(prev[k] as Q, cur[k] as Q) / (DT / 1000));
      prev = cur;
    }
    for (const key of keys) {
      const speeds = series.get(key)!;
      const peak = Math.max(...speeds);
      expect(peak, `${key} folds`).toBeGreaterThan(100);
      const first = speeds.findIndex((v) => v > 1e-6);
      // Base: still until ~170 ms, then 0 → 56% of its peak in one 0.1 ms step.
      expect(speeds[first]!, `${key} first-moving speed vs peak ${peak.toFixed(0)}°/s`).toBeLessThan(0.02 * peak);
      let worst = 0;
      for (let i = 1; i < speeds.length; i += 1) worst = Math.max(worst, Math.abs(speeds[i]! - speeds[i - 1]!));
      expect(worst / peak, `${key} worst speed change per ${DT} ms, share of peak`).toBeLessThan(0.01);
    }
  });
});
