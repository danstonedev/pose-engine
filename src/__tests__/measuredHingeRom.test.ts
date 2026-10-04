import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles, measureHingeFlexion, type JointAngleRestReference } from '../services/jointAngles';
import { buildComposedCommandPose } from '../services/movementCommand';
import { clampBoneToRom, clampContactHingeToRom, clampMeasuredHingeToRom, clampMeasuredPatientHinge, inspectClinicalAngles, setRomClampEnabled } from '../services/poseRomClamp';
import { getEffectiveRomRange, type RomScenarioConstraints } from '../services/romConstraints';
import type { CustomPose } from '../types';

const continuous = { continuousProjection: true };
const distanceDeg = (a: THREE.Quaternion, b: THREE.Quaternion) => {
  const q = a.clone().normalize().conjugate().multiply(b.clone().normalize());
  return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), Math.abs(q.w)) * 180 / Math.PI;
};
describe.each(['male', 'female', 'neutral'] as const)('%s measured hinge contact range', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skin: THREE.SkinnedMesh, rest: JointAngleRestReference, baseline: CustomPose, bones: Map<string, THREE.Bone>;
  beforeAll(async () => {
    setRomClampEnabled(false);
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
    rest = captureJointAngleRestReference(skin.skeleton, cfg); bones = buildBoneByPoseKey(skin.skeleton, cfg);
    baseline = serializeCustomPose(skin.skeleton, cfg, variant);
  });

  it.each(['L', 'R'] as const)('enforces default and patient geometric elbow/knee limits on %s while preserving other bone locals', side => {
    for (const limb of ['elbow', 'knee'] as const) {
      const key = `${side}_${limb === 'elbow' ? 'Forearm' : 'Leg'}`;
      const parent = bones.get(`${side}_${limb === 'elbow' ? 'UpperArm' : 'UpLeg'}`)!, bone = bones.get(key)!;
      const field = limb === 'elbow' ? 'elbowFlexion' : 'kneeFlexion';
      const normative = getEffectiveRomRange(null, key, field)!;
      for (const availableRange of [null, { min: 25, max: 80 }, { min: 40, max: 40 }]) for (const sign of [-1, 1]) {
        const constraints: RomScenarioConstraints | null = availableRange ? { [key]: { [field]: { availableRange } } } : null;
        const effective = getEffectiveRomRange(constraints, key, field)!;
        const target = sign < 0 ? effective.min : effective.max;
        const pose = buildComposedCommandPose(baseline, key, [{ motion: field, degrees: target + sign * 5 }], cfg, baseline, rest)!;
        applyCustomPose(skin.skeleton, cfg, pose);
        root.quaternion.setFromEuler(new THREE.Euler(.8, .3, -.2)); root.updateMatrixWorld(true);
        const before = measureHingeFlexion(parent, bone, key, rest)!;
        expect(sign * (before - target)).toBeGreaterThan(1);
        const original = bone.quaternion.clone();
        if (!constraints) {
          // Merely adding the named contact API must not change the legacy opt-in.
          expect(clampMeasuredPatientHinge(parent, bone, key, rest, null, continuous)).toBe(false);
          expect(bone.quaternion.toArray()).toEqual(original.toArray());
        }
        const otherLocals = skin.skeleton.bones.filter(b => b !== bone).map(b => [...b.position.toArray(), ...b.quaternion.toArray(), ...b.scale.toArray()]);
        clampMeasuredHingeToRom(parent, bone, key, rest, constraints, continuous);
        const measured = measureHingeFlexion(parent, bone, key, rest)!;
        expect(Math.abs(measured - target)).toBeLessThan(1e-5);
        expect(measured).toBeGreaterThanOrEqual(normative.min - 1e-5);
        expect(measured).toBeLessThanOrEqual(normative.max + 1e-5);
        expect(computeJointAngles(skin.skeleton, cfg, variant, rest).joints[key]![field]).toBe(measured);
        expect(skin.skeleton.bones.filter(b => b !== bone).map(b => [...b.position.toArray(), ...b.quaternion.toArray(), ...b.scale.toArray()])).toEqual(otherLocals);
        const first = bone.quaternion.clone();
        clampMeasuredHingeToRom(parent, bone, key, rest, constraints, continuous);
        expect(distanceDeg(first, bone.quaternion)).toBeLessThan(1e-5);
        if (constraints) {
          const expected = bone.quaternion.toArray(); bone.quaternion.copy(original);
          clampMeasuredPatientHinge(parent, bone, key, rest, constraints, continuous);
          clampMeasuredPatientHinge(parent, bone, key, rest, constraints, continuous);
          expect(bone.quaternion.toArray()).toEqual(expected);
        }
      }
    }
  });

  it('leaves an already valid unit elbow unchanged and rejects non-hinge projection', () => {
    applyCustomPose(skin.skeleton, cfg, baseline); root.quaternion.identity(); root.updateMatrixWorld(true);
    const parent = bones.get('R_UpperArm')!, bone = bones.get('R_Forearm')!;
    const pose = buildComposedCommandPose(baseline, 'R_Forearm', [{ motion: 'elbowFlexion', degrees: 50 }], cfg, baseline, rest)!;
    applyCustomPose(skin.skeleton, cfg, pose); bone.quaternion.normalize(); root.updateMatrixWorld(true);
    const before = bone.quaternion.toArray();
    expect(clampMeasuredHingeToRom(parent, bone, 'R_Forearm', rest, null)).toBe(false);
    expect(bone.quaternion.toArray()).toEqual(before);
    const hand = bones.get('R_Hand')!, handBefore = hand.quaternion.toArray();
    expect(clampMeasuredHingeToRom(bone, hand, 'R_Hand', rest, null, continuous)).toBe(false);
    expect(hand.quaternion.toArray()).toEqual(handBefore);
  });

  it.each(['L', 'R'] as const)('projects all contact hinge channels together on %s with continuous, idempotent feasible probes', side => {
    for (const limb of ['elbow', 'knee'] as const) for (const mode of ['default', 'ranged', 'locked']) for (const sign of [-1, 1]) {
      const key = `${side}_${limb === 'elbow' ? 'Forearm' : 'Leg'}`, field = limb === 'elbow' ? 'elbowFlexion' : 'kneeFlexion';
      const parent = bones.get(`${side}_${limb === 'elbow' ? 'UpperArm' : 'UpLeg'}`)!, bone = bones.get(key)!;
      const constraints = mode === 'default' ? null : { [key]: { [field]: { availableRange: mode === 'locked' ? { min: 40, max: 40 } : { min: 25, max: 80 } } } };
      const range = getEffectiveRomRange(constraints, key, field)!;
      const pose = buildComposedCommandPose(baseline, key, [{ motion: field, degrees: sign < 0 ? range.min - 5 : range.max + 5 }], cfg, baseline, rest)!;
      applyCustomPose(skin.skeleton, cfg, pose);
      bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, .5 * sign, .3 * sign)));
      root.quaternion.setFromEuler(new THREE.Euler(.8, .3, -.2)); root.updateMatrixWorld(true);
      const assertBounds = () => {
        const flexion = measureHingeFlexion(parent, bone, key, rest)!, local = inspectClinicalAngles(bone, key, rest, constraints)!;
        for (const [value, limits] of [[flexion, range], [local.raw.abduction, local.ranges.abduction], [local.raw.rotation, local.ranges.rotation!]] as const) {
          if (!limits) throw new Error(`Missing hinge bounds for ${key}`);
          expect(value).toBeGreaterThanOrEqual(limits.min - 1e-9);
          expect(value).toBeLessThanOrEqual(limits.max + 1e-9);
        }
        return flexion;
      };
      clampContactHingeToRom(parent, bone, key, rest, constraints); assertBounds();
      const projected = bone.quaternion.clone();
      clampContactHingeToRom(parent, bone, key, rest, constraints);
      expect(distanceDeg(projected, bone.quaternion)).toBeLessThan(1e-9);
      for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
        const lockedValues: number[] = [];
        for (const direction of [-1, 1]) {
          bone.quaternion.copy(projected).multiply(new THREE.Quaternion().setFromAxisAngle(axis, direction * 1e-6));
          clampContactHingeToRom(parent, bone, key, rest, constraints); lockedValues.push(assertBounds());
          const probe = bone.quaternion.clone();
          expect(distanceDeg(projected, probe)).toBeLessThan(1e-3);
          // The actual feasible directions used to build a projected Jacobian
          // must remain fixed points when projected again.
          clampContactHingeToRom(parent, bone, key, rest, constraints);
          expect(distanceDeg(probe, bone.quaternion)).toBeLessThan(1e-9);
        }
        if (mode === 'locked') expect(Math.abs((lockedValues[1]! - lockedValues[0]!) / 2e-6)).toBeLessThan(1e-6);
        for (const direction of [-1, 1]) {
          bone.quaternion.copy(projected).multiply(new THREE.Quaternion().setFromAxisAngle(axis, direction * 1e-10));
          clampContactHingeToRom(parent, bone, key, rest, constraints); assertBounds();
          expect(distanceDeg(projected, bone.quaternion)).toBeLessThan(1e-7);
        }
      }
    }
  });

  if (variant === 'male') it('corrects the retained 150.809-degree default elbow that local swing alone accepted', () => {
    applyCustomPose(skin.skeleton, cfg, baseline); root.quaternion.identity();
    const bone = bones.get('R_Forearm')!, parent = bones.get('R_UpperArm')!;
    // Actual source frame60 from the retained native-dense-extension-inputs-1
    // male recording. Parent/world placement is irrelevant to hinge flexion.
    bone.quaternion.fromArray([0.9563294711752631, -0.08455275953596525, -0.1414263241425753, 0.24141964126316068]);
    root.updateMatrixWorld(true);
    expect(measureHingeFlexion(parent, bone, 'R_Forearm', rest)!).toBeCloseTo(150.80940617684786, 4);
    expect(inspectClinicalAngles(bone, 'R_Forearm', rest)!.anatomicFlexion).toBeCloseTo(150, 4);
    const saved = bone.quaternion.clone();
    clampBoneToRom(bone, 'R_Forearm', rest, null, true, continuous);
    expect(measureHingeFlexion(parent, bone, 'R_Forearm', rest)!).toBeGreaterThan(150.8);
    clampMeasuredHingeToRom(parent, bone, 'R_Forearm', rest, null, continuous);
    expect(measureHingeFlexion(parent, bone, 'R_Forearm', rest)!).toBeCloseTo(150, 5);
    clampBoneToRom(bone, 'R_Forearm', rest, null, true, continuous);
    const fields = computeJointAngles(skin.skeleton, cfg, variant, rest).joints.R_Forearm!;
    for (const field of ['elbowFlexion', 'elbowDeviation', 'forearmRotation']) {
      const range = getEffectiveRomRange(null, 'R_Forearm', field)!;
      expect(fields[field]).toBeGreaterThanOrEqual(range.min - .05);
      expect(fields[field]).toBeLessThanOrEqual(range.max + .05);
    }
    bone.quaternion.copy(saved); root.updateMatrixWorld(true);
    clampContactHingeToRom(parent, bone, 'R_Forearm', rest);
    const exactFields = computeJointAngles(skin.skeleton, cfg, variant, rest).joints.R_Forearm!;
    expect(Math.abs(exactFields.elbowFlexion! - 150)).toBeLessThan(1e-10);
    expect(exactFields.elbowDeviation!).toBeGreaterThanOrEqual(-5 - 1e-10);
    expect(exactFields.elbowDeviation!).toBeLessThan(-4.99999);
    const once = bone.quaternion.clone();
    clampContactHingeToRom(parent, bone, 'R_Forearm', rest);
    expect(distanceDeg(once, bone.quaternion)).toBeLessThan(1e-10);
  });
});
