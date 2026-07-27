/**
 * SAGITTAL SPINE + SCAPULAR ROTATION IN GAIT — the channels that measured a flat
 * zero through an entire walk.
 *
 * WHY THIS EXISTS. Reported from the deployed build: everything visibly moved
 * during walking playback EXCEPT lumbar/thoracic/cervical flexion-extension and
 * scapular upward rotation/tilt. An audit over every `ROM_JOINT_ROWS` channel
 * confirmed it exactly — seven channels below 0.1° peak-to-peak, all of them
 * "not authored" rather than authored-and-cancelled:
 *
 *     L/R_Shoulder.scapularTilt   p2p 0.000°
 *     L/R_Shoulder.upRotation     p2p 0.000°
 *     Spine_Lower.flexion         p2p 0.005°
 *     Spine_Upper.flexion         p2p 0.022°
 *     Neck.flexion                p2p 0.026°
 *
 * Each had a DIFFERENT cause, and neither was a measurement bug — every one of
 * the five reads back exactly when commanded directly (20 → 20.00, 12 → 12.00,
 * 8 → 8.00, 6 → 6.00, 10 → 10.00):
 *
 *   • The SPINE channels were banned outright by spinalGaitCoordination, to
 *     protect the world-anchored shoulderFlexion readout. `trunkSum` later made
 *     that unnecessary; the ban outlived its reason.
 *   • The GIRDLE channels were unreachable: their only writer is `girdleSplit`,
 *     which returns zero below its 60°/30° setting phase, and a walk peaks at
 *     20.2°/14.0°. The rhythm models elevation, and gait is not elevation.
 *
 * So this file gates two things: that the channels MOVE, and that moving them
 * costs nothing the walk already guaranteed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { measureContactSlide } from '../services/footContact';
import { buildTravelWalk, buildTravelRun } from '../services/movementLocomotion';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;

interface Sampled {
  rec: MotionRecording;
  resolved: ReturnType<typeof resolveComposedMotion>;
}
const sampled: Record<string, Sampled> = {};

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
  for (const [name, motion] of [
    ['walk', buildTravelWalk()],
    ['run', buildTravelRun()],
  ] as const) {
    const resolved = resolveComposedMotion(motion, variantCfg);
    expect(resolved.status, `${name} resolves`).toBe('ok');
    sampled[name] = {
      resolved,
      rec: sampleComposedMotion(resolved, {
        baselinePose,
        variantCfg,
        rest,
        skeletonHarness: { root, skinned },
        sampleHz: 120,
      }),
    };
  }
}, 300_000);

const steady = (rec: MotionRecording) =>
  rec.frames.slice(Math.floor(rec.frames.length * 0.25), Math.floor(rec.frames.length * 0.8));
const ang = (fr: MotionRecording['frames'][number], j: string, m: string): number =>
  (fr.angles[j]?.[m] as number | undefined) ?? 0;
const p2p = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
const peak = (xs: number[]) => Math.max(...xs.map(Math.abs));
const chan = (rec: MotionRecording, j: string, m: string) => steady(rec).map((f) => ang(f, j, m));

describe('the seven flat channels now move', () => {
  it('reports every one of them, on walk and run', () => {
    for (const g of ['walk', 'run'] as const) {
      const { rec } = sampled[g]!;
      const line = (j: string, m: string) =>
        `    ${`${j}.${m}`.padEnd(28)} p2p ${p2p(chan(rec, j, m)).toFixed(3).padStart(7)}°  ` +
        `peak ${peak(chan(rec, j, m)).toFixed(2).padStart(6)}°`;
      // eslint-disable-next-line no-console
      console.log(
        `\n[${g}]\n` +
          [
            line('Spine_Lower', 'flexion'),
            line('Spine_Upper', 'flexion'),
            line('Neck', 'flexion'),
            line('L_Shoulder', 'upRotation'),
            line('R_Shoulder', 'upRotation'),
            line('L_Shoulder', 'scapularTilt'),
            line('R_Shoulder', 'scapularTilt'),
          ].join('\n'),
      );
    }
  }, 300_000);

  it('sagittal spine moves on BOTH gaits — the flat 0.00° is gone', () => {
    // The reported defect, stated as a gate. These were 0.005 / 0.022 / 0.026.
    for (const g of ['walk', 'run'] as const) {
      const { rec } = sampled[g]!;
      expect(p2p(chan(rec, 'Spine_Lower', 'flexion')), `${g} lumbar flexion`).toBeGreaterThan(2);
      expect(p2p(chan(rec, 'Spine_Upper', 'flexion')), `${g} thoracic flexion`).toBeGreaterThan(1.5);
      expect(p2p(chan(rec, 'Neck', 'flexion')), `${g} cervical flexion`).toBeGreaterThan(1);
    }
  }, 300_000);

  it('scapular rotation moves on BOTH gaits, on both sides', () => {
    // These were EXACTLY 0.000 — the girdle split cannot reach them at gait
    // amplitude, so nothing but this authoring can make them move at all.
    for (const g of ['walk', 'run'] as const) {
      const { rec } = sampled[g]!;
      for (const S of ['L', 'R'] as const) {
        expect(p2p(chan(rec, `${S}_Shoulder`, 'upRotation')), `${g} ${S} upRotation`).toBeGreaterThan(2);
        expect(p2p(chan(rec, `${S}_Shoulder`, 'scapularTilt')), `${g} ${S} scapularTilt`).toBeGreaterThan(1.5);
      }
    }
  }, 300_000);

  it('the sagittal trunk oscillates TWICE per stride, not once', () => {
    // The physiology, not just the amplitude: trunk flexion peaks around each
    // double support and releases through each mid-stance. A once-per-stride
    // signal would mean it had been coupled to the wrong driver (signed hipDiff
    // rather than |hipDiff|) — which would look like movement and be wrong.
    // Counted as interior local maxima against the hip's own once-per-stride.
    // Proved by CORRELATION rather than by counting cycles. Counting needs many
    // cycles to be reliable and the steady window holds barely two, so the count
    // was dominated by which partial cycle the window clipped — it read 2-vs-2 on
    // a signal that is visibly twice-per-stride. Correlation needs no such luck:
    //
    //   • against |hipDiff| (twice per stride) it must be STRONG — that is the
    //     driver, and the physiology: flex around each double support, extend
    //     through each mid-stance.
    //   • against SIGNED hipDiff (once per stride) it must be WEAK — a strong
    //     correlation here would mean the trunk was coupled to the sign of the
    //     stride, i.e. flexing for the left step and extending for the right.
    //     That is the specific wrong answer this gate exists to reject, and it
    //     would look like perfectly good movement on screen.
    const corr = (a: number[], b: number[]) => {
      const ma = a.reduce((x, y) => x + y, 0) / a.length;
      const mb = b.reduce((x, y) => x + y, 0) / b.length;
      let n = 0;
      let da = 0;
      let db = 0;
      for (let i = 0; i < a.length; i += 1) {
        n += (a[i]! - ma) * (b[i]! - mb);
        da += (a[i]! - ma) ** 2;
        db += (b[i]! - mb) ** 2;
      }
      return n / Math.sqrt(da * db);
    };
    for (const g of ['walk', 'run'] as const) {
      const f = steady(sampled[g]!.rec);
      const lumbar = f.map((x) => ang(x, 'Spine_Lower', 'flexion'));
      const signed = f.map(
        (x) => ang(x, 'L_UpLeg', 'hipFlexion') - ang(x, 'R_UpLeg', 'hipFlexion'),
      );
      const rAbs = corr(lumbar, signed.map(Math.abs));
      const rSigned = corr(lumbar, signed);
      // eslint-disable-next-line no-console
      console.log(`[${g}] lumbar vs |hipDiff| r = ${rAbs.toFixed(3)} · vs signed r = ${rSigned.toFixed(3)}`);
      expect(rAbs, `${g} lumbar tracks |hipDiff| (twice per stride)`).toBeGreaterThan(0.85);
      expect(Math.abs(rSigned), `${g} lumbar is NOT once-per-stride`).toBeLessThan(0.35);
    }
  }, 300_000);
});

describe('gaitTargetBudget — a gait must not overflow the per-keyframe target cap', () => {
  it('drops NOTHING on walk or run', () => {
    // THE GATE THAT SHOULD HAVE CAUGHT THIS IMMEDIATELY. Adding seven channels
    // took the walk from 48 targets in its busiest keyframe to 55, against a cap
    // of 48 — and the cap truncates by ARRIVAL ORDER, silently. 33 targets were
    // refused, every one of them right-side, because the coordinator appends the
    // left limb before the right: R_Ring1/R_Pinky1/R_Index1/R_Mid1 fingerFlexion,
    // R_UpLeg.hipAbduction, R_Leg.kneeRotation, R_Foot.ankleInversion. The run
    // lost 65.
    //
    // Nothing reported it. What surfaced instead was two unrelated hand tests
    // failing with numbers that read like a measurement bug (a finger at 39°
    // beside a finger at 9e-8), and the numbers did not move when the girdle
    // gains were HALVED — which is the tell, because a perturbation scales and an
    // amputation does not. Asserting on the outcome list says it in one line.
    for (const g of ['walk', 'run'] as const) {
      const dropped = (sampled[g]!.resolved.outcomes ?? []).filter(
        (o) => o.reason === 'target-limit',
      );
      const what = [...new Set(dropped.map((o) => `${o.joint}.${o.motion}`))];
      expect(dropped.length, `${g} drops ${dropped.length} targets: ${what.join(', ')}`).toBe(0);
    }
  }, 300_000);
});

describe('lifting the sagittal ban costs nothing the walk already guaranteed', () => {
  it('the stance foot still plants', () => {
    // The trunkSum compensation is what makes the ban unnecessary; this is the
    // check that it holds in the shipped output and not just in a probe.
    for (const g of ['walk', 'run'] as const) {
      const { rec, resolved } = sampled[g]!;
      const worst = Math.max(
        ...(resolved.contacts ?? []).map(
          (c) => measureContactSlide(rec, c.foot, c.fromMs!, c.toMs!).horizontalM,
        ),
      );
      // eslint-disable-next-line no-console
      console.log(`[${g}] worst stance slide ${(worst * 100).toFixed(2)} cm`);
      expect(worst, `${g} stance slide`).toBeLessThan(0.055);
    }
  }, 300_000);

  it('the head stays steady — the neck counters the trunk on all three planes', () => {
    for (const g of ['walk', 'run'] as const) {
      const hx = steady(sampled[g]!.rec).map((f) => f.worldTracks!.Head![0]);
      const mean = hx.reduce((a, b) => a + b, 0) / hx.length;
      const cm = p2p(hx.map((x) => x - mean)) * 100;
      // eslint-disable-next-line no-console
      console.log(`[${g}] head lateral excursion ${cm.toFixed(2)} cm`);
      expect(cm, `${g} head steady`).toBeLessThan(4);
    }
  }, 300_000);

  it('every new channel stays inside its band — measured as EXCURSION, not absolute angle', () => {
    // Peak-to-peak is the right measure and the absolute angle is not, which
    // this gate originally got wrong. The RUN authors a forward trunk lean
    // (`trunkLeanDeg`), so its lumbar sits around +8.5° and a peak-angle check
    // read 11.5° and called it out of band. Nothing was out of band: the lean is
    // the mean, and the oscillation rides on top of it.
    for (const g of ['walk', 'run'] as const) {
      const { rec } = sampled[g]!;
      expect(p2p(chan(rec, 'Spine_Lower', 'flexion')), `${g} lumbar excursion`).toBeLessThan(8);
      expect(p2p(chan(rec, 'Spine_Upper', 'flexion')), `${g} thoracic excursion`).toBeLessThan(7);
      expect(p2p(chan(rec, 'Neck', 'flexion')), `${g} cervical excursion`).toBeLessThan(7);
      for (const S of ['L', 'R'] as const) {
        expect(p2p(chan(rec, `${S}_Shoulder`, 'upRotation')), `${g} ${S} upRot excursion`).toBeLessThan(18);
        expect(p2p(chan(rec, `${S}_Shoulder`, 'scapularTilt')), `${g} ${S} tilt excursion`).toBeLessThan(14);
      }
    }
  }, 300_000);

  it('the sagittal excursion does NOT saturate at run energy', () => {
    // The defect the stride envelope exists to prevent, gated so it cannot come
    // back. A driver centred on a fixed constant railed at both ends of every
    // run cycle — the trace flat-topped at 11.5 and 5.9 — because the run's hip
    // excursion is ~1.5x the walk's. Saturation is invisible in a p2p number, so
    // it is measured here as TIME SPENT PINNED at the extremes.
    for (const g of ['walk', 'run'] as const) {
      const xs = chan(sampled[g]!.rec, 'Spine_Lower', 'flexion');
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      const band = (hi - lo) * 0.02;
      const pinned = xs.filter((v) => v <= lo + band || v >= hi - band).length / xs.length;
      // eslint-disable-next-line no-console
      console.log(`[${g}] lumbar time pinned at an extreme ${(pinned * 100).toFixed(1)}%`);
      expect(pinned, `${g} lumbar does not flat-top`).toBeLessThan(0.15);
    }
  }, 300_000);

  it('a gait that STOPS settles its trunk to neutral, not to a lean', () => {
    // The other defect the envelope fixes. With a fixed centre, |hipDiff| -> 0 at
    // termination read as maximum EXTENSION and the walk settled into a 3.4°
    // backward lean it should never have had. The last frames of the travel walk
    // are a standstill, so the trunk belongs at its authored posture there.
    const frames = sampled.walk!.rec.frames;
    const tail = frames.slice(Math.floor(frames.length * 0.94));
    const settle = peak(tail.map((f) => ang(f, 'Spine_Lower', 'flexion')));
    // eslint-disable-next-line no-console
    console.log(`[walk] lumbar flexion at standstill ${settle.toFixed(2)}°`);
    expect(settle, 'the walk does not stop leaning backward').toBeLessThan(1.5);
  }, 300_000);
});
