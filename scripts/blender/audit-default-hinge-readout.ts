import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { buildBoneByPoseKey } from '../../src/services/poseRig';
import { captureJointAngleRestReference, computeJointAngles, measureHingeFlexion } from '../../src/services/jointAngles';
import { clampBoneToRom, clampMeasuredPatientHinge, inspectClinicalAngles, setRomClampEnabled } from '../../src/services/poseRomClamp';
import { getEffectiveRomRange } from '../../src/services/romConstraints';

setRomClampEnabled(false);
const [inputs, output] = process.argv.slice(2);
if (!inputs || !output) throw Error('Supply immutable recording directory and fresh report path');
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const identities = () => Object.fromEntries(['poseRomClamp', 'jointAngles', 'romRegistry', 'romConstraints'].map(name =>
  [name, hash(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url)))]));
const report: any = { before: identities(), scope: 'Offline actual-rig replay of every retained dense default frame. Compares geometric clinical hinge readout to local clamp coordinates. Only a restored saved setup pose is projected with an explicit range equal to the unchanged normative range as a diagnostic; no runtime edits or new motion acceptance.', cases: [] };
for (const variant of ['male', 'female'] as const) {
  const inputPath = `${inputs}/fms-repo-legacy-v1-trunk-stability-push-up-extension-clearing-${variant}-both.recording.json`;
  const input = readFileSync(inputPath), recording = JSON.parse(input.toString('utf8'));
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin!: THREE.SkinnedMesh; root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
  const rest = captureJointAngleRestReference(skin.skeleton, cfg), canonical = buildBoneByPoseKey(skin.skeleton, cfg);
  const restore = (frame: any) => {
    root.position.fromArray(frame.root.position); root.quaternion.fromArray(frame.root.quaternion); root.scale.fromArray(frame.root.scale);
    for (const bone of skin.skeleton.bones) {
      const transform = frame.boneTransforms[bone.name];
      if (!transform) throw Error(`Missing recorded local transform: ${bone.name}`);
      bone.position.fromArray(transform.localPositionM); bone.quaternion.fromArray(transform.localQuaternionXYZW);
    }
    root.updateMatrixWorld(true);
  };
  const rows: any[] = []; let maximumWorldReplayErrorM = 0, maximumSavedReadoutDifferenceDeg = 0;
  for (const frame of recording.frames) {
    restore(frame);
    for (const bone of skin.skeleton.bones) maximumWorldReplayErrorM = Math.max(maximumWorldReplayErrorM,
      bone.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(frame.boneTransforms[bone.name].positionM)));
    const readout = computeJointAngles(skin.skeleton, cfg, variant, rest).joints;
    for (const side of ['L', 'R']) {
      const key = `${side}_Forearm`, bone = canonical.get(key)!, parent = canonical.get(`${side}_UpperArm`)!;
      const measured = measureHingeFlexion(parent, bone, key, rest)!;
      const local = inspectClinicalAngles(bone, key, rest)!;
      const range = getEffectiveRomRange(null, key, 'elbowFlexion')!;
      const saved = frame.angles?.joints?.[key]?.elbowFlexion ?? frame.angles?.[key]?.elbowFlexion;
      if (saved == null) throw Error('Recording has no geometric elbow readout');
      maximumSavedReadoutDifferenceDeg = Math.max(maximumSavedReadoutDifferenceDeg, Math.abs(measured - saved));
      rows.push({ index: frame.index, tMs: frame.tMs, key, saved, measured, computed: readout[key]?.elbowFlexion,
        localClampFlexion: local.anatomicFlexion, range, violationDeg: Math.max(range.min - measured, measured - range.max, 0) });
    }
  }
  const setup = recording.frames.reduce((a: any, b: any) => Math.abs(a.tMs - 1000) < Math.abs(b.tMs - 1000) ? a : b);
  const diagnostics = [];
  for (const side of ['L', 'R']) {
    restore(setup);
    const key = `${side}_Forearm`, bone = canonical.get(key)!, parent = canonical.get(`${side}_UpperArm`)!;
    const measure = () => ({ geometric: measureHingeFlexion(parent, bone, key, rest),
      local: inspectClinicalAngles(bone, key, rest), fields: computeJointAngles(skin.skeleton, cfg, variant, rest).joints[key], q: bone.quaternion.toArray() });
    const initial = measure();
    const defaultLocalChanged = clampBoneToRom(bone, key, rest, null, true, { continuousProjection: true });
    const afterLocal = measure();
    const defaultMeasuredChanged = clampMeasuredPatientHinge(parent, bone, key, rest, null, { continuousProjection: true });
    const afterDefaultMeasured = measure();
    const range = getEffectiveRomRange(null, key, 'elbowFlexion')!;
    const normativeAsExplicit = { [key]: { elbowFlexion: { availableRange: range } } };
    const measuredChanged = clampMeasuredPatientHinge(parent, bone, key, rest, normativeAsExplicit, { continuousProjection: true });
    const afterMeasuredNormative = measure();
    clampBoneToRom(bone, key, rest, null, true, { continuousProjection: true });
    const afterLocalAgain = measure();
    diagnostics.push({ key, initial, defaultLocalChanged, afterLocal, defaultMeasuredChanged, afterDefaultMeasured,
      measuredChanged, afterMeasuredNormative, afterLocalAgain });
  }
  const row = { variant, inputPath, inputSha256: hash(input), modelSha256: hash(bytes), frames: recording.frames.length,
    maximumWorldReplayErrorM, maximumSavedReadoutDifferenceDeg, maximumViolationDeg: Math.max(...rows.map(r => r.violationDeg)),
    violations: rows.filter(r => r.violationDeg > .05), setup: rows.filter(r => Math.abs(r.tMs - 1000) < .001), diagnostics };
  report.cases.push(row);
  console.log(JSON.stringify({ variant, frames: row.frames, maximumWorldReplayErrorM, maximumSavedReadoutDifferenceDeg,
    maximumViolationDeg: row.maximumViolationDeg, violations: row.violations.length, setup: row.setup,
    diagnostics: diagnostics.map(d => ({ key: d.key, initial: d.initial.geometric, defaultLocal: d.afterLocal.geometric,
      defaultMeasured: d.afterDefaultMeasured.geometric, measuredNormative: d.afterMeasuredNormative.geometric, afterLocalAgain: d.afterLocalAgain.geometric })) }));
}
report.after = identities(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
if (!report.sourceStable || report.cases.some((row: any) => row.maximumWorldReplayErrorM > 1e-8 || row.maximumSavedReadoutDifferenceDeg > 1e-6)) process.exitCode = 1;
