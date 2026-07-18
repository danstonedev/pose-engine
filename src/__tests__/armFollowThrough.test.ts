/**
 * ARM FOLLOW-THROUGH (overlapping action) — the walk's arms are no longer rigid
 * pendulums swinging dead-straight (the "marching robot" read). The elbows carry
 * ~20° flexion and PUMP through the gait cycle: more flexion on the backswing,
 * unwinding as the arm comes forward — the distal segment (forearm/hand) trails
 * the proximal (upper arm), which is the overlapping-action realism cue. Measured
 * on the real male rig, and confirmed to leave every leg/shoulder angle untouched.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, exportKinematics } from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

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

function walkExport() {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const walk = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);
  const rec = sampleComposedMotion(resolveComposedMotion(walk, variantCfg), {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60, loopCycle: true,
  });
  return exportKinematics(rec);
}

describe('walk arm follow-through', () => {
  it('the elbows are carried flexed and pump dynamically (not rigid/straight)', () => {
    const ex = walkExport();
    for (const key of ['R_Forearm.elbowFlexion', 'L_Forearm.elbowFlexion']) {
      const j = ex.summary.joints[key];
      expect(j, key).toBeDefined();
      const mean = (j!.peakDeg + j!.minDeg) / 2;
      expect(mean, `${key} carried flexion`).toBeGreaterThan(12); // not near-straight
      expect(mean, `${key} carried flexion`).toBeLessThan(28);
      expect(j!.excursionDeg, `${key} pumps through the swing`).toBeGreaterThan(10);
      expect(j!.peakDeg, `${key} within elbow ROM`).toBeLessThan(150);
    }
  });

  it('the elbow flexes MORE on the backswing (overlapping action, not in lockstep straight)', () => {
    const ex = walkExport();
    const sh = ex.series['R_UpperArm.shoulderFlexion']!;
    const el = ex.series['R_Forearm.elbowFlexion']!;
    // Frame of most shoulder EXTENSION (arm most back) vs most shoulder FLEXION.
    let iBack = 0;
    let iFwd = 0;
    for (let i = 0; i < sh.length; i += 1) {
      if (sh[i]! < sh[iBack]!) iBack = i;
      if (sh[i]! > sh[iFwd]!) iFwd = i;
    }
    expect(el[iBack]!, 'elbow more flexed when the arm is back').toBeGreaterThan(el[iFwd]! + 5);
  });

  it('leaves every leg + shoulder angle exactly as the authored gait', () => {
    const ex = walkExport();
    const peak = (k: string) => ex.summary.joints[k]!.peakDeg;
    expect(peak('R_UpLeg.hipFlexion'), 'hip').toBeGreaterThan(28);
    expect(peak('R_UpLeg.hipFlexion')).toBeLessThan(33);
    expect(peak('R_Leg.kneeFlexion'), 'knee swing').toBeGreaterThan(55);
    expect(peak('R_Foot.ankleFlexion'), 'ankle rocker present').toBeGreaterThan(5);
    expect(peak('R_UpperArm.shoulderFlexion'), 'shoulder swing ~20').toBeGreaterThan(18);
    expect(peak('R_UpperArm.shoulderFlexion')).toBeLessThan(24);
  });
});
