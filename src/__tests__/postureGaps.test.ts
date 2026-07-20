/**
 * POSTURE GRAPH — closing the gaps (Phase 3 Tier B+). Kneeling (standing↔kneel), prone
 * reached DOWN through hands-and-knees ("lie face down" = standing→quadruped→prone, no
 * faceplant), and the quadruped↔plank connector. This pins the planner routes and, on
 * the rig, verifies each new posture is actually reached with no seam teleport.
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
import { buildKneelDown, buildStandFromKneel } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const pitchDeg = (q: [number, number, number, number]): number => {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]), 'YXZ');
  return (e.x * 180) / Math.PI;
};
const TRACK = ['Hips', 'Head', 'L_Leg', 'R_Leg', 'L_Foot', 'L_Toes', 'L_Hand'];

describe('planPosturePath — closed gaps (pure)', () => {
  it('routes standing↔kneeling directly', () => {
    expect(planPosturePath('standing', 'kneeling')?.length).toBe(1);
    expect(planPosturePath('kneeling', 'standing')?.length).toBe(1);
  });
  it('routes standing↔prone by ROLLING through supine + a side (a real "roll over")', () => {
    const down = planPosturePath('standing', 'prone');
    expect(down?.length).toBe(3); // standing → supine → side → prone
    expect(down!.map((m) => m.endPosture)).toEqual(['supine', expect.stringMatching(/^sidelying-/), 'prone']);
    const up = planPosturePath('prone', 'standing');
    expect(up?.length).toBe(3); // prone → side → supine → stand up
    expect(up!.map((m) => m.endPosture)).toEqual([expect.stringMatching(/^sidelying-/), 'supine', 'standing']);
  });
  it('connects quadruped↔plank directly', () => {
    expect(planPosturePath('quadruped', 'plank')?.length).toBe(1);
    expect(planPosturePath('plank', 'quadruped')?.length).toBe(1);
  });
});

describe('closed gaps on the rig', () => {
  const variantCfg = BODY_VARIANTS.male;
  const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
  let root: THREE.Object3D; let skinned: THREE.SkinnedMesh; let rest: JointAngleRestReference; let baselinePose: CustomPose;

  beforeAll(async () => {
    const buf = readFileSync(fileURLToPath(GLB_URL));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
      const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder); l.parse(ab, '', res as never, rej);
    });
    root = gltf.scene; root.scale.setScalar(variantCfg.pose.rootScale);
    root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh; });
    root.updateMatrixWorld(true); applyAnatomicPose(root, variantCfg); root.updateMatrixWorld(true);
    rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
    baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  });

  const y = (f: { worldTracks?: Record<string, [number, number, number]> }, k: string) => f.worldTracks?.[k]?.[1] ?? NaN;
  const runChain = (motions: ReturnType<typeof buildKneelDown>[]) =>
    sampleMotionChain(motions, { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30, trackedBones: TRACK as never });

  it('kneel down reaches an UPRIGHT kneel (torso vertical, knees down, feet not clipping), and stands', () => {
    const chain = runChain([buildKneelDown(), buildStandFromKneel()]);
    expect(chain.map((c) => c.status)).toEqual(['ok', 'ok']);
    const kn = chain[0]!.recording.frames.at(-1)!;
    expect(Math.abs(pitchDeg(kn.root.orientQuat)), 'torso stays upright (identity orient)').toBeLessThan(20);
    expect(y(kn, 'L_Leg'), 'left knee on the floor').toBeLessThan(0.06);
    expect(y(kn, 'R_Leg'), 'right knee on the floor').toBeLessThan(0.06);
    expect(y(kn, 'Hips'), 'pelvis at kneeling (thigh) height, well below standing').toBeGreaterThan(0.4);
    expect(y(kn, 'Hips'), 'pelvis clearly below standing').toBeLessThan(0.7);
    expect(y(kn, 'Head'), 'head still high — kneeling tall, not folded').toBeGreaterThan(1.0);
    expect(y(kn, 'L_Toes'), 'foot does not clip through the floor').toBeGreaterThan(-0.05);
    expect(chain[1]!.seamRootTranslateM, 'kneel→stand no teleport').toBeLessThan(0.08);
    const st = chain[1]!.recording.frames.at(-1)!;
    expect(y(st, 'Hips'), 'back to standing pelvis height').toBeGreaterThan(0.9);
  });

  it('"lie face down" ROLLS to prone (lie down → roll over), face-down + low, no seam teleport', () => {
    const path = planPosturePath('standing', 'prone')!; // standing → supine → side → prone
    const chain = runChain(path as never);
    expect(chain.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);
    const end = chain.at(-1)!.recording.frames.at(-1)!;
    // ends FACE-DOWN (the body forward axis points at the floor) and low to the floor.
    const eq = end.root.orientQuat;
    const face = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(eq[0], eq[1], eq[2], eq[3]));
    expect(face.y, 'ends prone — face toward the floor').toBeLessThan(-0.7);
    const standHead = chain[0]!.recording.frames[0]!;
    expect(y(end, 'Hips'), 'pelvis is down near the floor when prone').toBeLessThan(y(standHead, 'Hips') - 0.6);
    // the ROLL motions (after the lie-down) stay low — never sitting up. (chain[0] is
    // the lie-down, where the head legitimately starts at standing height and descends.)
    for (const c of chain.slice(1)) for (const f of c.recording.frames) {
      expect(y(f, 'Head'), 'head stays low through the roll (no sit-up)').toBeLessThan(0.6);
    }
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]!.seamRootTranslateM, `seam ${i} no teleport`).toBeLessThan(0.1);
    }
  });

  it('FLOOR GET-UP: the planner gets the body up to standing from prone and from side-lying', () => {
    for (const from of ['prone', 'sidelying-left', 'sidelying-right'] as const) {
      const path = planPosturePath(from, 'standing');
      expect(path, `${from}→standing reachable`).not.toBeNull();
      // From lying, get up = roll back to supine, then sit up and stand — every step a
      // real transition, ending on the feet with no teleport.
      const chain = runChain([...(path as never[])]);
      expect(chain.map((c) => c.status).every((s) => s === 'ok'), `${from} get-up all ok`).toBe(true);
      const end = chain.at(-1)!.recording.frames.at(-1)!;
      expect(y(end, 'Hips'), `${from}: ends standing`).toBeGreaterThan(0.9);
      for (let i = 1; i < chain.length; i += 1) {
        expect(chain[i]!.seamRootTranslateM, `${from} seam ${i} no teleport`).toBeLessThan(0.1);
      }
    }
  });
});
