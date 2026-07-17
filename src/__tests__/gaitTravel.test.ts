/**
 * TRAVEL-GAIT GATE — buildTravelWalk advances the body forward with GROUND-TRUE
 * feet: the same authored 8-phase walk kinematics + cumulative +Z root travel +
 * ALTERNATING stance-foot contacts. Each stance foot stays world-planted while
 * the body passes over it (no moonwalk), the swing foot advances, and the whole
 * thing is a non-degenerate gait. This is the consumer that makes the live-stage
 * foot IK (Finding 4) visible.
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
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { measureContactSlide } from '../services/footContact';
import { buildTravelWalk } from '../services/movementTemplates';
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

/** The sampler captures the current root as its rest, so reset to origin before
 *  each sample (else consecutive samples accumulate the prior travel). */
function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

function sampleTravel(withContacts = true): MotionRecording {
  resetHarness();
  const motion = buildTravelWalk();
  // Prove the contrast: sample with the motion's declared contacts (default) or
  // with contacts explicitly disabled.
  const resolved = resolveComposedMotion(withContacts ? motion : { ...motion, contacts: [] }, variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
  });
}

const hipsDz = (rec: MotionRecording) =>
  rec.frames[rec.frames.length - 1]!.worldTracks!['Hips']![2] - rec.frames[0]!.worldTracks!['Hips']![2];

describe('buildTravelWalk — a non-degenerate forward gait', () => {
  it('is the full 8-phase cycle, planted, non-looping, with alternating contacts', () => {
    const m = buildTravelWalk();
    expect(m.keyframes.length).toBe(8);
    expect(m.loop ?? false).toBe(false); // travel can't loop (would teleport)
    expect(m.stance).toBe('planted');
    expect(m.contacts?.map((c) => c.foot)).toEqual(['R_Foot', 'L_Foot']);
    // Cumulative forward travel grows monotonically to one stride.
    const travels = m.keyframes.map((k) => k.travel!.meters);
    for (let i = 1; i < travels.length; i += 1) expect(travels[i]!).toBeGreaterThan(travels[i - 1]!);
    expect(m.keyframes.at(-1)!.travel!.meters).toBeCloseTo(0.7, 1);
  });

  it('travels the body forward (+Z) over the stride', () => {
    expect(hipsDz(sampleTravel()), 'body advances +Z').toBeGreaterThan(0.5);
  });

  it('keeps each stance foot planted DURING ITS window — far less than un-pinned', () => {
    const pinned = sampleTravel(true);
    const free = sampleTravel(false);
    // Right foot is stance for the first half (0–800 ms), left for the second.
    const rPin = measureContactSlide(pinned, 'R_Foot', 0, 800).horizontalM;
    const lPin = measureContactSlide(pinned, 'L_Foot', 800, 1600).horizontalM;
    expect(rPin, 'R stance slide').toBeLessThan(0.09);
    expect(lPin, 'L stance slide').toBeLessThan(0.09);
    // …materially less than the moonwalking un-pinned feet in the same windows.
    const rFree = measureContactSlide(free, 'R_Foot', 0, 800).horizontalM;
    expect(rPin).toBeLessThan(rFree * 0.5);
  });

  it('the swing foot still advances forward (the plant does not freeze the gait)', () => {
    const rec = sampleTravel(true);
    // The RIGHT foot swings forward during the second half (its non-stance window).
    const rSwing =
      rec.frames.find((f) => Math.abs(f.tMs - 1580) < 20)!.worldTracks!['R_Foot']![2] -
      rec.frames.find((f) => Math.abs(f.tMs - 820) < 20)!.worldTracks!['R_Foot']![2];
    expect(rSwing, 'R foot advances in swing').toBeGreaterThan(0.1);
  });
});
