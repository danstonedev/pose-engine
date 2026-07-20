/**
 * IDLE LIVELINESS (Wave 1 · item 1.1) — between commands the patient must keep
 * breathing, micro-swaying and slowly shifting weight instead of freezing into
 * a statue (the most-watched moment in a PT demo). The overlay is LIVE-ONLY
 * and additive: pure phase functions (services/liveliness) baked per idle rAF
 * frame as premultiplied trunk deltas + a small root X travel, and EXACTLY
 * undone before anything measures, records or animates.
 *
 * Gated at two layers:
 *  1) ON THE RIG — replicate the stage's exact application (same axes, same
 *     premultiply, same sign flip) on the real runtime GLB and measure the
 *     world-space result: the head visibly travels but stays subtle, the legs
 *     and every non-trunk bone stay byte-identical, the undo restores the pose
 *     exactly, and clean mode (amount 0) is a true statue.
 *  2) SOURCE PINS (the stage is WebGL + Svelte — unmountable here, same
 *     pattern as stageReliability.test.ts): the loop lifts the deltas BEFORE
 *     the recording tap and re-bakes them only when truly idle; every takeover
 *     and capture path lifts them first; the dirty flag stays honest.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey } from '../services/poseRig';
import {
  breathingLean,
  livelinessSwayDeg,
  idleWeightShift,
  IDLE_SHIFT_PEAK_M,
  IDLE_SHIFT_LEAN_PEAK_DEG,
} from '../services/liveliness';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const stageSource = readFileSync(
  fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)),
  'utf8',
);

// The stage's overlay axes (ExamStage3D _swayAxisAP / _swayAxisML).
const AXIS_AP = new THREE.Vector3(1, 0, 0);
const AXIS_ML = new THREE.Vector3(0, 0, 1);

describe('idle liveliness — measured on the rig', () => {
  const variantCfg = BODY_VARIANTS.male;
  const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
  let root: THREE.Object3D;
  let skinned: THREE.SkinnedMesh;
  let bones: Map<string, THREE.Bone>;

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
    bones = buildBoneByPoseKey(skinned.skeleton, variantCfg) as Map<string, THREE.Bone>;
  });

  /** Replicate the stage's applyIdleOverlays for one instant `tSec` (same
   *  axes, same premultiply order, same weight-shift sign flip), returning an
   *  undo. The stage bakes the root travel via bakePelvisShift (root X). */
  function applyIdleAt(tSec: number, amount: number, seed: number): () => void {
    const thorax = bones.get('Spine_Upper')!;
    const lowBack = bones.get('Spine_Lower')!;
    const baseThorax = thorax.quaternion.clone();
    const baseLumbar = lowBack.quaternion.clone();
    const baseRootX = root.position.x;
    const q = new THREE.Quaternion();
    const { mlDeg, apDeg } = livelinessSwayDeg(tSec, amount);
    const { shiftM, leanDeg } = idleWeightShift(tSec, amount, seed);
    q.setFromAxisAngle(AXIS_AP, (breathingLean(tSec, amount) * Math.PI) / 180);
    thorax.quaternion.premultiply(q);
    q.setFromAxisAngle(AXIS_ML, ((mlDeg - leanDeg) * Math.PI) / 180);
    lowBack.quaternion.premultiply(q);
    q.setFromAxisAngle(AXIS_AP, (apDeg * Math.PI) / 180);
    lowBack.quaternion.premultiply(q);
    root.position.x += shiftM;
    root.updateMatrixWorld(true);
    return () => {
      thorax.quaternion.copy(baseThorax);
      lowBack.quaternion.copy(baseLumbar);
      root.position.x = baseRootX;
      root.updateMatrixWorld(true);
    };
  }

  it('PINS the rig sign convention: +Z premultiplied roll at Spine_Lower moves the head toward −X (so the stage NEGATES the weight-shift lean)', () => {
    const lowBack = bones.get('Spine_Lower')!;
    const head = bones.get('Head')!;
    const p0 = new THREE.Vector3();
    head.getWorldPosition(p0);
    const saved = lowBack.quaternion.clone();
    const q = new THREE.Quaternion().setFromAxisAngle(AXIS_ML, (5 * Math.PI) / 180);
    lowBack.quaternion.premultiply(q);
    root.updateMatrixWorld(true);
    const p1 = new THREE.Vector3();
    head.getWorldPosition(p1);
    lowBack.quaternion.copy(saved);
    root.updateMatrixWorld(true);
    // If this flips (a re-rigged model), the `mlDeg - leanDeg` sign in
    // ExamStage3D applyIdleOverlays must flip with it.
    expect(p1.x - p0.x, 'a +Z roll at the low back tips the head toward −X').toBeLessThan(-0.02);
  });

  it('the weight-shift lean lands IN PHASE with the root travel — the head visibly settles over the loaded side, subtly', () => {
    const head = bones.get('Head')!;
    const rest = new THREE.Vector3();
    head.getWorldPosition(rest);
    const p = new THREE.Vector3();
    const seed = 42;
    const amount = 0.4; // the shipped default dial
    let xMin = Infinity;
    let xMax = -Infinity;
    let corr = 0;
    for (let t = 0; t <= 24; t += 1 / 30) {
      const undo = applyIdleAt(t, amount, seed);
      head.getWorldPosition(p);
      const headDx = p.x - rest.x;
      xMin = Math.min(xMin, headDx);
      xMax = Math.max(xMax, headDx);
      // In phase: the head's lateral displacement must FOLLOW the shift sign.
      const { shiftM } = idleWeightShift(t, amount, seed);
      corr += headDx * shiftM;
      undo();
    }
    const travelCm = (xMax - xMin) * 100;
    // eslint-disable-next-line no-console
    console.log(`idle rig: head lateral travel ${travelCm.toFixed(2)} cm over the shift cycle (amount 0.4)`);
    expect(travelCm, 'the settle is VISIBLE').toBeGreaterThan(0.8);
    expect(travelCm, 'but stays subtle — an idle settle, not a lurch').toBeLessThan(6);
    expect(corr, 'head displacement follows the shift (lean amplifies, never fights)').toBeGreaterThan(0);
  });

  it('breathing lives at the thorax: the chest/head rises-falls fore-aft while amount 0 is a true statue', () => {
    const head = bones.get('Head')!;
    const rest = new THREE.Vector3();
    head.getWorldPosition(rest);
    const p = new THREE.Vector3();
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let t = 0; t <= 8; t += 1 / 30) {
      const undo = applyIdleAt(t, 0.4, 42);
      head.getWorldPosition(p);
      zMin = Math.min(zMin, p.z - rest.z);
      zMax = Math.max(zMax, p.z - rest.z);
      undo();
    }
    expect((zMax - zMin) * 100, 'the breath is a real, if gentle, motion').toBeGreaterThan(0.3);
    // Clean mode: amount 0 leaves every sampled instant EXACTLY at rest.
    for (const t of [0.5, 1.7, 3.9]) {
      const undo = applyIdleAt(t, 0, 42);
      head.getWorldPosition(p);
      expect(p.distanceTo(rest)).toBe(0);
      undo();
    }
  });

  it('touches ONLY the trunk + root X: legs, arms and head local quats stay byte-identical (feet never skate from bone writes)', () => {
    const untouched = [
      'Hips', 'L_UpLeg', 'R_UpLeg', 'L_Leg', 'R_Leg', 'L_Foot', 'R_Foot',
      'L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm', 'Neck', 'Head',
    ];
    const before = untouched.map((k) => bones.get(k)!.quaternion.toArray());
    const undo = applyIdleAt(3.3, 1, 42);
    untouched.forEach((k, i) => {
      expect(bones.get(k)!.quaternion.toArray(), `${k} local quat untouched`).toEqual(before[i]);
    });
    undo();
  });

  it('the undo is EXACT: after lift, the pose is bit-identical to rest (recordings/goniometry can never inherit a residue)', () => {
    const thorax = bones.get('Spine_Upper')!;
    const lowBack = bones.get('Spine_Lower')!;
    const baseThorax = thorax.quaternion.toArray();
    const baseLumbar = lowBack.quaternion.toArray();
    const baseRootX = root.position.x;
    for (const t of [0.1, 2.6, 7.77]) {
      const undo = applyIdleAt(t, 1, 42);
      undo();
      expect(thorax.quaternion.toArray()).toEqual(baseThorax);
      expect(lowBack.quaternion.toArray()).toEqual(baseLumbar);
      expect(root.position.x).toBe(baseRootX);
    }
  });

  it('stays far inside trunk ROM: the peak lumbar lateral delta is bounded by the stated peaks (≈2.4° ≪ the ~8° gait-lean cap)', () => {
    // The stage applies (mlDeg − leanDeg) at the low back: bounded by the two
    // module peaks. Sweep and verify the ACTUAL applied angle never exceeds it.
    let peak = 0;
    for (let t = 0; t <= 60; t += 0.05) {
      const { mlDeg } = livelinessSwayDeg(t, 1);
      const { leanDeg } = idleWeightShift(t, 1, 42);
      peak = Math.max(peak, Math.abs(mlDeg - leanDeg));
    }
    expect(peak).toBeLessThanOrEqual(1.3 + IDLE_SHIFT_LEAN_PEAK_DEG + 1e-9); // SWAY_ML_PEAK + lean peak
    expect(peak).toBeLessThan(8); // the lateral-lean bound the gait gates use
    // And the root travel obeys its own stated bound (an order of magnitude
    // under the ±15 cm antalgic actuator clamp).
    expect(IDLE_SHIFT_PEAK_M).toBeLessThanOrEqual(0.15 / 10);
  });
});

describe('idle liveliness — stage wiring (source pins)', () => {
  it('the loop LIFTS the idle deltas before the recording tap (recordings sample the clean pose)', () => {
    expect(stageSource).toMatch(
      /if \(undoIdleOverlays\(\)\) renderNeeded = true;[\s\S]{0,700}if \(recording\) \{/,
    );
  });

  it('re-bakes ONLY when truly idle: no clip, no composed playback, no tween, no trajectory, posing layer not engaged', () => {
    expect(stageSource).toMatch(
      /!activeMotionId &&\s*\n\s*!composedActive &&\s*\n\s*!activeTween &&\s*\n\s*!activeTrajectory &&\s*\n\s*!poseLayerBusy\?\.\(\) &&\s*\n\s*applyIdleOverlays\(motionDelta\)/,
    );
  });

  it('the re-bake happens AFTER the recording tap and wakes the render only when deltas applied (dirty flag honest)', () => {
    expect(stageSource).toMatch(
      /if \(recording\) \{[\s\S]{0,1500}applyIdleOverlays\(motionDelta\)\s*\n\s*\) \{\s*\n\s*renderNeeded = true;/,
    );
  });

  it('every takeover lifts the deltas first: exam command, clip motion, composed playback, frame scrub', () => {
    expect(stageSource).toMatch(/undoIdleOverlays\(\); \/\/ the command starts from the clean idle pose/);
    expect(stageSource).toMatch(/undoIdleOverlays\(\); \/\/ the clip starts from the clean idle pose/);
    expect(stageSource).toMatch(/undoIdleOverlays\(\); \/\/ playback starts from the clean idle pose/);
    expect(stageSource).toMatch(/showRecordedFrameImpl = \(frame: RecordedFrame\) => \{[\s\S]{0,400}undoIdleOverlays\(\);/);
  });

  it('captureFrame/recording frames are built from the CLEAN pose and the overlay is restored at the same phase', () => {
    expect(stageSource).toMatch(
      /const hadIdleOverlay = undoIdleOverlays\(\);[\s\S]{0,200}buildFrameNowClean\(tMs\);[\s\S]{0,200}if \(hadIdleOverlay\) applyIdleOverlays\(0\);/,
    );
  });

  it('the pose API serializes/writes only the clean pose (getPose / loadPose / pose-play snapshot)', () => {
    expect(stageSource).toMatch(/getPose: \(\) => \{[\s\S]{0,400}undoIdleOverlays\(\);[\s\S]{0,200}serializeCustomPose/);
    expect(stageSource).toMatch(/loadPose: \(pose: CustomPose\) => \{[\s\S]{0,400}undoIdleOverlays\(\);/);
    expect(stageSource).toMatch(/undoIdleOverlays\(\);\s*\n\s*posePlayPosed = serializeCustomPose/);
  });

  it('the undo is an exact stored-base restore and un-bakes the idle root shift through the pelvis-shift tracker', () => {
    expect(stageSource).toMatch(
      /function undoIdleOverlays\(\): boolean \{[\s\S]{0,700}copy\(_idleBaseThoraxQ\)[\s\S]{0,300}copy\(_idleBaseLumbarQ\)[\s\S]{0,300}idleShiftM = 0;\s*\n\s*bakePelvisShift\(\);/,
    );
    // …and the bake target composes the two shifts, so idle can never clobber
    // the antalgic overlay (or vice versa).
    expect(stageSource).toMatch(/const targetM = motionPelvisShiftM \+ idleShiftM;/);
  });
});
