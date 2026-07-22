/**
 * Posture-aware base of support (visual-feedback fix). The balance instrument
 * was feet-only, so load-bearing HANDS (plank/push-up/quadruped) were invisible
 * and a stable floor posture read as the CoM tens of cm "outside" its base — an
 * alarming false "off balance" in the clinical readout. Now:
 *   • a floor/seated posture (groundingPosture set) is NOT feet-base-scored
 *     (statically supported on a base the feet-only model doesn't represent);
 *   • upright standing holds (lunge, kick, single-leg) are scored against the
 *     real feet base and read as over it;
 *   • a genuine single-support perturbation (stepping strategy) still measures
 *     the CoM leaving the base — the metric isn't neutered.
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
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  buildGetDownToPlank,
  buildPushUp,
  buildBirdDog,
  buildSquat,
} from '../services/movementTemplates';
import { computeBalanceTimeline } from '../services/centerOfMass';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let r0: THREE.Vector3;
let q0: THREE.Quaternion;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const g = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  root = g.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  r0 = root.position.clone();
  q0 = root.quaternion.clone();
}, 120_000);

function timeline(m: ComposedMotion) {
  root.position.copy(r0);
  root.quaternion.copy(q0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 30,
  });
  return computeBalanceTimeline(rec);
}

const tpl = (id: string) => templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === id)!);

describe('posture-aware base of support', () => {
  it('upright standing holds read as OVER their feet base (no false topple)', () => {
    // Was a feet-only artifact for the lunge (rear foot ignored → tens of cm
    // "outside"); now both feet anchor the base and the CoM sits inside it.
    expect(timeline(tpl('forward-lunge')).minMarginM!, 'lunge').toBeGreaterThan(0);
    expect(timeline(tpl('kick')).minMarginM!, 'kick').toBeGreaterThan(-0.02);
    expect(timeline(tpl('single-leg-stance')).minMarginM!, 'single-leg').toBeGreaterThan(0);
  });

  it('floor postures (plank / push-up / quadruped) are NOT feet-base-scored', () => {
    // A hand/knee-borne posture is statically supported on a base the feet-only
    // model doesn't represent — those frames report marginM null, so the readout
    // can never show the old alarming "COM 60 cm outside the base".
    const plank = timeline(buildGetDownToPlank());
    const plankFloorFrames = plank.frames.filter((f) => f.marginM == null).length;
    expect(plankFloorFrames, 'plank has un-scored floor frames').toBeGreaterThan(0);

    // A pure plank hold is entirely floor-supported → nothing feet-base-scored.
    expect(timeline(buildPushUp()).minMarginM, 'push-up not feet-base-scored').toBeNull();
    expect(timeline(buildBirdDog()).minMarginM, 'bird-dog not feet-base-scored').toBeNull();
  });

  it('a genuine single-support perturbation still measures the CoM leaving the base', () => {
    // The stepping strategy's whole point is the CoM exceeding the base and a
    // protective step recovering it — the metric must NOT be neutered to always-positive.
    expect(timeline(tpl('stepping-strategy')).minMarginM!, 'stepping strategy').toBeLessThan(-0.02);
  });

  it('buildSquat compensates limited dorsiflexion — balanced until the ROM budget runs out, then loses balance', () => {
    // Physics-informed compensation seed: as available ankle DF is restricted the
    // shins can't advance and the pelvis over-sits back, so buildSquat inclines the
    // trunk forward (hip-hinge + bounded spine) to carry the CoM over the mid-foot.
    // Full DF matches the shipped squat; moderate restriction stays balanced VIA the
    // compensation; severe restriction exhausts the hip+spine ROM budget and the CoM
    // genuinely leaves the base (backward loss) — the compensate-else-fall behaviour.
    const full = timeline(buildSquat({})).minMarginM!;
    expect(full, 'full-DF buildSquat balanced').toBeGreaterThan(0);
    // …and it reproduces the flat template within ~1cm (no measurement distortion).
    expect(Math.abs(full - timeline(tpl('squat')).minMarginM!), 'buildSquat({}) ~= template').toBeLessThan(0.01);
    // Moderate restriction (18°): still balanced, but only because of the compensation.
    expect(timeline(buildSquat({ dorsiflexionCapDeg: 18 })).minMarginM!, 'df18 compensated').toBeGreaterThan(0);
    // Severe restriction (10°): un-compensable → the CoM leaves the base (balance lost).
    expect(timeline(buildSquat({ dorsiflexionCapDeg: 10 })).minMarginM!, 'df10 balance lost').toBeLessThan(0);
  });

  it('the bodyweight squat keeps the CoM over the mid-foot the whole descent', () => {
    // Regression for the CoM-forward finding: the old squat, capped at 20° ankle DF
    // (open-chain AROM), over-sat the pelvis ~32 cm behind the ankles and the CoM
    // fell ~11 cm BEHIND the heels (a backward loss of balance, min margin ≈ −11 cm).
    // Allowing weight-bearing DF (~32°, closed-chain) advances the shins so the knees
    // track forward, the pelvis stops over-sitting-back, and the CoM stays over the
    // base — feet planted, no spine rounding. Must read balanced end-to-end.
    const tl = timeline(tpl('squat'));
    expect(tl.minMarginM!, 'squat min margin (over mid-foot, not behind the heels)').toBeGreaterThan(0);
    expect(tl.balancedFraction, 'squat balanced across the whole rep').toBe(1);
  });
});
