/**
 * A HELD FOREFOOT SITS ON THE FLOOR — the push-off pivot (a forefoot contact
 * from heel rise to toe lift) on a walk two gait cycles long, the shape DDx's
 * walk plays, whose calibrated vertical is sampled per period
 * (deriveVerticalCalibration's `periodFraction`).
 *
 * The walk here holds each stance foot by its ankle from the keyframe it lands
 * on, then by its forefoot from heel rise, and its right hip never extends past
 * 0° (the restriction DDx's two-cycle walk plays). When the right heel rise
 * opens its forefoot hold, the ankle hold has kept that heel down and the
 * forefoot is 1.4-1.8 cm up; the hold took the forefoot there and held it there
 * to its end — floating through every right push-off, while the vertical sat
 * within 5 mm of the floor pin. DDx's walk showed the same: its right forefoot
 * 1.3-1.5 cm up through both push-offs, and neither foot within 1 cm of the
 * floor for six frames. On 5c1c9ac the old whole-clip vertical, 2.3 cm under
 * the pin at those moments, buried DDx's right forefoot 0.8-1.0 cm instead
 * (this walk's 2.4-5.8 mm, its heel 2.2-2.7 cm).
 *
 * A forefoot hold that opens with the heel down now settles its point onto the
 * floor (footContact FOREFOOT_SETTLE_MS) and holds it there.
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
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import {
  authoredToTrajectoryTimeScale,
  gaitPeriodMs,
  sampleComposedMotion,
  type MotionRecording,
} from '../services/motionRecording';
import { captureFloorReference } from '../services/rootMotion';
// Namespace import: the settle span is read off the module so the checks below
// still run (and report their numbers) against an engine without it.
import * as footContact from '../services/footContact';
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
/** Each foot contact's world height with the rig standing (m): the floor. */
let restY: Record<string, number> = {};

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
  restY = captureFloorReference(skinned.skeleton, variantCfg).restY;
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

/** The heel rises this far before the end of terminal stance's keyframe, and
 *  the toes lift this far into initial swing's keyframe (DDx's walk values). */
const HEEL_RISE_FRACTION = 0.35;
const TOE_LIFT_FRACTION = 0.46;

/**
 * Two cycles of the engine's travelling walk — [0] initiation · [1..8] cycle ·
 * [9..16] cycle · [17] braking step · [18] settle — with the right hip stopped
 * at 0° of extension, each foot held by its ankle from the keyframe it lands on
 * to heel rise and by its forefoot from there until its toes lift, the
 * builder's closing holds, its stance schedule twice over and the second cycle
 * published. The last left stance keeps its ankle hold to terminal stance: the
 * braking step swings that leg through, which no forefoot hold survives.
 */
function twoCycleWalk(speed?: number): ComposedMotion {
  const walk = buildTravelWalk(speed ? { speed } : {});
  const k = walk.keyframes;
  const hipStopped = (kf: (typeof k)[number]) => ({
    ...kf,
    targets: kf.targets?.map((t) =>
      t.joint === 'R_UpLeg' && t.motion === 'hipFlexion'
        ? { ...t, targetDegrees: Math.max(0, t.targetDegrees) }
        : t,
    ),
  });
  const keyframes = [k[0]!, ...k.slice(1, 9), ...k.slice(1, 9), k[9]!, k[10]!].map(hipStopped);
  const ends: number[] = [];
  keyframes.reduce((t, kf) => {
    ends.push(t + (kf.durationMs ?? 0) + (kf.holdMs ?? 0));
    return ends[ends.length - 1]!;
  }, 0);
  const total = ends[ends.length - 1]!;
  const rise = (i: number) => ends[i]! - HEEL_RISE_FRACTION * (keyframes[i]!.durationMs ?? 0);
  const lift = (i: number) => ends[i - 1]! + TOE_LIFT_FRACTION * (keyframes[i]!.durationMs ?? 0);
  const lLands = ends[17]! + (keyframes[18]!.durationMs ?? 0);
  return {
    ...walk,
    keyframes,
    contacts: [
      { foot: 'R_Foot', fromMs: 0, toMs: rise(4) },
      { foot: 'R_Toes', fromMs: rise(4), toMs: lift(6) },
      { foot: 'L_Foot', fromMs: ends[5]!, toMs: rise(8) },
      { foot: 'L_Toes', fromMs: rise(8), toMs: lift(10) },
      { foot: 'R_Foot', fromMs: ends[9]!, toMs: rise(12) },
      { foot: 'R_Toes', fromMs: rise(12), toMs: lift(14) },
      { foot: 'L_Foot', fromMs: ends[13]!, toMs: ends[16]! },
      { foot: 'R_Foot', fromMs: ends[17]!, toMs: total },
      { foot: 'L_Foot', fromMs: lLands, toMs: total },
    ],
    gaitStanceWindowsMs: [
      { foot: 'R_Foot', fromMs: 0, toMs: ends[4]! },
      { foot: 'L_Foot', fromMs: ends[4]!, toMs: ends[8]! },
      { foot: 'R_Foot', fromMs: ends[8]!, toMs: ends[12]! },
      { foot: 'L_Foot', fromMs: ends[12]!, toMs: ends[16]! },
      { foot: 'R_Foot', fromMs: ends[16]!, toMs: lLands, travelLock: true },
    ],
    gaitCycleMs: { ...walk.gaitCycleMs!, fromMs: ends[9]!, toMs: ends[16]! },
  };
}

function sample(motion: ComposedMotion, sampleHz: number) {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status).toBe('ok');
  const rec: MotionRecording = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz,
  });
  const totalMs = rec.frames[rec.frames.length - 1]!.tMs;
  const scale = authoredToTrajectoryTimeScale(resolved, totalMs);
  const contacts = (resolved.contacts ?? []).map((c) => ({
    foot: c.foot,
    fromMs: (c.fromMs ?? -Infinity) * scale,
    toMs: (c.toMs ?? Infinity) * scale,
  }));
  return { resolved, rec, contacts, totalMs, scale };
}

describe('a held forefoot sits on the floor through its push-off', () => {
  for (const [speed, sampleHz] of [
    [0.85, 30],
    [1, 30],
    [1, 120],
  ] as const) {
    it(`two-cycle walk at speed ${speed}, ${sampleHz} Hz: every forefoot hold settles onto the floor and stays there`, () => {
      const { resolved, rec, contacts, totalMs, scale } = sample(twoCycleWalk(speed), sampleHz);
      // A walk this long calibrates its vertical per period (its period under
      // 0.375 of the clip — see deriveVerticalCalibration).
      expect(gaitPeriodMs(resolved, scale)! / totalMs).toBeLessThan(0.375);
      const settleMs = (footContact as { FOREFOOT_SETTLE_MS?: number }).FOREFOOT_SETTLE_MS ?? 120;
      const holds = contacts.filter((c) => c.foot.endsWith('Toes'));
      expect(holds.map((c) => c.foot)).toEqual(['R_Toes', 'L_Toes', 'R_Toes']);
      for (const c of holds) {
        const frames = rec.frames.filter((f) => f.tMs >= c.fromMs - 1e-6 && f.tMs <= c.toMs + 1e-6);
        const up = (i: number) => frames[i]!.worldTracks![c.foot]![1] - restY[c.foot]!;
        const heel = frames[0]!.worldTracks![c.foot.replace('Toes', 'Foot')]![1] - restY[c.foot.replace('Toes', 'Foot')]!;
        const first = frames[0]!.worldTracks![c.foot]!;
        let settled = 0;
        let worstSettled = 0;
        let worstSideways = 0;
        let rising = 0;
        for (let i = 0; i < frames.length; i += 1) {
          const p = frames[i]!.worldTracks![c.foot]!;
          worstSideways = Math.max(worstSideways, Math.hypot(p[0] - first[0], p[2] - first[2]));
          if (i > 0) rising = Math.max(rising, Math.abs(up(i)) - Math.abs(up(i - 1)));
          if (frames[i]!.tMs < frames[0]!.tMs + settleMs) continue;
          settled += 1;
          worstSettled = Math.max(worstSettled, Math.abs(up(i)));
        }
        // eslint-disable-next-line no-console
        console.log(
          `speed ${speed} ${sampleHz} Hz ${c.foot} [${c.fromMs.toFixed(0)}, ${c.toMs.toFixed(0)}] ms: heel ${(heel * 1000).toFixed(1)} mm, forefoot ${(up(0) * 1000).toFixed(1)} mm when held; settled ${(worstSettled * 1000).toFixed(2)} mm off the floor at worst over ${settled} frames; ${(worstSideways * 1000).toFixed(2)} mm sideways`,
        );
        // What the fixture exercises: the heel is down as the hold opens.
        expect(Math.abs(heel), `${c.foot} heel down`).toBeLessThan(0.02);
        if (c.foot === 'R_Toes') {
          // …and the route has the stopped hip's forefoot well up there.
          expect(up(0), `${c.foot} forefoot up when held`).toBeGreaterThan(0.01);
        }
        expect(settled, `${c.foot} settled frames`).toBeGreaterThan(1);
        // ON THE FLOOR once settled (was 15-18 mm above it on the right).
        expect(worstSettled, `${c.foot} settled height`).toBeLessThan(0.001);
        // Straight down: the settle moves the held point vertically only…
        expect(worstSideways, `${c.foot} sideways`).toBeLessThan(0.0005);
        // …and only ever toward the floor.
        expect(rising, `${c.foot} moving away from the floor`).toBeLessThan(1e-4);
      }
    }, 60_000); // a two-cycle walk on the rig: ~3 s at 120 Hz, more under load
  }
});
