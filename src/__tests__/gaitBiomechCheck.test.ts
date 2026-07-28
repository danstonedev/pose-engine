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
import { buildTravelWalk, buildTravelRun, buildSitDown } from '../services/movementTemplates';
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
    const { checks } = runGaitBiomechChecks(resolved, frames);
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
    expect(runGaitBiomechChecks(resolved, frames).checks).toEqual([]);
  });

  /** Add `deg` to one knee across every frame. */
  const bendKnee = (frames: readonly GateFrame[], boneKey: string, deg: number) =>
    frames.map((f) => ({
      ...f,
      angles: f.angles
        ? {
            ...f.angles,
            [boneKey]: {
              ...(f.angles[boneKey] ?? {}),
              kneeFlexion: (f.angles[boneKey]?.kneeFlexion ?? 0) + deg,
            },
          }
        : f.angles,
    }));

  it('a hyper-flexed knee trajectory fails the normative-knee band (the RMS check bites)', () => {
    const { resolved, frames } = sample(buildTravelWalk());
    const clean = byId(runGaitBiomechChecks(resolved, frames).checks, 'normative-kneeFlexion')!;
    // The walk publishes leadFoot R_Foot, so R_Leg is the limb whose initial
    // contact opens the cycle and therefore the one graded.
    const bent = bendKnee(frames, 'R_Leg', 45);
    const bad = byId(runGaitBiomechChecks(resolved, bent).checks, 'normative-kneeFlexion')!;
    expect(bad.measured, 'within-band fraction collapses vs the clean walk').toBeLessThan(clean.measured);
    expect(bad.pass, 'a +45° knee is not within ±1 SD of normal').toBe(false);
  });

  it('grades the limb whose initial contact opens the cycle, not a fixed side', () => {
    // The regression this pins: the check used to hardcode the LEFT limb while the
    // walk's cycle opens on the RIGHT, so it graded a curve half a cycle out of
    // phase against the normative one — reading a knee that is 67% within ±1 SD as
    // 19%, a false warn on a correct gait. Bending the CONTRALATERAL knee must not
    // move a check that claims to describe the lead limb.
    const { resolved, frames } = sample(buildTravelWalk());
    expect(resolved.gaitCycleMs?.leadFoot, 'the walk leads with R').toBe('R_Foot');
    const clean = byId(runGaitBiomechChecks(resolved, frames).checks, 'normative-kneeFlexion')!;
    const otherSide = byId(
      runGaitBiomechChecks(resolved, bendKnee(frames, 'L_Leg', 45)).checks,
      'normative-kneeFlexion',
    )!;
    expect(otherSide.measured).toBe(clean.measured);
  });

  it('is unaffected by a standing ready-settle head on the recording', () => {
    // gaitCycleMs is authored on the RESOLVED clock, where the motion starts at 0.
    // simMOVE's live playback tap does not share that origin — it records a
    // standing hold (~950 ms) first — so an uncorrected window selects the hold and
    // the initiation instead of the gait. That is not hypothetical: it is why the
    // UI card read knee 0.33 while the offline suite read 0.67 on the same motion.
    const { resolved, frames } = sample(buildTravelWalk());
    const measured = (fs: readonly GateFrame[]) => {
      const { checks } = runGaitBiomechChecks(resolved, fs);
      return ['normative-kneeFlexion', 'normative-hipFlexion', 'normative-ankleFlexion', 'froude']
        .map((id) => byId(checks, id)?.measured);
    };
    const baseline = measured(frames);
    expect(baseline.every((v) => typeof v === 'number')).toBe(true);

    const dt = 1000 / 60;
    for (const headMs of [250, 950, 1500]) {
      // A held opening pose, then the motion — one wall-clock timeline.
      const head = Array.from({ length: Math.round(headMs / dt) }, (_, i) => ({
        ...frames[0]!,
        tMs: i * dt,
      }));
      const withHead = [...head, ...frames.map((f) => ({ ...f, tMs: f.tMs + headMs }))];
      expect(measured(withHead), `${headMs} ms head changed the verdict`).toEqual(baseline);
    }
  });

  it('skips the walking normative curves for a motion that declares the run regime', () => {
    // Running kinematics genuinely differ from the bundled Winter/Perry WALKING
    // curves, so grading a run against them measures the walk/run difference and
    // reports a correct run as broken.
    const { resolved, frames } = sample(buildTravelRun());
    const { checks, skipped } = runGaitBiomechChecks(resolved, frames);
    expect(resolved.gaitRegime).toBe('run');
    for (const j of ['kneeFlexion', 'hipFlexion', 'ankleFlexion']) {
      expect(byId(checks, `normative-${j}`), `${j} must not be graded on a run`).toBeUndefined();
    }
    expect(skipped.some((s) => s.includes('WALKING norms'))).toBe(true);
  });

  it('a declared run PASSES Froude for being a run; a walk at the same speed does not', () => {
    const { resolved, frames } = sample(buildTravelRun());
    const fr = byId(runGaitBiomechChecks(resolved, frames).checks, 'froude')!;
    expect(fr.measured, 'the shipped run is well past the walk→run transition').toBeGreaterThan(0.5);
    expect(fr.pass, 'a run clearing the transition is a correct run').toBe(true);
    // Same measured Froude, declared as a walk, must still be caught.
    const asWalk = { ...resolved, gaitRegime: 'walk' as const };
    expect(byId(runGaitBiomechChecks(asWalk, frames).checks, 'froude')!.pass).toBe(false);
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
