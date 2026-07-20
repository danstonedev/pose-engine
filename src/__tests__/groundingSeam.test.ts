/**
 * GROUNDING-SWITCH SEAM (SEAM-4) — get-down to plank / quadruped, rig-gated.
 *
 * Pipeline diagnostics (docs/pipeline-diagnostics.md) measured three
 * compounding failures on the get-down transitions:
 *   - the discrete grounding-mode/pin switch free-fell the root 53 cm in ONE
 *     frame (quadruped get-down),
 *   - the feet swept 0.5 m BELOW the floor mid-transition (the incoming
 *     knee/toe pin applied while the body was still upright),
 *   - the arms swept the wrong way then snapped 168° in <10 ms (ill-conditioned
 *     SQUAD tangents + the unblended multi-pass hand-reach engagement).
 *
 * The fixes: the SQUAD tangent clamp (motionTrajectory — squadTangentClamp
 * .test.ts), the grounding-switch root-Y crossfade (rootMotion
 * .deriveGroundingBlendSpans — the outgoing feet pin governs the transition
 * segment; the incoming limb pin ramps in over the last ~200 ms into the
 * posture keyframe), and the eased hand-reach engagement weight
 * (rootMotion.handReachWeightAt + footContact.solveHandReach).
 *
 * Rig gates (sampled headlessly at 60 Hz on the real GLB):
 *   1. max root-Y per-frame drop < 8 cm/frame   (was 53 cm/frame; now ~2.7)
 *   2. no foot bone below floor − 5 cm ever     (was −50 cm; now ~−2.6)
 *   3. hand/forearm world rotation < 45°/frame  (was ~168°/<10 ms; now ~22)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose, applyCustomPose, buildBoneByPoseKey } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { captureFloorReference } from '../services/rootMotion';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import {
  buildGetDownToPlank,
  buildGetDownToQuadruped,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let floorY = 0;

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
  floorY = captureFloorReference(skinned.skeleton, variantCfg).floorY;
});

const FOOT_KEYS = ['L_Foot', 'R_Foot', 'L_Toes', 'R_Toes'] as const;
const ARM_KEYS = ['L_Hand', 'R_Hand', 'L_Forearm', 'R_Forearm'] as const;

function sampleGetDown(build: () => ReturnType<typeof buildGetDownToPlank>): MotionRecording {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(build(), variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
    trackedBones: ['Hips', 'Head', ...ARM_KEYS, ...FOOT_KEYS],
  });
}

/** Largest single-frame DROP of root-Y (m) across the recording. */
function maxRootDropPerFrame(rec: MotionRecording): number {
  let maxDrop = 0;
  for (let i = 1; i < rec.frames.length; i += 1) {
    maxDrop = Math.max(
      maxDrop,
      rec.frames[i - 1]!.root.translateM[1] - rec.frames[i]!.root.translateM[1],
    );
  }
  return maxDrop;
}

/** Lowest world-Y (m) any foot bone reaches across the recording. */
function minFootY(rec: MotionRecording): number {
  let min = Infinity;
  for (const f of rec.frames) {
    for (const k of FOOT_KEYS) {
      const p = f.worldTracks?.[k];
      if (p) min = Math.min(min, p[1]);
    }
  }
  return min;
}

/**
 * Max per-frame WORLD rotation (deg) across the hand/forearm bones,
 * reconstructed by re-applying each recorded frame (pose incl. any IK'd arm +
 * root state) to the harness — worldTracks carry positions only.
 */
function maxArmWorldRotPerFrame(rec: MotionRecording): number {
  const rootRestPos = root.position.clone();
  const rootRestQuat = root.quaternion.clone();
  const boneByKey = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  const prevQ = new Map<string, THREE.Quaternion>();
  const q = new THREE.Quaternion();
  const rq = new THREE.Quaternion();
  let maxDeg = 0;
  for (const f of rec.frames) {
    applyCustomPose(skinned.skeleton, variantCfg, f.pose);
    rq.set(f.root.orientQuat[0], f.root.orientQuat[1], f.root.orientQuat[2], f.root.orientQuat[3]);
    root.quaternion.copy(rootRestQuat).multiply(rq);
    root.position.set(
      rootRestPos.x + f.root.translateM[0],
      rootRestPos.y + f.root.translateM[1],
      rootRestPos.z + f.root.translateM[2],
    );
    root.updateMatrixWorld(true);
    for (const k of ARM_KEYS) {
      const b = boneByKey.get(k);
      if (!b) continue;
      b.getWorldQuaternion(q);
      const p = prevQ.get(k);
      if (p) {
        const dot = Math.min(1, Math.abs(p.dot(q)));
        maxDeg = Math.max(maxDeg, (2 * Math.acos(dot) * 180) / Math.PI);
      }
      prevQ.set(k, q.clone());
    }
  }
  root.position.copy(rootRestPos);
  root.quaternion.copy(rootRestQuat);
  root.updateMatrixWorld(true);
  return maxDeg;
}

describe('SEAM-4 rig gates — get-down transitions are seam-free', () => {
  for (const [name, build] of [
    ['get into a plank', buildGetDownToPlank],
    ['get onto hands and knees', buildGetDownToQuadruped],
  ] as const) {
    it(`${name}: no root free-fall, feet never below the floor, no arm snap`, () => {
      const rec = sampleGetDown(build);
      expect(rec.frames.length).toBeGreaterThan(30);

      const drop = maxRootDropPerFrame(rec);
      const footMin = minFootY(rec) - floorY;
      const armRot = maxArmWorldRotPerFrame(rec);
      // eslint-disable-next-line no-console
      console.log(
        `${name}: rootDrop ${(drop * 100).toFixed(2)}cm/frame · minFoot ${(footMin * 100).toFixed(2)}cm vs floor · armRot ${armRot.toFixed(1)}°/frame`,
      );

      // 1. The grounding switch no longer free-falls the root (was 53 cm/frame).
      expect(drop, 'max root-Y per-frame drop < 8 cm').toBeLessThan(0.08);
      // 2. No foot bone ever sweeps below floor − 5 cm (was −50 cm).
      expect(footMin, 'feet never below floor − 5 cm').toBeGreaterThan(-0.05);
      // 3. No hand/forearm world snap (was ~168°/frame): SQUAD clamp + eased
      //    hand-reach engagement keep every arm frame under 45°/frame.
      expect(armRot, 'hand/forearm world rotation < 45°/frame').toBeLessThan(45);
    });
  }
});
