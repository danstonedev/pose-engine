/**
 * INTRA-PHASE TIMING GATE (simMOVE Phase 2b) — proves expandPeakTiming realizes a
 * within-phase LEAD (the ankle dorsiflexing ahead of the knee inside one squat
 * descent) on the real rig, closing the "everything in a keyframe peaks in
 * lockstep" gap the Phase-2 diagnostic measured — while leaving a plan that sets
 * no peakAt byte-identical, and preserving every joint's final amplitude.
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
import { expandPeakTiming, resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, exportKinematics } from '../services/motionRecording';
import { checkCoordination, type CoordinationSourceExport } from '../services/movementCoordination';
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

function exportOf(m: ComposedMotion): CoordinationSourceExport & { summary: ReturnType<typeof exportKinematics>['summary'] } {
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, `resolve ${m.name}`).toBe('ok');
  const rec = sampleComposedMotion(resolved, { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60 });
  return exportKinematics(rec);
}

/** A planted bilateral squat descent+return; ankle leads when `lead` is set. */
function squat(lead: boolean): ComposedMotion {
  const ankle = (side: string) => ({ joint: `${side}_Foot`, motion: 'ankleFlexion', targetDegrees: 20, ...(lead ? { peakAt: 0.7 } : {}) });
  return {
    name: lead ? 'squat (ankle leads)' : 'squat (lockstep)',
    stance: 'planted',
    startFrom: 'neutral',
    keyframes: [
      {
        durationMs: 1000,
        holdMs: 200,
        targets: [
          ankle('L'), ankle('R'),
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 120 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 120 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 100 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 100 },
        ],
      },
      {
        durationMs: 1000,
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
        ],
      },
    ],
  };
}

const ANKLE_LEADS_KNEE = {
  name: 'ankle-leads-knee',
  order: [{ earlier: 'L_Foot.ankleFlexion', later: 'L_Leg.kneeFlexion', by: 'peak' as const, minLeadFrac: 0.05 }],
};

describe('expandPeakTiming realizes an intra-phase lead', () => {
  it('with peakAt, the ankle peaks BEFORE the knee (lead the critic confirms)', () => {
    const ex = exportOf(expandPeakTiming(squat(true)));
    expect(checkCoordination(ex, ANKLE_LEADS_KNEE).accepted, 'ankle should lead knee').toBe(true);
  });

  it('WITHOUT peakAt the same movement is lockstep — no lead', () => {
    const ex = exportOf(expandPeakTiming(squat(false)));
    // Lockstep: ankle and knee peak together, so the "ankle leads" order fails.
    expect(checkCoordination(ex, ANKLE_LEADS_KNEE).accepted).toBe(false);
  });

  it('preserves every joint final amplitude (the lead changes timing, not targets)', () => {
    const ex = exportOf(expandPeakTiming(squat(true)));
    expect(ex.summary.joints['L_Leg.kneeFlexion']!.peakDeg).toBeGreaterThan(115);
    expect(ex.summary.joints['L_UpLeg.hipFlexion']!.peakDeg).toBeGreaterThan(95);
    expect(ex.summary.joints['L_Foot.ankleFlexion']!.peakDeg).toBeGreaterThan(18);
  });
});

describe('expandPeakTiming is a no-op when no peakAt is set (back-compat)', () => {
  it('returns keyframes with identical targets + durations', () => {
    const plain = squat(false);
    const expanded = expandPeakTiming(plain);
    expect(expanded.keyframes.length).toBe(plain.keyframes.length);
    for (let i = 0; i < plain.keyframes.length; i += 1) {
      expect(expanded.keyframes[i]!.durationMs).toBe(plain.keyframes[i]!.durationMs);
      const a = (plain.keyframes[i]!.targets ?? []).map((t) => `${t.joint}.${t.motion}=${t.targetDegrees}`);
      const b = (expanded.keyframes[i]!.targets ?? []).map((t) => `${t.joint}.${t.motion}=${t.targetDegrees}`);
      expect(b).toEqual(a);
    }
  });
});
