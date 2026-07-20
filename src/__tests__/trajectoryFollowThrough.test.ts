/**
 * TRAJECTORY FOLLOW-THROUGH (roadmap 2.2) + TERMINAL PRE-SETTLE OVERSHOOT (2.3).
 *
 * 2.2 — Composed playback is no longer lockstep: inside the shared trajectory
 * (motionTrajectory.sampleAt — the ONE evaluator both the live stage and the
 * offline sampler consume), each arm-chain bone's segment-local SQUAD parameter
 * is warped by the delayed-and-renormalized proximal→distal scheme from
 * motionStagger (local′ = clamp((local − d)/(1 − d))). Distal segments trail
 * proximal ones mid-segment — TEMPORAL overlap — while both warp endpoints are
 * fixed points, so every bone still reaches every knot exactly at its knot time
 * (the settle/measurement contract). Root motion and the legs are exempt (never
 * fight the foot-plant IK / slide budgets).
 *
 * 2.3 — A motion whose FINAL keyframe arrives at speed (functional/ballistic)
 * gets ONE auto-inserted fly-through knot at target + ~3% of inbound travel,
 * ~120 ms before the stop: fast endings overshoot and settle instead of
 * dead-stopping servo-perfect. The final knot is untouched — final pose exact.
 *
 * Gated both PURE (exact knot arrival, lag ordering, leg/root exemption,
 * overshoot shape) and ON THE RIG (wrist reversal lags shoulder reversal by a
 * positive dt while both settle on their clamped targets within the existing
 * ±2.5° contract; a kick-style recovery measurably overshoots then settles).
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
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { measureCommandMotion } from '../services/movementCommand';
import {
  resolveComposedMotion,
  type ComposedMotion,
} from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import {
  buildComposedTrajectory,
  type SequenceBuildLike,
} from '../services/motionTrajectory';
import { trajectoryBoneDelay } from '../services/motionStagger';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

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

/** A pose rotating every listed bone to `deg` about +X. */
function chainPose(keys: string[], deg: number): CustomPose {
  return {
    variant: 'male',
    bones: Object.fromEntries(keys.map((k) => [k, rotX(deg)])),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}

/** Minimal SequenceBuildLike over the given per-keyframe degree targets. */
function syntheticBuilt(
  keys: string[],
  degs: number[],
  durationsMs: number[],
  velocityClasses?: SequenceBuildLike['velocityClasses'],
): SequenceBuildLike {
  return {
    poses: degs.map((d) => chainPose(keys, d)),
    roots: degs.map(() => ({
      quat: [...IDENT] as [number, number, number, number],
      translateM: [0, 0, 0] as [number, number, number],
      stance: 'planted',
    })),
    durationsMs,
    holdsMs: degs.map(() => 0),
    ...(velocityClasses ? { velocityClasses } : {}),
  };
}

const START_OPTS = {
  startPose: chainPose([], 0),
  startQuat: [...IDENT] as [number, number, number, number],
  startTranslate: [0, 0, 0] as [number, number, number],
  timeScale: 1,
};

// The arm chain proximal→distal, plus exempt references.
const ARM = ['L_Shoulder', 'L_UpperArm', 'L_Forearm', 'L_Hand', 'L_Index1'];
const LEGS = ['L_UpLeg', 'L_Leg', 'L_Foot', 'L_Toes'];

describe('trajectoryBoneDelay — scope of the follow-through warp', () => {
  it('arm chain delay grows proximal → distal; legs, toes, hips, root-adjacent are ZERO', () => {
    const d = trajectoryBoneDelay;
    expect(d('L_Shoulder')).toBeGreaterThan(0);
    expect(d('L_Shoulder')).toBeLessThan(d('L_UpperArm'));
    expect(d('L_UpperArm')).toBeLessThan(d('L_Forearm'));
    expect(d('L_Forearm')).toBeLessThan(d('L_Hand'));
    expect(d('L_Hand')).toBeLessThan(d('L_Index1'));
    for (const leg of [...LEGS, 'R_UpLeg', 'R_Foot']) expect(d(leg), leg).toBe(0);
    expect(d('Hips')).toBe(0);
  });

  it('the axial column gets only a whisper (well under the arm chain)', () => {
    for (const k of ['Spine_Lower', 'Spine_Upper', 'Neck', 'Head']) {
      expect(trajectoryBoneDelay(k), k).toBeGreaterThanOrEqual(0);
      expect(trajectoryBoneDelay(k), k).toBeLessThan(trajectoryBoneDelay('L_Shoulder'));
    }
  });
});

describe('follow-through warp — pure trajectory invariants', () => {
  const keys = [...ARM, ...LEGS, 'Hips'];
  // start(0°) → kf0 fly-through(60°) → kf1 stop(0°): an out-and-back.
  const built = syntheticBuilt(keys, [60, 0], [500, 500]);
  const { trajectory, settleAtMs } = buildComposedTrajectory(built, START_OPTS);

  it('EVERY bone — warped or not — hits every knot pose exactly at its knot time', () => {
    const atKnot = trajectory.sampleAt(settleAtMs[0]!).pose;
    const atEnd = trajectory.sampleAt(settleAtMs[1]!).pose;
    for (const k of keys) {
      expect(signedXDeg(atKnot.bones[k]!), `${k} @knot`).toBeCloseTo(60, 4);
      expect(signedXDeg(atEnd.bones[k]!), `${k} @end`).toBeCloseTo(0, 4);
    }
  });

  it('mid-segment the chain sequences proximal → distal (the overlap cue)', () => {
    // Halfway through the first segment (time-warp u ≈ 0.375 — past every
    // chain delay): everyone is en route; deeper bones are behind.
    const mid = trajectory.sampleAt(250).pose;
    const f = (k: string) => signedXDeg(mid.bones[k]!);
    expect(f('Hips')).toBeGreaterThan(f('L_Shoulder'));
    expect(f('L_Shoulder')).toBeGreaterThan(f('L_UpperArm'));
    expect(f('L_UpperArm')).toBeGreaterThan(f('L_Forearm'));
    expect(f('L_Forearm')).toBeGreaterThan(f('L_Hand'));
    expect(f('L_Hand')).toBeGreaterThan(f('L_Index1'));
    // The lag is real but bounded — the fingertip is not stalled at rest.
    expect(f('L_Index1')).toBeGreaterThan(0);
  });

  it('legs and root are EXEMPT — byte-identical to the undelayed chain origin', () => {
    for (const t of [80, 150, 260, 340, 470, 620, 780, 930]) {
      const s = trajectory.sampleAt(t);
      for (const leg of LEGS) {
        // Same authored series as Hips (delay 0) → identical samples proves the
        // warp never touches the planted chains the foot-plant IK owns.
        expect(s.pose.bones[leg], `${leg} @${t}ms`).toEqual(s.pose.bones.Hips);
      }
      // Root translate rides the plain segment interpolant (zero here).
      expect(s.rootTranslate).toEqual([0, 0, 0]);
    }
  });
});

describe('terminal pre-settle overshoot — pure trajectory shape', () => {
  const keys = ['L_UpperArm', 'L_UpLeg', 'Hips'];
  const mk = (
    velocityClasses: SequenceBuildLike['velocityClasses'],
    opts: { cyclicEnds?: boolean } = {},
  ) =>
    buildComposedTrajectory(syntheticBuilt(keys, [90, 0], [400, 300], velocityClasses), {
      ...START_OPTS,
      ...opts,
    });

  it('a ballistic ending overshoots past the target (~3% of inbound travel) then settles exactly', () => {
    const { trajectory, settleAtMs } = mk([undefined, 'ballistic']);
    // The fly-through knot sits ~120 ms before the stop at −3% of the 90° inbound.
    let minDeg = Infinity;
    for (let t = settleAtMs[0]!; t <= trajectory.totalMs; t += 2) {
      minDeg = Math.min(minDeg, signedXDeg(trajectory.sampleAt(t).pose.bones.L_UpLeg!));
    }
    expect(minDeg, 'sails measurably past the 0° target').toBeLessThan(-1.5);
    expect(minDeg, 'a fly-through, not a wild swing').toBeGreaterThan(-6);
    // Final pose exact — the stop knot is untouched by the insertion.
    const end = trajectory.sampleAt(trajectory.totalMs).pose;
    for (const k of keys) expect(signedXDeg(end.bones[k]!), `${k} final`).toBeCloseTo(0, 4);
    // Knot times/settles unchanged.
    expect(settleAtMs).toEqual([400, 700]);
    expect(trajectory.totalMs).toBe(700);
  });

  it("a 'functional' ending overshoots too; the clinical default ('deliberate') does NOT", () => {
    for (const [cls, expects] of [
      ['functional', true],
      [undefined, false],
      ['deliberate', false],
    ] as const) {
      const { trajectory } = mk([undefined, cls as never]);
      let minDeg = Infinity;
      for (let t = 400; t <= trajectory.totalMs; t += 2) {
        minDeg = Math.min(minDeg, signedXDeg(trajectory.sampleAt(t).pose.bones.L_UpLeg!));
      }
      if (expects) expect(minDeg, String(cls)).toBeLessThan(-1.5);
      else expect(minDeg, String(cls)).toBeGreaterThan(-0.5);
    }
  });

  it('cyclic (gait) ends are exempt — the terminal knot is not a stop to overshoot into', () => {
    const { trajectory } = mk([undefined, 'ballistic'], { cyclicEnds: true });
    let minDeg = Infinity;
    for (let t = 400; t <= trajectory.totalMs - 1; t += 2) {
      minDeg = Math.min(minDeg, signedXDeg(trajectory.sampleAt(t).pose.bones.L_UpLeg!));
    }
    expect(minDeg).toBeGreaterThan(-0.5);
  });
});

// ── Rig gates (real male GLB, headless) ──────────────────────────────────────

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
});

function sampleMotion(m: ComposedMotion, hz: number): {
  rec: MotionRecording;
  resolved: ReturnType<typeof resolveComposedMotion>;
} {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, m.name).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: hz,
  });
  return { rec, resolved };
}

function series(rec: MotionRecording, joint: string, motion: string): number[] {
  return rec.frames.map(
    (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, joint, motion) ?? 0,
  );
}

/** Time (ms) of the LAST sample still within `eps` of the series max — the
 *  instant the joint genuinely REVERSES away from its peak. */
function reversalMs(rec: MotionRecording, vals: number[], eps = 0.75): number {
  const max = Math.max(...vals);
  let last = 0;
  for (let i = 0; i < vals.length; i += 1) if (vals[i]! >= max - eps) last = rec.frames[i]!.tMs;
  return last;
}

describe('follow-through on the rig — wrist reversal lags shoulder reversal', () => {
  const fastWave: ComposedMotion = {
    name: 'fast arm wave',
    keyframes: [
      {
        durationMs: 400,
        velocityClass: 'functional',
        targets: [
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 110 },
          { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 45 },
        ],
      },
      {
        durationMs: 600,
        velocityClass: 'functional',
        targets: [
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 20 },
          { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 0 },
        ],
      },
    ],
  };

  it('the wrist reverses a measurable positive dt AFTER the shoulder — while both still settle on target (±2.5°)', () => {
    const { rec, resolved } = sampleMotion(fastWave, 120);
    const sh = series(rec, 'R_UpperArm', 'shoulderFlexion');
    const wr = series(rec, 'R_Hand', 'wristFlexion');

    // TEMPORAL overlap: the distal joint leaves its peak later than the proximal
    // one (the drag lives mid-segment; predicted lag here ≈ (0.1575 − 0.1125) ×
    // 600 ms ≈ 27 ms).
    const lagMs = reversalMs(rec, wr) - reversalMs(rec, sh);
    // eslint-disable-next-line no-console
    console.log(`fast wave: wrist reversal lags shoulder by ${lagMs.toFixed(1)} ms`);
    expect(lagMs, 'wrist reversal trails shoulder reversal').toBeGreaterThanOrEqual(8);
    expect(lagMs, 'the trail is a drag, not a detachment').toBeLessThan(150);

    // …and the settle/measurement contract is untouched: at each keyframe's
    // settle instant, the measured angles read the CLAMPED targets (the same
    // ±2.5° bound motionRecording.test.ts pins for the unwarped path).
    const settleMs = [400, 1000];
    for (const [ki, tMs] of settleMs.entries()) {
      const fi = rec.frames.findIndex((f) => Math.abs(f.tMs - tMs) < 1);
      expect(fi, `frame at settle ${tMs}`).toBeGreaterThanOrEqual(0);
      for (const t of resolved.keyframes[ki]!.targets) {
        if (!/^R_(UpperArm|Hand)$/.test(t.joint)) continue; // authored targets only
        const measured = measureCommandMotion(
          { at: '', variant: 'male', joints: rec.frames[fi]!.angles },
          t.joint,
          t.motion,
        );
        expect(
          Math.abs(measured! - t.clampedDegrees),
          `kf${ki} ${t.joint}.${t.motion}: ${measured} vs ${t.clampedDegrees}`,
        ).toBeLessThan(2.5);
      }
    }
  });
});

describe('terminal overshoot on the rig — a fast kick recovery lands with mass', () => {
  const kickish = (finalClass?: 'ballistic'): ComposedMotion => ({
    name: 'fast kick recovery',
    stance: 'planted',
    keyframes: [
      {
        durationMs: 350,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: -15 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 40 },
        ],
      },
      {
        durationMs: 250,
        velocityClass: 'functional',
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 65 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 5 },
        ],
      },
      {
        durationMs: 400,
        ...(finalClass ? { velocityClass: finalClass } : {}),
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
        ],
      },
    ],
  });

  it('the ballistic recovery dips measurably past the final hip target, then settles exact', () => {
    const { rec } = sampleMotion(kickish('ballistic'), 40);
    const hip = series(rec, 'R_UpLeg', 'hipFlexion');
    const final = hip[hip.length - 1]!;
    // Small measurable overshoot: the leg swings past the stand (≈ −3% of the
    // 65° inbound ≈ −2°) in the last ~160 ms, RELATIVE to the settled value.
    let minLate = Infinity;
    for (let i = 0; i < hip.length; i += 1) {
      if (rec.frames[i]!.tMs >= 780 && rec.frames[i]!.tMs < 1000) {
        minLate = Math.min(minLate, hip[i]!);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`kick recovery: overshoot ${(minLate - final).toFixed(2)}° past the settled hip`);
    expect(minLate - final, 'overshoot past the settled pose').toBeLessThan(-0.8);
    expect(minLate - final, 'small — a settle, not a bounce').toBeGreaterThan(-6);
    // Final pose exact: the settled hip reads its clamped 0° target.
    expect(Math.abs(final), 'final hip on target').toBeLessThan(2.5);
  });

  it('the same recovery WITHOUT the fast class keeps the clinical dead-straight ending', () => {
    const { rec } = sampleMotion(kickish(), 40);
    const hip = series(rec, 'R_UpLeg', 'hipFlexion');
    const final = hip[hip.length - 1]!;
    let minLate = Infinity;
    for (let i = 0; i < hip.length; i += 1) {
      if (rec.frames[i]!.tMs >= 780 && rec.frames[i]!.tMs < 1000) {
        minLate = Math.min(minLate, hip[i]!);
      }
    }
    expect(minLate - final, 'no overshoot on the deliberate ending').toBeGreaterThan(-0.5);
  });
});
