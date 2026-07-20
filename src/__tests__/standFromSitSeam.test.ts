/**
 * STAND-FROM-SIT PIN-SWAP SEAM (SEAM-5) — rig-gated.
 *
 * Sit-to-stand swaps the primary grounding pin pelvis→feet at a pose where the
 * two solutions disagree by ~10 cm: the sit-DOWN direction was tuned seam-free
 * (SEAT_HEIGHT_M places the seated pelvis where the foot-grounded flex puts
 * it), but the stand-UP direction swapped at the lean-forward pose and hopped
 * the pelvis 9.94 cm in ONE frame. The fix is the grounding-switch root-Y
 * crossfade (rootMotion.deriveGroundingBlendSpans): a ~200 ms eased window
 * centered on the swap keyframe blends the outgoing (seat) and incoming (feet)
 * pin solutions — NOT a SEAT_HEIGHT_M retune, which would break the tuned
 * sit-down direction.
 *
 * Rig gates (60 Hz, both directions chained so stand-up starts from the real
 * seated pose):
 *   1. stand-up max root-Y per-frame delta < 3 cm/frame (was 9.94)
 *   2. sit-down stays within epsilon of its pre-fix per-frame root-Y trace
 *      (fixtures/sitDownRootY.baseline.json — captured on origin/main BEFORE
 *      the crossfade landed), protecting the tuned direction; and its old
 *      residual −2.06 cm swap step is now smoothed too.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { sampleMotionChain } from '../services/movementChain';
import { buildSitDown, buildStandFromSit } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { MotionRecording } from '../services/motionRecording';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
const BASELINE_URL = new URL('./fixtures/sitDownRootY.baseline.json', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;

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
});

function sampleBothDirections(): [MotionRecording, MotionRecording] {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const chain = sampleMotionChain([buildSitDown(), buildStandFromSit()], {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
    trackedBones: ['Hips', 'Head', 'L_Foot', 'R_Foot', 'L_Toes', 'R_Toes'],
  });
  expect(chain.map((c) => c.status)).toEqual(['ok', 'ok']);
  return [chain[0]!.recording, chain[1]!.recording];
}

/** Largest single-frame |Δ| of root-Y (m) across the recording. */
function maxRootDeltaPerFrame(rec: MotionRecording): number {
  let max = 0;
  for (let i = 1; i < rec.frames.length; i += 1) {
    max = Math.max(
      max,
      Math.abs(rec.frames[i]!.root.translateM[1] - rec.frames[i - 1]!.root.translateM[1]),
    );
  }
  return max;
}

describe('SEAM-5 rig gates — sit-to-stand pin swap, both directions', () => {
  it('stand-up: the pelvis→feet swap no longer hops (max ΔY < 3 cm/frame; was 9.94)', () => {
    const [, standUp] = sampleBothDirections();
    const maxDelta = maxRootDeltaPerFrame(standUp);
    // eslint-disable-next-line no-console
    console.log(`stand-up max root-Y delta: ${(maxDelta * 100).toFixed(2)} cm/frame`);
    expect(maxDelta, 'stand-up root-Y per-frame delta < 3 cm').toBeLessThan(0.03);
  });

  it('sit-down: the tuned direction stays within epsilon of its pre-fix trace', () => {
    const [sitDown] = sampleBothDirections();
    const baseline = JSON.parse(readFileSync(fileURLToPath(BASELINE_URL), 'utf8')) as {
      sampleHz: number;
      rootY: number[];
    };
    expect(sitDown.sampleHz).toBe(baseline.sampleHz);
    expect(sitDown.frames.length).toBe(baseline.rootY.length);

    let maxDev = 0;
    for (let i = 0; i < sitDown.frames.length; i += 1) {
      maxDev = Math.max(maxDev, Math.abs(sitDown.frames[i]!.root.translateM[1] - baseline.rootY[i]!));
    }
    // eslint-disable-next-line no-console
    console.log(`sit-down max deviation vs pre-fix trace: ${(maxDev * 100).toFixed(2)} cm`);
    // EPSILON 2.5 cm, justified: the measured deviation (2.03 cm) peaks at the
    // exact instant of the old −2.06 cm swap step — it IS that step being
    // crossfaded away (plus the weighted-descent re-derivation reading the now
    // step-free arc). Everywhere the tuning matters the trace is preserved:
    // same descent path, same seated pin.
    expect(maxDev, 'sit-down root-Y within 2.5 cm of its tuned pre-fix trace').toBeLessThan(0.025);
    // The settled seated height is byte-close to the tuned baseline.
    expect(
      Math.abs(sitDown.frames.at(-1)!.root.translateM[1] - baseline.rootY.at(-1)!),
      'final seated height unchanged',
    ).toBeLessThan(1e-3);
    // And the direction is now smoother than it was: its own residual swap
    // step (2.06 cm in one frame on main) is blended under 1.5 cm/frame.
    expect(
      maxRootDeltaPerFrame(sitDown),
      'sit-down per-frame root-Y smoother than the pre-fix step',
    ).toBeLessThan(0.015);
  });
});
