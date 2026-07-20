/**
 * QUADRUPED + BIRD-DOG (Phase 3 Tier B) — hands-and-knees on the multi-contact
 * grounding (shins as the vertical pin, hands as reach-IK contacts), plus the
 * bird-dog exercise where one arm + the opposite leg lift to horizontal (the raised
 * hand releases its floor contact, the raised knee lifts off the pin). This pins:
 * (1) the planner (standing↔quadruped edges); and, on the rig, (2) get-onto-hands-
 * and-knees reaches the prone frame with hands + knees on the floor, hips elevated,
 * and the feet not clipping through; (3) the bird-dog raises the correct diagonal
 * while the support hand + knee stay planted; (4) the full chain flows and stands.
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
import { measureCommandMotion } from '../services/movementCommand';
import { planPosturePath } from '../services/posturePlan';
import { buildGetDownToQuadruped, buildBirdDog, buildStandFromQuadruped } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const pitchDeg = (q: [number, number, number, number]): number => {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]), 'YXZ');
  return (e.x * 180) / Math.PI;
};
const TRACK = ['Hips', 'Head', 'L_Hand', 'R_Hand', 'L_Leg', 'R_Leg', 'L_Foot', 'R_Foot', 'L_Toes', 'R_Toes'];

describe('planPosturePath — quadruped edges (pure)', () => {
  it('routes standing↔quadruped to get-onto-hands-and-knees / stand-from-quadruped', () => {
    const down = planPosturePath('standing', 'quadruped');
    expect(down?.length).toBe(1);
    expect(down![0]!.endPosture).toBe('quadruped');
    const up = planPosturePath('quadruped', 'standing');
    expect(up?.length).toBe(1);
    expect(up![0]!.startPosture).toBe('quadruped');
    expect(up![0]!.endPosture).toBe('standing');
  });
});

describe('quadruped + bird-dog on the rig', () => {
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
    root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh; });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, variantCfg);
    root.updateMatrixWorld(true);
    rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
    baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  });

  const y = (f: { worldTracks?: Record<string, [number, number, number]> }, k: string) =>
    f.worldTracks?.[k]?.[1] ?? NaN;

  it('gets onto hands and knees, does a bird-dog (R arm + L leg), and stands', () => {
    const chain = sampleMotionChain(
      [buildGetDownToQuadruped(), buildBirdDog({ side: 'R' }), buildStandFromQuadruped()],
      { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30, trackedBones: TRACK as never },
    );
    expect(chain.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);

    // (2) Quadruped: hands + knees on the floor, hips elevated, feet not clipping.
    const quad = chain[0]!.recording.frames.at(-1)!;
    expect(Math.abs(pitchDeg(quad.root.orientQuat)), 'trunk pitched to horizontal').toBeGreaterThan(70);
    expect(y(quad, 'L_Hand'), 'left hand on the floor').toBeLessThan(0.08);
    expect(y(quad, 'R_Hand'), 'right hand on the floor').toBeLessThan(0.08);
    expect(y(quad, 'L_Leg'), 'left knee on the floor').toBeLessThan(0.06);
    expect(y(quad, 'R_Leg'), 'right knee on the floor').toBeLessThan(0.06);
    expect(y(quad, 'Hips'), 'hips elevated at thigh height').toBeGreaterThan(0.35);
    expect(y(quad, 'L_Toes'), 'left foot does not clip through the floor').toBeGreaterThan(-0.05);
    expect(y(quad, 'R_Toes'), 'right foot does not clip through the floor').toBeGreaterThan(-0.05);

    // (3) Bird-dog: at the hold, the RAISED R hand + L foot lift clear while the SUPPORT
    // L hand + R knee stay planted, and the trunk stays roughly horizontal.
    const bd = chain[1]!.recording;
    const rHandTop = Math.max(...bd.frames.map((f) => y(f, 'R_Hand')));
    const lFootTop = Math.max(...bd.frames.map((f) => y(f, 'L_Foot')));
    expect(rHandTop, 'the raised (right) hand lifts off the floor').toBeGreaterThan(0.25);
    expect(lFootTop, 'the raised (left) leg lifts off the floor').toBeGreaterThan(0.25);
    // support side stays down throughout
    for (const f of bd.frames) {
      expect(y(f, 'L_Hand'), 'the support (left) hand stays planted').toBeLessThan(0.1);
      expect(y(f, 'R_Leg'), 'the support (right) knee stays planted').toBeLessThan(0.08);
    }

    // (3b) WRIST RELEASE (Wave 5, roadmap 5.6): the audit flagged the raised arm
    // carrying the −45° floor-palm wrist through the whole reach — a hand still
    // cocked for a floor that isn't there. At the raise the lifted wrist must
    // read ~NEUTRAL (the hand continues the forearm line) while the SUPPORT
    // wrist keeps its extended floor palm; back on all fours, the raised wrist
    // re-extends for the floor.
    const wrist = (f: (typeof bd.frames)[number], side: 'L' | 'R'): number =>
      measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, `${side}_Hand`, 'wristFlexion') ?? 0;
    const topFrame = bd.frames.reduce((a, b) => (y(b, 'R_Hand') > y(a, 'R_Hand') ? b : a));
    // eslint-disable-next-line no-console
    console.log(`bird-dog wrists at raise: raised R ${wrist(topFrame, 'R').toFixed(1)}° · support L ${wrist(topFrame, 'L').toFixed(1)}°`);
    expect(Math.abs(wrist(topFrame, 'R')), 'the raised wrist releases to neutral').toBeLessThan(10);
    expect(wrist(topFrame, 'L'), 'the support wrist keeps its floor palm').toBeLessThan(-30);
    expect(wrist(bd.frames[0]!, 'R'), 'the wrist starts extended on the floor').toBeLessThan(-30);
    expect(wrist(bd.frames.at(-1)!, 'R'), 'the wrist re-extends for the floor on return').toBeLessThan(-30);

    // (4) The whole chain flows with no seam teleport and ends standing upright.
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]!.seamRootTranslateM, `seam ${i} no translate teleport`).toBeLessThan(0.08);
    }
    const standEnd = chain[2]!.recording.frames.at(-1)!;
    expect(Math.abs(pitchDeg(standEnd.root.orientQuat)), 'upright again').toBeLessThan(20);
    expect(y(standEnd, 'Hips'), 'back to standing pelvis height').toBeGreaterThan(0.9);
  });
});
