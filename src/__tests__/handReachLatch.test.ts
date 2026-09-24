/**
 * THE HAND-REACH LATCH DOES NOT DEPEND ON WHICH FRAMES RAN — on both real rigs.
 *
 * A floor reach (plank, push-up, quadruped, bird-dog) pulls a descending hand
 * to the floor and latches the point where it gets there, so the hand then
 * stays put while the body lowers over it. The latch took the first FRAME
 * whose pulled hand was inside the 3 cm floor band, so the planted point — and
 * every settled pose after it — moved with the frames that ran: 30 and 120 Hz
 * settled up to 18 mm / 2.3° apart (the bird-dog), 59 mm / 6.0° in a chain
 * (press-up to quadruped after lowering to prone). Interpolating the crossing
 * between the frames either side of it left a self-heal, and the re-latch
 * after it, on the frame that found them: 10.4 mm / 1.1° in the female chain
 * at 30 and 120 Hz, 46 mm / 4.7° on a 40–95 ms clock.
 *
 * The latch is now settled on the motion's own clock
 * (footContact.settleHandReachLatches): the latch at the moment the pulled
 * hand touches the floor, found on the trajectory between frames; a self-heal
 * on a 5 ms grid of motion time. Every rate and clock below settles
 * identically.
 *
 * WHERE it latches moved with it: at the touch, not as the hand first comes
 * within 3 cm (a hand still travelling planted short of its landing). A hand
 * held short of where the route drives it punched deeper through the floor —
 * the push-up entered 7.3 cm under it latched at the band's edge, 6.2 on the
 * frame, 3.9 at the touch — so the last block holds the depth to the frame
 * latch's.
 *
 * What still moves the latch is the PATH: it plants where the hand reaches
 * the floor, so re-timing the arm between knots (motionStagger's
 * follow-through) still moves a hand-planted settle. That is the latch's
 * purpose — plant on contact, not at a point chosen mid-transition.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { DEFAULT_TRACKED_BONES, sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import { captureFloorReference } from '../services/rootMotion';
import {
  buildBirdDog,
  buildGetDownToPlank,
  buildGetDownToQuadruped,
  buildLowerToProne,
  buildPlankFromQuadruped,
  buildPressUpToQuadruped,
  buildPushUp,
  buildQuadrupedFromPlank,
  buildStandFromQuadruped,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

type Variant = 'male' | 'female';

interface Rig {
  variant: Variant;
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  rest: JointAngleRestReference;
  baselinePose: CustomPose;
  floorY: number;
  rootRest0: THREE.Vector3;
  rootQuat0: THREE.Quaternion;
}

const rigs = new Map<Variant, Rig>();

async function loadRig(variant: Variant): Promise<Rig> {
  const variantCfg = BODY_VARIANTS[variant];
  const url = new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url);
  const buf = readFileSync(fileURLToPath(url));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  const root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  let skinned: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const sk = skinned as unknown as THREE.SkinnedMesh;
  return {
    variant,
    root,
    skinned: sk,
    rest: captureJointAngleRestReference(sk.skeleton, variantCfg),
    baselinePose: serializeCustomPose(sk.skeleton, variantCfg, variant),
    floorY: captureFloorReference(sk.skeleton, variantCfg).floorY,
    rootRest0: root.position.clone(),
    rootQuat0: root.quaternion.clone(),
  };
}

beforeAll(async () => {
  for (const v of ['male', 'female'] as const) rigs.set(v, await loadRig(v));
});
// Each test here samples the rig synchronously for seconds. Yield to the
// event loop before each one: a file whose tests run over 60 s in all without
// a turn of it trips vitest's worker RPC timeout ("Timeout calling
// onTaskUpdate"), which fails the run although every test passed.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const TRACKED = [...new Set([...DEFAULT_TRACKED_BONES, 'L_Hand', 'R_Hand'])];
const ARM = ['L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm', 'L_Hand', 'R_Hand'];

function options(r: Rig, sampleHz: number, frameTimesMs?: number[]) {
  return {
    baselinePose: r.baselinePose,
    variantCfg: BODY_VARIANTS[r.variant],
    rest: r.rest,
    skeletonHarness: { root: r.root, skinned: r.skinned },
    sampleHz,
    trackedBones: TRACKED,
    ...(frameTimesMs ? { frameTimesMs } : {}),
  };
}

function reset(r: Rig): void {
  r.root.position.copy(r.rootRest0);
  r.root.quaternion.copy(r.rootQuat0);
  r.root.updateMatrixWorld(true);
}

function record(variant: Variant, motion: () => ComposedMotion, sampleHz: number, frameTimesMs?: number[]): MotionRecording {
  const r = rigs.get(variant)!;
  reset(r);
  const resolved = resolveComposedMotion(motion(), BODY_VARIANTS[variant]);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, options(r, sampleHz, frameTimesMs));
}

function recordChain(variant: Variant, segments: () => ComposedMotion[], sampleHz: number, frameTimesMs?: number[]): MotionRecording[] {
  const r = rigs.get(variant)!;
  reset(r);
  const parts = sampleMotionChain(segments(), options(r, sampleHz, frameTimesMs));
  for (const p of parts) expect(p.status).toBe('ok');
  return parts.map((p) => p.recording);
}

const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};

/** A stage-like clock: steps of 8–40 ms from a fixed seed, plus every 30 Hz
 *  frame time (so the recordings share frames to compare). */
function jitteredClock(totalMs: number, grid: readonly number[]): number[] {
  const next = seeded(12345);
  const times = new Set<number>(grid);
  for (let t = 0; t < totalMs; t += 8 + next() * 32) times.add(Math.round(t * 1000) / 1000);
  return [...times].sort((a, b) => a - b);
}

/** A coarse clock: steps of 40–95 ms (every one inside the release's 100 ms
 *  interpolation window, none on the 30 Hz grid), ending on the motion's end. */
function coarseClock(totalMs: number): number[] {
  const next = seeded(24680);
  const times: number[] = [];
  for (let t = 0; t < totalMs; t += 40 + next() * 55) times.push(Math.round(t * 1000) / 1000);
  times.push(totalMs);
  return times;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/** The largest hand distance (m) and arm-joint angle (°) between two frames. */
function apart(f: MotionRecording['frames'][number], g: MotionRecording['frames'][number]): { hand: number; arm: number } {
  let hand = 0;
  let arm = 0;
  for (const key of ['L_Hand', 'R_Hand']) {
    const a = f.worldTracks![key]!;
    const b = g.worldTracks![key]!;
    hand = Math.max(hand, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  for (const key of ARM) {
    const a = f.pose.bones[key]!;
    const b = g.pose.bones[key]!;
    arm = Math.max(arm, (_qa.set(a[0], a[1], a[2], a[3]).angleTo(_qb.set(b[0], b[1], b[2], b[3])) * 180) / Math.PI);
  }
  return { hand, arm };
}

/** Every frame `rec` shares with `base` (by time), compared. */
function sharedApart(base: MotionRecording, rec: MotionRecording): { shared: number; hand: number; arm: number } {
  let shared = 0;
  let hand = 0;
  let arm = 0;
  for (const f of base.frames) {
    const g = rec.frames.find((x) => Math.abs(x.tMs - f.tMs) < 1e-6);
    if (!g) continue;
    shared += 1;
    const d = apart(f, g);
    hand = Math.max(hand, d.hand);
    arm = Math.max(arm, d.arm);
  }
  return { shared, hand, arm };
}

/** Where the rates are held to agree: to the float noise of one pose solve. */
const HAND_AGREE_M = 1e-4;
const ARM_AGREE_DEG = 0.05;

describe('the hand-reach latch plants where the hand touched the floor, whichever frames ran', () => {
  const male: [string, () => ComposedMotion][] = [
    ['plank from quadruped', buildPlankFromQuadruped],
    ['quadruped from plank', buildQuadrupedFromPlank],
    ['press-up to quadruped', buildPressUpToQuadruped],
    ['get down to quadruped', buildGetDownToQuadruped],
    ['get down to plank', buildGetDownToPlank],
    ['push-up', buildPushUp],
    ['bird dog', buildBirdDog],
  ];
  const female: [string, () => ComposedMotion][] = [
    ['plank from quadruped', buildPlankFromQuadruped],
    ['press-up to quadruped', buildPressUpToQuadruped],
    ['push-up', buildPushUp],
    ['bird dog', buildBirdDog],
  ];
  for (const [variant, cases, rates] of [
    ['male', male, [60, 120]],
    ['female', female, [120]],
  ] as const) {
    for (const [name, motion] of cases) {
      const clocks = `${rates.join(' and ')} Hz${variant === 'male' ? ' and a jittered clock' : ''}`;
      it(`${variant} ${name}: 30 Hz, ${clocks} plant the hands alike on every shared frame, and a 40–95 ms clock settles alike`, () => {
        const base = record(variant, motion, 30);
        const grid = base.frames.map((f) => f.tMs);
        const totalMs = grid[grid.length - 1]!;
        const others: [string, MotionRecording][] = [
          ...rates.map((hz) => [`${hz} Hz`, record(variant, motion, hz)] as [string, MotionRecording]),
          ...(variant === 'male' ? [['jittered', record(variant, motion, 30, jitteredClock(totalMs, grid))] as [string, MotionRecording]] : []),
        ];
        for (const [label, rec] of others) {
          const d = sharedApart(base, rec);
          // eslint-disable-next-line no-console
          console.log(`${variant} ${name}, 30 Hz vs ${label}: ${d.shared} shared frames, hands within ${(d.hand * 1000).toFixed(3)} mm, arms within ${d.arm.toFixed(4)}°`);
          expect(d.shared, `${label} shares every 30 Hz frame`).toBe(base.frames.length);
          expect(d.hand, `${name}: hands, 30 Hz vs ${label} (m)`).toBeLessThan(HAND_AGREE_M);
          expect(d.arm, `${name}: arm joints, 30 Hz vs ${label} (°)`).toBeLessThan(ARM_AGREE_DEG);
        }
        const coarse = record(variant, motion, 30, coarseClock(totalMs));
        const end = apart(base.frames[base.frames.length - 1]!, coarse.frames[coarse.frames.length - 1]!);
        // eslint-disable-next-line no-console
        console.log(`${variant} ${name}, 30 Hz vs 40–95 ms clock (${coarse.frames.length} frames): settled hands within ${(end.hand * 1000).toFixed(3)} mm, arms within ${end.arm.toFixed(4)}°`);
        expect(end.hand, `${name}: settled hands, 30 Hz vs the coarse clock (m)`).toBeLessThan(HAND_AGREE_M);
        expect(end.arm, `${name}: settled arm joints, 30 Hz vs the coarse clock (°)`).toBeLessThan(ARM_AGREE_DEG);
        // …and a parked stage, which jumps from the start straight to the end
        // (ExamStage3D's hidden path): the bird-dog's replanted hand ended
        // 140 mm off when a jump over its lift read the old engagement on.
        const parked = record(variant, motion, 30, [0, totalMs]);
        const jump = apart(base.frames[base.frames.length - 1]!, parked.frames[parked.frames.length - 1]!);
        // eslint-disable-next-line no-console
        console.log(`${variant} ${name}, 30 Hz vs one jump to the end: settled hands within ${(jump.hand * 1000).toFixed(3)} mm, arms within ${jump.arm.toFixed(4)}°`);
        expect(jump.hand, `${name}: settled hands, 30 Hz vs one jump (m)`).toBeLessThan(HAND_AGREE_M);
        expect(jump.arm, `${name}: settled arm joints, 30 Hz vs one jump (°)`).toBeLessThan(ARM_AGREE_DEG);
      }, 180_000);
    }
  }
});

describe('…and through a chain, where a latch self-heals and re-latches', () => {
  // Lowering to prone leaves the arms where the press-up's first frame cannot
  // hold them: its hands self-heal and re-latch at once (on the frame that
  // found it, 33 / 17 / 84 ms in at 30 / 60 Hz / a coarse clock). The plank
  // from quadruped's hands self-heal ~210 ms in, on whichever frame saw it.
  const chains: [string, () => ComposedMotion[]][] = [
    ['plank → prone → press-up to quadruped → stand', () => [buildGetDownToPlank(), buildLowerToProne(), buildPressUpToQuadruped(), buildStandFromQuadruped()]],
    ['quadruped → plank → quadruped → stand', () => [buildGetDownToQuadruped(), buildPlankFromQuadruped(), buildQuadrupedFromPlank(), buildStandFromQuadruped()]],
  ];
  for (const variant of ['male', 'female'] as const) {
    for (const [name, segments] of chains) {
      it(`${variant} ${name}: every part plants alike at 30 and 120 Hz, and settles alike on a 40–95 ms clock`, () => {
        const base = recordChain(variant, segments, 30);
        const fine = recordChain(variant, segments, 120);
        const longest = Math.max(...base.map((p) => p.frames[p.frames.length - 1]!.tMs));
        const coarse = recordChain(variant, segments, 30, coarseClock(longest));
        const parked = recordChain(variant, segments, 30, [0, longest]);
        base.forEach((part, k) => {
          const d = sharedApart(part, fine[k]!);
          const partEnd = part.frames[part.frames.length - 1]!;
          const coarseEnd = coarse[k]!.frames.find((f) => Math.abs(f.tMs - partEnd.tMs) < 1e-6);
          expect(coarseEnd, `part ${k}: the coarse clock ends where the part does`).toBeDefined();
          const end = apart(partEnd, coarseEnd!);
          // eslint-disable-next-line no-console
          console.log(
            `${variant} ${name}, part ${k}: 30 vs 120 Hz over ${d.shared} frames, hands within ${(d.hand * 1000).toFixed(3)} mm, arms ${d.arm.toFixed(4)}°; ` +
              `settled vs the coarse clock ${(end.hand * 1000).toFixed(3)} mm, ${end.arm.toFixed(4)}°`,
          );
          expect(d.shared, `part ${k} shares every 30 Hz frame`).toBe(part.frames.length);
          expect(d.hand, `part ${k}: hands, 30 vs 120 Hz (m)`).toBeLessThan(HAND_AGREE_M);
          expect(d.arm, `part ${k}: arm joints, 30 vs 120 Hz (°)`).toBeLessThan(ARM_AGREE_DEG);
          expect(end.hand, `part ${k}: settled hands, 30 Hz vs the coarse clock (m)`).toBeLessThan(HAND_AGREE_M);
          expect(end.arm, `part ${k}: settled arm joints, 30 Hz vs the coarse clock (°)`).toBeLessThan(ARM_AGREE_DEG);
          const jump = apart(partEnd, parked[k]!.frames[parked[k]!.frames.length - 1]!);
          expect(jump.hand, `part ${k}: settled hands, 30 Hz vs one jump (m)`).toBeLessThan(HAND_AGREE_M);
          expect(jump.arm, `part ${k}: settled arm joints, 30 Hz vs one jump (°)`).toBeLessThan(ARM_AGREE_DEG);
        });
      }, 180_000);
    }
  }
});

describe('a hand latched at the touch punches no deeper through the floor than one latched on the frame', () => {
  // How far the hand bone gets below the floor plane at 60 Hz, cm — latched on
  // the first frame inside the 3 cm band (2504a7e), at the band's edge (the
  // crossing interpolated) and now at the touch:
  //                               male                      female
  //                       frame  band  touch        frame  band  touch
  //   push-up              6.20  7.25  3.92          5.74  5.75  4.05
  //   bird dog             6.68  7.47  5.57          7.37  7.37  7.37
  //   plank from quad      0.70  0.87  0.21          3.35  3.90  2.98
  //   press-up to quad     2.72  2.72  2.67          4.46  4.46  4.49
  //   get down to quad     1.65  1.50  1.79          1.65  1.62  1.89
  // A hand latched short of where the route drives it is held back while the
  // route plunges it on (the push-up enters from standing: the route's hand
  // ends 18 cm under the floor), and the four-pass hold loses more of it. The
  // get-down's hands latch later at the touch, 1–2 mm deeper.
  const FRAME: Record<Variant, Record<string, number>> = {
    male: { 'push-up': 0.062, 'bird dog': 0.0668, 'plank from quadruped': 0.007, 'press-up to quadruped': 0.0272, 'get down to quadruped': 0.0165 },
    female: { 'push-up': 0.0574, 'bird dog': 0.0737, 'plank from quadruped': 0.0335, 'press-up to quadruped': 0.0446, 'get down to quadruped': 0.0165 },
  };
  const motions: [string, () => ComposedMotion][] = [
    ['push-up', buildPushUp],
    ['bird dog', buildBirdDog],
    ['plank from quadruped', buildPlankFromQuadruped],
    ['press-up to quadruped', buildPressUpToQuadruped],
    ['get down to quadruped', buildGetDownToQuadruped],
  ];
  for (const variant of ['male', 'female'] as const) {
    it(`${variant}: within 3 mm of the frame latch's depth everywhere, and the push-up's entry over 1.5 cm shallower`, () => {
      const floorY = rigs.get(variant)!.floorY;
      for (const [name, motion] of motions) {
        const rec = record(variant, motion, 60);
        let depth = -Infinity;
        for (const f of rec.frames) {
          for (const key of ['L_Hand', 'R_Hand']) depth = Math.max(depth, floorY - f.worldTracks![key]![1]);
        }
        const frame = FRAME[variant][name]!;
        // eslint-disable-next-line no-console
        console.log(`${variant} ${name} @60 Hz: hand down to ${(depth * 100).toFixed(2)} cm below the floor (latched on the frame: ${(frame * 100).toFixed(2)})`);
        expect(depth, `${name}: depth below the floor (m)`).toBeLessThanOrEqual(frame + 0.003);
        if (name === 'push-up') expect(depth, 'the push-up’s entry (m)').toBeLessThan(frame - 0.015);
      }
    }, 180_000);
  }
});

describe('reading the latch on the motion’s clock costs a parked stage under 1.75× what 5c1c9ac’s jump did', () => {
  // The stage's parked (hidden) path settles a command synchronously, from
  // settle to settle — a single jump for a one-keyframe command. The latch
  // walk this replaced read every 5 ms of any frame gap over 100 ms: one jump
  // over the male push-up cost 1.33 s, more than recording all 271 of its 60
  // Hz frames (5c1c9ac: 10 ms, but its latch moved with the frames that ran).
  //
  // 5c1c9ac's own jump, as a share of THIS tree's 60 Hz recording of the same
  // motion — both the best of several runs in one process on one machine, so
  // the share holds on a faster or slower one (this tree records a frame
  // ~3.3× faster than 5c1c9ac, which is why the shares are small):
  //                              male    female     (5c1c9ac's jump, ms)
  //   push-up                   0.0396   0.0376     9.5 / 9.7
  //   bird dog                  0.0671   0.0677     8.9 / 9.0
  //   bird dog, left, two reps  0.0393   0.0385     9.3 / 9.6
  //   plank from quadruped      0.162    0.167      8.3 / 8.6
  //   quadruped from plank      0.174    0.144      8.2 / 7.9
  //   press-up to quadruped     0.139    0.122      8.6 / 8.0
  //   get down to quadruped     1.50     1.30     122.7 / 109.5
  //   get down to plank         1.06     1.19     118.9 / 110.2
  // Measured the same way, this tree's jump is 1.1–1.5× 5c1c9ac's for the
  // first six (the push-up 1.1–1.4×, the bird dog's two reps 1.35–1.5×;
  // ±15% run to run on a shared machine) and a fifth of it for the last two.
  // It was 1.5–2.1× (the push-ups 1.8–1.9×, the female bird dog's two reps
  // 2.0×) before a planted hand was read up to 600 ms apart and two hands
  // landing together shared their touch solve
  // (footContact HAND_LATCH_PLANTED_MAX_STEP_MS, nextTouchProbe); the walk
  // before that, 70–140×. The aim is 1.5×; the bound, 1.75×, leaves room for
  // timing noise on a loaded machine.
  const MAIN_SHARE: Record<Variant, Record<string, number>> = {
    male: {
      'push-up': 0.0396,
      'bird dog': 0.0671,
      'bird dog, left, two reps': 0.0393,
      'plank from quadruped': 0.162,
      'quadruped from plank': 0.174,
      'press-up to quadruped': 0.139,
      'get down to quadruped': 1.5,
      'get down to plank': 1.06,
    },
    female: {
      'push-up': 0.0376,
      'bird dog': 0.0677,
      'bird dog, left, two reps': 0.0385,
      'plank from quadruped': 0.167,
      'quadruped from plank': 0.144,
      'press-up to quadruped': 0.122,
      'get down to quadruped': 1.3,
      'get down to plank': 1.19,
    },
  };
  const motions: [string, () => ComposedMotion][] = [
    ['push-up', buildPushUp],
    ['bird dog', buildBirdDog],
    ['bird dog, left, two reps', () => buildBirdDog({ side: 'L', reps: 2 })],
    ['plank from quadruped', buildPlankFromQuadruped],
    ['quadruped from plank', buildQuadrupedFromPlank],
    ['press-up to quadruped', buildPressUpToQuadruped],
    ['get down to quadruped', buildGetDownToQuadruped],
    ['get down to plank', buildGetDownToPlank],
  ];
  for (const variant of ['male', 'female'] as const) {
    it(`${variant}: one jump over each hand-planted motion costs under 1.75× 5c1c9ac’s share of its 60 Hz recording`, () => {
      const r = rigs.get(variant)!;
      // The sampling alone is timed (the motion resolved once), as 5c1c9ac's was.
      const time = (resolved: ReturnType<typeof resolveComposedMotion>, runs: number, frameTimesMs?: number[]): number => {
        let best = Infinity;
        for (let k = 0; k < runs; k += 1) {
          reset(r);
          const t0 = performance.now();
          sampleComposedMotion(resolved, options(r, 60, frameTimesMs));
          best = Math.min(best, performance.now() - t0);
        }
        return best;
      };
      for (const [name, motion] of motions) {
        const resolved = resolveComposedMotion(motion(), BODY_VARIANTS[variant]);
        expect(resolved.status).toBe('ok');
        const totalMs = record(variant, motion, 60).frames.at(-1)!.tMs;
        // Interleaved, so a burst of load on the machine lands on both.
        let full = Infinity;
        let jump = Infinity;
        for (let k = 0; k < 3; k += 1) {
          full = Math.min(full, time(resolved, 1));
          jump = Math.min(jump, time(resolved, 4, [0, totalMs]));
        }
        const main = MAIN_SHARE[variant][name]! * full;
        // eslint-disable-next-line no-console
        console.log(
          `${variant} ${name}: 60 Hz ${full.toFixed(1)} ms, one jump ${jump.toFixed(1)} ms — ` +
            `${(jump / main).toFixed(2)}× 5c1c9ac's (${main.toFixed(1)} ms at its share)`,
        );
        expect(jump, `${name}: one jump against 1.75× 5c1c9ac's`).toBeLessThan(1.75 * main);
      }
    }, 180_000);
  }
});
