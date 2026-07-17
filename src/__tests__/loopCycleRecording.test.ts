/**
 * CLEAN LOOP-CYCLE RECORDING GATE (Finding 7) — `sampleComposedMotion` with
 * `loopCycle` records ONE seamless period of a looping motion (no standing
 * intro, velocity-continuous wrap) so a saved clip replays as a clean cycle,
 * instead of the one-shot "standing → cycle → last keyframe" pass.
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
import { sampleComposedMotion } from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

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

function resetToAnatomic(): void {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
}

const walkResolved = () =>
  resolveComposedMotion(templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!), variantCfg);

function kneeAt(rec: { frames: { tMs: number; angles: Record<string, Record<string, number>> }[] }, tMs: number): number {
  let best = rec.frames[0]!;
  for (const f of rec.frames) if (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  return best.angles['L_Leg']?.['kneeFlexion'] ?? 0;
}

describe('loopCycle recording — clean, seamless gait cycle', () => {
  it('a loopCycle walk never contains the standing pose (unlike the one-shot pass)', () => {
    resetToAnatomic();
    const oneShot = sampleComposedMotion(walkResolved(), {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
    });
    resetToAnatomic();
    const cycle = sampleComposedMotion(walkResolved(), {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60, loopCycle: true,
    });

    // The one-shot pass STARTS at standing (all legs neutral at t=0); the loop
    // cycle starts mid-gait and never shows the whole-body standing frame. Sum
    // the magnitudes of the four major leg joints per frame — standing ≈ 0, but
    // in gait at least one leg is always flexed, so the MIN stays well above 0.
    const legLoad = (f: { angles: Record<string, Record<string, number>> }) =>
      Math.abs(f.angles['L_UpLeg']?.['hipFlexion'] ?? 0) +
      Math.abs(f.angles['R_UpLeg']?.['hipFlexion'] ?? 0) +
      Math.abs(f.angles['L_Leg']?.['kneeFlexion'] ?? 0) +
      Math.abs(f.angles['R_Leg']?.['kneeFlexion'] ?? 0);
    expect(legLoad(oneShot.frames[0]!), 'one-shot starts standing').toBeLessThan(15);
    const cycleMinLoad = Math.min(...cycle.frames.map(legLoad));
    expect(cycleMinLoad, 'loop cycle never returns to standing').toBeGreaterThan(40);
  });

  it('the loop cycle is one period long and pose-continuous at the wrap (first ≈ last)', () => {
    resetToAnatomic();
    const cycle = sampleComposedMotion(walkResolved(), {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60, loopCycle: true,
    });
    const dur = cycle.frames[cycle.frames.length - 1]!.tMs;
    expect(dur).toBeCloseTo(1600, -1); // one 8×200 ms period (±)
    // Wrap continuity: the last sampled frame is one period from the first, so
    // they represent the same phase — the same knee angle within tolerance.
    expect(Math.abs(kneeAt(cycle, dur) - kneeAt(cycle, 0))).toBeLessThan(6);
  });

  it('loopCycle is ignored for a non-looping motion (one-shot recorded as before)', () => {
    resetToAnatomic();
    const squat = resolveComposedMotion(
      templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'squat')!),
      variantCfg,
    );
    const a = sampleComposedMotion(squat, {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
    });
    resetToAnatomic();
    const b = sampleComposedMotion(squat, {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60, loopCycle: true,
    });
    // Squat doesn't loop → loopCycle has no effect → identical frame count + id.
    expect(b.frames.length).toBe(a.frames.length);
    expect(b.id).toBe(a.id);
  });
});
