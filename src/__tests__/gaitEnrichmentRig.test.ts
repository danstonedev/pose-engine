/**
 * RESOLVE-TIME GAIT PLUMBING — rig-measured acceptance gates (AI-PLUMB-01/02/03,
 * AI-SEAM-01), sampled headlessly on the real male runtime GLB.
 *
 * The fixture is the probe's 8-phase AI walk (a faithful copy of the compose
 * prompt's reference template, with per-keyframe authored root travel — the
 * prompt-sanctioned way an AI walks forward). UNENRICHED it measured, on this
 * same rig + sampler: 68 cm planted-foot slide (template: 2.6), a 12.35 cm
 * 100-ms pelvis drop (template: 5.24 — past the recording-gate class), ZERO
 * lateral weight shift (template: 5.5 cm), a 1.03 m/s entry (template: 0.15),
 * and — for the looping variant — a 12.9 cm/frame glide-snap at every wrap.
 * The resolve-time enrichment must bring each metric into the deterministic
 * walk's class:
 *
 *   1. planted-foot in-window slide       < 8 cm   (was 68)
 *   2. max 100 ms pelvis drop             < 6 cm   (was 12.35)
 *   3. lateral shuttle peak-to-peak       > 2 cm   (was 0)
 *   4. entry root speed (first 150 ms)    < 0.3 m/s (was 1.03)
 *   5. loop+travel: no wrap teleport — resolves one-shot; late root deltas
 *      < 3 cm/frame and the end BRAKES    (was 12.9 cm/frame, −7.4 m/s)
 *   6. the body actually travels (+Z)     > 0.5 m (the conversion is real
 *      foot-driven travel, not an in-place fake)
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
  resolveComposedMotion,
  type ComposedMotion,
  type SequenceKeyframe,
} from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { measureContactSlide } from '../services/footContact';
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

const t = (cmd: string, deg: number) => {
  const [joint, motion] = cmd.split('.') as [string, string];
  return { joint, motion, targetDegrees: deg };
};

/** The probe fixture's faithful 8-phase AI walk cycle (full-limb version). */
function walkPhases(): SequenceKeyframe[] {
  const P = (durationMs: number, targets: ReturnType<typeof t>[]): SequenceKeyframe => ({
    durationMs,
    targets,
  });
  const side = (S: 'R' | 'L') => {
    const O = S === 'R' ? 'L' : 'R';
    return [
      P(168, [
        t(`${S}_UpLeg.hipFlexion`, 30), t(`${S}_Leg.kneeFlexion`, 5), t(`${S}_Foot.ankleFlexion`, 0), t(`${S}_Toes.toeFlexion`, 0),
        t(`${O}_UpLeg.hipFlexion`, -10), t(`${O}_Leg.kneeFlexion`, 40), t(`${O}_Foot.ankleFlexion`, -15), t(`${O}_Toes.toeFlexion`, 28),
        t(`${O}_UpperArm.shoulderFlexion`, 20), t(`${S}_UpperArm.shoulderFlexion`, -20),
        t(`${O}_Forearm.elbowFlexion`, 11), t(`${S}_Forearm.elbowFlexion`, 29),
      ]),
      P(160, [
        t(`${S}_UpLeg.hipFlexion`, 25), t(`${S}_Leg.kneeFlexion`, 18), t(`${S}_Foot.ankleFlexion`, -8), t(`${S}_Toes.toeFlexion`, 0),
        t(`${O}_UpLeg.hipFlexion`, 5), t(`${O}_Leg.kneeFlexion`, 60), t(`${O}_Foot.ankleFlexion`, -5), t(`${O}_Toes.toeFlexion`, 5),
        t(`${O}_UpperArm.shoulderFlexion`, 14), t(`${S}_UpperArm.shoulderFlexion`, -14),
        t(`${O}_Forearm.elbowFlexion`, 14), t(`${S}_Forearm.elbowFlexion`, 26),
      ]),
      P(236, [
        t(`${S}_UpLeg.hipFlexion`, 5), t(`${S}_Leg.kneeFlexion`, 8), t(`${S}_Foot.ankleFlexion`, 5), t(`${S}_Toes.toeFlexion`, 0),
        t(`${O}_UpLeg.hipFlexion`, 20), t(`${O}_Leg.kneeFlexion`, 45), t(`${O}_Foot.ankleFlexion`, 0), t(`${O}_Toes.toeFlexion`, 0),
        t(`${O}_UpperArm.shoulderFlexion`, 0), t(`${S}_UpperArm.shoulderFlexion`, 0),
        t(`${O}_Forearm.elbowFlexion`, 20), t(`${S}_Forearm.elbowFlexion`, 20),
      ]),
      P(236, [
        t(`${S}_UpLeg.hipFlexion`, -10), t(`${S}_Leg.kneeFlexion`, 5), t(`${S}_Foot.ankleFlexion`, 10), t(`${S}_Toes.toeFlexion`, 12),
        t(`${O}_UpLeg.hipFlexion`, 30), t(`${O}_Leg.kneeFlexion`, 5), t(`${O}_Foot.ankleFlexion`, 0), t(`${O}_Toes.toeFlexion`, 0),
        t(`${O}_UpperArm.shoulderFlexion`, -14), t(`${S}_UpperArm.shoulderFlexion`, 14),
        t(`${O}_Forearm.elbowFlexion`, 26), t(`${S}_Forearm.elbowFlexion`, 14),
      ]),
    ];
  };
  return [...side('R'), ...side('L')];
}

const aiTravelWalk = (): ComposedMotion => ({
  name: 'walk forward',
  stance: 'planted',
  keyframes: walkPhases().map((k, i) => ({
    ...k,
    root: { translateM: [0, 0, +(0.175 * (i + 1)).toFixed(3)] as [number, number, number] },
  })),
});

const aiLoopTravelWalk = (): ComposedMotion => ({
  ...aiTravelWalk(),
  name: 'walk forward loop',
  loop: true,
});

function sample(motion: ComposedMotion): MotionRecording {
  applyAnatomicPose(root, variantCfg);
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
  });
}

/** Horizontal slide of a foot over the LONGEST contiguous run in which it is
 *  the lower (weight-bearing) foot — the honest stance-slide metric, mirroring
 *  gaitTravel.test.ts / heelStrike.test.ts. */
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

describe('enriched AI 8-phase gait — the deterministic walk’s class, measured on the rig', () => {
  let rec: MotionRecording;
  beforeAll(() => {
    rec = sample(aiTravelWalk());
  });

  it('gate 1 — each planted foot stays world-fixed: slide < 8 cm (was 68)', () => {
    expect(plantedSlideM(rec, 'R_Foot'), 'R stance slide').toBeLessThan(0.08);
    expect(plantedSlideM(rec, 'L_Foot'), 'L stance slide').toBeLessThan(0.08);
  });

  it('gate 2 — the pelvis vertical is calmed: max 100 ms drop < 6 cm (was 12.35)', () => {
    const fr = rec.frames;
    const ys = fr.map((f) => f.root.translateM[1]);
    const perMs = fr[fr.length - 1]!.tMs / (fr.length - 1);
    const win = Math.max(1, Math.round(100 / perMs));
    let maxDrop = 0;
    for (let i = win; i < ys.length; i += 1) maxDrop = Math.max(maxDrop, ys[i - win]! - ys[i]!);
    expect(maxDrop).toBeLessThan(0.06);
  });

  it('gate 3 — the lateral weight shift EXISTS: root-X peak-to-peak > 2 cm (was 0)', () => {
    const xs = rec.frames.map((f) => f.root.translateM[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.02);
  });

  it('gate 4 — the entry eases from a standstill: root speed over the first 150 ms < 0.3 m/s (was 1.03)', () => {
    const fr = rec.frames;
    const perMs = fr[fr.length - 1]!.tMs / (fr.length - 1);
    const i150 = Math.max(1, Math.min(fr.length - 1, Math.round(150 / perMs)));
    const dt = (fr[i150]!.tMs - fr[0]!.tMs) / 1000;
    const d = Math.hypot(
      fr[i150]!.root.translateM[0] - fr[0]!.root.translateM[0],
      fr[i150]!.root.translateM[2] - fr[0]!.root.translateM[2],
    );
    expect(d / dt).toBeLessThan(0.3);
  });

  it('gate 6 — the conversion is REAL travel: the body advances > 0.5 m (+Z), stride emergent from the FK', () => {
    const zs = rec.frames.map((f) => f.root.translateM[2]);
    expect(zs[zs.length - 1]! - zs[0]!).toBeGreaterThan(0.5);
  });
});

describe('AI-SEAM-01 — the looping travel plan has no glide-snap wrap', () => {
  let rec: MotionRecording;
  beforeAll(() => {
    rec = sample(aiLoopTravelWalk());
  });

  it('gate 5a — resolves as ONE traveled pass (loop converted, noted)', () => {
    const resolved = resolveComposedMotion(aiLoopTravelWalk(), variantCfg);
    expect(resolved.loop).toBe(false);
    expect(resolved.footDrivenTravel).toBe(true);
    expect(resolved.notes?.some((n) => n.includes('loop-travel'))).toBe(true);
  });

  it('gate 5b — no teleport anywhere near the (former) wrap: root deltas over the last 300 ms < 3 cm/frame (was 12.9)', () => {
    const fr = rec.frames;
    const endMs = fr[fr.length - 1]!.tMs;
    let worst = 0;
    for (let i = 1; i < fr.length; i += 1) {
      if (fr[i]!.tMs < endMs - 300) continue;
      const a = fr[i - 1]!.root.translateM;
      const b = fr[i]!.root.translateM;
      worst = Math.max(worst, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('gate 5c — the pass BRAKES instead of stopping mid-glide: root speed over the last 150 ms < 0.3 m/s (was −7.4)', () => {
    const fr = rec.frames;
    const endMs = fr[fr.length - 1]!.tMs;
    const iStart = fr.findIndex((f) => f.tMs >= endMs - 150);
    const dt = (endMs - fr[iStart]!.tMs) / 1000;
    const d = Math.hypot(
      fr[fr.length - 1]!.root.translateM[0] - fr[iStart]!.root.translateM[0],
      fr[fr.length - 1]!.root.translateM[2] - fr[iStart]!.root.translateM[2],
    );
    expect(d / dt).toBeLessThan(0.3);
  });
});
