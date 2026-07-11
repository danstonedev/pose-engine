/**
 * MOVEMENT TEMPLATES — the clinician-authored reference library is only worth
 * anything if its authored peaks are (a) within normative ROM and (b) actually
 * achievable and measurable on the real rig. Both are proven here through the
 * SAME engine the app uses, so the templates can't drift from reality.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { measureCommandMotion } from '../services/movementCommand';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording, type RecordedFrame } from '../services/motionRecording';
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  findMovementTemplate,
  describeMovementTemplates,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRestPos: THREE.Vector3;
let rootRestQuat: THREE.Quaternion;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.parse(ab, '', resolve, reject);
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
  rootRestPos = root.position.clone();
  rootRestQuat = root.quaternion.clone();
});

function resetToAnatomic(): void {
  applyAnatomicPose(root, variantCfg);
  root.position.copy(rootRestPos);
  root.quaternion.copy(rootRestQuat);
  root.updateMatrixWorld(true);
}

function frameAngle(frame: RecordedFrame, joint: string, motion: string): number | undefined {
  return measureCommandMotion({ at: '', variant: 'male', joints: frame.angles }, joint, motion) ?? undefined;
}
function frameNearest(rec: MotionRecording, tMs: number): RecordedFrame {
  let best = rec.frames[0]!;
  for (const f of rec.frames) if (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  return best;
}

describe('movement templates — ROM-validated (nothing exceeds normative range)', () => {
  for (const t of MOVEMENT_TEMPLATES) {
    it(`${t.id}: resolves ok and every authored peak survives the ROM clamp unchanged`, () => {
      const resolved = resolveComposedMotion(templateToComposedMotion(t), variantCfg);
      expect(resolved.status, `resolve ${t.id}`).toBe('ok');
      // Every authored target must appear in the resolved keyframe AND be clamped
      // to exactly its authored value — i.e. it was already within normative ROM.
      t.phases.forEach((phase, i) => {
        const resolvedTargets = resolved.keyframes[i]!.targets;
        for (const target of phase.targets) {
          const rt = resolvedTargets.find((x) => x.joint === target.joint && x.motion === target.motion);
          expect(rt, `${t.id} kf${i} ${target.joint}.${target.motion} present`).toBeDefined();
          expect(
            Math.abs(rt!.clampedDegrees - target.peakDeg),
            `${t.id} kf${i} ${target.joint}.${target.motion}: authored ${target.peakDeg}° clamped to ${rt!.clampedDegrees}° (exceeds normative ROM)`,
          ).toBeLessThan(1);
        }
      });
    });
  }
});

describe('movement templates — round-trip on the real rig (authored peaks are achieved)', () => {
  // Joints whose peak we assert the rig reaches. Small/coupled angles (soft-knee
  // 12°, arm-swing 25°) are directional only; we pin the primary large-ROM joints.
  const PRIMARY: Record<string, string[]> = {
    squat: ['L_UpLeg.hipFlexion', 'R_UpLeg.hipFlexion', 'L_Leg.kneeFlexion', 'R_Leg.kneeFlexion'],
    'forward-hip-hinge': ['L_UpLeg.hipFlexion', 'Spine_Lower.flexion'],
    'shoulder-flexion-elevation': ['R_UpperArm.shoulderFlexion'],
    'shoulder-abduction-elevation': ['R_UpperArm.shoulderAbduction'],
    'high-knee-march': ['R_UpLeg.hipFlexion', 'R_Leg.kneeFlexion'],
    'sit-to-stand': ['L_UpLeg.hipFlexion', 'L_Leg.kneeFlexion'],
    'forward-lunge': ['R_UpLeg.hipFlexion', 'R_Leg.kneeFlexion'],
    'single-leg-stance': ['R_UpLeg.hipFlexion', 'R_Leg.kneeFlexion'],
    'cervical-rotation': ['Neck.rotation'],
    'lumbar-flexion-extension': ['Spine_Lower.flexion'],
  };

  for (const t of MOVEMENT_TEMPLATES) {
    it(`${t.id}: measured angles at each peak match the authored peaks (±6°)`, () => {
      resetToAnatomic();
      const resolved = resolveComposedMotion(templateToComposedMotion(t), variantCfg);
      expect(resolved.status).toBe('ok');
      const rec = sampleComposedMotion(resolved, {
        baselinePose,
        variantCfg,
        rest,
        skeletonHarness: { root, skinned },
        sampleHz: 60,
      });
      // Settle time of phase i = Σ durations ≤ i + Σ holds < i.
      let settle = 0;
      const primary = new Set(PRIMARY[t.id] ?? []);
      resolved.keyframes.forEach((kf, i) => {
        settle += kf.durationMs;
        const frame = frameNearest(rec, settle);
        for (const target of t.phases[i]!.targets) {
          const key = `${target.joint}.${target.motion}`;
          if (!primary.has(key)) continue;
          const measured = frameAngle(frame, target.joint, target.motion);
          expect(measured, `${t.id} ${key} measurable`).toBeDefined();
          expect(
            Math.abs(measured! - target.peakDeg),
            `${t.id} phase '${t.phases[i]!.name}' ${key}: authored ${target.peakDeg}° vs measured ${measured}°`,
          ).toBeLessThan(6);
        }
        settle += kf.holdMs;
      });
    });
  }
});

describe('movement templates — lookup + prompt rendering', () => {
  it('findMovementTemplate matches instruction keywords', () => {
    expect(findMovementTemplate('please do a deep squat')?.id).toBe('squat');
    expect(findMovementTemplate('bend forward and touch your toes')?.id).toBe('forward-hip-hinge');
    expect(findMovementTemplate('raise your right arm overhead')?.id).toBe('shoulder-flexion-elevation');
    expect(findMovementTemplate('march in place')?.id).toBe('high-knee-march');
    expect(findMovementTemplate('wiggle your nose')).toBeNull();
  });

  it('describeMovementTemplates renders every template with peaks + timing', () => {
    const text = describeMovementTemplates();
    for (const t of MOVEMENT_TEMPLATES) expect(text).toContain(t.label);
    expect(text).toMatch(/hipFlexion 100°/);
    expect(text).toMatch(/scapulohumeral/i);
  });
});
