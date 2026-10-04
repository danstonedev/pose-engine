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
import * as Support from '../../src/services/proneSkinSupport';
import { createProneSkinSupport as instrumentedSupport } from './captured-prone-support-profile';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';

setRomClampEnabled(false);

const files = ['proneSkinSupport', 'footContact', 'handContactPose', 'motionTrajectory', 'posedGeometry', 'motionRigInputKey', 'motionRecording'];
const identity = () => Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url))).digest('hex')]));
const report: any = { before: identity(), poseModeClampEnabled: false, scope: 'Diagnostic copied helper instrumentation; browser/test pose-mode clamp switch disabled; contact solver still forces clinical/patient projection. Process-local exact-delegating factory/solve timing; no production source changes or cache decisions changed.', runs: [] };
const descriptor = Object.getOwnPropertyDescriptor(Support, 'createProneSkinSupport')!;
if (!descriptor.configurable) throw Error('ViteNode export instrumentation unavailable');
const original = Support.createProneSkinSupport;
let current: any;
Object.defineProperty(Support, 'createProneSkinSupport', { configurable: true, value: (...args: Parameters<typeof original>) => {
  const start = performance.now(), helper = instrumentedSupport(...args), factory = { initializationMs: performance.now() - start, calls: [] as any[] };
  current.factories.push(factory);
  return { ...helper, solve: (...input: Parameters<typeof helper.solve>) => {
    const stack = new Error().stack ?? '';
    const path = stack.includes('poseReachFrameAt') ? 'guide-prepass' : stack.includes('sampleAt') ? 'playback' : 'other';
    const nested: any = {}; (globalThis as any).__proneCost=nested; const start = performance.now(), result = helper.solve(...input); (globalThis as any).__proneCost=null;
    factory.calls.push({ path, ms: performance.now() - start, reused: result.reusedSolution, iterations: result.iterations, nested });
    return result;
  } };
} });
try {
  const cfg = BODY_VARIANTS.male, bytes = readFileSync(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
  const baselinePose = serializeCustomPose(skinned.skeleton, cfg, 'male'), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const p = root.position.clone(), q = root.quaternion.clone();
  const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } }, L_Forearm: { elbowFlexion: { availableRange: { min: 110, max: 125 } } }, R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
  for (const label of ['default', 'patient', 'patient-repeat']) {
    root.position.copy(p); root.quaternion.copy(q); applyCustomPose(skinned.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
    current = { label, factories: [] };
    const costs = (globalThis as any).__palmCosts = {}, start = performance.now();
    const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
      baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 30, ...(label === 'default' ? {} : { constraints }),
    });
    current.elapsedMs = performance.now() - start; current.frames = recording.frames.length; current.costs = costs;
    current.rawFactories = current.factories;
    current.factories = current.factories.map((factory: any) => ({ initializationMs: factory.initializationMs,
      paths: Object.fromEntries(['guide-prepass', 'playback', 'other'].map(path => {
        const selected = factory.calls.filter((row: any) => row.path === path);
        return [path, { calls: selected.length, totalMs: selected.reduce((sum: number, row: any) => sum + row.ms, 0),
          cachedCalls: selected.filter((row: any) => row.reused).length, iterations: selected.reduce((sum: number, row: any) => sum + row.iterations, 0),
          cachedMs: selected.filter((row: any) => row.reused).reduce((sum: number, row: any) => sum + row.ms, 0) }];
      })) }));
    report.runs.push(current); const {rawFactories,...summary}=current;console.log(JSON.stringify(summary));
  }
} finally { Object.defineProperty(Support, 'createProneSkinSupport', descriptor); }
report.after = identity(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
