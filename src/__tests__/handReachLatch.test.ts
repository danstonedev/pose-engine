/**
 * THE HAND-REACH LATCH DOES NOT DEPEND ON WHICH FRAMES RAN — on the real rig.
 *
 * A floor reach (plank, push-up, quadruped, bird-dog) pulls a descending hand
 * to the floor and latches the point where it gets there, so the hand then
 * stays put while the body lowers over it. The latch took the first FRAME
 * whose pulled hand was inside the 3 cm floor band, so the planted point — and
 * every settled pose after it — moved with the sample rate: the plank from
 * quadruped settled 10.4 mm / 2.0° apart at 30 and 60 Hz, and the quadruped
 * from plank, press-up to quadruped and both get-downs 3.8–7.4 mm / 0.6–1.2°
 * apart at 30 and 120 Hz. It now interpolates the moment the hand crossed the
 * band between the evaluations either side of it (footContact.solveHandReach,
 * given the motion time), so 30, 60 and 120 Hz and an irregular clock like a
 * live stage's agree to the interpolation's own error.
 *
 * What still moves the latch is the PATH: it plants where the hand first
 * reaches the floor, so re-timing the arm between knots (motionStagger's
 * follow-through) still moves a hand-planted settle. That is the latch's
 * purpose — plant on contact, not at a point chosen mid-transition.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { DEFAULT_TRACKED_BONES, sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import {
  buildBirdDog,
  buildGetDownToPlank,
  buildGetDownToQuadruped,
  buildPlankFromQuadruped,
  buildPressUpToQuadruped,
  buildPushUp,
  buildQuadrupedFromPlank,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
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
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

const TRACKED = [...new Set([...DEFAULT_TRACKED_BONES, 'L_Hand', 'R_Hand'])];
const ARM = ['L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm', 'L_Hand', 'R_Hand'];

function record(motion: () => ComposedMotion, sampleHz: number, frameTimesMs?: number[]): MotionRecording {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(motion(), variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz,
    trackedBones: TRACKED,
    ...(frameTimesMs ? { frameTimesMs } : {}),
  });
}

/** A stage-like clock: steps of 8–40 ms from a fixed seed, plus every 30 Hz
 *  frame time (so the recordings share frames to compare). */
function jitteredClock(totalMs: number, grid: readonly number[]): number[] {
  let s = 12345;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const times = new Set<number>(grid);
  for (let t = 0; t < totalMs; t += 8 + next() * 32) times.add(Math.round(t * 1000) / 1000);
  return [...times].sort((a, b) => a - b);
}

describe('the hand-reach latch plants where the hand reached the floor, whichever frames ran', () => {
  for (const [name, motion] of [
    ['plank from quadruped', buildPlankFromQuadruped],
    ['quadruped from plank', buildQuadrupedFromPlank],
    ['press-up to quadruped', buildPressUpToQuadruped],
    ['get down to quadruped', buildGetDownToQuadruped],
    ['get down to plank', buildGetDownToPlank],
    ['push-up', buildPushUp],
    ['bird dog', buildBirdDog],
  ] as const) {
    it(`${name}: at 30, 60 and 120 Hz and on a jittered clock every shared frame plants the hands within 1 mm, the arms within 0.5° (10.4 mm / 2.0° at worst before)`, () => {
      const base = record(motion, 30);
      const grid = base.frames.map((f) => f.tMs);
      const totalMs = grid[grid.length - 1]!;
      const others: [string, MotionRecording][] = [
        ['60 Hz', record(motion, 60)],
        ['120 Hz', record(motion, 120)],
        ['jittered', record(motion, 30, jitteredClock(totalMs, grid))],
      ];
      const qa = new THREE.Quaternion();
      const qb = new THREE.Quaternion();
      for (const [label, rec] of others) {
        let hand = 0;
        let arm = 0;
        let shared = 0;
        for (const f of base.frames) {
          const g = rec.frames.find((x) => Math.abs(x.tMs - f.tMs) < 1e-6);
          if (!g) continue;
          shared += 1;
          for (const key of ['L_Hand', 'R_Hand']) {
            const a = f.worldTracks![key]!;
            const b = g.worldTracks![key]!;
            hand = Math.max(hand, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
          }
          for (const key of ARM) {
            const a = f.pose.bones[key]!;
            const b = g.pose.bones[key]!;
            arm = Math.max(arm, (qa.set(a[0], a[1], a[2], a[3]).angleTo(qb.set(b[0], b[1], b[2], b[3])) * 180) / Math.PI);
          }
        }
        // eslint-disable-next-line no-console
        console.log(`${name}, 30 Hz vs ${label}: ${shared} shared frames, hands within ${(hand * 1000).toFixed(2)} mm, arms within ${arm.toFixed(3)}°`);
        expect(shared, `${label} shares every 30 Hz frame`).toBe(base.frames.length);
        expect(hand, `${name}: hands, 30 Hz vs ${label} (m)`).toBeLessThan(0.001);
        expect(arm, `${name}: arm joints, 30 Hz vs ${label} (°)`).toBeLessThan(0.5);
      }
    }, 120_000);
  }
});
