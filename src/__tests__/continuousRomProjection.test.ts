import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, measureHingeFlexion, type JointAngleRestReference } from '../services/jointAngles';
import { clampBoneToRom, clampMeasuredPatientHinge, inspectClinicalAngles } from '../services/poseRomClamp';
import { buildComposedCommandPose } from '../services/movementCommand';
import type { CustomPose } from '../types';
import type { RomScenarioConstraints } from '../services/romConstraints';

const continuous = { continuousProjection: true };
const angularDistance = (a: THREE.Quaternion, b: THREE.Quaternion) => {
  const q = a.clone().normalize().conjugate().multiply(b.clone().normalize());
  return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), Math.abs(q.w)) * 180 / Math.PI;
};

describe.each(['male', 'female', 'neutral'] as const)('%s continuous contact projection', variant => {
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
  });

  it.each(['L', 'R'] as const)('projects tiny bound violations continuously on the %s clavicle without changing the interactive clamp', side => {
    applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    const key = `${side}_Shoulder`, bones = buildBoneByPoseKey(skinned.skeleton, cfg), bone = bones.get(key)!, hand = bones.get(`${side}_Hand`)!;
    const restQ = new THREE.Quaternion().fromArray(rest.localQuats[key]!);
    const setRotation = (degrees: number) => {
      bone.quaternion.setFromEuler(new THREE.Euler(0, -degrees * Math.PI / 180, 0, 'YXZ')).multiply(restQ);
      root.updateMatrixWorld(true);
    };
    for (const availableRange of [{ min: -30, max: 30 }, { min: -12, max: 17 }, { min: 6, max: 6 }]) for (const sign of [-1, 1]) {
      const constraints: RomScenarioConstraints | null = availableRange.min === -30 ? null : { [key]: { protraction: { availableRange } } };
      const bound = sign < 0 ? availableRange.min : availableRange.max;
      setRotation(bound + sign * .00005);
      const incoming = bone.quaternion.toArray();
      expect(clampBoneToRom(bone, key, rest, constraints, true)).toBe(false);
      expect(bone.quaternion.toArray()).toEqual(incoming);
      clampBoneToRom(bone, key, rest, constraints, true, continuous);
      expect(inspectClinicalAngles(bone, key, rest, constraints)!.anatomicRotation).toBeCloseTo(bound, 6);
      const first = bone.quaternion.clone();
      clampBoneToRom(bone, key, rest, constraints, true, continuous);
      expect(angularDistance(first, bone.quaternion)).toBeLessThan(1e-7);

      // The former outward dead band could turn a vanishing input step into
      // a finite pose jump. Check the actual distal point as well as angles.
      const center = bone.quaternion.clone(); root.updateMatrixWorld(true);
      const centerPoint = hand.getWorldPosition(new THREE.Vector3());
      for (const stepDeg of [1e-8, 1e-6, .0001]) for (const direction of [-1, 1]) {
        bone.quaternion.copy(center).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), direction * stepDeg * Math.PI / 180));
        clampBoneToRom(bone, key, rest, constraints, true, continuous); root.updateMatrixWorld(true);
        expect(angularDistance(center, bone.quaternion)).toBeLessThan(2 * stepDeg + 1e-7);
        expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(centerPoint)).toBeLessThan(2 * stepDeg * Math.PI / 180 + 1e-8);
        const actual = inspectClinicalAngles(bone, key, rest, constraints)!.anatomicRotation;
        expect(actual).toBeGreaterThanOrEqual(availableRange.min - 1e-6);
        expect(actual).toBeLessThanOrEqual(availableRange.max + 1e-6);
      }
      // Opting in is scoped to this call, not a shared toggle.
      setRotation(bound + sign * .00005);
      expect(clampBoneToRom(bone, key, rest, constraints, true)).toBe(false);
    }
  });

  it.each(['L', 'R'] as const)('continuously projects tiny explicit patient hinge violations on %s without changing the default', side => {
    const bones = buildBoneByPoseKey(skinned.skeleton, cfg);
    for (const limb of ['arm', 'leg']) for (const unitInput of [false, true]) for (const locked of [false, true]) for (const sign of [-1, 1]) {
      const key = `${side}_${limb === 'arm' ? 'Forearm' : 'Leg'}`, field = limb === 'arm' ? 'elbowFlexion' : 'kneeFlexion';
      const parent = bones.get(`${side}_${limb === 'arm' ? 'UpperArm' : 'UpLeg'}`)!, bone = bones.get(key)!;
      const pose = buildComposedCommandPose(baseline, key, [{ motion: field, degrees: 50 }], cfg, baseline, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose);
      // Cover both real Float32 command/rest inputs and exact unit inputs.
      if (unitInput) bone.quaternion.normalize();
      root.updateMatrixWorld(true);
      const measured = measureHingeFlexion(parent, bone, key, rest)!;
      const target = measured - sign * 5e-8;
      const availableRange = locked ? { min: target, max: target }
        : sign < 0 ? { min: target, max: target + 10 } : { min: target - 10, max: target };
      const constraints = { [key]: { [field]: { availableRange } } };
      const incoming = bone.quaternion.clone();
      expect(clampMeasuredPatientHinge(parent, bone, key, rest, undefined, continuous)).toBe(false);
      expect(bone.quaternion.toArray()).toEqual(incoming.toArray());
      bone.quaternion.normalize(); root.updateMatrixWorld(true);
      const expected = THREE.MathUtils.clamp(measureHingeFlexion(parent, bone, key, rest)!, availableRange.min, availableRange.max);
      bone.quaternion.copy(incoming); root.updateMatrixWorld(true);
      expect(clampMeasuredPatientHinge(parent, bone, key, rest, constraints)).toBe(false);
      expect(bone.quaternion.toArray()).toEqual(incoming.toArray());
      const otherLocals = skinned.skeleton.bones.filter(other => other !== bone).map(other => [...other.position.toArray(), ...other.quaternion.toArray(), ...other.scale.toArray()]);
      clampMeasuredPatientHinge(parent, bone, key, rest, constraints, continuous);
      expect(skinned.skeleton.bones.filter(other => other !== bone).map(other => [...other.position.toArray(), ...other.quaternion.toArray(), ...other.scale.toArray()])).toEqual(otherLocals);
      expect(Math.abs(measureHingeFlexion(parent, bone, key, rest)! - expected)).toBeLessThan(1e-10);
      const projected = bone.quaternion.clone();
      clampMeasuredPatientHinge(parent, bone, key, rest, constraints, continuous);
      expect(angularDistance(projected, bone.quaternion)).toBeLessThan(1e-10);
      for (const stepDeg of [1e-10, 1e-8, 1e-6]) for (const direction of [-1, 1]) {
        bone.quaternion.copy(projected).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), direction * stepDeg * Math.PI / 180));
        clampMeasuredPatientHinge(parent, bone, key, rest, constraints, continuous);
        expect(angularDistance(projected, bone.quaternion)).toBeLessThan(2 * stepDeg + 1e-10);
        const actual = measureHingeFlexion(parent, bone, key, rest)!;
        expect(actual).toBeGreaterThanOrEqual(availableRange.min - 1e-10);
        expect(actual).toBeLessThanOrEqual(availableRange.max + 1e-10);
      }
      bone.quaternion.copy(incoming);
      expect(clampMeasuredPatientHinge(parent, bone, key, rest, constraints)).toBe(false);
      expect(bone.quaternion.toArray()).toEqual(incoming.toArray());
    }
  });
});
