/** Read measured clinical effects of sparse Blender hip/knee world-X increments.
 * vite-node .../check-prone-lower-chain-probe.ts <probe.json> <author2.json> <audit.json> <fresh-output.json>
 * Diagnostic only; no contact solve or runtime mutation is performed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { captureJointAngleRestReference, computeJointAngles } from '../../src/services/jointAngles';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from '../../src/services/rootMotion';
import { ROM_JOINT_ROWS } from '../../src/services/romRegistry';

const [probeArg, authorArg, auditArg, outputArg] = process.argv.slice(2);
if (!probeArg || !authorArg || !auditArg || !outputArg) throw Error('Provide sparse probe, authored source, original audit and fresh report');
const read = (path: string) => readFileSync(resolve(path));
const parse = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const probeBytes = read(probeArg), authorBytes = read(authorArg), auditBytes = read(auditArg);
const probe = parse(probeBytes), author = parse(authorBytes), audit = parse(auditBytes);
if (probe.sourceReportSha256 !== hash(authorBytes) || author.auditSha256 !== hash(auditBytes)) throw Error('Source chain hash mismatch');
const engine = fileURLToPath(new URL('../../', import.meta.url));
const result: any = { version: 1, probeSha256: hash(probeBytes), authorSha256: hash(authorBytes), auditSha256: hash(auditBytes),
  scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  scope: 'Six sparse lower-chain orientation probes, reconstructed from validated author2 local quaternions and original root placement. No whole-trajectory, surface-equivalence, native, patient or clinical-protocol acceptance. Existing author2 upper-limb violations remain.',
  convention: 'Hip then knee world +X rotations match Blender axes (Blender X = engine X). Parent world quaternion refreshed between rotations. Parent-local hip/knee/ankle/toe readouts use production root/pelvis-adjusted rest. Probe root translation does not affect these angles and is not fitted here.',
  geometryLimitation: 'Probe has no independent final bone-position oracle. Base author2 reproduction is checked independently; final skin gaps are Blender observations only.',
  runtimeFileHashes: Object.fromEntries(['src/services/jointAngles.ts', 'src/services/rootMotion.ts', 'src/services/poseRig.ts', 'src/services/romRegistry.ts'].map(path => [path, hash(readFileSync(resolve(engine, path)))])),
  cases: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], authored = author.cases.find((c: any) => c.variant === variant), original = audit.cases.find((c: any) => c.variant === variant);
  const glb = readFileSync(resolve(engine, `models/painmap3D_${variant}.runtime.glb`));
  if (hash(glb) !== authored.sourceModelSha256 || original.sourceModelSha256 !== authored.sourceModelSha256) throw Error('Model hash mismatch');
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin: THREE.SkinnedMesh | undefined;
  root.traverse(object => { if (!skin && (object as THREE.SkinnedMesh).isSkinnedMesh) skin = object as THREE.SkinnedMesh; });
  if (!skin) throw Error('Missing skin');
  const baseline = serializeCustomPose(skin.skeleton, cfg, variant), rest = captureJointAngleRestReference(skin.skeleton, cfg);
  const names = Object.fromEntries(Object.entries(original.frames[0].boneTransforms).map(([key, value]: [string, any]) => [key, value.name]));
  const bone = (key: string) => skin!.skeleton.bones.find(bone => bone.name === names[key])!;
  const point = (key: string) => bone(key).getWorldPosition(new THREE.Vector3());
  const anatomicParentInverse = bone('Hips').parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
  const rootPosition = root.position.clone(), rootQuaternion = root.quaternion.clone();
  for (const p of probe.cases.filter((p: any) => p.variant === variant)) {
    const index = Math.round(p.sourceTimeSec * authored.sampleHz), frame = authored.frames[index], originalFrame = original.frames[index];
    if (Math.abs(frame.timeSec - p.sourceTimeSec) > 1e-9) throw Error('Frame time mismatch');
    const orient = new THREE.Quaternion().fromArray(originalFrame.boneTransforms.Hips.parentWorldQuaternion).multiply(anatomicParentInverse);
    root.quaternion.copy(orient).multiply(rootQuaternion); root.position.copy(rootPosition);
    applyCustomPose(skin.skeleton, cfg, { ...baseline, bones: { ...baseline.bones, ...frame.engineLocalQuaternions } });
    for (const [key, q] of Object.entries(frame.engineLocalQuaternions) as [string, number[]][]) bone(key).quaternion.fromArray(q);
    root.updateMatrixWorld(true);
    root.position.add(new THREE.Vector3().fromArray(frame.bonePositionsM.Hips).sub(point('Hips'))); root.updateMatrixWorld(true);
    const baseBoneResidualM = Math.max(...Object.keys(names).map(key => point(key).distanceTo(new THREE.Vector3().fromArray(frame.bonePositionsM[key]))));
    if (baseBoneResidualM > .0001) throw Error('Base transfer failed independent bone-position check');
    const reference = () => rotateRestReferenceByPelvis(rotateRestReferenceByRoot(rest, orient), skin!.skeleton, cfg);
    const measure = () => Object.fromEntries(Object.entries(computeJointAngles(skin!.skeleton, cfg, variant, reference()).joints).filter(([key]) => /^[LR]_(UpLeg|Leg|Foot|Toes)$/.test(key)));
    const before = measure();
    for (const side of ['L', 'R']) for (const [key, channel] of [['UpLeg', 'hip'], ['Leg', 'knee']]) {
      const degrees = p.incrementalWorldPitchDeg[side][channel];
      if (!Number.isFinite(degrees)) throw Error('Invalid pitch increment');
      const targetBone = bone(`${side}_${key}`);
      const targetWorld = targetBone.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), degrees * Math.PI / 180));
      targetBone.quaternion.copy(targetBone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()).multiply(targetWorld);
      root.updateMatrixWorld(true);
    }
    const after = measure(), delta = Object.fromEntries(Object.entries(after).map(([key, values]) => [key, Object.fromEntries(Object.entries(values).map(([field, value]) => [field, value - before[key]![field]!]))]));
    const violations = [];
    for (const row of ROM_JOINT_ROWS) if (after[row.canonicalKey]) for (const field of row.fields) {
      const value = after[row.canonicalKey]![field.key]!;
      const excess = Math.max(field.range.min - value, value - field.range.max, 0);
      if (!Number.isFinite(value)) throw Error('Missing finite clinical measurement');
      if (excess > .01) violations.push({ joint: row.canonicalKey, field: field.key, value, range: field.range, excessDeg: excess });
    }
    result.cases.push({ variant, phase: p.phase, sourceTimeSec: p.sourceTimeSec, baseBoneResidualM, incrementalWorldPitchDeg: p.incrementalWorldPitchDeg, before, after, delta, violations, blenderSkinAfterM: p.skinAfterM });
    console.log(variant, p.phase, JSON.stringify({ hip: [after.L_UpLeg?.hipFlexion, after.R_UpLeg?.hipFlexion], knee: [after.L_Leg?.kneeFlexion, after.R_Leg?.kneeFlexion], violations }));
  }
}
writeFileSync(resolve(outputArg), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
