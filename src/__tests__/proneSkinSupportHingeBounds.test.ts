import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { buildSequencePoses, resolveComposedMotion } from '../services/motionSequence';
import { buildComposedCommandPose } from '../services/movementCommand';
import { createProneSkinSupport } from '../services/proneSkinSupport';
import { setRomClampEnabled } from '../services/poseRomClamp';
import { getEffectiveRomRange } from '../services/romConstraints';

describe.each(['male', 'female', 'neutral'] as const)('%s prone support knee boundary', variant => {
  it('keeps the actual knee within default and locked ranges even when floor support is infeasible', async () => {
    setRomClampEnabled(false);
    const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    let skin!: THREE.SkinnedMesh; root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
    const rest = captureJointAngleRestReference(skin.skeleton, cfg), baselinePose = serializeCustomPose(skin.skeleton, cfg, variant), bones = buildBoneByPoseKey(skin.skeleton, cfg);
    const sequence = buildSequencePoses(baselinePose, resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), cfg, rest);
    for (const limit of [null, 40, 0]) {
      root.quaternion.fromArray(sequence.roots[1]!.quat); applyCustomPose(skin.skeleton, cfg, sequence.poses[1]!);
      for (const side of ['L', 'R']) {
        const key = `${side}_Leg`, source = serializeCustomPose(skin.skeleton, cfg, variant);
        const pose = buildComposedCommandPose(baselinePose, key, [{ motion: 'kneeFlexion', degrees: limit === null ? 140 : 40 }, { motion: 'kneeRotation', degrees: 15 }], cfg, source, rest)!;
        bones.get(key)!.quaternion.fromArray(pose.bones[key]!);
      }
      root.updateMatrixWorld(true);
      const constraints = limit === null ? null : Object.fromEntries(['L', 'R'].map(side => [`${side}_Leg`, { kneeFlexion: { availableRange: { min: limit, max: limit } } }]));
      const support = createProneSkinSupport({ root, skinned: skin, variantCfg: cfg, baselinePose, rest });
      const result = support.solve({ constraints });
      expect(result.feasible).toBe(false);
      expect(result.reasons.some(reason => reason.includes('support residual'))).toBe(true);
      // Contact infeasibility does not permit a clinical violation. Previously
      // a default140 command left the neutral actual knee at141.439 degrees.
      for (const repeat of [false, true]) {
        if (repeat) support.solve({ constraints });
        const joints = computeJointAngles(skin.skeleton, cfg, variant, rest).joints;
        for (const side of ['L', 'R']) for (const field of ['kneeFlexion', 'kneeDeviation', 'kneeRotation']) {
          const range = getEffectiveRomRange(constraints, `${side}_Leg`, field)!;
          const actual = joints[`${side}_Leg`]![field]!;
          expect(actual, `${limit} ${side}.${field}`).toBeGreaterThanOrEqual(range.min - 1e-8);
          expect(actual, `${limit} ${side}.${field}`).toBeLessThanOrEqual(range.max + 1e-8);
        }
      }
    }
  });
});
