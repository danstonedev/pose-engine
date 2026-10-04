import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference, measureHingeFlexion } from '../../src/services/jointAngles';
import { buildComposedCommandPose } from '../../src/services/movementCommand';
import { clampContactHingeToRom as original, inspectClinicalAngles, setRomClampEnabled } from '../../src/services/poseRomClamp';
import { clampContactHingeToRom as candidate } from './captured-parent-local-clamp';
import { createParentLocalHingeReadout, localReadoutCounts } from './captured-parent-local-hinge';
import { getEffectiveRomRange } from '../../src/services/romConstraints';

setRomClampEnabled(false);
const output = process.argv[2]; if (!output) throw Error('Fresh report required');
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const identities = () => Object.fromEntries(['poseRomClamp', 'jointAngles', 'handContactPose'].map(name => [name, hash(`src/services/${name}.ts`)]));
const rotationDistance = (a: THREE.Quaternion, b: THREE.Quaternion) => {
  const q = a.clone().normalize().conjugate().multiply(b.clone().normalize());
  return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), Math.abs(q.w)) * 180 / Math.PI;
};
const violation = (value: number, range: { min: number; max: number }) => Math.max(range.min - value, value - range.max, 0);
const report: any = { before: identities(), scope: 'OFFLINE approximate rotational-invariance hypothesis. Actual default and normalized-ancestor worlds compared; exact clinical bounds and prior solver budgets unchanged. Raw strict residuals retained, no acceptance inferred.',
  derivation: 'For world parent linear transform sR with s>0 and R orthogonal, world directions normalize(R p) and normalize(R Q c), and world hinge axis normalize(R a); signed projected angle equals parent-local angle(p,Q c,a). Nonunit Float32 ancestor quaternions can make the actual world linear map slightly nonorthogonal; translation/subtraction and normalization order also differ.',
  cases: [], models: {} };
for (const variant of ['male', 'female', 'neutral'] as const) {
  const path = `models/painmap3D_${variant}.runtime.glb`, bytes = readFileSync(path), cfg = BODY_VARIANTS[variant];
  report.models[variant] = hash(path);
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin!: THREE.SkinnedMesh; root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
  const rest = captureJointAngleRestReference(skin.skeleton, cfg), baseline = serializeCustomPose(skin.skeleton, cfg, variant), bones = buildBoneByPoseKey(skin.skeleton, cfg);
  for (const normalizedAncestors of [false, true]) for (const side of ['L', 'R']) for (const limb of ['elbow', 'knee']) for (const mode of ['default', 'ranged', 'locked']) {
    const key = `${side}_${limb === 'elbow' ? 'Forearm' : 'Leg'}`, parent = bones.get(`${side}_${limb === 'elbow' ? 'UpperArm' : 'UpLeg'}`)!, bone = bones.get(key)!;
    const field = limb === 'elbow' ? 'elbowFlexion' : 'kneeFlexion', deviation = limb === 'elbow' ? 'elbowDeviation' : 'kneeDeviation', rotation = limb === 'elbow' ? 'forearmRotation' : 'kneeRotation';
    const constraints = mode === 'default' ? null : { [key]: { [field]: { availableRange: mode === 'locked' ? { min: 40, max: 40 } : { min: 25, max: 80 } } } };
    const range = getEffectiveRomRange(constraints, key, field)!;
    for (const authoredDegrees of [range.min - 5, range.max + 5, -180.001, -179.999, -179, 179, 179.999, 180.001]) for (const offSign of [-1, 1]) {
      const pose = buildComposedCommandPose(baseline, key, [{ motion: field, degrees: authoredDegrees }, { motion: deviation, degrees: offSign * 12 }, { motion: rotation, degrees: offSign * 35 }], cfg, baseline, rest)!;
      applyCustomPose(skin.skeleton, cfg, pose); root.position.set(.3, -.2, .1); root.quaternion.setFromEuler(new THREE.Euler(.8, .3, -.2));
      if (normalizedAncestors) for (let node: THREE.Object3D | null = parent; node; node = node.parent) node.quaternion.normalize();
      root.updateMatrixWorld(true);
      const localReadout = createParentLocalHingeReadout(parent, bone, key, rest);
      const initial = bone.quaternion.clone(), initialWorld = measureHingeFlexion(parent, bone, key, rest)!, initialLocal = localReadout?.measure();
      const evaluate = (project: typeof original) => {
        bone.quaternion.copy(initial); root.updateMatrixWorld(true);
        const started = performance.now(); project(parent, bone, key, rest, constraints, { currentMatrixReadback: true });
        const elapsedMs = performance.now() - started, q = bone.quaternion.clone();
        const measured = measureHingeFlexion(parent, bone, key, rest)!, channels = inspectClinicalAngles(bone, key, rest, constraints)!;
        project(parent, bone, key, rest, constraints, { currentMatrixReadback: true });
        return { elapsedMs, q: q.toArray(), measured,
          strictFlexionErrorDeg: violation(measured, range), strictDeviationErrorDeg: violation(channels.raw.abduction, channels.ranges.abduction!),
          strictTwistErrorDeg: violation(channels.raw.rotation, channels.ranges.rotation!), repeatDriftDeg: rotationDistance(q, bone.quaternion) };
      };
      const a = evaluate(original), b = evaluate(candidate);
      report.cases.push({ variant, key, mode, authoredDegrees, offSign, normalizedAncestors,
        eligible: !!localReadout, distortion: localReadout?.distortion, continuation: localReadout?.continuationNode,
        initialWorld, initialLocal, rawReadoutDifferenceDeg: initialLocal == null ? null : initialLocal - initialWorld,
        projectionTurnDifferenceDeg: rotationDistance(new THREE.Quaternion().fromArray(a.q), new THREE.Quaternion().fromArray(b.q)), original: a, candidate: b });
    }
  }
}
report.after = identities(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
report.counts = localReadoutCounts;
report.summary = Object.fromEntries([false, true].map(normalized => {
  const rows = report.cases.filter((row: any) => row.normalizedAncestors === normalized);
  return [normalized ? 'normalizedAncestors' : 'actualAncestors', { cases: rows.length, eligible: rows.filter((r: any) => r.eligible).length,
    maximumReadoutDifferenceDeg: Math.max(...rows.map((r: any) => Math.abs(r.rawReadoutDifferenceDeg ?? 0))),
    maximumProjectionTurnDifferenceDeg: Math.max(...rows.map((r: any) => r.projectionTurnDifferenceDeg)),
    maximumCandidateStrictViolationDeg: Math.max(...rows.map((r: any) => Math.max(r.candidate.strictFlexionErrorDeg, r.candidate.strictDeviationErrorDeg, r.candidate.strictTwistErrorDeg))),
    maximumRepeatDriftDeg: Math.max(...rows.map((r: any) => r.candidate.repeatDriftDeg)),
    originalMs: rows.reduce((s: number, r: any) => s + r.original.elapsedMs, 0), candidateMs: rows.reduce((s: number, r: any) => s + r.candidate.elapsedMs, 0) }];
}));
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ sourceStable: report.sourceStable, summary: report.summary, counts: report.counts }));
