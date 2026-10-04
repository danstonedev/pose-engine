import { readFileSync, writeFileSync } from 'node:fs';
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
// Match floorPalmSupports.test.ts and the browser calibration context. Contact
// solves still explicitly enforce normative and current patient restrictions.
setRomClampEnabled(false);
const cfg = BODY_VARIANTS.male;
const bytes = readFileSync(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url));
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
const baselinePose = serializeCustomPose(skinned.skeleton, cfg, 'male'), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
const p = root.position.clone(), q = root.quaternion.clone();
const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } }, L_Forearm: { elbowFlexion: { availableRange: { min: 110, max: 125 } } }, R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
const report: any[] = [];
for (const label of ['default', 'patient', 'patient-repeat']) {
  root.position.copy(p); root.quaternion.copy(q); applyCustomPose(skinned.skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
  const costs = (globalThis as any).__palmCosts = {}, start = performance.now();
  const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
    baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 30, ...(label === 'default' ? {} : { constraints }) });
  const row = { label, globalRomClamp: false, elapsedMs: performance.now() - start, frames: recording.frames.length, costs };
  report.push(row); console.log(JSON.stringify(row));
}
writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
