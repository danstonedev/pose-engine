/**
 * LOOP-FORM VERTICAL CALIBRATION + HANDOFF (DET-LOCK-02) — a LOOPING walk's
 * vcal table must be derived from the LOOP-form trajectory (the cycle that
 * actually sustains), indexed at a phase that is CONTINUOUS across the
 * loop-engage boundary. Before the fix the one-shot pass derived its own table
 * (the standing intro inflated the arc: gain 0.853 vs the loop's 0.989), so
 * the pelvis stepped up ~3.4 cm one pass in and recordings didn't match the
 * stage (2.0 cm mean / 4.6 cm max on the first pass).
 *
 * Emulates the stage's "first pass → loop" playback with the SAME sampler code
 * the stage mirrors: pass 1 is the one-shot recording, passes 2+ are the
 * periodic loopCycle recording entered at the last keyframe's phase (exactly
 * how the stage seeds its loop clock at `enterAtMs`).
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
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  calibrateGaitVertical,
  NORMAL_GAIT_VERTICAL_CM,
} from '../services/movementTemplates';
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

/** The in-place looping walk with the normal calibrated vertical (the loop +
 *  vcal combination DET-LOCK-02 is about — the bare template has no target). */
const calibratedWalk = () =>
  calibrateGaitVertical(
    templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!),
    NORMAL_GAIT_VERTICAL_CM,
  );

function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
}

function sample(loopCycle: boolean): MotionRecording {
  resetHarness();
  return sampleComposedMotion(resolveComposedMotion(calibratedWalk(), variantCfg), {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
    ...(loopCycle ? { loopCycle: true } : {}),
  });
}

/** Pelvis (Hips) world Y at tMs, linearly interpolated between frames, cm. */
function pelvisYCm(rec: MotionRecording, tMs: number): number {
  const fs = rec.frames;
  let i = 0;
  while (i < fs.length - 1 && fs[i + 1]!.tMs < tMs) i += 1;
  const a = fs[i]!;
  const b = fs[Math.min(fs.length - 1, i + 1)]!;
  const ya = a.worldTracks!['Hips']![1];
  const yb = b.worldTracks!['Hips']![1];
  const span = b.tMs - a.tMs;
  const f = span > 0 ? Math.min(1, Math.max(0, (tMs - a.tMs) / span)) : 0;
  return (ya + (yb - ya) * f) * 100;
}

describe('DET-LOCK-02 — loop-form vcal: no pelvis step when the loop engages', () => {
  it('pelvis world-Y per-frame delta stays < 1 cm/frame across the loop-engage boundary (2+ passes)', () => {
    const oneShot = sample(false); // pass 1 — what the stage plays first
    const cycle = sample(true); // the periodic loop the stage then engages
    const period = cycle.frames[cycle.frames.length - 1]!.tMs;
    // The one-shot reaches keyframe i at τ_i + dur₀; the loop indexes it at
    // phase τ_i — so the loop clock enters at (one-shot total − dur₀), exactly
    // the stage's `enterAtMs` seeding.
    const dur0 = resolveComposedMotion(calibratedWalk(), variantCfg).keyframes[0]!.durationMs;
    const totalOneShot = oneShot.frames[oneShot.frames.length - 1]!.tMs;
    const enterPhase = totalOneShot - dur0;
    const dt = 1000 / 60;

    // Stitch 2+ passes: pass 1 = the one-shot frames; passes 2-3 = the loop
    // sampled from the entry phase onward (wrapping). Walk the stitched series
    // frame by frame through the boundary and one full extra pass.
    const stitchedYCm = (tMs: number): number =>
      tMs <= totalOneShot
        ? pelvisYCm(oneShot, tMs)
        : pelvisYCm(cycle, (enterPhase + (tMs - totalOneShot)) % period);
    let maxBoundaryDelta = 0;
    for (let t = totalOneShot - 200; t <= totalOneShot + period; t += dt) {
      const d = Math.abs(stitchedYCm(t + dt) - stitchedYCm(t));
      if (t <= totalOneShot + 200) maxBoundaryDelta = Math.max(maxBoundaryDelta, d);
      // Every per-frame delta through the passes stays gait-smooth too.
      expect(d, `per-frame pelvis ΔY at t=${t.toFixed(0)}ms`).toBeLessThan(1);
    }
    // The loop-engage boundary itself (was a ~3.4 cm step before the fix).
    expect(maxBoundaryDelta, 'loop-engage boundary step').toBeLessThan(1);
    // And the exact handoff instant matches the loop's entry phase closely.
    expect(Math.abs(pelvisYCm(cycle, enterPhase) - pelvisYCm(oneShot, totalOneShot))).toBeLessThan(0.5);
  });

  it('the first pass rides the SAME table as the loop: in-cycle vertical matches within 0.5 cm mean', () => {
    const oneShot = sample(false);
    const cycle = sample(true);
    const period = cycle.frames[cycle.frames.length - 1]!.tMs;
    const dur0 = resolveComposedMotion(calibratedWalk(), variantCfg).keyframes[0]!.durationMs;
    // Compare the first pass's cycle portion (after the entry ramp completes at
    // the first keyframe's arrival) against the loop at the SAME phase. Before
    // the fix the two tables differed (gain 0.853 vs 0.989) → 2.0 cm mean.
    let sum = 0;
    let n = 0;
    let max = 0;
    for (const f of oneShot.frames) {
      if (f.tMs < dur0) continue;
      const d = Math.abs(f.worldTracks!['Hips']![1] * 100 - pelvisYCm(cycle, (f.tMs - dur0) % period));
      sum += d;
      n += 1;
      max = Math.max(max, d);
    }
    expect(n).toBeGreaterThan(50);
    // With the shared loop-form table + phase alignment the first pass is
    // numerically exact vs the loop (~1e-14 cm); the OLD one-shot-derived table
    // measured 0.30 cm mean / 1.28 cm max here (and 2.0 cm mean live-vs-
    // recording on the stage) — both bounds catch a regression outright.
    expect(sum / n, 'mean first-pass vs loop vertical divergence (cm)').toBeLessThan(0.1);
    expect(max, 'max first-pass vs loop vertical divergence (cm)').toBeLessThan(0.5);
  });

});
