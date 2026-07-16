/**
 * FOOT CONTACT / IK PLANT GATE (simMOVE Phase 3) — proves closed-chain ground
 * contact on the real rig: a forward step travels the body +Z while the IK-pinned
 * stance foot stays put (no moonwalk slide), and the swing foot still advances.
 * Without the plant the stance foot slides the full travel distance — the
 * contrast that makes the gate non-vacuous.
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
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { buildFootPlant, measureContactSlide } from '../services/footContact';
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

/** sampleComposedMotion captures the CURRENT root transform as its rest, so the
 *  harness root must be reset to the grounded origin before each independent
 *  sample (else consecutive samples accumulate the prior travel). */
function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

const STEP_M = 0.3;
const forwardStep = (startFrom: 'neutral' | 'current' = 'neutral'): ComposedMotion => ({
  name: 'forward step',
  stance: 'planted',
  startFrom,
  keyframes: [
    {
      durationMs: 800,
      travel: { direction: 'forward', meters: STEP_M },
      targets: [
        { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 25 },
        { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 30 },
      ],
    },
  ],
});

function sample(contacts?: { foot: string }[], startFrom: 'neutral' | 'current' = 'neutral', cont?: { currentPose: CustomPose; currentRoot: { quat?: [number, number, number, number]; translateM?: [number, number, number] } }): MotionRecording {
  resetHarness();
  const resolved = resolveComposedMotion(forwardStep(startFrom), variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
    ...(contacts ? { contacts } : {}),
    ...(cont ?? {}),
  });
}
const hipsDz = (rec: MotionRecording) =>
  rec.frames[rec.frames.length - 1]!.worldTracks!['Hips']![2] - rec.frames[0]!.worldTracks!['Hips']![2];
const footZ = (rec: MotionRecording, i: number) => rec.frames[i]!.worldTracks!['L_Foot']![2];

describe('IK foot plant keeps the stance foot from sliding during travel', () => {
  it('without a plant, the stance foot slides the full travel distance (moonwalk)', () => {
    const slide = measureContactSlide(sample(), 'L_Foot');
    expect(slide.horizontalM).toBeGreaterThan(0.25); // ≈ the 0.3 m travel
  });

  it('with a plant, the stance foot stays put while the body still travels forward', () => {
    const noPlant = measureContactSlide(sample(), 'L_Foot').horizontalM;
    const rec = sample([{ foot: 'L_Foot' }]);
    const slide = measureContactSlide(rec, 'L_Foot');
    // The pinned foot barely moves horizontally…
    expect(slide.horizontalM).toBeLessThan(0.08);
    // …far less than the un-pinned slide (the plant did the work)…
    expect(slide.horizontalM).toBeLessThan(noPlant * 0.25);
    // …the foot's VERTICAL float stays bounded (best-effort: a straight stance
    // leg lifts a little as the pelvis travels — gated so it stays honest)…
    expect(slide.verticalM).toBeLessThan(0.12);
    // …and the body still travelled forward (+Z, facing-relative)…
    expect(hipsDz(rec)).toBeGreaterThan(0.25);
    // …and the SWING foot still advanced (the plant didn't freeze the body).
    const rFootDz = rec.frames[rec.frames.length - 1]!.worldTracks!['R_Foot']![2] - rec.frames[0]!.worldTracks!['R_Foot']![2];
    expect(rFootDz).toBeGreaterThan(0.25);
  });

  it('a plant on a startFrom:current continuation pins the foot where it IS, not the baseline (red-team #1)', () => {
    // Advance the body with a first step, then run a CONTINUATION step. The plant
    // must capture the foot at its true frame-0 position — so at frame 0 the
    // pinned foot matches the un-pinned foot (no teleport to a stale baseline).
    const first = sample();
    const end = first.frames[first.frames.length - 1]!;
    const contRoot = { currentPose: end.pose, currentRoot: { quat: end.root.orientQuat, translateM: end.root.translateM } };
    const noPin = sample(undefined, 'current', contRoot);
    const pinned = sample([{ foot: 'L_Foot' }], 'current', contRoot);
    // Frame 0 with the plant equals frame 0 without it (the plant didn't yank the
    // foot); the old baseline-capture bug made these differ by ~0.4 m.
    expect(Math.abs(footZ(pinned, 0) - footZ(noPin, 0))).toBeLessThan(0.02);
  });
});

describe('measureContactSlide + buildFootPlant units', () => {
  it('reports ~0 horizontal slide for a planted track and the drift for a sliding one', () => {
    const planted = { frames: [
      { tMs: 0, worldTracks: { L_Foot: [0.1, 0.05, 0.2] as [number, number, number] } },
      { tMs: 100, worldTracks: { L_Foot: [0.1, 0.06, 0.2] as [number, number, number] } },
    ] };
    const sliding = { frames: [
      { tMs: 0, worldTracks: { L_Foot: [0.1, 0.05, 0.2] as [number, number, number] } },
      { tMs: 100, worldTracks: { L_Foot: [0.1, 0.05, 0.5] as [number, number, number] } },
    ] };
    expect(measureContactSlide(planted, 'L_Foot').horizontalM).toBeLessThan(1e-6);
    expect(measureContactSlide(sliding, 'L_Foot').horizontalM).toBeCloseTo(0.3, 5);
  });

  it('buildFootPlant returns null for an unknown foot key', () => {
    expect(buildFootPlant(skinned, 'Not_A_Foot', variantCfg)).toBeNull();
    expect(buildFootPlant(skinned, 'L_Foot', variantCfg)).not.toBeNull();
  });
});
