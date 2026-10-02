/** Export production reach playback, including rendered twist, for Blender review.
 * npx vite-node scripts/blender/export-review.ts <new-output-directory>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS, type BodyVariantId } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { UPPER_ASSESSMENT_MOTIONS } from '../../src/services/assessmentUpperMotions';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { buildPushUp } from '../../src/services/movementPostures';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { sampleComposedMotion, authoredToTrajectoryTimeMap } from '../../src/services/motionRecording';
import { resolveComposedMotion, type ComposedMotion } from '../../src/services/motionSequence';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';

// GLTFExporter uses this browser API to package buffers; these review materials
// intentionally have no textures, so no browser canvas/image shim is needed.
if (!globalThis.FileReader) Object.defineProperty(globalThis, 'FileReader', { value: class {
  result: ArrayBuffer | string | null = null;
  onloadend?: () => void;
  readAsArrayBuffer(blob: Blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob: Blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
} });
const repository = fileURLToPath(new URL('../../', import.meta.url));
const output = process.argv[2] && resolve(process.argv[2]);
if (!output) throw Error('Provide a fresh output directory');
mkdirSync(output); // Never replace evidence from an earlier run.
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${repository.replaceAll('\\', '/').replace(/\/$/, '')}`, ...args], { cwd: repository, encoding: 'utf8' }).trim();
const sources = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', 'src', 'models', 'package-lock.json').split('\n').filter(Boolean))].sort();
const sourceDigest = () => hash(sources.map(path => `${path}:${hash(readFileSync(resolve(repository, path)))}`).join('\n'));
const digest = sourceDigest();
const manifest = { version: 1, sourceRevision: git('rev-parse', 'HEAD'), sourceStatus: git('status', '--porcelain'), sourceDigest: digest,
  exporterSha256: hash(readFileSync(fileURLToPath(import.meta.url))), fps: 30, axes: 'glTF: X left, Y up, Z anterior; metres',
  materialPolicy: 'Neutral review material; source geometry, skin weights and production assets are unchanged.',
  deformation: 'Production sampled poses with createStageTwistOverlay.sampleWithTwist baked into every helper track.',
  cases: [] as Record<string, unknown>[] };
const floorReview = process.argv[3] === 'floor';
const customMotion = process.argv[3]?.endsWith('.json') ? JSON.parse(readFileSync(resolve(process.argv[3]), 'utf8').replace(/^\uFEFF/, '')) as ComposedMotion : null;
const generalReview = floorReview || !!customMotion;
const cases = (['male', 'female', 'neutral'] as BodyVariantId[]).flatMap(variant => customMotion
  ? [{ variant, side: 'R' as const, movement: basename(process.argv[3], '.json') }]
  : floorReview
  ? ['push-up', 'trunk-stability-push-up', 'extension-clearing', 'flexion-clearing'].map(movement => ({ variant, side: 'R' as const, movement }))
  : (['L', 'R'] as const).map(side => ({ variant, side, movement: 'ue-pattern1' })));
for (const { variant, side, movement } of cases) {
  const id = generalReview ? `${variant}-${movement}` : `${variant}-${side}`;
  const cfg = BODY_VARIANTS[variant];
  const bytes = readFileSync(resolve(repository, `models/painmap3D_${variant}.runtime.glb`));
  const { scene: root } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  root.name = 'ENGINE_ModelRoot';
  root.scale.setScalar(cfg.pose.rootScale);
  applyAnatomicPose(root, cfg);
  root.updateMatrixWorld(true);
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.material = new THREE.MeshStandardMaterial({ color: 0xd9e1e4, roughness: 0.8 });
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh);
  });
  const skin = meshes[0];
  if (!skin) throw Error(`No skin for ${id}`);
  const skeleton = skin.skeleton;
  const rest = captureJointAngleRestReference(skeleton, cfg);
  const baselinePose = serializeCustomPose(skeleton, cfg, variant);
  const twist = createStageTwistOverlay(); twist.reset(skeleton, cfg);
  const authored = customMotion ?? (movement === 'push-up' ? buildPushUp({ reps: 1 }) : floorReview ? BODY_ASSESSMENT_MOTIONS[movement](side) : UPPER_ASSESSMENT_MOTIONS['ue-pattern1'](side));
  const motion = resolveComposedMotion(authored, cfg);
  const recording = sampleComposedMotion(motion, { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned: skin }, sampleHz: manifest.fps });
  const durationMs = recording.frames.at(-1)!.tMs;
  const map = authoredToTrajectoryTimeMap(motion, durationMs);
  const setupMs = map.toTrajectory(motion.keyframes[0].durationMs);
  const checkpoints = generalReview ? [0, setupMs, setupMs + (durationMs - setupMs) / 4, setupMs + (durationMs - setupMs) / 2, durationMs]
    : [0, 1600, 2200, 3400, 4100, 5400, 6800, 7500].map(t => map.toTrajectory(t));
  const indices = new Set(checkpoints.map(t => recording.frames.reduce((best, f, i) => Math.abs(f.tMs - t) < Math.abs(recording.frames[best].tMs - t) ? i : best, 0)));
  const animated = [root, ...skeleton.bones];
  const values = new Map(animated.map(node => [node, { q: [] as number[], p: [] as number[] }]));
  const expected: { timeSec: number; frame: number; bones: Record<string, number[]>; skinPointsM: number[][] }[] = [];
  for (let frameIndex = 0; frameIndex < recording.frames.length; frameIndex++) {
    const frame = recording.frames[frameIndex];
    root.position.fromArray(frame.root.translateM); root.quaternion.fromArray(frame.root.orientQuat);
    applyCustomPose(skeleton, cfg, frame.pose);
    twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true);
      for (const node of animated) { values.get(node)!.q.push(...node.quaternion.toArray()); values.get(node)!.p.push(...node.position.toArray()); }
      if (indices.has(frameIndex)) {
        const points: number[][] = [];
        for (const mesh of meshes) {
          const position = mesh.geometry.getAttribute('position');
          for (let index = 0; index < position.count; index += Math.max(1, Math.floor(position.count / 256))) {
            const p = new THREE.Vector3().fromBufferAttribute(position, index);
            mesh.applyBoneTransform(index, p); p.applyMatrix4(mesh.matrixWorld); points.push(p.toArray());
          }
        }
        expected.push({ timeSec: frame.tMs / 1000, frame: 1 + frameIndex,
          bones: Object.fromEntries(skeleton.bones.map(b => [b.name, b.getWorldPosition(new THREE.Vector3()).toArray()])), skinPointsM: points });
      }
    });
  }
  const times = recording.frames.map(f => f.tMs / 1000);
  const tracks = animated.flatMap(node => [new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values.get(node)!.q), new THREE.VectorKeyframeTrack(`${node.name}.position`, times, values.get(node)!.p)]);
  const clip = new THREE.AnimationClip(`ENGINE_${id}`, durationMs / 1000, tracks);
  root.position.set(0, 0, 0); root.quaternion.identity(); applyCustomPose(skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations: [clip], onlyVisible: false }) as ArrayBuffer;
  writeFileSync(resolve(output, `${id}.glb`), Buffer.from(glb), { flag: 'wx' });
  const record = { id, variant, side, movement, file: `${id}.glb`, sourceModelSha256: hash(bytes), glbSha256: hash(new Uint8Array(glb)),
    frames: recording.frames.length, durationMs, setupFrame: Math.round(setupMs / 1000 * manifest.fps),
    holdFrame: 1 + Math.round((generalReview ? setupMs + (durationMs - setupMs) / 2 : map.toTrajectory(4100)) / 1000 * manifest.fps), expected };
  writeFileSync(resolve(output, `${id}.expected.json`), JSON.stringify(record), { flag: 'wx' });
  manifest.cases.push({ ...record, expected: `${id}.expected.json` });
  console.log(`${id}: ${record.frames} frames, ${expected.length} surface/bone checkpoints`);
}
if (digest !== sourceDigest()) throw Error('Source changed during export');
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
