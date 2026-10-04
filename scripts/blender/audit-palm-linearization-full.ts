/** Every invoked hand solve in complete actual-rig recordings, byte comparison. */
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
import * as Hand from '../../src/services/handContactPose';
import { solveHandContactPose as candidate, linearizationReuseStatistics } from './captured-palm-linearization-reuse';

setRomClampEnabled(false);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const src = new URL('../../src/', import.meta.url);
const identity = () => Object.fromEntries(readdirSync(src, { recursive: true }).map(String)
  .filter(name => !name.includes('__tests__') && /\.(?:[cm]?ts|svelte|[cm]?js)$/.test(name)).sort()
  .map(name => [name.replaceAll('\\', '/'), hash(readFileSync(new URL(name.replaceAll('\\', '/'), src)))]));
const output = process.argv[2];
if (!output) throw Error('Fresh output path required');
const report: any = { before: identity(), scriptSha256: hash(readFileSync(new URL(import.meta.url))),
  candidateSha256: hash(readFileSync(new URL('./captured-palm-linearization-reuse.ts', import.meta.url))),
  scope: 'Every actually invoked hand solve in default and restrictive complete30Hz recordings on all three actual rigs. Candidate differs only by retaining an identical exact-quaternion linearization within one guarded solve across rejected steps. Every physical input is constant for that invocation; damping alone changes. All101 local/world and solver results compare exactly. Original output restored after each pair. Diagnostic timing only, not original performance gate.',
  runs: [], failures: [] };
const original = Hand.solveHandContactPose;
const descriptor = Object.getOwnPropertyDescriptor(Hand, 'solveHandContactPose')!;
if (!descriptor.configurable) throw Error('ViteNode exact-delegating wrapper unavailable');
let current: any, skin: THREE.SkinnedMesh;
const state = () => ({ locals: skin.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]),
  worlds: skin.skeleton.bones.map(bone => bone.matrixWorld.toArray()) });
Object.defineProperty(Hand, 'solveHandContactPose', { configurable: true, value: (...args: Parameters<typeof original>) => {
  const bones = args[0].ctx.bones, before = bones.map(bone => bone.quaternion.clone());
  const restore = () => { bones.forEach((bone, i) => bone.quaternion.copy(before[i]!)); bones.at(-1)!.updateWorldMatrix(true, true); };
  let a: ReturnType<typeof state>, b: ReturnType<typeof state>, ar: ReturnType<typeof original>, br: ReturnType<typeof original>;
  let originalMs = 0, candidateMs = 0;
  const first = () => { const start = performance.now(); ar = original(...args); originalMs = performance.now() - start; a = state(); };
  const second = () => { const start = performance.now(); br = candidate(...args); candidateMs = performance.now() - start; b = state(); };
  if (current.calls % 2) { second(); restore(); first(); }
  else { first(); restore(); second(); }
  const sameLocals = JSON.stringify(a!.locals) === JSON.stringify(b!.locals);
  const sameWorlds = JSON.stringify(a!.worlds) === JSON.stringify(b!.worlds);
  const sameResult = JSON.stringify(ar!) === JSON.stringify(br!);
  const row = { call: current.calls++, hand: args[0].footKey, sameLocals, sameWorlds, sameResult, originalMs, candidateMs };
  current.originalMs += originalMs; current.candidateMs += candidateMs;
  current.resultDigest.update(JSON.stringify([ar!, a!]));
  if (!sameLocals || !sameWorlds || !sameResult) {
    report.failures.push({ variant: current.variant, mode: current.mode, ...row, original: a!, candidate: b!, originalResult: ar!, candidateResult: br! });
    throw Error('Calculation graph changed a solver output');
  }
  // Both are byte equal; retain the full actual rig in its produced state.
  return ar!;
} });
try {
  for (const variant of ['male', 'female', 'neutral'] as const) {
    const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    let selected: THREE.SkinnedMesh | undefined;
    root.traverse(node => { if (!selected && (node as THREE.SkinnedMesh).isSkinnedMesh) selected = node as THREE.SkinnedMesh; });
    skin = selected!;
    const baselinePose = serializeCustomPose(skin.skeleton, cfg, variant), rest = captureJointAngleRestReference(skin.skeleton, cfg);
    const p = root.position.clone(), q = root.quaternion.clone();
    const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } }, L_Forearm: { elbowFlexion: { availableRange: { min: 110, max: 125 } } }, R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
    for (const mode of ['default', 'patient']) {
      root.position.copy(p); root.quaternion.copy(q); applyCustomPose(skin.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
      current = { variant, mode, modelSha256: hash(bytes), calls: 0, originalMs: 0, candidateMs: 0, resultDigest: createHash('sha256') };
      const start = performance.now();
      const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
        baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned: skin }, sampleHz: 30,
        ...(mode === 'patient' ? { constraints } : {}),
      });
      current.elapsedMs = performance.now() - start; current.frames = recording.frames.length;
      current.resultDigest = current.resultDigest.digest('hex');
      report.runs.push(current); console.log(JSON.stringify(current));
    }
  }
} catch (error) {
  report.error = String(error); process.exitCode = 1;
} finally {
  Object.defineProperty(Hand, 'solveHandContactPose', descriptor);
  report.linearizationReuseStatistics = linearizationReuseStatistics;
  report.after = identity(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
  report.passed = report.sourceStable && !report.error && report.runs.length === 6 && report.failures.length === 0;
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ sourceStable: report.sourceStable, passed: report.passed, failures: report.failures.length, error: report.error }));
  if (!report.passed) process.exitCode = 1;
}
