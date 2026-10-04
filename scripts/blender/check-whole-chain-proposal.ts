/** Reconstruct a Blender proposal on the unchanged production rigs.
 * vite-node .../check-whole-chain-proposal.ts <authoring-dir> <source-audit.json> <fresh-report.json> [source-motion.json]
 * Reports geometry and registry violations; never clamps or promotes a pose.
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
import { captureJointAngleRestReference, computeJointAngles, upperArmWorldAngles, isShoulderFieldMasked } from '../../src/services/jointAngles';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from '../../src/services/rootMotion';
import { ROM_JOINT_ROWS } from '../../src/services/romRegistry';
import { measureCommandMotion } from '../../src/services/movementCommand';

const [sourceArg, auditArg, outputArg, motionArg] = process.argv.slice(2);
if (!sourceArg || !auditArg || !outputArg) throw Error('Provide authoring folder, source audit and fresh output');
const source = resolve(sourceArg, 'whole-chain-authoring.json'), bytes = readFileSync(source);
const parse = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
const data = parse(bytes), auditBytes = readFileSync(resolve(auditArg)), audit = parse(auditBytes);
const engine = fileURLToPath(new URL('../../', import.meta.url));
const hash = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
if (hash(auditBytes) !== data.auditSha256) throw Error('Source audit hash mismatch');
const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${engine.replaceAll('\\', '/').replace(/\/$/, '')}`, ...args], { cwd: engine, encoding: 'utf8' }).trim();
const sourcePaths = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', 'src', 'models', 'package-lock.json').split('\n').filter(Boolean))].sort();
const sourceDigest = () => hash(sourcePaths.map(path => `${path}:${hash(readFileSync(resolve(engine, path)))}`).join('\n'));
const digestBefore = sourceDigest();
const motionBytes = motionArg ? readFileSync(resolve(motionArg)) : null, sourceMotion = motionBytes ? parse(motionBytes) : null;
const transferToleranceM = .0001, numericalAngleToleranceDeg = .01;
const result: any = {
  version: 2, inputSha256: hash(bytes), inputScriptSha256: data.scriptSha256, auditSha256: hash(auditBytes),
  scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), sourceRevision: git('rev-parse', 'HEAD'),
  sourceDigestBefore: digestBefore, ...(motionBytes ? { sourceMotionSha256: hash(motionBytes) } : {}),
  scope: 'Geometric reconstruction and comparison with existing engine registry. No pose is clamped, no patient constraints supplied, no clinical protocol scoring, force, native or host acceptance.',
  rootConvention: 'Original per-frame Hips parent world quaternion reconstructs model-root orientation against the production anatomic parent. Only model-root translation aligns authored Hips. Every other bone position is an independent transfer check.',
  shoulderConvention: 'Runtime shoulderComplex uses immutable anatomic rest and live thorax/girdle frames. Legacy runtime world-plane projections are retained separately, not used as thorax-relative ROM. Registry shoulder fields use upperArmWorldAngles after undoing live thorax delta into original anatomic axes; degenerate projections are explicitly masked by the existing runtime rule.',
  surfaceScope: 'Skin minima are Blender observations copied from input, not independently reconstructed: canonical transfer omits baked unmapped twist helper poses. Bone transfer equality does not establish surface equality.',
  poseSchema: 'Captured serializeCustomPose schema/rig identity is retained; unmapped source Pelvis helper quaternion is explicitly restored by its original bone name.',
  patientStatus: 'not-evaluated-no-patient-constraints', transferToleranceM, numericalAngleToleranceDeg,
  cases: [],
};
for (const c of data.cases) {
  const cfg = BODY_VARIANTS[c.variant as keyof typeof BODY_VARIANTS];
  if (!cfg) throw Error('Unknown body variant');
  const glb = readFileSync(resolve(engine, 'models', `painmap3D_${c.variant}.runtime.glb`));
  if (hash(glb) !== c.sourceModelSha256) throw Error('Production model changed');
  const original = audit.cases.find((row: any) => row.id === c.id);
  if (!original || original.sourceModelSha256 !== c.sourceModelSha256 || original.frames.length !== c.frames.length) throw Error('Missing or mismatched original trajectory');
  const parsed = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
  const root = parsed.scene; root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin: THREE.SkinnedMesh | undefined;
  root.traverse(o => { if (!skin && (o as THREE.SkinnedMesh).isSkinnedMesh) skin = o as THREE.SkinnedMesh; });
  if (!skin) throw Error('Missing skin');
  const rest = captureJointAngleRestReference(skin.skeleton, cfg), baseline = serializeCustomPose(skin.skeleton, cfg, c.variant);
  const names = Object.fromEntries(Object.entries(original.frames[0].boneTransforms).map(([key, value]: [string, any]) => [key, value.name]));
  const lookup = (key: string) => skin!.skeleton.bones.find(b => b.name === names[key])!;
  if (Object.keys(names).some(key => !lookup(key))) throw Error('Missing source bone');
  const point = (key: string) => lookup(key).getWorldPosition(new THREE.Vector3());
  const initialRootRotation = root.quaternion.clone(), initialRootPosition = root.position.clone();
  const anatomicParentInverse = lookup('Hips').parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
  const thoraxRest = lookup('L_Shoulder').parent!.getWorldQuaternion(new THREE.Quaternion());
  const ranges: Record<string, any> = {}, violations: Record<string, any> = {}, targetResiduals: Record<string, any> = {};
  const transferResiduals: Record<string, any> = {}, geometricResiduals: Record<string, any> = {};
  const frames = [], maskedProjectionCounts: Record<string, number> = {};
  let maxBoneResidualM = 0;
  const recordMaximum = (map: Record<string, any>, key: string, value: number, frame: any, extra: any = {}) => {
    if (!map[key] || value > map[key].value) map[key] = { value, timeSec: frame.timeSec, sampleIndex: frame.sampleIndex, ...extra };
  };
  const sourceEndpoints: any[] = [];
  let phaseEndMs = 0;
  for (const [index, keyframe] of (sourceMotion?.keyframes ?? []).entries()) {
    phaseEndMs += keyframe.durationMs;
    sourceEndpoints.push({ index, timeMs: phaseEndMs, targets: keyframe.targets ?? [] });
    phaseEndMs += keyframe.holdMs ?? 0;
  }
  for (const frame of c.frames) {
    const originalFrame = original.frames[frame.sampleIndex];
    if (!originalFrame || originalFrame.timeSec !== frame.timeSec) throw Error('Frame time/index mismatch');
    const rootRotation = new THREE.Quaternion().fromArray(originalFrame.boneTransforms.Hips.parentWorldQuaternion).multiply(anatomicParentInverse);
    root.quaternion.copy(rootRotation).multiply(initialRootRotation); root.position.copy(initialRootPosition);
    applyCustomPose(skin.skeleton, cfg, { ...baseline, bones: { ...baseline.bones, ...frame.engineLocalQuaternions } });
    for (const [key, q] of Object.entries(frame.engineLocalQuaternions) as [string, number[]][]) {
      if (q.length !== 4 || !q.every(Number.isFinite) || Math.abs(Math.hypot(...q) - 1) > 1e-4 || !lookup(key)) throw Error('Invalid transfer quaternion');
      // Include the noncanonical Pelvis helper; no position is fitted here.
      lookup(key).quaternion.fromArray(q);
    }
    root.updateMatrixWorld(true);
    root.position.add(new THREE.Vector3().fromArray(frame.bonePositionsM.Hips).sub(point('Hips'))); root.updateMatrixWorld(true);
    let frameResidual = 0;
    for (const key of Object.keys(names)) {
      if (!frame.bonePositionsM[key]) throw Error('Missing independent position oracle');
      const residual = point(key).distanceTo(new THREE.Vector3().fromArray(frame.bonePositionsM[key]));
      frameResidual = Math.max(frameResidual, residual); maxBoneResidualM = Math.max(maxBoneResidualM, residual);
      recordMaximum(transferResiduals, key, residual, frame);
    }
    const measureRest = rotateRestReferenceByPelvis(rotateRestReferenceByRoot(rest, rootRotation), skin.skeleton, cfg);
    const clinical = computeJointAngles(skin.skeleton, cfg, c.variant, measureRest);
    for (const key of Object.keys(clinical.joints)) if (!names[key]) delete clinical.joints[key];
    const runtimeProjectedShoulders = { L: clinical.joints.L_UpperArm, R: clinical.joints.R_UpperArm };
    const inverseThoraxDelta = lookup('L_Shoulder').parent!.getWorldQuaternion(new THREE.Quaternion()).multiply(thoraxRest.clone().invert()).invert();
    const hands: Record<string, any> = {};
    for (const side of ['L', 'R'] as const) {
      const key = side + '_UpperArm';
      const angles = upperArmWorldAngles(lookup(key).getWorldQuaternion(new THREE.Quaternion()).premultiply(inverseThoraxDelta),
        new THREE.Quaternion().fromArray(rest.worldQuats[key]!), point(side + '_Forearm').sub(point(key)).normalize().applyQuaternion(inverseThoraxDelta),
        new THREE.Vector3().fromArray(rest.worldDirs![key]!), side === 'R');
      clinical.joints[key] = { shoulderFlexion: angles.flexion, shoulderAbduction: angles.abduction, shoulderRotation: angles.rotation };
      const positionResidualM = point(side + '_Hand').distanceTo(new THREE.Vector3().fromArray(c.handBoneAnchorsM[side]));
      const sourceSetup = original.frames[Math.round(c.sampleHz)];
      const orientationResidualDeg = lookup(side + '_Hand').getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(new THREE.Quaternion().fromArray(sourceSetup.boneTransforms[side + '_Hand'].worldQuaternion).normalize()) * 180 / Math.PI;
      hands[side] = { positionResidualM, orientationResidualDeg };
      recordMaximum(geometricResiduals, side + '.handPositionM', positionResidualM, frame);
      recordMaximum(geometricResiduals, side + '.handOrientationDeg', orientationResidualDeg, frame);
      for (const [a, b] of [['UpLeg', 'Leg'], ['Leg', 'Foot'], ['UpperArm', 'Forearm'], ['Forearm', 'Hand']]) {
        const current = point(`${side}_${a}`).distanceTo(point(`${side}_${b}`));
        const sourceLength = new THREE.Vector3().fromArray(originalFrame.bonePositionsM[`${side}_${a}`]).distanceTo(new THREE.Vector3().fromArray(originalFrame.bonePositionsM[`${side}_${b}`]));
        recordMaximum(geometricResiduals, `${side}.${a}-${b}.lengthChangeM`, Math.abs(current - sourceLength), frame);
      }
    }
    const frameViolations: Record<string, any> = {};
    for (const row of ROM_JOINT_ROWS) for (const field of row.fields) {
      if (!names[row.canonicalKey]) continue; // Fingers are not in the transfer contract.
      const value = clinical.joints[row.canonicalKey]?.[field.key];
      if (value == null || !Number.isFinite(value)) throw Error('Missing or invalid clinical field');
      const key = row.canonicalKey + '.' + field.key;
      if (isShoulderFieldMasked(row.canonicalKey, field.key, clinical.joints[row.canonicalKey])) {
        maskedProjectionCounts[key] = (maskedProjectionCounts[key] ?? 0) + 1; continue;
      }
      ranges[key] ??= { min: value, max: value }; ranges[key].min = Math.min(ranges[key].min, value); ranges[key].max = Math.max(ranges[key].max, value);
      const excess = Math.max(field.range.min - value, value - field.range.max, 0);
      if (excess > numericalAngleToleranceDeg) {
        frameViolations[key] = { value, range: field.range, excessDeg: excess };
        if (excess > (violations[key]?.excessDeg ?? 0)) violations[key] = { ...frameViolations[key], timeSec: frame.timeSec, sampleIndex: frame.sampleIndex };
      }
    }
    const endpoint = sourceEndpoints.find(endpoint => Math.abs(endpoint.timeMs - frame.timeSec * 1000) < 1000 / c.sampleHz / 2);
    const endpointTargets = endpoint ? endpoint.targets.map((target: any) => {
      const measured = measureCommandMotion(clinical, target.joint, target.motion, true);
      const errorDeg = measured == null ? null : measured - target.targetDegrees;
      if (errorDeg != null) recordMaximum(targetResiduals, `${target.joint}.${target.motion}`, Math.abs(errorDeg), frame, { targetDegrees: target.targetDegrees, measuredDegrees: measured, signedErrorDeg: errorDeg, sourceKeyframe: endpoint.index });
      return { ...target, measuredDegrees: measured ?? null, errorDeg, masked: measured == null };
    }) : undefined;
    frames.push({ sampleIndex: frame.sampleIndex, timeSec: frame.timeSec, transferResidualM: frameResidual, rootOrientation: rootRotation.toArray(),
      clinical: clinical.joints, runtimeProjectedShoulders, shoulderFrames: clinical.shoulders, violations: frameViolations, hands,
      ...(endpoint ? { sourceEndpoint: endpoint.index, sourceEndpointTargets: endpointTargets } : {}),
      blenderSkinMinimaM: frame.skinMinimaM, fittedHipWorldPitchDeg: frame.fittedHipWorldPitchDeg, fittedElbowGuide: frame.fittedElbowGuide });
  }
  const transferValid = maxBoneResidualM <= transferToleranceM;
  result.cases.push({ variant: c.variant, sourceModelSha256: c.sourceModelSha256, frameCount: c.frames.length,
    transferValid, maxBoneResidualM, transferResiduals, geometricResiduals, ranges, violations, maskedProjectionCounts,
    normativeStatus: !transferValid ? 'invalid-transfer-do-not-interpret' : Object.keys(violations).length ? 'violations' : 'within-reported-registry-fields',
    sourceEndpointTargetResiduals: targetResiduals, frames });
  console.log(c.variant, 'transfer residual mm', maxBoneResidualM * 1000, 'ROM violations', Object.keys(violations));
}
result.sourceDigestAfter = sourceDigest();
result.sourceStableDuringRun = result.sourceDigestAfter === digestBefore;
writeFileSync(resolve(outputArg), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
if (!result.sourceStableDuringRun || result.cases.some((c: any) => !c.transferValid)) process.exitCode = 1;
