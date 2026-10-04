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
import * as Geometry from '../../src/services/posedGeometry';
import { createPosedVertexReader as candidate } from './captured-posedGeometry-bind-input';

setRomClampEnabled(false);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const src = new URL('../../src/', import.meta.url);
const identity = () => Object.fromEntries(readdirSync(src, { recursive: true }).map(String)
  .filter(name => !name.includes('__tests__') && /\.(?:[cm]?ts|svelte|[cm]?js)$/.test(name)).sort()
  .map(name => [name.replaceAll('\\', '/'), hash(readFileSync(new URL(name.replaceAll('\\', '/'), src)))]));
const report: any = { before: identity(), scriptSha256: hash(readFileSync(new URL(import.meta.url))),
  candidateSha256: hash(readFileSync(new URL('./captured-posedGeometry-bind-input.ts', import.meta.url))),
  scope: 'Offline exact paired original/candidate vertex measurements in full 30Hz default and restricted actual-body recordings. Original vertex always returned. Per-call timings include instrumentation and are diagnostic, not unchanged performance gate.', runs: [] };
const descriptor = Object.getOwnPropertyDescriptor(Geometry, 'createPosedVertexReader')!;
const original = Geometry.createPosedVertexReader;
let current: any;
Object.defineProperty(Geometry, 'createPosedVertexReader', { configurable: true, value: () => {
  const a = original(), b = candidate(), av = new THREE.Vector3(), bv = new THREE.Vector3();
  return { beginMeasurement() { a.beginMeasurement(); b.beginMeasurement(); },
    getVertexPosition(mesh: THREE.SkinnedMesh, index: number, target: THREE.Vector3) {
      let t = performance.now(); a.getVertexPosition(mesh, index, av); current.originalMs += performance.now() - t;
      t = performance.now(); b.getVertexPosition(mesh, index, bv); current.candidateMs += performance.now() - t;
      current.calls++;
      if (!av.equals(bv)) throw Error(`Vertex mismatch ${mesh.name}/${index}: ${av.toArray()} versus ${bv.toArray()}`);
      return target.copy(av);
    } };
} });
try {
  for (const variant of ['male', 'female', 'neutral'] as const) {
    const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
    const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    const p = root.position.clone(), q = root.quaternion.clone();
    const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } }, L_Forearm: { elbowFlexion: { availableRange: { min: 110, max: 125 } } }, R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
    for (const mode of ['default', 'patient']) {
      root.position.copy(p); root.quaternion.copy(q); applyCustomPose(skinned.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
      current = { variant, mode, modelSha256: hash(bytes), calls: 0, originalMs: 0, candidateMs: 0 };
      const t = performance.now();
      const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
        baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 30, ...(mode === 'patient' ? { constraints } : {}) });
      current.elapsedMs = performance.now() - t; current.frames = recording.frames.length;
      current.recordingSha256 = hash(JSON.stringify(recording)); report.runs.push(current); console.log(JSON.stringify(current));
    }
  }
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  Object.defineProperty(Geometry, 'createPosedVertexReader', descriptor);
  report.after = identity(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
  report.passed = report.sourceStable && !report.error && report.runs.length === 6;
  writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, sourceStable: report.sourceStable, error: report.error }));
}
