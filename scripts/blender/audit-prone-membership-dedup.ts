import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { buildSequencePoses, resolveComposedMotion } from '../../src/services/motionSequence';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
import { createProneSkinSupport as originalFactory } from './captured-prone-membership-original';
import { createProneSkinSupport as candidateFactory } from './captured-prone-membership-dedup';

setRomClampEnabled(false);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (file: string) => hash(readFileSync(new URL(file, import.meta.url)));
const sourceIdentity = () => Object.fromEntries(['proneSkinSupport', 'poseRomClamp', 'jointAngles', 'movementCommand'].map(name => [name, fileHash(`../../src/services/${name}.ts`)]));
const report: any = { before: sourceIdentity(), scope: 'Isolated helper reference-fingerprint deduplication. Actual three body rigs, authored setup/peak/return, lower-chain patient constraint, repeated inputs and authoritative mutations. Exact returned result and all-bone locals required. Timings alternate execution order; this is not the combined patient performance gate.', copies: Object.fromEntries(['original', 'dedup'].map(name => [name, fileHash(`./captured-prone-membership-${name}.ts`)])), runs: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const skins: THREE.SkinnedMesh[] = [];
  root.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) skins.push(node as THREE.SkinnedMesh); });
  const skinned = skins[0]!, baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const options = { root, skinned, variantCfg: cfg, baselinePose, rest };
  const sequence = buildSequencePoses(baselinePose, resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), cfg, rest);
  const helpers = [originalFactory(options), candidateFactory(options)];
  const snapshot = () => skinned.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
  const restore = (pose: number[][]) => { skinned.skeleton.bones.forEach((bone, i) => { bone.position.fromArray(pose[i]!); bone.quaternion.fromArray(pose[i]!, 3); bone.scale.fromArray(pose[i]!, 7); }); root.updateMatrixWorld(true); };
  const run: any = { variant, assetSha256: hash(bytes), skins: skins.length, uniqueSkeletons: new Set(skins.map(skin => skin.skeleton)).size, calls: [], mutations: [] };
  let count = 0;
  const pair = (label: string, constraints?: any) => {
    const input = snapshot(), results: any[] = [], poses: number[][][] = [], times: number[] = [];
    for (const index of count++ % 2 ? [1, 0] : [0, 1]) {
      restore(input); const start = performance.now();
      results[index] = helpers[index]!.solve({ constraints }); times[index] = performance.now() - start; poses[index] = snapshot();
    }
    const exactResult = JSON.stringify(results[0]) === JSON.stringify(results[1]), exactPose = JSON.stringify(poses[0]) === JSON.stringify(poses[1]);
    if (!exactResult || !exactPose) throw Error(JSON.stringify({ variant, label, exactResult, exactPose }));
    run.calls.push({ label, times, reused: results[0].reusedSolution, exactResult, exactPose });
  };
  for (const patient of [false, true]) for (let iteration = 0; iteration < 20; iteration++) for (let phase = 0; phase < sequence.poses.length; phase++) {
    applyCustomPose(skinned.skeleton, cfg, sequence.poses[phase]!); root.quaternion.fromArray(sequence.roots[phase]!.quat); root.updateMatrixWorld(true);
    pair(patient ? 'patient' : 'default', patient ? { L_Leg: { kneeFlexion: { availableRange: { min: 0, max: 0 } } } } : undefined);
  }
  for (const mutation of ['owner', 'weights', 'replacement', 'binding', 'baseline', 'rest', 'scale']) {
    const witness = helpers[0]!.measure().pelvis, mesh = root.getObjectByName(witness.mesh) as THREE.SkinnedMesh;
    const ids = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
    if (mutation === 'owner') { let slot = 0; for (let i = 1; i < 4; i++) if (weights.getComponent(witness.vertex, i) > weights.getComponent(witness.vertex, slot)) slot = i; ids.setComponent(witness.vertex, slot, mesh.skeleton.bones.findIndex(bone => /Waist$/.test(bone.name))); ids.needsUpdate = true; }
    if (mutation === 'weights') { const old = weights.getX(witness.vertex); weights.setX(witness.vertex, weights.getY(witness.vertex)); weights.setY(witness.vertex, old); weights.needsUpdate = true; }
    if (mutation === 'replacement') { const position = mesh.geometry.getAttribute('position').clone(); position.setY(witness.vertex, position.getY(witness.vertex) + .2); mesh.geometry.setAttribute('position', position); }
    if (mutation === 'binding') mesh.skeleton.boneInverses[0]!.elements[12]! += .1;
    if (mutation === 'baseline') baselinePose.positions!.L_Leg![1] += .01;
    if (mutation === 'rest') rest.localQuats.L_UpLeg = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .01).multiply(new THREE.Quaternion().fromArray(rest.localQuats.L_UpLeg!)).toArray();
    if (mutation === 'scale') root.scale.y *= 1.01;
    const before = snapshot(), candidateMeasured = helpers[1]!.measure(), fresh = candidateFactory(options);
    if (JSON.stringify(candidateMeasured) !== JSON.stringify(fresh.measure())) throw Error(`Stale ${variant} ${mutation}`);
    restore(before); pair(mutation); run.mutations.push({ mutation, exactFreshMeasurement: true });
  }
  run.timing = Object.fromEntries(['default', 'patient'].map(label => { const calls = run.calls.filter((call: any) => call.label === label); return [label, { calls: calls.length, originalMs: calls.reduce((sum: number, call: any) => sum + call.times[0], 0), candidateMs: calls.reduce((sum: number, call: any) => sum + call.times[1], 0) }]; }));
  report.runs.push(run); console.log(JSON.stringify({ variant, skins: run.skins, uniqueSkeletons: run.uniqueSkeletons, timing: run.timing, mutations: run.mutations.length }));
}
report.after = sourceIdentity(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
