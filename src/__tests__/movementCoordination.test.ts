/**
 * COORDINATION GATE (simMOVE Phase 2) — proves the cross-joint coordination
 * checker measures, on the REAL rig, the relations that make the compound
 * movements natural, and REJECTS them when the coordination is broken:
 *   • squat — hip and knee flex in a fixed ~100:120 ratio;
 *   • high-knee march — a stepping leg peaks WITH the contralateral arm and
 *     APART from the ipsilateral arm (reciprocal gait timing);
 *   • sit-to-stand — trunk/hip FLEXION momentum leads the leg EXTENSION to rise
 *     (flexion-momentum-before-extension).
 * These are the INTER-phase relations the current engine genuinely produces;
 * intra-phase lead/lag (ankle-before-knee within one descent) is still lockstep
 * and is a documented generation follow-up, not gated here.
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
import {
  checkCoordination,
  type CoordinationSourceExport,
  type CoordinationSpec,
} from '../services/movementCoordination';
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

function exportOf(m: ComposedMotion): CoordinationSourceExport {
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, `resolve ${m.name}`).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  });
  return exportKinematics(rec);
}
function templateMotion(id: string): ComposedMotion {
  const t = MOVEMENT_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`no template ${id}`);
  return templateToComposedMotion(t);
}
type Xform = (t: { joint: string; motion: string; targetDegrees: number }) => number;
function mapTargets(m: ComposedMotion, key: string, x: Xform): ComposedMotion {
  return {
    ...m,
    keyframes: m.keyframes.map((kf) => ({
      ...kf,
      targets: (kf.targets ?? []).map((t) => (`${t.joint}.${t.motion}` === key ? { ...t, targetDegrees: x(t) } : t)),
    })),
  };
}

// ── Specs (values grounded in measured rig kinematics) ───────────────────────
const SQUAT: CoordinationSpec = {
  name: 'squat',
  ratios: [
    { a: 'L_UpLeg.hipFlexion', b: 'L_Leg.kneeFlexion', ratio: 100 / 120, tolRel: 0.25 },
    { a: 'R_UpLeg.hipFlexion', b: 'R_Leg.kneeFlexion', ratio: 100 / 120, tolRel: 0.25 },
  ],
};
const MARCH: CoordinationSpec = {
  name: 'high-knee-march',
  together: [
    { a: 'R_UpLeg.hipFlexion', b: 'L_UpperArm.shoulderFlexion', label: 'R-step with L-arm' },
    { a: 'L_UpLeg.hipFlexion', b: 'R_UpperArm.shoulderFlexion', label: 'L-step with R-arm' },
  ],
  apart: [
    { a: 'R_UpLeg.hipFlexion', b: 'R_UpperArm.shoulderFlexion', label: 'R-step vs ipsilateral R-arm' },
  ],
};
const STS: CoordinationSpec = {
  name: 'sit-to-stand',
  // Trunk flexion momentum (the lean) leads the hip EXTENSION to rise.
  order: [
    { earlier: 'Spine_Lower.flexion', later: 'L_UpLeg.hipFlexion', by: 'maxVel', minLeadFrac: 0.05 },
    { earlier: 'Spine_Lower.flexion', later: 'R_UpLeg.hipFlexion', by: 'maxVel', minLeadFrac: 0.05 },
  ],
};

describe('compound templates exhibit natural inter-joint coordination (measured)', () => {
  it('squat: hip and knee flex in the authored ~100:120 ratio', () => {
    const res = checkCoordination(exportOf(templateMotion('squat')), SQUAT);
    expect(res.accepted, res.reasons.join('; ')).toBe(true);
  });

  it('high-knee march: stepping leg peaks WITH the contralateral arm, APART from the ipsilateral', () => {
    const res = checkCoordination(exportOf(templateMotion('high-knee-march')), MARCH);
    expect(res.accepted, res.reasons.join('; ')).toBe(true);
  });

  it('sit-to-stand: trunk flexion momentum leads the hip extension (flexion-before-extension)', () => {
    const res = checkCoordination(exportOf(templateMotion('sit-to-stand')), STS);
    expect(res.accepted, res.reasons.join('; ')).toBe(true);
  });
});

describe('the checker REJECTS broken coordination', () => {
  it('squat with a shallow knee breaks the hip:knee ratio', () => {
    const broken = mapTargets(templateMotion('squat'), 'L_Leg.kneeFlexion', (t) => t.targetDegrees * 0.35);
    const res = checkCoordination(exportOf(broken), SQUAT);
    expect(res.accepted).toBe(false);
    expect(res.results.find((r) => r.kind === 'ratio' && !r.ok)).toBeDefined();
  });

  it('march with the IPSILATERAL arm (same-side swing) fails the reciprocal timing', () => {
    // Move the arm swing onto the SAME side as the stepping leg: R-arm now swings
    // with the R-step, so "R-step with L-arm" (together) no longer holds.
    const m = templateMotion('high-knee-march');
    const ipsi: ComposedMotion = {
      ...m,
      keyframes: m.keyframes.map((kf) => ({
        ...kf,
        targets: (kf.targets ?? []).map((t) => {
          if (t.joint === 'L_UpperArm' && t.motion === 'shoulderFlexion') return { ...t, joint: 'R_UpperArm' };
          if (t.joint === 'R_UpperArm' && t.motion === 'shoulderFlexion') return { ...t, joint: 'L_UpperArm' };
          return t;
        }),
      })),
    };
    const res = checkCoordination(exportOf(ipsi), MARCH);
    expect(res.accepted).toBe(false);
    expect(res.results.find((r) => r.kind === 'together' && !r.ok)).toBeDefined();
  });

  it('a missing joint fails its rule rather than passing silently', () => {
    const res = checkCoordination(exportOf(templateMotion('squat')), {
      name: 'bogus',
      ratios: [{ a: 'No.joint', b: 'L_Leg.kneeFlexion', ratio: 1 }],
    });
    expect(res.accepted).toBe(false);
  });
});
