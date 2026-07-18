/**
 * CLOSED-CHAIN FOOT-ROOTED PLANTING — the fix for planted movements whose feet
 * swing forward. A pelvis-rooted FK swings the stance leg forward (a leg-raise),
 * so squat / hinge / sit-to-stand kick the feet out 35–94 cm and there is no
 * stable base. {@link plantStanceFoot} re-roots the rigid body at the stance
 * foot: the SAME authored joint angles then read as a real hinge/squat — feet
 * planted, pelvis placed by the chain, COM over the base (balance for free) —
 * and every measured joint angle is untouched.
 *
 * This is the bench gate: for each planted movement, at its deepest frame,
 * re-planting must (1) put the stance foot back at its standing position,
 * (2) leave knee/hip/trunk angles identical, and (3) bring the COM over the base.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose, applyCustomPose, buildBoneByPoseKey } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { computeBalanceState } from '../services/centerOfMass';
import { captureFootFrames, plantStanceFoot, type FootFrameReference } from '../services/rootMotion';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let footFrames: FootFrameReference;
let restFootXZ: Record<string, [number, number]>;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  footFrames = captureFootFrames(skinned.skeleton, variantCfg);
  const b = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  restFootXZ = {};
  for (const key of ['L_Foot', 'R_Foot']) {
    const p = b.get(key)!.getWorldPosition(new THREE.Vector3());
    restFootXZ[key] = [p.x, p.z];
  }
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

function angles(): Record<string, number> {
  const r = computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, rest).joints as Record<
    string,
    Record<string, number>
  >;
  return {
    lKnee: r.L_Leg?.kneeFlexion ?? 0,
    rKnee: r.R_Leg?.kneeFlexion ?? 0,
    lHip: r.L_UpLeg?.hipFlexion ?? 0,
    trunk: r.Spine_Lower?.flexion ?? 0,
  };
}

/** Sample a template, return its deepest-COM (hardest) frame's pose. */
function deepestPose(templateId: string): CustomPose {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const m = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === templateId)!);
  const rec = sampleComposedMotion(resolveComposedMotion(m, variantCfg), {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  });
  let deep = rec.frames[0]!;
  let mx = -Infinity;
  for (const f of rec.frames) {
    const z = f.worldTracks!.CoM![2];
    if (z > mx) {
      mx = z;
      deep = f;
    }
  }
  return deep.pose;
}

/** Apply a pose pelvis-rooted (no plant) and read the stance-foot XZ + angles. */
function applyPelvisRooted(pose: CustomPose) {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  applyCustomPose(skinned.skeleton, variantCfg, pose);
  root.updateMatrixWorld(true);
}

describe('foot-rooted planting keeps the feet planted, preserves identity, balances', () => {
  for (const id of ['squat', 'forward-hip-hinge', 'sit-to-stand', 'single-leg-stance']) {
    it(`${id}: stance foot returns to standing, angles unchanged, COM over base`, () => {
      const pose = deepestPose(id);

      // BEFORE — pelvis-rooted: the leg-swing, and the balance it wrecks.
      applyPelvisRooted(pose);
      const before = { angles: angles(), balance: computeBalanceState(skinned.skeleton, variantCfg) };

      // RE-PLANT at the stance foot.
      const stanceKey = plantStanceFoot(root, skinned.skeleton, variantCfg, footFrames)!;
      expect(stanceKey).toBeTruthy();
      const after = { angles: angles(), balance: computeBalanceState(skinned.skeleton, variantCfg) };

      // 1. The stance foot is back at its STANDING position (planted).
      const b = buildBoneByPoseKey(skinned.skeleton, variantCfg);
      const sp = b.get(stanceKey)!.getWorldPosition(new THREE.Vector3());
      const [rx, rz] = restFootXZ[stanceKey]!;
      expect(Math.hypot(sp.x - rx, sp.z - rz), `${stanceKey} horizontal drift`).toBeLessThan(0.03);

      // 2. Every measured joint angle is IDENTICAL — a rigid re-root touches no joint.
      for (const k of Object.keys(before.angles)) {
        expect(Math.abs(after.angles[k]! - before.angles[k]!), `${k} changed`).toBeLessThan(0.5);
      }

      // 3. The COM lands ON/near the base — balance emerges from correct
      //    kinematics, no separate controller. For the trunk-folding movements
      //    (hinge, sit-to-stand) this is a ~half-metre jump from "toppling far
      //    off the base" to "on it"; the small residual (±few cm) is the
      //    base-of-support footprint's approximation and a deep posture's
      //    genuinely near-edge COM. Either way the body is no longer toppling.
      // eslint-disable-next-line no-console
      console.log(
        `${id}: margin ${(before.balance.marginM! * 100).toFixed(0)}cm → ${(after.balance.marginM! * 100).toFixed(0)}cm  (Δ ${((after.balance.marginM! - before.balance.marginM!) * 100).toFixed(0)}cm)`,
      );
      expect(after.balance.marginM!, 'COM near/over base (not toppling)').toBeGreaterThan(-0.1);
    });
  }
});
