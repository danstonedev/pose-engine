/**
 * JUMP PHYSICS GATE — buildJump is a real countermovement vertical jump, not a
 * quick squat that never leaves the floor. Measured on the rig: the COM and the
 * FEET rise to a genuine airborne peak MID-motion (not at the start/end), the
 * peak is preceded by a load dip and followed by a distinct landing absorption,
 * and the body returns to a quiet stand. The contrast that makes it non-vacuous:
 * a squat's pelvis only ever goes DOWN; a jump's rises well above standing.
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
import { buildJump, templateToComposedMotion, MOVEMENT_TEMPLATES } from '../services/movementTemplates';
import { measureCommandMotion } from '../services/movementCommand';
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
let standingHipsY: number;
let standingFootY: number;

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
  // Standing reference = the jump's first frame (t=0 is the neutral start pose,
  // before the load dip): the tracked-bone world Y at rest.
  const rec0 = sampleJump();
  standingHipsY = rec0.frames[0]!.worldTracks!['Hips']![1];
  standingFootY = rec0.frames[0]!.worldTracks!['L_Foot']![1];
});

function resetHarness(): void {
  applyAnatomicPose(root, variantCfg);
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

function sampleJump(): MotionRecording {
  resetHarness();
  const resolved = resolveComposedMotion(buildJump(), variantCfg);
  expect(resolved.status, resolved.reason).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
  });
}

const yOf = (rec: MotionRecording, bone: string) => rec.frames.map((f) => f.worldTracks![bone]![1]);
const argmax = (a: number[]) => a.reduce((bi, v, i) => (v > a[bi]! ? i : bi), 0);
const kneeAt = (rec: MotionRecording, tMs: number) => {
  const f = rec.frames.reduce((b, x) => (Math.abs(x.tMs - tMs) < Math.abs(b.tMs - tMs) ? x : b));
  return measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'L_Leg', 'kneeFlexion') ?? 0;
};

describe('buildJump — real vertical jump physics', () => {
  it('the COM rises to a genuine airborne peak MID-motion (not a squat that only drops)', () => {
    const rec = sampleJump();
    const hips = yOf(rec, 'Hips');
    const peak = Math.max(...hips);
    const peakIdx = argmax(hips);
    const total = rec.frames.length;
    // Rises well ABOVE standing — a squat never does (its pelvis only drops).
    expect(peak - standingHipsY, 'COM rise above standing').toBeGreaterThan(0.3);
    // The peak is airborne — mid-motion, not the first or last frame.
    expect(peakIdx).toBeGreaterThan(total * 0.25);
    expect(peakIdx).toBeLessThan(total * 0.8);
  });

  it('the whole body leaves the floor — the feet clear the ground at apex', () => {
    const rec = sampleJump();
    expect(Math.max(...yOf(rec, 'L_Foot')) - standingFootY, 'foot clearance').toBeGreaterThan(0.3);
    expect(Math.max(...yOf(rec, 'R_Foot')) - standingFootY).toBeGreaterThan(0.3);
  });

  it('loads BEFORE the peak and ABSORBS after it (distinct landing flexion)', () => {
    const rec = sampleJump();
    const hips = yOf(rec, 'Hips');
    const apexMs = rec.frames[argmax(hips)]!.tMs;
    // Countermovement: a knee-flexion load dip before takeoff…
    const loadKnee = Math.max(
      ...rec.frames.filter((f) => f.tMs < apexMs * 0.6).map((f) =>
        measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'L_Leg', 'kneeFlexion') ?? 0,
      ),
    );
    expect(loadKnee, 'load knee flexion').toBeGreaterThan(35);
    // …and a SEPARATE landing absorption AFTER the apex (feet re-plant, knees
    // flex to cushion) — the phase the old quick-squat jump never had.
    const landKnee = Math.max(
      ...rec.frames.filter((f) => f.tMs > apexMs + 120).map((f) =>
        measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'L_Leg', 'kneeFlexion') ?? 0,
      ),
    );
    expect(landKnee, 'landing absorption knee flexion').toBeGreaterThan(35);
  });

  it('returns to a quiet stand (COM back near standing, knees extended)', () => {
    const rec = sampleJump();
    const last = rec.frames.at(-1)!;
    expect(Math.abs(last.worldTracks!['Hips']![1] - standingHipsY), 'COM back to standing').toBeLessThan(0.08);
    expect(kneeAt(rec, last.tMs), 'knees extended at rest').toBeLessThan(10);
  });

  it('CONTRAST — a squat only ever drops; the jump rises far above it', () => {
    const rec = sampleJump();
    resetHarness();
    const squat = resolveComposedMotion(
      templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'squat')!),
      variantCfg,
    );
    const srec = sampleComposedMotion(squat, {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
    });
    const jumpPeak = Math.max(...yOf(rec, 'Hips'));
    const squatPeak = Math.max(...yOf(srec, 'Hips'));
    expect(jumpPeak).toBeGreaterThan(squatPeak + 0.25);
    // The squat's pelvis stays at/below standing; the jump's clears it.
    expect(squatPeak).toBeLessThan(standingHipsY + 0.02);
  });
});
