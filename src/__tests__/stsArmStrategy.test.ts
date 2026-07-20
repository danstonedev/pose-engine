/**
 * SIT-TO-STAND ARM STRATEGY (Wave 5, roadmap 5.6) — the thigh push-off.
 *
 * The audit's polish lens: "STS has no arm strategy" — the template rose with
 * the arms hanging dead at anatomic zero while relaxedHands curled the fingers.
 * A natural STS pushes off the thighs: hands rest ON the thighs seated, PRESS
 * through the lean-forward, the ELBOWS EXTEND through the push-off as the hips
 * leave the seat, and the arms RELEASE to a relaxed hang at upright. All
 * authored keyframe targets on the template.
 *
 * Gates:
 *  1. RIG PROXIMITY — through seat-off (lean-forward → push-off) each hand's
 *     world-space distance to its own mid-thigh is small (the hand rides the
 *     thigh), then RELEASES: the standing hand ends clearly farther from the
 *     (now vertical) thigh line than its pushing minimum.
 *  2. ELBOW EXTENSION THROUGH THE RISE — the measured elbow flexion decreases
 *     from the lean (pressing, ~45°) through push-off (~14°) to the upright
 *     hang (~8°).
 *  3. RELAXED-HANDS GATE — the template now authors wrist targets, so the
 *     universal relaxedHands transform must SKIP it (same object reference; no
 *     finger-curl background adds appear on resolve).
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
import { relaxedHands, resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { measureCommandMotion } from '../services/movementCommand';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;

const sts = (): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'sit-to-stand')!);

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

function sampleSts(): MotionRecording {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(sts(), variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
    // Hands + both thigh endpoints (hip joint = UpLeg origin, knee = Leg origin)
    // so the hand-to-thigh distance is derivable per frame.
    trackedBones: ['Hips', 'L_Hand', 'R_Hand', 'L_UpLeg', 'R_UpLeg', 'L_Leg', 'R_Leg'],
  });
}

/** Distance (m) from a hand to the SEGMENT hip→knee of the same side — the
 *  honest "hand on the thigh" metric (point-to-segment, not point-to-midpoint,
 *  so a hand anywhere along the thigh counts as riding it). */
function handToThighM(f: MotionRecording['frames'][number], side: 'L' | 'R'): number {
  const w = f.worldTracks!;
  const hand = w[`${side}_Hand`]!;
  const hip = w[`${side}_UpLeg`]!;
  const knee = w[`${side}_Leg`]!;
  const ab = [knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]] as const;
  const ap = [hand[0] - hip[0], hand[1] - hip[1], hand[2] - hip[2]] as const;
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = len2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
  const px = hip[0] + ab[0] * t;
  const py = hip[1] + ab[1] * t;
  const pz = hip[2] + ab[2] * t;
  return Math.hypot(hand[0] - px, hand[1] - py, hand[2] - pz);
}

/** Frame nearest an absolute time. */
const frameAt = (rec: MotionRecording, tMs: number): MotionRecording['frames'][number] => {
  let best = rec.frames[0]!;
  for (const f of rec.frames) if (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  return best;
};

// Authored phase settle times: seated 700(+300 hold) → lean 1500 → push-off 1850 → stand 2300.
const SEATED_AT = 700;
const LEAN_AT = 1500;
const PUSH_AT = 1850;
const STAND_AT = 2300;

describe('sit-to-stand arm strategy — measured on the rig', () => {
  it('the hands ride the thighs through seat-off, then RELEASE at upright', () => {
    const rec = sampleSts();
    for (const side of ['L', 'R'] as const) {
      const at = (tMs: number): number => handToThighM(frameAt(rec, tMs), side);
      // Minimum distance across the pushing window (lean → push-off settle).
      let pushMin = Infinity;
      for (const f of rec.frames) {
        if (f.tMs >= SEATED_AT && f.tMs <= PUSH_AT) pushMin = Math.min(pushMin, handToThighM(f, side));
      }
      const seated = at(SEATED_AT);
      const lean = at(LEAN_AT);
      const push = at(PUSH_AT);
      const stand = at(STAND_AT);
      // eslint-disable-next-line no-console
      console.log(
        `STS ${side} hand→thigh: seated ${(seated * 100).toFixed(1)}cm · lean ${(lean * 100).toFixed(1)}cm · push ${(push * 100).toFixed(1)}cm · stand ${(stand * 100).toFixed(1)}cm (push-window min ${(pushMin * 100).toFixed(1)}cm)`,
      );
      // Proximity: the hand rides close to its thigh line through the push.
      expect(seated, `${side} seated hand rests on the thigh`).toBeLessThan(0.13);
      expect(lean, `${side} pressing hand stays on the thigh through the lean`).toBeLessThan(0.13);
      expect(push, `${side} hand still on the thigh at seat-off`).toBeLessThan(0.16);
      // Release: the upright hang is clearly farther from the (now vertical)
      // thigh line than the pushing minimum.
      expect(stand, `${side} arm released at upright`).toBeGreaterThan(pushMin + 0.04);
    }
  });

  it('the elbows EXTEND through the rise and the arms settle to a relaxed hang', () => {
    const rec = sampleSts();
    const elbow = (tMs: number, side: 'L' | 'R'): number =>
      measureCommandMotion(
        { at: '', variant: 'male', joints: frameAt(rec, tMs).angles },
        `${side}_Forearm`,
        'elbowFlexion',
      ) ?? 0;
    for (const side of ['L', 'R'] as const) {
      const lean = elbow(LEAN_AT, side);
      const push = elbow(PUSH_AT, side);
      const stand = elbow(STAND_AT, side);
      // eslint-disable-next-line no-console
      console.log(`STS ${side} elbow: lean ${lean.toFixed(1)}° · push ${push.toFixed(1)}° · stand ${stand.toFixed(1)}°`);
      expect(lean, `${side} pressing elbow clearly bent`).toBeGreaterThan(35);
      expect(push, `${side} elbow extending through seat-off`).toBeLessThan(lean - 15);
      expect(stand, `${side} relaxed hang at upright`).toBeLessThan(push - 3);
      expect(stand, `${side} slight relaxed bend, not locked rigid`).toBeGreaterThan(-2);
      expect(stand, `${side} settles at the relaxed hang`).toBeLessThan(12);
    }
  });

  it('relaxedHands SKIPS the template now that it authors the hands (gate verified)', () => {
    const m = sts();
    // Same object reference — the authors-hands gate fires.
    expect(relaxedHands(m)).toBe(m);
    // And on the full resolve path no finger-curl background add appears — the
    // pressing palm is never curled by the universal transform.
    const r = resolveComposedMotion(m, variantCfg);
    expect(r.status).toBe('ok');
    expect(
      r.keyframes.some((kf) => kf.targets.some((t) => t.motion === 'fingerFlexion')),
      'no relaxed-hand finger curl on a pressing palm',
    ).toBe(false);
    // The authored wrist strategy IS on the resolved truth path (extension while
    // pressing — negative wristFlexion — released to 0 at upright).
    const wristAt = (ki: number): number | undefined =>
      r.keyframes[ki]!.targets.find((t) => t.joint === 'R_Hand' && t.motion === 'wristFlexion')?.clampedDegrees;
    expect(wristAt(1)).toBeLessThan(-10);
    expect(wristAt(r.keyframes.length - 1)).toBe(0);
  });
});
