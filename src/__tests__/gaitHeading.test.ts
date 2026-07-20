/**
 * TRAVEL-HEADING GATE — buildTravelWalk(opts.headingDeg) walks along a ROTATED
 * horizontal direction (roadmap 4.1): the initiation keyframe pivots the body
 * to the heading (the person orients, THEN walks off), every keyframe carries
 * heading + its own pelvic yaw, and the foot-driven travel derivation rides
 * offset·(sinH, cosH) with the lateral shuttle perpendicular to it.
 *
 * Two non-negotiables, both rig-gated here:
 *   • headingDeg 0 (or omitted) is BYTE-IDENTICAL to the un-headed walk — at
 *     the builder, the resolver, AND the sampled recording;
 *   • headingDeg 90 actually travels the rotated path (+X, toward the
 *     subject's left) with near-zero drift along the old axis, keeps every
 *     stance foot planted (slide budgets along the rotated path), keeps the
 *     head steady, and keeps the calibrated vertical calm.
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

interface HeadedSample {
  rec: MotionRecording;
  resolved: ReturnType<typeof resolveComposedMotion>;
}

function sampleWalk(opts: { headingDeg?: number } = {}): HeadedSample {
  resetHarness();
  const resolved = resolveComposedMotion(buildTravelWalk(opts), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
  });
  return { rec, resolved };
}

const track = (f: MotionRecording['frames'][number], key: string): [number, number, number] =>
  f.worldTracks![key]!;

/** Worst horizontal slide of a foot across its AUTHORED stance windows — the
 *  spans the walk declares the foot weight-bearing (and IK-pins it). The honest
 *  planted metric for the headed walk: its longer initiation pivot briefly
 *  levels the feet (near-tie heights), so the straight walk's longest
 *  lower-foot-run heuristic would land on the braking-step LANDING (a foot
 *  still travelling before its window opens) instead of a stance.
 *  measureContactSlide is planar XZ, so it is heading-agnostic. */
function plantedSlideM(
  sample: HeadedSample,
  foot: 'R_Foot' | 'L_Foot',
): number {
  let worst = 0;
  for (const c of sample.resolved.contacts ?? []) {
    if (c.foot !== foot) continue;
    const from = c.fromMs ?? 0;
    const to = c.toMs ?? Infinity;
    const run = sample.rec.frames.filter((f) => f.tMs >= from - 1e-6 && f.tMs <= to + 1e-6);
    if (run.length < 2) continue;
    worst = Math.max(worst, measureContactSlide({ frames: run }, foot).horizontalM);
  }
  return worst;
}

describe('buildTravelWalk headingDeg — the walk travels along a rotated heading', () => {
  it('headingDeg 0 is BYTE-IDENTICAL to the un-headed walk (builder, resolver, and sampled rig)', () => {
    // Builder: same plan, no extra fields (heading 0 IS the default).
    expect(JSON.stringify(buildTravelWalk({ headingDeg: 0 }))).toBe(JSON.stringify(buildTravelWalk()));
    expect('headingDeg' in buildTravelWalk()).toBe(false);
    // Resolver: the resolved motion carries no heading either way.
    const r0 = resolveComposedMotion(buildTravelWalk({ headingDeg: 0 }), variantCfg);
    const rPlain = resolveComposedMotion(buildTravelWalk(), variantCfg);
    expect(JSON.stringify(r0)).toBe(JSON.stringify(rPlain));
    expect(r0.headingDeg).toBeUndefined();
    // Rig: the sampled recordings are byte-identical frame streams.
    const rec0 = sampleWalk({ headingDeg: 0 }).rec;
    const recPlain = sampleWalk().rec;
    expect(JSON.stringify(rec0.frames)).toBe(JSON.stringify(recPlain.frames));
  });

  describe('headingDeg 90 (toward the subject\'s left, +X)', () => {
    let sample: HeadedSample;
    let rec: MotionRecording;
    /** End of the initiation pivot (the walk re-orients FIRST; the pivot about
     *  the stance foot legitimately relocates the body a few cm, so the
     *  path-line assertions start once the walking does). */
    let initEndMs = 0;
    beforeAll(() => {
      sample = sampleWalk({ headingDeg: 90 });
      rec = sample.rec;
      initEndMs = sample.resolved.keyframes[0]!.durationMs;
    });

    it('travels along +X (>0.5 m) and STAYS ON the rotated line — <0.1 m perpendicular spread', () => {
      const first = rec.frames[0]!;
      const dX = track(rec.frames[rec.frames.length - 1]!, 'Hips')[0] - track(first, 'Hips')[0];
      // Once walking (post-pivot), the path's PERPENDICULAR (old +Z) coordinate
      // must hold a line: total spread under 0.1 m (the shuttle's few cm live
      // inside it). The initiation pivot itself may relocate the body only by
      // a step-width-scale amount.
      const zs = rec.frames.filter((f) => f.tMs >= initEndMs).map((f) => track(f, 'Hips')[2]);
      const zSpread = Math.max(...zs) - Math.min(...zs);
      const pivotShift = Math.abs(
        track(rec.frames.find((f) => f.tMs >= initEndMs)!, 'Hips')[2] - track(first, 'Hips')[2],
      );
      // eslint-disable-next-line no-console
      console.log(`heading 90: ΔX ${dX.toFixed(2)}m · Z line spread ${(100 * zSpread).toFixed(1)}cm · pivot Z shift ${(100 * pivotShift).toFixed(1)}cm`);
      expect(dX, 'travels along the rotated heading (+X)').toBeGreaterThan(0.5);
      expect(zSpread, 'stays on the rotated line (no old-axis drift)').toBeLessThan(0.1);
      expect(pivotShift, 'the initiation pivot relocation stays step-width scale').toBeLessThan(0.2);
    });

    it('each stance foot stays planted along the rotated path — slide budgets green', () => {
      const rSlide = plantedSlideM(sample, 'R_Foot');
      const lSlide = plantedSlideM(sample, 'L_Foot');
      // eslint-disable-next-line no-console
      console.log(`heading 90: R slide ${(100 * rSlide).toFixed(1)}cm · L slide ${(100 * lSlide).toFixed(1)}cm`);
      // The straight walk gates < 3 cm (5 cm fast); same family of budget here —
      // the stance-foot pivot compensation is what keeps the entry inside it.
      expect(rSlide, 'R stance slide').toBeLessThan(0.05);
      expect(lSlide, 'L stance slide').toBeLessThan(0.05);
    });

    it('the head stays steady: its path-perpendicular excursion stays in the shuttle band', () => {
      // At heading 90 the path runs along X, so PERPENDICULAR is Z. The pelvis
      // deliberately shuttles a few cm perpendicular each stance; the thoracic
      // absorb keeps the HEAD from exceeding that band (the same vestibular
      // head-steadiness the straight walk gates in spinalCoordination.test.ts).
      // Measured once walking — the initiation pivot legitimately swings the
      // head around the stance foot.
      const walking = rec.frames.filter((f) => f.tMs >= initEndMs);
      const zs = walking.map((f) => track(f, 'Head')[2]);
      const headExc = Math.max(...zs) - Math.min(...zs);
      const zsHips = walking.map((f) => track(f, 'Hips')[2]);
      const hipsExc = Math.max(...zsHips) - Math.min(...zsHips);
      // eslint-disable-next-line no-console
      console.log(`heading 90: head ⊥ excursion ${(100 * headExc).toFixed(1)}cm · pelvis ⊥ ${(100 * hipsExc).toFixed(1)}cm`);
      expect(headExc, 'head lateral-to-path excursion stays small').toBeLessThan(0.06);
    });

    it('the calibrated vertical stays calm and smooth along the rotated path', () => {
      const ys = rec.frames.map((f) => f.root.translateM[1]);
      const p2p = Math.max(...ys) - Math.min(...ys);
      const total = rec.frames[rec.frames.length - 1]!.tMs;
      const perMs = total / (ys.length - 1);
      const win = Math.max(1, Math.round(100 / perMs));
      let maxDrop = 0;
      for (let i = win; i < ys.length; i += 1) maxDrop = Math.max(maxDrop, ys[i - win]! - ys[i]!);
      // eslint-disable-next-line no-console
      console.log(`heading 90: vertical p2p ${(100 * p2p).toFixed(1)}cm · max 100ms drop ${(100 * maxDrop).toFixed(1)}cm`);
      expect(p2p, 'excursion calmed (same budget as the straight walk)').toBeLessThan(0.10);
      expect(maxDrop, 'no sudden vertical drop').toBeLessThan(0.06);
    });

    it('the body FACES the heading while walking it (the initiation pivot oriented first)', () => {
      // Mid-walk the root orientation carries the ~90° heading yaw: rotate the
      // rest forward (+Z) by the recorded root quat and check its horizontal angle.
      const mid = rec.frames[Math.floor(rec.frames.length / 2)]!;
      const q = new THREE.Quaternion(...mid.root.orientQuat);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const yaw = (Math.atan2(fwd.x, fwd.z) * 180) / Math.PI;
      // eslint-disable-next-line no-console
      console.log(`heading 90: mid-walk body yaw ${yaw.toFixed(1)}°`);
      expect(Math.abs(yaw - 90), 'body faces the line of travel').toBeLessThan(10);
    });

    it('deterministic — two headed samples are byte-identical', () => {
      const again = sampleWalk({ headingDeg: 90 }).rec;
      expect(JSON.stringify(again.frames)).toBe(JSON.stringify(rec.frames));
    });
  });
});
