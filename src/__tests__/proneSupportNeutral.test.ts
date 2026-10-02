import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { captureFloorReference } from '../services/rootMotion';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';

it('plays measured prone support on the neutral host model without requiring a native fixture', async () => {
  const cfg = BODY_VARIANTS.neutral;
  const bytes = readFileSync(new URL('../../models/painmap3D_neutral.runtime.glb', import.meta.url));
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const root = gltf.scene; root.scale.setScalar(cfg.pose.rootScale);
  let skinned: THREE.SkinnedMesh | undefined;
  root.traverse(object => { if (!skinned && (object as THREE.SkinnedMesh).isSkinnedMesh) skinned = object as THREE.SkinnedMesh; });
  expect(skinned).toBeDefined();
  root.updateMatrixWorld(true); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const floor = captureFloorReference(skinned!.skeleton, cfg, root);
  expect(floor.pronePelvisPoint?.every(Number.isFinite)).toBe(true);
  const baselinePose = serializeCustomPose(skinned!.skeleton, cfg, 'neutral');
  const rest = captureJointAngleRestReference(skinned!.skeleton, cfg);
  const resolved = resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg);
  expect(resolved.status).toBe('ok');
  const recording = sampleComposedMotion(resolved, { baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned: skinned! }, sampleHz: 10 });
  expect(recording.frames.length).toBeGreaterThan(20);
  for (const frame of recording.frames) {
    expect([...frame.root.translateM, ...frame.root.orientQuat].every(Number.isFinite)).toBe(true);
  }
  const setup = recording.frames.find(frame => frame.tMs === 1000)!;
  expect(setup).toBeDefined();
  expect(setup.worldTracks!.Hips![1] - floor.floorY).toBeGreaterThan(.07);
  expect(new THREE.Vector3().fromArray(setup.worldTracks!.Hips!).distanceTo(
    new THREE.Vector3().fromArray(recording.frames.at(-1)!.worldTracks!.Hips!),
  )).toBeLessThan(.006);
});
