/**
 * GAIT BOUNCE / GLIDE GATE — `gaitBounce` tunes the vertical "spring vs glide"
 * quality of a walk. Measured on the rig: a GLIDE (amount 0) has a flatter
 * pelvis vertical excursion AND a lower knee lift (smooth, shuffling) than the
 * authored normal; a BOUNCE (amount 2) springs with a higher knee lift. Stride
 * (hip flexion) and cadence are untouched — bounce is orthogonal to speed.
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
import { MOVEMENT_TEMPLATES, templateToComposedMotion, gaitBounce } from '../services/movementTemplates';
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

function metrics(m: ComposedMotion): { verticalCm: number; kneeLift: number; hipExc: number } {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const rec = sampleComposedMotion(resolveComposedMotion(m, variantCfg), {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 120, loopCycle: true,
  });
  const ys = rec.frames.map((f) => f.worldTracks!['Hips']![1]);
  const ex = exportKinematics(rec);
  return {
    verticalCm: (Math.max(...ys) - Math.min(...ys)) * 100,
    kneeLift: ex.summary.joints['R_Leg.kneeFlexion']!.peakDeg,
    hipExc: ex.summary.joints['R_UpLeg.hipFlexion']!.excursionDeg,
  };
}

describe('gaitBounce — spring vs glide', () => {
  it('amount 1 is identity', () => {
    expect(gaitBounce(walk(), 1)).toEqual(walk());
  });

  it('GLIDE (0) is flatter and lower-kneed than normal; BOUNCE (2) springs higher', () => {
    const glide = metrics(gaitBounce(walk(), 0));
    const normal = metrics(walk());
    const bounce = metrics(gaitBounce(walk(), 2));

    // Glide: a noticeably flatter pelvis AND a lower knee lift (smooth shuffle).
    expect(glide.verticalCm, `glide ${glide.verticalCm} vs normal ${normal.verticalCm}`).toBeLessThan(
      normal.verticalCm * 0.75,
    );
    expect(glide.kneeLift, 'glide knee lift lower').toBeLessThan(normal.kneeLift - 8);

    // Bounce: a springier, higher knee lift than normal.
    expect(bounce.kneeLift, 'bounce knee lift higher').toBeGreaterThan(normal.kneeLift + 8);
  });

  it('leaves stride (hip flexion) essentially unchanged — bounce is orthogonal to speed', () => {
    const normal = metrics(walk());
    const glide = metrics(gaitBounce(walk(), 0));
    const bounce = metrics(gaitBounce(walk(), 2));
    expect(Math.abs(glide.hipExc - normal.hipExc), 'glide stride unchanged').toBeLessThan(2);
    expect(Math.abs(bounce.hipExc - normal.hipExc), 'bounce stride unchanged').toBeLessThan(2);
  });

  it('the glide still clears the ground (swing knee not collapsed to a drag)', () => {
    expect(metrics(gaitBounce(walk(), 0)).kneeLift, 'glide keeps some swing clearance').toBeGreaterThan(30);
  });
});
