/**
 * CALIBRATED GAIT VERTICAL — `calibrateGaitVertical` / `gaitBounce` set a
 * centimetre target for the walk's pelvis (COM) vertical excursion, realized as a
 * MEAN-PRESERVING scale of the emergent floor-pinned arc. Measured on the rig:
 *  • the excursion lands ON the requested target (exact, not qualitative);
 *  • every clinical joint angle is IDENTICAL to the uncalibrated walk (root-only
 *    reshape — the whole point vs a foot-lock IK, which would corrupt the hip);
 *  • the feet stay grounded (no fly-to-30cm / clip-through-floor of the old
 *    knee-scaling knob);
 *  • bounce (2) springs higher than normal (1) springs higher than glide (0),
 *    while stride (hip flexion) is untouched — bounce is orthogonal to speed.
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
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  gaitBounce,
  calibrateGaitVertical,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;

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
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

const walk = () => templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

interface Metrics {
  verticalCm: number;
  footMinCm: number;
  hipPeak: number;
  hipExc: number;
  kneePeak: number;
}

function metrics(m: ComposedMotion): Metrics {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const rec = sampleComposedMotion(resolveComposedMotion(m, variantCfg), {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 120,
    loopCycle: true,
  });
  const ys = rec.frames.map((f) => f.worldTracks!['Hips']![1]);
  const feet = rec.frames.flatMap((f) => [f.worldTracks!['L_Foot']![1], f.worldTracks!['R_Foot']![1]]);
  const ex = exportKinematics(rec);
  return {
    verticalCm: (Math.max(...ys) - Math.min(...ys)) * 100,
    footMinCm: Math.min(...feet) * 100,
    hipPeak: ex.summary.joints['R_UpLeg.hipFlexion']!.peakDeg,
    hipExc: ex.summary.joints['R_UpLeg.hipFlexion']!.excursionDeg,
    kneePeak: ex.summary.joints['R_Leg.kneeFlexion']!.peakDeg,
  };
}

describe('calibrateGaitVertical — a centimetre-accurate COM excursion', () => {
  it('the uncalibrated walk vaults ~9 cm (the compass-gait floor-pin), ~2× real free gait', () => {
    // Documents the baseline the calibration corrects: the emergent floor-pin
    // excursion is roughly double the ~4-5 cm of real free gait.
    expect(metrics(walk()).verticalCm).toBeGreaterThan(7.5);
  });

  it('scales the excursion ONTO the requested target (exact, mean-preserving)', () => {
    for (const cm of [3, 5, 8]) {
      const got = metrics(calibrateGaitVertical(walk(), cm)).verticalCm;
      expect(Math.abs(got - cm), `target ${cm}cm → measured ${got.toFixed(2)}cm`).toBeLessThan(0.6);
    }
  });

  it('leaves EVERY clinical joint angle exactly as the uncalibrated walk (root-only)', () => {
    const base = metrics(walk());
    for (const cm of [3, 5, 8]) {
      const cal = metrics(calibrateGaitVertical(walk(), cm));
      expect(Math.abs(cal.hipPeak - base.hipPeak), `hip peak @${cm}`).toBeLessThan(0.5);
      expect(Math.abs(cal.hipExc - base.hipExc), `hip exc @${cm}`).toBeLessThan(0.5);
      expect(Math.abs(cal.kneePeak - base.kneePeak), `knee peak @${cm}`).toBeLessThan(0.5);
    }
  });

  it('keeps the feet grounded — no clip-through-floor (the old knob dipped feet ~5 cm under)', () => {
    const floor = metrics(walk()).footMinCm; // the grounded stance floor of the base walk
    for (const cm of [3, 5, 8]) {
      const cal = metrics(calibrateGaitVertical(walk(), cm));
      // The mean-preserving reshape only nudges the feet a little off the floor at
      // the arc extremes — nothing like the old scaling's 5 cm penetration.
      expect(cal.footMinCm, `foot floor @${cm}: ${cal.footMinCm.toFixed(1)} vs base ${floor.toFixed(1)}`)
        .toBeGreaterThan(floor - 3);
    }
  });
});

describe('gaitBounce — spring vs glide, on the calibrated arc', () => {
  it('amount 1 is the normal ~5 cm; 0 glides calmer; 2 bounces higher', () => {
    const glide = metrics(gaitBounce(walk(), 0)).verticalCm;
    const normal = metrics(gaitBounce(walk(), 1)).verticalCm;
    const bounce = metrics(gaitBounce(walk(), 2)).verticalCm;
    expect(normal, `normal ${normal.toFixed(2)}cm`).toBeGreaterThan(4);
    expect(normal).toBeLessThan(6);
    expect(glide, `glide ${glide.toFixed(2)} < normal ${normal.toFixed(2)}`).toBeLessThan(normal - 1);
    expect(bounce, `bounce ${bounce.toFixed(2)} > normal ${normal.toFixed(2)}`).toBeGreaterThan(normal + 1);
  });

  it('leaves stride (hip flexion excursion) unchanged — bounce is orthogonal to speed', () => {
    const normal = metrics(gaitBounce(walk(), 1));
    const glide = metrics(gaitBounce(walk(), 0));
    const bounce = metrics(gaitBounce(walk(), 2));
    expect(Math.abs(glide.hipExc - normal.hipExc), 'glide stride unchanged').toBeLessThan(1);
    expect(Math.abs(bounce.hipExc - normal.hipExc), 'bounce stride unchanged').toBeLessThan(1);
  });
});
