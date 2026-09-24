/**
 * FOLLOW-THROUGH AT PINNED KNOTS — a delayed bone passes a knot whose path has
 * a corner at rest, on a clock whose rate never exceeds 1/(1 − d) × the chain's
 * (motionStagger.followThroughRamp).
 *
 * A PINNED knot is a fly-through whose SQUAD control is the knot itself: either
 * side of a segment wider than 120° (the arms of every floor transition, the
 * bird-dog raise, the jump's arm swing) and the terminal overshoot. The path
 * then leaves and enters the knot along each side's own chord — a corner, or a
 * reversal. 5c1c9ac hid that by stopping every delayed bone dead at every knot
 * (a velocity step on arrival, another after its dwell); the C¹ follow-through
 * flew straight through and flipped the velocity instead. Measured on 2d8f5e6:
 *   - stand from all fours / from plank: the upper arm 162 → −162°/s at the
 *     700 ms knot, and the mean of the tracked points peaking at 101.8 / 90.8
 *     m/s² at 120 Hz against 5c1c9ac's 77.7 / 68.7 (male; female 100.2 / 89.7
 *     against 76.5 / 67.9);
 *   - bird-dog's 417 ms knot 122 → 195°/s turning a corner (217°/s of change;
 *     5c1c9ac 146), and the jump's arm swing arriving at 1,186°/s into a dead
 *     stop (574°/s of change; 5c1c9ac 645);
 *   - the upper arm's peak over 5c1c9ac's where the flip cut the stroke short
 *     (stand from all fours 357 vs 348°/s, from plank 360 vs 351, the jump
 *     1,186 vs 1,176, to all fours 325 vs 320, to plank 313 vs 308).
 * Slowing the bone's own time-warp to zero across the whole stroke instead (the
 * reverted round-4 attempt) cost a peak 12–25% over 5c1c9ac's.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { CustomPose } from '../types';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { buildSequencePoses, resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { buildComposedTrajectory, type PoseTrajectory } from '../services/motionTrajectory';
import { sampleComposedMotion } from '../services/motionRecording';
import { followThroughRamp, followThroughRampProgress, trajectoryBoneDelay } from '../services/motionStagger';
import { clampTimeScale } from '../services/motionConstants';
import * as P from '../services/movementPostures';
import { buildJump } from '../services/movementLocomotion';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

type Q = [number, number, number, number];
type Variant = 'male' | 'female';

function rotVec(a: Q, b: Q): [number, number, number] {
  const [ax, ay, az, aw] = [-a[0], -a[1], -a[2], a[3]];
  const [bx, by, bz, bw] = b;
  let x = aw * bx + ax * bw + ay * bz - az * by;
  let y = aw * by - ax * bz + ay * bw + az * bx;
  let z = aw * bz + ax * by - ay * bx + az * bw;
  let w = aw * bw - ax * bx - ay * by - az * bz;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const v = Math.hypot(x, y, z);
  if (v < 1e-15) return [0, 0, 0];
  const k = (2 * Math.atan2(v, w)) / v;
  return [x * k, y * k, z * k];
}

interface Rig {
  variant: Variant;
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  rest: JointAngleRestReference;
  baselinePose: CustomPose;
  pos0: THREE.Vector3;
  quat0: THREE.Quaternion;
  local0: THREE.Quaternion[];
}
const rigs = new Map<Variant, Rig>();

beforeAll(async () => {
  for (const variant of ['male', 'female'] as const) {
    const variantCfg = BODY_VARIANTS[variant];
    const buf = readFileSync(fileURLToPath(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url)));
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
    const sk = skinned! as THREE.SkinnedMesh;
    rigs.set(variant, {
      variant,
      root,
      skinned: sk,
      rest: captureJointAngleRestReference(sk.skeleton, variantCfg),
      baselinePose: serializeCustomPose(sk.skeleton, variantCfg, variant),
      pos0: root.position.clone(),
      quat0: root.quaternion.clone(),
      local0: sk.skeleton.bones.map((b) => b.quaternion.clone()),
    });
  }
}, 120_000);

/** The composed trajectory exactly as the sampler and the stage build it. */
function trajectoryOf(r: Rig, motion: ComposedMotion): PoseTrajectory {
  const variantCfg = BODY_VARIANTS[r.variant];
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status, motion.name).toBe('ok');
  const built = buildSequencePoses(r.baselinePose, resolved, variantCfg, r.rest, { currentPose: null, currentRoot: null });
  return buildComposedTrajectory(built, {
    startPose: r.baselinePose,
    startQuat: [0, 0, 0, 1],
    startTranslate: [0, 0, 0],
    timeScale: clampTimeScale(resolved.modifiers?.timeScale),
    reps: resolved.reps,
    cyclicEnds: resolved.footDrivenTravel === true && resolved.settleEnds !== true,
    flowIn: resolved.flowIn === true,
  }).trajectory;
}

/** Per delayed bone: its peak angular speed (°/s) and the largest change of its
 *  angular velocity VECTOR between consecutive 0.5 ms steps (°/s) — a velocity
 *  step or flip reads as its whole size there, a smooth motion as its
 *  acceleration × 0.5 ms. */
function delayedMotion(traj: PoseTrajectory): Map<string, { peak: number; step: number; stepAtMs: number }> {
  const keys = Object.keys(traj.sampleAt(0).pose.bones).filter((k) => trajectoryBoneDelay(k) > 0);
  const out = new Map(keys.map((k) => [k, { peak: 0, step: 0, stepAtMs: 0 }]));
  const dt = 0.5;
  const toDegS = (180 / Math.PI) * (1000 / dt);
  let prev = traj.sampleAt(0).pose.bones;
  const last = new Map<string, number[]>();
  for (let t = dt; t <= traj.totalMs; t += dt) {
    const cur = traj.sampleAt(t).pose.bones;
    for (const k of keys) {
      const w = rotVec(prev[k] as Q, cur[k] as Q).map((v) => v * toDegS);
      const o = out.get(k)!;
      o.peak = Math.max(o.peak, Math.hypot(w[0]!, w[1]!, w[2]!));
      const p = last.get(k);
      if (p) {
        const step = Math.hypot(w[0]! - p[0]!, w[1]! - p[1]!, w[2]! - p[2]!);
        if (step > o.step) {
          o.step = step;
          o.stepAtMs = t;
        }
      }
      last.set(k, w);
    }
    prev = cur;
  }
  return out;
}

const walkTemplate = (): ComposedMotion => templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

/** Motions with pinned knots on a moving delayed bone, and 5c1c9ac's upper-arm
 *  peak (°/s, both rigs alike) where the flip had lifted 2d8f5e6's over it. */
const PINNED: { name: string; make: () => ComposedMotion; upperArmPeakMain?: number }[] = [
  { name: 'stand from all fours', make: () => P.buildStandFromQuadruped(), upperArmPeakMain: 348.2 },
  { name: 'stand from plank', make: () => P.buildStandFromPlank(), upperArmPeakMain: 351.1 },
  { name: 'down to all fours', make: () => P.buildGetDownToQuadruped(), upperArmPeakMain: 320.3 },
  { name: 'down to plank', make: () => P.buildGetDownToPlank(), upperArmPeakMain: 307.5 },
  { name: 'jump', make: () => buildJump({}), upperArmPeakMain: 1175.7 },
  { name: 'bird-dog ×3', make: () => P.buildBirdDog({ side: 'L', reps: 3 }) },
  { name: 'walk template (terminal overshoot)', make: walkTemplate },
];

describe('followThroughRamp', () => {
  it('runs from r0 through 1/(1 − d) to r1 and covers the stroke exactly', () => {
    for (const d of [0.0225, 0.09, 0.1125, 0.135, 0.1575, 0.18]) {
      for (const [r0, r1] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [0.75, 0],
        [0, Infinity],
      ] as const) {
        const ramp = followThroughRamp(d, r0, r1)!;
        expect(ramp.peak).toBeCloseTo(1 / (1 - d), 12);
        expect(followThroughRampProgress(ramp, 0)).toBe(0);
        expect(followThroughRampProgress(ramp, 1)).toBeCloseTo(1, 12);
        const h = 1e-6;
        const rate = (s: number) => (followThroughRampProgress(ramp, s + h) - followThroughRampProgress(ramp, s - h)) / (2 * h);
        expect(rate(h), `d ${d}: starts at r0`).toBeCloseTo(Math.min(ramp.peak, r0), 4);
        expect(rate(1 - h), `d ${d}: ends at r1`).toBeCloseTo(Math.min(ramp.peak, r1), 4);
        let prev = 0;
        for (let s = 0.001; s < 1; s += 0.001) {
          const v = followThroughRampProgress(ramp, s);
          expect(v).toBeGreaterThanOrEqual(prev); // never backwards
          expect(rate(s)).toBeLessThanOrEqual(ramp.peak + 1e-6); // never over 1/(1 − d)
          prev = v;
        }
      }
    }
    expect(followThroughRamp(0, 0, 0)).toBeNull();
  });
});

describe.each(['male', 'female'] as const)('a delayed bone through a pinned knot (%s)', (variant) => {
  for (const m of PINNED) {
    it(`${m.name}: every delayed bone's velocity is continuous, and the upper arm's peak is 5c1c9ac's`, () => {
      const r = rigs.get(variant)!;
      const motion = delayedMotion(trajectoryOf(r, m.make()));
      expect(motion.size).toBeGreaterThan(10);
      for (const [key, o] of motion) {
        // 2d8f5e6: the upper arm changed velocity by 135–574°/s in one 0.5 ms
        // step at these knots (5c1c9ac 149–645); now by the ramp's own
        // acceleration, at most 29°/s a step (the jump's 160 ms swing, braking
        // in 18 ms).
        expect(o.step, `${key}: velocity step of ${o.step.toFixed(0)}°/s at ${o.stepAtMs} ms`).toBeLessThan(40);
      }
      if (m.upperArmPeakMain != null) {
        for (const key of ['L_UpperArm', 'R_UpperArm']) {
          expect(motion.get(key)!.peak, key).toBeLessThanOrEqual(m.upperArmPeakMain + 0.05);
        }
      }
    });
  }
});

/** Peak acceleration (m/s²) of the mean of every tracked point — the sweep's
 *  mean-track measure — over a recording's frames (non-uniform second
 *  difference). */
function meanTrackPeakAccel(frames: readonly { tMs: number; worldTracks?: Record<string, number[]> }[]): number {
  const keys = Object.keys(frames[0]!.worldTracks!);
  const mean = frames.map((f) => [0, 1, 2].map((d) => keys.reduce((s, k) => s + f.worldTracks![k]![d]!, 0) / keys.length));
  let peak = 0;
  for (let i = 1; i < frames.length - 1; i += 1) {
    const dt1 = (frames[i]!.tMs - frames[i - 1]!.tMs) / 1000;
    const dt2 = (frames[i + 1]!.tMs - frames[i]!.tMs) / 1000;
    if (!(dt1 > 0 && dt2 > 0)) continue;
    const a = [0, 1, 2].map(
      (d) => ((mean[i + 1]![d]! - mean[i]![d]!) / dt2 - (mean[i]![d]! - mean[i - 1]![d]!) / dt1) / ((dt1 + dt2) / 2),
    );
    peak = Math.max(peak, Math.hypot(a[0]!, a[1]!, a[2]!));
  }
  return peak;
}

// 5c1c9ac's mean-track peak acceleration (m/s²), measured by the sweep.
const MAIN_MEAN_TRACK: Record<Variant, Record<string, Record<number, number>>> = {
  male: {
    'stand from all fours': { 30: 26.7, 60: 43.45, 120: 77.727 },
    'stand from plank': { 30: 22.822, 60: 37.907, 120: 68.748 },
  },
  female: {
    'stand from all fours': { 30: 26.137, 60: 42.671, 120: 76.479 },
    'stand from plank': { 30: 22.409, 60: 37.368, 120: 67.921 },
  },
};

describe.each(['male', 'female'] as const)('standing up from the floor, recorded (%s)', (variant) => {
  for (const name of ['stand from all fours', 'stand from plank']) {
    it(`${name}: the body's tracked points accelerate no harder than on 5c1c9ac (2d8f5e6: +31% at 120 Hz)`, () => {
      const r = rigs.get(variant)!;
      const make = PINNED.find((m) => m.name === name)!.make;
      for (const hz of [30, 60, 120]) {
        r.skinned.skeleton.bones.forEach((b, i) => b.quaternion.copy(r.local0[i]!));
        r.root.position.copy(r.pos0);
        r.root.quaternion.copy(r.quat0);
        r.root.updateMatrixWorld(true);
        const rec = sampleComposedMotion(resolveComposedMotion(make(), BODY_VARIANTS[variant]), {
          baselinePose: r.baselinePose,
          variantCfg: BODY_VARIANTS[variant],
          rest: r.rest,
          skeletonHarness: { root: r.root, skinned: r.skinned },
          sampleHz: hz,
        });
        // To the sweep's 3 decimals, so 5c1c9ac reads its own numbers. Measured
        // 19.2 / 20.8 / 23.7 (all fours) and 15.9 / 17.4 / 17.7 (plank) at 30 /
        // 60 / 120 Hz on the male rig; 18.6 / 20.2 / 20.5 and 15.5 / 16.9 / 17.2
        // on the female.
        const peak = Math.round(meanTrackPeakAccel(rec.frames as never) * 1000) / 1000;
        expect(peak, `${hz} Hz`).toBeLessThanOrEqual(MAIN_MEAN_TRACK[variant][name]![hz]!);
      }
    });
  }
});
