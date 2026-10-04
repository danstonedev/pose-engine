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
import { createProneSkinSupport as candidateSupport } from './captured-prone-support-candidate';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';

setRomClampEnabled(false);

const files = ['proneSkinSupport', 'footContact', 'handContactPose', 'motionTrajectory', 'posedGeometry', 'motionRigInputKey', 'motionRecording'];
const identity = () => Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url))).digest('hex')]));
const report: any = { exactResultAndPoseEquality: true, before: identity(), poseModeClampEnabled: false, scope: 'Paired actual-rig production helper and isolated candidate; all returned values and all bone locals must be byte-identical on each invocation. Browser/test pose-mode clamp switch disabled; contact solver still forces clinical/patient projection. Process-local exact-delegating factory/solve timing; no production source changes or cache decisions changed.', runs: [] };
const descriptor = Object.getOwnPropertyDescriptor(Support, 'createProneSkinSupport')!;
if (!descriptor.configurable) throw Error('ViteNode export instrumentation unavailable');
const original = Support.createProneSkinSupport;
let current: any;
Object.defineProperty(Support, 'createProneSkinSupport', { configurable: true, value: (...args: Parameters<typeof original>) => {
  const start = performance.now(), helper = original(...args), candidate = candidateSupport(...args), factory = { initializationMs: performance.now() - start, calls: [] as any[] };
  current.factories.push(factory);
  return { ...helper, solve: (...input: Parameters<typeof helper.solve>) => {
    const stack = new Error().stack ?? '';
    const path = stack.includes('poseReachFrameAt') ? 'guide-prepass' : stack.includes('sampleAt') ? 'playback' : 'other';
    const snapshot=()=>args[0].skinned.skeleton.bones.map(b=>[...b.position.toArray(),...b.quaternion.toArray(),...b.scale.toArray()]);
    const restore=(pose:number[][])=>{args[0].skinned.skeleton.bones.forEach((b,i)=>{b.position.fromArray(pose[i]!);b.quaternion.fromArray(pose[i]!,3);b.scale.fromArray(pose[i]!,7);});args[0].root.updateMatrixWorld(true);};
    const before=snapshot(); const start = performance.now(), result = helper.solve(...input);const originalMs=performance.now()-start;const after=snapshot();restore(before);
    const candidateStart=performance.now(),candidateResult=candidate.solve(...input),candidateMs=performance.now()-candidateStart;
    const candidateAfter=snapshot();const resultEqual=JSON.stringify(result)===JSON.stringify(candidateResult),poseEqual=JSON.stringify(after)===JSON.stringify(candidateAfter);
    if(!resultEqual||!poseEqual)throw Error('Candidate changed exact helper output '+JSON.stringify({resultEqual,poseEqual,result,candidateResult}));
    factory.calls.push({ path, ms: originalMs, candidateMs, reused: result.reusedSolution, iterations: result.iterations });
    return result;
  } };
} });
try {
  for(const variant of ['male','female','neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
  const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const p = root.position.clone(), q = root.quaternion.clone();
  const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } }, L_Forearm: { elbowFlexion: { availableRange: { min: 110, max: 125 } } }, R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
  for (const label of ['default', 'patient', 'patient-repeat']) {
    root.position.copy(p); root.quaternion.copy(q); applyCustomPose(skinned.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
    current = { variant, label, factories: [] };
    const costs = (globalThis as any).__palmCosts = {}, start = performance.now();
    const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
      baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 30, ...(label === 'default' ? {} : { constraints }),
    });
    current.elapsedMs = performance.now() - start; current.frames = recording.frames.length; current.costs = costs;
    current.factories = current.factories.map((factory: any) => ({ initializationMs: factory.initializationMs,
      paths: Object.fromEntries(['guide-prepass', 'playback', 'other'].map(path => {
        const selected = factory.calls.filter((row: any) => row.path === path);
        return [path, { calls: selected.length, totalMs: selected.reduce((sum: number, row: any) => sum + row.ms, 0),
          cachedCalls: selected.filter((row: any) => row.reused).length, iterations: selected.reduce((sum: number, row: any) => sum + row.iterations, 0),
          candidateMs: selected.reduce((sum:number,row:any)=>sum+row.candidateMs,0),
          cachedMs: selected.filter((row: any) => row.reused).reduce((sum: number, row: any) => sum + row.ms, 0) }];
      })) }));
    report.runs.push(current); console.log(JSON.stringify(current));
  }
  }
} finally { Object.defineProperty(Support, 'createProneSkinSupport', descriptor); }
report.after = identity(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
