/** Sparse current-source skin witnesses. This diagnostic never qualifies motion.
 * vite-node scripts/blender/audit-pressup-skin-regions.ts <fresh-report.json>
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { isRomClampActive, setRomClampEnabled } from '../../src/services/poseRomClamp';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';

const output = process.argv[2];
assert.ok(output, 'Provide a fresh report path');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const walk = (folder: string): string[] => readdirSync(resolve(repository, folder), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? (entry.name === '__tests__' ? [] : walk(`${folder}/${entry.name}`)) : [`${folder}/${entry.name}`]);
const hashes = () => Object.fromEntries([...walk('src'), ...walk('models')].sort().map(file => [file, sha(readFileSync(resolve(repository, file)))]));
setRomClampEnabled(false);
assert.equal(isRomClampActive(), false);
const report: any = {
  at: new Date().toISOString(), scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  scope: 'Sparse setup/ascent/hold/return actual visible skin, all three production rigs, shared sampler, global ROM clamp OFF and production twist. Largest skin-weight bone is a reporting label, not a region exclusion. No floor fitting, physics, contact acceptance or full-cycle qualification.',
  sourceHashesBefore: hashes(), globalRomClamp: false, cases: [],
};
for (const variant of ['male', 'female', 'neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], modelPath = `models/painmap3D_${variant}.runtime.glb`;
  const bytes = readFileSync(resolve(repository, modelPath));
  const { scene: root } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  root.scale.setScalar(cfg.pose.rootScale);
  applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(node as THREE.SkinnedMesh); });
  assert.ok(meshes.length);
  const skinned = meshes[0], skeleton = skinned.skeleton;
  const bones = [...new Set(meshes.flatMap(mesh => mesh.skeleton.bones))];
  const rest = captureJointAngleRestReference(skeleton, cfg);
  const baselinePose = serializeCustomPose(skeleton, cfg, variant);
  const twist = createStageTwistOverlay(); twist.reset(skeleton, cfg);
  const authored = BODY_ASSESSMENT_MOTIONS['extension-clearing']('R');
  const motion = resolveComposedMotion(authored, cfg);
  const floorY = motion.supportPlaneY;
  assert.ok(Number.isFinite(floorY), 'An explicit source support plane is required');
  const times = [0, 1000, 1600, 2500, 4100, 5400];
  const recording = sampleComposedMotion(motion, { baselinePose, variantCfg: cfg, rest,
    skeletonHarness: { root, skinned }, sampleHz: 60, frameTimesMs: times });
  assert.deepEqual(recording.frames.map(frame => frame.tMs), times);
  const owners = meshes.map(mesh => {
    const weights = mesh.geometry.getAttribute('skinWeight'), indices = mesh.geometry.getAttribute('skinIndex');
    return Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, index) => {
      let largest = 0;
      for (let component = 1; component < 4; component++) if (weights.getComponent(index, component) > weights.getComponent(index, largest)) largest = component;
      return mesh.skeleton.bones[indices.getComponent(index, largest)].name;
    });
  });
  const entry: any = { variant, modelPath, modelSha256: sha(bytes), boneCount: bones.length,
    meshes: meshes.map(mesh => ({ name: mesh.name, vertices: mesh.geometry.getAttribute('position').count })),
    floorY, authored, frames: [] };
  for (const frame of recording.frames) {
    root.position.fromArray(frame.root.translateM); root.quaternion.fromArray(frame.root.orientQuat);
    applyCustomPose(skeleton, cfg, frame.pose);
    twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true);
      for (const mesh of meshes) mesh.skeleton.update();
      const regions: Record<string, any> = {};
      let minimum: any = null;
      for (const [meshIndex, mesh] of meshes.entries()) for (let vertex = 0; vertex < owners[meshIndex].length; vertex++) {
        const position = mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
        const owner = owners[meshIndex][vertex], region = regions[owner] ??= { vertices: 0, belowFloor: 0, minimum: null };
        const witness = { meshIndex, meshName: mesh.name, vertex, owner, positionM: position.toArray(), clearanceM: position.y - floorY! };
        region.vertices++;
        if (witness.clearanceM < 0) region.belowFloor++;
        if (!region.minimum || witness.clearanceM < region.minimum.clearanceM) region.minimum = witness;
        if (!minimum || witness.clearanceM < minimum.clearanceM) minimum = witness;
      }
      entry.frames.push({ tMs: frame.tMs, minimum, regions, angles: frame.angles,
        proneSupport: frame.proneSupport, pronePalmLayout: frame.pronePalmLayout,
        root: { position: root.position.toArray(), quaternion: root.quaternion.toArray(), scale: root.scale.toArray() },
        boneTransforms: Object.fromEntries(bones.map(bone => [bone.name, {
          localPositionM: bone.position.toArray(), localQuaternionXYZW: bone.quaternion.toArray(),
          positionM: bone.getWorldPosition(new THREE.Vector3()).toArray(), quaternionXYZW: bone.getWorldQuaternion(new THREE.Quaternion()).normalize().toArray(),
        }])) });
    });
  }
  report.cases.push(entry);
  console.log(JSON.stringify({ variant, samples: entry.frames.map((frame: any) => ({ tMs: frame.tMs,
    minimum: frame.minimum, forearms: Object.entries(frame.regions).filter(([key]) => /[LR]_Forearm/.test(key)) })) }));
}
report.sourceHashesAfter = hashes();
report.stableSources = JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
assert.ok(report.stableSources, 'Source changed during diagnostic');
