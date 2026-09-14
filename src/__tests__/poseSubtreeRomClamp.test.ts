import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { clampBoneToRom, inspectClinicalAngles } from '../services/poseRomClamp';
import { clampPoseSubtreeToRom } from '../services/poseSubtreeRomClamp';

// Minimal reproduction from the female right-hand/lower-back demonstration.
// Parent-only clamping can reproduce this violation after a girdle edit;
// the capture itself does not record the user's complete editing history.
const CAPTURED_ARM: Record<string, [number, number, number, number]> = {
  R_Shoulder: [-0.056765594918105226, -0.13787077924934107, 0.8040964269111289, 0.5754982639126633],
  R_UpperArm: [-0.346351350692292, 0.7038608721359327, -0.3911026917649286, -0.48130998985665074],
  R_Forearm: [0.8730420735826155, -0.18245105265797334, -0.15726095247681451, 0.4240024987669811],
  R_Hand: [-0.012787216400130304, 0.0058487589800863445, 0.090033958988094, 0.9958394274902252],
};

describe('explicit pose subtree ROM enforcement on the female rig', () => {
  const cfg = BODY_VARIANTS.female;
  let root: THREE.Object3D;
  let skin: THREE.SkinnedMesh;
  let bones: Map<string, THREE.Bone>;
  let rest: ReturnType<typeof captureJointAngleRestReference>;
  let baseline: ReturnType<typeof serializeCustomPose>;

  beforeAll(async () => {
    const bytes = readFileSync(new URL('../../models/painmap3D_female.runtime.glb', import.meta.url));
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '',
    );
    root = gltf.scene;
    root.scale.setScalar(cfg.pose.rootScale);
    root.traverse(object => {
      if (!skin && (object as THREE.SkinnedMesh).isSkinnedMesh) skin = object as THREE.SkinnedMesh;
    });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, cfg);
    root.updateMatrixWorld(true);
    rest = captureJointAngleRestReference(skin.skeleton, cfg);
    bones = buildBoneByPoseKey(skin.skeleton, cfg);
    baseline = serializeCustomPose(skin.skeleton, cfg, 'female');
  });

  beforeEach(() => {
    applyCustomPose(skin.skeleton, cfg, baseline);
    for (const [key, quaternion] of Object.entries(CAPTURED_ARM)) bones.get(key)!.quaternion.fromArray(quaternion);
    root.updateMatrixWorld(true);
  });

  function report(key: string) {
    return inspectClinicalAngles(bones.get(key)!, key, rest)!;
  }

  function expectArmWithinLimits() {
    for (const key of ['R_Shoulder', 'R_UpperArm', 'R_Forearm']) {
      const value = report(key);
      for (const axis of ['flexion', 'abduction', 'rotation'] as const) {
        const angle = axis === 'flexion' ? value.anatomicFlexion : value.raw[axis];
        const range = value.ranges[axis];
        if (!range) continue;
        expect(angle, `${key}.${axis}`).toBeGreaterThanOrEqual(range.min - 0.001);
        expect(angle, `${key}.${axis}`).toBeLessThanOrEqual(range.max + 0.001);
      }
    }
  }

  it('preserves the captured orientation until limits are explicitly applied', () => {
    expect(report('R_UpperArm').raw.rotation).toBeCloseTo(-103.36, 1);
    for (const [key, quaternion] of Object.entries(CAPTURED_ARM)) {
      expect(bones.get(key)!.quaternion.toArray()).toEqual(quaternion);
    }
    const adjusted = clampPoseSubtreeToRom(bones.get('R_Shoulder')!, bones, rest);
    expect(adjusted).toContain('R_UpperArm');
    expectArmWithinLimits();
  });

  it('enforces the child bound after a parent edit, where a selected-only clamp fails', () => {
    const shoulder = bones.get('R_Shoulder')!;
    clampPoseSubtreeToRom(shoulder, bones, rest);
    expectArmWithinLimits();
    shoulder.rotateX(2 * Math.PI / 180);
    // The editor's former call bounds the parent but leaves its child's
    // world-frame rotation outside its range after this 2-degree nudge.
    clampBoneToRom(shoulder, 'R_Shoulder', rest);
    expect(report('R_UpperArm').raw.rotation).toBeLessThan(-91);
    const editedParent = shoulder.quaternion.toArray();
    const adjusted = clampPoseSubtreeToRom(shoulder, bones, rest);
    expect(adjusted).toContain('R_UpperArm');
    expect(shoulder.quaternion.toArray()).toEqual(editedParent);
    expectArmWithinLimits();
  });

  it('does not change unrelated joints or a parent outside the edited subtree', () => {
    const before = new Map([...bones].map(([key, bone]) => [key, bone.quaternion.toArray()]));
    const selected = bones.get('R_Shoulder')!;
    const descendants = new Set<THREE.Object3D>();
    selected.traverse(object => descendants.add(object));
    clampPoseSubtreeToRom(selected, bones, rest);
    for (const [key, bone] of bones) {
      if (!descendants.has(bone)) expect(bone.quaternion.toArray(), key).toEqual(before.get(key));
    }
    expectArmWithinLimits();
  });

  it('clamps ancestors before descendants regardless of bone-map order', () => {
    const shoulder = bones.get('R_Shoulder')!;
    shoulder.rotateX(Math.PI / 2);
    const reversed = new Map([...bones].reverse());
    const adjusted = clampPoseSubtreeToRom(shoulder, reversed, rest);
    expect(adjusted[0]).toBe('R_Shoulder');
    expect(adjusted).toContain('R_UpperArm');
    expectArmWithinLimits();
  });

  it('honors a patient elbow restriction on the affected descendant', () => {
    const constraints = { R_Forearm: { elbowFlexion: { availableRange: { max: 40 } } } };
    const adjusted = clampPoseSubtreeToRom(bones.get('R_Shoulder')!, bones, rest, constraints);
    expect(adjusted).toContain('R_Forearm');
    expect(report('R_Forearm').anatomicFlexion).toBeLessThanOrEqual(40.001);
    expectArmWithinLimits();
  });
});
