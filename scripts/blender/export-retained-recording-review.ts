/** Reuse an immutable dense native-source capture for the existing Blender workflow.
 * vite-node scripts/blender/export-retained-recording-review.ts <dense-manifest> <fresh-folder>
 * This replays recorded locals, including baked twist. It never reruns a solver.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

if (!globalThis.FileReader) Object.defineProperty(globalThis, 'FileReader', { value: class {
  result: ArrayBuffer | string | null = null;
  onloadend?: () => void;
  readAsArrayBuffer(blob: Blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob: Blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
} });
const [manifestArg, outputArg] = process.argv.slice(2);
if (!manifestArg || !outputArg) throw Error('Provide a retained dense manifest and fresh output folder');
const manifestPath = resolve(manifestArg), output = resolve(outputArg), input = dirname(manifestPath);
const bytes = readFileSync(manifestPath), captured = JSON.parse(bytes.toString());
if (!captured.stableSources || captured.romClamp?.effective !== false) throw Error('Expected a stable-source ROM-off capture');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const repository = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(output);
const manifest: any = { version: 1, sourceRevision: captured.sourceRevision, sourceDigest: hash(bytes),
  capturedManifest: { path: manifestPath, sha256: hash(bytes) }, exporterSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  scope: 'Immutable development recording replay for visual review; no movement, clinical or native acceptance.',
  sourceScope: captured.scope, fps: captured.sourceHz, romClamp: captured.romClamp,
  deformation: 'All recorded bone locals already include production twist; no overlay reapplied.', cases: [] };
for (const entry of captured.cases) {
  const recordingBytes = readFileSync(resolve(input, entry.denseFile));
  if (hash(recordingBytes) !== entry.denseSha256) throw Error('Retained recording identity changed');
  const recording = JSON.parse(recordingBytes.toString());
  const modelPath = `models/painmap3D_${entry.variant}.runtime.glb`, modelBytes = readFileSync(resolve(repository, modelPath));
  if (hash(modelBytes) !== captured.sourceHashesBefore[modelPath]) throw Error('Production model differs from captured model');
  const { scene: root } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
    modelBytes.buffer.slice(modelBytes.byteOffset, modelBytes.byteOffset + modelBytes.byteLength), '');
  root.name = 'ENGINE_ModelRoot';
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse(object => {
    if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).material = new THREE.MeshStandardMaterial({ color: 0xd9e1e4, roughness: .8 });
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh);
  });
  if (!meshes.length) throw Error('No production skin');
  const bones = [...new Set(meshes.flatMap(mesh => mesh.skeleton.bones))];
  if (bones.length !== entry.bones) throw Error('Captured skeleton inventory differs');
  const animated = [root, ...bones], tracks = new Map(animated.map(node => [node, { q: [] as number[], p: [] as number[], s: [] as number[] }]));
  const checkpointMs = [0, 500, 1000, 1750, 2500, 4100, 4700, 5400];
  const indices = new Set(checkpointMs.filter(t => t <= recording.durationMs).map(t => recording.frames.reduce(
    (best: number, f: any, i: number) => Math.abs(f.tMs - t) < Math.abs(recording.frames[best].tMs - t) ? i : best, 0)));
  const expected: any[] = [];
  let maxBoneErrorM = 0, maxQuaternionComponentError = 0;
  for (const [index, frame] of recording.frames.entries()) {
    root.position.fromArray(frame.root.position); root.quaternion.fromArray(frame.root.quaternion); root.scale.fromArray(frame.root.scale);
    for (const bone of bones) {
      const sample = frame.boneTransforms[bone.name];
      if (!sample) throw Error(`Missing recorded bone ${bone.name}`);
      bone.position.fromArray(sample.localPositionM); bone.quaternion.fromArray(sample.localQuaternionXYZW);
    }
    root.updateMatrixWorld(true);
    for (const bone of bones) {
      const sample = frame.boneTransforms[bone.name], p = bone.getWorldPosition(new THREE.Vector3());
      maxBoneErrorM = Math.max(maxBoneErrorM, p.distanceTo(new THREE.Vector3().fromArray(sample.positionM)));
      const q = bone.getWorldQuaternion(new THREE.Quaternion()).normalize().toArray(), ref = sample.quaternionXYZW;
      maxQuaternionComponentError = Math.max(maxQuaternionComponentError,
        Math.min(Math.max(...q.map((v, i) => Math.abs(v - ref[i]))), Math.max(...q.map((v, i) => Math.abs(v + ref[i])))));
    }
    for (const node of animated) {
      const values = tracks.get(node)!;
      values.q.push(...node.quaternion.toArray()); values.p.push(...node.position.toArray()); values.s.push(...node.scale.toArray());
    }
    if (indices.has(index)) {
      const points: number[][] = [];
      for (const mesh of meshes) {
        const positions = mesh.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i += Math.max(1, Math.floor(positions.count / 256))) {
          const p = new THREE.Vector3().fromBufferAttribute(positions, i);
          mesh.applyBoneTransform(i, p); points.push(p.applyMatrix4(mesh.matrixWorld).toArray());
        }
      }
      expected.push({ timeSec: frame.tMs / 1000, frame: index + 1,
        bones: Object.fromEntries(bones.map(b => [b.name, b.getWorldPosition(new THREE.Vector3()).toArray()])), skinPointsM: points });
    }
  }
  if (maxBoneErrorM > 1e-9 || maxQuaternionComponentError > 1e-9) throw Error(`Recorded locals do not reconstruct worlds: ${maxBoneErrorM}, ${maxQuaternionComponentError}`);
  const times = recording.frames.map((f: any) => f.tMs / 1000), id = `${entry.variant}-retained-extension`;
  const animation = new THREE.AnimationClip(`ENGINE_${id}`, recording.durationMs / 1000, animated.flatMap(node => [
    new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, tracks.get(node)!.q),
    new THREE.VectorKeyframeTrack(`${node.name}.position`, times, tracks.get(node)!.p),
    new THREE.VectorKeyframeTrack(`${node.name}.scale`, times, tracks.get(node)!.s),
  ]));
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations: [animation], onlyVisible: false }) as ArrayBuffer;
  const file = `${id}.glb`, expectedFile = `${id}.expected.json`;
  writeFileSync(resolve(output, file), Buffer.from(glb), { flag: 'wx' });
  const setupMs = recording.boundaries.find((b: any) => b.kind === 'arrival' && b.index === 0).tMs;
  const peakMs = recording.boundaries.find((b: any) => b.kind === 'arrival' && b.index === 1).tMs;
  if (recording.authored.supportPlaneY == null) throw Error('Retained review requires an explicit source support plane');
  const row = { id, variant: entry.variant, side: 'R', movement: recording.movement, file, sourceModelSha256: hash(modelBytes),
    glbSha256: hash(new Uint8Array(glb)), frames: recording.frames.length, durationMs: recording.durationMs,
    floorY: recording.authored.supportPlaneY, supportPlaneY: recording.authored.supportPlaneY,
    setupFrame: Math.round(setupMs / 1000 * manifest.fps), holdFrame: 1 + Math.round(peakMs / 1000 * manifest.fps),
    boundaries: recording.boundaries, maxBoneErrorM, maxQuaternionComponentError, expected };
  writeFileSync(resolve(output, expectedFile), JSON.stringify(row) + '\n', { flag: 'wx' });
  manifest.cases.push({ ...row, expected: expectedFile, recordingSha256: entry.denseSha256 });
  console.log(JSON.stringify({ id, maxBoneErrorM, maxQuaternionComponentError, frames: row.frames }));
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
