/**
 * CURVED-WALK GATE (roadmap 6.2) — buildTravelWalk(opts.turnDeg) walks a gentle
 * constant-rate ARC: the authored root yaw progresses from the initiation
 * heading to heading+turnDeg across the cycle keyframes (braking/settle hold
 * the exit heading), the published heading profile (`headingProfileMs`) drives
 * the travel derivation ALONG THE HEADING AT EACH TIME (an arc, not a line)
 * with the shuttle on the instantaneous perpendicular, and each foot-plant
 * window's IK clamp frame is rotated by the heading at that window's start.
 *
 * Rig-gated non-negotiables:
 *   • turnDeg 0 (or omitted) is BYTE-IDENTICAL to the straight walk — at the
 *     builder, the resolver, AND the sampled recording;
 *   • turnDeg 90 ends with the body FACING ~90° off the start, the net
 *     displacement is a genuine curve (|X| and |Z| both substantial; the path
 *     midpoint deviates from the start→end chord), every stance foot stays
 *     planted (gentle-arc slide budget), and the vertical/head gates stay
 *     green (no worse than the straight walk's own budgets);
 *   • buildFigureEightWalk() returns two arc walks that resolve + compose,
 *     the second REVERSING the turn back to the entry heading.
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
import { sampleMotionChain } from '../services/movementChain';
import { buildFigureEightWalk, buildTravelWalk } from '../services/movementTemplates';
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

function harness() {
  return {
    baselinePose, variantCfg, rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  } as const;
}

interface CurvedSample {
  rec: MotionRecording;
  resolved: ReturnType<typeof resolveComposedMotion>;
}

function sampleWalk(opts: Parameters<typeof buildTravelWalk>[0] = {}): CurvedSample {
  resetHarness();
  const resolved = resolveComposedMotion(buildTravelWalk(opts), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, harness());
  return { rec, resolved };
}

const track = (f: MotionRecording['frames'][number], key: string): [number, number, number] =>
  f.worldTracks![key]!;

/** World yaw (deg) of the body's forward vector at a frame — the rest forward
 *  (+Z) rotated by the recorded root orientation. */
function bodyYawDeg(f: MotionRecording['frames'][number]): number {
  const q = new THREE.Quaternion(...f.root.orientQuat);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return (Math.atan2(fwd.x, fwd.z) * 180) / Math.PI;
}

/** Worst horizontal slide of a foot across its AUTHORED stance windows (the
 *  spans the walk declares the foot weight-bearing and IK-pins it) — the same
 *  honest planted metric gaitHeading.test.ts uses; measureContactSlide is
 *  planar XZ, so it is heading-agnostic. */
function plantedSlideM(sample: CurvedSample, foot: 'R_Foot' | 'L_Foot'): number {
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

describe('buildTravelWalk turnDeg — the walk curves along a per-time heading (roadmap 6.2)', () => {
  it('turnDeg 0 is BYTE-IDENTICAL to the straight walk (builder, resolver, and sampled rig)', () => {
    // Builder: same plan, no extra fields (turn 0 IS the default).
    expect(JSON.stringify(buildTravelWalk({ turnDeg: 0 }))).toBe(JSON.stringify(buildTravelWalk()));
    expect('headingProfileMs' in buildTravelWalk()).toBe(false);
    expect('headingProfileMs' in buildTravelWalk({ turnDeg: 0 })).toBe(false);
    // Resolver: the resolved motion carries no profile either way.
    const r0 = resolveComposedMotion(buildTravelWalk({ turnDeg: 0 }), variantCfg);
    const rPlain = resolveComposedMotion(buildTravelWalk(), variantCfg);
    expect(JSON.stringify(r0)).toBe(JSON.stringify(rPlain));
    expect(r0.headingProfileMs).toBeUndefined();
    // Rig: the sampled recordings are byte-identical frame streams.
    const rec0 = sampleWalk({ turnDeg: 0 }).rec;
    const recPlain = sampleWalk().rec;
    expect(JSON.stringify(rec0.frames)).toBe(JSON.stringify(recPlain.frames));
  });

  it('the turn is clamped to the gentle-arc band (±120)', () => {
    const over = buildTravelWalk({ turnDeg: 500 });
    const prof = over.headingProfileMs!;
    expect(prof[prof.length - 1]!.headingDeg).toBe(120);
    const under = buildTravelWalk({ turnDeg: -500 });
    expect(under.headingProfileMs![under.headingProfileMs!.length - 1]!.headingDeg).toBe(-120);
  });

  describe('turnDeg 90 (a quarter-circle to the subject\'s left)', () => {
    let sample: CurvedSample;
    let rec: MotionRecording;
    let straight: CurvedSample;
    beforeAll(() => {
      sample = sampleWalk({ turnDeg: 90 });
      rec = sample.rec;
      straight = sampleWalk();
    });

    it('ends with the body FACING ~90° off the start (world forward-vector yaw)', () => {
      const yaw0 = bodyYawDeg(rec.frames[0]!);
      const yawEnd = bodyYawDeg(rec.frames[rec.frames.length - 1]!);
      // eslint-disable-next-line no-console
      console.log(`turn 90: start yaw ${yaw0.toFixed(1)}° · end yaw ${yawEnd.toFixed(1)}°`);
      expect(Math.abs(yaw0), 'starts facing straight ahead').toBeLessThan(5);
      expect(Math.abs(yawEnd - 90), 'ends facing the turned heading').toBeLessThan(10);
    });

    it('the net displacement is a CURVE: |X| and |Z| both substantial, midpoint off the chord', () => {
      const first = track(rec.frames[0]!, 'Hips');
      const last = track(rec.frames[rec.frames.length - 1]!, 'Hips');
      const dX = last[0] - first[0];
      const dZ = last[2] - first[2];
      // Max perpendicular deviation of the pelvis path from the start→end chord
      // — a straight walk hugs its chord (shuttle-scale cm); an arc bows out.
      const chord = Math.hypot(dX, dZ);
      let maxDev = 0;
      for (const f of rec.frames) {
        const p = track(f, 'Hips');
        const dev = Math.abs(((p[0] - first[0]) * dZ - (p[2] - first[2]) * dX) / chord);
        maxDev = Math.max(maxDev, dev);
      }
      // eslint-disable-next-line no-console
      console.log(`turn 90: ΔX ${dX.toFixed(2)}m · ΔZ ${dZ.toFixed(2)}m · chord dev ${(100 * maxDev).toFixed(1)}cm`);
      expect(dZ, 'advances along the entry heading (+Z)').toBeGreaterThan(0.3);
      expect(dX, 'bends toward the turn (+X, subject-left)').toBeGreaterThan(0.3);
      expect(maxDev, 'the path bows off the chord (an arc, not a rotated line)').toBeGreaterThan(0.05);
    });

    it('each stance foot stays planted along the arc — gentle-arc slide budget', () => {
      const rSlide = plantedSlideM(sample, 'R_Foot');
      const lSlide = plantedSlideM(sample, 'L_Foot');
      // eslint-disable-next-line no-console
      console.log(`turn 90: R slide ${(100 * rSlide).toFixed(1)}cm · L slide ${(100 * lSlide).toFixed(1)}cm`);
      // The straight walk gates < 3 cm and the constant-heading walk < 5 cm;
      // the arc's per-window plant rest keeps the curved stance inside 4 cm
      // (the gentle-arc allowance: the heading still drifts up to ~turn/2
      // within one stance window, and the leg IK absorbs the perpendicular
      // residual — see deriveFootDrivenTravel's curved-heading note).
      expect(rSlide, 'R stance slide').toBeLessThan(0.04);
      expect(lSlide, 'L stance slide').toBeLessThan(0.04);
    });

    it('the calibrated vertical stays calm and smooth along the arc', () => {
      const ys = rec.frames.map((f) => f.root.translateM[1]);
      const p2p = Math.max(...ys) - Math.min(...ys);
      const total = rec.frames[rec.frames.length - 1]!.tMs;
      const perMs = total / (ys.length - 1);
      const win = Math.max(1, Math.round(100 / perMs));
      let maxDrop = 0;
      for (let i = win; i < ys.length; i += 1) maxDrop = Math.max(maxDrop, ys[i - win]! - ys[i]!);
      // eslint-disable-next-line no-console
      console.log(`turn 90: vertical p2p ${(100 * p2p).toFixed(1)}cm · max 100ms drop ${(100 * maxDrop).toFixed(1)}cm`);
      expect(p2p, 'excursion calmed (same budget as the straight walk)').toBeLessThan(0.10);
      expect(maxDrop, 'no sudden vertical drop').toBeLessThan(0.06);
    });

    it('the head stays steady over the curving pelvis (no worse than the straight walk)', () => {
      // Heading-agnostic vestibular gate: the head's horizontal offset from the
      // pelvis (the trunk absorb keeps it stacked while the pelvis shuttles).
      const headOverHips = (r: MotionRecording): number => {
        let worst = 0;
        for (const f of r.frames) {
          const h = track(f, 'Head');
          const p = track(f, 'Hips');
          worst = Math.max(worst, Math.hypot(h[0] - p[0], h[2] - p[2]));
        }
        return worst;
      };
      const curved = headOverHips(rec);
      const straightRef = headOverHips(straight.rec);
      // eslint-disable-next-line no-console
      console.log(`turn 90: head-over-hips max ${(100 * curved).toFixed(1)}cm · straight ${(100 * straightRef).toFixed(1)}cm`);
      expect(curved, 'the arc does not unbalance the head').toBeLessThan(straightRef + 0.02);
    });

    it('deterministic — two curved samples are byte-identical', () => {
      const again = sampleWalk({ turnDeg: 90 }).rec;
      expect(JSON.stringify(again.frames)).toBe(JSON.stringify(rec.frames));
    });
  });

  describe('buildFigureEightWalk — two arc walks, the second reversing the turn', () => {
    it('both segments RESOLVE, and the profiles trace +lobe then back to 0', () => {
      const [a, b] = buildFigureEightWalk();
      const ra = resolveComposedMotion(a, variantCfg);
      const rb = resolveComposedMotion(b, variantCfg);
      expect(ra.status).toBe('ok');
      expect(rb.status).toBe('ok');
      const profA = ra.headingProfileMs!;
      const profB = rb.headingProfileMs!;
      // Segment 1: 0 → +lobe. Segment 2: enters AT +lobe, reverses to 0.
      expect(profA[0]!.headingDeg).toBe(0);
      expect(profA[profA.length - 1]!.headingDeg).toBe(120);
      expect(profB[0]!.headingDeg).toBe(120);
      expect(profB[profB.length - 1]!.headingDeg).toBe(0);
    });

    it('the segments COMPOSE: seamless chain, opposite curvature, heading returns to the entry', () => {
      resetHarness();
      const segs = sampleMotionChain([...buildFigureEightWalk()], harness());
      expect(segs).toHaveLength(2);
      expect(segs.every((s) => s.status === 'ok')).toBe(true);
      // Seam gates: the crossover is a quiet-standing weight transfer, not a snap.
      expect(segs[1]!.seamDiscontinuityDeg, 'joint seam').toBeLessThan(3);
      expect(segs[1]!.seamRootTranslateM, 'root seam').toBeLessThan(0.05);
      // Segment 1 exits facing +120; segment 2 exits facing ~0 again.
      const endA = segs[0]!.recording.frames[segs[0]!.recording.frames.length - 1]!;
      const endB = segs[1]!.recording.frames[segs[1]!.recording.frames.length - 1]!;
      const midB = segs[1]!.recording.frames[Math.floor(segs[1]!.recording.frames.length / 2)]!;
      // eslint-disable-next-line no-console
      console.log(
        `figure-8: seg A end yaw ${bodyYawDeg(endA).toFixed(1)}° · seg B mid yaw ${bodyYawDeg(midB).toFixed(1)}° · seg B end yaw ${bodyYawDeg(endB).toFixed(1)}°`,
      );
      expect(Math.abs(bodyYawDeg(endA) - 120), 'lobe A exits at +120°').toBeLessThan(10);
      // Mid-lobe-B the body still faces well left of the exit — it entered at
      // +120 and is unwinding (the REVERSED turn), not pivoting then walking straight.
      expect(bodyYawDeg(midB), 'lobe B unwinds through the reversed turn').toBeGreaterThan(30);
      expect(Math.abs(bodyYawDeg(endB)), 'lobe B exits back at the entry heading').toBeLessThan(10);
    });
  });
});
