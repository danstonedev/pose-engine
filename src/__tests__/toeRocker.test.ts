/**
 * TOE ROCKER GATE (wave 1) — the THIRD rocker of gait and the push-off MTP hinge.
 *
 * The audit finding: toeFlexion (L/R_Toes MTP, + = extension, ROM −40..70°) was
 * fully plumbed and ROM-clamped but NO template drove it — push-off pivoted a
 * rigid flat foot (no forefoot rocker), and ballistic push-offs rose en-pointe.
 * The fix authors MTP extension into the walk (building through terminal stance,
 * peaking ~28° at pre-swing push-off, releasing through swing), the heel-raise
 * (gated in heelRaise.test.ts), and the jump's propulsion (~30°, reset in flight).
 *
 * This gate proves, headlessly on the real male rig:
 *   1. the sampled TRAVEL walk MEASURES >15° MTP extension at each foot's
 *      push-off (the ankle plantarflexion trough), and a flat forefoot at that
 *      foot's initial contact — the rocker is phase-locked to the stride;
 *   2. the grounding interaction is safe: the floor-pin/foot-plant contacts read
 *      the Foot/Toes BONE ORIGINS (rootMotion CONTACT_KEYS), and MTP rotation
 *      happens ABOUT the Toes origin, so driving the toes must not pop the root
 *      height — asserted as a per-frame root-Y step bound (the slide budgets and
 *      vertical-smoothness gates stay in gaitTravel.test.ts);
 *   3. the jump pushes off over the MTP (>20° at propulsion) and the toes reset
 *      to neutral in flight and through the landing.
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
import { measureCommandMotion } from '../services/movementCommand';
import { buildJump, buildTravelWalk, MOVEMENT_TEMPLATES } from '../services/movementTemplates';
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

function resetHarness(): void {
  applyAnatomicPose(root, variantCfg);
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

function sample(motion: ReturnType<typeof buildTravelWalk>, sampleHz = 120): MotionRecording {
  resetHarness();
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status, resolved.reason).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz,
  });
}

/** Measured joint.motion series over a recording (registry clinical degrees). */
function seriesOf(rec: MotionRecording, joint: string, motion: string): number[] {
  return rec.frames.map(
    (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, joint, motion) ?? 0,
  );
}

const argmin = (a: number[]) => a.reduce((bi, v, i) => (v < a[bi]! ? i : bi), 0);
const argmax = (a: number[]) => a.reduce((bi, v, i) => (v > a[bi]! ? i : bi), 0);

describe('walk template — the plan authors a phase-locked forefoot rocker', () => {
  it('MTP extension peaks at the pre-swing push-off phase and is flat at contact, both sides', () => {
    const walk = MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!;
    const toeAt = (phase: string, joint: string): number =>
      walk.phases.find((p) => p.name === phase)!.targets.find(
        (x) => x.joint === joint && x.motion === 'toeFlexion',
      )?.peakDeg ?? 0;
    // The R foot pushes off at LEFT initial contact (its pre-swing), mirror for L.
    expect(toeAt('left-initial-contact', 'R_Toes'), 'R push-off MTP extension').toBeGreaterThanOrEqual(25);
    expect(toeAt('right-initial-contact', 'L_Toes'), 'L push-off MTP extension').toBeGreaterThanOrEqual(25);
    // Heel-off builds the extension a phase earlier (terminal stance)…
    expect(toeAt('right-terminal-stance', 'R_Toes'), 'R heel-off build').toBeGreaterThan(5);
    expect(toeAt('left-terminal-stance', 'L_Toes'), 'L heel-off build').toBeGreaterThan(5);
    // …and the forefoot is FLAT at the foot's own initial contact.
    expect(toeAt('right-initial-contact', 'R_Toes'), 'R flat at contact').toBe(0);
    expect(toeAt('left-initial-contact', 'L_Toes'), 'L flat at contact').toBe(0);
  });
});

describe('travel walk — the third rocker measured on the rig', () => {
  it('each foot shows >15° MTP extension at its push-off (ankle plantarflexion trough)', () => {
    const rec = sample(buildTravelWalk());
    for (const S of ['R', 'L'] as const) {
      const ankle = seriesOf(rec, `${S}_Foot`, 'ankleFlexion');
      const toe = seriesOf(rec, `${S}_Toes`, 'toeFlexion');
      // Push-off = the pre-swing plantarflexion trough (−15° authored).
      const push = argmin(ankle);
      // eslint-disable-next-line no-console
      console.log(
        `${S} push-off @${rec.frames[push]!.tMs.toFixed(0)}ms: ankle ${ankle[push]!.toFixed(1)}°, MTP ext ${toe[push]!.toFixed(1)}° (peak ${Math.max(...toe).toFixed(1)}°)`,
      );
      expect(ankle[push]!, `${S} push-off is a real plantarflexion`).toBeLessThan(-9);
      expect(toe[push]!, `${S} MTP extension at push-off`).toBeGreaterThan(15);
      // At that foot's INITIAL CONTACT (hip flexion peak) the forefoot lands flat.
      const contact = argmax(seriesOf(rec, `${S}_UpLeg`, 'hipFlexion'));
      expect(Math.abs(toe[contact]!), `${S} forefoot flat at initial contact`).toBeLessThan(8);
    }
  });

  it('driving the toes does not pop the root height (grounding reads the bone origins)', () => {
    // MTP rotation happens ABOUT the Toes bone origin, and every grounding path
    // (floor-pin CONTACT_KEYS, foot-plant IK, foot-driven travel) reads Foot/Toes
    // ORIGINS — so the toe rocker must leave the root vertical smooth. Bound the
    // per-frame root-Y step at 120 Hz (a pin pop would be a multi-cm jump); the
    // p2p excursion + 100 ms-window drop gates stay in gaitTravel.test.ts.
    const rec = sample(buildTravelWalk());
    const ys = rec.frames.map((f) => f.root.translateM[1]);
    let maxStep = 0;
    for (let i = 1; i < ys.length; i += 1) maxStep = Math.max(maxStep, Math.abs(ys[i]! - ys[i - 1]!));
    // eslint-disable-next-line no-console
    console.log(`travel walk root-Y max per-frame step ${(maxStep * 100).toFixed(2)} cm @120Hz`);
    expect(maxStep, 'no per-frame root-height pop').toBeLessThan(0.01);
  });
});

describe('jump — MTP push-off at propulsion, neutral in flight', () => {
  it('toes extend >20° driving the final push, and reset for flight + landing', () => {
    const rec = sample(buildJump(), 60);
    const hipsY = rec.frames.map((f) => f.worldTracks!['Hips']![1]);
    const apexIdx = argmax(hipsY);
    const apexMs = rec.frames[apexIdx]!.tMs;
    const toe = seriesOf(rec, 'L_Toes', 'toeFlexion');
    // Standing start: toes neutral.
    expect(Math.abs(toe[0]!), 'toes neutral at the standing start').toBeLessThan(3);
    // Propulsion (before the airborne peak): the push rolls over the MTP.
    const pushPeak = Math.max(...toe.slice(0, apexIdx + 1));
    // eslint-disable-next-line no-console
    console.log(`jump: MTP ext peak before apex ${pushPeak.toFixed(1)}°, at apex ${toe[apexIdx]!.toFixed(1)}° (apex @${apexMs.toFixed(0)}ms)`);
    expect(pushPeak, 'MTP extension drives the propulsion push-off').toBeGreaterThan(20);
    // The apex pose lands at the vertical peak with the toes already released…
    expect(Math.abs(toe[apexIdx]!), 'toes reset by the airborne apex').toBeLessThan(10);
    // …and they stay neutral through the descent, landing and recovery.
    const after = toe.filter((_, i) => rec.frames[i]!.tMs > apexMs + 100);
    expect(Math.max(...after.map(Math.abs)), 'toes neutral through landing/recovery').toBeLessThan(8);
  });
});
