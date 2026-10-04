import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';

const output = process.argv[2]; if (!output) throw Error('Provide fresh report');
const engine = fileURLToPath(new URL('../../', import.meta.url));
const hash = (x: Uint8Array) => createHash('sha256').update(x).digest('hex');
const paths = ['footContact', 'handContactPose', 'pressupPalmLayout', 'proneSkinSupport', 'poseRomClamp', 'motionRecording', 'assessmentBodyMotions'];
const identity = () => Object.fromEntries(paths.map(name => [name, hash(readFileSync(resolve(engine, 'src/services', name + '.ts')))]));
const before = identity(), cfg = BODY_VARIANTS.male;
const bytes = readFileSync(resolve(engine, 'models/painmap3D_male.runtime.glb'));
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
const baselinePose = serializeCustomPose(skinned.skeleton, cfg, 'male'), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
const constraints = Object.fromEntries(['L', 'R'].flatMap(side => [
  [side + '_Forearm', { elbowFlexion: { availableRange: { min: 35, max: 75 } } }],
  [side + '_Hand', { wristFlexion: { availableRange: { min: -35, max: 35 } } }],
  [side + '_Leg', { kneeFlexion: { availableRange: { min: 0, max: 0 } } }],
]));
const resolved = resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']('R'), cfg, { constraints });
const times = [0, 1000, 2500, 4100, 5400], samples: any[] = [];
for (const [name, clock] of [['sparse', times], ['duplicates', times.flatMap(t => [t, t, t])], ['sparse-repeat', times]] as const) {
  root.position.set(0, 0, 0); root.quaternion.identity(); applyCustomPose(skinned.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
  const result = sampleComposedMotion(resolved, { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, frameTimesMs: clock, sampleHz: 60 });
  samples.push({ name, frames: result.frames.map(frame => ({ tMs: frame.tMs, pose: frame.pose, angles: frame.angles, root: frame.root, worldTracks: frame.worldTracks })) });
}
const comparisons = samples.slice(1).map(sample => ({ name: sample.name, frames: sample.frames.map((frame: any) => {
  const reference = samples[0].frames.find((f: any) => f.tMs === frame.tMs);
  const differences = Object.entries(reference.pose.bones).map(([key, value]) => ({ key, degrees:
    new THREE.Quaternion().fromArray(value as number[]).normalize().angleTo(new THREE.Quaternion().fromArray(frame.pose.bones[key]).normalize()) * 180 / Math.PI }));
  return { tMs: frame.tMs, worst: differences.sort((a, b) => b.degrees - a.degrees)[0] };
}) }));
const after = identity();
const report = { scope: 'Patient sampler duplicate-time and repeatability diagnostic, no source changes or acceptance.', before, after, stable: JSON.stringify(before) === JSON.stringify(after), sourceModelSha256: hash(bytes), constraints, comparisons, samples };
writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ stable: report.stable, comparisons }));
