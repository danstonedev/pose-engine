/**
 * NATURAL SPINAL GAIT COORDINATION — the trunk must counter-rotate with the arm
 * swing and sway toward the stance leg, so gait reads as human instead of a rigid
 * torso on moving legs. This pins: (1) the transform ADDS only spine/neck targets
 * and leaves every leg/arm driver byte-identical (feet + goniometry untouched);
 * (2) the thoracic axial rotation OSCILLATES across the cycle (both directions);
 * (3) it is DERIVED from the arm swing, so a damped arm swing damps the trunk
 * rotation; (4) identity at zero gain; and (5) on the sampled rig the measured
 * thoracic rotation actually swings through a believable range.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose, buildBoneByPoseKey, applyCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import {
  buildRun,
  buildTravelWalk,
  spinalGaitCoordination,
  templateToComposedMotion,
  scaleArmSwing,
  MOVEMENT_TEMPLATES,
} from '../services/movementTemplates';
import { measureCommandMotion } from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const SPINE_MOTIONS = new Set(['rotation', 'lateralTilt']);
const isSpineAdd = (joint: string, motion: string) =>
  (joint === 'Spine_Upper' || joint === 'Spine_Lower' || joint === 'Neck') && SPINE_MOTIONS.has(motion);

const walkComposed = () =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

/** The peak-to-peak swing of Spine_Upper axial rotation across a motion's keyframes. */
const thoracicSwing = (m: ReturnType<typeof buildRun>): number => {
  const vals = m.keyframes.map(
    (kf) => kf.targets?.find((t) => t.joint === 'Spine_Upper' && t.motion === 'rotation')?.targetDegrees ?? 0,
  );
  return Math.max(...vals) - Math.min(...vals);
};

describe('spinalGaitCoordination — trunk counter-rotation authoring', () => {
  it('is identity when both gains are 0 (clean/opt-out)', () => {
    const base = walkComposed();
    expect(spinalGaitCoordination(base, { axial: 0, lateral: 0 })).toBe(base);
  });

  it('ADDS only spine/neck rotation+lateralTilt — every leg/arm driver is byte-identical', () => {
    const base = walkComposed();
    const out = spinalGaitCoordination(base);
    expect(out.keyframes.length).toBe(base.keyframes.length);
    for (let i = 0; i < base.keyframes.length; i += 1) {
      const before = base.keyframes[i]!.targets ?? [];
      const after = out.keyframes[i]!.targets ?? [];
      // Nothing removed or mutated among the ORIGINAL targets…
      for (const b of before) {
        const match = after.find((t) => t.joint === b.joint && t.motion === b.motion);
        expect(match, `${b.joint}.${b.motion} preserved`).toBeDefined();
        // A pre-existing spine lateralTilt/rotation may be added onto; everything
        // else (legs, arms, sagittal spine flexion) must be untouched.
        if (!isSpineAdd(b.joint, b.motion)) {
          expect(match!.targetDegrees, `${b.joint}.${b.motion} unchanged`).toBe(b.targetDegrees);
        }
      }
      // …and every NEW target is a spine/neck rotation or lateralTilt.
      for (const a of after) {
        const wasThere = before.some((t) => t.joint === a.joint && t.motion === a.motion);
        if (!wasThere) expect(isSpineAdd(a.joint, a.motion), `${a.joint}.${a.motion} is a spine add`).toBe(true);
      }
    }
  });

  it('thoracic axial rotation OSCILLATES — both directions within one cycle', () => {
    const rot = spinalGaitCoordination(walkComposed()).keyframes.map(
      (kf) => kf.targets?.find((t) => t.joint === 'Spine_Upper' && t.motion === 'rotation')?.targetDegrees ?? 0,
    );
    expect(Math.max(...rot), 'rotates one way').toBeGreaterThan(2);
    expect(Math.min(...rot), 'and the other').toBeLessThan(-2);
  });

  it('is DERIVED from the arm swing — a damped arm swing damps the trunk rotation', () => {
    const full = spinalGaitCoordination(walkComposed());
    const damped = spinalGaitCoordination(scaleArmSwing(walkComposed(), 0.25));
    expect(thoracicSwing(damped)).toBeLessThan(thoracicSwing(full) * 0.5);
  });

  it('the run and travel-walk builders ship with trunk coordination baked in', () => {
    expect(thoracicSwing(buildRun()), 'run counter-rotates').toBeGreaterThan(6);
    expect(thoracicSwing(buildTravelWalk()), 'travel walk counter-rotates').toBeGreaterThan(4);
  });

  it('stays within physiologic ROM (never near end-range)', () => {
    for (const m of [buildRun(), buildRun({ speed: 1.6 }), buildTravelWalk()]) {
      for (const kf of m.keyframes) {
        for (const t of kf.targets ?? []) {
          if (t.joint === 'Spine_Upper' && t.motion === 'rotation') expect(Math.abs(t.targetDegrees)).toBeLessThanOrEqual(14);
          if (t.joint === 'Spine_Lower' && t.motion === 'rotation') expect(Math.abs(t.targetDegrees)).toBeLessThanOrEqual(8);
          if (t.motion === 'lateralTilt') expect(Math.abs(t.targetDegrees)).toBeLessThanOrEqual(8);
        }
      }
    }
  });
});

describe('spinalGaitCoordination — measured on the rig', () => {
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

  it('the sampled run shows a real thoracic counter-rotation while the legs keep working', () => {
    const rec = sampleComposedMotion(resolveComposedMotion(buildRun(), variantCfg), {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 60,
    });
    const rot = rec.frames.map(
      (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'Spine_Upper', 'rotation') ?? 0,
    );
    const hip = rec.frames.map(
      (f) => measureCommandMotion({ at: '', variant: 'male', joints: f.angles }, 'R_UpLeg', 'hipFlexion') ?? 0,
    );
    const rotRange = Math.max(...rot) - Math.min(...rot);
    const hipRange = Math.max(...hip) - Math.min(...hip);
    // eslint-disable-next-line no-console
    console.log(`run rig: thoracic rotation range ${rotRange.toFixed(1)}°, hip flexion range ${hipRange.toFixed(1)}°`);
    expect(rotRange, 'the trunk visibly counter-rotates').toBeGreaterThan(6);
    expect(Math.max(...rot), 'toward one side').toBeGreaterThan(1);
    expect(Math.min(...rot), 'and the other').toBeLessThan(-1);
    expect(hipRange, 'the legs are still driving the stride').toBeGreaterThan(30);
  });

  it('GAZE STAYS FORWARD: the head is world-stabilized while the thorax counter-rotates', () => {
    const yaw = (b: THREE.Bone): number => {
      const q = new THREE.Quaternion();
      b.getWorldQuaternion(q);
      return (new THREE.Euler().setFromQuaternion(q, 'YXZ').y * 180) / Math.PI;
    };
    for (const motion of [buildTravelWalk(), buildRun()]) {
      const rec = sampleComposedMotion(resolveComposedMotion(motion, variantCfg), {
        baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
      });
      const bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
      const head = bones.get('Head')!, thorax = bones.get('Spine_Upper')!;
      let hMin = Infinity, hMax = -Infinity, tMin = Infinity, tMax = -Infinity;
      for (const f of rec.frames) {
        applyCustomPose(skinned.skeleton, variantCfg, f.pose);
        root.updateMatrixWorld(true);
        const hy = yaw(head), ty = yaw(thorax);
        hMin = Math.min(hMin, hy); hMax = Math.max(hMax, hy);
        tMin = Math.min(tMin, ty); tMax = Math.max(tMax, ty);
      }
      const headSwing = hMax - hMin, thoraxSwing = tMax - tMin;
      // eslint-disable-next-line no-console
      console.log(`${motion.name}: HEAD yaw swing ${headSwing.toFixed(1)}° vs THORAX ${thoraxSwing.toFixed(1)}°`);
      // The thorax visibly counter-rotates, but the head/gaze stays forward — the neck
      // counters the inherited trunk rotation (vestibulo-ocular stabilization). Regression
      // guard: before the fix the neck counter overflowed MAX_TARGETS and the head rode
      // the thorax 1:1 (~17-21° swing).
      expect(thoraxSwing, 'the thorax does counter-rotate').toBeGreaterThan(12);
      expect(headSwing, 'the head stays looking forward').toBeLessThan(7);
      expect(headSwing).toBeLessThan(thoraxSwing * 0.4);
    }
  });
});
