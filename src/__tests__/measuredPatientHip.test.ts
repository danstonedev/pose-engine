import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles, type JointAngleRestReference } from '../services/jointAngles';
import { buildComposedCommandPose } from '../services/movementCommand';
import { clampMeasuredPatientHip } from '../services/poseRomClamp';
import type { CustomPose } from '../types';

describe.each(['male', 'female', 'neutral'] as const)('%s measured patient hip projection', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skinned: THREE.SkinnedMesh, rest: JointAngleRestReference, baseline: CustomPose;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    root.traverse(object => { if (!skinned && (object as THREE.SkinnedMesh).isSkinnedMesh) skinned = object as THREE.SkinnedMesh; });
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    baseline = serializeCustomPose(skinned.skeleton, cfg, variant);
    rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    root.quaternion.setFromEuler(new THREE.Euler(Math.PI / 2, Math.PI / 3, 0));
  });

  it.each(['L', 'R'] as const)('preserves other measured channels while honoring locked/lower/upper bounds on %s', side => {
    const key = `${side}_UpLeg`, bone = buildBoneByPoseKey(skinned.skeleton, cfg).get(key)!;
    for (const availableRange of [{ min: 0, max: 0 }, { min: 15, max: 30 }, { min: -20, max: -5 }]) {
      const pose = buildComposedCommandPose(baseline, key, [
        { motion: 'hipFlexion', degrees: 0 }, { motion: 'hipAbduction', degrees: 8 }, { motion: 'hipRotation', degrees: -12 },
      ], cfg, baseline, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose); root.updateMatrixWorld(true);
      const before = computeJointAngles(skinned.skeleton, cfg, variant, rest).joints[key]!;
      const unchanged = bone.quaternion.toArray();
      expect(clampMeasuredPatientHip(bone, key, rest)).toBe(false);
      expect(bone.quaternion.toArray()).toEqual(unchanged);
      const constraints = { [key]: { hipFlexion: { availableRange } } };
      const target = THREE.MathUtils.clamp(before.hipFlexion!, availableRange.min, availableRange.max);
      clampMeasuredPatientHip(bone, key, rest, constraints);
      const after = computeJointAngles(skinned.skeleton, cfg, variant, rest).joints[key]!;
      expect(after.hipFlexion).toBeCloseTo(target, 6);
      expect(after.hipAbduction).toBeCloseTo(before.hipAbduction!, 6);
      expect(after.hipRotation).toBeCloseTo(before.hipRotation!, 6);
      const projected = bone.quaternion.toArray();
      expect(clampMeasuredPatientHip(bone, key, rest, constraints)).toBe(false);
      expect(bone.quaternion.toArray()).toEqual(projected);
    }
  });
});
