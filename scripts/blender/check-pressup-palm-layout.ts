/** Actual-rig sparse planner checks and editable-proposal source poses.
 * vite-node .../check-pressup-palm-layout.ts <fresh-folder> [male|female|neutral|all]
 * Optional final `properties` checks determinism, heading and patient fallback.
 * This evidence does not replace dense skin, clinical, native or host review.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { resolveComposedMotion, rebaseMotionYaw, type SequenceTarget } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { preparePressupPalmLayout } from '../../src/services/pressupPalmLayout';
import { defineBodyControl } from '../../src/services/movementControl';
import { ROM_JOINT_ROWS } from '../../src/services/romRegistry';

const [outputArg, filter = 'all', checks, pelvisArg = '-20', hipSeedArg = '6', kneeSeedArg = '10', shoulderSeedArg = '140', hipRotationArg = '0', hipAbductionArg = '0', elbowBackArg = '1', elbowUpArg = '.5'] = process.argv.slice(2);
if (!outputArg) throw Error('Provide fresh output directory');
const output = resolve(outputArg), engine = fileURLToPath(new URL('../../', import.meta.url)); mkdirSync(output);
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const files = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(folder, entry.name)) : [resolve(folder, entry.name)]).sort();
const identity = () => sha(files(resolve(engine, 'src')).map(path => relative(engine, path).replaceAll('\\', '/') + ':' + sha(readFileSync(path))).join('\n'));
const before = identity();
const motion = structuredClone(BODY_ASSESSMENT_MOTIONS['extension-clearing']('R'));
const pelvisTarget = Number(pelvisArg), hipSeed = Number(hipSeedArg), kneeSeed = Number(kneeSeedArg), shoulderSeed = Number(shoulderSeedArg), hipRotation = Number(hipRotationArg), hipAbduction = Number(hipAbductionArg);
const elbowBackward = Number(elbowBackArg), elbowUpward = Number(elbowUpArg);
if (![pelvisTarget, hipSeed, kneeSeed, shoulderSeed, hipRotation, hipAbduction].every(Number.isFinite)) throw Error('Nonfinite proposal control');
motion.name = 'Blender proposal: supported whole-chain spinal extension clearing';
motion.proneSkinSupport = true;
motion.pronePalmAnchorFit = true;
const set = (targets: SequenceTarget[], joint: string, channel: string, value: number) => {
  const target = targets.find(item => item.joint === joint && item.motion === channel);
  if (target) target.targetDegrees = value; else targets.push({ joint, motion: channel, targetDegrees: value });
};
motion.keyframes.forEach((frame, index) => {
  const peak = index === 1, targets = frame.targets!;
  set(targets, 'Hips', 'anteriorTilt', peak ? pelvisTarget : 0);
  if (peak) { set(targets, 'Spine_Lower', 'flexion', -25); set(targets, 'Spine_Upper', 'flexion', -25); }
  for (const side of ['L', 'R']) {
    if (peak) set(targets, side + '_UpperArm', 'shoulderFlexion', shoulderSeed);
    set(targets, side + '_UpLeg', 'hipFlexion', peak ? pelvisTarget + hipSeed : hipSeed);
    set(targets, side + '_Leg', 'kneeFlexion', kneeSeed);
    set(targets, side + '_UpLeg', 'hipRotation', hipRotation);
    set(targets, side + '_UpLeg', 'hipAbduction', hipAbduction);
  }
  frame.control = defineBodyControl({
    id: 'extension-clearing/' + ['setup', 'press-and-hold', 'return'][index],
    root: { translation: 'support', orientation: 'placement' },
    supports: ['anterior-pelvis', 'thigh-calf-envelope', 'dorsal-toes', 'bilateral-palms'],
    groups: [
      { joints: ['Hips'], role: 'contact', support: 'anterior-pelvis', purpose: 'Authored pelvic tilt participates in extension while measured anterior pelvis sets root support height.' },
      { joints: ['Spine_Lower'], role: 'driven', purpose: 'Authored lumbar curve contributes to coordinated spinal extension and return within patient ROM.' },
      { joints: ['Spine_Mid', 'Spine_Upper'], role: 'derived', source: 'Hips', purpose: 'Regional thoracic command splits across both segments; proneSkinSupport raises only the minimum setup curve needed for chest clearance above the supported pelvis.' },
      { joints: ['Neck'], role: 'driven', purpose: 'Regional cervical command coordinates gaze with the extending trunk.' },
      { joints: ['Neck_Lower'], role: 'derived', source: 'Neck', purpose: 'Regional cervical command distributes through the lower neck.' },
      { joints: ['Head'], role: 'held', purpose: 'Local head orientation follows the cervical chain without an independent head excursion.' },
      { joints: ['L_Shoulder', 'L_UpperArm', 'L_Forearm'], role: 'derived', source: 'L_Hand', purpose: 'Bounded handContactPose solves the fixed left palm with the authored elbow guide and preserves clinical/patient ROM.' },
      { joints: ['R_Shoulder', 'R_UpperArm', 'R_Forearm'], role: 'derived', source: 'R_Hand', purpose: 'Bounded handContactPose solves the fixed right palm with the authored elbow guide and preserves clinical/patient ROM.' },
      { joints: ['L_Hand', 'R_Hand'], role: 'contact', support: 'bilateral-palms', purpose: 'Measured palm skin orientation and geometry-derived fixed anchors stay on the explicit floor throughout the source motion.' },
      { joints: ['L_UpLeg', 'L_Leg', 'R_UpLeg', 'R_Leg'], role: 'derived', source: 'Hips', purpose: 'proneSkinSupport coordinates bounded hip/knee corrections from the actual full thigh/calf envelope and toe skin against pelvis support; distal-envelope and knee-band clearance remain separately reported.' },
      { joints: ['L_Foot', 'R_Foot'], role: 'held', purpose: 'Authored plantarflexed ankles are held while the proximal chain solves prone resting support.' },
      { joints: ['L_Toes', 'R_Toes'], role: 'contact', support: 'dorsal-toes', purpose: 'Dorsal toe skin participates in prone resting support, without requiring a standing sole or heel plant.' },
    ],
  });
});
for (const contact of motion.contacts!) Object.assign(contact.palmSupport!, { forward: .258171, elbowOutward: .35, elbowBackward, elbowUpward });
writeFileSync(resolve(output, 'proposed.motion.json'), JSON.stringify(motion, null, 2) + '\n', { flag: 'wx' });
const summary: any = { version: 1, sourceBefore: before, scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  scope: 'Five actual bounded source times. Sparse planner feasibility and state properties; not full-motion acceptance.',
  frameTimesMs: [0, 1000, 2500, 4100, 5400], cases: [], properties: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  if (filter !== 'all' && filter !== variant) continue;
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skinned: THREE.SkinnedMesh | undefined;
  root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
  if (!skinned) throw Error('Missing actual skin');
  const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const resolvedMotion = resolveComposedMotion(motion, cfg);
  assert.equal(resolvedMotion.status, 'ok');
  const options = { resolvedMotion, baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned } };
  const snapshot = () => [root, ...skinned!.skeleton.bones].map(node => ({ uuid: node.uuid, p: node.position.toArray(), q: node.quaternion.toArray(), s: node.scale.toArray(), matrix: [...node.matrix.elements], matrixAutoUpdate: node.matrixAutoUpdate }));
  const stateBefore = snapshot(), start = performance.now(), layout = preparePressupPalmLayout(options), elapsedMs = performance.now() - start;
  assert.deepEqual(snapshot(), stateBefore, 'Planner must restore root and every bone/helper local transform');
  if (checks === 'properties') {
    const repeated = preparePressupPalmLayout(options);
    assert.deepEqual(repeated, layout, 'Identical inputs must produce identical serialized layout');
    assert.deepEqual(snapshot(), stateBefore);
    const unsupported = preparePressupPalmLayout({ ...options, resolvedMotion: { ...resolvedMotion, loop: true } });
    assert.equal(unsupported.iterations.length, 0); assert.deepEqual(unsupported.contacts, motion.contacts);
    const patient = { L_Leg: { kneeFlexion: { availableRange: { min: 0, max: 0 } } }, R_Leg: { kneeFlexion: { availableRange: { min: 0, max: 0 } } } };
    const limited = preparePressupPalmLayout({ ...options, constraints: patient });
    assert.equal(limited.endpointReached, false); assert.equal(limited.iterations.length, 1);
    assert.deepEqual(limited.contacts, motion.contacts); assert.ok(limited.bodySupportFailures.length > 0);
    assert.deepEqual(snapshot(), stateBefore);
    // The supported heading route authors yaw on the motion. Altering the
    // baseline rig root before anatomical capture changes command frames and
    // failed in properties1; that distinct preexisting limitation is preserved.
    const headed = preparePressupPalmLayout({ ...options, resolvedMotion: resolveComposedMotion(rebaseMotionYaw(motion, 60), cfg) });
    assert.equal(headed.endpointReached, layout.endpointReached);
    if (layout.forward != null) assert.ok(Math.abs(headed.forward! - layout.forward) < .00001, `Heading changed fitted forward ${headed.forward} vs ${layout.forward}`);
    assert.deepEqual(snapshot(), stateBefore);
    summary.properties.push({ variant, harnessRestoration: true, exactRepeat: true, unsupportedScope: true, patientEarlyFallback: true, headingInvariant: true, limited });
  }
  const recording = sampleComposedMotion({ ...resolvedMotion, contacts: layout.contacts, pronePalmAnchorFit: false }, {
    baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, frameTimesMs: summary.frameTimesMs, sampleHz: 1,
    trackedBones: ['Hips', 'Head', 'Spine_Lower', 'Spine_Mid', 'Spine_Upper', 'Neck_Lower', 'Neck', ...['L', 'R'].flatMap(side => ['Shoulder', 'UpperArm', 'Forearm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'Toes'].map(part => side + '_' + part))],
  });
  const violations: any[] = [];
  for (const frame of recording.frames) for (const row of ROM_JOINT_ROWS) for (const field of row.fields) {
    const value = frame.angles[row.canonicalKey]?.[field.key]; if (value == null) continue;
    const excess = Math.max(field.range.min - value, value - field.range.max, 0);
    if (excess > .05) violations.push({ timeMs: frame.tMs, joint: row.canonicalKey, field: field.key, value, range: field.range, excess });
  }
  const entry = { id: 'planned-whole-chain', variant, parameters: { pelvis: pelvisTarget, hipSeed, kneeSeed, shoulderSeed, hipRotation, hipAbduction, forward: layout.forward, elbowBackward, elbowUpward },
    sourceModelSha256: sha(bytes), layout, elapsedMs, violations, frames: recording.frames };
  writeFileSync(resolve(output, variant + '-planned-whole-chain.json'), JSON.stringify(entry, null, 2) + '\n', { flag: 'wx' });
  summary.cases.push({ ...entry, frames: undefined });
  console.log(JSON.stringify({ variant, elapsedMs, forward: layout.forward, endpointReached: layout.endpointReached, bodySupportFeasible: layout.bodySupportFeasible, wristDriftM: layout.maximumPalmDriftM, peakElbows: layout.iterations[layout.selectedIteration ?? 0]?.peakElbowFlexionDeg, violations: violations.length, reasons: layout.reasons }));
}
summary.sourceAfter = identity(); summary.sourceStable = summary.sourceAfter === before;
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
