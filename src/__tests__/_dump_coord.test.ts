import { beforeAll, describe, it } from 'vitest';
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
  checkCoordination, excursionOf, normPeakTimeOf, normMaxVelTimeOf,
  type CoordinationSourceExport,
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
  root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh; });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
});

function exportOf(m: ComposedMotion): CoordinationSourceExport {
  const resolved = resolveComposedMotion(m, variantCfg);
  const rec = sampleComposedMotion(resolved, { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60 });
  return exportKinematics(rec);
}
function tm(id: string): ComposedMotion {
  const t = MOVEMENT_TEMPLATES.find((x) => x.id === id)!;
  return templateToComposedMotion(t);
}
const p = (n: number | null) => (n == null ? 'null' : n.toFixed(4));

function report(label: string, ex: CoordinationSourceExport, keys: string[]) {
  console.log(`\n### ${label}  dur=${ex.meta?.durationMs}ms frames=${ex.timesMs.length}`);
  for (const k of keys) {
    const s = (ex as any).series[k] as number[] | undefined;
    const mn = s ? Math.min(...s) : NaN;
    const mx = s ? Math.max(...s) : NaN;
    console.log(
      `  ${k.padEnd(30)} exc=${p(excursionOf(ex, k))} min=${mn.toFixed(1)} max=${mx.toFixed(1)} ` +
      `peakT=${p(normPeakTimeOf(ex, k))} maxVelT=${p(normMaxVelTimeOf(ex, k))}`,
    );
  }
}

describe('dump', () => {
  it('squat', () => {
    const ex = exportOf(tm('squat'));
    report('SQUAT', ex, ['L_UpLeg.hipFlexion', 'R_UpLeg.hipFlexion', 'L_Leg.kneeFlexion', 'R_Leg.kneeFlexion', 'Spine_Lower.flexion']);
  });
  it('march', () => {
    const ex = exportOf(tm('high-knee-march'));
    report('MARCH', ex, ['R_UpLeg.hipFlexion', 'L_UpLeg.hipFlexion', 'L_UpperArm.shoulderFlexion', 'R_UpperArm.shoulderFlexion']);
  });
  it('sts', () => {
    const ex = exportOf(tm('sit-to-stand'));
    report('STS', ex, ['Spine_Lower.flexion', 'Spine_Upper.flexion', 'L_UpLeg.hipFlexion', 'R_UpLeg.hipFlexion', 'L_Leg.kneeFlexion']);
  });

  it('STS no-lean loophole', () => {
    const m = tm('sit-to-stand');
    // Remove ALL Spine_Lower.flexion lean (set to 0 everywhere) -> no trunk lean at all.
    const noLean: ComposedMotion = {
      ...m,
      keyframes: m.keyframes.map((kf) => ({
        ...kf,
        targets: (kf.targets ?? []).map((t) =>
          t.joint === 'Spine_Lower' && t.motion === 'flexion' ? { ...t, targetDegrees: 0 } : t),
      })),
    };
    const ex = exportOf(noLean);
    report('STS-NO-LEAN', ex, ['Spine_Lower.flexion', 'L_UpLeg.hipFlexion']);
    const STS = {
      name: 'sit-to-stand',
      order: [
        { earlier: 'Spine_Lower.flexion', later: 'L_UpLeg.hipFlexion', by: 'maxVel' as const, minLeadFrac: 0.05 },
        { earlier: 'Spine_Lower.flexion', later: 'R_UpLeg.hipFlexion', by: 'maxVel' as const, minLeadFrac: 0.05 },
      ],
    };
    const res = checkCoordination(ex, STS);
    console.log('STS-NO-LEAN accepted =', res.accepted, '|', res.reasons.join(' ; '));
  });

  it('SQUAT hip sign-flip loophole', () => {
    const m = tm('squat');
    // Flip hip flexion to hip EXTENSION (negative): anatomically absurd squat.
    const flip: ComposedMotion = {
      ...m,
      keyframes: m.keyframes.map((kf) => ({
        ...kf,
        targets: (kf.targets ?? []).map((t) =>
          t.joint.endsWith('UpLeg') && t.motion === 'hipFlexion' ? { ...t, targetDegrees: -t.targetDegrees } : t),
      })),
    };
    const ex = exportOf(flip);
    report('SQUAT-HIP-FLIP', ex, ['L_UpLeg.hipFlexion', 'L_Leg.kneeFlexion', 'R_UpLeg.hipFlexion', 'R_Leg.kneeFlexion']);
    const SQUAT = {
      name: 'squat',
      ratios: [
        { a: 'L_UpLeg.hipFlexion', b: 'L_Leg.kneeFlexion', ratio: 100 / 120, tolRel: 0.25 },
        { a: 'R_UpLeg.hipFlexion', b: 'R_Leg.kneeFlexion', ratio: 100 / 120, tolRel: 0.25 },
      ],
    };
    const res = checkCoordination(ex, SQUAT);
    console.log('SQUAT-HIP-FLIP accepted =', res.accepted, '|', res.reasons.join(' ; '));
  });

  it('empty spec', () => {
    const ex = exportOf(tm('squat'));
    const res = checkCoordination(ex, {});
    console.log('EMPTY-SPEC accepted =', res.accepted, 'results=', res.results.length);
    const res2 = checkCoordination(ex, { name: 'x', order: [] });
    console.log('NO-RULES-SPEC accepted =', res2.accepted, 'results=', res2.results.length);
  });

  it('sampleHz sensitivity of STS order', () => {
    const m = tm('sit-to-stand');
    for (const hz of [20, 30, 60, 120]) {
      const resolved = resolveComposedMotion(m, variantCfg);
      const rec = sampleComposedMotion(resolved, { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: hz });
      const ex = exportKinematics(rec);
      console.log(`hz=${hz} spineMaxVelT=${p(normMaxVelTimeOf(ex, 'Spine_Lower.flexion'))} hipMaxVelT=${p(normMaxVelTimeOf(ex, 'L_UpLeg.hipFlexion'))}`);
    }
  });
});
