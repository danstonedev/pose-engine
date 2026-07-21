/**
 * Motion recording (motionRecording.ts) — headless, against the REAL male
 * runtime rig (same harness as motionSequence.test.ts):
 *
 * 1. OFFLINE SAMPLER — sampleComposedMotion on the battery's guarded overhead
 *    reach: frame count == duration·hz ± 1, the frame at each keyframe settle
 *    time reads the keyframe's CLAMPED targets (±2.5°), angular velocities all
 *    finite and ≈0 during holds, deterministic (two samples deep-equal).
 * 2. EDIT OPS — trim/split boundaries + re-zeroing + frame integrity,
 *    bakeFrameEdit (edited frame exact, half-window neighbor ≈ halfway).
 * 3. EXPORT — summary peaks match known battery values; CSV header/rows.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { measureCommandMotion } from '../services/movementCommand';
import { buildCommandPose } from '../services/movementCommand';
import {
  resolveComposedMotion,
  type ComposedMotion,
  type ResolvedComposedMotion,
  type SequenceKeyframe,
} from '../services/motionSequence';
import {
  bakeFrameEdit,
  composedTweenEase,
  concatRecordings,
  compactRecording,
  exportKinematics,
  exportKinematicsCsv,
  recordingDurationMs,
  renameRecording,
  sampleComposedMotion,
  splitRecording,
  trimRecording,
  type MotionRecording,
  type RecordedFrame,
} from '../services/motionRecording';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;

const kf = (
  targets: { joint: string; motion: string; deg: number }[],
  durationMs: number,
  holdMs?: number,
): SequenceKeyframe => ({
  targets: targets.map((t) => ({ joint: t.joint, motion: t.motion, targetDegrees: t.deg })),
  durationMs,
  ...(holdMs != null ? { holdMs } : {}),
});

/** The battery's 3-keyframe 'guarded overhead reach' (right arm). */
const guardedOverheadReach = (): ComposedMotion => ({
  name: 'guarded overhead reach',
  keyframes: [
    kf(
      [
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', deg: 45 },
        { joint: 'R_Forearm', motion: 'elbowFlexion', deg: 30 },
      ],
      600,
    ),
    kf(
      [
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', deg: 110 },
        { joint: 'R_Forearm', motion: 'elbowFlexion', deg: 10 },
        { joint: 'Spine_Lower', motion: 'flexion', deg: -5 },
      ],
      800,
      400,
    ),
    kf(
      [
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', deg: 5 },
        { joint: 'R_Forearm', motion: 'elbowFlexion', deg: 0 },
        { joint: 'Spine_Lower', motion: 'flexion', deg: 0 },
      ],
      900,
    ),
  ],
});

const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let anatomicLocals: Map<THREE.Bone, THREE.Quaternion>;
let rootRestPos: THREE.Vector3;
let rootRestQuat: THREE.Quaternion;

function resetToAnatomic(): void {
  for (const [bone, q] of anatomicLocals) bone.quaternion.copy(q);
  root.position.copy(rootRestPos);
  root.quaternion.copy(rootRestQuat);
  root.updateMatrixWorld(true);
}

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.parse(arrayBuffer, '', resolve, reject);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  expect(skinned).toBeDefined();

  // The exact ExamStage3D boot order: anatomic pose FIRST, then rest-reference
  // capture, then the baseline-pose serialization every command builds from.
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  anatomicLocals = new Map();
  for (const bone of skinned.skeleton.bones) anatomicLocals.set(bone, bone.quaternion.clone());
  rootRestPos = root.position.clone();
  rootRestQuat = root.quaternion.clone();
});

function sampleReach(hz = 30): { resolved: ResolvedComposedMotion; rec: MotionRecording } {
  resetToAnatomic();
  const resolved = resolveComposedMotion(guardedOverheadReach(), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: hz,
  });
  return { resolved, rec };
}

/** Frame angle in the registry's clinical convention (same conversion the
 *  stage's measured outcomes use). */
function frameAngle(frame: RecordedFrame, joint: string, motion: string): number {
  const v = measureCommandMotion(
    { at: '', variant: 'male', joints: frame.angles },
    joint,
    motion,
  );
  expect(v, `${joint}.${motion} present`).toBeDefined();
  return v!;
}

function frameNearest(rec: MotionRecording, tMs: number): RecordedFrame {
  let best = rec.frames[0]!;
  for (const f of rec.frames) if (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  return best;
}

const TOL = 2.5;

describe('sampleComposedMotion — offline sampler on the real male rig', () => {
  it('easing is the shared stage curve (ease-in-out cubic)', () => {
    expect(composedTweenEase(0)).toBe(0);
    expect(composedTweenEase(0.5)).toBeCloseTo(0.5, 10);
    expect(composedTweenEase(1)).toBe(1);
    expect(composedTweenEase(0.25)).toBeCloseTo(4 * 0.25 ** 3, 10);
  });

  it('frame count == duration·hz ± 1 and timestamps are uniform', () => {
    const { rec } = sampleReach(30);
    // 600 + 800 (+400 hold) + 900 = 2700 ms total.
    const durationMs = recordingDurationMs(rec);
    expect(durationMs).toBeCloseTo(2700, 0);
    const expected = (2700 / 1000) * 30;
    expect(Math.abs(rec.frames.length - 1 - expected)).toBeLessThanOrEqual(1);
    for (let i = 1; i < rec.frames.length; i += 1) {
      expect(rec.frames[i]!.tMs).toBeGreaterThan(rec.frames[i - 1]!.tMs);
    }
    expect(rec.sampleHz).toBe(30);
    expect(rec.variant).toBe('male');
    expect(rec.sourceKind).toBe('composed');
    expect(rec.sourceName).toBe('guarded overhead reach');
  });

  it('the frame at each keyframe settle time reads the clamped targets (±2.5°)', () => {
    const { resolved, rec } = sampleReach(30);
    // Settle times: kf0 at 600, kf1 at 1400 (held to 1800), kf2 at 2700.
    const settleMs = [600, 1400, 2700];
    for (const [ki, tMs] of settleMs.entries()) {
      const frame = frameNearest(rec, tMs);
      for (const t of resolved.keyframes[ki]!.targets) {
        // FINGER READOUT TOLERANCE (see motionSequence.test.ts): the composite
        // digit-curl readout rides the mesh's molded finger bend, so the
        // relaxedHands background adds don't all measure back within ±2.5°.
        // Thumb (non-monotonic readout at low curls: cmd 0°→44°, 20°→26°) is
        // exempt; index (~3° molded-bend offset) gets ±4°; mid/ring/pinky +
        // wrist land within ±0.5° and keep the strict gate.
        if (t.joint === 'L_Thumb1' || t.joint === 'R_Thumb1') continue;
        const tol = t.motion === 'fingerFlexion' ? 4 : TOL;
        const measured = frameAngle(frame, t.joint, t.motion);
        expect(
          Math.abs(measured - t.clampedDegrees),
          `kf${ki} ${t.joint}.${t.motion}: ${measured} vs ${t.clampedDegrees}`,
        ).toBeLessThan(tol);
      }
    }
    // Every frame carries pose + measured angles + root + world tracks.
    for (const f of rec.frames) {
      expect(Object.keys(f.pose.bones).length).toBeGreaterThan(10);
      expect(f.root.orientQuat).toHaveLength(4);
      expect(f.worldTracks?.Hips).toBeDefined();
      expect(f.worldTracks?.R_Hand).toBeDefined();
    }
  });

  it('velocities are all finite and ≈0 during the hold', () => {
    const { rec } = sampleReach(30);
    const ex = exportKinematics(rec);
    const vel = ex.angularVelocityDegS['R_UpperArm.shoulderFlexion']!;
    expect(vel).toHaveLength(rec.frames.length);
    for (const v of Object.values(ex.angularVelocityDegS)) {
      for (const x of v) expect(Number.isFinite(x)).toBe(true);
    }
    // Hold window: 1400..1800 ms — take the interior samples.
    for (const [i, t] of ex.timesMs.entries()) {
      if (t > 1480 && t < 1720) expect(Math.abs(vel[i]!)).toBeLessThan(2);
    }
    // …and the shoulder genuinely moves during travel.
    expect(Math.max(...vel.map(Math.abs))).toBeGreaterThan(50);
  });

  it('is deterministic — two samples are deep-equal', () => {
    const a = sampleReach(30).rec;
    const b = sampleReach(30).rec;
    expect(b).toEqual(a);
    expect(b.id).toBe(a.id);
  });
});

describe('DET-LOCK-03 — guarding/sway are BAKED into the sampled recording (charter lockstep)', () => {
  // Guarding + balance-sway used to exist ONLY as a live stage overlay, so the
  // recording, the grade and the screen gave three answers. They are now folded
  // into the resolved keyframes (bakeGuardingSway), so the SAME
  // resolveComposedMotion → sampleComposedMotion the live stage builds from now
  // carries them — recording == grade == screen by construction. Headless.
  const reachWith = (modifiers?: ComposedMotion['modifiers']): MotionRecording => {
    resetToAnatomic();
    const m: ComposedMotion = { ...guardedOverheadReach(), ...(modifiers ? { modifiers } : {}) };
    return sampleComposedMotion(resolveComposedMotion(m, variantCfg), {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 60,
    });
  };
  const excursion = (rec: MotionRecording, joint: string, motion: string): number => {
    const vals = rec.frames.map((f) => frameAngle(f, joint, motion));
    return Math.max(...vals) - Math.min(...vals);
  };

  it('guarding REDUCES the trunk + arm excursion vs unguarded (measurable, headless)', () => {
    const plain = reachWith();
    const guarded = reachWith({ guarding: 0.9 });
    const armPlain = excursion(plain, 'R_UpperArm', 'shoulderFlexion');
    const armGuarded = excursion(guarded, 'R_UpperArm', 'shoulderFlexion');
    // eslint-disable-next-line no-console
    console.log(`DET-LOCK-03: shoulder excursion plain ${armPlain.toFixed(1)}° → guarded ${armGuarded.toFixed(1)}°`);
    // The guarded, protective pattern damps the reach markedly — but does not freeze it.
    expect(armGuarded, 'guarding damps the excursion').toBeLessThan(armPlain * 0.7);
    expect(armGuarded, 'still a reach, not frozen').toBeGreaterThan(2);
  });

  it('balance-sway ADDS a low-back lean that is absent unguarded (measurable, headless)', () => {
    const plain = reachWith();
    const swayed = reachWith({ balanceSway: 1 });
    const lateralPlain = excursion(plain, 'Spine_Lower', 'lateralTilt');
    const lateralSway = excursion(swayed, 'Spine_Lower', 'lateralTilt');
    // eslint-disable-next-line no-console
    console.log(`DET-LOCK-03: low-back lateral excursion plain ${lateralPlain.toFixed(1)}° → sway ${lateralSway.toFixed(1)}°`);
    // The reach authors no lateral lean; sway introduces a measurable one.
    expect(lateralSway, 'sway adds a low-back wobble').toBeGreaterThan(lateralPlain + 2);
  });

  it('clean mode (guarding/sway 0) is byte-identical to the un-modified sample — a true no-op', () => {
    const plainFrames = reachWith().frames.map((f) => f.angles);
    const zeroed = reachWith({ guarding: 0, balanceSway: 0 }).frames.map((f) => f.angles);
    expect(zeroed).toEqual(plainFrames);
  });
});

describe('edit operations (pure, non-mutating)', () => {
  it('trimRecording keeps only [start, end], re-zeroes, preserves frames', () => {
    const { rec } = sampleReach(30);
    const before = rec.frames.length;
    const trimmed = trimRecording(rec, 600, 1800);
    expect(rec.frames).toHaveLength(before); // non-mutating
    expect(trimmed.frames.length).toBeGreaterThan(0);
    expect(trimmed.frames[0]!.tMs).toBe(0);
    expect(recordingDurationMs(trimmed)).toBeLessThanOrEqual(1200 + 1e-6);
    // The first kept frame is the old nearest-to-600 frame, intact.
    const src = frameNearest(rec, trimmed.frames[0]!.tMs + 600);
    expect(trimmed.frames[0]!.pose).toEqual(src.pose);
    expect(trimmed.frames[0]!.angles).toEqual(src.angles);
    // Reversed bounds behave the same.
    expect(trimRecording(rec, 1800, 600).frames).toHaveLength(trimmed.frames.length);
  });

  it('splitRecording yields two re-zeroed clips sharing the seam frame', () => {
    const { rec } = sampleReach(30);
    const [a, b] = splitRecording(rec, 1400);
    const seam = frameNearest(rec, 1400);
    expect(a.frames[a.frames.length - 1]!.pose).toEqual(seam.pose);
    expect(b.frames[0]!.pose).toEqual(seam.pose);
    expect(b.frames[0]!.tMs).toBe(0);
    expect(a.frames[0]!.tMs).toBe(0);
    // Every source frame lands in exactly one half (seam in both).
    expect(a.frames.length + b.frames.length).toBe(rec.frames.length + 1);
    expect(a.id).not.toBe(b.id);
    expect(recordingDurationMs(a)).toBeCloseTo(seam.tMs, 5);
    expect(recordingDurationMs(b)).toBeCloseTo(recordingDurationMs(rec) - seam.tMs, 5);
  });

  it('bakeFrameEdit: edited frame exact, half-window neighbor ≈ halfway', () => {
    const { rec } = sampleReach(30);
    // Edit the hold frame at ~1600ms: elbow to 60° instead of the settled 10°.
    const editedPose = buildCommandPose(
      baselinePose,
      { action: 'set-joint', joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 60 },
      60,
      variantCfg,
      frameNearest(rec, 1600).pose,
      rest,
    )!;
    expect(editedPose).toBeTruthy();
    const measure = (pose: CustomPose) => {
      applyCustomPose(skinned.skeleton, variantCfg, pose);
      root.updateMatrixWorld(true);
      const report = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
      const out: Record<string, Record<string, number>> = {};
      for (const [j, set] of Object.entries(report.joints)) out[j] = { ...set };
      return out;
    };
    const baked = bakeFrameEdit(rec, 1600, editedPose, { blendMs: 300, measure });
    expect(baked.frames).toHaveLength(rec.frames.length);
    const center = frameNearest(baked, 1600);
    expect(center.pose).toBe(editedPose);
    expect(Math.abs(frameAngle(center, 'R_Forearm', 'elbowFlexion') - 60)).toBeLessThan(TOL);
    // Neighbor at the half window (±150ms) sits ≈ halfway between the
    // original 10° and the edited 60° → ~35°.
    const centerT = center.tMs;
    const half = frameNearest(baked, centerT + 150);
    const w = 1 - Math.abs(half.tMs - centerT) / 300;
    const expected = 10 + (60 - 10) * w;
    expect(Math.abs(frameAngle(half, 'R_Forearm', 'elbowFlexion') - expected)).toBeLessThan(4);
    // Outside the window: untouched (same object).
    const far = frameNearest(baked, centerT + 500);
    const farSrc = frameNearest(rec, far.tMs);
    expect(far).toBe(farSrc);
    // Original untouched (non-mutating).
    expect(
      Math.abs(frameAngle(frameNearest(rec, centerT), 'R_Forearm', 'elbowFlexion') - 10),
    ).toBeLessThan(TOL);
  });

  it('rename / concat / compact behave', () => {
    const { rec } = sampleReach(30);
    expect(renameRecording(rec, 'renamed').name).toBe('renamed');
    expect(renameRecording(rec, 'renamed')).not.toBe(rec);
    const joined = concatRecordings(rec, rec);
    expect(joined.frames).toHaveLength(rec.frames.length * 2);
    expect(recordingDurationMs(joined)).toBeGreaterThan(recordingDurationMs(rec) * 2);
    const compact = compactRecording(rec, 3);
    expect(compact.frames).toHaveLength(rec.frames.length);
    const q = compact.frames[5]!.pose.bones['R_UpperArm']!;
    for (const c of q) expect(c).toBe(Math.round(c * 1000) / 1000);
  });
});

describe('exportKinematics / exportKinematicsCsv', () => {
  it('summary peaks match the battery targets; schema documents itself', () => {
    const { rec } = sampleReach(30);
    const ex = exportKinematics(rec, { provenance: { composedMotion: guardedOverheadReach() } });
    expect(ex.schema).toContain('degrees');
    expect(ex.schema).toContain('provenance');
    expect(ex.meta.name).toBe('guarded overhead reach');
    expect(ex.meta.frameCount).toBe(rec.frames.length);
    expect(ex.meta.durationMs).toBeCloseTo(2700, 0);
    expect(ex.provenance?.composedMotion).toBeDefined();
    // Battery values: shoulder peaks ≈110 (kf1), elbow ≈30 (kf0), trunk min ≈ −5.
    const shoulder = ex.summary.joints['R_UpperArm.shoulderFlexion']!;
    expect(Math.abs(shoulder.peakDeg - 110)).toBeLessThan(TOL);
    expect(shoulder.timeOfPeakMs).toBeGreaterThan(1300);
    expect(shoulder.timeOfPeakMs).toBeLessThan(1900);
    expect(shoulder.excursionDeg).toBeGreaterThan(100);
    expect(Math.abs(shoulder.peakVelocityDegS)).toBeGreaterThan(50);
    const elbow = ex.summary.joints['R_Forearm.elbowFlexion']!;
    expect(Math.abs(elbow.peakDeg - 30)).toBeLessThan(TOL);
    // Tracked-bone kinematics: the reaching hand travels; the feet stay put.
    const hand = ex.summary.bones['R_Hand']!;
    expect(hand.pathLengthM).toBeGreaterThan(0.5);
    expect(hand.peakSpeedMs).toBeGreaterThan(0.3);
    expect(ex.summary.bones['L_Foot']!.pathLengthM).toBeLessThan(0.05);
    expect(ex.trajectories['R_Hand']).toHaveLength(rec.frames.length);
    expect(ex.speedsMs['R_Hand']).toHaveLength(rec.frames.length);
    // No root motion in this battery.
    expect(ex.summary.root.maxTranslateM.magnitude).toBeLessThan(1e-6);
    expect(ex.summary.root.orientationKeyPoints.length).toBeGreaterThanOrEqual(1);
    // JSON-serializable round trip.
    expect(() => JSON.stringify(ex)).not.toThrow();
  });

  it('CSV: header + one row per frame, tMs first, joint.motion columns', () => {
    const { rec } = sampleReach(30);
    const csv = exportKinematicsCsv(rec);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(rec.frames.length + 1);
    const header = lines[0]!.split(',');
    expect(header[0]).toBe('tMs');
    expect(header).toContain('R_UpperArm.shoulderFlexion');
    expect(header).toContain('R_Forearm.elbowFlexion');
    // Every row has the header's column count.
    for (const line of lines.slice(1)) expect(line.split(',')).toHaveLength(header.length);
    expect(lines[1]!.startsWith('0,')).toBe(true);
  });
});
