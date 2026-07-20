/**
 * BALANCE-STRATEGY LIBRARY (Wave 3, roadmap item 3.4) — core PT teaching content.
 *
 * Three deterministic, scripted-perturbation templates [Horak & Nashner 1986;
 * Shumway-Cook & Woollacott]. Each has a scripted forward perturbation and a
 * strategy-specific recovery; rig-gated on the balance timeline (the same
 * `computeBalanceTimeline` the HUD and the other balance gates read):
 *
 *   1. ankle strategy — margin dips toward 0 then recovers; ankle excursion
 *      DOMINATES (> 2× any hip/spine excursion); the trunk stays rigid; feet
 *      stay planted (IK-pinned, no slide).
 *   2. hip strategy — margin dips BELOW 0 (the larger perturbation) then recovers;
 *      hip + trunk excursion dominates; ankles stay near neutral.
 *   3. stepping strategy — margin dips BELOW 0 (COM driven outside the base) then
 *      recovers positive at the brace; a REAL protective step (the stepping foot's
 *      world position advances, plants, and returns) while the pinned stance foot
 *      never slides.
 *
 * All deterministic: two samples are byte-identical (no live controller).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { measureCommandMotion } from '../services/movementCommand';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { computeBalanceTimeline } from '../services/centerOfMass';
import { measureContactSlide } from '../services/footContact';
import { MOVEMENT_TEMPLATES, templateToComposedMotion, findMovementTemplate } from '../services/movementTemplates';
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

function sample(id: string): MotionRecording {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const m: ComposedMotion = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === id)!);
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, `resolve ${id}`).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  });
}

function angleTrack(rec: MotionRecording, joint: string, motion: string): number[] {
  return rec.frames.map((f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, joint, motion) ?? 0);
}
const excursion = (a: number[]): number => Math.max(...a) - Math.min(...a);
function bone(rec: MotionRecording, key: string): [number, number, number][] {
  return rec.frames.map((f) => f.worldTracks?.[key] ?? [0, 0, 0]);
}

describe('the three balance strategies are reachable + resolve', () => {
  it('each strategy is selectable by its aliases and resolves ok', () => {
    for (const [id, phrase] of [
      ['ankle-strategy', 'show me the ankle strategy'],
      ['hip-strategy', 'demonstrate the hip strategy'],
      ['stepping-strategy', 'the stepping strategy — a protective step'],
    ] as const) {
      expect(findMovementTemplate(phrase)?.id).toBe(id);
      const resolved = resolveComposedMotion(
        templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === id)!),
        variantCfg,
      );
      expect(resolved.status, `resolve ${id}`).toBe('ok');
    }
  });

  it('a generic "balance recovery" resolves to a strategy', () => {
    expect(findMovementTemplate('balance recovery')?.id).toBe('ankle-strategy');
  });
});

describe('ankle strategy: ankle-dominant sway, rigid trunk, margin dips then recovers', () => {
  it('margin narrows on the sway and re-centres; ankle excursion dominates', () => {
    const rec = sample('ankle-strategy');
    const tl = computeBalanceTimeline(rec);
    const margins = tl.frames.map((f) => f.marginM).filter((m): m is number => m != null);
    const base = margins[0]!;
    const min = Math.min(...margins);
    const final = margins[margins.length - 1]!;

    // Grounded throughout (a quiet-stance perturbation — never airborne).
    expect(tl.airborneFraction).toBe(0);
    // The margin narrows meaningfully on the sway (toward 0) — but the ankle
    // strategy keeps the COM INSIDE the base, so it stays positive…
    expect(min).toBeLessThan(base - 0.03);
    expect(min).toBeGreaterThan(0);
    // …and re-centres by the settle.
    expect(final).toBeGreaterThan(base - 0.01);

    // JOINT SIGNATURE: ankle excursion dominates — > 2× any hip/spine excursion.
    const ankle = Math.max(excursion(angleTrack(rec, 'L_Foot', 'ankleFlexion')), excursion(angleTrack(rec, 'R_Foot', 'ankleFlexion')));
    const hip = Math.max(excursion(angleTrack(rec, 'L_UpLeg', 'hipFlexion')), excursion(angleTrack(rec, 'R_UpLeg', 'hipFlexion')));
    const spine = Math.max(excursion(angleTrack(rec, 'Spine_Lower', 'flexion')), excursion(angleTrack(rec, 'Spine_Upper', 'flexion')));
    expect(ankle).toBeGreaterThan(3);
    expect(ankle).toBeGreaterThan(2 * hip);
    expect(ankle).toBeGreaterThan(2 * spine);

    // Feet stay planted (IK-pinned): no forward slide of the base.
    const lSlide = measureContactSlide(rec, 'L_Foot').horizontalM;
    const rSlide = measureContactSlide(rec, 'R_Foot').horizontalM;
    expect(lSlide).toBeLessThan(0.02);
    expect(rSlide).toBeLessThan(0.02);
  });
});

describe('hip strategy: hip + trunk counter-flexion, margin dips below 0 then recovers', () => {
  it('the larger perturbation drives the margin negative; the jack-knife recovers it', () => {
    const rec = sample('hip-strategy');
    const tl = computeBalanceTimeline(rec);
    const margins = tl.frames.map((f) => f.marginM).filter((m): m is number => m != null);
    const base = margins[0]!;
    const min = Math.min(...margins);
    const final = margins[margins.length - 1]!;

    expect(tl.airborneFraction).toBe(0);
    // The larger perturbation carries the COM to/over the edge — the margin goes
    // negative — then the rapid trunk/hip counter-flexion re-centres it upright.
    expect(min).toBeLessThan(0);
    expect(final).toBeGreaterThan(base - 0.01);

    // JOINT SIGNATURE: hip + trunk excursion dominates; the ankles stay ~neutral.
    const hip = Math.max(excursion(angleTrack(rec, 'L_UpLeg', 'hipFlexion')), excursion(angleTrack(rec, 'R_UpLeg', 'hipFlexion')));
    const spine = excursion(angleTrack(rec, 'Spine_Lower', 'flexion'));
    const ankle = Math.max(excursion(angleTrack(rec, 'L_Foot', 'ankleFlexion')), excursion(angleTrack(rec, 'R_Foot', 'ankleFlexion')));
    expect(hip).toBeGreaterThan(20);
    expect(spine).toBeGreaterThan(20);
    expect(hip + spine).toBeGreaterThan(4 * (ankle + 1)); // hip+trunk dominates; ankles quiet
  });
});

describe('stepping strategy: a real protective step recovers an out-of-base COM', () => {
  it('the COM leaves the base, the stepping foot advances + plants, the margin recovers', () => {
    const rec = sample('stepping-strategy');
    const tl = computeBalanceTimeline(rec);
    const margins = tl.frames.map((f) => f.marginM).filter((m): m is number => m != null);
    const min = Math.min(...margins);
    const final = margins[margins.length - 1]!;

    // The largest perturbation drives the COM OUTSIDE the base — margin negative.
    expect(min).toBeLessThan(-0.02);
    // Recovered by the settle (feet re-levelled, quiet stance).
    expect(final).toBeGreaterThan(0.04);

    // A REAL STEP: the RIGHT (stepping) foot's world Z advances forward, then
    // returns beside the stance foot.
    const rz = bone(rec, 'R_Foot').map((p) => p[2]);
    const advance = Math.max(...rz) - rz[0]!;
    expect(advance, 'stepping foot advances forward').toBeGreaterThan(0.12);
    expect(rz[rz.length - 1]! - rz[0]!, 'stepping foot returns beside stance').toBeLessThan(0.03);
    // It clears the floor mid-step (a swing, not a slide).
    const ry = bone(rec, 'R_Foot').map((p) => p[1]);
    expect(Math.max(...ry) - ry[0]!, 'stepping foot lifts off').toBeGreaterThan(0.04);

    // A brace mid-step: at least one frame stands on the single (stance) foot
    // while the stepping foot is airborne.
    expect(tl.frames.some((f) => f.contacts.length === 1)).toBe(true);

    // The STANCE (left) foot is IK-pinned for the whole motion — it never slides.
    expect(measureContactSlide(rec, 'L_Foot').horizontalM, 'stance foot planted').toBeLessThan(0.02);
  });
});

describe('the strategies are deterministic (scripted, no live controller)', () => {
  for (const id of ['ankle-strategy', 'hip-strategy', 'stepping-strategy'] as const) {
    it(`${id}: two samples are byte-identical`, () => {
      const a = sample(id);
      const b = sample(id);
      expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
    });
  }
});
