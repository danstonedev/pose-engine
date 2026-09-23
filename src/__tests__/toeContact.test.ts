/**
 * TOE CONTACT — the forefoot pivot of push-off, on the real rig.
 *
 * A walk may hold each stance foot flat (an ankle contact) and then, from heel
 * rise to toe lift, by its forefoot (a toe contact) — DDx's walk declares
 * exactly that. `toePivotWalk` reproduces the pattern on the engine's own
 * travelling walk.
 *
 * A TOE CONTACT IS A LEG CHAIN WITH A HINGED KNEE. It reused the foot's two
 * parents (toes → ankle → knee — the hip never helped) and its hinge key was the
 * toe bone itself (the 'Foot'-suffix rewrite missed 'Toes'), so the knee was
 * solved as a free ball joint: 4.8° of knee varus/valgus through the right toe
 * pivot here (4.6°/5.0° on the DDx walk), 0.0° with the foot flat.
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
import {
  authoredToTrajectoryTimeScale,
  sampleComposedMotion,
  type MotionRecording,
} from '../services/motionRecording';
import * as footContact from '../services/footContact';
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

/** The heel rises this far before the end of terminal stance's keyframe, and
 *  the toes lift this far into the keyframe after toe-off (DDx's walk values). */
const HEEL_RISE_FRACTION = 0.35;
const TOE_LIFT_FRACTION = 0.46;

/**
 * The engine walk with each stance split DDx's way: the foot held flat from
 * landing to heel rise, then by its forefoot until the toes lift part-way into
 * initial swing. Layout [0] initiation · [1..8] cycle · [9] braking step ·
 * [10] settle: the right heel rises late in keyframe 4 and its toes lift in 6;
 * the left's in 8 and 9. The builder's closing contacts are kept.
 */
function toePivotWalk(speed?: number): ComposedMotion {
  const walk = buildTravelWalk(speed ? { speed } : {});
  const kfs = walk.keyframes;
  const ends: number[] = [];
  kfs.reduce((t, k) => {
    ends.push(t + k.durationMs + (k.holdMs ?? 0));
    return ends[ends.length - 1]!;
  }, 0);
  const rise = (k: number) => ends[k]! - HEEL_RISE_FRACTION * kfs[k]!.durationMs;
  const lift = (k: number) => ends[k - 1]! + TOE_LIFT_FRACTION * kfs[k]!.durationMs;
  return {
    ...walk,
    contacts: [
      { foot: 'R_Foot', fromMs: 0, toMs: rise(4) },
      { foot: 'R_Toes', fromMs: rise(4), toMs: lift(6) },
      { foot: 'L_Foot', fromMs: ends[4]!, toMs: rise(8) },
      { foot: 'L_Toes', fromMs: rise(8), toMs: lift(9) },
      ...(walk.contacts ?? []).slice(2),
    ],
  };
}

interface Sampled {
  rec: MotionRecording;
  /** The contacts on the trajectory clock the frames run on. */
  contacts: { foot: string; fromMs: number; toMs: number }[];
}

const cache = new Map<string, Sampled>();
function sample(motion: () => ComposedMotion, key: string, sampleHz: number): Sampled {
  const hit = cache.get(`${key}@${sampleHz}`);
  if (hit) return hit;
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(motion(), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz,
  });
  const scale = authoredToTrajectoryTimeScale(resolved, rec.frames[rec.frames.length - 1]!.tMs);
  const contacts = (resolved.contacts ?? []).map((c) => ({
    foot: c.foot,
    fromMs: (c.fromMs ?? -Infinity) * scale,
    toMs: (c.toMs ?? Infinity) * scale,
  }));
  const out = { rec, contacts };
  cache.set(`${key}@${sampleHz}`, out);
  return out;
}

const inWindow = (c: { fromMs: number; toMs: number }, tMs: number) =>
  tMs >= c.fromMs - 1e-6 && tMs <= c.toMs + 1e-6;
const angle = (rec: MotionRecording, i: number, bone: string, motion: string): number =>
  rec.frames[i]!.angles[bone]?.[motion] ?? 0;

describe('a toe contact is a leg chain whose knee stays a hinge', () => {
  it('the toe chain climbs toes → ankle → knee → hip and hinges the KNEE; the foot chain is unchanged', () => {
    const keysOf = (key: string) => footContact.buildFootPlant(skinned, key, variantCfg)!.ctx.canonicalKeys;
    expect(keysOf('L_Toes')).toEqual(['L_Toes', 'L_Foot', 'L_Leg', 'L_UpLeg']);
    expect(keysOf('R_Toes')).toEqual(['R_Toes', 'R_Foot', 'R_Leg', 'R_UpLeg']);
    expect(footContact.buildFootPlant(skinned, 'R_Toes', variantCfg)!.kneeKey).toBe('R_Leg');
    expect(keysOf('L_Foot')).toEqual(['L_Foot', 'L_Leg', 'L_UpLeg']);
    expect(footContact.buildFootPlant(skinned, 'L_Foot', variantCfg)!.kneeKey).toBe('L_Leg');
    expect(footContact.kneeKeyForFoot('L_Toes')).toBe('L_Leg');
    expect(footContact.kneeKeyForFoot('R_Foot')).toBe('R_Leg');
  });

  it('a declared HAND contact hinges the elbow, like the grounding hand plant (it hinged nothing)', () => {
    const plant = footContact.buildFootPlant(skinned, 'L_Hand', variantCfg)!;
    expect(plant.ctx.canonicalKeys).toEqual(['L_Hand', 'L_Forearm', 'L_UpperArm']);
    expect(plant.kneeKey).toBe('L_Forearm');
    expect(plant.kneeKey).toBe(footContact.buildHandPlant(skinned, 'L_Hand', variantCfg)!.kneeKey);
  });

  it('through every toe pivot the knee takes no varus/valgus (was 4.8°) and the forefoot stays put', () => {
    const { rec, contacts } = sample(() => toePivotWalk(), 'toe', 60);
    let pivots = 0;
    for (const c of contacts) {
      const side = c.foot.slice(0, 2);
      const frames = rec.frames.map((_, i) => i).filter((i) => inWindow(c, rec.frames[i]!.tMs));
      expect(frames.length, `${c.foot} window sampled`).toBeGreaterThan(3);
      const worst = Math.max(...frames.map((i) => Math.abs(angle(rec, i, `${side}Leg`, 'kneeDeviation'))));
      // eslint-disable-next-line no-console
      console.log(`${c.foot} ${c.fromMs.toFixed(0)}–${c.toMs.toFixed(0)} ms: max |kneeDeviation| ${worst.toFixed(2)}°`);
      expect(worst, `${c.foot} knee varus/valgus`).toBeLessThan(0.5);
      if (!c.foot.endsWith('Toes')) continue;
      pivots += 1;
      // The hinge costs the hold nothing: the forefoot stays where it was put.
      const slide = footContact.measureContactSlide(rec, c.foot, c.fromMs, c.toMs);
      // eslint-disable-next-line no-console
      console.log(`${c.foot} held: slide ${(slide.horizontalM * 1000).toFixed(2)} mm, lift ${(slide.verticalM * 1000).toFixed(2)} mm`);
      expect(slide.horizontalM, `${c.foot} forefoot slide`).toBeLessThan(0.005);
      expect(slide.verticalM, `${c.foot} forefoot lift`).toBeLessThan(0.005);
    }
    expect(pivots, 'both toe pivots covered').toBe(2);
  });
});
