import { beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { preparePressupPalmLayout, type PreparePressupPalmLayoutOptions } from '../services/pressupPalmLayout';
import type { ProneSkinSupportResult } from '../services/proneSkinSupport';
import { isRomClampActive, setRomClampEnabled } from '../services/poseRomClamp';
import { pressupPatientRangeRefusal } from '../services/pressupPatientSupport';

vi.mock('../services/motionRecording', () => ({ sampleComposedMotion: vi.fn() }));

beforeEach(() => { vi.mocked(sampleComposedMotion).mockReset(); });

// This tests the planning schedule and recursion boundary. Its synthetic
// landmarks are deliberately not evidence of anatomical or contact acceptance.
it.each([2, 3])('plans distinct setup/endpoint/hold probes with %i authored phases', phases => {
  const source = BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R');
  const keyframes = structuredClone(source.keyframes.slice(0, phases));
  if (phases === 2) keyframes[1].holdMs = 10000;
  const motion = resolveComposedMotion({ ...source, keyframes, proneSkinSupport: true, pronePalmAnchorFit: true });
  expect(motion.status).toBe('ok');
  const setupEnd = motion.keyframes[0].durationMs + motion.keyframes[0].holdMs;
  const peakAt = setupEnd + motion.keyframes[1].durationMs;
  const holdEnd = peakAt + motion.keyframes[1].holdMs;
  const end = motion.keyframes.reduce((sum, frame) => sum + frame.durationMs + frame.holdMs, 0);
  const expectedTimes = phases === 2 ? [0, setupEnd, peakAt, holdEnd] : [0, setupEnd, peakAt, holdEnd, end];
  const pose: CustomPose = { variant: 'male', schemaVersion: POSE_SCHEMA_VERSION, bones: {} };
  vi.mocked(sampleComposedMotion).mockImplementation((probe, options) => {
    expect(probe.pronePalmAnchorFit).toBe(false);
    expect(options.frameTimesMs).toEqual(expectedTimes);
    return { id: 'synthetic-schedule', name: 'Synthetic schedule', variant: 'male', sourceKind: 'composed', sampleHz: 1,
      frames: options.frameTimesMs!.map(tMs => ({
      tMs, pose,
      root: { translateM: [0, 0, 0], orientQuat: [0, 0, 0, 1] },
      angles: { L_Forearm: { elbowFlexion: tMs === peakAt ? 8 : 90 }, R_Forearm: { elbowFlexion: tMs === peakAt ? 8 : 90 } },
      // Only the feasibility flag is consumed by this scheduling fixture.
      proneSupport: { feasible: true } as ProneSkinSupportResult,
      worldTracks: Object.fromEntries(['L', 'R'].flatMap((side, i) => [
        [`${side}_UpperArm`, [i * .3, .5, 0]],
        [`${side}_Forearm`, [i * .3, .25, .05]],
        [`${side}_Hand`, [i * .3, 0, 0]],
      ])),
    })) } as ReturnType<typeof sampleComposedMotion>;
  });
  const root = new THREE.Group();
  const skinned = new THREE.SkinnedMesh();
  skinned.bind(new THREE.Skeleton([])); root.add(skinned);
  const options: PreparePressupPalmLayoutOptions = { resolvedMotion: motion, baselinePose: pose,
    variantCfg: BODY_VARIANTS.male, skeletonHarness: { root, skinned },
    rest: { pelvisWorldQuat: [0, 0, 0, 1], worldQuats: {}, localQuats: {}, worldDirs: { Spine_Lower: [0, 0, 1] } },
  };
  const result = preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(1);
  expect(result.iterations[0].peakElbowFlexionDeg).toEqual([8, 8]);
  expect(result.endpointReached).toBe(true);
  expect(motion.pronePalmAnchorFit).toBe(true);
  expect(motion.keyframes[1].holdMs).toBe(phases === 2 ? 10000 : source.keyframes[1].holdMs);

  const original = structuredClone(result);
  result.contacts[0].palmSupport!.forward = 999;
  expect(preparePressupPalmLayout(options)).toEqual(original);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(1);

  // A patient edit, model edit, or placement change must force fresh planning.
  options.constraints = { L_Forearm: { elbowFlexion: { availableRange: { min: 0, max: 90 } } } };
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(2);
  options.constraints.L_Forearm!.elbowFlexion!.availableRange!.max = 60;
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(3);
  const positions = new THREE.Float32BufferAttribute([0, 0, 0], 3);
  skinned.geometry.setAttribute('position', positions);
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(4);
  positions.setY(0, .01); positions.needsUpdate = true;
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(5);
  root.position.x += .1;
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(6);

  const helper = new THREE.Bone(); helper.name = 'Unowned helper'; root.add(helper);
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(7);
  helper.rotateX(.1);
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(8);

  const hips = new THREE.Bone(); hips.name = 'CC_Base_Hip'; root.add(hips);
  skinned.bind(new THREE.Skeleton([hips]));
  pose.bones.Hips = [0, 0, 0, 1];
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(9);
  hips.rotateX(.2);
  const incoming = hips.quaternion.clone();
  preparePressupPalmLayout(options);
  // Incoming playback on a bone reset by baseline is irrelevant to planning,
  // but the caller's current pose must still survive a cached lookup unchanged.
  expect(sampleComposedMotion).toHaveBeenCalledTimes(9);
  expect(hips.quaternion.toArray()).toEqual(incoming.toArray());

  // An elbow range disjoint from the accepted extension endpoint cannot be
  // repaired by searching palm locations. Keep the original layout explicitly
  // unresolved. Public delivery refuses this unsupported endpoint request.
  options.constraints = { R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
  const excluded = preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(9);
  expect(excluded.contacts).toEqual(motion.contacts);
  expect(excluded.iterations).toEqual([]);
  expect(excluded.endpointReached).toBe(false);
  expect(excluded.reasons).toContain(pressupPatientRangeRefusal(motion, options.constraints));
  expect(hips.quaternion.toArray()).toEqual(incoming.toArray());

  options.constraints.R_Forearm!.elbowFlexion!.availableRange!.min = 12;
  preparePressupPalmLayout(options);
  expect(sampleComposedMotion).toHaveBeenCalledTimes(10);
  // Browser calibration and Node/default clamp modes can produce different
  // source poses even for identical motion JSON and the same live rig.
  const originalClampMode = isRomClampActive();
  try {
    setRomClampEnabled(!originalClampMode);
    preparePressupPalmLayout(options);
    expect(sampleComposedMotion).toHaveBeenCalledTimes(11);
    setRomClampEnabled(originalClampMode);
    preparePressupPalmLayout(options);
    expect(sampleComposedMotion).toHaveBeenCalledTimes(11);
  } finally {
    setRomClampEnabled(null);
  }
});
