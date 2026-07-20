/**
 * TRAVEL-GAIT GATE — buildTravelWalk advances the body forward with GROUND-TRUE
 * feet via ROOT MOTION FROM FOOT PLACEMENT (`footDrivenTravel`): the same authored
 * 8-phase walk kinematics, and the sampler/stage derive the +Z root travel from
 * the FK so the PLANTED foot stays world-fixed — no authored stride, no foot-lock
 * IK. Each stance foot barely slides (the old authored-stride + IK-capture version
 * dragged it ~30 cm horizontally and let it float ~18 cm at heel-strike), the
 * swing foot advances, the stride emerges from the ROM, and speed couples.
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

function sampleTravel(opts: { speed?: number } = {}): MotionRecording {
  resetHarness();
  const resolved = resolveComposedMotion(buildTravelWalk(opts), variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 120,
  });
}

const hipsDz = (rec: MotionRecording) =>
  rec.frames[rec.frames.length - 1]!.worldTracks!['Hips']![2] - rec.frames[0]!.worldTracks!['Hips']![2];
const durOf = (rec: MotionRecording) => rec.frames[rec.frames.length - 1]!.tMs;

/** Horizontal slide of a foot over the LONGEST contiguous run in which it is the
 *  lower (weight-bearing/planted) foot — the honest "did the stance foot stay put"
 *  metric for an alternating gait, independent of any authored window. */
function plantedSlideM(rec: MotionRecording, foot: 'R_Foot' | 'L_Foot'): number {
  const other = foot === 'R_Foot' ? 'L_Foot' : 'R_Foot';
  const low = rec.frames.map((f) => f.worldTracks![foot]![1] <= f.worldTracks![other]![1]);
  let bestStart = 0;
  let bestLen = 0;
  let curStart = -1;
  for (let i = 0; i <= rec.frames.length; i += 1) {
    if (i < rec.frames.length && low[i]) {
      if (curStart < 0) curStart = i;
    } else if (curStart >= 0) {
      if (i - curStart > bestLen) {
        bestLen = i - curStart;
        bestStart = curStart;
      }
      curStart = -1;
    }
  }
  const run = rec.frames.slice(bestStart, bestStart + bestLen);
  return measureContactSlide({ frames: run }, foot).horizontalM;
}

describe('buildTravelWalk — a forward gait driven by foot placement', () => {
  it('is the 8-phase walk, planted, non-looping, foot-driven, with stance foot-plant contacts', () => {
    const m = buildTravelWalk();
    expect(m.keyframes.length).toBe(8);
    expect(m.loop ?? false).toBe(false); // travel can't loop (would teleport)
    expect(m.stance).toBe('planted');
    expect(m.footDrivenTravel).toBe(true);
    // Foot-plant contacts pin each stance foot (R first half, L second) so the pelvis can
    // rotate its full range ABOUT the planted leg without the foot sliding. R stance =
    // [0, mid], L = [mid, total] — a symmetric two-step cycle.
    const total = m.keyframes.reduce((s, k) => s + (k.durationMs ?? 0) + (k.holdMs ?? 0), 0);
    expect(m.contacts?.map((c) => c.foot)).toEqual(['R_Foot', 'L_Foot']);
    expect(m.contacts![0]).toMatchObject({ foot: 'R_Foot', fromMs: 0, toMs: total / 2 });
    expect(m.contacts![1]).toMatchObject({ foot: 'L_Foot', fromMs: total / 2, toMs: total });
    expect(m.keyframes.every((k) => k.travel == null), 'no authored per-keyframe stride').toBe(true);
  });

  it('travels the body forward (+Z) — the stride EMERGES from the FK', () => {
    expect(hipsDz(sampleTravel()), 'body advances +Z').toBeGreaterThan(0.5);
  });

  it('each stance foot stays world-fixed — barely slides (the derived root cancels the FK sweep)', () => {
    const rec = sampleTravel();
    expect(plantedSlideM(rec, 'R_Foot'), 'R stance slide').toBeLessThan(0.03);
    expect(plantedSlideM(rec, 'L_Foot'), 'L stance slide').toBeLessThan(0.03);
  });

  it('paced travel: a faster walk travels farther per stride AND keeps feet planted', () => {
    const normal = sampleTravel();
    const fast = sampleTravel({ speed: 1.45 });
    // Faster ⇒ bigger leg swing ⇒ longer stride (more body travel) AND a shorter
    // cycle (quicker cadence) — all from paceGait, with the stride still emergent.
    expect(hipsDz(fast), 'faster travels farther').toBeGreaterThan(hipsDz(normal) + 0.1);
    expect(durOf(fast), 'faster cycle is shorter').toBeLessThan(durOf(normal) - 100);
    // A fast stride extends the stance leg near its reach limit, so the smoothed gait
    // vertical (which rounds the double-support drop by lifting the pelvis, clamped to
    // +2 cm over the pin) makes the planted foot over-reach a little more than at normal
    // speed — ~4.2 cm here vs ~3.9 cm un-smoothed. Still barely-sliding; the trade buys a
    // much smoother COM vertical (no 13 cm sawtooth). The default walk keeps <3 cm.
    expect(plantedSlideM(fast, 'R_Foot'), 'R stays planted when fast').toBeLessThan(0.05);
  });

  it('the COM vertical is calmed AND smooth — no sudden double-support drop', () => {
    // The raw floor-pin vault of the travelling walk is ~13.5 cm with a sharp V-drop into
    // double support (it even spiked UP just after contact). The vertical calibration +
    // phase smoothing calms the excursion and rounds the drop; the +2.5 cm rise clamp keeps
    // the stance foot planted. Assert both the calmer amplitude and the gentler descent.
    const frames = sampleTravel().frames;
    const ys = frames.map((f) => f.root.translateM[1]);
    const p2p = Math.max(...ys) - Math.min(...ys);
    expect(p2p, 'excursion calmed from the ~13.5 cm raw floor-pin vault').toBeLessThan(0.10);
    // Gentle descent: the biggest drop over any ~100 ms window is well under the raw ~7 cm.
    const total = frames[frames.length - 1]!.tMs;
    const perMs = total / (ys.length - 1);
    const win = Math.max(1, Math.round(100 / perMs));
    let maxDrop = 0;
    for (let i = win; i < ys.length; i += 1) maxDrop = Math.max(maxDrop, ys[i - win]! - ys[i]!);
    expect(maxDrop, 'no sudden vertical drop — the descent is rounded').toBeLessThan(0.06);
  });

  it('the swing foot still advances forward (the plant does not freeze the gait)', () => {
    const rec = sampleTravel();
    const dur = durOf(rec);
    // The RIGHT foot swings forward during the second half (its non-stance window).
    const zAt = (t: number) =>
      rec.frames.reduce((b, f) => (Math.abs(f.tMs - t) < Math.abs(b.tMs - t) ? f : b)).worldTracks!['R_Foot']![2];
    expect(zAt(dur * 0.98) - zAt(dur * 0.55), 'R foot advances in swing').toBeGreaterThan(0.1);
  });
});
