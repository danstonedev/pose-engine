import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import * as Clamp from '../../src/services/poseRomClamp';
import * as Before from './captured-before-generic-scope-rom';

const output = process.argv[2]; if (!output) throw new Error('Supply a fresh report path.');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['poseRomClamp', 'handContactPose', 'footContact', 'rootMotion', 'proneSkinSupport'];
const identities = () => Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(new URL(`../../src/services/${file}.ts`, import.meta.url)))]));
const sourceBefore = identities();
const clamp = Clamp.clampBoneToRom, inspect = Clamp.inspectClinicalAngles;
const clampDescriptor = Object.getOwnPropertyDescriptor(Clamp, 'clampBoneToRom')!, inspectDescriptor = Object.getOwnPropertyDescriptor(Clamp, 'inspectClinicalAngles')!;
let useBefore = false;
Object.defineProperty(Clamp, 'clampBoneToRom', { configurable: true, value: (...args: Parameters<typeof clamp>) => useBefore ? Before.clampBoneToRom(...args) : clamp(...args) });
Object.defineProperty(Clamp, 'inspectClinicalAngles', { configurable: true, value: (...args: Parameters<typeof inspect>) => useBefore ? Before.inspectClinicalAngles(...args) : inspect(...args) });
Clamp.setRomClampEnabled(false); Before.setRomClampEnabled(false);
const cases: any[] = [];
try {
  for (const variant of ['male', 'female', 'neutral'] as const) {
    const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const recordings: any[] = [];
    for (const before of [true, false]) {
      useBefore = before;
      const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
      root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
      let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
      const rest = captureJointAngleRestReference(skinned.skeleton, cfg), baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant);
      const resolved = resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg);
      recordings.push(sampleComposedMotion(resolved, { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60 }).frames);
    }
    const encoded = recordings.map(frames => JSON.stringify(frames));
    cases.push({ variant, frames: recordings[0].length, beforeSha256: hash(encoded[0]!), afterSha256: hash(encoded[1]!), exact: encoded[0] === encoded[1], assetSha256: hash(bytes),
      firstDifferentFrame: recordings[0].findIndex((frame: any, index: number) => JSON.stringify(frame) !== JSON.stringify(recordings[1][index])) });
  }
} finally { Object.defineProperty(Clamp, 'clampBoneToRom', clampDescriptor); Object.defineProperty(Clamp, 'inspectClinicalAngles', inspectDescriptor); }
const sourceAfter = identities();
const report = { scope: 'Approved default extension-clearing, 60 Hz all three actual bodies, browser ROM mode off; byte equality of every serialized frame including pose, root, world tracks, clinical readouts and support/layout results before versus after generic hinge policy scope correction.',
  globalRomClamp: false, sourceBefore, sourceAfter, sourceStable: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
  previousClampSha256: hash(readFileSync(new URL('./captured-before-generic-scope-rom.ts', import.meta.url))), scriptSha256: hash(readFileSync(new URL(import.meta.url))), cases, exactAll: cases.every(value => value.exact) };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
