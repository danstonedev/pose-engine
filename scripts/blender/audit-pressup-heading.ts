/** Diagnose source covariance independently of the palm-layout search.
 * vite-node audit-pressup-heading.ts <motion.json> <fresh-report.json> [variant]
 * No production motion or solver settings are changed by this audit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS, type BodyVariantId } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { buildSequencePoses, rebaseMotionYaw, resolveComposedMotion, type ComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import type { CustomPose } from '../../src/types';

const [motionFile, outputFile, body = 'neutral', mode] = process.argv.slice(2);
if (!motionFile || !outputFile || !(body in BODY_VARIANTS)) throw Error('Provide motion, fresh report and supported body');
const variant = body as BodyVariantId, cfg = BODY_VARIANTS[variant];
const engine = fileURLToPath(new URL('../../', import.meta.url));
const source = readFileSync(resolve(motionFile));
const authored = JSON.parse(source.toString().replace(/^\uFEFF/, '')) as ComposedMotion;
authored.pronePalmAnchorFit = mode === 'planner';
const cases = [];
for (const [degrees, authoredYaw] of (mode === 'planner' ? [[0, 0], [0, 60]] : [[0, 0], [60, 0], [0, 60]])) {
  const bytes = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale);
  root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), degrees * Math.PI / 180);
  applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skinned: THREE.SkinnedMesh | undefined;
  root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
  if (!skinned) throw Error('Missing skin');
  const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant);
  const rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const motion = resolveComposedMotion(rebaseMotionYaw(authored, authoredYaw), cfg);
  if (motion.status !== 'ok') throw Error(motion.reason);
  const built = buildSequencePoses(baselinePose, motion, cfg, rest);
  const recording = sampleComposedMotion(motion, { baselinePose, variantCfg: cfg, rest,
    skeletonHarness: { root, skinned }, frameTimesMs: [0, 1000, 2500, 4100, 5400],
    trackedBones: ['Hips', 'Spine_Lower', 'Spine_Upper', 'L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm', 'L_Hand', 'R_Hand'] });
  cases.push({ degrees, authoredYaw, built, recording });
}
const differences = (a: CustomPose, b: CustomPose) => Object.keys(a.bones).map(joint => ({
  joint, differenceDeg: new THREE.Quaternion().fromArray(a.bones[joint]).normalize().angleTo(new THREE.Quaternion().fromArray(b.bones[joint]).normalize()) * 180 / Math.PI,
})).filter(row => row.differenceDeg > .0001).sort((a, b) => b.differenceDeg - a.differenceDeg);
const report = {
  scope: 'Read-only actual-rig source covariance audit; no movement acceptance inferred.', variant, mode: mode ?? 'source',
  motionSha256: createHash('sha256').update(source).digest('hex'),
  builtLocalDifferences: cases[0].built.poses.map((pose, i) => differences(pose, cases[1].built.poses[i])),
  sampledLocalDifferences: cases[0].recording.frames.map((frame, i) => ({ tMs: frame.tMs, differences: differences(frame.pose, cases[1].recording.frames[i].pose) })),
  authoredYawBuiltDifferences: cases[0].built.poses.map((pose, i) => differences(pose, cases.at(-1)!.built.poses[i])),
  authoredYawSampledDifferences: cases[0].recording.frames.map((frame, i) => ({ tMs: frame.tMs, differences: differences(frame.pose, cases.at(-1)!.recording.frames[i].pose) })),
  palmLayouts: cases.map(entry => entry.recording.frames[0]?.pronePalmLayout),
  cases,
};
writeFileSync(resolve(outputFile), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ built: report.builtLocalDifferences.map(rows => rows.slice(0, 2)), sampled: report.sampledLocalDifferences.map(row => ({ tMs: row.tMs, differences: row.differences.slice(0, 2) })), authoredYawBuilt: report.authoredYawBuiltDifferences.map(rows => rows.slice(0, 2)), authoredYawSampled: report.authoredYawSampledDifferences.map(row => ({ tMs: row.tMs, differences: row.differences.slice(0, 2) })) }, null, 2));
