/**
 * THE END-TO-END TUNING LOOP, on the real rig.
 *
 * policySearch.test.ts proves the optimizer finds optima on synthetic bowls. This
 * file answers the question that actually matters and that a synthetic objective
 * cannot: does the engine's own objective MOVE when the trunk gains move?
 *
 * That question was open for a reason. The shipped ValidityReport.score is a mean
 * of per-check {1, 0.5, 0} tokens, and it was measured at exactly 0.80 across a
 * 14-point sweep of these same four gains — a search driven by it is a search over
 * a constant. So the first assertion here is the load-bearing one: the CONTINUOUS
 * objective must be non-constant where the token score is flat. If that assertion
 * ever fails, the tuning loop is decoration and this suite should say so loudly
 * rather than let a green optimizer test imply otherwise.
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
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { captureFloorReference } from '../services/rootMotion';
import { assessValidity } from '../services/validityGate';
import { runGaitBiomechChecks } from '../services/gaitBiomechCheck';
import { buildTravelWalk, spinalGaitCoordination } from '../services/movementTemplates';
import { motionObjective, gradedCheckIds } from '../services/motionObjective';
import { searchParameters, identityVector, type Vector } from '../services/policySearch';
import { GAIT_TRUNK_PARAMETERS, toSpinalOpts, applyTrunkGains } from '../services/gaitTuning';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;
let floorY = 0;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url)));
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

/** Resolve + rig-sample + grade one candidate. This IS the evaluation an
 *  optimizer pays for — ~200-400 ms, dominated entirely by sampling. */
function evaluateVector(v: Vector): { reward: number; valid: boolean; score: number } {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const motion: ComposedMotion = applyTrunkGains(buildTravelWalk(), v, spinalGaitCoordination);
  const resolved = resolveComposedMotion(motion, variantCfg);
  if (resolved.status !== 'ok') return { reward: -Infinity, valid: false, score: 0 };
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 30, // sampling is ~98% of the cost; 30 Hz halves it and the gate is unchanged
  });
  const report = assessValidity(resolved, rec.frames, { floorY, runBiomechChecks: runGaitBiomechChecks });
  const obj = motionObjective(report);
  return { reward: obj.reward, valid: obj.valid, score: report.score };
}

describe('the objective is CONTINUOUS where the shipped score is flat', () => {
  it('moves under gain changes that leave ValidityReport.score constant', () => {
    // The load-bearing assertion. A 14-point sweep of these gains was measured at
    // score 0.80 throughout; if the continuous objective is ALSO constant then
    // there is nothing to optimize and the loop below is theatre.
    const probes: Vector[] = [
      identityVector(GAIT_TRUNK_PARAMETERS),
      { axial: 0.04, lateral: 0.02, pelvis: 0.03, headStabilize: 1 },
      { axial: 0.28, lateral: 0.08, pelvis: 0.09, headStabilize: 0.6 },
      { axial: 0.16, lateral: 0.06, pelvis: 0.05, headStabilize: 0.8 },
    ];
    const results = probes.map(evaluateVector);
    const rewards = results.map((r) => r.reward);
    const distinct = new Set(rewards.map((r) => r.toFixed(6)));
    expect(distinct.size, `rewards were ${JSON.stringify(rewards)}`).toBeGreaterThan(1);

    const spread = Math.max(...rewards) - Math.min(...rewards);
    expect(spread, 'objective must have usable dynamic range').toBeGreaterThan(1e-3);
  });

  it('grades the checks it claims to, and reports any it does not', () => {
    const known = new Set(gradedCheckIds());
    root.position.copy(rootRest0);
    root.quaternion.copy(rootQuat0);
    root.updateMatrixWorld(true);
    const resolved = resolveComposedMotion(buildTravelWalk(), variantCfg);
    const rec = sampleComposedMotion(resolved, {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
    });
    const obj = motionObjective(
      assessValidity(resolved, rec.frames, { floorY, runBiomechChecks: runGaitBiomechChecks }),
    );
    expect(obj.terms.length).toBeGreaterThan(3);
    // An added gate check must not fall silently out of the objective.
    for (const id of obj.ungraded) expect(known.has(id)).toBe(false);
  });
});

describe('the identity point is exactly the shipped motion', () => {
  it('applying the identity vector reproduces the untuned gains', () => {
    // The contract that stops a tuning run from redefining the clinical reference:
    // the search must be able to return to the shipped values EXACTLY.
    expect(toSpinalOpts(identityVector(GAIT_TRUNK_PARAMETERS))).toEqual({
      axial: 0.16,
      lateral: 0.03,
      pelvis: 0.05,
      headStabilize: 1,
    });
  });

  it('every parameter identity sits inside its own bounds', () => {
    for (const p of GAIT_TRUNK_PARAMETERS) {
      expect(p.identity, p.name).toBeGreaterThanOrEqual(p.min);
      expect(p.identity, p.name).toBeLessThanOrEqual(p.max);
      expect(p.max, p.name).toBeGreaterThan(p.min);
    }
  });
});

describe('the loop recovers a deliberately degraded parameter', () => {
  it('search from a bad start beats the bad start, on the real rig', async () => {
    // The end-to-end claim, stated so it can be falsified: starting from gains
    // that are measurably worse than shipped, the search must find something
    // better than where it started. It is NOT asserted that it beats the shipped
    // values — those were hand-tuned against things this objective cannot see
    // (breathing, gaze and the whole live-only layer are invisible offline).
    // The start must be VALID but worse. An INVALID start makes baselineReward
    // -Infinity, and then "best > baseline" is trivially true and proves nothing
    // about optimization — the first version of this test passed that way.
    const degraded = [
      { name: 'axial', min: 0.02, max: 0.3, identity: 0.28 },
      { name: 'lateral', min: 0.01, max: 0.09, identity: 0.08 },
      { name: 'pelvis', min: 0.02, max: 0.1, identity: 0.09 },
      { name: 'headStabilize', min: 0.5, max: 1, identity: 0.6 },
    ];
    expect(evaluateVector(identityVector(degraded)).valid, 'degraded start must be VALID').toBe(true);
    const r = await searchParameters(
      degraded,
      async (v) => {
        const e = evaluateVector(v);
        return e.valid ? e.reward : -Infinity;
      },
      { budget: 24, seed: 13, initialStep: 0.2 },
    );
    expect(Number.isFinite(r.baselineReward), 'a -Infinity baseline proves nothing').toBe(true);
    expect(r.bestReward).toBeGreaterThan(r.baselineReward);
    expect(r.accepted).toBeGreaterThan(0);
    for (const p of degraded) {
      expect(r.best[p.name]).toBeGreaterThanOrEqual(p.min);
      expect(r.best[p.name]).toBeLessThanOrEqual(p.max);
    }
  }, 120_000);

  it('the search never proposes a motion the GATE rejects', async () => {
    // Reward is a shaping signal; assessValidity stays the authority. A search
    // that could talk its way past a safety check would be worse than no search.
    let sawInvalidAccepted = false;
    await searchParameters(
      GAIT_TRUNK_PARAMETERS,
      async (v) => {
        const e = evaluateVector(v);
        if (!e.valid) return -Infinity;
        return e.reward;
      },
      {
        budget: 12,
        seed: 21,
        onStep: (s) => {
          if (s.accepted && !Number.isFinite(s.reward)) sawInvalidAccepted = true;
        },
      },
    );
    expect(sawInvalidAccepted).toBe(false);
  }, 120_000);
});
