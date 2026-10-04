import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { fitPalmSupportPlane } from '../services/handSupportSurface';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { setRomClampEnabled } from '../services/poseRomClamp';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, authoredToTrajectoryTimeMap, type RecordedFrame } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { buildPushUp, buildGetDownToPlank } from '../services/movementPostures';
import { captureFloorReference } from '../services/rootMotion';
import type { RomScenarioConstraints } from '../services/romConstraints';

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
  afterEach(async () => {
    setRomClampEnabled(null);
    // These tests synchronously produce full production-rig recordings. Let
    // the worker report each result before the next recording blocks its loop.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });

  function sample(id: string, sampleHz = 30, constrained: boolean | RomScenarioConstraints = false, diagnosticPartialReach = false) {
    root.position.copy(initialPosition); root.quaternion.copy(initialQuaternion);
    applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    const motion = id === 'push-up' ? buildPushUp({ reps: 2 }) : BODY_ASSESSMENT_MOTIONS[id]!('R');
    // This opt-out exists only in the numerical regression below. It removes
    // the full-endpoint delivery contract, not a patient or contact limit.
    if (diagnosticPartialReach) motion.pronePalmAnchorFit = false;
    const resolved = resolveComposedMotion(motion, cfg);
    const constraints = constrained === true
      ? { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } } }
      : constrained || undefined;
    const recording = sampleComposedMotion(resolved, {
      baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz,
      ...(constraints ? { constraints } : {}),
      trackedBones: ['Hips', 'Head', ...['L', 'R'].flatMap(side => ['Leg', 'Toes', 'UpperArm', 'Forearm', 'Hand', 'Mid1', 'Index1', 'Pinky1'].map(bone => `${side}_${bone}`))],
    });
    const setupMs = resolved.startAtSetup ? 0 : authoredToTrajectoryTimeMap(resolved, recording.frames.at(-1)!.tMs).toTrajectory(resolved.keyframes[0].durationMs);
    return recording.frames.filter(frame => frame.tMs >= setupMs - .01);
  }

  it.each(ids)('%s retains both palms, forward fingers and a bounded arm through the whole cycle', id => {
    const frames = sample(id), first = frames[0]!;
    for (const side of ['L', 'R']) {
      let skinNormalBasis: THREE.Vector3 | undefined;
      if (id === 'extension-clearing' || id === 'flexion-clearing' || id === 'trunk-stability-push-up') {
        // Blender showed the palm skin support plane differs from the
        // metacarpal bone plane. Keep the same alignment tolerance on the
        // measured skin plane for both explicitly authored surface contacts.
        // Flexion clearing and trunk push-up also support the palm skin plane.
        root.position.fromArray(first.root.translateM); root.quaternion.fromArray(first.root.orientQuat);
        applyCustomPose(skinned.skeleton, cfg, first.pose); root.updateMatrixWorld(true);
        const hand = buildBoneByPoseKey(skinned.skeleton, cfg).get(`${side}_Hand`)!;
        const rotation = hand.getWorldQuaternion(new THREE.Quaternion()).normalize();
        const forward = point(first, `${side}_Mid1`).sub(point(first, `${side}_Hand`)).normalize();
        const normal = forward.clone().cross(point(first, `${side}_Index1`).sub(point(first, `${side}_Pinky1`))).normalize().multiplyScalar(side === 'L' ? 1 : -1);
        const lateral = normal.clone().cross(forward).normalize();
        const inverse = rotation.clone().invert();
        const fitted = fitPalmSupportPlane(skinned, hand, normal.clone().applyQuaternion(inverse), forward.clone().applyQuaternion(inverse));
        const measured = fitted.normalLocal.applyQuaternion(rotation);
        skinNormalBasis = new THREE.Vector3(measured.dot(forward), measured.dot(lateral), measured.dot(normal));
      }
      for (const frame of frames) {
        for (const key of ['Hand', 'Mid1', 'Index1', 'Pinky1']) {
          expect(point(frame, `${side}_${key}`).distanceTo(point(first, `${side}_${key}`)), `${id} ${side} ${key} drift at ${frame.tMs}`).toBeLessThan(.002);
        }
        const fingers = point(frame, `${side}_Mid1`).sub(point(frame, `${side}_Hand`)).normalize();
        const normal = fingers.clone().cross(point(frame, `${side}_Index1`).sub(point(frame, `${side}_Pinky1`))).normalize().multiplyScalar(side === 'L' ? 1 : -1);
        if (skinNormalBasis) {
          const lateral = normal.clone().cross(fingers).normalize();
          normal.multiplyScalar(skinNormalBasis.z).addScaledVector(fingers, skinNormalBasis.x).addScaledVector(lateral, skinNormalBasis.y).normalize();
        }
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
    if (id === 'extension-clearing') {
      const last = frames.at(-1)!;
      for (const [key, quaternion] of Object.entries(first.pose.bones)) {
        expect(last.pose.bones[key], `${key} is present at the loop seam`).toBeDefined();
        const before = new THREE.Quaternion().fromArray(quaternion).normalize();
        const after = new THREE.Quaternion().fromArray(last.pose.bones[key]!).normalize();
        expect(before.angleTo(after), `${key} returns to the same bounded pose`).toBeLessThan(.001);
      }
      // A fixed body and fixed palms must not accumulate a different girdle
      // solution during the authored hold. Reuse the sampled trajectory and
      // the existing cross-playback orientation tolerance.
      const source = BODY_ASSESSMENT_MOTIONS[id]!('R');
      const holdFrom = source.keyframes[0]!.durationMs + source.keyframes[1]!.durationMs;
      const holdTo = holdFrom + (source.keyframes[1]!.holdMs ?? 0);
      const held = frames.filter(frame => frame.tMs >= holdFrom - .001 && frame.tMs <= holdTo + .001);
      expect(held.length).toBeGreaterThan(1);
      for (const frame of held) for (const side of ['L', 'R']) for (const part of ['Shoulder', 'UpperArm', 'Forearm', 'Hand']) {
        const key = `${side}_${part}`;
        const before = new THREE.Quaternion().fromArray(held[0]!.pose.bones[key]!).normalize();
        const after = new THREE.Quaternion().fromArray(frame.pose.bones[key]!).normalize();
        expect(before.angleTo(after), `${key} holds its supported posture at ${frame.tMs}`).toBeLessThan(.001);
      }
    }
  });

  it('honors a patient wrist limit even when the palm target becomes unreachable', () => {
    for (const frame of sample('push-up', 15, true)) {
      expect(frame.angles.L_Hand!.wristFlexion).toBeGreaterThanOrEqual(-10.01);
      expect(frame.angles.L_Hand!.wristFlexion).toBeLessThanOrEqual(10.01);
    }
  });

  // This integration test generates three complete recordings per body. Its
  // assertions verify patient bounds and cache behavior; the framework's default
  // five-second timeout was never a product latency requirement. Allow CI
  // headroom over the measured 10–11 seconds without changing those assertions.
  it('honors patient bounds in an explicitly diagnostic partial reach, including cached playback', () => {
    const bounds = [
      { joint: 'L_Hand', field: 'wristFlexion', min: -10, max: 10 },
      { joint: 'L_Forearm', field: 'elbowFlexion', min: 110, max: 125 },
      { joint: 'R_Forearm', field: 'elbowFlexion', min: 40, max: 70 },
    ];
    const unconstrained = sample('extension-clearing', 30);
    for (const { joint, field, min, max } of bounds) {
      expect(unconstrained.some(frame => frame.angles[joint]![field]! < min - .5 || frame.angles[joint]![field]! > max + .5),
        `${joint}.${field} must exercise a genuinely restrictive patient limit`).toBe(true);
    }
    const constraints: RomScenarioConstraints = Object.fromEntries(bounds.map(({ joint, field, min, max }) =>
      [joint, { [field]: { availableRange: { min, max } } }]));
    // Intentionally bypass the full-endpoint contract to exercise unreachable
    // numerical projection. These frames are not supported-patient delivery
    // evidence; public prepared requests with these limits must be refused.
    for (let playback = 0; playback < 2; playback++) {
      const frames = sample('extension-clearing', 30, constraints, true);
      expect(frames.length).toBeGreaterThan(100);
      for (const frame of frames) {
      for (const { joint, field, min, max } of bounds) {
        const value = frame.angles[joint]![field]!;
        expect(value, `${joint}.${field} at ${frame.tMs} ms, playback ${playback}`).toBeGreaterThanOrEqual(min - .01);
        expect(value, `${joint}.${field} at ${frame.tMs} ms, playback ${playback}`).toBeLessThanOrEqual(max + .01);
      }
      }
    }
  }, 30_000);

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
