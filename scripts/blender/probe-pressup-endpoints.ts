/** Sparse, clinically bounded source evaluation of Blender whole-chain controls.
 * vite-node .../probe-pressup-endpoints.ts <fresh-folder> [male|female|neutral|all]
 * Does not edit source recipes, solver limits, or gates.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { resolveComposedMotion, type ComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { ROM_JOINT_ROWS } from '../../src/services/romRegistry';

const [outputArg, filter = 'all'] = process.argv.slice(2);
const fitting = process.argv[4] === 'fit';
if (!outputArg) throw Error('Provide fresh directory');
const output = resolve(outputArg), engine = fileURLToPath(new URL('../../', import.meta.url)); mkdirSync(output);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const filenames = ['assessmentBodyMotions', 'floorPalmSupports', 'motionRecording', 'footContact', 'rootMotion', 'handSupportSurface', 'movementCommand', 'jointAngles', 'poseRomClamp'];
const identities = () => Object.fromEntries(filenames.map(name => [name, sha(readFileSync(resolve(engine, 'src/services', name + '.ts')))]));
const initial = identities();
const report: any = { version: 1, scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))), sourceBefore: initial,
  scope: 'Five sparse source samples with existing bounded arm/contact solver. Body/palm authoring feasibility only; no dense skin, dynamics, host or clinical approval.',
  frameTimesMs: [0, 1000, 2500, 4100, 5400], cases: [] };
const candidates: { id: string; pelvis: number; forward: number; up: number; motion: ComposedMotion }[] = [];
for (const pelvis of fitting ? [-20] : [0, -10, -20]) for (const forward of fitting ? [.258171] : [.258171, .6]) for (const up of fitting ? [.5] : [.5, 1]) {
  const motion = structuredClone(BODY_ASSESSMENT_MOTIONS['extension-clearing']('R'));
  const id = `p${-pelvis}-f${forward.toFixed(3)}-u${up}`;
  motion.name = 'Blender whole-chain endpoint probe ' + id;
  if (fitting) motion.proneSkinSupport = true;
  const set = (targets: any[], joint: string, channel: string, value: number) => {
    const target = targets.find(t => t.joint === joint && t.motion === channel);
    if (target) target.targetDegrees = value; else targets.push({ joint, motion: channel, targetDegrees: value });
  };
  motion.keyframes.forEach((frame, index) => {
    const peak = index === 1, targets = frame.targets!;
    set(targets, 'Hips', 'anteriorTilt', peak ? pelvis : 0);
    if (peak) { set(targets, 'Spine_Lower', 'flexion', -25); set(targets, 'Spine_Upper', 'flexion', -25); }
    for (const side of ['L', 'R']) {
      set(targets, side + '_UpLeg', 'hipFlexion', peak ? 6 + pelvis : 6);
      set(targets, side + '_Leg', 'kneeFlexion', 10);
    }
  });
  for (const contact of motion.contacts!) Object.assign(contact.palmSupport!, { forward, elbowOutward: .35, elbowBackward: 1, elbowUpward: up });
  writeFileSync(resolve(output, id + '.motion.json'), JSON.stringify(motion, null, 2) + '\n', { flag: 'wx' });
  candidates.push({ id, pelvis, forward, up, motion });
}
for (const variant of ['male', 'female', 'neutral'] as const) {
  if (filter !== 'all' && filter !== variant) continue;
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  const parsed = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const root = parsed.scene; root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin: THREE.SkinnedMesh | undefined;
  root.traverse(o => { if (!skin && (o as THREE.SkinnedMesh).isSkinnedMesh) skin = o as THREE.SkinnedMesh; });
  if (!skin) throw Error('Missing skin');
  const baseline = serializeCustomPose(skin.skeleton, cfg, variant), rest = captureJointAngleRestReference(skin.skeleton, cfg);
  const restRoot = { position: root.position.clone(), quaternion: root.quaternion.clone() };
  const variantCandidates = fitting ? structuredClone(candidates) : candidates;
  for (const [candidateIndex, candidate] of variantCandidates.entries()) {
    root.position.copy(restRoot.position); root.quaternion.copy(restRoot.quaternion); applyCustomPose(skin.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    const motion = resolveComposedMotion(candidate.motion, cfg);
    if (motion.status !== 'ok') throw Error('Refused probe');
    const recording = sampleComposedMotion(motion, { baselinePose: baseline, variantCfg: cfg, rest,
      skeletonHarness: { root, skinned: skin }, frameTimesMs: report.frameTimesMs, sampleHz: 1,
      trackedBones: ['Hips', 'Head', 'Spine_Lower', 'Spine_Mid', 'Spine_Upper', 'Neck_Lower', 'Neck', ...['L', 'R'].flatMap(side => ['Shoulder', 'UpperArm', 'Forearm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'Toes'].map(part => side + '_' + part))] });
    const peak = recording.frames.find(f => f.tMs === 2500)!, first = recording.frames[0]!;
    const wristDriftM = Math.max(...recording.frames.flatMap(frame => ['L_Hand', 'R_Hand'].map(key => new THREE.Vector3().fromArray(frame.worldTracks![key]).distanceTo(new THREE.Vector3().fromArray(first.worldTracks![key])))));
    const violations: any[] = [];
    for (const frame of recording.frames) for (const row of ROM_JOINT_ROWS) for (const field of row.fields) {
      const value = frame.angles[row.canonicalKey]?.[field.key]; if (value == null || row.canonicalKey === 'Hips') continue;
      const excess = Math.max(field.range.min - value, value - field.range.max, 0);
      if (excess > .05) violations.push({ timeMs: frame.tMs, joint: row.canonicalKey, field: field.key, value, range: field.range, excess });
    }
    const elbowPeak = ['L', 'R'].map(side => peak.angles[side + '_Forearm'].elbowFlexion);
    const row = { id: candidate.id, variant, parameters: { pelvis: candidate.pelvis, forward: candidate.forward, elbowUpward: candidate.up },
      sourceModelSha256: sha(bytes), peakElbowFlexionDeg: elbowPeak, wristDriftM, violations, frames: recording.frames,
      score: Math.max(...elbowPeak) + wristDriftM * 10000 + (violations.length ? 1000 : 0) };
    writeFileSync(resolve(output, variant + '-' + candidate.id + '.json'), JSON.stringify(row, null, 2) + '\n', { flag: 'wx' });
    report.cases.push({ ...row, frames: undefined });
    console.log(JSON.stringify({ variant, id: candidate.id, peakElbowFlexionDeg: elbowPeak, wristDriftM, violations: violations.length, score: row.score }));
    if (fitting && candidateIndex < 7 && !(Math.max(...elbowPeak.map(value => Math.abs(value - 10))) < 2 && wristDriftM < .0005)) {
      // Actual reach geometry, not a variant table: intersect desired elbow
      // reach with the plane at the fitted wrist height. The bounded solver
      // may move the girdle, so repeat against its realized shoulder position.
      const corrections = ['L', 'R'].map(side => {
        const point = (part: string) => new THREE.Vector3().fromArray(peak.worldTracks![side + '_' + part]);
        const shoulder = point('UpperArm'), elbow = point('Forearm'), wrist = point('Hand');
        const upper = shoulder.distanceTo(elbow), lower = elbow.distanceTo(wrist);
        const reachSquared = upper * upper + lower * lower + 2 * upper * lower * Math.cos(10 * Math.PI / 180);
        const radialSquared = reachSquared - (wrist.y - shoulder.y) ** 2 - (wrist.x - shoulder.x) ** 2;
        if (radialSquared < 0) return { feasible: false, forwardChange: 0, radialSquared };
        const desiredZ = shoulder.z + Math.sqrt(radialSquared);
        return { feasible: true, forwardChange: (desiredZ - wrist.z) / upper, radialSquared };
      });
      const delta = corrections.reduce((sum, value) => sum + value.forwardChange, 0) / 2;
      const nextForward = Math.min(1, Math.max(-.1, candidate.forward + Math.max(-.15, Math.min(.15, delta))));
      (report.cases.at(-1) as any).anchorGeometry = corrections;
      if (Math.abs(nextForward - candidate.forward) > .00001) {
        const next = structuredClone(candidate); next.forward = nextForward; next.id = `fit-${variant}-${candidateIndex + 1}`;
        for (const contact of next.motion.contacts!) contact.palmSupport!.forward = nextForward;
        next.motion.name = 'Blender geometry-derived fixed palm ' + next.id;
        variantCandidates.push(next);
        writeFileSync(resolve(output, next.id + '.motion.json'), JSON.stringify(next.motion, null, 2) + '\n', { flag: 'wx' });
      }
    }
  }
}
report.sourceAfter = identities(); report.sourceStable = JSON.stringify(report.sourceAfter) === JSON.stringify(initial);
report.ranked = [...report.cases].sort((a: any, b: any) => a.score - b.score);
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
