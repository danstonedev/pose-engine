/**
 * TURN-IN-PLACE GATE — buildTurnInPlace is the engine's first turning
 * vocabulary (roadmap 4.1; the audit graded turns F: "the engine cannot
 * turn"). It must be a real STEP TURN — the clinically normal pattern — not a
 * spin: 2-4 small steps, each lifting one foot while the root yaws a portion
 * of the total on the stance foot, placing it, transferring weight; feet stay
 * under the body; ends in quiet standing facing the new heading.
 *
 * All rig-sampled:
 *   • the final body heading (a horizontal PELVIS FORWARD VECTOR built from
 *     the hip-joint world positions — never an Euler readout) lands within
 *     ±10° of the request;
 *   • the feet ALTERNATE — each step lifts one foot while the other holds,
 *     and the planted foot's horizontal drift stays inside a generous pivot
 *     budget (pivot feet DO rotate about their own contact in life — the
 *     budget bounds translation, not swivel);
 *   • the turn ENDS BALANCED (positive margin of stability through the final
 *     stand);
 *   • deterministic — two samples are byte-identical.
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
import { resolveComposedMotion, type ResolvedComposedMotion } from '../services/motionSequence';
import {
  sampleComposedMotion,
  DEFAULT_TRACKED_BONES,
  type MotionRecording,
} from '../services/motionRecording';
import { computeBalanceTimeline } from '../services/centerOfMass';
import { buildTurnInPlace } from '../services/movementTemplates';
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
 *  each sample (else consecutive samples accumulate the prior state). */
function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

/** Hip-joint bones tracked ON TOP of the defaults — the pelvis forward vector
 *  is built from their world positions (a real horizontal direction on the
 *  rig, not an Euler decomposition). */
const TURN_TRACKED = [...DEFAULT_TRACKED_BONES, 'L_UpLeg', 'R_UpLeg'] as const;

function sampleTurn(degrees?: number): { rec: MotionRecording; resolved: ResolvedComposedMotion } {
  resetHarness();
  const resolved = resolveComposedMotion(buildTurnInPlace(degrees != null ? { degrees } : {}), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
    trackedBones: TURN_TRACKED,
  });
  return { rec, resolved };
}

const track = (f: MotionRecording['frames'][number], key: string): [number, number, number] =>
  f.worldTracks![key]!;
const frameAt = (r: MotionRecording, tMs: number) =>
  r.frames.reduce((b, f) => (Math.abs(f.tMs - tMs) < Math.abs(b.tMs - tMs) ? f : b));

/** Horizontal PELVIS FORWARD heading (deg about +Y; 0 = world +Z, + toward
 *  subject-left/+X — the root yawDeg convention) from the hip-joint world
 *  positions: lateral = L_hip − R_hip, forward = lateral × up. */
function pelvisYawDeg(f: MotionRecording['frames'][number]): number {
  const l = track(f, 'L_UpLeg');
  const r = track(f, 'R_UpLeg');
  const latX = l[0] - r[0];
  const latZ = l[2] - r[2];
  // forward = cross(lateral, up) on the floor plane: (latX,0,latZ)×(0,1,0) = (−latZ, 0, latX)
  const fwdX = -latZ;
  const fwdZ = latX;
  return (Math.atan2(fwdX, fwdZ) * 180) / Math.PI;
}

/** Signed smallest angular difference a−b in degrees, in (−180, 180]. */
function angDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Cumulative RESOLVED keyframe end times (the trajectory's knot arrivals at
 *  timeScale 1) — the honest time base for per-step assertions. */
function keyframeEnds(resolved: ResolvedComposedMotion): number[] {
  const ends: number[] = [];
  let cursor = 0;
  for (const kf of resolved.keyframes) {
    cursor += kf.durationMs;
    ends.push(cursor);
    cursor += kf.holdMs;
  }
  return ends;
}

describe('buildTurnInPlace — a 2-4 step pivot on the root yawDeg primitive', () => {
  it('is a planted, non-looping step turn: lift/place per step + a settle, yaw authored per keyframe', () => {
    const m = buildTurnInPlace(); // default 180
    expect(m.stance).toBe('planted');
    expect(m.loop ?? false).toBe(false);
    expect(m.footDrivenTravel ?? false).toBe(false);
    // 180° at ≤~60°/step ⇒ 3 steps of (lift, place) + the settle.
    expect(m.keyframes.length).toBe(7);
    // Every keyframe authors the root yaw explicitly — the yawDeg primitive.
    for (const kf of m.keyframes) expect(kf.root?.orient?.yawDeg).toBeTypeOf('number');
    // The final keyframe faces the full request and stands centred.
    expect(m.keyframes[m.keyframes.length - 1]!.root?.orient?.yawDeg).toBe(180);
    expect(m.keyframes[m.keyframes.length - 1]!.root?.translateM).toEqual([0, 0, 0]);
    // Degrees clamp to ±360; direction comes from the sign.
    const lastYaw = (deg: number): number | undefined => {
      const kfs = buildTurnInPlace({ degrees: deg }).keyframes;
      return kfs[kfs.length - 1]!.root?.orient?.yawDeg;
    };
    expect(lastYaw(900)).toBe(360);
    expect(lastYaw(-900)).toBe(-360);
    expect(buildTurnInPlace({ degrees: -90 }).keyframes.length).toBe(5); // 2 steps
  });

  for (const degrees of [180, -90]) {
    describe(`${degrees}° turn (${degrees > 0 ? 'left' : 'right'})`, () => {
      let rec: MotionRecording;
      let resolved: ResolvedComposedMotion;
      beforeAll(() => {
        ({ rec, resolved } = sampleTurn(degrees === 180 ? undefined : degrees));
      });

      it('rig: the final body heading lands within ±10° of the request (pelvis forward vector)', () => {
        const finalYaw = pelvisYawDeg(rec.frames[rec.frames.length - 1]!);
        const err = Math.abs(angDiff(finalYaw, degrees));
        // eslint-disable-next-line no-console
        console.log(`turn ${degrees}°: final pelvis heading ${finalYaw.toFixed(1)}° (err ${err.toFixed(1)}°)`);
        expect(err, 'faces the requested heading').toBeLessThanOrEqual(10);
      });

      it('rig: the feet ALTERNATE — each step lifts one foot while the planted one holds (pivot budget)', () => {
        const ends = keyframeEnds(resolved);
        const nSteps = (resolved.keyframes.length - 1) / 2;
        const firstStep = degrees > 0 ? 'L' : 'R'; // the outside foot leads
        for (let k = 0; k < nSteps; k += 1) {
          const S = (k % 2 === 0 ? firstStep : firstStep === 'L' ? 'R' : 'L') as 'L' | 'R';
          const O = S === 'L' ? 'R' : 'L';
          const liftEnd = ends[2 * k]!;
          const liftStart = k === 0 ? 0 : ends[2 * k - 1]!;
          const atLift = frameAt(rec, liftEnd);
          const stepY = track(atLift, `${S}_Foot`)[1];
          const stanceY = track(atLift, `${O}_Foot`)[1];
          // The stepping foot is clearly up while the stance foot stays down.
          expect(stepY - stanceY, `step ${k}: ${S} foot lifts`).toBeGreaterThan(0.02);
          // The planted foot HOLDS through the lift: horizontal drift from its
          // position at lift onset stays inside a generous pivot budget — the
          // stance foot of a step turn rotates about its contact (as in life)
          // but must not walk away.
          const at0 = frameAt(rec, liftStart);
          const p0 = track(at0, `${O}_Foot`);
          let maxDrift = 0;
          for (const f of rec.frames) {
            if (f.tMs < liftStart - 1e-6 || f.tMs > liftEnd + 1e-6) continue;
            const p = track(f, `${O}_Foot`);
            maxDrift = Math.max(maxDrift, Math.hypot(p[0] - p0[0], p[2] - p0[2]));
          }
          // eslint-disable-next-line no-console
          console.log(`turn ${degrees}° step ${k}: ${S} lift ${(100 * (stepY - stanceY)).toFixed(1)}cm · ${O} stance drift ${(100 * maxDrift).toFixed(1)}cm`);
          expect(maxDrift, `step ${k}: ${O} stance foot holds (pivot budget)`).toBeLessThan(0.15);
        }
      });

      it('rig: the feet stay UNDER the body — no travel, a tight pivot footprint', () => {
        const last = rec.frames[rec.frames.length - 1]!;
        // The pelvis ends where it started (a turn, not a walk)…
        const hips0 = track(rec.frames[0]!, 'Hips');
        const hips1 = track(last, 'Hips');
        expect(Math.hypot(hips1[0] - hips0[0], hips1[2] - hips0[2]), 'no net travel').toBeLessThan(0.1);
        // …and both feet end near the pelvis axis (stance width, not a stride).
        for (const foot of ['L_Foot', 'R_Foot'] as const) {
          const p = track(last, foot);
          expect(Math.hypot(p[0] - hips1[0], p[2] - hips1[2]), `${foot} under the body`).toBeLessThan(0.25);
        }
      });

      it('rig: ends BALANCED — positive margin of stability through the final stand', () => {
        const tl = computeBalanceTimeline(rec);
        const total = rec.frames[rec.frames.length - 1]!.tMs;
        const tail = tl.frames.filter((f) => f.tMs >= total - 200);
        expect(tail.length).toBeGreaterThan(3);
        for (const f of tail) {
          expect(f.airborne, 'standing, never airborne').toBe(false);
          expect(f.marginM, 'COM inside the base').not.toBeNull();
          expect(f.marginM!).toBeGreaterThan(0);
        }
        // eslint-disable-next-line no-console
        console.log(`turn ${degrees}°: final margin ${(tail[tail.length - 1]!.marginM! * 100).toFixed(1)}cm`);
      });

      it('deterministic — two samples are byte-identical', () => {
        const again = sampleTurn(degrees === 180 ? undefined : degrees).rec;
        expect(JSON.stringify(again.frames)).toBe(JSON.stringify(rec.frames));
      });
    });
  }
});
