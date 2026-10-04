/** Export selected, already measured bounded source poses for editable Blender review.
 * vite-node .../export-sparse-pressup-probe.ts <probe-folder> <selection.json> <fresh-output>
 * Selection [{variant,file}] names result JSON files, not source recipes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';
if (!globalThis.FileReader) Object.defineProperty(globalThis, 'FileReader', { value: class {
  result: ArrayBuffer | string | null = null; onloadend?: () => void;
  readAsArrayBuffer(blob: Blob) { blob.arrayBuffer().then(v => { this.result = v; this.onloadend?.(); }); }
  readAsDataURL(blob: Blob) { blob.arrayBuffer().then(v => { this.result = `data:${blob.type};base64,${Buffer.from(v).toString('base64')}`; this.onloadend?.(); }); }
} });
const [probeArg, selectionArg, outputArg] = process.argv.slice(2);
if (!probeArg || !selectionArg || !outputArg) throw Error('Provide probe, selection and fresh output');
const probe = resolve(probeArg), output = resolve(outputArg), engine = fileURLToPath(new URL('../../', import.meta.url)); mkdirSync(output);
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const hash = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const selection = read(resolve(selectionArg));
const manifest: any = { version: 1, sourceRevision: 'exploratory-sparse-proposal',
  sourceDigest: hash(selection.map((s: any) => hash(readFileSync(resolve(probe, s.file)))).join('\n')),
  exporterSha256: hash(readFileSync(fileURLToPath(import.meta.url))), fps: 60,
  axes: 'glTF X left,Y up,Z anterior; metres', sparseOnly: true,
  scope: 'Only the five recorded source times are authoritative. In-between animation is interpolation for authoring, not production whole-motion evidence. Source control changes remain unpromoted.',
  cases: [] };
for (const selected of selection) {
  const entry = read(resolve(probe, selected.file)), variant = selected.variant as keyof typeof BODY_VARIANTS, cfg = BODY_VARIANTS[variant];
  const model = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  if (hash(model) !== entry.sourceModelSha256) throw Error('Asset identity mismatch');
  const parsed = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength), '');
  const root = parsed.scene; root.name = 'ENGINE_ModelRoot'; root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const skins: THREE.SkinnedMesh[] = [];
  root.traverse(o => { const mesh = o as THREE.Mesh; if (mesh.isMesh) mesh.material = new THREE.MeshStandardMaterial({color: 0xd9e1e4, roughness: .8}); if ((o as THREE.SkinnedMesh).isSkinnedMesh) skins.push(o as THREE.SkinnedMesh); });
  const skeleton = skins[0].skeleton, baseline = serializeCustomPose(skeleton, cfg, variant), animated = [root, ...skeleton.bones];
  const values = new Map(animated.map(node => [node, { q: [] as number[], p: [] as number[] }]));
  const twist = createStageTwistOverlay(); twist.reset(skeleton, cfg);
  const expected = [];
  for (const frame of entry.frames) {
    root.position.fromArray(frame.root.translateM); root.quaternion.fromArray(frame.root.orientQuat); applyCustomPose(skeleton, cfg, frame.pose);
    twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true);
      for (const node of animated) { values.get(node)!.q.push(...node.quaternion.toArray()); values.get(node)!.p.push(...node.position.toArray()); }
      const skinPointsM: number[][] = [];
      for (const mesh of skins) { const p = mesh.geometry.getAttribute('position'); for (let i = 0; i < p.count; i += Math.max(1, Math.floor(p.count / 256))) {
        const value = new THREE.Vector3().fromBufferAttribute(p, i); mesh.applyBoneTransform(i, value); value.applyMatrix4(mesh.matrixWorld); skinPointsM.push(value.toArray());
      } }
      expected.push({timeSec: frame.tMs / 1000, frame: 1 + frame.tMs * 60 / 1000, bones: Object.fromEntries(skeleton.bones.map(b => [b.name, b.getWorldPosition(new THREE.Vector3()).toArray()])), skinPointsM});
    });
  }
  const times = entry.frames.map((f: any) => f.tMs / 1000), durationMs = entry.frames.at(-1).tMs;
  const tracks = animated.flatMap(node => [new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values.get(node)!.q), new THREE.VectorKeyframeTrack(`${node.name}.position`, times, values.get(node)!.p)]);
  const id = `${variant}-bounded-whole-chain-sparse`;
  root.position.set(0, 0, 0); root.quaternion.identity(); applyCustomPose(skeleton, cfg, baseline); root.updateMatrixWorld(true);
  const glb = await new GLTFExporter().parseAsync(root, {binary: true, animations: [new THREE.AnimationClip(id, durationMs / 1000, tracks)], onlyVisible: false}) as ArrayBuffer;
  writeFileSync(resolve(output, id + '.glb'), Buffer.from(glb), {flag: 'wx'});
  const record = {id, variant, side: 'R', movement: 'bounded-whole-chain-sparse', file: id + '.glb', sourceModelSha256: hash(model), glbSha256: hash(new Uint8Array(glb)),
    sourceProbe: selected.file, sourceProbeSha256: hash(readFileSync(resolve(probe, selected.file))), parameters: entry.parameters,
    frames: 1 + Math.round(durationMs * 60 / 1000), sourceSampleCount: entry.frames.length, sourceSampleTimesMs: entry.frames.map((f: any) => f.tMs), durationMs,
    floorY: 0, supportPlaneY: 0, setupFrame: 60, holdFrame: 151, expected};
  writeFileSync(resolve(output, id + '.expected.json'), JSON.stringify(record), {flag: 'wx'});
  manifest.cases.push({...record, expected: id + '.expected.json'});
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
