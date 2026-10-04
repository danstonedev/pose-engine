/** Read clinical bounds from the exact retained baseline export; compare an already
 * recorded candidate. No runtime/master edits and no current recipe resampling.
 * vite-node THIS <baseline-review-folder> <baseline-asymmetry.json> <candidate.json> <new-output.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { captureJointAngleRestReference, computeJointAngles, isShoulderFieldMasked } from '../../src/services/jointAngles';
import { getEffectiveRomRange } from '../../src/services/romConstraints';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from '../../src/services/rootMotion';

const [folder, oldProbePath, candidatePath, output] = process.argv.slice(2);
if (!output) throw Error('Retained folder, prior angle probe, candidate and output required');
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const manifest = read(resolve(folder, 'manifest.json'));
const oldProbe = read(oldProbePath), candidate = read(candidatePath);
const sourcePaths = ['src/services/jointAngles.ts', 'src/services/rootMotion.ts', 'src/services/romConstraints.ts', 'src/services/romRegistry.ts', 'src/anatomy/bodyVariants.ts'];
const identity = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(new URL('../../' + path, import.meta.url)))]));
const sourceBefore = identity();
const report: any = { version: 1, kind: 'retained-plank-clinical-comparison',
  baselineSourceDigest: manifest.sourceDigest, candidateSourceDigest: candidate.sourceDigest,
  manifestSha256: sha(readFileSync(resolve(folder, 'manifest.json'))), candidateSha256: sha(readFileSync(candidatePath)),
  oldProbeSha256: sha(readFileSync(oldProbePath)), readoutSourceHashes: sourceBefore,
  boundToleranceDeg: candidate.criteriaBeforeRun.boundToleranceDeg,
  scope: 'Every 169 retained baseline glTF frame read against the same production anatomical rest and registry as recorded candidate, including sampler root and pelvis reference rotation. Export bakes render helper twists; three-clock parity against earlier baseline sampler angles is quantified. No recipe resampling, runtime edits, limit changes or clinical signoff.', cases: [] };
const loader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const parse = (bytes: Buffer) => loader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const skeletonOf = (root: THREE.Object3D) => {
  let skeleton: THREE.Skeleton | undefined;
  root.traverse(object => { if (!skeleton && (object as THREE.SkinnedMesh).isSkinnedMesh) skeleton = (object as THREE.SkinnedMesh).skeleton; });
  if (!skeleton) throw Error('Skeleton missing'); return skeleton;
};
const summarize = (frames: any[]) => {
  const extrema: any = {}, breaches: any[] = [];
  for (const frame of frames) for (const [joint, set] of Object.entries(frame.angles)) for (const [field, value] of Object.entries(set as Record<string, number>)) {
    const key = joint + '.' + field, range = getEffectiveRomRange(null, joint, field);
    const e = extrema[key] ??= { min: value, max: value, minTMs: frame.tMs, maxTMs: frame.tMs, range, maskedFrames: 0 };
    if (value < e.min) { e.min = value; e.minTMs = frame.tMs; }
    if (value > e.max) { e.max = value; e.maxTMs = frame.tMs; }
    const masked = isShoulderFieldMasked(joint, field, set); if (masked) e.maskedFrames++;
    if (range && !masked && (value < range.min - report.boundToleranceDeg || value > range.max + report.boundToleranceDeg)) breaches.push({ tMs: frame.tMs, joint, field, value, range });
  }
  const grouped = Object.fromEntries([...new Set(breaches.map(b => b.joint + '.' + b.field))].map(key => [key, {
    ...extrema[key], count: breaches.filter(b => b.joint + '.' + b.field === key).length,
    firstBreach: breaches.find(b => b.joint + '.' + b.field === key),
  }]));
  return { extrema, groupedBreaches: grouped, breachCount: breaches.length, breaches };
};
for (const variant of ['male', 'female', 'neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], baselineCase = manifest.cases.find((row: any) => row.variant === variant);
  const modelBytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  if (sha(modelBytes) !== baselineCase.sourceModelSha256) throw Error('Retained asset identity differs');
  const production = (await parse(modelBytes)).scene; production.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(production, cfg); production.updateMatrixWorld(true);
  const rest = captureJointAngleRestReference(skeletonOf(production), cfg);
  const rootRestQuaternion = production.quaternion.clone();
  const bytes = readFileSync(resolve(folder, baselineCase.file)); if (sha(bytes) !== baselineCase.glbSha256) throw Error('Retained GLB changed');
  const gltf = await parse(bytes), skeleton = skeletonOf(gltf.scene), mixer = new THREE.AnimationMixer(gltf.scene);
  const modelRoot = gltf.scene.getObjectByName('ENGINE_ModelRoot') ?? gltf.scene;
  mixer.clipAction(gltf.animations[0]!).play();
  const updated = candidate.cases.find((row: any) => row.variant === variant && row.pitch === 76);
  const prior = oldProbe.cases.find((row: any) => row.variant === variant);
  const frames: any[] = [], parity: any[] = [];
  for (const candidateFrame of updated.frames) {
    const tMs = candidateFrame.tMs; mixer.setTime(tMs / 1000); gltf.scene.updateMatrixWorld(true);
    const worldRootDelta = modelRoot.quaternion.clone().normalize().multiply(rootRestQuaternion.clone().invert());
    const rootReference = rotateRestReferenceByRoot(rest, worldRootDelta);
    const measureReference = rotateRestReferenceByPelvis(rootReference, skeleton, cfg);
    const angles = computeJointAngles(skeleton, cfg, variant, measureReference).joints;
    frames.push({ tMs, angles });
    const control = prior.frames.find((row: any) => row.mode === 'full-contact' && Math.abs(row.tMs - tMs) < .001);
    if (control) {
      const differences = Object.entries(control.angles).flatMap(([joint, fields]) => Object.entries(fields as Record<string, number>).map(([field, value]) => ({ joint, field,
        deltaDeg: Math.abs((angles as any)[joint][field] - value) })));
      differences.sort((a, b) => b.deltaDeg - a.deltaDeg); parity.push({ tMs, maxAngleDeltaDeg: differences[0]!.deltaDeg, witness: differences[0], all: differences });
    }
  }
  const before = summarize(frames), after = summarize(updated.frames);
  const beforeKeys = Object.keys(before.groupedBreaches), afterKeys = Object.keys(after.groupedBreaches);
  const changes = Object.fromEntries([...new Set([...beforeKeys, ...afterKeys])].map(key => [key, {
    status: beforeKeys.includes(key) ? (afterKeys.includes(key) ? 'inherited-field' : 'resolved-field') : 'new-field',
    before: before.groupedBreaches[key] ?? before.extrema[key], after: after.groupedBreaches[key] ?? after.extrema[key],
    minDeltaDeg: after.extrema[key].min - before.extrema[key].min, maxDeltaDeg: after.extrema[key].max - before.extrema[key].max,
  }]));
  const focusedNewBreaches = after.breaches.filter(b => !/Thumb|Index|Mid|Ring|Pinky/.test(b.joint));
  report.cases.push({ variant, sampleCount: frames.length, assetSha256: sha(modelBytes), glbSha256: sha(bytes),
    before, after, changes, newBreachedFields: afterKeys.filter(key => !beforeKeys.includes(key)),
    inheritedBreachedFields: afterKeys.filter(key => beforeKeys.includes(key)), focusedChainBreachCount: focusedNewBreaches.length, parity, frames });
  console.log(JSON.stringify({ variant, sampleCount: frames.length, changes, focusedChainBreachCount: focusedNewBreaches.length,
    maxParityAngleDeltaDeg: Math.max(...parity.map(row => row.maxAngleDeltaDeg)) }));
}
report.readoutSourceStable = JSON.stringify(sourceBefore) === JSON.stringify(identity());
if (!report.readoutSourceStable) throw Error('Readout source changed during comparison');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
