import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  decomposeBodyDelta,
  deltaFromRest,
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
        'Spine_Upper',
        'Neck',
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
      // World-frame shoulder readout: local +X swings the arm posteriorly, so it
      // reads −60 (extension) — still within ROM (min −60), so the clamp is a no-op.
      // (poseRomClamp itself decomposes locally; the shoulder clamp path is the
      // documented, command-unused seam — see ExamStage3D.)
      expect(report.joints.L_UpperArm.shoulderFlexion).toBeCloseTo(-60, 0);
    });

    it('leaves a 90° elbow flexion (within ROM) almost untouched', () => {
      const { skeleton, bones, rest } = setup();
      bones.L_Forearm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      bones.Hips.updateMatrixWorld(true);

      clampBoneToRom(bones.L_Forearm, 'L_Forearm', rest);
      const report = reportFor(skeleton, rest);
      // Signed hinge (elbow flexSign=-1): a 90° forward bend reads -90°.
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(-90, 0);
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
      // Clamp decomposes locally (−90 → −60 local); the world-frame readout signs
      // the clamped pose as +60. Local clamp vs world read is the documented,
      // command-unused shoulder seam (see ExamStage3D).
      expect(report.joints.L_UpperArm.shoulderFlexion).toBeCloseTo(60, 0);
    });

    it('clamps elbow flexion 160° → -150° (signed hinge)', () => {
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
      // Signed hinge (elbow flexSign=-1): clamped 150° magnitude reads -150°.
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(-150, 0);
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

    it('clamps knee anatomic flex (lower leg posterior) 160° → -140° (signed hinge)', () => {
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
      // Signed hinge: posterior knee flex (from -X rotation sense) reads
      // negative; clamped 140° magnitude reads -140°.
      expect(report.joints.L_Leg.kneeFlexion).toBeCloseTo(-140, 0);
    });
  });

  describe('ankle: dorsi/plantar bounds land on the correct pole', () => {
    // Regression for the clamp/readout sign mismatch: the readout writes
    // ankleFlexion = -a.flexion (dorsi +), but the clamp used to feed raw
    // a.flexion into the registry range — so plantarflexion stopped at the
    // dorsi limit (20°) and dorsiflexion ran to the plantar limit (50°).
    // ROM: dorsi 0–20, plantar 0–50 (range {min:-50, max:20}).

    it('leaves 15° dorsiflexion (within ROM) untouched', () => {
      const { skeleton, bones, rest } = setup();
      // +X rotation lifts the toe toward the shin = dorsiflexion (Dorsi +).
      bones.L_Foot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (15 * Math.PI) / 180);
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Foot, 'L_Foot', rest);
      expect(changed).toBe(false);

      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Foot.ankleFlexion).toBeCloseTo(15, 0);
    });

    it('clamps 50° dorsiflexion → 20° (dorsi limit, NOT 50)', () => {
      const { skeleton, bones, rest } = setup();
      bones.L_Foot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (50 * Math.PI) / 180);
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Foot, 'L_Foot', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Foot.ankleFlexion).toBeCloseTo(20, 0);
    });

    it('allows 40° plantarflexion (within ROM) untouched', () => {
      const { skeleton, bones, rest } = setup();
      // -X rotation points the toe down = plantarflexion (Plantar, readout -).
      bones.L_Foot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (-40 * Math.PI) / 180);
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Foot, 'L_Foot', rest);
      expect(changed).toBe(false);

      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Foot.ankleFlexion).toBeCloseTo(-40, 0);
    });

    it('clamps 60° plantarflexion → 50° (plantar limit, NOT 20)', () => {
      const { skeleton, bones, rest } = setup();
      bones.L_Foot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (-60 * Math.PI) / 180);
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.L_Foot, 'L_Foot', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      expect(report.joints.L_Foot.ankleFlexion).toBeCloseTo(-50, 0);
    });
  });

  describe('spine: thoracic + cervical regional ROM (C/T-spine)', () => {
    // The region curve clamps the CONTROL bone's target (the regional total)
    // against the registry row keyed by the control: Spine_Upper = Thoracic,
    // Neck = Cervical. Body-euler shares the readout frame, so the clamped
    // result is checked in the readout's convention (flexion = -a.flexion).

    const REST_IDENTITY: [number, number, number, number] = [0, 0, 0, 1];
    function spineRest(key: string): JointAngleRestReference {
      return {
        pelvisWorldQuat: REST_IDENTITY,
        localQuats: { [key]: REST_IDENTITY },
        worldQuats: {},
      } as unknown as JointAngleRestReference;
    }
    // A pure +X-euler (YXZ) delta of θ° reads as θ° of readout flexion.
    function flexBone(deg: number): THREE.Bone {
      const bone = new THREE.Bone();
      bone.quaternion.setFromEuler(new THREE.Euler((deg * Math.PI) / 180, 0, 0, 'YXZ'));
      return bone;
    }
    function readoutFlexion(bone: THREE.Bone): number {
      const d = new THREE.Quaternion();
      deltaFromRest(bone.quaternion, REST_IDENTITY, d);
      return -decomposeBodyDelta(d).flexion; // readout convention
    }

    it('clamps thoracic flexion 60° → 40° (Spine_Upper max flex)', () => {
      const bone = flexBone(60);
      expect(clampBoneToRom(bone, 'Spine_Upper', spineRest('Spine_Upper'))).toBe(true);
      expect(readoutFlexion(bone)).toBeCloseTo(40, 0);
    });

    it('clamps thoracic extension -40° → -25° (Spine_Upper max ext)', () => {
      const bone = flexBone(-40);
      expect(clampBoneToRom(bone, 'Spine_Upper', spineRest('Spine_Upper'))).toBe(true);
      expect(readoutFlexion(bone)).toBeCloseTo(-25, 0);
    });

    it('leaves within-ROM thoracic flexion (30°) untouched', () => {
      const bone = flexBone(30);
      expect(clampBoneToRom(bone, 'Spine_Upper', spineRest('Spine_Upper'))).toBe(false);
      expect(readoutFlexion(bone)).toBeCloseTo(30, 0);
    });

    it('clamps cervical flexion 80° → 50° (Neck max flex)', () => {
      const bone = flexBone(80);
      expect(clampBoneToRom(bone, 'Neck', spineRest('Neck'))).toBe(true);
      expect(readoutFlexion(bone)).toBeCloseTo(50, 0);
    });

    it('clamps cervical extension -90° → -60° (Neck max ext)', () => {
      const bone = flexBone(-90);
      expect(clampBoneToRom(bone, 'Neck', spineRest('Neck'))).toBe(true);
      expect(readoutFlexion(bone)).toBeCloseTo(-60, 0);
    });
  });

  describe('wrist: flex/dev read from swapped axes (twisted frame)', () => {
    // The wrist inherits the forearm's twisted frame: readout wristFlexion =
    // -a.abduction (local-Z), wristDeviation = -a.flexion (local-X, L). The clamp
    // must use the SAME swap, else flexion is constrained by the deviation
    // range (±~25°) and deviation by the flexion range (±~70-80°). The flex sign
    // (verified live in PoseLab) means +flexion = -raw-Z, so flexion bounds
    // (+80) land on negative raw-Z and extension (-70) on positive raw-Z.
    // Ranges: wristFlexion {-70, 80}, wristDeviation {-30, 20}.

    const REST_IDENTITY: [number, number, number, number] = [0, 0, 0, 1];
    function handRest(): JointAngleRestReference {
      return {
        pelvisWorldQuat: REST_IDENTITY,
        localQuats: { L_Hand: REST_IDENTITY, R_Hand: REST_IDENTITY },
        worldQuats: {},
      } as unknown as JointAngleRestReference;
    }
    function decomposed(bone: THREE.Bone) {
      const d = new THREE.Quaternion();
      deltaFromRest(bone.quaternion, REST_IDENTITY, d);
      return decomposeBodyDelta(d);
    }
    // Pure Z-euler θ → a.abduction = θ → readout wristFlexion = -θ.
    function abductBone(deg: number): THREE.Bone {
      const bone = new THREE.Bone();
      bone.quaternion.setFromEuler(new THREE.Euler(0, 0, (deg * Math.PI) / 180, 'YXZ'));
      return bone;
    }
    // Pure X-euler -φ → a.flexion = φ → readout wristDeviation (L) = -φ.
    function flexBone(devDeg: number): THREE.Bone {
      const bone = new THREE.Bone();
      bone.quaternion.setFromEuler(new THREE.Euler((-devDeg * Math.PI) / 180, 0, 0, 'YXZ'));
      return bone;
    }

    it('clamps wrist flexion 100° → 80° (NOT the ±25° deviation range)', () => {
      const bone = abductBone(-100); // readout wristFlexion = -(-100) = 100
      expect(clampBoneToRom(bone, 'L_Hand', handRest())).toBe(true);
      expect(decomposed(bone).abduction).toBeCloseTo(-80, 0); // wristFlexion = 80
    });

    it('clamps wrist extension -100° → -70°', () => {
      const bone = abductBone(100); // readout wristFlexion = -100 (extension)
      expect(clampBoneToRom(bone, 'L_Hand', handRest())).toBe(true);
      expect(decomposed(bone).abduction).toBeCloseTo(70, 0); // wristFlexion = -70
    });

    it('clamps radial deviation 50° → 20° (NOT the ±80° flexion range)', () => {
      const bone = flexBone(-50); // readout wristDeviation (L) = -(-50) = 50 (radial)
      expect(clampBoneToRom(bone, 'L_Hand', handRest())).toBe(true);
      expect(decomposed(bone).flexion).toBeCloseTo(-20, 0); // wristDeviation = 20
    });

    it('clamps ulnar deviation -50° → -30°', () => {
      const bone = flexBone(50); // readout wristDeviation (L) = -50 (ulnar)
      expect(clampBoneToRom(bone, 'L_Hand', handRest())).toBe(true);
      expect(decomposed(bone).flexion).toBeCloseTo(30, 0); // wristDeviation = -30
    });

    it('leaves within-ROM wrist flexion (60°) untouched', () => {
      const bone = abductBone(-60); // readout wristFlexion = 60
      expect(clampBoneToRom(bone, 'L_Hand', handRest())).toBe(false);
      expect(decomposed(bone).abduction).toBeCloseTo(-60, 0);
    });

    // Right hand's local frame is flipped ~180° about its long axis, so its
    // FLEXION read inverts vs the left (flexionSign +1 not -1); deviation maps
    // the same on both. These lock that asymmetry.
    it('right wrist flexion uses the opposite raw-Z sign vs left', () => {
      const bone = abductBone(100); // a.abduction = 100 → R clinical flexion +100
      expect(clampBoneToRom(bone, 'R_Hand', handRest())).toBe(true);
      expect(decomposed(bone).abduction).toBeCloseTo(80, 0); // clamped to flex max +80
    });

    it('right wrist radial deviation matches the left mapping', () => {
      const bone = flexBone(-50); // a.flexion = -50 → R clinical deviation +50 (radial)
      expect(clampBoneToRom(bone, 'R_Hand', handRest())).toBe(true);
      expect(decomposed(bone).flexion).toBeCloseTo(-20, 0); // clamped to radial max +20
    });
  });

  describe('orientation: knees flex posteriorly, hips flex anteriorly', () => {
    it('allows anatomic knee flex up to -100° (lower leg posterior, in range)', () => {
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
      // Signed hinge: posterior knee flex reads negative → -100°.
      expect(report.joints.L_Leg.kneeFlexion).toBeCloseTo(-100, 0);
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

    it('clamps hip extension -45° → -30° (thigh posterior, max ext is 30°)', () => {
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
      // Hip flexion ROM min widened from -20° to -30°, so extension now
      // clamps at -30° instead of -20°.
      expect(r?.anatomicFlexion).toBeCloseTo(-30, 0);
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
      // Hinge magnitude is 10° (geometric angle between parent+child world
      // dirs after the clamp); signed hinge (elbow flexSign=-1) reports -10°.
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(-10, 0);
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
      // Signed hinge (elbow flexSign=-1): the preserved 90° flex reads -90°.
      expect(report.joints.L_Forearm.elbowFlexion).toBeCloseTo(-90, 0);
    });
  });

  describe('mirror correctness', () => {
    it('clamps right shoulder rotation +120° → +90° (mirror + flipped sign)', () => {
      const { skeleton, bones, rest } = setup();
      // 120° twist about the bone's long axis = pure shoulder rotation.
      // shoulderRotation sign is now flipped (plus the right-side mirror), so
      // the +120° quat reads positive and clamps to the +90° end of the
      // asymmetric ROM (min -90, max +70 -> here the clamp lands at +90°).
      bones.R_UpperArm.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, -1, 0),
        (120 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.R_UpperArm, 'R_UpperArm', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      // Local clamp lands at the +90° local twist limit; the world-frame readout
      // signs it −90 (local-clamp vs world-read shoulder seam — see ExamStage3D).
      expect(report.joints.R_UpperArm.shoulderRotation).toBeCloseTo(-90, 0);
    });

    it('clamps left shoulder rotation +120° → -70° (mirror counterpart of right)', () => {
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
      // Local clamp lands at the −70° local limit (no right-side mirror); the
      // world-frame readout signs it +70 (local-clamp vs world-read shoulder seam).
      expect(report.joints.L_UpperArm.shoulderRotation).toBeCloseTo(70, 0);
    });
  });

  describe('pelvis world frame', () => {
    it('clamps pelvis anterior tilt 60° → -30° (flipped sign)', () => {
      const { skeleton, bones, rest } = setup();
      // Forward tip of 60°: -π/3 about +X (forward tip is negative euler.x).
      bones.Hips.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (-60 * Math.PI) / 180,
      );
      bones.Hips.updateMatrixWorld(true);

      const changed = clampBoneToRom(bones.Hips, 'Hips', rest);
      expect(changed).toBe(true);

      bones.Hips.updateMatrixWorld(true);
      const report = reportFor(skeleton, rest);
      // anteriorTilt sign is now flipped: the clamped 30°-magnitude forward
      // tip reads -30°.
      expect(report.joints.Hips.anteriorTilt).toBeCloseTo(-30, 0);
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
