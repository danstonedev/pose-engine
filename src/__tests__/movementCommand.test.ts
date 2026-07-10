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
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  clearRomScenarioConstraints,
  setRomScenarioConstraints,
} from '../services/romConstraints';
import {
  buildCommandPose,
  finalizeOutcome,
  isMovementCommandSupported,
  listSupportedMovementCommands,
  measureCommandMotion,
  resolveCommandTarget,
  type ExamMovementCommand,
} from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;

const setJoint = (
  joint: string,
  motion: string,
  targetDegrees: number,
): ExamMovementCommand => ({ action: 'set-joint', joint, motion, targetDegrees });

afterEach(() => {
  clearRomScenarioConstraints();
});

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

  describe('scenario constraints clamp tighter than normative', () => {
    it('modifies at the scenario cap (dorsi 10 → 5, scenario-constraint)', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { availableRange: { min: -30, max: 5 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg);
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(5);
      expect(r.limitedBy).toBe('scenario-constraint');
    });

    it('modifies at the scenario floor (plantar −40 → −30, scenario-constraint)', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { availableRange: { min: -30, max: 5 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -40), variantCfg);
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(-30);
      expect(r.limitedBy).toBe('scenario-constraint');
    });

    it('leaves the unconstrained side of the joint on the normative bound', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { availableRange: { max: 5 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -60), variantCfg);
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(-50); // normative plantar floor still applies
      expect(r.limitedBy).toBe('normative-rom');
    });
  });

  describe('refusal rule: achievable travel < 20% of requested (from neutral)', () => {
    it('refuses dorsiflexion when the available range never crosses neutral', () => {
      // Ankle stuck plantar: can move only between −30 and −5.
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { availableRange: { min: -30, max: -5 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg);
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('no-achievable-travel');
      expect(r.limitedBy).toBe('scenario-constraint');
      expect(r.clampedDegrees).toBeUndefined();
    });

    it('still moves at exactly 20% achievable travel (cap 2 on a 10° request)', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { availableRange: { max: 2 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg);
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(2);
    });

    it('refuses just under the threshold (cap 1.9 on a 10° request)', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { availableRange: { max: 1.9 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 10), variantCfg);
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('no-achievable-travel');
    });

    it('never refuses a return-to-neutral target — settles at the nearest bound', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { availableRange: { min: -30, max: -5 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', 0), variantCfg);
      expect(r.status).toBe('modified'); // NOT refused
      expect(r.clampedDegrees).toBe(-5);
    });
  });

  describe('painful arc', () => {
    it('flags a compliant target inside the authored painful arc', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { painfulArc: { min: -20, max: -5 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -10), variantCfg);
      expect(r.status).toBe('complied');
      expect(r.painful).toBe(true);
    });

    it('does not flag a target outside the arc', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { painfulArc: { min: -20, max: -5 } } },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -2), variantCfg);
      expect(r.status).toBe('complied');
      expect(r.painful).toBe(false);
    });

    it('flags a MODIFIED target whose clamp lands inside the arc', () => {
      setRomScenarioConstraints({
        R_Foot: {
          ankleFlexion: {
            availableRange: { min: -20, max: 20 },
            painfulArc: { min: -20, max: -15 },
          },
        },
      });
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -45), variantCfg);
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

    it('refuses a registry-valid but v1-unsupported motion (ankle inversion)', () => {
      const r = resolveCommandTarget(setJoint('R_Foot', 'ankleInversion', 10), variantCfg);
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

    it('exposes exactly the documented vocabulary (v1 hinges + v1.1 lumbar + v1.3 quarter + v1.4 hip)', () => {
      const list = listSupportedMovementCommands()
        .map((c) => `${c.joint}.${c.motion}`)
        .sort();
      expect(list).toEqual([
        'L_Foot.ankleFlexion',
        'L_Forearm.elbowFlexion',
        'L_Leg.kneeFlexion',
        'L_UpLeg.hipAbduction',
        'L_UpLeg.hipFlexion',
        'L_UpLeg.hipRotation',
        'L_UpperArm.shoulderAbduction',
        'Neck.flexion',
        'Neck.lateralTilt',
        'Neck.rotation',
        'R_Foot.ankleFlexion',
        'R_Forearm.elbowFlexion',
        'R_Leg.kneeFlexion',
        'R_UpLeg.hipAbduction',
        'R_UpLeg.hipFlexion',
        'R_UpLeg.hipRotation',
        'R_UpperArm.shoulderAbduction',
        'Spine_Lower.flexion',
        'Spine_Lower.lateralTilt',
        'Spine_Lower.rotation',
      ]);
      expect(isMovementCommandSupported('R_Foot', 'ankleFlexion')).toBe(true);
      expect(isMovementCommandSupported('R_UpLeg', 'hipFlexion')).toBe(true);
      expect(isMovementCommandSupported('R_UpLeg', 'hipAbduction')).toBe(true);
      expect(isMovementCommandSupported('L_UpLeg', 'hipRotation')).toBe(true);
      expect(isMovementCommandSupported('Spine_Lower', 'lateralTilt')).toBe(true);
      expect(isMovementCommandSupported('Neck', 'rotation')).toBe(true);
      // Shoulder FLEXION stays withheld (readout long-axis degeneracy — see spec).
      expect(isMovementCommandSupported('R_UpperArm', 'shoulderFlexion')).toBe(false);
      expect(isMovementCommandSupported('R_Foot', 'ankleInversion')).toBe(false);
    });

    it('refuses shoulder flexion as unsupported in v1 (real-rig frame not yet calibrated)', () => {
      for (const joint of ['L_UpperArm', 'R_UpperArm']) {
        const r = resolveCommandTarget(setJoint(joint, 'shoulderFlexion', 60), variantCfg);
        expect(r.status).toBe('refused');
        expect(r.reason).toBe('unsupported-motion');
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
      setRomScenarioConstraints({
        Spine_Lower: {
          flexion: {
            availableRange: { min: -18, max: 32 },
            painfulArc: { min: 24, max: 32 },
          },
        },
      });
      const r = resolveCommandTarget(setJoint('Spine_Lower', 'flexion', 45), variantCfg);
      expect(r.status).toBe('modified');
      expect(r.clampedDegrees).toBe(32);
      expect(r.limitedBy).toBe('scenario-constraint');
      expect(r.painful).toBe(true);
    });
  });

  describe('finalizeOutcome', () => {
    it('prefers the measured achieved angle and re-evaluates pain against it', () => {
      setRomScenarioConstraints({
        R_Foot: { ankleFlexion: { painfulArc: { min: -20, max: -5 } } },
      });
      const resolved = resolveCommandTarget(setJoint('R_Foot', 'ankleFlexion', -2), variantCfg);
      expect(resolved.painful).toBe(false);
      // Suppose the settled skeleton measured −6.1° (inside the arc).
      const outcome = finalizeOutcome(resolved, -6.1);
      expect(outcome.achievedDegrees).toBe(-6.1);
      expect(outcome.painful).toBe(true);
      expect(outcome.status).toBe('complied');
      expect(outcome.joint).toBe('R_Foot');
      expect(outcome.requestedDegrees).toBe(-2);
    });

    it('carries refusal metadata through without an achieved angle', () => {
      const resolved = resolveCommandTarget(setJoint('R_Foot', 'ankleInversion', 10), variantCfg);
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
    setRomScenarioConstraints({
      R_Foot: { ankleFlexion: { availableRange: { min: -30, max: 5 } } },
    });
    const cmd = setJoint('R_Foot', 'ankleFlexion', 15);
    const resolved = resolveCommandTarget(cmd, variantCfg);
    expect(resolved.status).toBe('modified');
    expect(resolved.clampedDegrees).toBe(5);
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
    const report = applyAndMeasure(pose);
    const achieved = measureCommandMotion(report, 'R_Foot', 'ankleFlexion')!;
    expect(Math.abs(achieved - 5)).toBeLessThan(2);
    const outcome = finalizeOutcome(resolved, achieved);
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
    setRomScenarioConstraints({
      Spine_Lower: {
        flexion: { availableRange: { min: -18, max: 32 }, painfulArc: { min: 24, max: 32 } },
      },
    });
    const cmd = setJoint('Spine_Lower', 'flexion', 45);
    const resolved = resolveCommandTarget(cmd, variantCfg);
    expect(resolved.status).toBe('modified');
    const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
    const report = applyAndMeasure(pose);
    const achieved = measureCommandMotion(report, 'Spine_Lower', 'flexion')!;
    expect(Math.abs(achieved - 32)).toBeLessThan(2);
    const outcome = finalizeOutcome(resolved, achieved);
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

  it('shoulder abduction: 60° raises the arm laterally within ±2° (both sides)', () => {
    for (const [armKey, handKey] of [
      ['R_UpperArm', 'R_Hand'],
      ['L_UpperArm', 'L_Hand'],
    ] as const) {
      resetToAnatomic();
      const handBefore = boneLookup.get(handKey)!.getWorldPosition(new THREE.Vector3());
      const cmd = setJoint(armKey, 'shoulderAbduction', 60);
      const resolved = resolveCommandTarget(cmd, variantCfg);
      expect(resolved.status).toBe('complied');
      const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
      const report = applyAndMeasure(pose);
      expect(Math.abs(measureCommandMotion(report, armKey, 'shoulderAbduction')! - 60)).toBeLessThan(2);
      expect(Math.abs(report.joints[armKey].shoulderRotation)).toBeLessThan(5);
      // The hand rises as the arm lifts away from the side.
      const handAfter = boneLookup.get(handKey)!.getWorldPosition(new THREE.Vector3());
      expect(handAfter.y).toBeGreaterThan(handBefore.y);
    }
  });

  it('shoulder FLEXION stays refused — no supported spec (readout long-axis degeneracy)', () => {
    expect(isMovementCommandSupported('R_UpperArm', 'shoulderFlexion')).toBe(false);
    expect(isMovementCommandSupported('L_UpperArm', 'shoulderFlexion')).toBe(false);
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
      setJoint('R_Foot', 'ankleInversion', 10),
      10,
      variantCfg,
    );
    expect(pose).toBeNull();
  });
});
