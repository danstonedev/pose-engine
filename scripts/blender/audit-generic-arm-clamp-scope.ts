import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { buildBoneByPoseKey, buildIKChainContext, serializeCustomPose, applyCustomPose } from '../../src/services/poseRig';
import { solveArmChainWithRhythm } from '../../src/services/poseScapulohumeral';
import * as Clamp from '../../src/services/poseRomClamp';
import * as Hand from '../../src/services/handContactPose';
import * as Historical from './captured-head-generic-rom-clamp';

const output = process.argv[2]; if (!output) throw new Error('Supply a fresh output path.');
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const files = ['poseRomClamp', 'poseRig', 'poseScapulohumeral', 'handContactPose'];
const sourceHashes = () => Object.fromEntries(files.map(file => [file, hash(readFileSync(new URL(`../../src/services/${file}.ts`, import.meta.url)))]));
const sourceBefore = sourceHashes();
const original = Clamp.clampBoneToRom, descriptor = Object.getOwnPropertyDescriptor(Clamp, 'clampBoneToRom')!;
const currentInspect = Clamp.inspectClinicalAngles, inspectDescriptor = Object.getOwnPropertyDescriptor(Clamp, 'inspectClinicalAngles')!;
const handOriginal = Hand.solveHandContactPose, handDescriptor = Object.getOwnPropertyDescriptor(Hand, 'solveHandContactPose')!;
let mode = 'current', handCalls = 0, clampCalls = 0;
Object.defineProperty(Clamp, 'clampBoneToRom', { configurable: true, value: (...args: Parameters<typeof original>) => {
  clampCalls++; return mode.startsWith('historical') ? Historical.clampBoneToRom(...args) : original(...args);
} });
Object.defineProperty(Clamp, 'inspectClinicalAngles', { configurable: true, value: (...args: Parameters<typeof currentInspect>) => mode === 'historical-clamp-and-inspection' ? Historical.inspectClinicalAngles(...args) : currentInspect(...args) });
Object.defineProperty(Hand, 'solveHandContactPose', { configurable: true, value: (...args: Parameters<typeof handOriginal>) => { handCalls++; return handOriginal(...args); } });
Clamp.setRomClampEnabled(true); Historical.setRomClampEnabled(true);
const cases: any[] = [];
try {
  for (const variant of ['male', 'female'] as const) {
    const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    let skin!: THREE.SkinnedMesh; root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
    const bones = buildBoneByPoseKey(skin.skeleton, cfg), rest = captureJointAngleRestReference(skin.skeleton, cfg);
    const baseline = serializeCustomPose(skin.skeleton, cfg, variant);
    for (const side of ['L', 'R'] as const) for (const targetName of ['lower-back', 'cross-body'] as const) for (const candidate of ['current', 'historical-clamp-only', 'historical-clamp-and-inspection']) {
      mode = 'current'; applyCustomPose(skin.skeleton, cfg, baseline); root.updateMatrixWorld(true);
      mode = candidate; clampCalls = 0; handCalls = 0;
      const hand = bones.get(`${side}_Hand`)!, full = buildIKChainContext(skin, hand, 3, cfg)!, distal = buildIKChainContext(skin, hand, 2, cfg)!;
      const xyz = targetName === 'lower-back' ? [.075, 1.44, -.145] : [.13, 1.58, .02];
      const target = new THREE.Vector3(xyz[0]! * (side === 'L' ? -1 : 1), xyz[1], xyz[2]);
      solveArmChainWithRhythm(full, distal, target, { rest, recoverStalledReach: targetName === 'cross-body' });
      root.updateMatrixWorld(true);
      const reports = ['Shoulder', 'UpperArm', 'Forearm'].map(segment => {
        const key = `${side}_${segment}`, report = currentInspect(bones.get(key)!, key, rest)!;
        const violations = (['flexion', 'abduction', 'rotation'] as const).flatMap(axis => {
          const value = axis === 'flexion' ? report.anatomicFlexion : axis === 'rotation' ? report.anatomicRotation : report.raw.abduction;
          const range = report.ranges[axis]; return range && (value < range.min - .5 || value > range.max + .5) ? [{ axis, value, range }] : [];
        }); return { key, report, violations };
      });
      cases.push({ variant, side, targetName, mode, assetSha256: hash(bytes), wristErrorM: hand.getWorldPosition(new THREE.Vector3()).distanceTo(target), reports, genericClampCalls: clampCalls, floorHandSolverCalls: handCalls });
    }
  }
} finally { Object.defineProperty(Clamp, 'clampBoneToRom', descriptor); Object.defineProperty(Clamp, 'inspectClinicalAngles', inspectDescriptor); Object.defineProperty(Hand, 'solveHandContactPose', handDescriptor); }
const sourceAfter = sourceHashes();
const report = { scope: 'Counterfactual attribution only: current identical actual assets/solver versus HEAD generic clamp. Historical poses are evaluated by current clinical readout and are not candidates for promotion.', sourceBefore, sourceAfter,
  sourceStable: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), scriptSha256: hash(readFileSync(new URL(import.meta.url))), historicalClampSha256: hash(readFileSync(new URL('./captured-head-generic-rom-clamp.ts', import.meta.url))), cases };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(cases.map(value => ({ variant: value.variant, side: value.side, target: value.targetName, mode: value.mode, wristErrorM: value.wristErrorM, violations: value.reports.flatMap((report: any) => report.violations.map((violation: any) => ({ key: report.key, ...violation }))), floorHandSolverCalls: value.floorHandSolverCalls }))));
