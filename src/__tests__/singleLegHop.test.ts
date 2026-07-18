/**
 * buildSingleLegHop — a hop on ONE leg must actually leave the ground: the support
 * (hopping) foot pushes off and clears the floor during the floating apex, while the
 * other leg is held up throughout. Same airborne mechanism as buildJump/buildRun
 * (floating phases + up-travel, not floor-pinned).
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
import { sampleComposedMotion } from '../services/motionRecording';
import { buildSingleLegHop } from '../services/movementTemplates';
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

const yOf = (rec: ReturnType<typeof sampleComposedMotion>, key: string): number[] =>
  rec.frames.map((f) => f.worldTracks![key]![1]);

describe('buildSingleLegHop — the hopping foot leaves the ground', () => {
  it('the support (left) foot clears the floor during the airborne apex', () => {
    const rec = sampleComposedMotion(resolveComposedMotion(buildSingleLegHop({ stance: 'L' }), variantCfg), {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 60,
    });
    const lFoot = yOf(rec, 'L_Foot'); // the hopping foot
    const floor = Math.min(...lFoot); // its grounded (load/land) level
    const clearance = Math.max(...lFoot) - floor;
    // eslint-disable-next-line no-console
    console.log(`single-leg hop: the hopping foot clears the floor by ${(clearance * 100).toFixed(1)} cm`);
    expect(clearance, 'the hopping foot must leave the ground').toBeGreaterThan(0.08);
  });
});
