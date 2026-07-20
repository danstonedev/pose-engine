/**
 * GAIT WEIGHT-TRANSFER GATE — the travel walk's remaining weight-transfer cues
 * (roadmap 3.2 + 3.1-gait + 3.5), all rig-measured:
 *
 *   • ML ROOT SHUTTLE (3.2): the pelvis rides a few cm along world X toward the
 *     PLANTED foot each stance — toward the R foot through the first half-cycle,
 *     toward the L through the second — crossing the centre line at the
 *     double-support transitions. Derived at sample time from the measured feet
 *     (rootMotion `deriveGaitLateralShuttle`), phase-locked to the walk's
 *     planned stance schedule; the thoracic S-curve authored against the same
 *     schedule absorbs it so the head stays steady (the <2.5 cm head-lateral
 *     gate lives in spinalCoordination.test.ts and is re-measured there).
 *
 *   • REAL GAIT INITIATION (3.1): an anticipatory postural adjustment — the
 *     pelvis/COM shifts over the future stance (R) foot BEFORE the first swing
 *     (L) foot ever leaves the floor, replacing the old bare time-stretch.
 *     Gated as a TEMPORAL ORDER: shift onset precedes swing-foot lift-off.
 *
 *   • REAL GAIT TERMINATION (3.5): a braking final step — the lead (R) foot
 *     accepts weight, the trailing (L) foot steps up NEXT TO it, and the body
 *     levels out to quiet standing: feet together fore-aft, grounded, trunk
 *     de-rotated, COM settled inside the base (positive stability margin).
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
import { computeBalanceTimeline } from '../services/centerOfMass';
import { measureCommandMotion } from '../services/movementCommand';
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
let rec: MotionRecording; // one shared default-speed sample (deterministic)

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
  rec = sampleTravel();
});

/** The sampler captures the current root as its rest, so reset to origin before
 *  each sample (else consecutive samples accumulate the prior travel). */
function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

function sampleTravel(): MotionRecording {
  resetHarness();
  const resolved = resolveComposedMotion(buildTravelWalk(), variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
  });
}

const track = (f: MotionRecording['frames'][number], key: string): [number, number, number] =>
  f.worldTracks![key]!;
const frameAt = (r: MotionRecording, tMs: number) =>
  r.frames.reduce((b, f) => (Math.abs(f.tMs - tMs) < Math.abs(b.tMs - tMs) ? f : b));
const durOf = (r: MotionRecording) => r.frames[r.frames.length - 1]!.tMs;

/** The walk's authored stance schedule boundaries (recomputed from the plan the
 *  same way the builder lays them out — keyframe arrival times). */
function stanceBoundaries(): { rStanceEnd: number; lStanceEnd: number; lLandsAt: number } {
  const m = buildTravelWalk();
  const dur = (k: (typeof m.keyframes)[number]): number => (k.durationMs ?? 0) + (k.holdMs ?? 0);
  const endOf = (i: number): number => m.keyframes.slice(0, i + 1).reduce((s, k) => s + dur(k), 0);
  return {
    rStanceEnd: endOf(4),
    lStanceEnd: endOf(8),
    lLandsAt: endOf(9) + (m.keyframes[10]!.durationMs ?? 0),
  };
}

describe('3.2 — medio-lateral root shuttle (per-step weight transfer)', () => {
  it('the pelvis oscillates 2-4.5 cm toward each stance foot, crossing centre at the transitions', () => {
    const xs = rec.frames.map((f) => track(f, 'Hips')[0]);
    // Subject-left is +X, so the R foot lies at −X: the shuttle swings NEGATIVE
    // through R stance and POSITIVE through L stance.
    const towardR = -Math.min(...xs);
    const towardL = Math.max(...xs);
    // eslint-disable-next-line no-console
    console.log(`shuttle: toward R ${(towardR * 100).toFixed(1)}cm · toward L ${(towardL * 100).toFixed(1)}cm`);
    expect(towardR, 'rides toward the R stance foot').toBeGreaterThan(0.02);
    expect(towardR, '…but stays inside the base').toBeLessThan(0.045);
    expect(towardL, 'rides toward the L stance foot').toBeGreaterThan(0.02);
    expect(towardL, '…but stays inside the base').toBeLessThan(0.045);
  });

  it('is IN PHASE with stance: toward R during R stance, toward L during L stance, ~0 at the handoffs', () => {
    const { rStanceEnd, lStanceEnd } = stanceBoundaries();
    const xAt = (t: number) => track(frameAt(rec, t), 'Hips')[0];
    expect(xAt(rStanceEnd * 0.5), 'toward the R foot at mid R-stance').toBeLessThan(-0.015);
    expect(xAt((rStanceEnd + lStanceEnd) / 2), 'toward the L foot at mid L-stance').toBeGreaterThan(0.015);
    // Weight transfer crosses the centre line at the double-support boundaries.
    expect(Math.abs(xAt(rStanceEnd)), 'centred at the R→L transition').toBeLessThan(0.01);
    expect(Math.abs(xAt(lStanceEnd)), 'centred at the L→terminal transition').toBeLessThan(0.01);
  });

  it('the shuttle is deterministic — two samples are byte-identical', () => {
    const again = sampleTravel();
    expect(JSON.stringify(again.frames)).toBe(JSON.stringify(rec.frames));
  });
});

describe('3.1 — real gait initiation (anticipatory postural adjustment)', () => {
  it('the pelvis shifts over the stance (R) foot BEFORE the first swing (L) foot leaves the floor', () => {
    // Swing-foot lift-off: the L rises clear of the R (both feet ride the same
    // root/vertical reshapes, so the DIFFERENCE isolates the actual lift).
    const liftAt = rec.frames.find(
      (f) => track(f, 'L_Foot')[1] - track(f, 'R_Foot')[1] > 0.02,
    );
    expect(liftAt, 'the L foot does swing').toBeDefined();
    // Shift onset: the pelvis is measurably over the stance side while the L
    // foot is still level with the R.
    const shiftOnset = rec.frames.find((f) => track(f, 'Hips')[0] < -0.01);
    expect(shiftOnset, 'the pelvis does shift').toBeDefined();
    // eslint-disable-next-line no-console
    console.log(
      `APA: shift onset @${shiftOnset!.tMs.toFixed(0)}ms · L lift-off @${liftAt!.tMs.toFixed(0)}ms · pelvis at lift ${(track(liftAt!, 'Hips')[0] * 100).toFixed(1)}cm`,
    );
    expect(shiftOnset!.tMs, 'weight shift PRECEDES the swing lift').toBeLessThan(liftAt!.tMs - 100);
    // And by lift-off the unweighting shift is substantial — the body has
    // already committed its weight to the stance side.
    expect(track(liftAt!, 'Hips')[0], 'pelvis over the stance foot at lift-off').toBeLessThan(-0.02);
    // The COM tells the same story (it is the physiologic quantity).
    expect(track(liftAt!, 'CoM')[0], 'COM toward the stance foot at lift-off').toBeLessThan(-0.01);
  });
});

describe('3.5 — real gait termination (braking step to quiet standing)', () => {
  it('ends feet-together: both feet within 15 cm fore-aft, grounded at rest height', () => {
    const last = rec.frames[rec.frames.length - 1]!;
    const first = rec.frames[0]!;
    const gapZ = Math.abs(track(last, 'R_Foot')[2] - track(last, 'L_Foot')[2]);
    // eslint-disable-next-line no-console
    console.log(`termination: fore-aft foot gap ${(gapZ * 100).toFixed(1)}cm`);
    expect(gapZ, 'the trailing foot stepped up NEXT TO the lead foot').toBeLessThan(0.15);
    // Both feet grounded at their standing height — no terminal float.
    expect(Math.abs(track(last, 'R_Foot')[1] - track(first, 'R_Foot')[1])).toBeLessThan(0.015);
    expect(Math.abs(track(last, 'L_Foot')[1] - track(first, 'L_Foot')[1])).toBeLessThan(0.015);
  });

  it('levels out to a quiet stand: trunk de-rotated, pelvis centred, arms settled', () => {
    const last = rec.frames[rec.frames.length - 1]!;
    const measured = (joint: string, motion: string): number =>
      measureCommandMotion({ at: '', variant: 'male', joints: last.angles }, joint, motion) ?? 0;
    expect(Math.abs(measured('Spine_Upper', 'rotation')), 'thorax de-rotated').toBeLessThan(1.5);
    expect(Math.abs(measured('Spine_Lower', 'rotation')), 'lumbar de-rotated').toBeLessThan(1.5);
    expect(Math.abs(measured('R_UpperArm', 'shoulderFlexion')), 'R arm settled').toBeLessThan(3);
    expect(Math.abs(measured('L_UpperArm', 'shoulderFlexion')), 'L arm settled').toBeLessThan(3);
    // The shuttle has handed the weight back to centre: the pelvis sits between
    // the feet, not out over either one.
    const feetMidX = (track(last, 'R_Foot')[0] + track(last, 'L_Foot')[0]) / 2;
    expect(Math.abs(track(last, 'Hips')[0] - feetMidX), 'pelvis centred over the base').toBeLessThan(0.02);
  });

  it('settles BALANCED: the COM projects inside the base with a positive margin through the final stand', () => {
    const tl = computeBalanceTimeline(rec);
    const total = durOf(rec);
    const tail = tl.frames.filter((f) => f.tMs >= total - 200);
    expect(tail.length).toBeGreaterThan(3);
    for (const f of tail) {
      expect(f.airborne, 'terminal double support — never airborne').toBe(false);
      expect(f.marginM, 'COM inside the base').not.toBeNull();
      expect(f.marginM!).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(`termination: final margin ${(tail[tail.length - 1]!.marginM! * 100).toFixed(1)}cm`);
  });

  it('the walk still TRAVELS — the termination adds a step, it does not eat the stride', () => {
    const dz =
      track(rec.frames[rec.frames.length - 1]!, 'Hips')[2] - track(rec.frames[0]!, 'Hips')[2];
    expect(dz, 'net forward travel').toBeGreaterThan(0.5);
  });
});
