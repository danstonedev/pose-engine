/** Retain the five bounded delivery definitions exactly as the catalogue samples them.
 * vite-node scripts/blender/export-catalogue-delivery-review.ts <fresh-folder> [30|60] [--plan]
 * The master must already contain the current live definitions. No acceptance is written.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS, type BodyVariantId } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { buildGetDownToPlank, buildPushUp, buildStandFromPlank } from '../../src/services/movementPostures';
import { movementScreenMotion, movementScreenPattern } from '../../src/services/movementScreen';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { sampleComposedMotion, authoredToTrajectoryTimeMap } from '../../src/services/motionRecording';
import { resolveComposedMotion, type ComposedMotion } from '../../src/services/motionSequence';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';
import { captureFloorReference, floorReferenceForSupport } from '../../src/services/rootMotion';
import { isRomClampActive, setRomClampEnabled } from '../../src/services/poseRomClamp';
import { readMaster, contextKey } from '../catalogue/gate.mjs';

if (!globalThis.FileReader) Object.defineProperty(globalThis, 'FileReader', { value: class {
  result: ArrayBuffer | string | null = null;
  onloadend?: () => void;
  readAsArrayBuffer(blob: Blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob: Blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
} });
const args = process.argv.slice(2), planOnly = args.includes('--plan');
if (planOnly) args.splice(args.indexOf('--plan'), 1);
const reuseIndex = args.indexOf('--reuse-unsequenced');
const reuseFolder = reuseIndex >= 0 ? resolve(args[reuseIndex + 1] ?? '') : null;
if (reuseIndex >= 0) args.splice(reuseIndex, 2);
const [outputArg, hzArg = '30'] = args, sampleHz = Number(hzArg);
if (!outputArg || args.length > 2 || ![30, 60].includes(sampleHz)) throw Error('Provide a fresh folder, 30 or 60 Hz, and optional --plan');
const repository = fileURLToPath(new URL('../../', import.meta.url)), output = resolve(outputArg);
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const git = (...params: string[]) => execFileSync('git', ['-c', `safe.directory=${repository.replaceAll('\\', '/').replace(/\/$/, '')}`, ...params], { cwd: repository, encoding: 'utf8' }).trim();
const sourcePaths = () => [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', 'src', 'models', 'package-lock.json').split('\n').filter(Boolean))].sort();
const sourceHashes = () => Object.fromEntries(sourcePaths().map(path => [path, hash(readFileSync(resolve(repository, path)))]));
const before = sourceHashes(), sourceDigest = hash(JSON.stringify(before));
const reuseManifest = reuseFolder ? JSON.parse(readFileSync(resolve(reuseFolder, 'manifest.json'), 'utf8')) : null;
if (reuseManifest && (!reuseManifest.stableSources || reuseManifest.sourceDigest !== sourceDigest || reuseManifest.fps !== sampleHz || reuseManifest.romClamp?.effective !== false)) throw Error('Single-chapter reuse requires exact current runtime, assets, clocks and ROM mode');
const { data } = readMaster(repository);
const ids = ['exercises:push-up', 'engine-builder:buildPushUp',
  'screen:fms-repo-legacy-v1/trunk-stability-push-up/trunk-stability-push-up',
  'screen:fms-repo-legacy-v1/trunk-stability-push-up/extension-clearing',
  'screen:fms-repo-legacy-v1/rotary-stability/flexion-clearing'];
const unique: { id: string; variant: BodyVariantId; contexts: any[]; definition: any }[] = [];
for (const variant of ['male', 'female', 'neutral'] as const) for (const id of ids) {
  const contexts = data.contexts.filter((context: any) => context.id === id && context.variant === variant);
  if (contexts.length !== (id.startsWith('engine-builder:') ? 2 : 1) || contexts.some((c: any) => !c.available)) throw Error(`Unexpected catalogue contexts: ${id}/${variant}`);
  if (new Set(contexts.map((c: any) => c.definitionId)).size !== 1) throw Error(`Bilateral builder is no longer identical: ${id}`);
  const definition = data.definitions[contexts[0].definitionId];
  let live: ComposedMotion[];
  if (id === ids[0]) live = [buildGetDownToPlank(), buildPushUp(), buildStandFromPlank()];
  else if (id === ids[1]) live = [buildPushUp()];
  else {
    const pattern = movementScreenPattern(id.slice('screen:'.length));
    const motion = pattern && movementScreenMotion(pattern, 'L', 'movement');
    if (!motion) throw Error(`Missing live screen definition: ${id}`);
    live = [motion];
  }
  if (JSON.stringify(live) !== JSON.stringify(definition.motions)) throw Error(`Master/live constructor mismatch: ${id}/${variant}. Refresh the master first.`);
  unique.push({ id, variant, contexts, definition });
}
mkdirSync(output);
const plan = { sourceDigest, sourceHashes: before, fps: sampleHz,
  scope: 'Five exact catalogue definitions, 15 unique body clips and 18 contexts. Builder left/right reuse requires identical complete definitions. Default authored playback only; no clinical, native or movement qualification.',
  cases: unique.map(row => ({ id: row.id, variant: row.variant, contexts: row.contexts.map(contextKey), definitionId: row.contexts[0].definitionId,
    chapters: row.definition.motions.map((motion: ComposedMotion) => ({ name: motion.name, reps: motion.reps ?? 1, contacts: motion.contacts ?? [], startPosture: motion.startPosture, endPosture: motion.endPosture, supportPlaneY: motion.supportPlaneY })) })) };
writeFileSync(resolve(output, 'delivery-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
if (planOnly) { console.log(JSON.stringify(plan.cases)); process.exit(0); }
setRomClampEnabled(false);
if (isRomClampActive()) throw Error('Global override prevented explicit authored ROM-off capture');
const manifest: any = { version: 1, sourceRevision: git('rev-parse', 'HEAD'), sourceStatus: git('status', '--porcelain'), sourceDigest,
  sourceHashesBefore: before, exporterSha256: hash(readFileSync(fileURLToPath(import.meta.url))), fps: sampleHz,
  romClamp: { requested: 'off', effective: false, environment: 'node' }, scope: plan.scope,
  axes: 'glTF: X left, Y up, Z anterior; metres', deformation: 'All production bone locals, including render-time twist, retained at exact sampler clocks.',
  chapterPolicy: 'Fixed grounded/anatomic baseline with explicit previous pose/root/angles, matching production chain playback. Equal-clock chapter boundaries are right-continuous in GLB; both endpoint records and discontinuities remain in dense JSON.', cases: [] };
for (const row of unique) {
  const { variant, definition, contexts } = row, cfg = BODY_VARIANTS[variant];
  const movement = row.id === ids[0] ? 'exercise-push-up' : row.id === ids[1] ? 'builder-push-up' : row.id.split('/').at(-1)!;
  const id = `${variant}-${movement}`, bytes = readFileSync(resolve(repository, `models/painmap3D_${variant}.runtime.glb`));
  const reusable = definition.motions.length === 1 && reuseManifest?.cases.find((c: any) => c.id === id && c.definitionId === contexts[0].definitionId && c.chapters.length === 1);
  if (reusable) {
    if (reusable.sourceModelSha256 !== hash(bytes)) throw Error('Reused model mismatch');
    for (const [file, expectedHash] of [[reusable.file, reusable.glbSha256], [reusable.denseFile, reusable.denseSha256], [reusable.expected, null]]) {
      const source = resolve(reuseFolder!, file); if (expectedHash && hash(readFileSync(source)) !== expectedHash) throw Error(`Reused bytes changed: ${file}`);
      copyFileSync(source, resolve(output, file));
    }
    manifest.cases.push({ ...reusable, reusedFrom: { folder: reuseFolder, manifestSha256: hash(readFileSync(resolve(reuseFolder!, 'manifest.json'))), exporterSha256: reuseManifest.exporterSha256,
      scope: 'Identical single-chapter runtime source and sample semantics; original GLB, dense record and expected samples copied byte-for-byte. Only multi-chapter harness handling changed.' } });
    console.log(`${id}: reused unchanged single-chapter capture`); continue;
  }
  const { scene: root } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  root.name = 'ENGINE_ModelRoot'; root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse(object => {
    if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).material = new THREE.MeshStandardMaterial({ color: 0xd9e1e4, roughness: .8 });
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh);
  });
  const skin = meshes[0]; if (!skin) throw Error(`No skin: ${id}`);
  const skeleton = skin.skeleton, bones = [...new Set(meshes.flatMap(mesh => mesh.skeleton.bones))];
  const inventory = data.rigs[variant];
  if (inventory.sha256 !== hash(bytes) || bones.length !== inventory.bones.length || inventory.bones.some((b: any) => !bones.some(bone => bone.name === b.raw))) throw Error(`Complete rig inventory mismatch: ${id}`);
  const initialPose = serializeCustomPose(skeleton, cfg, variant), initialRoot = { p: root.position.clone(), q: root.quaternion.clone(), s: root.scale.clone() };
  const rest = captureJointAngleRestReference(skeleton, cfg), twist = createStageTwistOverlay(); twist.reset(skeleton, cfg);
  const animated = [root, ...bones], frames: any[] = [], rawFrames: any[] = [], chapters: any[] = [], joins: any[] = [], checkpoints = new Set<number>();
  let totalMs = 0, previous: any = null;
  for (let chapter = 0; chapter < definition.motions.length; chapter++) {
    const authored = definition.motions[chapter] as ComposedMotion;
    const rootRest = initialRoot, baselinePose = initialPose;
    root.position.copy(rootRest.p); root.quaternion.copy(rootRest.q); root.scale.copy(rootRest.s); applyCustomPose(skeleton, cfg, baselinePose); root.updateMatrixWorld(true);
    const currentRoot = previous ? { quat: previous.root.orientQuat, translateM: previous.root.translateM } : undefined;
    const currentAngles = previous ? Object.fromEntries(Object.entries(previous.angles as Record<string, Record<string, number>>).flatMap(([joint, channels]) => Object.entries(channels).filter(([,value]) => Number.isFinite(value)).map(([channel, value]) => [`${joint}.${channel}`, value]))) : undefined;
    const motion = resolveComposedMotion(authored, cfg, previous ? { currentAngles, currentRoot } : undefined);
    const floorY = floorReferenceForSupport(captureFloorReference(skeleton, cfg), motion.supportPlaneY).floorY;
    const recording = sampleComposedMotion(motion, { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned: skin }, sampleHz, ...(previous ? { currentPose: previous.pose, currentRoot } : {}) });
    const durationMs = recording.frames.at(-1)?.tMs; if (durationMs == null) throw Error(`Empty chapter: ${id}/${chapter}`);
    const map = authoredToTrajectoryTimeMap(motion, durationMs), phases: any[] = []; let authoredMs = 0;
    for (let rep = 0; rep < (motion.loop ? 1 : Math.max(1, motion.reps ?? 1)); rep++) for (let keyframe = 0; keyframe < motion.keyframes.length; keyframe++) {
      const k = motion.keyframes[keyframe], startMs = map.toTrajectory(authoredMs); authoredMs += k.durationMs ?? 0;
      const arrivalMs = map.toTrajectory(authoredMs); authoredMs += k.holdMs ?? 0;
      const endMs = map.toTrajectory(authoredMs); phases.push({ chapter, rep, keyframe, startMs: totalMs + startMs, arrivalMs: totalMs + arrivalMs, endMs: totalMs + endMs, groundingPosture: k.groundingPosture, targets: authored.keyframes[keyframe]?.targets ?? [] });
      for (const time of [startMs, (startMs + arrivalMs) / 2, arrivalMs, endMs]) checkpoints.add(totalMs + recording.frames.reduce((best, f) => Math.abs(f.tMs - time) < Math.abs(best.tMs - time) ? f : best).tMs);
    }
    chapters.push({ chapter, name: authored.name, startMs: totalMs, endMs: totalMs + durationMs, durationMs, sourceFrames: recording.frames.length, floorY, authored, phases });
    for (const frame of recording.frames) {
      root.position.copy(rootRest.p).add(new THREE.Vector3().fromArray(frame.root.translateM));
      root.quaternion.copy(rootRest.q).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat)); root.scale.copy(rootRest.s);
      applyCustomPose(skeleton, cfg, frame.pose);
      twist.sampleWithTwist(() => {
        root.updateMatrixWorld(true);
        const tMs = totalMs + frame.tMs, record: any = { ...frame, tMs, chapter, chapterTimeMs: frame.tMs, floorY,
          locals: Object.fromEntries(animated.map(node => [node.name, { p: node.position.toArray(), q: node.quaternion.toArray(), s: node.scale.toArray() }])),
          worldBones: Object.fromEntries(bones.map(bone => [bone.name, { p: bone.getWorldPosition(new THREE.Vector3()).toArray(), q: bone.getWorldQuaternion(new THREE.Quaternion()).toArray() }])) };
        if (checkpoints.has(tMs)) record.expected = { timeSec: tMs / 1000, frame: 1 + tMs / 1000 * sampleHz,
          bones: Object.fromEntries(bones.map(b => [b.name, b.getWorldPosition(new THREE.Vector3()).toArray()])),
          skinPointsM: meshes.flatMap(mesh => {
            const points: number[][] = [], count = mesh.geometry.getAttribute('position').count;
            for (let vertex = 0; vertex < count; vertex += Math.max(1, Math.floor(count / 256))) points.push(mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).toArray());
            return points;
          }) };
        rawFrames.push(record);
        const previous = frames.at(-1);
        if (previous && Math.abs(previous.tMs - tMs) < 1e-7) {
          joins.push({ timeMs: tMs, beforeChapter: previous.chapter, afterChapter: chapter,
            maxBonePositionJumpM: Math.max(...bones.map(b => new THREE.Vector3().fromArray(previous.worldBones[b.name].p).distanceTo(new THREE.Vector3().fromArray(record.worldBones[b.name].p)))),
            maxBoneRotationJumpDeg: Math.max(...bones.map(b => THREE.MathUtils.radToDeg(new THREE.Quaternion().fromArray(previous.worldBones[b.name].q).angleTo(new THREE.Quaternion().fromArray(record.worldBones[b.name].q))))) });
          frames[frames.length - 1] = record;
        } else frames.push(record);
      });
    }
    previous = recording.frames.at(-1);
    totalMs += durationMs;
  }
  const times = frames.map(frame => frame.tMs / 1000);
  const tracks = animated.flatMap(node => [new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, frames.flatMap(frame => frame.locals[node.name].q)),
    new THREE.VectorKeyframeTrack(`${node.name}.position`, times, frames.flatMap(frame => frame.locals[node.name].p)),
    new THREE.VectorKeyframeTrack(`${node.name}.scale`, times, frames.flatMap(frame => frame.locals[node.name].s))]);
  root.position.copy(initialRoot.p); root.quaternion.copy(initialRoot.q); root.scale.copy(initialRoot.s); applyCustomPose(skeleton, cfg, initialPose); root.updateMatrixWorld(true);
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations: [new THREE.AnimationClip(`ENGINE_${id}`, totalMs / 1000, tracks)], onlyVisible: false }) as ArrayBuffer;
  writeFileSync(resolve(output, `${id}.glb`), Buffer.from(glb), { flag: 'wx' });
  const denseFile = `${id}.recording.json`;
  writeFileSync(resolve(output, denseFile), JSON.stringify({ sourceDigest, variant, contextKeys: contexts.map(contextKey), definitionId: contexts[0].definitionId, chapters, joins, frames: rawFrames }) + '\n', { flag: 'wx' });
  const expected = frames.filter(frame => frame.expected).map(frame => frame.expected);
  const record = { id, variant, side: 'R', movement, file: `${id}.glb`, sourceModelSha256: hash(bytes), glbSha256: hash(new Uint8Array(glb)),
    contextKeys: contexts.map(contextKey), definitionId: contexts[0].definitionId, denseFile, denseSha256: hash(readFileSync(resolve(output, denseFile))),
    frames: frames.length, sourceFrames: rawFrames.length, boneCount: bones.length, durationMs: totalMs, floorY: chapters[0].floorY,
    sampleTimesSec: times, sampleFloorYs: frames.map(frame => frame.floorY), chapters, joins, romClamp: manifest.romClamp,
    setupFrame: chapters[0].phases[0].arrivalMs / 1000 * sampleHz,
    holdFrame: 1 + (chapters.find(ch => ch.authored.contacts?.length)?.phases[1]?.arrivalMs ?? totalMs / 2) / 1000 * sampleHz, expected };
  writeFileSync(resolve(output, `${id}.expected.json`), JSON.stringify(record) + '\n', { flag: 'wx' });
  manifest.cases.push({ ...record, expected: `${id}.expected.json` });
  console.log(`${id}: ${frames.length} retained times, ${rawFrames.length} source samples, ${bones.length} bones, ${expected.length} surface checkpoints`);
  root.traverse((node: any) => { node.geometry?.dispose(); if (Array.isArray(node.material)) node.material.forEach((m: any) => m.dispose()); else node.material?.dispose(); });
}
manifest.sourceHashesAfter = sourceHashes(); manifest.stableSources = hash(JSON.stringify(manifest.sourceHashesAfter)) === sourceDigest;
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
if (!manifest.stableSources) throw Error('Engine source changed during export; retained as mixed-source evidence');
