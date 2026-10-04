import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from '../services/rootMotion';
import { clampBoneToRom, inspectClinicalAngles } from '../services/poseRomClamp';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';

describe.each(['male', 'female', 'neutral'] as const)('%s clinical reference consistency', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skin: THREE.SkinnedMesh, bones: Map<string, THREE.Bone>;
  let rest: ReturnType<typeof captureJointAngleRestReference>, baseline: ReturnType<typeof serializeCustomPose>;
  const initialPosition = new THREE.Vector3(), initialQuaternion = new THREE.Quaternion();
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(object => { if (!skin && (object as THREE.SkinnedMesh).isSkinnedMesh) skin = object as THREE.SkinnedMesh; });
    bones = buildBoneByPoseKey(skin.skeleton, cfg); rest = captureJointAngleRestReference(skin.skeleton, cfg);
    baseline = serializeCustomPose(skin.skeleton, cfg, variant);
    initialPosition.copy(root.position); initialQuaternion.copy(root.quaternion);
  });
  beforeEach(() => {
    root.position.copy(initialPosition); root.quaternion.copy(initialQuaternion);
    applyCustomPose(skin.skeleton, cfg, baseline); root.updateMatrixWorld(true);
  });
  const measure = (reference = rest) => computeJointAngles(skin.skeleton, cfg, variant, reference).joints;
  function turnBody() {
    const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, .6, -.15, 'YXZ'));
    root.quaternion.copy(orientation).multiply(initialQuaternion);
    bones.get('Hips')!.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .2));
    root.updateMatrixWorld(true);
    return rotateRestReferenceByPelvis(rotateRestReferenceByRoot(rest, orientation), skin.skeleton, cfg);
  }
  it('preserves neutral and posed finger curl through root and pelvis reference rotations', () => {
    for (const side of ['L', 'R']) for (const joint of ['Index1', 'Index2'])
      bones.get(`${side}_${joint}`)!.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), .25));
    root.updateMatrixWorld(true);
    const before = measure(), adjusted = turnBody(), after = measure(adjusted);
    expect(Math.abs(before.L_Index1!.fingerFlexion!)).toBeGreaterThan(20);
    expect(adjusted.fingerCurlRest).toBe(rest.fingerCurlRest);
    expect(adjusted.gaitLegFrames).toBe(rest.gaitLegFrames);
    for (const side of ['L', 'R']) for (const digit of ['Thumb', 'Index', 'Mid', 'Ring', 'Pinky'])
      expect(after[`${side}_${digit}1`]!.fingerFlexion, `${side} ${digit}`).toBeCloseTo(before[`${side}_${digit}1`]!.fingerFlexion!, 4);
  });
  it.each(['L', 'R'] as const)('%s elbow clamps both deviation directions in clinical units after body rotation', side => {
    const reference = turnBody(), key = `${side}_Forearm`, bone = bones.get(key)!;
    for (const rawDegrees of [-40, 40]) {
      bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rawDegrees * Math.PI / 180)
        .multiply(new THREE.Quaternion().fromArray(rest.localQuats[key]!));
      root.updateMatrixWorld(true);
      const before = measure(reference)[key]!.elbowDeviation!;
      expect(Math.abs(before)).toBeGreaterThan(30);
      clampBoneToRom(bone, key, reference, undefined, true, { clinicalHingeDeviation: true }); root.updateMatrixWorld(true);
      const after = measure(reference)[key]!.elbowDeviation!;
      expect(after).toBeCloseTo(before < 0 ? -5 : 10, 4);
      expect(inspectClinicalAngles(bone, key, reference)!.raw.abduction).toBeCloseTo(after, 4);
      const once = bone.quaternion.toArray();
      expect(clampBoneToRom(bone, key, reference, undefined, true, { clinicalHingeDeviation: true })).toBe(false);
      expect(bone.quaternion.toArray()).toEqual(once);
    }
  });
  it.each(['L', 'R'] as const)('%s generic manipulation retains its declared legacy engineering play', side => {
    const key = `${side}_Forearm`, bone = bones.get(key)!;
    for (const degrees of [-40, 40]) {
      bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), degrees * Math.PI / 180)
        .multiply(new THREE.Quaternion().fromArray(rest.localQuats[key]!));
      root.updateMatrixWorld(true);
      const before = measure()[key]!.elbowDeviation!;
      clampBoneToRom(bone, key, rest, undefined, true); root.updateMatrixWorld(true);
      const after = measure()[key]!.elbowDeviation!;
      expect(after).toBeCloseTo(before < 0 ? -10 : 10, 4);
      const report = inspectClinicalAngles(bone, key, rest)!;
      expect(report.hingeDeviationPolicy).toBe('legacy-engineering');
      expect(report.raw.abduction).toBeCloseTo(after, 4);
      expect(report.ranges.abduction).toEqual({ min: -10, max: 10 });
      const clinical = inspectClinicalAngles(bone, key, rest, undefined, { clinicalHingeDeviation: true })!;
      expect(clinical.hingeDeviationPolicy).toBe('clinical');
      expect(clinical.ranges.abduction).toEqual({ min: -5, max: 10 });
    }
  });
  it.each(['L', 'R'] as const)('%s elbow honors asymmetric patient deviation bounds', side => {
    const reference = turnBody(), key = `${side}_Forearm`, bone = bones.get(key)!;
    const constraints = { [key]: { elbowDeviation: { availableRange: { min: -2, max: 3 } } } };
    for (const rawDegrees of [-40, 40]) {
      bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rawDegrees * Math.PI / 180)
        .multiply(new THREE.Quaternion().fromArray(rest.localQuats[key]!));
      root.updateMatrixWorld(true);
      const before = measure(reference)[key]!.elbowDeviation!;
      clampBoneToRom(bone, key, reference, constraints, true); root.updateMatrixWorld(true);
      expect(measure(reference)[key]!.elbowDeviation).toBeCloseTo(before < 0 ? -2 : 3, 4);
    }
  });
  it('reports engineering play residual when patient minimum is outside play but inside normative ROM', () => {
    const key = 'R_Forearm', bone = bones.get(key)!;
    const constraints = { [key]: { elbowDeviation: { availableRange: { min: 12, max: 13 } } } };
    clampBoneToRom(bone, key, rest, constraints, true); root.updateMatrixWorld(true);
    expect(measure()[key]!.elbowDeviation).toBeCloseTo(12, 4);
    expect(inspectClinicalAngles(bone, key, rest, constraints)!.engineeringResidual?.abductionDeg).toBeCloseTo(2, 4);
  });
  it('keeps source press-up elbow deviation within the registry across the sampled motion', () => {
    const motion = BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R');
    const frames = sampleComposedMotion(resolveComposedMotion(motion, cfg), { baselinePose: baseline, variantCfg: cfg, rest,
      skeletonHarness: { root, skinned: skin }, sampleHz: 10 }).frames;
    for (const frame of frames) for (const side of ['L', 'R']) {
      const value = frame.angles[`${side}_Forearm`]!.elbowDeviation!;
      expect(value, `${side} at ${frame.tMs}`).toBeGreaterThanOrEqual(-5.01);
      expect(value, `${side} at ${frame.tMs}`).toBeLessThanOrEqual(15.01);
    }
  });
});
