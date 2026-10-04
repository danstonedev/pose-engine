import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import * as Support from '../../src/services/proneSkinSupport';
import * as Contact from '../../src/services/footContact';
import * as Hand from '../../src/services/handContactPose';
import * as Layout from '../../src/services/pressupPalmLayout';

// Exact delegating wrappers in this ViteNode process only. Inclusive timings
// are labelled and must not be summed across nested scopes. No source copies,
// solver configuration, cache decisions, or production files are changed.
setRomClampEnabled(false);
const src = new URL('../../src/', import.meta.url);
const identity = () => Object.fromEntries(readdirSync(src, { recursive: true }).map(String)
  .filter(name => !name.includes('__tests__') && /\.(?:[cm]?ts|svelte|[cm]?js)$/.test(name)).sort()
  .map(name => [name.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(new URL(name.replaceAll('\\', '/'), src))).digest('hex')]));
const report: any = { before: identity(), globalRomClamp: false,
  scope: 'Unchanged original regression inputs: one default and two identical restrictive patient recordings at 30 Hz. Process-local inclusive timing; diagnostic overhead included. Original Vitest timeout is verified separately.',
  runs: [] };
let row: any, scope = 'playback';
const restorations: (() => void)[] = [];
function wrap(module: any, name: string, build: (original: any) => any) {
  const descriptor = Object.getOwnPropertyDescriptor(module, name)!;
  if (!descriptor.configurable) throw Error(`${name}: ViteNode instrumentation unavailable`);
  Object.defineProperty(module, name, { configurable: true, value: build(module[name]) });
  restorations.push(() => Object.defineProperty(module, name, descriptor));
}
function measure<T>(key: string, action: () => T): T {
  const start = performance.now();
  try { return action(); }
  finally { const bucket = row.costs[key] ??= { calls: 0, inclusiveMs: 0 }; bucket.calls++; bucket.inclusiveMs += performance.now() - start; }
}
wrap(Layout, 'preparePressupPalmLayout', original => (...args: any[]) => {
  const previous = scope; scope = 'layout';
  try { return measure('layout', () => original(...args)); } finally { scope = previous; }
});
wrap(Contact, 'preparePalmSupportApproach', original => (...args: any[]) => {
  const previous = scope; scope = `${previous}/guide`;
  try { return measure(scope, () => original(...args)); } finally { scope = previous; }
});
wrap(Hand, 'solveHandContactPose', original => (...args: any[]) => {
  const key = `${scope}/hand`, result = measure(key, () => original(...args)), bucket = row.costs[key];
  for (let part = result; part; part = part.refinement) {
    bucket.iterations = (bucket.iterations ?? 0) + part.iterations;
    const stops = bucket.stops ??= {}; stops[part.stopReason] = (stops[part.stopReason] ?? 0) + 1;
  }
  return result;
});
wrap(Support, 'createProneSkinSupport', original => (...args: any[]) => {
  const helper = measure(`${scope}/lower-factory`, () => original(...args));
  return { ...helper, solve: (...input: any[]) => {
    const result: any = measure(`${scope}/lower-solve`, () => helper.solve(...input));
    const bucket = row.costs[`${scope}/lower-solve`];
    bucket.reused = (bucket.reused ?? 0) + Number(result.reusedSolution);
    bucket.iterations = (bucket.iterations ?? 0) + result.iterations;
    return result;
  } };
});
try {
  const variant = (process.argv[3] ?? 'male') as keyof typeof BODY_VARIANTS, cfg = BODY_VARIANTS[variant];
  const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  report.variant = variant; report.modelSha256 = createHash('sha256').update(bytes).digest('hex');
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
  const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const p = root.position.clone(), q = root.quaternion.clone();
  const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } }, L_Forearm: { elbowFlexion: { availableRange: { min: 110, max: 125 } } }, R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
  for (const label of ['default', 'patient', 'patient-repeat']) {
    root.position.copy(p); root.quaternion.copy(q); applyCustomPose(skinned.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
    row = { label, costs: {} }; scope = 'playback'; const start = performance.now();
    const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
      baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 30,
      ...(label === 'default' ? {} : { constraints }),
    });
    row.elapsedMs = performance.now() - start; row.frames = recording.frames.length;
    report.runs.push(row); console.log(JSON.stringify(row));
  }
} finally { for (const restore of restorations.reverse()) restore(); }
report.after = identity(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
