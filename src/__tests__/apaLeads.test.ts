/**
 * ANTICIPATORY POSTURAL ADJUSTMENTS (Wave 3, roadmap item 3.1) — the weight shift
 * PRECEDES the limb lift.
 *
 * Wave 1/2 authored the single-leg-stance and kick counterbalance with an early
 * (peakAt 0.5) shift, but it still overlapped the limb action inside one keyframe.
 * Item 3.1 restructures those templates so a dedicated "load-stance-side" keyframe
 * completes the pelvis/trunk/arm weight shift over the stance foot BEFORE the foot
 * leaves the floor — a real APA (200-400 ms lead in life).
 *
 * TEMPORAL-ORDER RIG GATE (per template): the COM-X shift toward the stance foot
 * is substantially present ≥150 ms BEFORE swing-foot lift-off. Measured on the
 * headless rig through the same sampler the stage uses, so a pass means the
 * MEASURED kinematics lead, not a bookkeeping trick. The margin gates
 * (balance.test.ts / balanceCoordination.test.ts) stay green alongside.
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
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { computeBalanceTimeline, type BalanceTimeline } from '../services/centerOfMass';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
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

function sample(id: string): MotionRecording {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const m: ComposedMotion = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === id)!);
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  });
}

/** Nearest-frame COM ground X (world m). */
function comXAt(tl: BalanceTimeline, tMs: number): number {
  let best = tl.frames[0]!;
  for (const f of tl.frames) if (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  return best.comGround[0];
}

// Both templates stand on the LEFT leg, so the stance-ward shift is toward +X
// (subject-left, per romRegistry / the world facing convention).
const STANCE_SIGN = 1;

describe('APA: the weight shift precedes the swing-foot lift-off', () => {
  for (const id of ['single-leg-stance', 'kick'] as const) {
    it(`${id}: COM-X shift toward the stance foot is present ≥150 ms before lift-off`, () => {
      const rec = sample(id);
      const tl = computeBalanceTimeline(rec);

      // LIFT-OFF = the first frame the base collapses to a single foot (the swing
      // foot has left the floor).
      const liftIdx = tl.frames.findIndex((f) => f.contacts.length === 1);
      expect(liftIdx, `${id} reaches single support`).toBeGreaterThan(0);
      const tLift = tl.frames[liftIdx]!.tMs;

      const base = comXAt(tl, 0);
      const shift = (tMs: number): number => (comXAt(tl, tMs) - base) * STANCE_SIGN;

      const dLift = shift(tLift); // shift already accrued by lift-off
      const dLead = shift(tLift - 150); // shift 150 ms EARLIER

      // The shift LEADS: 150 ms before the foot leaves the floor, the COM has
      // already moved a real, substantial amount toward the stance foot — at
      // least half of what it will have by lift-off, and ≥1.5 cm in absolute
      // terms. (A simultaneous/lagging shift would have ~0 here.)
      expect(dLift, `${id} shifts toward stance by lift-off`).toBeGreaterThan(0.02);
      expect(dLead, `${id} ≥1.5 cm shift 150 ms before lift-off`).toBeGreaterThan(0.015);
      expect(dLead, `${id} ≥50% of the by-lift shift is present 150 ms earlier`).toBeGreaterThan(0.5 * dLift);

      // eslint-disable-next-line no-console
      console.log(
        `${id}: lift-off ${tLift.toFixed(0)}ms; COM-X shift toward stance ${(dLead * 100).toFixed(2)}cm @−150ms → ${(dLift * 100).toFixed(2)}cm @lift-off`,
      );
    });
  }
});
