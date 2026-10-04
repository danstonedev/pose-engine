import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { bakeFrameEdit, sampleComposedMotion } from '../services/motionRecording';

describe.each(['male', 'female', 'neutral'] as const)('%s prone support recording contract', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skinned: THREE.SkinnedMesh;
  let baselinePose: ReturnType<typeof serializeCustomPose>, rest: ReturnType<typeof captureJointAngleRestReference>;
  const initialPosition = new THREE.Vector3(), initialQuaternion = new THREE.Quaternion();
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    root.traverse(object => { if (!skinned && (object as THREE.SkinnedMesh).isSkinnedMesh) skinned = object as THREE.SkinnedMesh; });
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant);
    rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    initialPosition.copy(root.position); initialQuaternion.copy(root.quaternion);
  });
  beforeEach(() => {
    root.position.copy(initialPosition); root.quaternion.copy(initialQuaternion);
    applyCustomPose(skinned.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
  });
  function sample(overrideContacts: boolean) {
    const source = BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R');
    // Exercise support-owned serialization without palm IK. The production
    // recipe now enables palm fitting, which requires bilateral palm contacts;
    // turn that separate feature off in this intentionally contact-free fixture.
    const motion = { ...source, proneSkinSupport: true, pronePalmAnchorFit: false, ...(overrideContacts ? {} : { contacts: [] }) };
    const resolved = resolveComposedMotion(motion, cfg);
    expect(resolved.status).toBe('ok');
    return sampleComposedMotion(resolved, {
      baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned },
      frameTimesMs: [0, 1000, 2500], trackedBones: ['Spine_Upper', 'L_Leg', 'R_Leg', 'L_Toes', 'R_Toes'],
      ...(overrideContacts ? { contacts: [] } : {}),
    });
  }

  it.each([false, true])('records corrected joint poses without palm IK (contact override: %s)', overrideContacts => {
    const recording = sample(overrideContacts);
    const final = recording.frames.at(-1)!;
    // The sampler restores the model root, but leaves the final realized bones.
    // Support owns joints even when no contact IK caused serialization.
    expect(final.pose.bones).toEqual(serializeCustomPose(skinned.skeleton, cfg, variant).bones);
    expect(Math.abs(final.proneSupport!.correctedDegrees.L_kneeFlexion)).toBeGreaterThan(.1);
    const bones = buildBoneByPoseKey(skinned.skeleton, cfg);
    for (const frame of recording.frames) {
      expect(frame.proneSupport).toBeDefined();
      root.position.copy(initialPosition).add(new THREE.Vector3().fromArray(frame.root.translateM));
      root.quaternion.copy(initialQuaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
      applyCustomPose(skinned.skeleton, cfg, frame.pose); root.updateMatrixWorld(true);
      for (const key of ['Spine_Upper', 'L_Leg', 'R_Leg', 'L_Toes', 'R_Toes']) {
        const expected = frame.worldTracks![key]!;
        const actual = bones.get(key)!.getWorldPosition(new THREE.Vector3());
        expect(actual.distanceTo(new THREE.Vector3().fromArray(expected)), `${key} replay at ${frame.tMs}`).toBeLessThan(1e-7);
      }
    }
  });

  it('invalidates support and planning diagnostics when an edited pose changes their geometry', () => {
    const recording = sample(false);
    // An opaque planning result is sufficient here: the edit operation must
    // invalidate prior derived evidence without interpreting its acceptance.
    for (const frame of recording.frames) frame.pronePalmLayout = {
      contacts: [], forward: .3, endpointReached: true, bodySupportFeasible: true,
      maximumPalmDriftM: 0, selectedIteration: 0, iterations: [], bodySupportFailures: [], reasons: [], scope: 'fixture',
    };
    const editedPose = structuredClone(recording.frames[1]!.pose);
    editedPose.bones.L_Leg = new THREE.Quaternion().fromArray(editedPose.bones.L_Leg!)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .2)).toArray();
    const result = bakeFrameEdit(recording, 1000, editedPose, { blendMs: 1600 });
    for (const frame of result.frames) {
      expect(frame.proneSupport, `support diagnostics at ${frame.tMs}`).toBeUndefined();
      expect(frame.pronePalmLayout, `planning diagnostics at ${frame.tMs}`).toBeUndefined();
    }
    expect(recording.frames.every(frame => frame.proneSupport && frame.pronePalmLayout)).toBe(true);
  });
});
