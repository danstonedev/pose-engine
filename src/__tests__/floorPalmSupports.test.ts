import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { setRomClampEnabled } from '../services/poseRomClamp';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, authoredToTrajectoryTimeMap, type RecordedFrame } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { buildPushUp, buildGetDownToPlank } from '../services/movementPostures';
import { captureFloorReference } from '../services/rootMotion';

const point = (frame: RecordedFrame, key: string) => new THREE.Vector3().fromArray(frame.worldTracks![key]!);
const ids = ['push-up', 'trunk-stability-push-up', 'extension-clearing', 'flexion-clearing'];

describe.each(['male', 'female', 'neutral'] as const)('%s Blender-authored floor supports', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skinned: THREE.SkinnedMesh;
  let baseline: ReturnType<typeof serializeCustomPose>, rest: ReturnType<typeof captureJointAngleRestReference>;
  const initialPosition = new THREE.Vector3(), initialQuaternion = new THREE.Quaternion();
  let floorY: number;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    root = (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    root.traverse(object => { if (!skinned && (object as THREE.SkinnedMesh).isSkinnedMesh) skinned = object as THREE.SkinnedMesh; });
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    baseline = serializeCustomPose(skinned.skeleton, cfg, variant);
    rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    floorY = captureFloorReference(skinned.skeleton, cfg).floorY;
    initialPosition.copy(root.position); initialQuaternion.copy(root.quaternion);
  });
  // Browser calibration defaults to unclamped. Explicit supports must still
  // respect clinical limits and hold their palm pose in that host context.
  beforeEach(() => setRomClampEnabled(false));
  afterEach(() => setRomClampEnabled(null));

  function sample(id: string, sampleHz = 30, constrained = false) {
    root.position.copy(initialPosition); root.quaternion.copy(initialQuaternion);
    applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    const motion = id === 'push-up' ? buildPushUp({ reps: 2 }) : BODY_ASSESSMENT_MOTIONS[id]!('R');
    const resolved = resolveComposedMotion(motion, cfg);
    const recording = sampleComposedMotion(resolved, {
      baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz,
      ...(constrained ? { constraints: { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } } } } : {}),
      trackedBones: ['Hips', 'Head', ...['L', 'R'].flatMap(side => ['Leg', 'Toes', 'UpperArm', 'Forearm', 'Hand', 'Mid1', 'Index1', 'Pinky1'].map(bone => `${side}_${bone}`))],
    });
    const setupMs = resolved.startAtSetup ? 0 : authoredToTrajectoryTimeMap(resolved, recording.frames.at(-1)!.tMs).toTrajectory(resolved.keyframes[0].durationMs);
    return recording.frames.filter(frame => frame.tMs >= setupMs - .01);
  }

  it.each(ids)('%s retains both palms, forward fingers and a bounded arm through the whole cycle', id => {
    const frames = sample(id), first = frames[0]!;
    for (const side of ['L', 'R']) {
      for (const frame of frames) {
        for (const key of ['Hand', 'Mid1', 'Index1', 'Pinky1']) {
          expect(point(frame, `${side}_${key}`).distanceTo(point(first, `${side}_${key}`)), `${id} ${side} ${key} drift at ${frame.tMs}`).toBeLessThan(.002);
        }
        const fingers = point(frame, `${side}_Mid1`).sub(point(frame, `${side}_Hand`)).normalize();
        const normal = fingers.clone().cross(point(frame, `${side}_Index1`).sub(point(frame, `${side}_Pinky1`))).normalize().multiplyScalar(side === 'L' ? 1 : -1);
        expect(normal.y, 'palm faces the floor').toBeLessThan(-.995);
        expect(fingers.z, 'fingers face forward').toBeGreaterThan(.97);
        const hand = frame.angles[`${side}_Hand`]!, elbow = frame.angles[`${side}_Forearm`]!;
        expect(hand.wristFlexion).toBeGreaterThanOrEqual(-70.5);
        expect(hand.wristFlexion).toBeLessThanOrEqual(80.5);
        expect(Math.abs(elbow.forearmRotation)).toBeLessThanOrEqual(90.5);
        expect(elbow.elbowFlexion).toBeGreaterThanOrEqual(-.5);
        expect(elbow.elbowFlexion).toBeLessThanOrEqual(150.5);
        const shoulder = point(frame, `${side}_UpperArm`), elbowPoint = point(frame, `${side}_Forearm`);
        expect(elbowPoint.y - floorY, `${id} ${side} elbow floor clearance at ${frame.tMs}`).toBeGreaterThan(.02);
        expect(Math.abs(elbowPoint.x - shoulder.x), 'elbow does not flare out a full arm length').toBeLessThan(shoulder.distanceTo(elbowPoint) * .8);
      }
    }
    const keys = id === 'flexion-clearing' ? ['L_Leg', 'R_Leg'] : id === 'extension-clearing' ? ['Hips'] : ['L_Toes', 'R_Toes'];
    for (const key of keys) for (const frame of frames) {
      const delta = point(frame, key).sub(point(first, key));
      expect(Math.hypot(delta.x, delta.z), `${key} floor support`).toBeLessThan(id === 'flexion-clearing' ? .005 : .001);
    }
  });

  it('honors a patient wrist limit even when the palm target becomes unreachable', () => {
    for (const frame of sample('push-up', 15, true)) {
      expect(frame.angles.L_Hand!.wristFlexion).toBeGreaterThanOrEqual(-10.01);
      expect(frame.angles.L_Hand!.wristFlexion).toBeLessThanOrEqual(10.01);
    }
  });

  it('keeps incoming wrist contacts fixed when a plank continues into push-ups', () => {
    root.position.copy(initialPosition); root.quaternion.copy(initialQuaternion);
    applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    const chain = sampleMotionChain([buildGetDownToPlank(), buildPushUp({ reps: 2 })], {
      baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
      trackedBones: ['L_Hand', 'R_Hand'],
    });
    const entry = chain[0]!.recording.frames.at(-1)!;
    for (const frame of chain[1]!.recording.frames) for (const side of ['L', 'R']) {
      expect(point(frame, `${side}_Hand`).distanceTo(point(entry, `${side}_Hand`)), `${side} at ${frame.tMs}`).toBeLessThan(.002);
    }
  });

  it('produces the same supported arm poses at shared times across playback rates', () => {
    const low = sample('push-up', 30), high = sample('push-up', 60);
    for (const frame of low) {
      const same = high.find(other => Math.abs(other.tMs - frame.tMs) < .001)!;
      expect(same).toBeDefined();
      for (const side of ['L', 'R']) {
        expect(point(frame, `${side}_Hand`).distanceTo(point(same, `${side}_Hand`))).toBeLessThan(.0001);
        for (const bone of ['Shoulder', 'UpperArm', 'Forearm', 'Hand']) {
          const key = `${side}_${bone}`;
          expect(new THREE.Quaternion().fromArray(frame.pose.bones[key]!).angleTo(new THREE.Quaternion().fromArray(same.pose.bones[key]!))).toBeLessThan(.001);
        }
      }
    }
  });
});
