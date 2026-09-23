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
 * Gated PURE (single-axis chains, signed angle, 0.1 ms finite differences) and
 * ON THE RIG (the travel walk every gait task is built on; a sit-down with the
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
  type PoseTrajectory,
  type SequenceBuildLike,
} from '../services/motionTrajectory';
import {
  chainOnsetDelay,
  PROXIMAL_TO_DISTAL_STAGGER,
  stagedBlendWithBaseline,
  trajectoryBoneDelay,
} from '../services/motionStagger';
import { buildSitDown, buildTravelWalk } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

type Q = [number, number, number, number];
const IDENT: Q = [0, 0, 0, 1];

function rotX(deg: number): Q {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (deg * Math.PI) / 180);
  return [q.x, q.y, q.z, q.w];
}
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
