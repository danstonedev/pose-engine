import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  hashJointAngleReport,
} from '../services/jointAngles';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

/** Build a synthetic CC-named skeleton sufficient to exercise every joint
 *  computeJointAngles cares about. Bones are arranged so each child sits at
 *  (0, -1, 0) relative to its parent — that puts every limb's long axis
 *  along local -Y at rest, matching the production rig. Bone names follow
 *  the CC4 export convention (prefix `CC_Base_`, side prefix `L_`/`R_`)
 *  so CC_BONE_NAME_MAP in bodyVariants.ts normalizes them correctly. */
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

  // Root pelvis at the world origin; children offset to look like an
  // anatomic stick figure.
  const hips = make('CC_Base_Hip', null, [0, 0, 0]);

  // Spine + head — CC core tokens: Waist, Spine01, Spine02, NeckTwist01, Head.
  const spine = make('CC_Base_Waist', hips, [0, 0.2, 0]);
  const spine1 = make('CC_Base_Spine01', spine, [0, 0.3, 0]);
  const spine2 = make('CC_Base_Spine02', spine1, [0, 0.3, 0]);
  const neck = make('CC_Base_NeckTwist01', spine2, [0, 0.2, 0]);
  const head = make('CC_Base_Head', neck, [0, 0.2, 0]);

  // Left arm — CC: L_Clavicle → L_Upperarm → L_Forearm → L_Hand
  const lShoulder = make('CC_Base_L_Clavicle', spine2, [0.15, 0.1, 0]);
  const lUpperArm = make('CC_Base_L_Upperarm', lShoulder, [0.15, 0, 0]);
  const lForearm = make('CC_Base_L_Forearm', lUpperArm, [0, -1, 0]);
  const lHand = make('CC_Base_L_Hand', lForearm, [0, -1, 0]);
  make('CC_Base_L_Index1', lHand, [0, -0.3, 0]); // give Hand a child for direction computation

  // Right arm (mirrored on X)
  const rShoulder = make('CC_Base_R_Clavicle', spine2, [-0.15, 0.1, 0]);
  const rUpperArm = make('CC_Base_R_Upperarm', rShoulder, [-0.15, 0, 0]);
  const rForearm = make('CC_Base_R_Forearm', rUpperArm, [0, -1, 0]);
  const rHand = make('CC_Base_R_Hand', rForearm, [0, -1, 0]);
  make('CC_Base_R_Index1', rHand, [0, -0.3, 0]);

  // Left leg — CC: L_Thigh → L_Calf → L_Foot → L_ToeBase
  const lUpLeg = make('CC_Base_L_Thigh', hips, [0.1, -0.1, 0]);
  const lLeg = make('CC_Base_L_Calf', lUpLeg, [0, -1, 0]);
  const lFoot = make('CC_Base_L_Foot', lLeg, [0, -1, 0]);
  make('CC_Base_L_ToeBase', lFoot, [0, 0, -0.2]);

  // Right leg
  const rUpLeg = make('CC_Base_R_Thigh', hips, [-0.1, -0.1, 0]);
  const rLeg = make('CC_Base_R_Calf', rUpLeg, [0, -1, 0]);
  const rFoot = make('CC_Base_R_Foot', rLeg, [0, -1, 0]);
  make('CC_Base_R_ToeBase', rFoot, [0, 0, -0.2]);

  // Walk the tree to collect every bone for the Skeleton.
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
    L_Shoulder: lShoulder,
    L_UpperArm: lUpperArm,
    L_Forearm: lForearm,
    L_Hand: lHand,
    R_Shoulder: rShoulder,
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
const TOL = 0.5; // degrees; synthetic-skeleton precision

describe('computeJointAngles', () => {
  describe('anatomic baseline', () => {
    it('reports all clinical angles ~ 0 when no rotations are applied', () => {
      const { skeleton } = buildSyntheticCCSkeleton();
      const report = computeJointAngles(skeleton, variant, 'male');
      // Spot-check each category — pelvis world frame, parent-frame Euler,
      // ball joints, hinges, hand/foot.
      expect(report.joints.Hips.anteriorTilt).toBeCloseTo(0, 1);
      expect(report.joints.Hips.lateralTilt).toBeCloseTo(0, 1);
      expect(report.joints.Hips.rotation).toBeCloseTo(0, 1);
      // Spine_Mid is the trunk-curve control (no standalone readout); the
      // regional thoracic readout lives on Spine_Upper.
      expect(report.joints.Spine_Upper.flexion).toBeCloseTo(0, 1);
      expect(report.joints.L_UpperArm.shoulderFlexion).toBeCloseTo(0, 1);
      expect(report.joints.L_UpperArm.shoulderAbduction).toBeCloseTo(0, 1);
      expect(report.joints.R_UpperArm.shoulderFlexion).toBeCloseTo(0, 1);
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(0, 1);
      expect(report.joints.R_Forearm.elbowFlexion).toBeCloseTo(0, 1);
      expect(report.joints.L_Leg.kneeFlexion).toBeCloseTo(0, 1);
      expect(report.joints.R_Leg.kneeFlexion).toBeCloseTo(0, 1);
      expect(report.joints.L_Hand.wristFlexion).toBeCloseTo(0, 1);
      expect(report.joints.L_Foot.ankleFlexion).toBeCloseTo(0, 1);
    });
  });

  describe('hinge flexion (elbow / knee)', () => {
    it('reads -90° when forearm bends 90° about local X (elbow flex)', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      bones.L_Forearm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      // Elbow flexion is now SIGNED (magnitude * dir * flexSign, flexSign=-1
      // for the elbow), so this forward bend reads -90° rather than +90°.
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(-90, 0);
    });
    it('reads -90° on the right elbow too (mirror does not affect hinge sign)', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      bones.R_Forearm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      // Signed hinge: same -90° as the left elbow (elbow flexSign=-1).
      expect(report.joints.R_Forearm.elbowFlexion).toBeCloseTo(-90, 0);
    });
    it('reads 90° when knee bends 90°', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      bones.L_Leg.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      expect(report.joints.L_Leg.kneeFlexion).toBeCloseTo(90, 0);
    });
  });

  describe('ball joints (shoulder swing-twist)', () => {
    it('left arm raised forward 90° → +shoulderFlexion, ~0 abduction', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      // Rotate upper arm 90° about local X. Local -Y (down) maps to local -Z
      // (anterior in our body frame — model faces -Z), so this is forward
      // arm raise in the sagittal plane.
      bones.L_UpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      expect(report.joints.L_UpperArm.shoulderFlexion).toBeCloseTo(90, 0);
      expect(Math.abs(report.joints.L_UpperArm.shoulderAbduction)).toBeLessThan(TOL);
    });
    it('left arm abducted 90° → +shoulderAbduction, ~0 flexion', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      // Local -Y (down) → +X (subject's left, lateral) by rotating about
      // local +Z by +π/2. Right-hand rule about +Z: looking down +Z toward
      // origin, +X moves to +Y, +Y moves to -X, -Y moves to +X. So a +π/2
      // rotation moves "down" out to subject's left = abduction.
      bones.L_UpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      expect(report.joints.L_UpperArm.shoulderAbduction).toBeCloseTo(90, 0);
      expect(Math.abs(report.joints.L_UpperArm.shoulderFlexion)).toBeLessThan(TOL);
    });
    it('right arm abducted 90° (mirror sign) → +shoulderAbduction', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      // For the right side, true abduction takes the arm to subject's right
      // (-X), which is rotation about local +Z by -π/2. Without the mirror
      // this reads -90°; the right-side mirror inside ballJointAngles flips
      // it to +90° so both sides express abduction with the same sign.
      bones.R_UpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      expect(report.joints.R_UpperArm.shoulderAbduction).toBeCloseTo(90, 0);
    });
  });

  describe('pelvis world frame', () => {
    it('reads -anteriorTilt when the pelvis tips forward (top toward -Z)', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      // Superior axis (+Y) rotates toward anterior (-Z). Right-hand rule about
      // +X moves +Y toward +Z (posterior), so the forward tip comes from a
      // -π/6 rotation about +X. anteriorTilt sign is now flipped, so this
      // forward tip reads -30° rather than +30°.
      bones.Hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 6);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      expect(report.joints.Hips.anteriorTilt).toBeCloseTo(-30, 0);
    });
    it('reads +anteriorTilt (posterior tip) when the pelvis tips backward', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      bones.Hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 6); // 30° about +X
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      // anteriorTilt sign flipped: backward tip now reads +30° rather than -30°.
      expect(report.joints.Hips.anteriorTilt).toBeCloseTo(30, 0);
    });
    it('reads +lateralTilt when subject’s left rises', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      // +Z rotation moves +X (left) toward +Y (up) — left rises.
      bones.Hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 6);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      expect(report.joints.Hips.lateralTilt).toBeCloseTo(30, 0);
    });
    it('reads -rotation when the body rotates to face subject’s left', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      // Body anterior is -Z; rotating to face -X (subject’s left) takes
      // -Z to -X, which is rotation about +Y by -π/6. Pelvis rotation sign is
      // now flipped, so facing subject's left reads -30° rather than +30°.
      bones.Hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 6);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male');
      expect(report.joints.Hips.rotation).toBeCloseTo(-30, 0);
    });
  });

  describe('rest reference (delta from anatomic baseline)', () => {
    it('reads ~0 across the panel when current pose matches captured rest', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      // Stand the model in a non-trivial "anatomic" pose: tilt the pelvis,
      // bend a few joints. Capture this as rest. Live readout against rest
      // must be 0 even though absolute quaternions are nowhere near identity.
      bones.Hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2);
      bones.L_UpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4);
      bones.R_UpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.4);
      bones.L_Forearm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.15);
      bones.Hips.updateMatrixWorld(true);
      const rest = captureJointAngleRestReference(skeleton, variant);
      // Don't move anything between capture and read.
      const report = computeJointAngles(skeleton, variant, 'male', rest);
      expect(report.joints.Hips.anteriorTilt).toBeCloseTo(0, 1);
      expect(report.joints.Hips.lateralTilt).toBeCloseTo(0, 1);
      expect(report.joints.Hips.rotation).toBeCloseTo(0, 1);
      expect(report.joints.L_UpperArm.shoulderFlexion).toBeCloseTo(0, 1);
      expect(report.joints.L_UpperArm.shoulderAbduction).toBeCloseTo(0, 1);
      expect(report.joints.R_UpperArm.shoulderAbduction).toBeCloseTo(0, 1);
      // Hinge angle isn't delta-based but at this configuration the parent
      // and child still point closely enough for elbow extension to read
      // small (forearm bend was 0.15 rad ≈ 8.6°). Signed hinge (elbow
      // flexSign=-1) makes this read -8.6° rather than +8.6°.
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(-8.6, 0);
    });
    it('measures additional rotation correctly when current diverges from rest', () => {
      const { skeleton, bones } = buildSyntheticCCSkeleton();
      // Capture an off-anatomic rest (some shoulder abduction).
      bones.L_UpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4);
      bones.Hips.updateMatrixWorld(true);
      const rest = captureJointAngleRestReference(skeleton, variant);
      // Add 30° flexion in PARENT FRAME on top of rest. To get delta = addQ
      // (pure flexion in parent-local space) we need bone.quaternion =
      // addQ × restQ (apply rest first, then addQ). Three.js Quaternion
      // multiplication is left-to-right, so addQ.clone().multiply(restQ)
      // yields exactly that ordering.
      const restQ = bones.L_UpperArm.quaternion.clone();
      const addQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        Math.PI / 6,
      );
      bones.L_UpperArm.quaternion.copy(addQ).multiply(restQ);
      bones.Hips.updateMatrixWorld(true);
      const report = computeJointAngles(skeleton, variant, 'male', rest);
      expect(report.joints.L_UpperArm.shoulderFlexion).toBeCloseTo(30, 0);
    });
  });
});

describe('hashJointAngleReport', () => {
  it('returns "none" / "empty" sentinels for missing data', () => {
    expect(hashJointAngleReport(null)).toBe('none');
    expect(hashJointAngleReport({ at: '', variant: 'male', joints: {} })).toBe('empty');
  });
  it('produces stable hashes for equivalent reports and changes on edits', () => {
    const a = {
      at: '2026-01-01T00:00:00.000Z',
      variant: 'male',
      joints: { L_Forearm: { elbowFlexion: 30 } },
    };
    const b = {
      at: '2030-12-31T23:59:59.999Z',
      variant: 'male',
      joints: { L_Forearm: { elbowFlexion: 30.04 } }, // rounds to same 0.1°
    };
    const c = {
      at: '2026-01-01T00:00:00.000Z',
      variant: 'male',
      joints: { L_Forearm: { elbowFlexion: 31 } },
    };
    expect(hashJointAngleReport(a)).toBe(hashJointAngleReport(b));
    expect(hashJointAngleReport(a)).not.toBe(hashJointAngleReport(c));
  });
});
