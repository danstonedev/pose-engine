/**
 * THE HAND-OVER — root travel keeps moving while the support passes from one
 * foot to the other (deriveFootDrivenTravel).
 *
 * Measured on a two-cycle 0.85-speed walk built on the travel builder, the
 * pelvis all but stopped at every hand-over — 0.37 and 0.26 cm in a 33 ms frame
 * against ~6 — and then lurched ~5.8 cm to catch up. Three causes, one per test
 * below: the switching sample advanced ZERO (at 120 samples over a 4 s walk that
 * is a whole frame); the switch was taken while the landing foot was still in
 * the air, so the root then tracked a foot that was still swinging; and through
 * heel rise the derivation followed the ankle rolling forward over the planted
 * forefoot, not the forefoot the plant holds.
 *
 * The unit tests drive the derivation with a synthetic walk whose WORLD motion
 * is known (the body at a constant 1.2 m/s, planted points world-fixed); the
 * rig test checks the stock walk's pelvis through its steady hand-over.
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
import { sampleComposedMotion } from '../services/motionRecording';
import { buildTravelWalk } from '../services/movementTemplates';
import { deriveFootDrivenTravel, type FeetZ, type FootGround, type GaitContactHold } from '../services/rootMotion';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

/** Body speed, m per ms (1.2 m/s). */
const V = 0.0012;
/** Ankle → forefoot (m). */
const FOOT = 0.14;

/** A foot's ground contacts from its WORLD ankle (z, height) and pitch θ (rad,
 *  + = heel up, rotating about the forefoot; − = toes up, about the heel),
 *  expressed in the BODY frame the derivation measures (body at V·t). */
function foot(t: number, azWorld: number, ah: number, pitch: number, x: number): FootGround {
  const az = azWorld - V * t;
  return {
    ax: x,
    az,
    ah,
    tx: x,
    tz: az + FOOT * Math.cos(pitch),
    th: Math.max(0, ah - FOOT * Math.sin(pitch)),
  };
}

const feetOf = (R: FootGround, L: FootGround, ground = true): FeetZ => ({
  rz: R.az,
  ry: R.ah,
  rx: R.ax,
  lz: L.az,
  ly: L.ah,
  lx: L.ax,
  ...(ground ? { ground: { R, L } } : {}),
});

/** Per-sample advance of a derived travel over its own sample times. */
function advances(travel: { zAt(t: number): number }, times: number[]): number[] {
  return times.slice(1).map((t, i) => travel.zAt(t) - travel.zAt(times[i]!));
}

/** Run the derivation and keep the times it sampled at. */
function derive(
  sample: (t: number) => FeetZ,
  totalMs: number,
  holds?: GaitContactHold[],
): { travel: ReturnType<typeof deriveFootDrivenTravel>; times: number[] } {
  const times: number[] = [];
  const travel = deriveFootDrivenTravel(
    (t) => {
      times.push(t);
      return sample(t);
    },
    totalMs,
    undefined,
    120,
    0,
    undefined,
    holds,
  );
  return { travel, times };
}

const smooth = (u: number): number => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};

describe('the hand-over: the pelvis keeps travelling while the support changes feet', () => {
  it('the sample that switches feet is measured on the foot that bore it, not skipped', () => {
    // Ankles only (no ground contacts): both feet down and both sweeping back at
    // body speed — double support — while the R heel rises clear of the L. The
    // measured decision hands over when R is 8 mm higher; that interval was
    // borne by R and must advance like every other one. It used to advance 0.
    const sample = (t: number): FeetZ => {
      const heel = 0.04 * smooth((t - 100) / 300);
      return feetOf(foot(t, 0, heel, 0, -0.1), foot(t, 0.6, 0, 0, 0.1), false);
    };
    const { travel, times } = derive(sample, 500);
    const adv = advances(travel, times);
    const dt = times[1]! - times[0]!;
    // eslint-disable-next-line no-console
    console.log(`ankles-only hand-over: min advance ${(Math.min(...adv) / (V * dt)).toFixed(3)} × body speed`);
    for (const a of adv) expect(a).toBeCloseTo(V * dt, 9);
  });

  it('with ground contacts the support passes as the landing foot reaches the floor, never stalling', () => {
    // R stands flat, rises onto its forefoot (held from 300 ms), toes off at
    // 650. L swings in — still moving forward in the world, slowing to rest at
    // touchdown (500 ms), 8 cm up 150 ms before — and is held from touchdown.
    const TD = 500;
    const c = (1.5 * V) / (2 * 150); // L's world speed 1.5 V at TD-150, 0 at TD
    const sample = (t: number): FeetZ => {
      const pitchR = t < 300 ? 0 : 0.6 * smooth((t - 300) / 350);
      const R = foot(t, FOOT - FOOT * Math.cos(pitchR), FOOT * Math.sin(pitchR), pitchR, -0.1);
      const before = Math.max(0, TD - t);
      const lz = 0.6 - c * before * before;
      const lh = t < TD ? 0.08 * Math.min(1, before / 150) ** 2 : 0;
      const L = foot(t, lz, lh, t < TD ? -0.25 * Math.min(1, before / 150) : 0, 0.1);
      return feetOf(R, L);
    };
    const holds: GaitContactHold[] = [
      { foot: 'R_Foot', fromMs: 0, toMs: 300 },
      { foot: 'R_Toes', fromMs: 300, toMs: 650 },
      { foot: 'L_Foot', fromMs: TD, toMs: 900 },
    ];
    const { travel, times } = derive(sample, 900, holds);
    const adv = advances(travel, times);
    const dt = times[1]! - times[0]!;
    const worst = Math.min(...adv) / (V * dt);
    // eslint-disable-next-line no-console
    console.log(`hand-over with ground contacts: min advance ${worst.toFixed(3)} × body speed`);
    // The landing foot is still slowing as it takes the weight, so the transfer
    // dips — to ~0.7 of body speed here; the switch used to stall it to 0.
    expect(worst).toBeGreaterThan(0.5);
    // Once down, the landing ankle is the planted point: world-fixed.
    const ankleWorld = (t: number): number => sample(t).lz + travel.zAt(t);
    const landed = times.filter((t) => t >= TD);
    for (const t of landed) expect(Math.abs(ankleWorld(t) - ankleWorld(landed[0]!))).toBeLessThan(1e-9);
  });

  it('through heel rise the forefoot the plant holds stays world-fixed, not the ankle rolling over it', () => {
    // R rolls 35° onto its forefoot; L is high in swing throughout. Following
    // the ankle, the body lags the planted forefoot by FOOT·(1 − cos 35°) =
    // 2.5 cm by toe-off.
    const sample = (t: number): FeetZ => {
      const pitch = 0.61 * smooth((t - 100) / 400);
      return feetOf(
        foot(t, FOOT - FOOT * Math.cos(pitch), FOOT * Math.sin(pitch), pitch, -0.1),
        foot(t, 0.3 + V * t, 0.12, 0, 0.1),
      );
    };
    const holds: GaitContactHold[] = [
      { foot: 'R_Foot', fromMs: 0, toMs: 100 },
      { foot: 'R_Toes', fromMs: 100, toMs: 500 },
    ];
    const { travel, times } = derive(sample, 500, holds);
    const toesWorld = (t: number): number => sample(t).ground!.R.tz + travel.zAt(t);
    const drift = Math.max(...times.map((t) => Math.abs(toesWorld(t) - toesWorld(0))));
    // eslint-disable-next-line no-console
    console.log(`heel rise: held forefoot drifts ${(drift * 100).toFixed(3)} cm`);
    expect(drift).toBeLessThan(1e-3);
  });

  it('samples at most 20 ms apart however long the motion', () => {
    // A fixed 120 samples fell one per 33 ms frame on a 4 s walk and one per
    // 84 ms on a 10 s one: the time resolution of the travel diluted with length.
    const still = (t: number): FeetZ => feetOf(foot(t, V * t, 0, 0, -0.1), foot(t, 0.5 + V * t, 0, 0, 0.1));
    for (const totalMs of [500, 4000, 10000]) {
      const { times } = derive(still, totalMs);
      const gaps = times.slice(1).map((t, i) => t - times[i]!);
      expect(Math.max(...gaps), `${totalMs} ms motion`).toBeLessThanOrEqual(20 + 1e-9);
      expect(times[times.length - 1]).toBeCloseTo(totalMs, 9);
    }
  });
});

// ── The stock walk, sampled on the rig ──────────────────────────────────────

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

describe('the stock walk on the rig: no stall at the steady hand-over', () => {
  it.each([0.85, 1, 1.3])('speed %s: the pelvis never slows below a fifth of its steady pace', (speed) => {
    root.position.copy(rootRest0);
    root.quaternion.copy(rootQuat0);
    root.updateMatrixWorld(true);
    const resolved = resolveComposedMotion(buildTravelWalk({ speed }), variantCfg);
    expect(resolved.status).toBe('ok');
    const rec = sampleComposedMotion(resolved, {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
    });
    const frames = rec.frames;
    // The steady window gaitSpatiotemporal measures — the end of keyframe [2] to
    // the end of [8] — on the trajectory clock the frames run on.
    const authoredMs = resolved.keyframes.reduce((s, k) => s + k.durationMs + (k.holdMs ?? 0), 0);
    const scale = frames[frames.length - 1]!.tMs / authoredMs;
    const ends: number[] = [];
    let acc = 0;
    for (const k of resolved.keyframes) {
      acc += k.durationMs + (k.holdMs ?? 0);
      ends.push(acc * scale);
    }
    const hips = (i: number): number[] => frames[i]!.worldTracks!.Hips!;
    const steps: { tMs: number; cm: number }[] = [];
    for (let i = 1; i < frames.length; i += 1) {
      if (frames[i]!.tMs < ends[2]! || frames[i]!.tMs > ends[8]!) continue;
      steps.push({ tMs: frames[i]!.tMs, cm: 100 * Math.hypot(hips(i)[0]! - hips(i - 1)[0]!, hips(i)[2]! - hips(i - 1)[2]!) });
    }
    const sorted = [...steps].sort((a, b) => a.cm - b.cm);
    const median = sorted[Math.floor(sorted.length / 2)]!.cm;
    const slowest = sorted[0]!;
    // eslint-disable-next-line no-console
    console.log(
      `walk ${speed}: pelvis ${median.toFixed(2)} cm/frame steady, slowest ${slowest.cm.toFixed(2)} at ${slowest.tMs.toFixed(0)} ms`,
    );
    // Measured before the fix: 0.21, 0.36 and 0.39 cm against 2.44, 2.08 and 3.16
    // (9-17%), each at the frame the support switched feet. After: ≥ 30%.
    expect(slowest.cm / median).toBeGreaterThan(0.2);
  });
});
