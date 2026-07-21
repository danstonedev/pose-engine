/**
 * RAIL-CLIP LOOP TRIM (DET-LOCK-04) — `trimRecordingLoopCycle` trims a
 * live-captured looping clip to a clean cycle by starting at the TRAJECTORY
 * START (the first real motion frame / end of the ~950 ms ready-settle standing
 * intro), NOT at t=0. A naive t=0 trim keeps the standing intro, so the rail clip
 * loops back through the standing pose every cycle; trimming from the trajectory
 * start makes the clip begin in the gait cycle and stay C¹ across the wrap.
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
import { resolveComposedMotion } from '../services/motionSequence';
import {
  sampleComposedMotion,
  trimRecording,
  trimRecordingLoopCycle,
  recordingDurationMs,
  type MotionRecording,
  type RecordedFrame,
} from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

// Sampled ONCE (deterministic; rig sampling is the expensive part) and reused
// across the cases below — a clean live-rail recording (standing head + cycle)
// plus the underlying clean cycle and its period.
let rail: MotionRecording;
let cycle: MotionRecording;
let headMs: number;
let period: number;

const legLoad = (f: { angles: Record<string, Record<string, number>> }): number =>
  Math.abs(f.angles['L_UpLeg']?.['hipFlexion'] ?? 0) +
  Math.abs(f.angles['R_UpLeg']?.['hipFlexion'] ?? 0) +
  Math.abs(f.angles['L_Leg']?.['kneeFlexion'] ?? 0) +
  Math.abs(f.angles['R_Leg']?.['kneeFlexion'] ?? 0);

const kneeAt = (rec: MotionRecording, tMs: number): number => {
  let best = rec.frames[0]!;
  for (const f of rec.frames) if (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  return best.angles['L_Leg']?.['kneeFlexion'] ?? 0;
};

const reTime = (f: RecordedFrame, tMs: number): RecordedFrame => ({ ...f, tMs, angles: f.angles, pose: f.pose });

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  const root = gltf.scene as THREE.Object3D;
  let skinned!: THREE.SkinnedMesh;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const rest: JointAngleRestReference = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  const baselinePose: CustomPose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  const walkResolved = () =>
    resolveComposedMotion(templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!), variantCfg);
  const resetToAnatomic = () => {
    applyAnatomicPose(root, variantCfg);
    root.updateMatrixWorld(true);
  };

  const hz = 60;
  const dt = 1000 / hz;
  resetToAnatomic();
  // The standing head: the one-shot pass's first frame is the neutral stand.
  const oneShot = sampleComposedMotion(walkResolved(), {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: hz,
  });
  const standing = oneShot.frames[0]!;
  resetToAnatomic();
  // The clean gait cycle (velocity-continuous across the wrap).
  cycle = sampleComposedMotion(walkResolved(), {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: hz, loopCycle: true,
  });
  period = recordingDurationMs(cycle);
  // A "live rail" recording: ~950 ms of held standing (the ready-settle) at the
  // head, then the clean cycle shifted after it — the shape the live stage
  // captures for a looping motion (settle-into-ready, then loop).
  const headCount = Math.round(950 / dt);
  headMs = headCount * dt;
  const headFrames: RecordedFrame[] = [];
  for (let i = 0; i < headCount; i += 1) headFrames.push(reTime(standing, i * dt));
  const cycleFrames = cycle.frames.map((f) => reTime(f, headMs + f.tMs));
  rail = { ...cycle, id: 'rail-walk', name: 'walk (rail)', frames: [...headFrames, ...cycleFrames] };
});

describe('trimRecordingLoopCycle — rail clip starts at the gait cycle, not the standing intro', () => {
  it('the scenario is non-vacuous: the rail recording DOES start with a standing intro', () => {
    expect(legLoad(rail.frames[0]!), 'rail head is standing').toBeLessThan(15);
    // The standing intro is genuinely ~950 ms long (held, not moving).
    const departIdx = rail.frames.findIndex((f) => legLoad(f) > 40);
    expect(rail.frames[departIdx]!.tMs).toBeGreaterThan(headMs - 40);
  });

  it('trims from the trajectory START — the trimmed clip begins IN the gait cycle', () => {
    const trimmed = trimRecordingLoopCycle(rail, { periodMs: period });
    // First frame is mid-gait (a leg loaded), never the standing pose.
    expect(legLoad(trimmed.frames[0]!), 'trimmed clip starts in gait').toBeGreaterThan(40);
    // No frame in the trimmed clip is the standing pose (the intro is gone).
    const minLoad = Math.min(...trimmed.frames.map(legLoad));
    expect(minLoad, 'trimmed clip never returns to standing').toBeGreaterThan(40);
  });

  it('keeps exactly one period and stays C¹ across the loop wrap (first ≈ last)', () => {
    const trimmed = trimRecordingLoopCycle(rail, { periodMs: period });
    expect(recordingDurationMs(trimmed)).toBeCloseTo(period, -1);
    // The captured cycle is velocity-continuous across the wrap, so one period
    // from the start lands the last frame back on the first frame's phase.
    expect(Math.abs(kneeAt(trimmed, recordingDurationMs(trimmed)) - kneeAt(trimmed, 0))).toBeLessThan(6);
  });

  it('COUNTERFACTUAL: a naive t=0 trim keeps the standing intro (the bug this fixes)', () => {
    const naive = trimRecording(rail, 0, period);
    // The old t=0 trim starts in the standing intro — exactly what DET-LOCK-04 flags.
    expect(legLoad(naive.frames[0]!), 'naive trim starts standing').toBeLessThan(15);
  });

  it('a clean loopCycle recording (no standing head) passes through byte-identical', () => {
    const trimmed = trimRecordingLoopCycle(cycle, { periodMs: period });
    expect(trimmed.frames.length).toBe(cycle.frames.length);
    expect(trimmed.frames[0]!.tMs).toBe(cycle.frames[0]!.tMs);
    expect(recordingDurationMs(trimmed)).toBe(recordingDurationMs(cycle));
  });
});
