/**
 * Biomech half of the Validity Gate (Workstream A integration).
 *
 * Verifies runGaitBiomechChecks folds the normativeGait ground truth (Froude,
 * vertical-CoM, joint-angle RMS vs ±1 SD) into the gate for a gait-shaped
 * motion, returns [] for non-gait, catches a hyper-flexed knee counterfactual,
 * and composes into assessValidity's report through the runBiomechChecks hook.
 *
 * Harness mirrors validityGate.test.ts: load GLB → resolve → sampleComposedMotion
 * → world-space + measured-angle frames.
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
import { resolveComposedMotion, type ComposedMotion, type ResolvedComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { captureFloorReference } from '../services/rootMotion';
import { buildTravelWalk, buildSitDown } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { assessValidity, type GateFrame, type ValidityCheck } from '../services/validityGate';
import { runGaitBiomechChecks } from '../services/gaitBiomechCheck';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;
let floorY = 0;

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
  floorY = captureFloorReference(skinned.skeleton, variantCfg).floorY;
});

function sample(m: ComposedMotion): { resolved: ResolvedComposedMotion; frames: GateFrame[] } {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status).toBe('ok');
  const rec: MotionRecording = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  });
  // RecordedFrame carries tMs + worldTracks (incl. CoM) + angles — exactly the
  // GateFrame shape the biomech hook reads. Pass through (no clone needed).
  return { resolved, frames: rec.frames as unknown as GateFrame[] };
}

const byId = (checks: readonly ValidityCheck[], id: string): ValidityCheck | undefined =>
  checks.find((c) => c.id === id);

describe('runGaitBiomechChecks — normative kinematics on a gait-shaped motion', () => {
  it('a travel walk produces Froude + vertical-CoM + per-joint normative checks, all warn-severity', () => {
    const { resolved, frames } = sample(buildTravelWalk());
    const checks = runGaitBiomechChecks(resolved, frames);
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(c.severity).toBe('warn'); // realism findings, never hard fails

    const froude = byId(checks, 'froude');
    expect(froude, 'travel walk has forward speed → Froude reported').toBeDefined();
    expect(froude!.pass, `Froude ${froude!.measured} should not be in the run regime`).toBe(true);

    const com = byId(checks, 'vertical-com');
    expect(com, 'vertical CoM excursion reported').toBeDefined();
    expect(com!.pass, `CoM excursion ${com!.measured} cm within the accepted gait band`).toBe(true);

    // Per-joint normative checks are produced from the measured angles (values
    // are a REALISM finding, not asserted to pass — but must be well-formed).
    const knee = byId(checks, 'normative-kneeFlexion');
    expect(knee, 'knee graded against the normative curve').toBeDefined();
    expect(knee!.measured).toBeGreaterThanOrEqual(0);
    expect(knee!.measured).toBeLessThanOrEqual(1);
    expect(byId(checks, 'normative-hipFlexion')).toBeDefined();
    expect(byId(checks, 'normative-ankleFlexion')).toBeDefined();
  });

  it('a non-gait motion (sit-down) gets no gait biomech checks', () => {
    const { resolved, frames } = sample(buildSitDown());
    expect(runGaitBiomechChecks(resolved, frames)).toEqual([]);
  });

  it('a hyper-flexed knee trajectory fails the normative-knee band (the RMS check bites)', () => {
    const { resolved, frames } = sample(buildTravelWalk());
    const clean = byId(runGaitBiomechChecks(resolved, frames), 'normative-kneeFlexion')!;
    // Inject +45° onto every knee angle → far outside the ±1 SD corridor.
    const bent = frames.map((f) => ({
      ...f,
      angles: f.angles
        ? {
            ...f.angles,
            L_Leg: { ...(f.angles.L_Leg ?? {}), kneeFlexion: (f.angles.L_Leg?.kneeFlexion ?? 0) + 45 },
          }
        : f.angles,
    }));
    const bad = byId(runGaitBiomechChecks(resolved, bent), 'normative-kneeFlexion')!;
    expect(bad.measured, 'within-band fraction collapses vs the clean walk').toBeLessThan(clean.measured);
    expect(bad.pass, 'a +45° knee is not within ±1 SD of normal').toBe(false);
  });

  it('folds into assessValidity through the runBiomechChecks hook (one report)', () => {
    const { resolved, frames } = sample(buildTravelWalk());
    const withHook = assessValidity(resolved, frames, {
      floorY,
      runBiomechChecks: runGaitBiomechChecks,
    });
    expect(byId(withHook.checks, 'froude'), 'biomech checks are in the unified report').toBeDefined();
    expect(byId(withHook.checks, 'normative-kneeFlexion')).toBeDefined();
    // The gate no longer records the biomech gap in `skipped` once the hook runs.
    expect(withHook.skipped.some((s) => s.toLowerCase().includes('biomech'))).toBe(false);
    // Plausibility + biomech together still don't hard-fail a shipped walk.
    expect(withHook.overall).not.toBe('fail');
  });
});
