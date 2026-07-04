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

    it('exposes exactly the documented v1 vocabulary', () => {
      const list = listSupportedMovementCommands()
        .map((c) => `${c.joint}.${c.motion}`)
        .sort();
      expect(list).toEqual([
        'L_Foot.ankleFlexion',
        'L_Leg.kneeFlexion',
        'R_Foot.ankleFlexion',
        'R_Leg.kneeFlexion',
      ]);
      expect(isMovementCommandSupported('R_Foot', 'ankleFlexion')).toBe(true);
      expect(isMovementCommandSupported('R_Foot', 'ankleInversion')).toBe(false);
    });

    it('refuses shoulder flexion as unsupported in v1 (real-rig frame not yet calibrated)', () => {
      for (const joint of ['L_UpperArm', 'R_UpperArm']) {
        const r = resolveCommandTarget(setJoint(joint, 'shoulderFlexion', 60), variantCfg);
        expect(r.status).toBe('refused');
        expect(r.reason).toBe('unsupported-motion');
      }
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
    for (const [legKey, footKey] of [
      ['R_Leg', 'R_Foot'],
      ['L_Leg', 'L_Foot'],
    ] as const) {
      resetToAnatomic();
      const footBefore = boneLookup.get(footKey)!.getWorldPosition(new THREE.Vector3());
      const cmd = setJoint(legKey, 'kneeFlexion', 30);
      const resolved = resolveCommandTarget(cmd, variantCfg);
      expect(resolved.status).toBe('complied');
      const pose = buildCommandPose(baselinePose, cmd, resolved.clampedDegrees!, variantCfg)!;
      const report = applyAndMeasure(pose);
      // Anatomic knee flexion carries the foot POSTERIOR (world +Z; the
      // mannequin faces −Z), not sideways/anterior — locks the motion-axis
      // direction on the real rig, which the readout alone can't (the
      // geometric hinge magnitude is direction-blind).
      const footAfter = boneLookup.get(footKey)!.getWorldPosition(new THREE.Vector3());
      expect(footAfter.z - footBefore.z).toBeGreaterThan(0.05);
      expect(Math.abs(footAfter.x - footBefore.x)).toBeLessThan(0.05);
      const achieved = measureCommandMotion(report, legKey, 'kneeFlexion')!;
      expect(Math.abs(achieved - 30)).toBeLessThan(2);
      // Off-axis leakage stays negligible (clean hinge motion).
      expect(Math.abs(report.joints[legKey].kneeDeviation)).toBeLessThan(1);
      expect(Math.abs(report.joints[legKey].kneeRotation)).toBeLessThan(1);
    }
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
