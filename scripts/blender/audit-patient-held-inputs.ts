import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';

// Process-local instrumentation. The optional constant-endpoint counterfactual
// changes only identical-quaternion interpolation; no production file changes.
const constantCounterfactual = process.argv[3] === 'constant';
// Match the actual floorPalmSupports test and browser pose-mode switch.
// Contact solving still explicitly forces clinical/patient projection.
setRomClampEnabled(false);
const fileNames = ['footContact', 'handContactPose', 'proneSkinSupport', 'posedGeometry', 'poseRomClamp', 'motionRecording', 'motionTrajectory', 'pressupPalmLayout'];
const hashes = () => Object.fromEntries(fileNames.map(name => [name, createHash('sha256').update(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url))).digest('hex')]));
const report: any = { before: hashes(), poseModeClampEnabled: false, constantCounterfactual, scope: 'Exact inputs/cache lookups, male production rig, actual restrictive patient regression. Optional constant=true bypasses only identical-quaternion slerp in this process. Instrumentation overhead included; not acceptance.', runs: [] };
const cfg = BODY_VARIANTS.male;
const bytes = readFileSync(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url));
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
const baselinePose = serializeCustomPose(skinned.skeleton, cfg, 'male'), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
const position = root.position.clone(), quaternion = root.quaternion.clone();
const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } }, L_Forearm: { elbowFlexion: { availableRange: { min: 110, max: 125 } } }, R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
const stringify = JSON.stringify, get = Map.prototype.get, slerp = THREE.Quaternion.prototype.slerp;
const differences = (a: any, b: any, path = '', rows: any[] = []): any[] => {
  if (Object.is(a, b)) return rows;
  if (typeof a === 'number' && typeof b === 'number') rows.push({ path, before: a, after: b, delta: b - a });
  else if (a && b && typeof a === 'object' && typeof b === 'object') for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], `${path}.${key}`, rows);
  else rows.push({ path, before: a, after: b });
  return rows;
};
for (const label of ['default', 'patient', 'patient-repeat']) {
  root.position.copy(position); root.quaternion.copy(quaternion); applyCustomPose(skinned.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
  const rows: any[] = [], watched = new Map<string, any>(), selfSlerps: any = { calls: 0, changed: 0, maximumComponentChange: 0, witnesses: [] };
  JSON.stringify = ((value: any, ...args: any[]) => {
    const key = (stringify as any)(value, ...args);
    const kind = Array.isArray(value) && value.length === 9 && Array.isArray(value[0]) && value[0].length === 3 && Array.isArray(value[5]) ? 'refinement'
      : Array.isArray(value) && value.length === 10 && typeof value[0] === 'string' && typeof value[1] === 'number' ? 'guide'
      : value && !Array.isArray(value) && value.orientation && value.bones && value.skin ? 'lower-support' : null;
    if (kind) { const row = { kind, key, lookups: 0, hits: 0 }; rows.push(row); watched.set(key, row); }
    return key;
  }) as typeof JSON.stringify;
  Map.prototype.get = function(key: any) {
    const result = get.call(this, key), row = get.call(watched, key);
    if (row && this !== watched) { row.lookups++; if (result !== undefined) row.hits++; }
    return result;
  };
  THREE.Quaternion.prototype.slerp = function(target: THREE.Quaternion, t: number) {
    const equal = this.equals(target), before = equal ? this.toArray() : null;
    const result = equal && constantCounterfactual ? this : slerp.call(this, target, t);
    if (before) {
      selfSlerps.calls++;
      const after = this.toArray(), change = Math.max(...after.map((value, i) => Math.abs(value - before[i]!)));
      selfSlerps.maximumComponentChange = Math.max(selfSlerps.maximumComponentChange, change);
      if (change) {
        selfSlerps.changed++;
        if (selfSlerps.witnesses.length < 5) selfSlerps.witnesses.push({ before, after, t, lengthSq: before.reduce((sum, value) => sum + value * value, 0), stack: new Error().stack?.split('\n').slice(1, 5) });
      }
    }
    return result;
  };
  const costs = (globalThis as any).__palmCosts = {}, start = performance.now();
  let recording;
  try {
    recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
      baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 30,
      ...(label === 'default' ? {} : { constraints }),
    });
  } finally { JSON.stringify = stringify; Map.prototype.get = get; THREE.Quaternion.prototype.slerp = slerp; }
  const elapsedMs = performance.now() - start;
  const refinement = rows.filter(row => row.kind === 'refinement'), playback = refinement.slice(-recording.frames.length * 2);
  const held = playback.map((row, i) => ({ ...row, timeMs: recording.frames[Math.floor(i / 2)]!.tMs, input: JSON.parse(row.key) }))
    .filter(row => row.timeMs >= 2500 - .001 && row.timeMs <= 4100 + .001);
  const components = ['target', 'orientation', 'elbowFloor', 'rest', 'constraints', 'keys', 'guideInitialSeed', 'ancestorWorld', 'chainTransforms'];
  const lowerPlayback = rows.filter(row => row.kind === 'lower-support').slice(-recording.frames.length);
  const lowerHeld = lowerPlayback.map((row, i) => ({ ...row, timeMs: recording.frames[i]!.tMs, input: JSON.parse(row.key) }))
    .filter(row => row.timeMs >= 2500 - .001 && row.timeMs <= 4100 + .001);
  const lowerHold = { frames: lowerHeld.length, uniqueKeys: new Set(lowerHeld.map(row => row.key)).size,
    uniqueComponentCounts: Object.fromEntries(['orientation', 'scale', 'bones', 'skin', 'constraints'].map(name => [name, new Set(lowerHeld.map(row => stringify(row.input[name]))).size])) };
  const hold = ['L', 'R'].map(side => {
    const selected = held.filter(row => row.input[5][0].startsWith(side)), first = selected[0]!;
    return { side, frames: selected.length, uniqueKeys: new Set(selected.map(row => row.key)).size, hits: selected.reduce((sum, row) => sum + row.hits, 0),
      uniqueComponentCounts: Object.fromEntries(components.map((name, index) => [name, new Set(selected.map(row => stringify(row.input[index]))).size])),
      firstDifferent: selected.find(row => row.key !== first.key) ? (() => { const row = selected.find(row => row.key !== first.key)!; return { tMs: row.timeMs, differences: differences(first.input, row.input).slice(0, 25) }; })() : null };
  });
  const summary = { label, elapsedMs, frames: recording.frames.length, costs, selfSlerps, lowerHold,
    keys: Object.fromEntries(['guide', 'lower-support', 'refinement'].map(kind => { const selected = rows.filter(row => row.kind === kind); return [kind, { calls: selected.length, unique: new Set(selected.map(row => row.key)).size, lookups: selected.reduce((sum, row) => sum + row.lookups, 0), hits: selected.reduce((sum, row) => sum + row.hits, 0) }]; })), hold };
  report.runs.push(summary); console.log(stringify({ label, elapsedMs, costs, keys: summary.keys, lowerHold, hold: hold.map(({ side, frames, uniqueKeys, hits, uniqueComponentCounts }) => ({ side, frames, uniqueKeys, hits, uniqueComponentCounts })), selfSlerps: { calls: selfSlerps.calls, changed: selfSlerps.changed, maximumComponentChange: selfSlerps.maximumComponentChange } }));
}
report.after = hashes(); report.sourceStable = stringify(report.before) === stringify(report.after);
writeFileSync(process.argv[2]!, stringify(report, null, 2) + '\n', { flag: 'wx' });
