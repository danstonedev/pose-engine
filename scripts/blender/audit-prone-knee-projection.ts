import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../../src/services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { buildSequencePoses, resolveComposedMotion } from '../../src/services/motionSequence';
import { buildComposedCommandPose } from '../../src/services/movementCommand';
import { createProneSkinSupport } from '../../src/services/proneSkinSupport';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';

setRomClampEnabled(false);
const output = process.argv[2]; if (!output) throw Error('Fresh output path required');
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const identity = () => Object.fromEntries(['proneSkinSupport', 'poseRomClamp', 'movementCommand'].map(n => [n, hash(readFileSync(new URL(`../../src/services/${n}.ts`, import.meta.url)))]));
const report: any = { before: identity(), scope: 'Actual lower-support helper only, no arm solver. Authored setup plus high/default and explicitly locked knee cases. Skin infeasibility and clinical bound compliance are separate observations.', cases: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin!: THREE.SkinnedMesh; root.traverse(n => { if (!skin && (n as THREE.SkinnedMesh).isSkinnedMesh) skin = n as THREE.SkinnedMesh; });
  const rest = captureJointAngleRestReference(skin.skeleton, cfg), baselinePose = serializeCustomPose(skin.skeleton, cfg, variant), bones = buildBoneByPoseKey(skin.skeleton, cfg);
  const sequence = buildSequencePoses(baselinePose, resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), cfg, rest);
  for (const mode of ['normal', 'default-upper', 'locked40', 'locked0']) {
    root.quaternion.fromArray(sequence.roots[1]!.quat); applyCustomPose(skin.skeleton, cfg, sequence.poses[1]!); root.updateMatrixWorld(true);
    if (mode !== 'normal') for (const side of ['L', 'R']) {
      const key = `${side}_Leg`, source = serializeCustomPose(skin.skeleton, cfg, variant);
      const pose = buildComposedCommandPose(baselinePose, key, [{ motion: 'kneeFlexion', degrees: mode === 'default-upper' ? 140 : 40 }, { motion: 'kneeRotation', degrees: 15 }], cfg, source, rest)!;
      bones.get(key)!.quaternion.fromArray(pose.bones[key]!);
    }
    root.updateMatrixWorld(true);
    const constraints = mode.startsWith('locked') ? Object.fromEntries(['L', 'R'].map(side => [`${side}_Leg`, { kneeFlexion: { availableRange: { min: mode === 'locked40' ? 40 : 0, max: mode === 'locked40' ? 40 : 0 } } }])) : null;
    const helper = createProneSkinSupport({ root, skinned: skin, variantCfg: cfg, baselinePose, rest });
    const before = computeJointAngles(skin.skeleton, cfg, variant, rest).joints;
    const result = helper.solve({ constraints });
    const after = computeJointAngles(skin.skeleton, cfg, variant, rest).joints;
    const first = serializeCustomPose(skin.skeleton, cfg, variant);
    const repeated = helper.solve({ constraints });
    const second = serializeCustomPose(skin.skeleton, cfg, variant);
    const row = { variant, mode, before: { L: before.L_Leg, R: before.R_Leg }, after: { L: after.L_Leg, R: after.R_Leg }, result,
      repeated: { feasible: repeated.feasible, iterations: repeated.iterations, reused: repeated.reusedSolution }, exactRepeatPose: JSON.stringify(first) === JSON.stringify(second) };
    report.cases.push(row); console.log(JSON.stringify({ variant, mode, after: row.after, feasible: result.feasible, iterations: result.iterations, reasons: result.reasons, exactRepeatPose: row.exactRepeatPose }));
  }
}
report.after = identity(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
