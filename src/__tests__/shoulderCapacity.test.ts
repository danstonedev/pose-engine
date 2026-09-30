import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose, buildIKChainContext, solveIKChain } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles, hashJointAngleReport } from '../services/jointAngles';
import { buildComposedCommandPose, finalizeOutcome, measureCommandMotion } from '../services/movementCommand';
import { buildSequencePoses, resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, exportKinematics, bakeFrameEdit } from '../services/motionRecording';
import { enforceShoulderCapacities, inspectClinicalAngles } from '../services/poseRomClamp';
import { projectShoulderProxyLocal, recordedShoulderConstraints, shoulderConstraintsForPolicy, shoulderProxyCapacity } from '../services/shoulderRuntime';
import { assessValidity } from '../services/validityGate';
import type { RomScenarioConstraints } from '../services/romConstraints';

for (const variant of ['male', 'female', 'neutral'] as const) describe(`${variant}: coupled shoulder capacity`, () => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skin: THREE.SkinnedMesh;
  let bones: Map<string, THREE.Bone>, baseline: ReturnType<typeof serializeCustomPose>, rest: ReturnType<typeof captureJointAngleRestReference>;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); root.updateMatrixWorld(true); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skin) skin = o as THREE.SkinnedMesh; });
    bones = buildBoneByPoseKey(skin.skeleton, cfg); baseline = serializeCustomPose(skin.skeleton, cfg, variant);
    rest = captureJointAngleRestReference(skin.skeleton, cfg);
  });
  const reset = () => { root.position.set(0, 0, 0); root.quaternion.identity(); applyCustomPose(skin.skeleton, cfg, baseline); root.updateMatrixWorld(true); };
  for (const side of ['L', 'R'] as const) {
    const key = `${side}_UpperArm`, girdleKey = `${side}_Shoulder`;
    it(`${side}: runtime limits preserve external rotation and apply asymmetric patient bounds in command coordinates`, () => {
      const bone = bones.get(key)!;
      for (const [rotation, expected] of [[-90, -90], [-70, -70], [0, 0], [70, 70], [-110, -90], [90, 70]]) {
        reset();
        const pose = buildComposedCommandPose(baseline, key, [{ motion: 'shoulderRotation', degrees: rotation }], cfg, baseline, rest)!;
        applyCustomPose(skin.skeleton, cfg, pose); root.updateMatrixWorld(true);
        enforceShoulderCapacities(bones, rest, shoulderConstraintsForPolicy('enforce-proxy'));
        root.updateMatrixWorld(true);
        expect(inspectClinicalAngles(bone, key, rest)!.anatomicRotation).toBeCloseTo(expected, 3);
        expect(computeJointAngles(skin.skeleton, cfg, variant, rest).joints[key].shoulderRotation).toBeCloseTo(expected, 2);
      }
      const constraints = { [key]: { shoulderRotation: { availableRange: { min: -30, max: 10 } } } };
      for (const [rotation, expected] of [[-60, -30], [40, 10]]) {
        reset();
        const pose = buildComposedCommandPose(baseline, key, [{ motion: 'shoulderRotation', degrees: rotation }], cfg, baseline, rest)!;
        applyCustomPose(skin.skeleton, cfg, pose); root.updateMatrixWorld(true);
        enforceShoulderCapacities(bones, rest, shoulderConstraintsForPolicy('enforce-proxy', constraints));
        root.updateMatrixWorld(true);
        expect(inspectClinicalAngles(bone, key, rest, constraints)!.anatomicRotation).toBeCloseTo(expected, 3);
        expect(computeJointAngles(skin.skeleton, cfg, variant, rest).joints[key].shoulderRotation).toBeCloseTo(expected, 2);
      }
      for (const [flexion, abduction] of [[90, 0], [174, 155]]) {
        reset();
        const pose = buildComposedCommandPose(baseline, key, [
          { motion: 'shoulderFlexion', degrees: flexion }, { motion: 'shoulderAbduction', degrees: abduction },
          { motion: 'shoulderRotation', degrees: -90 },
        ], cfg, baseline, rest)!;
        applyCustomPose(skin.skeleton, cfg, pose); root.updateMatrixWorld(true);
        const before = bone.quaternion.clone();
        enforceShoulderCapacities(bones, rest, shoulderConstraintsForPolicy('enforce-proxy'));
        expect(bone.quaternion.angleTo(before)).toBeLessThan(.003);
        expect(inspectClinicalAngles(bone, key, rest)!.anatomicRotation).toBeLessThan(-89);
        expect(computeJointAngles(skin.skeleton, cfg, variant, rest).joints[key].shoulderRotation).toBeCloseTo(-90, 0);
      }
    });
    for (const rotation of [-60, 0, 60]) it(`${side}: explicit zero girdle stays fixed while swing is bounded and twist preserved (${rotation})`, () => {
      reset();
      const ts = [{ motion: 'shoulderFlexion', degrees: 180 }, { motion: 'shoulderRotation', degrees: rotation }];
      const girdle = [{ motion: 'scapularTilt', degrees: 0 }, { motion: 'upRotation', degrees: 0 }, { motion: 'protraction', degrees: 0 }];
      const legacy = buildComposedCommandPose(baseline, key, ts, cfg, baseline, rest, girdle)!;
      applyCustomPose(skin.skeleton, cfg, legacy); root.updateMatrixWorld(true);
      const before = computeJointAngles(skin.skeleton, cfg, variant, rest).shoulders![side];
      expect(before.capacity.withinBudget).toBe(false);
      const constraints = { [key]: { girdleProxyElevation: { availableRange: { max: 100 } } } };
      const bounded = buildComposedCommandPose(baseline, key, ts, cfg, baseline, rest, girdle, constraints)!;
      expect(bounded.bones[girdleKey]).toEqual(legacy.bones[girdleKey]);
      applyCustomPose(skin.skeleton, cfg, bounded); root.updateMatrixWorld(true);
      const after = computeJointAngles(skin.skeleton, cfg, variant, rest, constraints).shoulders![side];
      expect(after.girdleProxy.elevationDeg).toBeCloseTo(100, 5);
      expect(after.girdleProxy.restAxisTwistDeg).toBeCloseTo(before.girdleProxy.restAxisTwistDeg!, 5);
      expect(after.capacity.withinBudget).toBe(true);
      const again = projectShoulderProxyLocal(new THREE.Quaternion().fromArray(bounded.bones[key]!), key, rest, 100)!;
      expect(again.angleTo(new THREE.Quaternion().fromArray(bounded.bones[key]!))).toBeLessThan(1e-7);
    });
    it(`${side}: continuous sampling, export and remeasurement retain realized capacity`, () => {
      reset();
      const motion: ComposedMotion = { shoulderCapacity: 'enforce-proxy', startFrom: 'neutral', stance: 'floating', keyframes: [
        { durationMs: 900, targets: [{ joint: key, motion: 'shoulderFlexion', targetDegrees: 180 }, { joint: girdleKey, motion: 'scapularTilt', targetDegrees: 0 }] },
        { durationMs: 900, targets: [{ joint: key, motion: 'shoulderFlexion', targetDegrees: 90 }, { joint: key, motion: 'shoulderAbduction', targetDegrees: 60 }] },
      ] };
      const resolved = resolveComposedMotion(motion, cfg);
      const rec = sampleComposedMotion(resolved, { baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned: skin }, sampleHz: 60 });
      expect(rec.frames.length).toBeGreaterThan(60);
      for (const f of rec.frames) {
        expect(f.shoulders![side].capacity.withinBudget, String(f.tMs)).toBe(true);
        applyCustomPose(skin.skeleton, cfg, f.pose); root.updateMatrixWorld(true);
        expect(computeJointAngles(skin.skeleton, cfg, variant, rest).shoulders![side].girdleProxy.elevationDeg)
          .toBeCloseTo(f.shoulders![side].girdleProxy.elevationDeg!, 5);
      }
      expect(exportKinematics(rec).shoulders).toEqual(rec.frames.map(f => f.shoulders));
      expect(assessValidity(resolved, rec.frames).checks.find(c => c.id === `shoulder-capacity-${side}`)?.pass).toBe(true);
      expect(assessValidity(resolved, rec.frames.map(f => ({ ...f, shoulders: undefined }))).checks.find(c => c.id === `shoulder-capacity-${side}`)?.pass).toBe(false);
      expect(recordedShoulderConstraints(rec.frames.at(-1)!.shoulders)?.[key]?.girdleProxyElevation?.availableRange?.max).toBe(120);
      expect(bakeFrameEdit(rec, 0, baseline).frames[0]!.shoulders).toBeUndefined();
    });
    it(`${side}: patient bounds and capacity remain explicit after hand IK`, () => {
      reset();
      const constraints: RomScenarioConstraints = { [key]: { girdleProxyElevation: { availableRange: { max: 80 } }, shoulderFlexion: { availableRange: { max: 90 } } } };
      const hand = bones.get(`${side}_Hand`)!;
      solveIKChain(buildIKChainContext(skin, hand, 3, cfg)!, new THREE.Vector3(side === 'L' ? .3 : -.3, 2.5, .4), { rest, constraints, forceRomClamp: true, iterations: 20 });
      enforceShoulderCapacities(bones, rest, constraints); root.updateMatrixWorld(true);
      expect(computeJointAngles(skin.skeleton, cfg, variant, rest, constraints).shoulders![side].capacity.withinBudget).toBe(true);
      const clinical = inspectClinicalAngles(bones.get(key)!, key, rest, constraints)!;
      expect(clinical.anatomicFlexion).toBeLessThanOrEqual(90 + .01);
    });
  }
  it('capacity changes invalidate readout identity without changing any joint', () => {
    reset();
    const a = computeJointAngles(skin.skeleton, cfg, variant, rest);
    const constraints = { R_UpperArm: { girdleProxyElevation: { availableRange: { max: 90 } } } };
    const b = computeJointAngles(skin.skeleton, cfg, variant, rest, constraints);
    expect(a.joints).toEqual(b.joints); expect(hashJointAngleReport(a)).not.toBe(hashJointAngleReport(b));
    constraints.R_UpperArm.girdleProxyElevation.availableRange.max = 70;
    expect(computeJointAngles(skin.skeleton, cfg, variant, rest, constraints).shoulders!.R.capacity.budgetDeg).toBe(70);
    expect(projectShoulderProxyLocal(new THREE.Quaternion(NaN, 0, 0, 1), 'R_UpperArm', rest, 100)).toBeNull();
  });
});

it('strict policy fills a missing engineering maximum without overwriting patient restrictions', () => {
  const input = { R_UpperArm: { shoulderFlexion: { availableRange: { max: 75 } }, girdleProxyElevation: { note: 'engineering proxy' } } };
  const out = shoulderConstraintsForPolicy('enforce-proxy', input)!;
  expect(out.R_UpperArm.shoulderFlexion.availableRange!.max).toBe(75);
  expect(shoulderProxyCapacity(out, 'R')).toEqual({ enforced: true, budgetDeg: 120 });
  expect(input.R_UpperArm.girdleProxyElevation).toEqual({ note: 'engineering proxy' });
});

it('legacy projected values stay compatible while realized outcomes can reject an ambiguous projection', () => {
  const report = { at: '', variant: '', joints: { R_UpperArm: { shoulderFlexion: 120, shoulderAbduction: 180 } } };
  expect(measureCommandMotion(report, 'R_UpperArm', 'shoulderAbduction')).toBeDefined();
  expect(measureCommandMotion(report, 'R_UpperArm', 'shoulderAbduction', true)).toBeUndefined();
});

it('measured shoulder shortfall cannot be reported as complied', () => {
  expect(finalizeOutcome({ status: 'complied', joint: 'R_UpperArm', motion: 'shoulderFlexion', requestedDegrees: 180, clampedDegrees: 180 }, 147).status).toBe('modified');
  expect(shoulderProxyCapacity({ R_UpperArm: { girdleProxyElevation: { availableRange: { max: NaN } } } }, 'R'))
    .toEqual({ enforced: true, budgetDeg: 0 });
});
