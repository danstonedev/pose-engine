import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { clampBoneToRom, hasClampStrategy, inspectClinicalAngles } from '../services/poseRomClamp';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

/** Mirror of the skeleton builder in jointAngles.test.ts — kept duplicated
 *  so the test files stay independent. Names match CC4 export tokens so
 *  the variant's bone-name map normalizes them onto canonical pose keys. */
function buildSyntheticCCSkeleton(): {
  skeleton: THREE.Skeleton;
  bones: Record<string, THREE.Bone>;
} {
  const make = (name: string, parent: THREE.Bone | null, offset: [number, number, number]) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...offset);
    if (parent) parent.add(b);
    return b;
  };

  const hips = make('CC_Base_Hip', null, [0, 0, 0]);
  const spine = make('CC_Base_Waist', hips, [0, 0.2, 0]);
  const spine1 = make('CC_Base_Spine01', spine, [0, 0.3, 0]);
  const spine2 = make('CC_Base_Spine02', spine1, [0, 0.3, 0]);
  const neck = make('CC_Base_NeckTwist01', spine2, [0, 0.2, 0]);
  const head = make('CC_Base_Head', neck, [0, 0.2, 0]);

  const lShoulder = make('CC_Base_L_Clavicle', spine2, [0.15, 0.1, 0]);
  const lUpperArm = make('CC_Base_L_Upperarm', lShoulder, [0.15, 0, 0]);
  const lForearm = make('CC_Base_L_Forearm', lUpperArm, [0, -1, 0]);
  const lHand = make('CC_Base_L_Hand', lForearm, [0, -1, 0]);
  make('CC_Base_L_Index1', lHand, [0, -0.3, 0]);

  const rShoulder = make('CC_Base_R_Clavicle', spine2, [-0.15, 0.1, 0]);
  const rUpperArm = make('CC_Base_R_Upperarm', rShoulder, [-0.15, 0, 0]);
  const rForearm = make('CC_Base_R_Forearm', rUpperArm, [0, -1, 0]);
  const rHand = make('CC_Base_R_Hand', rForearm, [0, -1, 0]);
  make('CC_Base_R_Index1', rHand, [0, -0.3, 0]);

  const lUpLeg = make('CC_Base_L_Thigh', hips, [0.1, -0.1, 0]);
  const lLeg = make('CC_Base_L_Calf', lUpLeg, [0, -1, 0]);
  const lFoot = make('CC_Base_L_Foot', lLeg, [0, -1, 0]);
  make('CC_Base_L_ToeBase', lFoot, [0, 0, -0.2]);

  const rUpLeg = make('CC_Base_R_Thigh', hips, [-0.1, -0.1, 0]);
  const rLeg = make('CC_Base_R_Calf', rUpLeg, [0, -1, 0]);
  const rFoot = make('CC_Base_R_Foot', rLeg, [0, -1, 0]);
  make('CC_Base_R_ToeBase', rFoot, [0, 0, -0.2]);

  const collected: THREE.Bone[] = [];
  const walk = (node: THREE.Object3D) => {
    if ((node as THREE.Bone).isBone) collected.push(node as THREE.Bone);
    for (const child of node.children) walk(child);
  };
  walk(hips);
  hips.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(collected);

  const bones: Record<string, THREE.Bone> = {
    Hips: hips,
    Spine_Mid: spine1,
    Head: head,
    L_UpperArm: lUpperArm,
    L_Forearm: lForearm,
    L_Hand: lHand,
    R_UpperArm: rUpperArm,
    R_Forearm: rForearm,
    R_Hand: rHand,
    L_UpLeg: lUpLeg,
    L_Leg: lLeg,
    L_Foot: lFoot,
    R_UpLeg: rUpLeg,
    R_Leg: rLeg,
    R_Foot: rFoot,
  };
  return { skeleton, bones };
}

const variant = BODY_VARIANTS.male;

function setup(): {
  skeleton: THREE.Skeleton;
  bones: Record<string, THREE.Bone>;
  rest: JointAngleRestReference;
} {
  const { skeleton, bones } = buildSyntheticCCSkeleton();
  const rest = captureJointAngleRestReference(skeleton, variant);
  return { skeleton, bones, rest };
}

function reportFor(skeleton: THREE.Skeleton, rest: JointAngleRestReference) {
  return computeJointAngles(skeleton, variant, 'male', rest);
}

describe('clampBoneToRom', () => {
  describe('strategy table', () => {
    it('recognises every joint with a ROM definition', () => {
      for (const key of [
        'Hips',
        'Spine_Mid',
        'Head',
        'L_UpperArm',
        'R_UpperArm',
        'L_Forearm',
        'R_Forearm',
        'L_Hand',
        'R_Hand',
        'L_UpLeg',
        'R_UpLeg',
        'L_Leg',
        'R_Leg',
        'L_Foot',
        'R_Foot',
      ]) {
        expect(hasClampStrategy(key)).toBe(true);
      }
    });
    it('returns false for null / unknown keys', () => {
      expect(hasClampStrategy(null)).toBe(false);
      expect(hasClampStrategy(undefined)).toBe(false);
      expect(hasClampStrategy('NotAJoint')).toBe(false);
    });
  });

  describe('in-range round-trip', () => {
    it('leaves a 60° shoulder flexion (within ROM) untouched', () => {
      const { skeleton, bones, rest } = setup();
      // 60° about local +X = forward shoulder flexion (well within ±180°).
      bones.L_UpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 3);
      bones.Hips.updateMatrixWorld(true);

      const before = bones.L_UpperArm.quaternion.clone();
      const changed = clampBoneToRom(bones.L_UpperArm, 'L_UpperArm', rest);
      expect(changed).toBe(false);
      expect(bones.L_UpperArm.quaternion.equals(before)).toBe(true);

      const report = reportFor(skeleton, rest);
      expect(report.joints.L_UpperArm.shoulderFlexion).toBeCloseTo(60, 0);
    });

    it('leaves a 90° elbow flexion (within ROM) almost untouched', () => {
      const { skeleton, bones, rest } = setup();
      bones.L_Forearm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);

      clampBoneToRom(bones.L_Forearm, 'L_Forearm', rest);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(90, 0);
    });
  });

  describe('out-of-range clamping', () => {
    it('clamps shoulder hyperextension (-90°) → -60° (max extension limit)', () => {
      const { skeleton, bones, rest } = setup();
      // -90° about +X = arm swings posteriorly behind the body. ROM allows
      // 60° of extension; the decomposition reads -90° flexion.
      bones.L_UpperArm.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        -Math.PI / 2,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_UpperArm, 'L_UpperArm', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_UpperArm.shoulderFlexion).toBeCloseTo(-60, 0);
    });

    it('clamps elbow flexion 160° → 150°', () => {
      const { skeleton, bones, rest } = setup();
      bones.L_Forearm.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (160 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Forearm, 'L_Forearm', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(150, 0);
    });

    it('clamps elbow hyperextension (-30°) → 0°', () => {
      const { skeleton, bones, rest } = setup();
      // Negative rotation about the hinge axis = hyperextension.
      bones.L_Forearm.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (-30 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Forearm, 'L_Forearm', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(0, 0);
    });

    it('clamps knee anatomic flex (lower leg posterior) 160° → 140°', () => {
      const { skeleton, bones, rest } = setup();
      // Anatomic knee flex = heel-toward-butt = lower leg swings POSTERIORLY.
      // Rotation about +X by -160° takes (0,-1,0) to (0, 0.94, 0.34) — past
      // horizontal, toward posterior. That's 160° of anatomic knee flexion;
      // ROM is 140° so it should clamp.
      bones.L_Leg.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (-160 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Leg, 'L_Leg', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Leg.kneeFlexion).toBeCloseTo(140, 0);
    });
  });

  describe('orientation: knees flex posteriorly, hips flex anteriorly', () => {
    it('allows anatomic knee flex up to 100° (lower leg posterior, in range)', () => {
      const { skeleton, bones, rest } = setup();
      bones.L_Leg.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (-100 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const before = bones.L_Leg.quaternion.clone();
      const changed = clampBoneToRom(bones.L_Leg, 'L_Leg', rest);
      expect(changed).toBe(false);
      expect(bones.L_Leg.quaternion.equals(before)).toBe(true);

      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Leg.kneeFlexion).toBeCloseTo(100, 0);
    });

    it('rejects anti-anatomic "knee flex" (lower leg anterior) — snaps to 0°', () => {
      const { skeleton, bones, rest } = setup();
      // Rotation about +X by +90° swings the lower leg ANTERIORLY — knees
      // can't bend forward, so this should clamp back to extension (0°).
      bones.L_Leg.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Leg, 'L_Leg', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Leg.kneeFlexion).toBeCloseTo(0, 0);
    });

    it('allows anatomic hip flex 90° (thigh anterior, in range up to 120°)', () => {
      const { bones, rest } = setup();
      // Canonical-frame decomposition: synthetic rest_world is identity,
      // so a +X rotation maps to anatomic forward swing → +flex.
      bones.L_UpLeg.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);

      const before = bones.L_UpLeg.quaternion.clone();
      const changed = clampBoneToRom(bones.L_UpLeg, 'L_UpLeg', rest);
      expect(changed).toBe(false);
      expect(bones.L_UpLeg.quaternion.equals(before)).toBe(true);

      const r = inspectClinicalAngles(bones.L_UpLeg, 'L_UpLeg', rest);
      expect(r?.anatomicFlexion).toBeCloseTo(90, 0);
    });

    it('clamps hip extension -45° → -20° (thigh posterior, max ext is 20°)', () => {
      const { bones, rest } = setup();
      // Anatomic hip extension = posterior thigh swing = -X rotation in
      // synthetic (rest_world=identity).
      bones.L_UpLeg.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (-45 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_UpLeg, 'L_UpLeg', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const r = inspectClinicalAngles(bones.L_UpLeg, 'L_UpLeg', rest);
      expect(r?.anatomicFlexion).toBeCloseTo(-20, 0);
    });

    it('clamps hip flex 130° → 120° (thigh anterior, max flex is 120°)', () => {
      const { bones, rest } = setup();
      bones.L_UpLeg.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (130 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_UpLeg, 'L_UpLeg', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const r = inspectClinicalAngles(bones.L_UpLeg, 'L_UpLeg', rest);
      expect(r?.anatomicFlexion).toBeCloseTo(120, 0);
    });
  });

  describe('hinge off-axis tolerance', () => {
    it('clamps excessive elbow off-axis swing (40° → 10°)', () => {
      const { skeleton, bones, rest } = setup();
      // Rotation about local Z = abduction-style swing for a hinge bone.
      // Elbow allows ±10° of carrying-angle wobble; 40° should clamp to 10°.
      bones.L_Forearm.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        (40 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Forearm, 'L_Forearm', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      // Hinge angle is unsigned; 10° abduction reads as a 10° hinge angle
      // because the geometric angle between parent+child world dirs = 10°.
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(10, 0);
    });

    it('clamps excessive knee off-axis swing (40° → 5°) — tighter than elbow', () => {
      const { skeleton, bones, rest } = setup();
      bones.L_Leg.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        (40 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Leg, 'L_Leg', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Leg.kneeFlexion).toBeCloseTo(5, 0);
    });

    it('leaves a small forearm twist (20°) untouched — within elbow tolerance', () => {
      const { bones, rest } = setup();
      bones.L_Forearm.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, -1, 0),
        (20 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const before = bones.L_Forearm.quaternion.clone();
      const changed = clampBoneToRom(bones.L_Forearm, 'L_Forearm', rest);
      expect(changed).toBe(false);
      expect(bones.L_Forearm.quaternion.equals(before)).toBe(true);
    });

    it('clamps excessive forearm twist (80°) → 45° (elbow rotation cap)', () => {
      const { bones, rest } = setup();
      bones.L_Forearm.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, -1, 0),
        (80 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Forearm, 'L_Forearm', rest);
      expect(changed).toBe(true);
      // After clamp the bone should be a pure 45° twist about local -Y.
      const expected = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, -1, 0),
        (45 * Math.PI) / 180,
      );
      expect(bones.L_Forearm.quaternion.angleTo(expected)).toBeLessThan(0.02);
    });

    it('preserves a 90° flex + 20° forearm twist (both within tolerance)', () => {
      const { skeleton, bones, rest } = setup();
      const flex = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        Math.PI / 2,
      );
      const twist = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, -1, 0),
        (20 * Math.PI) / 180,
      );
      bones.L_Forearm.quaternion.copy(flex).multiply(twist);
      bones.Hips.updateMatrixWorld(true);

      clampBoneToRom(bones.L_Forearm, 'L_Forearm', rest);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(90, 0);
    });
  });

  describe('mirror correctness', () => {
    it('clamps right shoulder rotation +120° → -90° (mirror flips sign)', () => {
      const { skeleton, bones, rest } = setup();
      // 120° twist about the bone's long axis = pure shoulder rotation.
      // For the right side the mirror flips the displayed rotation sign,
      // so the +120° quat reads as -120° rotation; clamp to ROM min -90°.
      bones.R_UpperArm.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, -1, 0),
        (120 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.R_UpperArm, 'R_UpperArm', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.R_UpperArm.shoulderRotation).toBeCloseTo(-90, 0);
    });

    it('clamps left shoulder rotation +120° → +90° (mirror-symmetric with right)', () => {
      const { skeleton, bones, rest } = setup();
      bones.L_UpperArm.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, -1, 0),
        (120 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_UpperArm, 'L_UpperArm', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_UpperArm.shoulderRotation).toBeCloseTo(90, 0);
    });
  });

  describe('pelvis world frame', () => {
    it('clamps pelvis anterior tilt 60° → 30°', () => {
      const { skeleton, bones, rest } = setup();
      // Anterior tilt of 60°: -π/3 about +X (forward tip is negative euler.x).
      bones.Hips.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (-60 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.Hips, 'Hips', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.Hips.anteriorTilt).toBeCloseTo(30, 0);
    });
  });

  describe('safety', () => {
    it('returns false (and writes nothing) when rest is null', () => {
      const { bones } = setup();
      const before = bones.L_UpperArm.quaternion.clone();
      bones.L_UpperArm.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (220 * Math.PI) / 180,
      );
      const dirty = bones.L_UpperArm.quaternion.clone();
      const changed = clampBoneToRom(bones.L_UpperArm, 'L_UpperArm', null);
      expect(changed).toBe(false);
      expect(bones.L_UpperArm.quaternion.equals(dirty)).toBe(true);
      // Sanity: we did move it off the captured rest.
      expect(bones.L_UpperArm.quaternion.equals(before)).toBe(false);
    });

    it('returns false for a bone with no clamp strategy', () => {
      const { bones, rest } = setup();
      // L_Hand has a strategy, so use a key we know is absent.
      const changed = clampBoneToRom(bones.L_UpperArm, 'L_Shoulder', rest);
      expect(changed).toBe(false);
    });
  });
});
