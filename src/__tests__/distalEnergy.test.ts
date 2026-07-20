/**
 * DISTAL ENERGY AT SPEED (Wave 5, roadmap 5.4).
 *
 * spinalGaitCoordination's DERIVED gains always scaled with the stride, but its
 * distal CONSTANTS (finger curl, wrist drag, elbow pump, head stabilization)
 * were speed-invariant — a runner swung with a walker's hand. The coordinator
 * now grades them by locomotor ENERGY (1 = a comfortable walk; a paced walk's
 * speed via paceGait's timeScale = √speed; ~2× the speed request for a run):
 *
 *   • the finger curl OPENS (a runner's hand un-curls), floored at a loose 14°;
 *   • the elbow pump amplitude GROWS about its authored mean (counter-phased
 *     with the arm swing, like the authored pump), capped at ±14°;
 *   • the wrist drag deepens (WRIST_FLEX_MAX still caps it);
 *   • headStabilize relaxes slightly (a runner's head rides more), never below
 *     85%.
 *
 * The critical contract: SPEED 1 IS BYTE-IDENTICAL — every delta is ×(energy−1),
 * so the walk the whole regression suite is calibrated against never moves.
 * Gated at target level AND measured on the rig (run vs walk finger curl).
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
import { measureCommandMotion } from '../services/movementCommand';
import {
  MOVEMENT_TEMPLATES,
  buildRun,
  buildTravelWalk,
  paceGait,
  spinalGaitCoordination,
  templateToComposedMotion,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

/** The authored speed-1 distal constants (pinned literals — the byte-identity
 *  contract is against these exact values). */
const WALK_FINGER_CURL = 32;
const FINGER_CURL_FLOOR = 14;
const WRIST_FLEX_CAP = 22;
const ELBOW_PUMP_CAP = 14;

const walk = (): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

const targetOf = (m: ComposedMotion, kfIndex: number, joint: string, motion: string): number | undefined =>
  m.keyframes[kfIndex]!.targets?.find((t) => t.joint === joint && t.motion === motion)?.targetDegrees;

/** All values of joint.motion across the motion's keyframes (absent → skipped). */
const series = (m: ComposedMotion, joint: string, motion: string): number[] =>
  m.keyframes.flatMap((kf) => {
    const t = kf.targets?.find((x) => x.joint === joint && x.motion === motion);
    return t ? [t.targetDegrees] : [];
  });

const excursion = (m: ComposedMotion, joint: string, motion: string): number => {
  const v = series(m, joint, motion);
  return v.length ? Math.max(...v) - Math.min(...v) : 0;
};

/** headStabilize readout: the neck axial counter over the trunk yaw it cancels
 *  (pelvis root yaw + thoracic + lumbar rotation) — exactly the effective
 *  headStab gain on keyframes where nothing hits a cap. Uses the keyframe with
 *  the LARGEST trunk sum (well away from caps' small-angle noise). */
const headStabRatio = (m: ComposedMotion): number => {
  let best = 0;
  let ratio = 1;
  for (const kf of m.keyframes) {
    const at = (j: string, mo: string): number =>
      kf.targets?.find((t) => t.joint === j && t.motion === mo)?.targetDegrees ?? 0;
    const sum = (kf.root?.orient?.yawDeg ?? 0) + at('Spine_Upper', 'rotation') + at('Spine_Lower', 'rotation');
    if (Math.abs(sum) > best) {
      best = Math.abs(sum);
      ratio = -at('Neck', 'rotation') / sum;
    }
  }
  return ratio;
};

describe('distal energy — SPEED 1 IS BYTE-IDENTICAL (the calibration contract)', () => {
  it('explicit energy 1 and the default derive to the identical motion', () => {
    const base = spinalGaitCoordination(walk());
    const explicit = spinalGaitCoordination(walk(), { energy: 1 });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(base));
  });

  it('paceGait speed 1 (timeScale 1) keeps the coordinated keyframes byte-identical', () => {
    const base = spinalGaitCoordination(walk());
    const paced = spinalGaitCoordination(paceGait(walk(), 1));
    expect(JSON.stringify(paced.keyframes)).toBe(JSON.stringify(base.keyframes));
  });

  it('buildTravelWalk speed 1 (and omitted) are byte-identical', () => {
    expect(JSON.stringify(buildTravelWalk({ speed: 1 }))).toBe(JSON.stringify(buildTravelWalk()));
  });

  it('the speed-1 walk keeps the EXACT authored distal constants — 32° curl, untouched elbows', () => {
    const raw = walk();
    const co = spinalGaitCoordination(raw);
    for (let i = 0; i < co.keyframes.length; i += 1) {
      for (const t of co.keyframes[i]!.targets ?? []) {
        if (t.motion === 'fingerFlexion') expect(t.targetDegrees, `kf${i} ${t.joint}`).toBe(WALK_FINGER_CURL);
      }
      // The elbow drivers are byte-identical to the authored template — no pump add.
      for (const S of ['L', 'R'] as const) {
        expect(targetOf(co, i, `${S}_Forearm`, 'elbowFlexion'), `kf${i} ${S} elbow`).toBe(
          targetOf(raw, i, `${S}_Forearm`, 'elbowFlexion'),
        );
      }
    }
    // Full head stabilization at walking speed.
    expect(headStabRatio(co)).toBeCloseTo(1, 6);
  });

  it('a SLOW walk keeps the walker’s hand too (energy floors at 1 — no inverted scaling)', () => {
    const slow = spinalGaitCoordination(paceGait(walk(), 0.6));
    for (const v of slow.keyframes.flatMap((kf) => kf.targets ?? []))
      if (v.motion === 'fingerFlexion') expect(v.targetDegrees).toBe(WALK_FINGER_CURL);
  });
});

describe('distal energy — a FAST walk gains distal energy (targets)', () => {
  const w1 = buildTravelWalk();
  const w145 = buildTravelWalk({ speed: 1.45 });

  it('the finger curl measurably OPENS with speed (still a curled hand)', () => {
    const fast = series(w145, 'R_Index1', 'fingerFlexion');
    expect(fast.length).toBeGreaterThan(0);
    for (const v of fast) {
      expect(v, 'opens vs the walk curl').toBeLessThan(WALK_FINGER_CURL - 2);
      expect(v, 'never past the loose-open floor').toBeGreaterThanOrEqual(FINGER_CURL_FLOOR);
    }
  });

  it('the elbow pump and wrist drag amplitudes GROW vs the speed-1 walk', () => {
    expect(excursion(w145, 'R_Forearm', 'elbowFlexion'), 'elbow pump grows').toBeGreaterThan(
      excursion(w1, 'R_Forearm', 'elbowFlexion') + 1.5,
    );
    expect(excursion(w145, 'R_Hand', 'wristFlexion'), 'wrist drag grows').toBeGreaterThan(
      excursion(w1, 'R_Hand', 'wristFlexion') + 1,
    );
  });

  it('headStabilize relaxes SLIGHTLY (still ≥ 85% — the head reads stable)', () => {
    const r = headStabRatio(w145);
    expect(r).toBeLessThan(0.995);
    expect(r).toBeGreaterThanOrEqual(0.85);
    // …and less relaxed than the run (energy ordering).
    expect(r).toBeGreaterThan(headStabRatio(buildRun()));
  });
});

describe('distal energy — the RUN gets run-form distal texture, capped physiologic', () => {
  const run = buildRun();

  it('the run finger curl is measurably OPEN vs the walk (a runner’s hand un-curls)', () => {
    for (const v of series(run, 'R_Index1', 'fingerFlexion')) {
      expect(v).toBeLessThanOrEqual(WALK_FINGER_CURL - 8);
      expect(v).toBeGreaterThanOrEqual(FINGER_CURL_FLOOR);
    }
  });

  it('the run elbows PUMP about their authored 85° carry (amplitude > 8° where the walk-form run had none)', () => {
    const exc = excursion(run, 'R_Forearm', 'elbowFlexion');
    expect(exc).toBeGreaterThan(8);
    // …and every pump stays inside the physiologic cap about the authored mean.
    for (const v of series(run, 'R_Forearm', 'elbowFlexion'))
      expect(Math.abs(v - 85)).toBeLessThanOrEqual(ELBOW_PUMP_CAP + 1e-9);
  });

  it('headStabilize relaxes at run speed but holds its floor', () => {
    const r = headStabRatio(run);
    expect(r).toBeLessThan(0.95);
    expect(r).toBeGreaterThanOrEqual(0.85);
  });

  it('at the 1.6 speed cap every distal amount stays physiologic (caps + floors hold)', () => {
    const fastRun = buildRun({ speed: 1.6 });
    for (const kf of fastRun.keyframes) {
      for (const t of kf.targets ?? []) {
        if (t.motion === 'fingerFlexion') {
          expect(t.targetDegrees, 'curl floored at a loose open hand').toBe(FINGER_CURL_FLOOR);
        }
        if (t.motion === 'wristFlexion') {
          expect(Math.abs(t.targetDegrees), 'wrist drag capped').toBeLessThanOrEqual(WRIST_FLEX_CAP);
        }
        if (t.joint.endsWith('_Forearm') && t.motion === 'elbowFlexion') {
          expect(Math.abs(t.targetDegrees - 85), 'elbow pump capped').toBeLessThanOrEqual(ELBOW_PUMP_CAP + 1e-9);
        }
      }
    }
  });
});

describe('distal energy — measured on the rig', () => {
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

  const measure = (m: ComposedMotion, joint: string, motion: string): number[] => {
    applyAnatomicPose(root, variantCfg);
    root.updateMatrixWorld(true);
    const resolved = resolveComposedMotion(m, variantCfg);
    expect(resolved.status).toBe('ok');
    const rec = sampleComposedMotion(resolved, {
      baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
    });
    return rec.frames.map(
      (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, joint, motion) ?? 0,
    );
  };

  it('at run speed the MEASURED finger curl opens and the elbow visibly pumps vs the walk', () => {
    const walkCurl = measure(spinalGaitCoordination(walk()), 'R_Index1', 'fingerFlexion');
    const runCurl = measure(buildRun(), 'R_Index1', 'fingerFlexion');
    const runElbow = measure(buildRun(), 'R_Forearm', 'elbowFlexion');
    // Settled distal posture: median of the second half of each recording (past
    // the neutral→gait entry transient).
    const settled = (v: number[]): number => {
      const half = v.slice(Math.floor(v.length / 2)).sort((a, b) => a - b);
      return half[Math.floor(half.length / 2)]!;
    };
    const wc = settled(walkCurl);
    const rc = settled(runCurl);
    // Steady-state pump only (the second half of the cycle recording) — the
    // neutral→run entry transient would inflate the range dishonestly.
    const steady = runElbow.slice(Math.floor(runElbow.length / 2));
    const elbowRange = Math.max(...steady) - Math.min(...steady);
    // eslint-disable-next-line no-console
    console.log(`rig distal energy: walk curl ${wc.toFixed(1)}° · run curl ${rc.toFixed(1)}° · run elbow range ${elbowRange.toFixed(1)}°`);
    expect(rc, 'the running hand is measurably more open').toBeLessThan(wc - 5);
    expect(rc, 'still gently curled, not splayed').toBeGreaterThan(5);
    expect(elbowRange, 'the run elbow pumps').toBeGreaterThan(6);
  });
});
