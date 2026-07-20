/**
 * PERSISTENT-HEADING GATE (SEAM-1 — the turn→walk unwind, the pipeline
 * diagnostics' worst visible glitch). Before the fix, a travel walk chained
 * after buildTurnInPlace({degrees:180}) authored ABSOLUTE root yaw (heading 0),
 * so on frame one the stance hip wrenched 0→+134°, R_Toes teleported
 * +32 cm/frame, the body whipped 178→0° in <50 ms, and the model walked off +Z
 * — the PRE-turn direction. The fix generalizes the TUG chain's rebase into
 * the engine: gait builders flag `inheritHeading`, and `resolveComposedMotion`
 * rebases a flagged `startFrom:'current'` motion by the live entry yaw
 * (threaded via ResolveComposedOptions.currentRoot — sampleMotionChain does).
 *
 * Rig-gated non-negotiables:
 *   1. Across the turn→walk seam the body yaw moves < 5°/frame (was 178° in
 *      <50 ms) — through the WHOLE walk, not just the boundary frame.
 *   2. Feet/toes move < 5 cm/frame through the seam window (was 32 cm/frame).
 *   3. The walk's net travel is within ~15° of the POST-turn facing (≈ −Z
 *      after a 180° turn from rest) — never the pre-turn +Z.
 *   4. A plain walk from rest (identity entry yaw) is BYTE-IDENTICAL to main:
 *      rebase by 0 is a no-op at the resolver AND on the sampled rig, and the
 *      guards (no flag / 'neutral' start / no threaded root) all skip.
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
import {
  offsetMotionTranslate,
  rebaseMotionYaw,
  resolveComposedMotion,
  rootYawDegFromQuat,
  type ComposedMotion,
} from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording, type RecordedFrame } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import { buildFigureEightWalk, buildTravelWalk, buildTravelRun, buildTurnInPlace } from '../services/movementTemplates';
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

/** The sampler captures the current root as its rest — reset before each run. */
function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

function harness(sampleHz = 60) {
  return {
    baselinePose, variantCfg, rest,
    skeletonHarness: { root, skinned },
    sampleHz,
  } as const;
}

/** World yaw (deg) of the body's forward vector at a frame. */
function bodyYawDeg(f: RecordedFrame): number {
  const q = new THREE.Quaternion(...f.root.orientQuat);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return (Math.atan2(fwd.x, fwd.z) * 180) / Math.PI;
}

/** Wrap-aware absolute yaw difference (deg) — 179.9 vs −179.9 is 0.2, not 359.8. */
function yawDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const track = (f: RecordedFrame, key: string): [number, number, number] => f.worldTracks![key]!;

/** Max per-frame world displacement (m) of a tracked bone over consecutive
 *  frame pairs (the teleport metric). */
function maxTrackStepM(pairs: [RecordedFrame, RecordedFrame][], key: string): number {
  let worst = 0;
  for (const [a, b] of pairs) {
    const pa = track(a, key);
    const pb = track(b, key);
    worst = Math.max(worst, Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]));
  }
  return worst;
}

/** Identity-entry root (a body standing at rest, facing +Z). */
const IDENTITY_ROOT = {
  quat: [0, 0, 0, 1] as [number, number, number, number],
  translateM: [0, 0, 0] as [number, number, number],
};

/** Root quat for a pure world yaw (deg). */
function yawRoot(yawDeg: number) {
  const h = (yawDeg * Math.PI) / 360;
  return {
    quat: [0, Math.sin(h), 0, Math.cos(h)] as [number, number, number, number],
    translateM: [0, 0, 0] as [number, number, number],
  };
}

describe('turn 180° → travel walk: the walk continues the POST-turn heading (SEAM-1)', () => {
  let turnRec: MotionRecording;
  let walkRec: MotionRecording;
  let turnEndYaw: number;

  beforeAll(() => {
    resetHarness();
    const segs = sampleMotionChain(
      [buildTurnInPlace({ degrees: 180 }), buildTravelWalk()],
      harness(60),
    );
    expect(segs).toHaveLength(2);
    expect(segs.every((s) => s.status === 'ok')).toBe(true);
    turnRec = segs[0]!.recording;
    walkRec = segs[1]!.recording;
    turnEndYaw = bodyYawDeg(turnRec.frames[turnRec.frames.length - 1]!);
  }, 240000);

  it('the turn actually turned (~180°) — the seam premise is real', () => {
    expect(yawDiff(turnEndYaw, 180), 'turn ends facing ~180°').toBeLessThan(10);
  });

  it('gate 1 — body yaw moves < 5°/frame across the seam and through the whole walk (was 178° in <50 ms)', () => {
    const frames = [turnRec.frames[turnRec.frames.length - 1]!, ...walkRec.frames];
    let worst = 0;
    let atMs = 0;
    for (let i = 1; i < frames.length; i += 1) {
      const d = yawDiff(bodyYawDeg(frames[i]!), bodyYawDeg(frames[i - 1]!));
      if (d > worst) {
        worst = d;
        atMs = frames[i]!.tMs;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`turn→walk: worst yaw step ${worst.toFixed(2)}°/frame at walk t=${atMs}ms`);
    expect(worst, 'no yaw whip anywhere in the walk').toBeLessThan(5);
  });

  it('gate 2 — feet/toes move < 5 cm/frame through the seam window (was 32 cm/frame)', () => {
    // The whip lived in the seam frame + the first frames of the walk (the
    // measured teleport was inside 50 ms): gate the boundary pair and every
    // pair through the 400 ms APA initiation — quiet standing weight shift,
    // nothing may move fast there. (Beyond it the step-off swing legitimately
    // approaches ~5 cm/frame at 60 Hz — that is gait, not a seam.)
    const seamPairs: [RecordedFrame, RecordedFrame][] = [
      [turnRec.frames[turnRec.frames.length - 1]!, walkRec.frames[0]!],
    ];
    for (let i = 1; i < walkRec.frames.length && walkRec.frames[i]!.tMs <= 400; i += 1) {
      seamPairs.push([walkRec.frames[i - 1]!, walkRec.frames[i]!]);
    }
    for (const key of ['R_Toes', 'L_Toes', 'R_Foot', 'L_Foot'] as const) {
      const worst = maxTrackStepM(seamPairs, key);
      // eslint-disable-next-line no-console
      console.log(`turn→walk seam: ${key} worst step ${(100 * worst).toFixed(2)} cm/frame`);
      expect(worst, `${key} does not teleport at the seam`).toBeLessThan(0.05);
    }
  });

  it('gate 3 — the walk travels within ~15° of the POST-turn facing (−Z), not the pre-turn +Z', () => {
    const first = walkRec.frames[0]!;
    const last = walkRec.frames[walkRec.frames.length - 1]!;
    const h0 = track(first, 'Hips');
    const h1 = track(last, 'Hips');
    const dx = h1[0] - h0[0];
    const dz = h1[2] - h0[2];
    const dist = Math.hypot(dx, dz);
    const travelYaw = (Math.atan2(dx, dz) * 180) / Math.PI;
    // eslint-disable-next-line no-console
    console.log(
      `turn→walk: net travel ${dist.toFixed(2)} m at ${travelYaw.toFixed(1)}° (post-turn facing ${turnEndYaw.toFixed(1)}°)`,
    );
    expect(dist, 'the walk genuinely travels').toBeGreaterThan(0.8);
    expect(dz, 'travel is away (−Z-ish), never the pre-turn +Z').toBeLessThan(0);
    expect(yawDiff(travelYaw, turnEndYaw), 'travel aligns with the post-turn facing').toBeLessThan(15);
  });

  it('the walk ends still facing the post-turn heading (no unwind during the walk)', () => {
    const endYaw = bodyYawDeg(walkRec.frames[walkRec.frames.length - 1]!);
    expect(yawDiff(endYaw, turnEndYaw), 'facing persists through the walk').toBeLessThan(10);
  });
});

describe('turn → turn: the second turn carries the live facing forward (180 → 360)', () => {
  it('two chained 180° turns come full circle without a snap between them', () => {
    resetHarness();
    const segs = sampleMotionChain(
      [buildTurnInPlace({ degrees: 180 }), buildTurnInPlace({ degrees: 180 })],
      harness(30),
    );
    expect(segs.every((s) => s.status === 'ok')).toBe(true);
    const a = segs[0]!.recording;
    const b = segs[1]!.recording;
    // Yaw is continuous across the seam and through the second turn.
    const frames = [a.frames[a.frames.length - 1]!, ...b.frames];
    let worst = 0;
    for (let i = 1; i < frames.length; i += 1) {
      worst = Math.max(worst, yawDiff(bodyYawDeg(frames[i]!), bodyYawDeg(frames[i - 1]!)));
    }
    // 30 Hz sampling of a step turn pivots a few °/frame; the pre-fix snap was
    // a wholesale unwind (~180° inside one lift keyframe).
    expect(worst, 'no yaw snap at the turn→turn seam').toBeLessThan(8);
    // The second turn ENDS back at the entry facing (180 + 180 ≡ 360 ≡ 0)…
    const endYaw = bodyYawDeg(b.frames[b.frames.length - 1]!);
    expect(yawDiff(endYaw, 0), 'full circle').toBeLessThan(10);
    // …and passes through the far side (≈ 270°/−90°) on the way — it kept
    // turning the same way, it did not re-play 0→180.
    const passesFarSide = b.frames.some((f) => yawDiff(bodyYawDeg(f), -90) < 25);
    expect(passesFarSide, 'the second turn continues 180→360').toBe(true);
  }, 240000);
});

describe('gate 4 — rebase by 0 is a no-op: plain gaits from rest are byte-identical', () => {
  it('resolver: identity entry root, unthreaded root, and neutral start all leave the walk untouched', () => {
    const plain = resolveComposedMotion(buildTravelWalk(), variantCfg);
    expect(plain.status).toBe('ok');
    // Identity entry (a body at rest, facing +Z): rebase by 0 — byte-identical.
    const identity = resolveComposedMotion(buildTravelWalk(), variantCfg, { currentRoot: IDENTITY_ROOT });
    expect(JSON.stringify(identity)).toBe(JSON.stringify(plain));
    // Sub-epsilon entry yaw (numeric noise off a prior grounded motion): skipped.
    const noise = resolveComposedMotion(buildTravelWalk(), variantCfg, { currentRoot: yawRoot(0.004) });
    expect(JSON.stringify(noise)).toBe(JSON.stringify(plain));
    // Unflagged motion: a live 180° yaw never rotates it (opt-in only).
    const unflagged: ComposedMotion = { ...buildTravelWalk() };
    delete unflagged.inheritHeading;
    const unflaggedPlain = resolveComposedMotion(unflagged, variantCfg);
    const unflaggedTurned = resolveComposedMotion(unflagged, variantCfg, { currentRoot: yawRoot(180) });
    expect(JSON.stringify(unflaggedTurned)).toBe(JSON.stringify(unflaggedPlain));
    // 'neutral' start: the motion returns to anatomic first — never rebased.
    const neutral: ComposedMotion = { ...buildTravelWalk(), startFrom: 'neutral' };
    const neutralPlain = resolveComposedMotion(neutral, variantCfg);
    const neutralTurned = resolveComposedMotion(neutral, variantCfg, { currentRoot: yawRoot(180) });
    expect(JSON.stringify(neutralTurned)).toBe(JSON.stringify(neutralPlain));
    // The run carries the same contract.
    const runPlain = resolveComposedMotion(buildTravelRun(), variantCfg);
    const runIdentity = resolveComposedMotion(buildTravelRun(), variantCfg, { currentRoot: IDENTITY_ROOT });
    expect(runPlain.status).toBe('ok');
    expect(JSON.stringify(runIdentity)).toBe(JSON.stringify(runPlain));
  });

  it('a motion authored FOR its entry heading rebases by 0 (the TUG walk-back / figure-eight contract)', () => {
    // headingDeg 180 entered facing 180: delta = 0 — as authored, byte-identical.
    const back = buildTravelWalk({ headingDeg: 180 });
    const backPlain = resolveComposedMotion(back, variantCfg);
    const backAtEntry = resolveComposedMotion(back, variantCfg, { currentRoot: yawRoot(180) });
    expect(backPlain.status).toBe('ok');
    expect(JSON.stringify(backAtEntry)).toBe(JSON.stringify(backPlain));
    // Figure-eight lobe B (headingDeg 120, turnDeg −120) entered at +120: same.
    const [, lobeB] = buildFigureEightWalk();
    const lobePlain = resolveComposedMotion(lobeB, variantCfg);
    const lobeAtEntry = resolveComposedMotion(lobeB, variantCfg, { currentRoot: yawRoot(120) });
    expect(lobePlain.status).toBe('ok');
    expect(JSON.stringify(lobeAtEntry)).toBe(JSON.stringify(lobePlain));
  });

  it('rig: the sampled plain walk is frame-for-frame identical with and without a threaded identity root', () => {
    resetHarness();
    const plain = resolveComposedMotion(buildTravelWalk(), variantCfg);
    const recPlain = sampleComposedMotion(plain, harness(30));
    resetHarness();
    const identity = resolveComposedMotion(buildTravelWalk(), variantCfg, { currentRoot: IDENTITY_ROOT });
    const recIdentity = sampleComposedMotion(identity, harness(30));
    expect(JSON.stringify(recIdentity.frames)).toBe(JSON.stringify(recPlain.frames));
  }, 240000);
});

describe('the rebase helpers are pure and honest (unit level, no rig)', () => {
  it('rebaseMotionYaw(m, 0) and offsetMotionTranslate(m, 0, 0) are the identity', () => {
    const m = buildTravelWalk();
    expect(rebaseMotionYaw(m, 0)).toBe(m);
    expect(offsetMotionTranslate(m, 0, 0)).toBe(m);
  });

  it('rebaseMotionYaw rotates yaw keys, translates, and the travel plumbing together', () => {
    const walk = buildTravelWalk();
    const rb = rebaseMotionYaw(walk, 180);
    expect(rb).not.toBe(walk);
    // Every authored yaw key gains the offset (the initiation authored 0 → 180).
    for (const [i, kf] of rb.keyframes.entries()) {
      const orig = walk.keyframes[i]!;
      if (orig.root?.orient?.yawDeg != null) {
        expect(kf.root?.orient?.yawDeg).toBeCloseTo(orig.root.orient.yawDeg + 180, 9);
      }
    }
    // The APA shift (−X toward the R stance foot) rotates to +X after 180°.
    const apaOrig = walk.keyframes[0]!.root!.translateM!;
    const apaRb = rb.keyframes[0]!.root!.translateM!;
    expect(apaRb[0]).toBeCloseTo(-apaOrig[0], 6);
    expect(apaRb[2]).toBeCloseTo(-apaOrig[2], 6);
    expect(apaRb[1]).toBeCloseTo(apaOrig[1], 12); // Y untouched
    // The travel heading follows (0 → 180), so the plant-clamp rest rotation,
    // the travel ride and the shuttle perpendicular all rotate with the plan.
    expect(rb.headingDeg).toBeCloseTo(180, 9);
    // The input was not mutated.
    expect(walk.headingDeg).toBeUndefined();
    // A curved walk's heading profile rotates point-for-point.
    const arc = buildTravelWalk({ turnDeg: 90 });
    const arcRb = rebaseMotionYaw(arc, 180);
    for (const [i, p] of arcRb.headingProfileMs!.entries()) {
      expect(p.headingDeg).toBeCloseTo(arc.headingProfileMs![i]!.headingDeg + 180, 9);
      expect(p.tMs).toBe(arc.headingProfileMs![i]!.tMs);
    }
  });

  it('rebaseMotionYaw never sprouts a heading on a non-travelling motion (the turn)', () => {
    const turn = buildTurnInPlace({ degrees: 180 });
    const rb = rebaseMotionYaw(turn, 180);
    expect(rb.headingDeg).toBeUndefined();
    expect(rb.keyframes[rb.keyframes.length - 1]!.root!.orient!.yawDeg).toBeCloseTo(360, 9);
  });

  it('offsetMotionTranslate shifts only authored translates, X/Z only', () => {
    const turn = buildTurnInPlace({ degrees: 180 });
    const off = offsetMotionTranslate(turn, 0.5, -1.5);
    for (const [i, kf] of off.keyframes.entries()) {
      const orig = turn.keyframes[i]!;
      if (orig.root?.translateM) {
        expect(kf.root!.translateM![0]).toBeCloseTo(orig.root.translateM[0] + 0.5, 12);
        expect(kf.root!.translateM![1]).toBeCloseTo(orig.root.translateM[1], 12);
        expect(kf.root!.translateM![2]).toBeCloseTo(orig.root.translateM[2] - 1.5, 12);
      } else {
        expect(kf.root?.translateM).toBeUndefined();
      }
    }
  });

  it('rootYawDegFromQuat reads the root-yaw convention and refuses undefined headings', () => {
    expect(rootYawDegFromQuat([0, 0, 0, 1])).toBeCloseTo(0, 9);
    expect(rootYawDegFromQuat(yawRoot(90).quat)).toBeCloseTo(90, 6);
    expect(rootYawDegFromQuat(yawRoot(-135).quat)).toBeCloseTo(-135, 6);
    // Supine (pitch −90): the forward axis points vertical — heading undefined.
    const supine = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
    expect(rootYawDegFromQuat([supine.x, supine.y, supine.z, supine.w])).toBeNull();
    expect(rootYawDegFromQuat(null)).toBeNull();
    expect(rootYawDegFromQuat([Number.NaN, 0, 0, 1])).toBeNull();
  });
});
