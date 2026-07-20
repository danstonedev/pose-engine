/**
 * PLANK / PUSH-UP (Phase 3 Tier B) — the multi-contact grounding that "running →
 * push-up" needs. A plank is a straight prone-frame line held on the TOES (the
 * vertical pin) and the HANDS (a reach contact the hand-plant IK keeps planted on
 * the floor). This pins: (1) the pure planner (standing↔plank edges); and, on the
 * rig, (2) get-into-a-plank reaches the prone frame with hands+toes on the floor and
 * the hips elevated (a plank, not lying flat); (3) the push-up lowers the chest while
 * the hands stay planted and the elbows fold; (4) the full standing → plank → push-up
 * → stand chain flows with no root teleport and returns upright.
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
import { sampleMotionChain } from '../services/movementChain';
import { planPosturePath } from '../services/posturePlan';
import { resolveComposedMotion } from '../services/motionSequence';
import { buildGetDownToPlank, buildPushUp, buildStandFromPlank } from '../services/movementTemplates';
import { measureCommandMotion } from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const pitchDeg = (q: [number, number, number, number]): number => {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]), 'YXZ');
  return (e.x * 180) / Math.PI;
};

describe('planPosturePath — plank edges (pure)', () => {
  it('routes standing↔plank to get-into-a-plank / stand-from-plank', () => {
    const down = planPosturePath('standing', 'plank');
    expect(down?.length).toBe(1);
    expect(down![0]!.endPosture).toBe('plank');
    const up = planPosturePath('plank', 'standing');
    expect(up?.length).toBe(1);
    expect(up![0]!.startPosture).toBe('plank');
    expect(up![0]!.endPosture).toBe('standing');
  });
});

describe('DET-RES-02 — plank family authors the ankle WITHIN ROM (no silent clamp)', () => {
  // The toe-tuck used to author 40° plantarflexion against the 20° ankleFlexion
  // ROM limit — resolution silently clamped it, so authored intent and what
  // actually played disagreed. The family now authors AT the limit; this pins
  // that every ankle target survives resolution unchanged.
  it('every ankleFlexion target in get-down/push-up/stand resolves to exactly its authored value', () => {
    for (const motion of [buildGetDownToPlank(), buildPushUp({ reps: 2 }), buildStandFromPlank()]) {
      const resolved = resolveComposedMotion(motion, BODY_VARIANTS.male);
      expect(resolved.status, motion.name).toBe('ok');
      const ankles = resolved.outcomes.filter((o) => o.motion === 'ankleFlexion');
      expect(ankles.length, `${motion.name} authors ankle targets`).toBeGreaterThan(0);
      for (const o of ankles) {
        expect(o.status, `${motion.name} kf${o.keyframe} ${o.joint}.ankleFlexion`).not.toBe('refused');
        expect(
          Math.abs((o.clampedDegrees ?? NaN) - o.requestedDegrees),
          `${motion.name} kf${o.keyframe} ${o.joint}.ankleFlexion: authored ${o.requestedDegrees}° clamped to ${o.clampedDegrees}° (exceeds ROM)`,
        ).toBeLessThan(1e-6);
      }
    }
  });
});

describe('plank / push-up on the rig', () => {
  const variantCfg = BODY_VARIANTS.male;
  const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
  let root: THREE.Object3D;
  let skinned: THREE.SkinnedMesh;
  let rest: JointAngleRestReference;
  let baselinePose: CustomPose;

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
  });

  const y = (f: { worldTracks?: Record<string, [number, number, number]> }, k: string) =>
    f.worldTracks?.[k]?.[1] ?? NaN;

  it('gets into a plank, does push-ups, and stands — planted hands, real chest travel', () => {
    const chain = sampleMotionChain(
      [buildGetDownToPlank(), buildPushUp({ reps: 2 }), buildStandFromPlank()],
      { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30 },
    );
    expect(chain.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);

    // (2) The plank is a prone-frame line: hands AND toes on the floor, hips elevated.
    const plankEnd = chain[0]!.recording.frames.at(-1)!;
    expect(Math.abs(pitchDeg(plankEnd.root.orientQuat)), 'body pitched to the prone frame').toBeGreaterThan(60);
    expect(y(plankEnd, 'L_Toes'), 'toes on the floor').toBeLessThan(0.06);
    expect(y(plankEnd, 'L_Hand'), 'left hand planted on the floor').toBeLessThan(0.08);
    expect(y(plankEnd, 'R_Hand'), 'right hand planted on the floor').toBeLessThan(0.08);
    expect(y(plankEnd, 'Hips'), 'hips ELEVATED — a plank, not lying flat').toBeGreaterThan(0.25);

    // (3) The push-up lowers the chest a real distance while the hands stay planted.
    const push = chain[1]!.recording;
    const headY = push.frames.map((f) => y(f, 'Head'));
    expect(Math.max(...headY) - Math.min(...headY), 'chest travels through the rep').toBeGreaterThan(0.15);
    const handXZ = push.frames.map((f) => f.worldTracks?.L_Hand).filter(Boolean) as [number, number, number][];
    let handSlide = 0;
    const base = handXZ[0]!;
    for (const p of handXZ) handSlide = Math.max(handSlide, Math.hypot(p[0] - base[0], p[2] - base[2]));
    expect(handSlide, 'the planted hand barely slides while the body lowers over it').toBeLessThan(0.06);
    for (const f of push.frames) expect(y(f, 'L_Toes'), 'toes stay grounded through the reps').toBeLessThan(0.06);
    // The elbows FOLD (the defining push-up feature — the chest can only drop over a
    // planted hand if the arm bends).
    const elbow = push.frames.map(
      (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'L_Forearm', 'elbowFlexion') ?? 0,
    );
    expect(Math.max(...elbow), 'the elbow flexes at the bottom of the push-up').toBeGreaterThan(45);

    // (4) The whole chain flows with no seam teleport and ends standing upright.
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]!.seamRootTranslateM, `seam ${i} no translate teleport`).toBeLessThan(0.08);
    }
    const standEnd = chain[2]!.recording.frames.at(-1)!;
    expect(Math.abs(pitchDeg(standEnd.root.orientQuat)), 'upright again after standing up').toBeLessThan(20);
    expect(y(standEnd, 'Hips'), 'back to standing pelvis height').toBeGreaterThan(0.9);
  });
});
