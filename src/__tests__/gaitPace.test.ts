/**
 * GAIT PACE GATE (Finding 6) — `paceGait` couples STRIDE (amplitude) and CADENCE
 * (timeScale) to walking speed, so a fast walk takes longer, quicker strides —
 * not the same stride played faster (all a bare timeScale did). Measured on the
 * real rig: faster ⇒ larger per-cycle hip/knee excursion AND a shorter period;
 * slower ⇒ shorter strides; speed 1 ≈ the authored template.
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
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, exportKinematics } from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion, paceGait } from '../services/movementTemplates';
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

const walk = () => templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

function excursions(m: ComposedMotion): { hip: number; knee: number; periodMs: number } {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60, loopCycle: true,
  });
  const ex = exportKinematics(rec);
  const exc = (k: string) => ex.summary.joints[k]!.excursionDeg;
  return {
    hip: (exc('R_UpLeg.hipFlexion') + exc('L_UpLeg.hipFlexion')) / 2,
    knee: (exc('R_Leg.kneeFlexion') + exc('L_Leg.kneeFlexion')) / 2,
    periodMs: rec.frames[rec.frames.length - 1]!.tMs,
  };
}

describe('paceGait — stride × cadence coupling', () => {
  it('speed 1 is (near-)identity in stride and cadence', () => {
    const base = excursions(walk());
    const paced = excursions(paceGait(walk(), 1));
    expect(Math.abs(paced.hip - base.hip)).toBeLessThan(2);
    expect(Math.abs(paced.knee - base.knee)).toBeLessThan(2);
    expect(Math.abs(paced.periodMs - base.periodMs)).toBeLessThan(30);
  });

  it('a faster walk takes LONGER strides AND a shorter period', () => {
    const base = excursions(walk());
    const fast = excursions(paceGait(walk(), 1.45));
    expect(fast.hip, 'hip excursion grows').toBeGreaterThan(base.hip + 3);
    expect(fast.knee, 'knee excursion grows').toBeGreaterThan(base.knee + 4);
    expect(fast.periodMs, 'cadence quickens (shorter period)').toBeLessThan(base.periodMs - 100);
  });

  it('a slower walk takes SHORTER strides AND a longer period (a shuffle)', () => {
    const base = excursions(walk());
    const slow = excursions(paceGait(walk(), 0.6));
    expect(slow.hip, 'hip excursion shrinks').toBeLessThan(base.hip - 2);
    expect(slow.knee, 'knee excursion shrinks').toBeLessThan(base.knee - 3);
    expect(slow.periodMs, 'cadence slows (longer period)').toBeGreaterThan(base.periodMs + 100);
  });

  it('sets modifiers.timeScale to √speed and scales stride by the same factor', () => {
    const fast = paceGait(walk(), 1.44);
    expect(fast.modifiers?.timeScale).toBeCloseTo(1.2, 2); // √1.44
    // A stride joint scaled by √1.44 = 1.2 (hip 30 → 36); a non-stride joint untouched.
    const kf0 = fast.keyframes[0]!;
    const hip = kf0.targets!.find((t) => t.joint === 'R_UpLeg' && t.motion === 'hipFlexion')!;
    expect(hip.targetDegrees).toBeCloseTo(36, 0);
  });
});
