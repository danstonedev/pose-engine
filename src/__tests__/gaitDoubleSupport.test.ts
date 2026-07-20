/**
 * DOUBLE-SUPPORT GATE (roadmap 6.5 — regression armor) — the travel walk keeps
 * a PHYSIOLOGIC share of double support: both feet at floor height
 * simultaneously for ~15-25% of the steady stride (Perry & Burnfield: ~20%,
 * two ~10% transfer windows per cycle). A walk that never has both feet down
 * is a run; one that keeps both feet low most of the stride is a shuffle. This
 * pins the sampled rig behaviour so no future stance / vertical / foot-plant /
 * swing-trajectory change can silently break the gait's temporal structure.
 *
 * MEASUREMENT (kinematic, documented honestly):
 *   • A foot is AT FLOOR HEIGHT when ANY part of it — ankle (heel end) or toes
 *     (forefoot) — rides within a small band of its own quiet-standing rest
 *     height. Either end suffices because contact ROLLS: heel rocker at
 *     initial contact (toes up), foot flat, then heel-off with the forefoot
 *     down (toe rocker). An ankle-only test misreads the whole toe-stance as
 *     airborne; a rig has no force plates, so height is the contact proxy —
 *     the same limitation real kinematic gait analysis has (minimum swing toe
 *     clearance in human gait is 1-2 cm, inside any honest band, so a swing
 *     foot's lowest pass reads as floor-height there too; the share band below
 *     absorbs exactly that, on the rig as in a gait lab).
 *   • The window is the STEADY STRIDE, measured from the rig's own events —
 *     first swing lift-off to final landing — because the walk's authored
 *     initiation and feet-together termination are deliberately
 *     double-support-heavy standstill ramps that would inflate the share.
 *
 * Rig-measured baseline (straight travel walk, 60 Hz): steady stride
 * ~600..2250 ms; double-support share ~21% at the 1.5 cm band (stable 17-24%
 * across 1-2 cm bands), split ~22%/20% between the stride halves; the longest
 * run with NO foot at floor height (the stance foot riding the vault crest a
 * couple cm up while the swing foot is high) is ~180 ms — a blip, not a
 * ballistic flight phase.
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
import { buildTravelWalk } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rec: MotionRecording;

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
  const resolved = resolveComposedMotion(buildTravelWalk(), variantCfg);
  expect(resolved.status).toBe('ok');
  rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
  });
});

const track = (f: MotionRecording['frames'][number], key: string): [number, number, number] =>
  f.worldTracks![key]!;

/** "At floor height" band: some part of the foot within this of its standing
 *  rest height. 1.5 cm reads rolling contact (heel rocker / foot flat / toe
 *  rocker) as grounded while the vault-riding stance crest (~2-5 cm) and the
 *  swept swing foot stay out; the share is stable 17-24% across 1-2 cm. */
const FLOOR_BAND_M = 0.015;

/** Clear-of-floor threshold for the lift-off / landing EVENTS that bound the
 *  steady stride (well above the band, well below the ~7+ cm swing peak). */
const LIFT_BAND_M = 0.03;

/** Lowest point of a foot relative to its own quiet-standing rest — min over
 *  the ankle (heel end) and toes (forefoot), each against its frame-0 height. */
function minRelM(f: MotionRecording['frames'][number], side: 'R' | 'L'): number {
  const f0 = rec.frames[0]!;
  return Math.min(
    track(f, `${side}_Foot`)[1] - track(f0, `${side}_Foot`)[1],
    track(f, `${side}_Toes`)[1] - track(f0, `${side}_Toes`)[1],
  );
}

/** The steady stride [first lift-off, final landing], from the rig's own
 *  events — NOT the authored keyframe schedule, so a duration refactor cannot
 *  silently move the window off the walking portion. */
function steadyStride(): { fromMs: number; toMs: number } {
  let first = -1;
  let lastAir = -1;
  for (let i = 0; i < rec.frames.length; i += 1) {
    const air = minRelM(rec.frames[i]!, 'R') > LIFT_BAND_M || minRelM(rec.frames[i]!, 'L') > LIFT_BAND_M;
    if (air && first < 0) first = i;
    if (air) lastAir = i;
  }
  expect(first, 'the walk does lift a foot').toBeGreaterThanOrEqual(0);
  return {
    fromMs: rec.frames[first]!.tMs,
    toMs: rec.frames[Math.min(rec.frames.length - 1, lastAir + 1)]!.tMs,
  };
}

describe('6.5 — double-support duration gate (travel walk, steady stride)', () => {
  it('both feet are at floor height simultaneously for a physiologic ~15-25% of the stride', () => {
    const { fromMs, toMs } = steadyStride();
    const stride = rec.frames.filter((f) => f.tMs >= fromMs - 1e-6 && f.tMs <= toMs + 1e-6);
    expect(stride.length, 'a non-vacuous stride window').toBeGreaterThan(60);
    let both = 0;
    for (const f of stride) {
      if (minRelM(f, 'R') < FLOOR_BAND_M && minRelM(f, 'L') < FLOOR_BAND_M) both += 1;
    }
    const doubleShare = both / stride.length;
    // eslint-disable-next-line no-console
    console.log(
      `double support: ${(100 * doubleShare).toFixed(1)}% of the steady stride [${fromMs.toFixed(0)}..${toMs.toFixed(0)}ms] (${both}/${stride.length} frames)`,
    );
    // Perry: ~20% (2 × ~10%). The band admits healthy variation but rejects
    // both failure modes — a bounding walk whose feet never share the floor
    // (run-like) and a shuffling one whose feet are both low most of the time.
    expect(doubleShare, 'double support is present (not a run)').toBeGreaterThan(0.15);
    expect(doubleShare, 'double support stays a transfer share, not a shuffle').toBeLessThan(0.25);
  });

  it('each half of the stride carries its own double-support share (two windows per cycle)', () => {
    const { fromMs, toMs } = steadyStride();
    const midMs = (fromMs + toMs) / 2;
    const shareIn = (a: number, b: number): number => {
      const span = rec.frames.filter((f) => f.tMs >= a - 1e-6 && f.tMs <= b + 1e-6);
      let both = 0;
      for (const f of span) {
        if (minRelM(f, 'R') < FLOOR_BAND_M && minRelM(f, 'L') < FLOOR_BAND_M) both += 1;
      }
      return both / Math.max(1, span.length);
    };
    const firstHalf = shareIn(fromMs, midMs);
    const secondHalf = shareIn(midMs, toMs);
    // eslint-disable-next-line no-console
    console.log(
      `double support per stride half: first ${(100 * firstHalf).toFixed(1)}% · second ${(100 * secondHalf).toFixed(1)}%`,
    );
    // Both steps put both feet at floor height for a real share — neither
    // half-stride is a ballistic (run-like) exchange. Rig baseline ~22%/20%.
    expect(firstHalf, 'first half-stride shares the floor').toBeGreaterThan(0.1);
    expect(secondHalf, 'second half-stride shares the floor').toBeGreaterThan(0.1);
  });

  it('no sustained flight: any no-foot-at-floor-height run stays a blip', () => {
    // The stance foot occasionally rides the smoothed vertical's crest a
    // couple cm above its rest band (rig baseline: longest such run ~180 ms) —
    // but a WALK must never string them into a real ballistic flight phase.
    const { fromMs, toMs } = steadyStride();
    const stride = rec.frames.filter((f) => f.tMs >= fromMs - 1e-6 && f.tMs <= toMs + 1e-6);
    const stepMs = rec.frames[1]!.tMs - rec.frames[0]!.tMs;
    let run = 0;
    let maxRun = 0;
    for (const f of stride) {
      if (minRelM(f, 'R') >= FLOOR_BAND_M && minRelM(f, 'L') >= FLOOR_BAND_M) {
        run += 1;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
    }
    // eslint-disable-next-line no-console
    console.log(`longest no-contact run: ${(maxRun * stepMs).toFixed(0)}ms`);
    expect(maxRun * stepMs, 'no ballistic flight phase in a walk').toBeLessThan(300);
  });

  it('the walk starts and stops in sustained double support (standstill ramps)', () => {
    const { fromMs, toMs } = steadyStride();
    const shareIn = (a: number, b: number): number => {
      const span = rec.frames.filter((f) => f.tMs >= a - 1e-6 && f.tMs <= b + 1e-6);
      let both = 0;
      for (const f of span) {
        if (minRelM(f, 'R') < FLOOR_BAND_M && minRelM(f, 'L') < FLOOR_BAND_M) both += 1;
      }
      return both / Math.max(1, span.length);
    };
    const totalMs = rec.frames[rec.frames.length - 1]!.tMs;
    const initiation = shareIn(0, fromMs);
    const termination = shareIn(toMs, totalMs);
    // eslint-disable-next-line no-console
    console.log(
      `ramps: initiation double support ${(100 * initiation).toFixed(1)}% · termination ${(100 * termination).toFixed(1)}%`,
    );
    // The APA initiation keeps both feet down until the first swing lifts
    // (rig baseline ~89% — the step-off briefly rocks the stance foot onto its
    // heel, carrying the ankle a hair over the band), and the braking/settle
    // ends feet-together at rest height (gaitDynamics 3.5).
    expect(initiation, 'initiation is a grounded ramp').toBeGreaterThan(0.8);
    expect(termination, 'termination settles into double support').toBeGreaterThan(0.9);
  });
});
