/** Export exact saved all-bone locals from isolated proposal and corrected-floor
 * baseline. Never reruns a motion or solver. Uses the existing Blender workflow.
 * vite-node THIS <dense-proposal.json> <dense-baseline.json> <fresh-folder>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { buildBoneByPoseKey } from '../../src/services/poseRig';

if (!globalThis.FileReader) Object.defineProperty(globalThis, 'FileReader', { value: class {
  result: ArrayBuffer | string | null = null; onloadend?: () => void;
  readAsArrayBuffer(blob: Blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob: Blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
} });
const [proposalPath, baselinePath, outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Dense proposal, baseline and fresh folder required');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const proposalBytes = readFileSync(proposalPath), baselineBytes = readFileSync(baselinePath), proposal = JSON.parse(proposalBytes.toString()), baseline = JSON.parse(baselineBytes.toString());
if (!proposal.sourceStable || !baseline.sourceStable) throw Error('Unstable retained source');
const output = resolve(outputPath); mkdirSync(output);
const sourceIdentity = () => Object.fromEntries(Object.keys(proposal.sourceBefore).map(name => [name, sha(readFileSync(new URL('../../src/services/' + name + '.ts', import.meta.url)))]));
const before = sourceIdentity();
if (JSON.stringify(before) !== JSON.stringify(proposal.sourceBefore)) throw Error('Runtime differs from retained candidate identity');
const manifest: any = { version: 1, sourceDigest: sha(proposalBytes), sourceRevision: 'retained isolated candidate', fps: 30,
  proposalPath, proposalSha256: sha(proposalBytes), baselinePath, baselineSha256: sha(baselineBytes), sourceControllerHashes: before,
  exporterSha256: sha(readFileSync(new URL(import.meta.url))),
  romClamp: { requested: 'off', effective: false, environment: 'node', scope: 'Saved recording; bounded contact projection remains intact.' },
  axes: 'glTF X left,Y up,Z anterior; metres', deformation: 'Saved all101 bone locals contain render helper twist; no overlay or solver rerun.',
  scope: 'Exact source-matched retained candidate plus earlier corrected-floor reference for editable Blender authoring and full-body comparison. No native or clinical acceptance.', cases: [] };
for (const [label, report] of [['proposal', proposal], ['reference', baseline]] as const) for (const entry of report.cases) {
  if (label === 'proposal' && entry.mode !== 'initial-mirror-refine-only') continue;
  if (entry.frames.length !== 169) throw Error('Dense chapter required');
  const cfg = BODY_VARIANTS[entry.variant as keyof typeof BODY_VARIANTS], bytes = readFileSync(new URL(`../../models/painmap3D_${entry.variant}.runtime.glb`, import.meta.url));
  if (sha(bytes) !== entry.assetSha256) throw Error('Retained model identity differs');
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.name = 'ENGINE_ModelRoot'; root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const rootRestP = root.position.clone(), rootRestQ = root.quaternion.clone();
  const skins: THREE.SkinnedMesh[] = []; root.traverse(object => {
    if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).material = new THREE.MeshStandardMaterial({ color: 0xd9e1e4, roughness: .8 });
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skins.push(object as THREE.SkinnedMesh);
  });
  const skeleton = skins[0]!.skeleton, bones = buildBoneByPoseKey(skeleton, cfg), animated = [root, ...skeleton.bones];
  if (skeleton.bones.length !== 101) throw Error('Whole rig required');
  const values = new Map(animated.map(node => [node, { p: [] as number[], q: [] as number[] }])), expected: any[] = [];
  const checkpoints = new Set([0, 30, 52, 75, 123, 145, 168]); let maxCanonicalReplayErrorM = 0;
  for (const [ordinal, frame] of entry.frames.entries()) {
    root.position.copy(rootRestP).add(new THREE.Vector3().fromArray(frame.root.translateM)); root.quaternion.copy(rootRestQ).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
    const locals = frame.localQuats ?? frame.locals;
    for (const bone of skeleton.bones) { if (!locals[bone.name]) throw Error('Missing saved bone ' + bone.name); bone.quaternion.fromArray(locals[bone.name]); }
    root.updateMatrixWorld(true);
    const positions = frame.bones ?? frame.positions;
    for (const [key, bone] of bones) maxCanonicalReplayErrorM = Math.max(maxCanonicalReplayErrorM, bone.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(positions[key])));
    for (const node of animated) { values.get(node)!.p.push(...node.position.toArray()); values.get(node)!.q.push(...node.quaternion.toArray()); }
    if (checkpoints.has(ordinal)) {
      const points: number[][] = [], point = new THREE.Vector3();
      for (const mesh of skins) { mesh.skeleton.update(); const count = mesh.geometry.getAttribute('position').count;
        for (let index = 0; index < count; index += Math.max(1, Math.floor(count / 256))) points.push(mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld).toArray());
      }
      expected.push({ timeSec: frame.tMs / 1000, frame: ordinal + 1, bones: Object.fromEntries(skeleton.bones.map(bone => [bone.name, bone.getWorldPosition(new THREE.Vector3()).toArray()])), skinPointsM: points });
    }
  }
  if (maxCanonicalReplayErrorM > 1e-9) throw Error('Recorded world replay mismatch: ' + maxCanonicalReplayErrorM);
  const id = `${entry.variant}-trunk-bilateral-${label}`, times = entry.frames.map((frame: any) => frame.tMs / 1000), durationMs = entry.frames.at(-1).tMs;
  const clip = new THREE.AnimationClip('ENGINE_' + id, durationMs / 1000, animated.flatMap(node => [
    new THREE.VectorKeyframeTrack(node.name + '.position', times, values.get(node)!.p), new THREE.QuaternionKeyframeTrack(node.name + '.quaternion', times, values.get(node)!.q) ]));
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations: [clip], onlyVisible: false }) as ArrayBuffer;
  const row = { id, variant: entry.variant, side: 'both', movement: 'trunk-stability-push-up', treatment: label, file: id + '.glb',
    sourceModelSha256: sha(bytes), glbSha256: sha(new Uint8Array(glb)), frames: entry.frames.length, durationMs, floorY: 0, supportPlaneY: 0,
    setupFrame: 0, holdFrame: 76, maxCanonicalReplayErrorM, boneCount: 101, expected };
  writeFileSync(resolve(output, row.file), Buffer.from(glb), { flag: 'wx' });
  writeFileSync(resolve(output, id + '.expected.json'), JSON.stringify(row) + '\n', { flag: 'wx' });
  manifest.cases.push({ ...row, expected: id + '.expected.json' }); console.log(JSON.stringify({ id, maxCanonicalReplayErrorM, frames: row.frames }));
}
manifest.sourceStable = JSON.stringify(before) === JSON.stringify(sourceIdentity());
if (!manifest.sourceStable) throw Error('Source changed during export');
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
