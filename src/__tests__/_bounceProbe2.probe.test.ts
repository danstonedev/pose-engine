import { beforeAll, describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { measureCommandMotion } from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D, skinned: THREE.SkinnedMesh, rest: JointAngleRestReference, baselinePose: CustomPose;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder); l.parse(ab, '', res as never, rej);
  });
  root = gltf.scene; root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh; });
  root.updateMatrixWorld(true); applyAnatomicPose(root, variantCfg); root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
});

describe('BOUNCE PROBE 2', () => {
  it('per-phase Hips/Foot Y profile', () => {
    applyAnatomicPose(root, variantCfg); root.updateMatrixWorld(true);
    const rec = sampleComposedMotion(resolveComposedMotion(templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!), variantCfg), { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 120, loopCycle: true });
    const at = (tMs: number) => rec.frames.reduce((b, f) => Math.abs(f.tMs - tMs) < Math.abs(b.tMs - tMs) ? f : b);
    console.log('\n=== per-phase (loopCycle) ===');
    console.log('ph  tMs   HipsY   LFootY  RFootY  Lknee Rknee Lank Rank');
    for (let i = 0; i < 8; i++) {
      const t = i * 200;
      const f = at(t);
      const lk = measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'L_Leg', 'kneeFlexion') ?? 0;
      const rk = measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'R_Leg', 'kneeFlexion') ?? 0;
      const la = measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'L_Foot', 'ankleFlexion') ?? 0;
      const ra = measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'R_Foot', 'ankleFlexion') ?? 0;
      console.log(`${i}  ${t.toString().padStart(4)}  ${f.worldTracks!['Hips']![1].toFixed(3)}  ${f.worldTracks!['L_Foot']![1].toFixed(3)}  ${f.worldTracks!['R_Foot']![1].toFixed(3)}  ${lk.toFixed(0).padStart(4)} ${rk.toFixed(0).padStart(4)} ${la.toFixed(0).padStart(4)} ${ra.toFixed(0).padStart(4)}`);
    }
    const ys = rec.frames.map((f) => f.worldTracks!['Hips']![1]);
    console.log(`Hips Y range ${((Math.max(...ys) - Math.min(...ys)) * 100).toFixed(1)} cm`);
  });
});
