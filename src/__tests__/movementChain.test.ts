/**
 * COMPOUND CHAIN GATE (simMOVE Phase 4) — proves a larger movement built by
 * sequencing VALIDATED primitives (a) flows through the chain WITHOUT teleporting
 * between segments, and (b) each sub-movement still independently passes its own
 * Phase-1 kinematic signature. The teleport counter-example (a segment that
 * resets to neutral instead of continuing) makes the seam gate non-vacuous.
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
import { sampleComposedMotion, exportKinematics } from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { buildSignatureFromExport, driverKeysOf, scoreAgainstSignature } from '../services/movementSignature';
import { sampleMotionChain, measureSeamContinuity, measureSeamRootDiscontinuity } from '../services/movementChain';
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

const harness = () => ({ baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30 });
function templateMotion(id: string): ComposedMotion {
  const t = MOVEMENT_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`no template ${id}`);
  return templateToComposedMotion(t);
}
/** Reference signature for a template, from a STANDALONE sampling. */
function referenceOf(id: string) {
  const m = templateMotion(id);
  const drivers = driverKeysOf(m);
  const rec = sampleComposedMotion(resolveComposedMotion(m, variantCfg), harness());
  return { sig: buildSignatureFromExport(exportKinematics(rec), { joints: drivers }), drivers };
}

const CHAIN = ['shoulder-flexion-elevation', 'cervical-rotation', 'single-leg-stance'];

describe('a chain of validated primitives is continuous and each segment still validates', () => {
  it('no teleport between segments (seams are continuous)', () => {
    const segs = sampleMotionChain(CHAIN.map(templateMotion), harness());
    expect(segs).toHaveLength(3);
    for (let i = 1; i < segs.length; i += 1) {
      // Each later segment continues from the previous end: the seam joint-angle
      // discontinuity is tiny (these templates each end near neutral).
      expect(segs[i]!.seamDiscontinuityDeg, `seam ${i}`).toBeLessThan(3);
    }
  });

  it('each sub-movement independently passes its own kinematic signature', () => {
    const segs = sampleMotionChain(CHAIN.map(templateMotion), harness());
    for (let i = 0; i < CHAIN.length; i += 1) {
      const { sig, drivers } = referenceOf(CHAIN[i]!);
      const res = scoreAgainstSignature(exportKinematics(segs[i]!.recording), sig, {}, { joints: drivers });
      expect(res.accepted, `${CHAIN[i]}: ${res.reasons.join('; ')}`).toBe(true);
    }
  });
});

describe('the seam metric catches a real teleport (non-vacuous)', () => {
  // A segment that RAISES the arm to 90° and HOLDS (does not lower) — so the body
  // ends far from neutral, making continue-vs-reset observable at the next seam.
  const raiseAndHold = (): ComposedMotion => ({
    name: 'raise + hold',
    startFrom: 'neutral',
    keyframes: [{ durationMs: 800, holdMs: 200, targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90 }] }],
  });

  it('continuing keeps the arm up (small seam); resetting to neutral snaps it down (large seam)', () => {
    // CONTINUATION path (Phase 4): the chain folds the cervical segment onto the
    // arm-up pose → the arm persists → small seam.
    const chained = sampleMotionChain([raiseAndHold(), templateMotion('cervical-rotation')], harness());
    expect(chained[1]!.seamDiscontinuityDeg).toBeLessThan(3);

    // TELEPORT path: sample the raise, then a cervical segment that RESETS to
    // neutral from the same end pose → the arm snaps 90°→0° → large seam.
    const raiseRec = sampleComposedMotion(resolveComposedMotion(raiseAndHold(), variantCfg), harness());
    const endPose = raiseRec.frames[raiseRec.frames.length - 1]!.pose;
    const endRoot = raiseRec.frames[raiseRec.frames.length - 1]!.root;
    const neutralCervical: ComposedMotion = { ...templateMotion('cervical-rotation'), startFrom: 'neutral' };
    const cervicalReset = sampleComposedMotion(resolveComposedMotion(neutralCervical, variantCfg), {
      ...harness(),
      currentPose: endPose,
      currentRoot: { quat: endRoot.orientQuat, translateM: endRoot.translateM },
    });
    const teleportSeam = measureSeamContinuity(raiseRec, cervicalReset);
    expect(teleportSeam).toBeGreaterThan(45); // the ~90° arm drop is caught
  });

  it('continuity is load-bearing THROUGH the chain runner (a displaced driver persists)', () => {
    // Red-team #3: prove sampleMotionChain's asContinuation actually carries state
    // — not just the hand-rolled counter-example. Chain raise-and-hold → cervical;
    // the cervical segment's FIRST frame must still show the arm up (~90°). If
    // asContinuation were a no-op (reset to neutral), it would read ~0°.
    const segs = sampleMotionChain([raiseAndHold(), templateMotion('cervical-rotation')], harness());
    const armAtSeam = segs[1]!.recording.frames[0]!.angles['R_UpperArm']?.['shoulderFlexion'] ?? 0;
    expect(armAtSeam).toBeGreaterThan(80);
  });
});

describe('root continuity is gated (joint angles alone are seam-blind)', () => {
  const step = (): ComposedMotion => ({
    name: 'step', stance: 'planted', startFrom: 'neutral',
    keyframes: [{ durationMs: 700, travel: { direction: 'forward', meters: 0.3 }, targets: [
      { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 25 }, { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 30 } ] }],
  });

  it('a traveling chain keeps the ROOT continuous at the seam', () => {
    const segs = sampleMotionChain([step(), step()], harness());
    expect(segs).toHaveLength(2);
    expect(segs.every((s) => s.status === 'ok')).toBe(true);
    // The root does not jump at the seam (the whole-body thread is intact) —
    // something joint-angle continuity can't see.
    expect(segs[1]!.seamRootTranslateM).toBeLessThan(0.05);
  });

  it('the root-seam metric CATCHES a dropped root thread (non-vacuous)', () => {
    // Sample a step, then a continuation that does NOT thread currentRoot → the
    // body snaps back to the origin while joint angles stay ~identical.
    const first = sampleComposedMotion(resolveComposedMotion(step(), variantCfg), harness());
    const cont: ComposedMotion = { ...step(), startFrom: 'current' };
    const brokenRoot = sampleComposedMotion(resolveComposedMotion(cont, variantCfg), {
      ...harness(), currentPose: first.frames[first.frames.length - 1]!.pose, // pose threaded…
      // …but currentRoot deliberately omitted → the ~0.3 m of travel is dropped.
    });
    expect(measureSeamRootDiscontinuity(first, brokenRoot).translateM).toBeGreaterThan(0.2);
    // Joint angles alone would call this seam "fine" — the whole point of the metric.
    expect(measureSeamContinuity(first, brokenRoot)).toBeLessThan(5);
  });
});

describe('a refused segment does not crash or silently pass the chain', () => {
  it('marks the refused segment and keeps threading from the last OK one', () => {
    const bad: ComposedMotion = { name: 'bogus', keyframes: [{ durationMs: 400, targets: [{ joint: 'Not_A_Joint', motion: 'nope', targetDegrees: 20 }] }] };
    const segs = sampleMotionChain([templateMotion('cervical-rotation'), bad, templateMotion('single-leg-stance')], harness());
    expect(segs).toHaveLength(3);
    expect(segs[0]!.status).toBe('ok');
    expect(segs[1]!.status).toBe('refused');
    expect(segs[1]!.recording.frames).toHaveLength(0);
    // The third segment still ran (continuing from the first OK segment), not crashed.
    expect(segs[2]!.status).toBe('ok');
    expect(segs[2]!.recording.frames.length).toBeGreaterThan(0);
  });
});
