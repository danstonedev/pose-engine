/**
 * Movement-command seam (simLAB A0).
 *
 * Two layers under test:
 *
 * 1. `resolveCommandTarget` — the pure clamping matrix: normative-only,
 *    scenario-constrained-tighter, the documented refusal rule (<20% of the
 *    requested travel achievable from neutral), and the painful-arc flag.
 *
 * 2. `buildCommandPose` — pose construction verified against the REAL male
 *    runtime rig, exactly like mission-shell's moveObservePose.test.ts: GLB
 *    parse (meshopt) → applyAnatomicPose → captureJointAngleRestReference →
 *    apply the built pose → computeJointAngles, asserting the MEASURED angle
 *    lands within ±2° of the clamped target. The ankle case reproduces the
 *    authored ankle-sprain convention (~−12° plantar on R_Foot).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
// The runtime mannequins are EXT_meshopt_compression-encoded — parsing them
// requires the decoder, same as every registered loader site in this repo.
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import {
  buildComposedCommandPose,
  buildCommandPose,
  finalizeOutcome,
  isMovementCommandSupported,
  listSupportedMovementCommands,
  measureCommandMotion,
  resolveCommandTarget,
  type ExamMovementCommand,
} from '../services/movementCommand';
import { buildSequencePoses, resolveComposedMotion } from '../services/motionSequence';
import { hasClampStrategy } from '../services/poseRomClamp';
import { ROM_JOINT_ROWS } from '../services/romRegistry';
import { DEFAULT_TRACKED_BONES } from '../services/motionRecording';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;

const setJoint = (
  joint: string,
  motion: string,
  targetDegrees: number,
): ExamMovementCommand => ({ action: 'set-joint', joint, motion, targetDegrees });

// ── 1. resolveCommandTarget clamping matrix (pure) ──────────────────────────

describe('resolveCommandTarget', () => {
  describe('normative-only clamping', () => {
    it('complies with an in-range dorsiflexion request', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg);
      expect(r.status).toBe('complied');
      expect(r.clampedDegrees).toBe(10);
      expect(r.limitedBy).toBeUndefined();
      expect(r.painful).toBe(false);
    });

    it('modifies dorsiflexion past the normative limit (35 → 20, normative-rom)', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 35), variantCfg);
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(20);
      expect(r.limitedBy).toBe('normative-rom');
    });

    it('modifies plantarflexion past the normative limit (−60 → −50, normative-rom)', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -60), variantCfg);
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(-50);
      expect(r.limitedBy).toBe('normative-rom');
    });

    it('clamps knee flexion 160 → 140 (normative-rom)', () => {
      const r = resolveCommandTarget(setJoint('R_Leg', 'kneeFlexion', 160), variantCfg);
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(140);
      expect(r.limitedBy).toBe('normative-rom');
    });
  });

  describe('weight-bearing (closed-chain) dorsiflexion allowance', () => {
    // Ankle DF has two norms: seated open-chain AROM ~20°, and the larger
    // weight-bearing (WBLT) ~35° reached when the shin advances over a planted
    // foot in a squat/lunge. The WB max applies ONLY to a planted target.
    it('open-chain (default) still caps dorsiflexion at the 20° AROM', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 32), variantCfg);
      expect(r.clampedDegrees).toBe(20);
      expect(r.limitedBy).toBe('normative-rom');
    });

    it('a PLANTED (weight-bearing) foot reaches the WB dorsiflexion max', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 32), variantCfg, {
        weightBearing: true,
      });
      expect(r.status).toBe('complied');
      expect(r.clampedDegrees).toBe(32);
      // …and it is bounded by the WB max (35°), not left unclamped.
      const capped = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 40), variantCfg, {
        weightBearing: true,
      });
      expect(capped.clampedDegrees).toBe(35);
      expect(capped.limitedBy).toBe('normative-rom');
    });

    it('a scenario DF restriction still tightens BELOW the WB max (reduced-DF fault)', () => {
      // The teaching hook: constrain DF below the WB max to demonstrate the
      // compensations a limited-dorsiflexion squat must make to stay balanced.
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 32), variantCfg, {
        weightBearing: true,
        constraints: { R_Foot: { ankleFlexion: { availableRange: { min: -30, max: 12 } } } },
      });
      expect(r.clampedDegrees).toBe(12);
      expect(r.limitedBy).toBe('scenario-constraint');
    });

    it('plantarflexion (negative side) is unaffected by the WB flag', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -60), variantCfg, {
        weightBearing: true,
      });
      expect(r.clampedDegrees).toBe(-50);
    });
  });

  describe('scenario constraints clamp tighter than normative', () => {
    it('modifies at the scenario cap (dorsi 10 → 5, scenario-constraint)', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { availableRange: { min: -30, max: 5 } } } },
      });
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(5);
      expect(r.limitedBy).toBe('scenario-constraint');
    });

    it('modifies at the scenario floor (plantar −40 → −30, scenario-constraint)', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -40), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { availableRange: { min: -30, max: 5 } } } },
      });
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(-30);
      expect(r.limitedBy).toBe('scenario-constraint');
    });

    it('leaves the unconstrained side of the joint on the normative bound', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -60), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { availableRange: { max: 5 } } } },
      });
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(-50); // normative plantar floor still applies
      expect(r.limitedBy).toBe('normative-rom');
    });
  });

  describe('refusal rule: achievable travel < 20% of requested (from neutral)', () => {
    it('refuses dorsiflexion when the available range never crosses neutral', () => {
      // Ankle stuck plantar: can move only between −30 and −5.
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { availableRange: { min: -30, max: -5 } } } },
      });
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('no-achievable-travel');
      expect(r.limitedBy).toBe('scenario-constraint');
      expect(r.clampedDegrees).toBeUndefined();
    });

    it('still moves at exactly 20% achievable travel (cap 2 on a 10° request)', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { availableRange: { max: 2 } } } },
      });
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(2);
    });

    it('refuses just under the threshold (cap 1.9 on a 10° request)', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { availableRange: { max: 1.9 } } } },
      });
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('no-achievable-travel');
    });

    it('never refuses a return-to-neutral target — settles at the nearest bound', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 0), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { availableRange: { min: -30, max: -5 } } } },
      });
      expect(r.status).toBe('modified'); // NOT refused
      expect(r.clampedDegrees).toBe(-5);
    });
  });

  describe('painful arc', () => {
    it('flags a compliant target inside the authored painful arc', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -10), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { painfulArc: { min: -20, max: -5 } } } },
      });
      expect(r.status).toBe('complied');
      expect(r.painful).toBe(true);
    });

    it('does not flag a target outside the arc', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -2), variantCfg, {
        constraints: { R_Foot: { ankleFlexion: { painfulArc: { min: -20, max: -5 } } } },
      });
      expect(r.status).toBe('complied');
      expect(r.painful).toBe(false);
    });

    it('flags a MODIFIED target whose clamp lands inside the arc', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -45), variantCfg, {
        constraints: {
          R_Foot: {
            ankleFlexion: {
              availableRange: { min: -20, max: 20 },
              painfulArc: { min: -20, max: -15 },
            },
          },
        },
      });
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(-20);
      expect(r.painful).toBe(true);
    });
  });

  describe('vocabulary validation', () => {
    it('refuses an unknown joint', () => {
      const r = resolveCommandTarget(setJoint('R_Flipper', 'ankleFlexion', 10), variantCfg);
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('unknown-joint');
    });

    it('refuses an unknown motion on a known joint', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'wingFlap', 10), variantCfg);
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('unknown-motion');
    });

    it('refuses a registry-valid but unsupported motion (elbow deviation)', () => {
      const r = resolveCommandTarget(setJoint('L_Forearm', 'elbowDeviation', 10), variantCfg);
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('unsupported-motion');
    });

    it('refuses a non-finite target', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', Number.NaN), variantCfg);
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('invalid-target');
    });

    it('relax always complies', () => {
      const r = resolveCommandTarget({ action: 'relax' }, variantCfg);
      expect(r.status).toBe('complied');
    });

    it('exposes exactly the documented vocabulary (v1 → v1.5: every rig-reported joint)', () => {
      const list = listSupportedMovementCommands()
        .map((c) => `${c.joint}.${c.motion}`)
        .sort();
      expect(list).toEqual([
        'L_Foot.ankleAbduction',
        'L_Foot.ankleFlexion',
        'L_Foot.ankleInversion',
        'L_Forearm.elbowFlexion',
        'L_Forearm.forearmRotation',
        'L_Hand.wristDeviation',
        'L_Hand.wristFlexion',
        'L_Index1.fingerFlexion',
        'L_Leg.kneeFlexion',
        'L_Leg.kneeRotation',
        'L_Mid1.fingerFlexion',
        'L_Pinky1.fingerFlexion',
        'L_Ring1.fingerFlexion',
        'L_Shoulder.protraction',
        'L_Shoulder.scapularTilt',
        'L_Shoulder.upRotation',
        'L_Thumb1.fingerFlexion',
        'L_Toes.toeFlexion',
        'L_UpLeg.hipAbduction',
        'L_UpLeg.hipFlexion',
        'L_UpLeg.hipRotation',
        'L_UpperArm.shoulderAbduction',
        'L_UpperArm.shoulderFlexion',
        'L_UpperArm.shoulderRotation',
        'Neck.flexion',
        'Neck.lateralTilt',
        'Neck.rotation',
        'R_Foot.ankleAbduction',
        'R_Foot.ankleFlexion',
        'R_Foot.ankleInversion',
        'R_Forearm.elbowFlexion',
        'R_Forearm.forearmRotation',
        'R_Hand.wristDeviation',
        'R_Hand.wristFlexion',
        'R_Index1.fingerFlexion',
        'R_Leg.kneeFlexion',
        'R_Leg.kneeRotation',
        'R_Mid1.fingerFlexion',
        'R_Pinky1.fingerFlexion',
        'R_Ring1.fingerFlexion',
        'R_Shoulder.protraction',
        'R_Shoulder.scapularTilt',
        'R_Shoulder.upRotation',
        'R_Thumb1.fingerFlexion',
        'R_Toes.toeFlexion',
        'R_UpLeg.hipAbduction',
        'R_UpLeg.hipFlexion',
        'R_UpLeg.hipRotation',
        'R_UpperArm.shoulderAbduction',
        'R_UpperArm.shoulderFlexion',
        'R_UpperArm.shoulderRotation',
        'Spine_Lower.flexion',
        'Spine_Lower.lateralTilt',
        'Spine_Lower.rotation',
        'Spine_Upper.flexion',
        'Spine_Upper.lateralTilt',
        'Spine_Upper.rotation',
      ]);
      expect(isMovementCommandSupported('R_Foot', 'ankleFlexion')).toBe(true);
      expect(isMovementCommandSupported('R_Foot', 'ankleInversion')).toBe(true);
      expect(isMovementCommandSupported('L_UpLeg', 'hipRotation')).toBe(true);
      expect(isMovementCommandSupported('R_Hand', 'wristFlexion')).toBe(true);
      expect(isMovementCommandSupported('L_Shoulder', 'upRotation')).toBe(true);
      expect(isMovementCommandSupported('R_UpperArm', 'shoulderRotation')).toBe(true);
      expect(isMovementCommandSupported('Spine_Upper', 'rotation')).toBe(true);
      expect(isMovementCommandSupported('L_Mid1', 'fingerFlexion')).toBe(true);
      expect(isMovementCommandSupported('L_Toes', 'toeFlexion')).toBe(true);
      // Shoulder FLEXION stays withheld (readout long-axis degeneracy — see spec).
      expect(isMovementCommandSupported('L_UpperArm', 'shoulderFlexion')).toBe(true);
      // Hinge deviation axes (knee rotation/deviation) remain uncalibrated.
      expect(isMovementCommandSupported('L_Forearm', 'elbowDeviation')).toBe(false);
    });

    it('supports shoulder flexion (v1.6 world-frame readout)', () => {
      for (const joint of ['L_UpperArm', 'R_UpperArm']) {
        const r = resolveCommandTarget(setJoint(joint, 'shoulderFlexion', 60), variantCfg);
        expect(r.status).toBe('complied');
      }
    });

    it('trunk: clamps lumbar flexion to the normative registry range (−25…60)', () => {
      const over = resolveCommandTarget(setJoint('Spine_Lower', 'flexion', 75), variantCfg);
      expect(over.status).toBe('modified');
      expect(over.clampedDegrees).toBe(60);
      expect(over.limitedBy).toBe('normative-rom');
      const ext = resolveCommandTarget(setJoint('Spine_Lower', 'flexion', -40), variantCfg);
      expect(ext.status).toBe('modified');
      expect(ext.clampedDegrees).toBe(-25);
    });

    it('trunk: the authored guarded-flexion shape (cap 32, painful 24–32) modifies + hurts', () => {
      const r = resolveCommandTarget(setJoint('Spine_Lower', 'flexion', 45), variantCfg, {
        constraints: {
          Spine_Lower: {
            flexion: {
              availableRange: { min: -18, max: 32 },
              painfulArc: { min: 24, max: 32 },
            },
          },
        },
      });
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(32);
      expect(r.limitedBy).toBe('scenario-constraint');
      expect(r.painful).toBe(true);
    });
  });

  describe('finalizeOutcome', () => {
    it('prefers the measured achieved angle and re-evaluates pain against it', () => {
      const constraints = {
        R_Foot: { ankleFlexion: { painfulArc: { min: -20, max: -5 } } },
      };
      const resolved = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -2), variantCfg, {
        constraints,
      });
      expect(resolved.painful).toBe(false);
      // Suppose the settled skeleton measured −6.1° (inside the arc).
      const outcome = finalizeOutcome(resolved, -6.1, constraints);
      expect(outcome.achievedDegrees).toBe(-6.1);
      expect(outcome.painful).toBe(true);
      expect(outcome.status).toBe('complied');
      expect(outcome.joint).toBe('R_Foot');
      expect(outcome.requestedDegrees).toBe(-2);
    });

    it('carries refusal metadata through without an achieved angle', () => {
      const resolved = resolveCommandTarget(setJoint('L_Forearm', 'elbowDeviation', 10), variantCfg);
      const outcome = finalizeOutcome(resolved);
      expect(outcome.status).toBe('refused');
      expect(outcome.reason).toBe('unsupported-motion');
      expect(outcome.achievedDegrees).toBeUndefined();
    });
  });
});

// ── 2. buildCommandPose against the REAL male runtime rig ──────────────────

const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let boneLookup: Map<string, THREE.Bone>;
let anatomicLocals: Map<THREE.Bone, THREE.Quaternion>;

function resetToAnatomic(): void {
  for (const [bone, q] of anatomicLocals) bone.quaternion.copy(q);
  root.updateMatrixWorld(true);
}

function applyAndMeasure(pose: CustomPose) {
  const applied = applyCustomPose(skinned.skeleton, variantCfg, pose);
  expect(applied).toBeGreaterThan(0);
  root.updateMatrixWorld(true);
  return computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
}

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.parse(arrayBuffer, '', resolve, reject);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  expect(skinned).toBeDefined();

  // The exact ExamStage3D/ObservationViewer boot order (the correctness
  // trap): anatomic pose FIRST, then rest-reference capture, then the
  // baseline-pose serialization every command builds from.
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  boneLookup = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  anatomicLocals = new Map();
  for (const bone of skinned.skeleton.bones) anatomicLocals.set(bone, bone.quaternion.clone());
});

describe('buildCommandPose on the real male rig', () => {
  it('ankle: reproduces the authored −12° plantar-flexion convention (±2°)', () => {
    resetToAnatomic();
    const cmd = setJoint('R_Foot', 'ankleFlexion', -12);
    const resolved = resolveCommandTarget(cmd, variantCfg);
    expect(resolved.status).toBe('complied');
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg);
    expect(pose).not.toBeNull();
    const report = applyAndMeasure(pose!);
    expect(report.joints.R_Foot.ankleFlexion).toBeGreaterThan(-14);
    expect(report.joints.R_Foot.ankleFlexion).toBeLessThan(-10);
    // Comparison limb stays plantigrade (only the commanded bone moves).
    expect(Math.abs(report.joints.L_Foot.ankleFlexion)).toBeLessThan(2);
    expect(measureCommandMotion(report, 'R_Foot', 'ankleFlexion')).toBeCloseTo(-12, 0);
  });

  it('ankle: 10° dorsiflexion lands within ±2°', () => {
    resetToAnatomic();
    const cmd = setJoint('R_Foot', 'ankleFlexion', 10);
    const resolved = resolveCommandTarget(cmd, variantCfg);
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
    const report = applyAndMeasure(pose);
    const achieved = measureCommandMotion(report, 'R_Foot', 'ankleFlexion')!;
    expect(Math.abs(achieved - 10)).toBeLessThan(2);
  });

  it('ankle: a scenario-clamped command settles at the constraint cap', () => {
    resetToAnatomic();
    const constraints = {
      R_Foot: { ankleFlexion: { availableRange: { min: -30, max: 5 } } },
    };
    const cmd = setJoint('R_Foot', 'ankleFlexion', 15);
    const resolved = resolveCommandTarget(cmd, variantCfg, { constraints });
    expect(resolved.status).toBe('modified');
    expect(resolved.clampedDegrees).toBe(5);
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
    const report = applyAndMeasure(pose);
    const achieved = measureCommandMotion(report, 'R_Foot', 'ankleFlexion')!;
    expect(Math.abs(achieved - 5)).toBeLessThan(2);
    const outcome = finalizeOutcome(resolved, achieved, constraints);
    expect(outcome.status).toBe('modified');
    expect(outcome.limitedBy).toBe('scenario-constraint');
  });

  it('knee: 30° flexion lands within ±2° and swings the foot posteriorly (both sides)', () => {
    for (const [legKey, footKey, toesKey] of [
      ['R_Leg', 'R_Foot', 'R_Toes'],
      ['L_Leg', 'L_Foot', 'L_Toes'],
    ] as const) {
      resetToAnatomic();
      // CONVENTION-FREE direction pin (founder field report: the old test
      // hardcoded "the mannequin faces −Z" — it faces +Z, so "bend your knee"
      // shipped as an anterior front-kick). Anterior is defined by the rig
      // itself: the way the toes point at rest. Anatomic knee flexion carries
      // the foot AWAY from where the toes point (heel toward buttock).
      const footBefore = boneLookup.get(footKey)!.getWorldPosition(new THREE.Vector3());
      const toesBefore = boneLookup.get(toesKey)!.getWorldPosition(new THREE.Vector3());
      const anterior = toesBefore.clone().sub(footBefore).setY(0).normalize();
      const cmd = setJoint(legKey, 'kneeFlexion', 30);
      const resolved = resolveCommandTarget(cmd, variantCfg);
      expect(resolved.status).toBe('complied');
      const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
      const report = applyAndMeasure(pose);
      const footAfter = boneLookup.get(footKey)!.getWorldPosition(new THREE.Vector3());
      const travel = footAfter.clone().sub(footBefore);
      expect(travel.clone().setY(0).dot(anterior)).toBeLessThan(-0.05); // posterior
      expect(travel.clone().setY(0).addScaledVector(anterior, -travel.clone().setY(0).dot(anterior)).length()).toBeLessThan(0.05); // no lateral drift
      const achieved = measureCommandMotion(report, legKey, 'kneeFlexion')!;
      expect(Math.abs(achieved - 30)).toBeLessThan(2);
      // Off-axis leakage stays negligible (clean hinge motion).
      expect(Math.abs(report.joints[legKey].kneeDeviation)).toBeLessThan(1);
      expect(Math.abs(report.joints[legKey].kneeRotation)).toBeLessThan(1);
    }
  });

  it('trunk: 20° lumbar flexion lands EXACT, smear-free, and bends the body forward', () => {
    resetToAnatomic();
    // Convention-free forward check: bending forward carries the head toward
    // where the toes point (and caudally). Capture the toe direction at rest.
    const footRest = boneLookup.get('R_Foot')!.getWorldPosition(new THREE.Vector3());
    const toesRest = boneLookup.get('R_Toes')!.getWorldPosition(new THREE.Vector3());
    const anterior = toesRest.sub(footRest).setY(0).normalize();
    const headRest = boneLookup.get('Head')!.getWorldPosition(new THREE.Vector3());

    const cmd = setJoint('Spine_Lower', 'flexion', 20);
    const resolved = resolveCommandTarget(cmd, variantCfg);
    expect(resolved.status).toBe('complied');
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
    const report = applyAndMeasure(pose);

    // The readout honesty bar (what kept shoulder out): commanded == measured.
    const achieved = measureCommandMotion(report, 'Spine_Lower', 'flexion')!;
    expect(Math.abs(achieved - 20)).toBeLessThan(2);
    // Zero off-axis smear — a sagittal command must not read as tilt/rotation.
    expect(Math.abs(report.joints.Spine_Lower.lateralTilt)).toBeLessThan(1);
    expect(Math.abs(report.joints.Spine_Lower.rotation)).toBeLessThan(1);

    // The visual honesty bar: the head moved TOWARD the toes and DOWN.
    const headAfter = boneLookup.get('Head')!.getWorldPosition(new THREE.Vector3());
    const headTravel = headAfter.clone().sub(headRest);
    expect(headTravel.clone().setY(0).dot(anterior)).toBeGreaterThan(0.05);
    expect(headTravel.y).toBeLessThan(-0.005);
    // Legs stay parked — only the commanded segment moves.
    expect(Math.abs(measureCommandMotion(report, 'R_Leg', 'kneeFlexion')!)).toBeLessThan(1);
    expect(Math.abs(report.joints.R_Foot.ankleFlexion)).toBeLessThan(1);
  });

  it('trunk: extension (−15°) measures true and moves the head the other way', () => {
    resetToAnatomic();
    const headRest = boneLookup.get('Head')!.getWorldPosition(new THREE.Vector3());
    const footRest = boneLookup.get('R_Foot')!.getWorldPosition(new THREE.Vector3());
    const toesRest = boneLookup.get('R_Toes')!.getWorldPosition(new THREE.Vector3());
    const anterior = toesRest.sub(footRest).setY(0).normalize();
    const cmd = setJoint('Spine_Lower', 'flexion', -15);
    const resolved = resolveCommandTarget(cmd, variantCfg);
    expect(resolved.status).toBe('complied');
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
    const report = applyAndMeasure(pose);
    expect(Math.abs(measureCommandMotion(report, 'Spine_Lower', 'flexion')! - -15)).toBeLessThan(2);
    const headAfter = boneLookup.get('Head')!.getWorldPosition(new THREE.Vector3());
    expect(headAfter.clone().sub(headRest).setY(0).dot(anterior)).toBeLessThan(-0.05);
  });

  it('trunk: the guarded-flexion scenario settles at the cap, in the painful arc', () => {
    resetToAnatomic();
    const constraints = {
      Spine_Lower: {
        flexion: { availableRange: { min: -18, max: 32 }, painfulArc: { min: 24, max: 32 } },
      },
    };
    const cmd = setJoint('Spine_Lower', 'flexion', 45);
    const resolved = resolveCommandTarget(cmd, variantCfg, { constraints });
    expect(resolved.status).toBe('modified');
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
    const report = applyAndMeasure(pose);
    const achieved = measureCommandMotion(report, 'Spine_Lower', 'flexion')!;
    expect(Math.abs(achieved - 32)).toBeLessThan(2);
    const outcome = finalizeOutcome(resolved, achieved, constraints);
    expect(outcome.status).toBe('modified');
    expect(outcome.limitedBy).toBe('scenario-constraint');
    expect(outcome.painful).toBe(true);
  });

  // ── v1.3 commanded joints: hip / elbow / trunk side-bend+rotation / cervical
  //    / shoulder abduction — each reads back within ±2°, no off-plane smear,
  //    correct world direction (rig-verified by the calibration team). ──────────

  it('hip: flexion (+30) & extension (−15) land within ±2°, smear-free (both sides)', () => {
    for (const [hipKey, kneeKey] of [
      ['R_UpLeg', 'R_Leg'],
      ['L_UpLeg', 'L_Leg'],
    ] as const) {
      for (const cmd of [30, -15]) {
        resetToAnatomic();
        const kneeBefore = boneLookup.get(kneeKey)!.getWorldPosition(new THREE.Vector3());
        const command = setJoint(hipKey, 'hipFlexion', cmd);
        const resolved = resolveCommandTarget(command, variantCfg);
        expect(resolved.status).toBe('complied');
        const pose = buildCommandPose(baselinePose, command, resolved.clampedDegrees!, variantCfg)!;
        const report = applyAndMeasure(pose);
        expect(Math.abs(measureCommandMotion(report, hipKey, 'hipFlexion')! - cmd)).toBeLessThan(2);
        expect(Math.abs(report.joints[hipKey].hipAbduction)).toBeLessThan(5);
        expect(Math.abs(report.joints[hipKey].hipRotation)).toBeLessThan(5);
        // Flexion carries the thigh up; extension drops it back.
        const kneeAfter = boneLookup.get(kneeKey)!.getWorldPosition(new THREE.Vector3());
        if (cmd > 0) expect(kneeAfter.y).toBeGreaterThan(kneeBefore.y);
      }
    }
  });

  it('hip: abduction (+30) & adduction (−20) read back within ±2° and swing the knee laterally (both sides)', () => {
    for (const [hipKey, kneeKey, awaySign] of [
      // true abduction carries the LEFT knee toward +X (subject-left) and the
      // RIGHT knee toward −X — both AWAY from the midline.
      ['L_UpLeg', 'L_Leg', +1],
      ['R_UpLeg', 'R_Leg', -1],
    ] as const) {
      for (const cmd of [30, -20]) {
        resetToAnatomic();
        const kneeBefore = boneLookup.get(kneeKey)!.getWorldPosition(new THREE.Vector3());
        const command = setJoint(hipKey, 'hipAbduction', cmd);
        const resolved = resolveCommandTarget(command, variantCfg);
        expect(resolved.status).toBe('complied');
        const pose = buildCommandPose(baselinePose, command, resolved.clampedDegrees!, variantCfg)!;
        const report = applyAndMeasure(pose);
        expect(Math.abs(measureCommandMotion(report, hipKey, 'hipAbduction')! - cmd)).toBeLessThan(2);
        // Clean world swing: knee moves in X (abduction +away / adduction −toward),
        // with no anterior/posterior drift (Z ≈ 0).
        const kneeAfter = boneLookup.get(kneeKey)!.getWorldPosition(new THREE.Vector3());
        const d = kneeAfter.clone().sub(kneeBefore);
        expect(Math.sign(d.x)).toBe(cmd > 0 ? awaySign : -awaySign);
        expect(Math.abs(d.z)).toBeLessThan(0.03);
        // Off-plane smear is the swing-twist coupling artifact — bounded, not zero.
        expect(Math.abs(report.joints[hipKey].hipFlexion)).toBeLessThan(5);
        expect(Math.abs(report.joints[hipKey].hipRotation)).toBeLessThan(6);
      }
    }
  });

  it('hip: internal (+25) & external (−25) rotation read back within ±2° (both sides)', () => {
    for (const hipKey of ['L_UpLeg', 'R_UpLeg'] as const) {
      for (const cmd of [25, -25]) {
        resetToAnatomic();
        const command = setJoint(hipKey, 'hipRotation', cmd);
        const resolved = resolveCommandTarget(command, variantCfg);
        expect(resolved.status).toBe('complied');
        const pose = buildCommandPose(baselinePose, command, resolved.clampedDegrees!, variantCfg)!;
        const report = applyAndMeasure(pose);
        expect(Math.abs(measureCommandMotion(report, hipKey, 'hipRotation')! - cmd)).toBeLessThan(2);
        // Coupled swing stays bounded; the twist itself is exact.
        expect(Math.abs(report.joints[hipKey].hipFlexion)).toBeLessThan(4);
        expect(Math.abs(report.joints[hipKey].hipAbduction)).toBeLessThan(5);
      }
    }
  });

  it('elbow: 60° flexion lands within ±2° and swings the hand toward the shoulder (both sides)', () => {
    for (const [foreKey, armKey, handKey] of [
      ['R_Forearm', 'R_UpperArm', 'R_Hand'],
      ['L_Forearm', 'L_UpperArm', 'L_Hand'],
    ] as const) {
      resetToAnatomic();
      const shoulder = boneLookup.get(armKey)!.getWorldPosition(new THREE.Vector3());
      const handBefore = boneLookup.get(handKey)!.getWorldPosition(new THREE.Vector3());
      const cmd = setJoint(foreKey, 'elbowFlexion', 60);
      const resolved = resolveCommandTarget(cmd, variantCfg);
      expect(resolved.status).toBe('complied');
      const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
      const report = applyAndMeasure(pose);
      expect(Math.abs(measureCommandMotion(report, foreKey, 'elbowFlexion')! - 60)).toBeLessThan(2);
      expect(Math.abs(report.joints[foreKey].forearmRotation)).toBeLessThan(5);
      const handAfter = boneLookup.get(handKey)!.getWorldPosition(new THREE.Vector3());
      expect(handAfter.distanceTo(shoulder)).toBeLessThan(handBefore.distanceTo(shoulder));
      expect(handAfter.y).toBeGreaterThan(handBefore.y);
    }
  });

  it('trunk: side-bend (±25) and axial rotation (±10) read back exact, smear-free', () => {
    for (const [motion, deg] of [
      ['lateralTilt', 25],
      ['lateralTilt', -25],
      ['rotation', 10],
      ['rotation', -10],
    ] as const) {
      resetToAnatomic();
      const cmd = setJoint('Spine_Lower', motion, deg);
      const resolved = resolveCommandTarget(cmd, variantCfg);
      expect(resolved.status).toBe('complied');
      const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
      const report = applyAndMeasure(pose);
      expect(Math.abs(measureCommandMotion(report, 'Spine_Lower', motion)! - deg)).toBeLessThan(2);
      for (const off of ['flexion', 'lateralTilt', 'rotation'] as const)
        if (off !== motion) expect(Math.abs(report.joints.Spine_Lower[off])).toBeLessThan(2);
    }
  });

  it('cervical: flexion / rotation / lateralTilt read back exact, smear-free', () => {
    for (const [motion, deg] of [
      ['flexion', 30],
      ['flexion', -20],
      ['rotation', 60],
      ['rotation', -60],
      ['lateralTilt', 25],
      ['lateralTilt', -25],
    ] as const) {
      resetToAnatomic();
      const cmd = setJoint('Neck', motion, deg);
      const resolved = resolveCommandTarget(cmd, variantCfg);
      expect(resolved.status).toBe('complied');
      const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
      const report = applyAndMeasure(pose);
      expect(Math.abs(measureCommandMotion(report, 'Neck', motion)! - deg)).toBeLessThan(2);
      for (const off of ['flexion', 'lateralTilt', 'rotation'] as const)
        if (off !== motion) expect(Math.abs(report.joints.Neck[off])).toBeLessThan(2);
    }
  });

  it('shoulder FLEXION (v1.6): forward-raises the arm, exact + isolated (both arms)', () => {
    for (const [armKey, handKey] of [
      ['L_UpperArm', 'L_Hand'],
      ['R_UpperArm', 'R_Hand'],
    ] as const) {
      // Main axis exact across the full clinical range (incl. overhead).
      for (const deg of [45, 90, 135]) {
        resetToAnatomic();
        const handBefore = boneLookup.get(handKey)!.getWorldPosition(new THREE.Vector3());
        const report = expectMeasured(armKey, 'shoulderFlexion', deg);
        expect(Math.abs(report.joints[armKey].shoulderRotation)).toBeLessThan(3); // no twist leak
        // World direction: the hand raises anteriorly (+Z) and upward.
        const handAfter = boneLookup.get(handKey)!.getWorldPosition(new THREE.Vector3());
        expect(handAfter.z).toBeGreaterThan(handBefore.z);
        expect(handAfter.y).toBeGreaterThan(handBefore.y);
      }
      // (The abduction field carries a few degrees of cross-talk during flexion and
      // saturates toward 180° past horizontal — an inherent 3-field ball-joint
      // limit; the twist-free main axis above is what grading uses.)
    }
  });

  it('shoulder abduction (v1.6): laterally raises the arm, exact + isolated to ~90° (both arms)', () => {
    for (const [armKey, handKey, awaySign] of [
      ['L_UpperArm', 'L_Hand', +1], // left arm away from midline = +X
      ['R_UpperArm', 'R_Hand', -1],
    ] as const) {
      for (const deg of [45, 90]) {
        resetToAnatomic();
        const handBefore = boneLookup.get(handKey)!.getWorldPosition(new THREE.Vector3());
        const report = expectMeasured(armKey, 'shoulderAbduction', deg);
        expect(Math.abs(report.joints[armKey].shoulderRotation)).toBeLessThan(4);
        const handAfter = boneLookup.get(handKey)!.getWorldPosition(new THREE.Vector3());
        expect(Math.sign(handAfter.x - handBefore.x)).toBe(awaySign); // away from midline
        expect(handAfter.y).toBeGreaterThan(handBefore.y);
      }
    }
  });

  // ── v1.5 commanded joints: ankle secondary / great toe / thoracic / scapula /
  //    wrist / shoulder rotation / fingers — rig-verified by the calibration team. ──

  const expectMeasured = (joint: string, motion: string, deg: number, tol = 2) => {
    resetToAnatomic();
    const cmd = setJoint(joint, motion, deg);
    const resolved = resolveCommandTarget(cmd, variantCfg);
    expect(resolved.status).toBe('complied');
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg, null, rest)!;
    const report = applyAndMeasure(pose);
    expect(Math.abs(measureCommandMotion(report, joint, motion)! - deg)).toBeLessThan(tol);
    return report;
  };

  it('ankle secondary: inversion/eversion & abduction/adduction read back exact (both feet)', () => {
    for (const foot of ['L_Foot', 'R_Foot'] as const) {
      for (const [motion, deg] of [
        ['ankleInversion', 20],
        ['ankleInversion', -10],
        ['ankleAbduction', 10],
        ['ankleAbduction', -10],
      ] as const) {
        const report = expectMeasured(foot, motion, deg);
        // The other two ankle axes stay put (clean single-axis motion).
        for (const off of ['ankleFlexion', 'ankleInversion', 'ankleAbduction'] as const)
          if (off !== motion) expect(Math.abs(report.joints[foot][off])).toBeLessThan(2);
        // The opposite foot never moves.
        const other = foot === 'L_Foot' ? 'R_Foot' : 'L_Foot';
        expect(Math.abs(report.joints[other][motion])).toBeLessThan(1);
      }
    }
  });

  it('great toe: MTP extension (+40) lifts the toes and flexion (−20) curls them (both feet)', () => {
    for (const toeKey of ['L_Toes', 'R_Toes'] as const) {
      resetToAnatomic();
      const tipRest = boneLookup.get(toeKey)!.getWorldPosition(new THREE.Vector3());
      const ext = expectMeasured(toeKey, 'toeFlexion', 40);
      const tipExt = boneLookup.get(toeKey)!.getWorldPosition(new THREE.Vector3());
      expect(tipExt.y).toBeGreaterThan(tipRest.y - 0.001); // toes rise on extension
      void ext;
      expectMeasured(toeKey, 'toeFlexion', -20); // curl reads back exact
    }
  });

  it('thoracic: flexion / lateralTilt / rotation read back exact, smear-free', () => {
    for (const [motion, deg] of [
      ['flexion', 20],
      ['flexion', -15],
      ['lateralTilt', 20],
      ['lateralTilt', -20],
      ['rotation', 25],
      ['rotation', -25],
    ] as const) {
      const report = expectMeasured('Spine_Upper', motion, deg);
      for (const off of ['flexion', 'lateralTilt', 'rotation'] as const)
        if (off !== motion) expect(Math.abs(report.joints.Spine_Upper[off])).toBeLessThan(2);
    }
  });

  it('scapula: upRotation / scapularTilt / protraction read back exact (both sides)', () => {
    for (const scap of ['L_Shoulder', 'R_Shoulder'] as const) {
      for (const [motion, deg] of [
        ['upRotation', 30],
        ['scapularTilt', 20],
        ['protraction', 20],
        ['protraction', -20],
      ] as const) {
        const report = expectMeasured(scap, motion, deg);
        for (const off of ['upRotation', 'scapularTilt', 'protraction'] as const)
          if (off !== motion) expect(Math.abs(report.joints[scap][off])).toBeLessThan(2);
      }
    }
  });

  it('wrist: flexion/extension & radial/ulnar deviation read back exact, smear-free (both hands)', () => {
    for (const hand of ['L_Hand', 'R_Hand'] as const) {
      for (const [motion, deg] of [
        ['wristFlexion', 40],
        ['wristFlexion', -40],
        ['wristDeviation', 15],
        ['wristDeviation', -20],
      ] as const) {
        const report = expectMeasured(hand, motion, deg);
        for (const off of ['wristFlexion', 'wristDeviation'] as const)
          if (off !== motion) expect(Math.abs(report.joints[hand][off])).toBeLessThan(2);
      }
    }
  });

  it('forearm: pro/supination commanded on the Forearm reads back exact (both arms)', () => {
    for (const foreKey of ['L_Forearm', 'R_Forearm'] as const) {
      for (const deg of [60, -60]) {
        const report = expectMeasured(foreKey, 'forearmRotation', deg);
        // The readout writes the total pro/sup to the wrist row too.
        const handKey = foreKey === 'L_Forearm' ? 'L_Hand' : 'R_Hand';
        expect(Math.abs(report.joints[handKey].proSup - deg)).toBeLessThan(3);
        // Hinge flexion undisturbed.
        expect(Math.abs(report.joints[foreKey].elbowFlexion)).toBeLessThan(2);
      }
    }
  });

  it('knee rotation: tibial internal/external reads back exact (both legs)', () => {
    for (const legKey of ['L_Leg', 'R_Leg'] as const) {
      for (const deg of [20, -20]) {
        const report = expectMeasured(legKey, 'kneeRotation', deg);
        expect(Math.abs(report.joints[legKey].kneeFlexion)).toBeLessThan(2);
      }
    }
  });

  it('shoulder rotation: internal (+30) & external (−30) read back exact (both arms)', () => {
    for (const arm of ['L_UpperArm', 'R_UpperArm'] as const) {
      for (const deg of [30, -30]) {
        const report = expectMeasured(arm, 'shoulderRotation', deg);
        expect(Math.abs(report.joints[arm].shoulderFlexion)).toBeLessThan(3);
        expect(Math.abs(report.joints[arm].shoulderAbduction)).toBeLessThan(3);
      }
    }
  });

  // The floor of each digit's response curve — the LOWEST `fingerFlexion` the
  // rig can read at any pose, because the readout sums UNSIGNED inter-bone
  // angles and the local-Z curl axis is not perpendicular to the metacarpal.
  // Commands below it land on the digit's most-extended pose (see FINGER_CURVE).
  const MALE_FINGER_FLOOR: Record<string, number> = {
    Thumb1: 28.1,
    Index1: 20.0,
    Mid1: 5.8,
    Ring1: 6.9,
    Pinky1: 20.2,
  };

  it('fingers: commanded == measured across the WHOLE 0–160° ROM, every digit, both hands', () => {
    // Not a spot check. The previous affine pre-compensation passed at 30/60 and
    // read 16° low at 90 on the thumb, because it was a chord across a curved
    // response. Walking the range at 1° is what catches that class of error.
    let worst = { err: 0, digit: '', deg: 0, measured: 0 };
    for (const digit of ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1'] as const) {
      for (const side of ['L_', 'R_'] as const) {
        const key = `${side}${digit}`;
        for (let deg = Math.ceil(MALE_FINGER_FLOOR[digit]!) + 1; deg <= 160; deg++) {
          resetToAnatomic();
          const cmd = setJoint(key, 'fingerFlexion', deg);
          const resolved = resolveCommandTarget(cmd, variantCfg);
          const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg, null, rest)!;
          const measured = measureCommandMotion(applyAndMeasure(pose), key, 'fingerFlexion')!;
          const err = Math.abs(measured - deg);
          if (err > worst.err) worst = { err, digit: key, deg, measured };
        }
      }
    }
    expect(
      worst.err,
      `worst: ${worst.digit} commanded ${worst.deg}° measured ${worst.measured.toFixed(1)}°`,
    ).toBeLessThan(2);
  });

  it('fingers: each digit has a rig floor it cannot read below, and lands ON it when commanded lower', () => {
    // Stated rather than hidden: this is a property of the readout's geometry,
    // not of the pre-compensation. A caller asking for 0° on the thumb gets the
    // most-extended thumb the rig has, and the report says so.
    for (const digit of ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1'] as const) {
      const floor = MALE_FINGER_FLOOR[digit]!;
      const at = (deg: number) => {
        resetToAnatomic();
        const cmd = setJoint(`R_${digit}`, 'fingerFlexion', deg);
        const resolved = resolveCommandTarget(cmd, variantCfg);
        const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg, null, rest)!;
        return measureCommandMotion(applyAndMeasure(pose), `R_${digit}`, 'fingerFlexion')!;
      };
      // Commanding 0 settles at the floor, not below it.
      expect(Math.abs(at(0) - floor)).toBeLessThan(1.5);
      // And nothing in the achievable range reads below it.
      expect(at(Math.ceil(floor) + 5)).toBeGreaterThan(floor - 1);
    }
  });

  it('fingers: the curl CASCADES down all three phalanges (MCP trails PIP, DIP two-thirds of PIP)', () => {
    // The clinical readout only sees MCP+PIP, so it cannot catch a distal
    // phalanx that never moves. Measure the bone rotations directly.
    resetToAnatomic();
    const restLocals = new Map<string, THREE.Quaternion>();
    for (const b of ['R_Mid1', 'R_Mid2', 'R_Mid3'])
      restLocals.set(b, boneLookup.get(b)!.quaternion.clone());

    const cmd = setJoint('R_Mid1', 'fingerFlexion', 60);
    const resolved = resolveCommandTarget(cmd, variantCfg);
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg, null, rest)!;
    applyAndMeasure(pose);

    const travel = (key: string) => {
      const now = boneLookup.get(key)!.quaternion;
      const delta = restLocals.get(key)!.clone().invert().multiply(now);
      return 2 * Math.acos(Math.min(1, Math.abs(delta.w))) * (180 / Math.PI);
    };
    const [mcp, pip, dip] = [travel('R_Mid1'), travel('R_Mid2'), travel('R_Mid3')];
    // Every segment moves — the distal end curls rather than pointing.
    expect(dip).toBeGreaterThan(15);
    // The PIP leads the cascade; the DIP follows it at roughly two-thirds.
    expect(mcp).toBeLessThan(pip);
    expect(dip / pip).toBeGreaterThan(0.6);
    expect(dip / pip).toBeLessThan(0.8);
  });

  it('fingers: the fingertip travels toward the palm and keeps going as the curl deepens', () => {
    resetToAnatomic();
    const wrist = boneLookup.get('R_Hand')!.getWorldPosition(new THREE.Vector3());
    const deepest = (b: THREE.Bone): THREE.Bone => {
      let cur: THREE.Bone = b;
      for (;;) {
        const child = cur.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
        if (!child) return cur;
        cur = child;
      }
    };
    const tip = deepest(boneLookup.get('R_Mid1')!);
    const reach = (deg: number) => {
      resetToAnatomic();
      const cmd = setJoint('R_Mid1', 'fingerFlexion', deg);
      const resolved = resolveCommandTarget(cmd, variantCfg);
      const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg, null, rest)!;
      applyAndMeasure(pose);
      return tip.getWorldPosition(new THREE.Vector3()).distanceTo(wrist);
    };
    // MONOTONE, not just "moved": a distribution that over-rotates one phalanx
    // can pull the tip back out again past a certain depth. It must not.
    const rest0 = tip.getWorldPosition(new THREE.Vector3()).distanceTo(wrist);
    let prev = rest0;
    for (const deg of [20, 40, 60, 80, 100, 120, 140, 160]) {
      const d = reach(deg);
      expect(d).toBeLessThan(prev);
      prev = d;
    }
    // …and the deepest curl brings the tip meaningfully in toward the palm.
    expect(prev).toBeLessThan(rest0 - 0.03);
  });

  it('preserves the rest of a fromPose (sequential commands compose)', () => {
    resetToAnatomic();
    // First command: knee to 30.
    const kneeCmd = setJoint('R_Leg', 'kneeFlexion', 30);
    const kneePose = buildCommandPose(baselinePose, kneeCmd, 30, variantCfg)!;
    // Second command: ankle to −12, composed on top of the knee pose.
    const ankleCmd = setJoint('R_Foot', 'ankleFlexion', -12);
    const combined = buildCommandPose(baselinePose, ankleCmd, -12, variantCfg, kneePose)!;
    // The knee override from the first command survives verbatim.
    expect(combined.bones.R_Leg).toEqual(kneePose.bones.R_Leg);
    const report = applyAndMeasure(combined);
    expect(Math.abs(measureCommandMotion(report, 'R_Leg', 'kneeFlexion')! - 30)).toBeLessThan(2);
    expect(Math.abs(measureCommandMotion(report, 'R_Foot', 'ankleFlexion')! - -12)).toBeLessThan(2);
  });

  it('relax returns toward the baseline pose (all supported joints ≈ 0°)', () => {
    resetToAnatomic();
    // Park the rig off-baseline first.
    const parked = buildCommandPose(baselinePose, setJoint('R_Foot', 'ankleFlexion', -12), -12, variantCfg)!;
    applyAndMeasure(parked);
    // Relax → a copy of the resting pose handed in (here: the anatomic baseline).
    const relaxed = buildCommandPose(baselinePose, { action: 'relax' }, 0, variantCfg)!;
    expect(relaxed.bones.R_Foot).toEqual(baselinePose.bones.R_Foot);
    const report = applyAndMeasure(relaxed);
    expect(Math.abs(report.joints.R_Foot.ankleFlexion)).toBeLessThan(1);
    expect(Math.abs(measureCommandMotion(report, 'R_Leg', 'kneeFlexion')!)).toBeLessThan(1);
    expect(Math.abs(measureCommandMotion(report, 'L_UpperArm', 'shoulderFlexion')!)).toBeLessThan(1);
  });

  it('returns null for unsupported motions (callers refuse first)', () => {
    const pose = buildCommandPose(
      baselinePose,
      setJoint('L_Forearm', 'elbowDeviation', 10),
      10,
      variantCfg,
    );
    expect(pose).toBeNull();
  });
});

// ── 3. FEMALE-variant canary (the calibrations were derived on the male rig;
//    this compact boot of the female GLB guards the transfer — especially the
//    finger fits, whose OFFSETS are variant-keyed (different rest MCP posture).
//    Rig-verified full sweep: 51/57 transfer exactly; fingers need the female
//    constants in FINGER_FIT. ─────────────────────────────────────────────────

describe('female-variant canary (calibration transfers)', () => {
  const femaleCfg = BODY_VARIANTS.female;
  let fRoot: THREE.Object3D;
  let fSkinned: THREE.SkinnedMesh;
  let fRest: JointAngleRestReference;
  let fBaseline: CustomPose;

  beforeAll(async () => {
    const url = new URL('../../models/painmap3D_female.runtime.glb', import.meta.url);
    const buf = readFileSync(fileURLToPath(url));
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.parse(arrayBuffer, '', resolve, reject);
    });
    fRoot = gltf.scene;
    fRoot.scale.setScalar(femaleCfg.pose.rootScale);
    fRoot.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !fSkinned) fSkinned = o as THREE.SkinnedMesh;
    });
    fRoot.updateMatrixWorld(true);
    applyAnatomicPose(fRoot, femaleCfg);
    fRoot.updateMatrixWorld(true);
    fRest = captureJointAngleRestReference(fSkinned.skeleton, femaleCfg);
    fBaseline = serializeCustomPose(fSkinned.skeleton, femaleCfg, 'female');
  });

  const measureFemale = (joint: string, motion: string, deg: number, tol = 2) => {
    const cmd = setJoint(joint, motion, deg);
    const resolved = resolveCommandTarget(cmd, femaleCfg);
    expect(resolved.status).toBe('complied');
    const pose = buildCommandPose(fBaseline, cmd, resolved.clampedDegrees!, femaleCfg, null, fRest)!;
    expect(pose).not.toBeNull();
    applyCustomPose(fSkinned.skeleton, femaleCfg, pose);
    fRoot.updateMatrixWorld(true);
    const report = computeJointAngles(fSkinned.skeleton, femaleCfg, 'female', fRest);
    expect(Math.abs(measureCommandMotion(report, joint, motion)! - deg)).toBeLessThan(tol);
  };

  it('one canary per joint group reads back exact on the female rig', () => {
    measureFemale('R_Foot', 'ankleFlexion', 12);
    measureFemale('L_Foot', 'ankleInversion', 20);
    measureFemale('R_Leg', 'kneeFlexion', 60);
    measureFemale('L_UpLeg', 'hipAbduction', 27);
    measureFemale('R_UpLeg', 'hipRotation', 25);
    measureFemale('L_Forearm', 'elbowFlexion', 60, 3);
    measureFemale('R_Forearm', 'forearmRotation', 54);
    measureFemale('L_Hand', 'wristFlexion', 40);
    measureFemale('Spine_Lower', 'lateralTilt', 20);
    measureFemale('Spine_Upper', 'rotation', 25);
    measureFemale('Neck', 'rotation', 48);
    measureFemale('R_Shoulder', 'protraction', 20);
    measureFemale('L_Toes', 'toeFlexion', 40);
  });

  it('shoulder world-frame readout is variant-independent (flexion 90 / abduction 45 / rotation ±30)', () => {
    measureFemale('L_UpperArm', 'shoulderFlexion', 90);
    measureFemale('R_UpperArm', 'shoulderFlexion', 45);
    measureFemale('L_UpperArm', 'shoulderAbduction', 45);
    measureFemale('R_UpperArm', 'shoulderRotation', 30);
    measureFemale('L_UpperArm', 'shoulderRotation', -30);
  });

  it('fingers use the FEMALE curve: commanded == measured across the whole ROM, both hands', () => {
    // The female rest hand posture differs, so the response curve differs — the
    // male table read several degrees off here. Same full-range walk as the male
    // rig, above each digit's own floor.
    const floor: Record<string, number> = {
      Thumb1: 22.6,
      Index1: 18.4,
      Mid1: 4.4,
      Ring1: 8.3,
      Pinky1: 19.5,
    };
    for (const digit of ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1'] as const)
      for (const side of ['L_', 'R_'] as const)
        for (let deg = Math.ceil(floor[digit]!) + 1; deg <= 160; deg += 3)
          measureFemale(`${side}${digit}`, 'fingerFlexion', deg, 2);
  });
});

// ── 4. The MIDDLE + DISTAL phalanges are mapped so a transform can reach them
//    and pose serialization carries their quats — and for NOTHING else. Same
//    contract as the eye bones (eyeGaze.test.ts), pinned the same way: mapping a
//    bone must not quietly enrol it in clinical machinery, or a digit's shape
//    bones start showing up as goniometry rows and getting ROM-clamped.

describe('finger phalanges are mapped WITHOUT joining any clinical machinery', () => {
  const PHALANGES = ['Thumb', 'Index', 'Mid', 'Ring', 'Pinky'].flatMap((d) =>
    ['L_', 'R_'].flatMap((s) => [`${s}${d}2`, `${s}${d}3`]),
  );

  it('no ROM row, no clamp strategy, no pose handle, no tracked bone', () => {
    for (const key of PHALANGES) {
      expect(ROM_JOINT_ROWS.some((j) => j.canonicalKey === key), `${key} ROM row`).toBe(false);
      expect(hasClampStrategy(key), `${key} clamp strategy`).toBe(false);
      expect(BODY_VARIANTS.male.poseRig.handles.some((h) => h.canonicalKey === key)).toBe(false);
      expect((DEFAULT_TRACKED_BONES as readonly string[]).includes(key), `${key} tracked`).toBe(
        false,
      );
    }
  });

  it('a baseline pose WITHOUT the phalanges degrades to single-bone, not to a third of the curl', () => {
    // The MCP share is only 35% of a digit's curl. Writing it before confirming
    // the PIP/DIP are writable would leave a caller-supplied partial pose driving
    // the digit at a third of what it asked for — silently, since the readout is
    // never consulted. It must fall back to the whole curl at the knuckle.
    const partial: CustomPose = { variant: 'male', bones: { R_Mid1: baselinePose.bones!.R_Mid1! } };
    const cmd = setJoint('R_Mid1', 'fingerFlexion', 90);
    const built = buildCommandPose(partial, cmd, 90, variantCfg, null, rest)!;
    expect(built).not.toBeNull();
    // No phalanx bones invented on a pose that did not carry them.
    expect(built.bones.R_Mid2).toBeUndefined();
    expect(built.bones.R_Mid3).toBeUndefined();
    // And the knuckle carries the FULL curl, matching what buildDelta alone builds.
    const full = new THREE.Quaternion(...(built.bones.R_Mid1 as [number, number, number, number]));
    const restQ = new THREE.Quaternion(...(baselinePose.bones!.R_Mid1 as [number, number, number, number]));
    const travelled = (2 * Math.acos(Math.min(1, Math.abs(restQ.clone().invert().multiply(full).w))) * 180) / Math.PI;
    // Whole-digit curl for a commanded 90 is ~84°; a 35% share would be ~29°.
    expect(travelled).toBeGreaterThan(60);
  });

  it('a startFrom:current CONTINUATION keeps the phalanx spread (the settle must not un-curl it)', () => {
    // buildSequencePoses eases bones the motion does not drive back toward
    // baseline. A digit's command targets only its MCP key, so a joint-key-only
    // notion of "driven" classifies the PIP/DIP as residuals and slerps the
    // spread away — leaving the knuckle carrying a curl calibrated for a spread
    // that is no longer there. Nothing else covers this: every other sequence
    // test starts from neutral, where the settle pass does not run at all.
    const base: CustomPose = {
      variant: 'male',
      bones: {
        R_Mid1: baselinePose.bones!.R_Mid1!,
        R_Mid2: baselinePose.bones!.R_Mid2!,
        R_Mid3: baselinePose.bones!.R_Mid3!,
      },
    };
    const motion = {
      id: 'curl',
      label: 'curl',
      startFrom: 'current' as const,
      keyframes: [0, 1].map((i) => ({
        label: `k${i}`,
        durationMs: 400,
        holdMs: 0,
        targets: [{ joint: 'R_Mid1', motion: 'fingerFlexion', targetDegrees: 90 }],
      })),
    };
    const resolvedSeq = resolveComposedMotion(motion as never, variantCfg);
    expect(resolvedSeq.status).toBe('ok');
    // A live pose whose phalanges sit away from baseline — what any prior finger
    // motion leaves behind, and what makes them look like residuals.
    const live: CustomPose = {
      variant: 'male',
      bones: { ...base.bones, R_Mid2: [0, 0, 0.3, 0.954], R_Mid3: [0, 0, 0.3, 0.954] },
    };
    const cont = buildSequencePoses(base, resolvedSeq as never, variantCfg, rest, {
      currentPose: live,
    } as never);
    const fresh = buildSequencePoses(base, resolvedSeq as never, variantCfg, rest);
    for (let i = 0; i < cont.poses.length; i += 1)
      for (const key of ['R_Mid2', 'R_Mid3'] as const) {
        const a = new THREE.Quaternion(...(cont.poses[i]!.bones[key] as [number, number, number, number]));
        const b = new THREE.Quaternion(...(fresh.poses[i]!.bones[key] as [number, number, number, number]));
        const off = (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;
        expect(off, `kf${i} ${key} continuation vs fresh`).toBeLessThan(1);
      }
  });

  it('a non-finite command never writes a NaN quaternion into the pose', () => {
    // buildComposedCommandPose takes raw target degrees with no resolveCommandTarget
    // gate in front of it; one NaN reaching the interpolation poisons the skeleton.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const built = buildComposedCommandPose(
        baselinePose,
        'R_Mid1',
        [{ motion: 'fingerFlexion', degrees: bad }],
        variantCfg,
        null,
        rest,
      )!;
      expect(built).not.toBeNull();
      for (const k of ['R_Mid1', 'R_Mid2', 'R_Mid3'] as const)
        for (const c of built.bones[k]!) expect(Number.isFinite(c), `${k} ${bad}`).toBe(true);
    }
  });

  it('but they ARE reachable and serializable — the reason they are mapped at all', () => {
    // A rotation written to an unmapped bone is silently dropped by
    // serializeCustomPose, which would desync live playback from its recording.
    for (const key of PHALANGES) expect(baselinePose.bones?.[key], key).toBeDefined();
  });

  it('fingerFlexion stays ONE composite per digit — the phalanges add no motions', () => {
    const vocab = listSupportedMovementCommands();
    for (const key of PHALANGES)
      expect(vocab.some((c) => c.joint === key), `${key} commandable`).toBe(false);
    expect(vocab.filter((c) => c.joint === 'R_Mid1').map((c) => c.motion)).toEqual([
      'fingerFlexion',
    ]);
  });
});
