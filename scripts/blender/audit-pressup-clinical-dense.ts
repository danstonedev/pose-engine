/** All-frame clinical diagnostic of the exact exported authored motion.
 * vite-node this.ts <motion.json> <review-dir> <fresh-report.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, serializeCustomPose, buildBoneByPoseKey } from '../../src/services/poseRig';
import { captureJointAngleRestReference, computeJointAngles, upperArmWorldAngles, isShoulderFieldMasked } from '../../src/services/jointAngles';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from '../../src/services/rootMotion';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { ROM_JOINT_ROWS } from '../../src/services/romRegistry';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';
import { isRomClampActive, setRomClampEnabled } from '../../src/services/poseRomClamp';

const [motionPath, reviewPath, destination] = process.argv.slice(2);
if (!motionPath || !reviewPath || !destination) throw Error('Provide motion, review directory and fresh report path');
const engine = fileURLToPath(new URL('../../', import.meta.url));
const parse = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${engine.replaceAll('\\', '/').replace(/\/$/, '')}`, ...args], { cwd: engine, encoding: 'utf8' }).trim();
const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', 'src', 'models', 'package-lock.json').split('\n').filter(Boolean))].sort();
const runtimeFiles = files.filter(path => !path.startsWith('src/__tests__/'));
const digest = (paths: string[]) => hash(paths.map(path => `${path}:${hash(readFileSync(resolve(engine, path)))}`).join('\n'));
const authored = parse(motionPath), manifest = parse(resolve(reviewPath, 'manifest.json'));
if (manifest.romClamp && typeof manifest.romClamp.effective !== 'boolean') throw Error('Export clamp mode is malformed');
const effectiveClamp = manifest.romClamp?.effective ?? true;
setRomClampEnabled(effectiveClamp);
if (isRomClampActive() !== effectiveClamp) throw Error('Process debug override conflicts with the exported clamp mode');
const report: any = { version: 1, sampleHz: 60, motionSha256: hash(readFileSync(motionPath)),
  romClamp: { effective: effectiveClamp, provenance: manifest.romClamp ? 'export manifest' : 'legacy exporter used Node default ON' },
  scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), sourceDigestBefore: digest(files), runtimeDigestBefore: digest(runtimeFiles),
  exportSourceDigest: manifest.sourceDigest, sourceRevision: git('rev-parse', 'HEAD'), exportManifestSha256: hash(readFileSync(resolve(reviewPath, 'manifest.json'))),
  scope: 'All 975 source poses at60Hz. Existing registry limits, unchanged0.05deg numerical tolerance. World-track replay and five all-bone/render-twist skin checkpoints perbody compared with exported input. Not force, native tracking or experimental approval.',
  shoulderConvention: 'Root/pelvis-rebased references for runtime readout; humerothoracic clinical fields independently measured after undoing live thorax world delta into anatomical rest axes. Legacy projected fields retained separately.',
  patientScope: 'No patient restrictions in this default motion audit; patient-bound regression is separate.',
  numericalAngleToleranceDeg: .05, transferToleranceM: .0001, cases: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], entry = manifest.cases.find((c: any) => c.variant === variant);
  const bytes = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  if (hash(bytes) !== entry.sourceModelSha256) throw Error('Source asset changed');
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(node as THREE.SkinnedMesh); });
  const skinned = meshes[0], baseline = serializeCustomPose(skinned.skeleton, cfg, variant);
  const rest = captureJointAngleRestReference(skinned.skeleton, cfg), initialQuaternion = root.quaternion.clone(), initialPosition = root.position.clone();
  const bones = buildBoneByPoseKey(skinned.skeleton, cfg), point = (key: string) => bones.get(key)!.getWorldPosition(new THREE.Vector3());
  const thoraxRest = bones.get('L_Shoulder')!.parent!.getWorldQuaternion(new THREE.Quaternion());
  const twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
  const recording = sampleComposedMotion(resolveComposedMotion(authored, cfg), { baselinePose: baseline, variantCfg: cfg, rest,
    skeletonHarness: { root, skinned }, sampleHz: 60 });
  if (recording.frames.length !== entry.frames) throw Error('Export frame count mismatch');
  const expected = parse(resolve(reviewPath, entry.expected)).expected;
  const row: any = { variant, sourceModelSha256: hash(bytes), frameCount: recording.frames.length,
    maxTrackResidualM: 0, maxExportBoneResidualM: 0, maxExportSkinResidualM: 0, exportCheckpoints: 0,
    ranges: {}, violations: [], maskedProjectionCounts: {}, missingFields: [], frames: [] };
  for (let index = 0; index < recording.frames.length; index++) {
    const frame = recording.frames[index];
    root.position.copy(initialPosition).add(new THREE.Vector3().fromArray(frame.root.translateM));
    root.quaternion.copy(initialQuaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
    applyCustomPose(skinned.skeleton, cfg, frame.pose); root.updateMatrixWorld(true);
    for (const [key, value] of Object.entries(frame.worldTracks ?? {})) if (bones.has(key))
      row.maxTrackResidualM = Math.max(row.maxTrackResidualM, point(key).distanceTo(new THREE.Vector3().fromArray(value)));
    const activeRest = rotateRestReferenceByPelvis(rotateRestReferenceByRoot(rest, root.quaternion.clone().multiply(initialQuaternion.clone().invert())), skinned.skeleton, cfg);
    const clinical = computeJointAngles(skinned.skeleton, cfg, variant, activeRest);
    const legacyShoulders = { L: clinical.joints.L_UpperArm, R: clinical.joints.R_UpperArm };
    const inverseThorax = bones.get('L_Shoulder')!.parent!.getWorldQuaternion(new THREE.Quaternion()).multiply(thoraxRest.clone().invert()).invert();
    for (const side of ['L', 'R'] as const) {
      const key = side + '_UpperArm', upper = bones.get(key)!;
      const value = upperArmWorldAngles(upper.getWorldQuaternion(new THREE.Quaternion()).premultiply(inverseThorax),
        new THREE.Quaternion().fromArray(rest.worldQuats[key]!),
        point(side + '_Forearm').sub(point(key)).normalize().applyQuaternion(inverseThorax),
        new THREE.Vector3().fromArray(rest.worldDirs![key]!), side === 'R');
      clinical.joints[key] = { shoulderFlexion: value.flexion, shoulderAbduction: value.abduction, shoulderRotation: value.rotation };
    }
    const failures: any[] = [];
    for (const joint of ROM_JOINT_ROWS) for (const field of joint.fields) {
      const key = joint.canonicalKey + '.' + field.key, value = clinical.joints[joint.canonicalKey]?.[field.key];
      if (value == null || !Number.isFinite(value)) { if (!row.missingFields.includes(key)) row.missingFields.push(key); continue; }
      if (isShoulderFieldMasked(joint.canonicalKey, field.key, clinical.joints[joint.canonicalKey])) {
        row.maskedProjectionCounts[key] = (row.maskedProjectionCounts[key] ?? 0) + 1; continue;
      }
      row.ranges[key] ??= { min: value, max: value };
      row.ranges[key].min = Math.min(row.ranges[key].min, value); row.ranges[key].max = Math.max(row.ranges[key].max, value);
      const excessDeg = Math.max(0, field.range.min - value, value - field.range.max);
      if (excessDeg > report.numericalAngleToleranceDeg) failures.push({ key, value, range: field.range, excessDeg });
    }
    row.violations.push(...failures.map(failure => ({ frame: index, tMs: frame.tMs, ...failure })));
    row.frames.push({ tMs: frame.tMs, clinical: clinical.joints, legacyShoulders, shoulderFrames: clinical.shoulders, violations: failures });
    const checkpoint = expected.find((p: any) => p.frame === index + 1);
    if (checkpoint) twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true); row.exportCheckpoints++;
      for (const bone of skinned.skeleton.bones) row.maxExportBoneResidualM = Math.max(row.maxExportBoneResidualM,
        bone.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(checkpoint.bones[bone.name])));
      let sampleIndex = 0;
      for (const mesh of meshes) {
        const position = mesh.geometry.getAttribute('position');
        for (let vertex = 0; vertex < position.count; vertex += Math.max(1, Math.floor(position.count / 256))) {
          const p = new THREE.Vector3().fromBufferAttribute(position, vertex);
          mesh.applyBoneTransform(vertex, p); p.applyMatrix4(mesh.matrixWorld);
          row.maxExportSkinResidualM = Math.max(row.maxExportSkinResidualM, p.distanceTo(new THREE.Vector3().fromArray(checkpoint.skinPointsM[sampleIndex++])));
        }
      }
      if (sampleIndex !== checkpoint.skinPointsM.length) throw Error('Export skin sample count mismatch');
    });
  }
  report.cases.push(row);
  console.log(JSON.stringify({ variant, frames: row.frameCount, violations: row.violations.length,
    violationFields: [...new Set(row.violations.map((v: any) => v.key))], missingFields: row.missingFields,
    maxTrackResidualM: row.maxTrackResidualM, maxExportBoneResidualM: row.maxExportBoneResidualM, maxExportSkinResidualM: row.maxExportSkinResidualM }));
}
report.sourceDigestAfter = digest(files); report.runtimeDigestAfter = digest(runtimeFiles);
report.sourceStable = report.sourceDigestBefore === report.sourceDigestAfter;
report.runtimeStable = report.runtimeDigestBefore === report.runtimeDigestAfter;
report.pass = report.runtimeStable && report.cases.every((c: any) => !c.violations.length && !c.missingFields.length
  && c.maxTrackResidualM < 1e-7 && c.maxExportBoneResidualM < .0001 && c.maxExportSkinResidualM < .0001 && c.exportCheckpoints === 5);
writeFileSync(resolve(destination), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
if (!report.pass) process.exitCode = 1;
