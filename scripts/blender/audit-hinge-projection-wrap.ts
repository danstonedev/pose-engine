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
import { clampBoneToRom, clampMeasuredHingeToRom, clampContactHingeToRom, inspectClinicalAngles, setRomClampEnabled } from '../../src/services/poseRomClamp';
import { getEffectiveRomRange } from '../../src/services/romConstraints';

setRomClampEnabled(false);
const output = process.argv[2]; if (!output) throw Error('Fresh output path required');
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const identity = () => hash(readFileSync(new URL('../../src/services/poseRomClamp.ts', import.meta.url)));
const angle = (a: THREE.Quaternion, b: THREE.Quaternion) => { const q = a.clone().normalize().conjugate().multiply(b.clone().normalize()); return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), Math.abs(q.w)) * 180 / Math.PI; };
const violation = (value: number, range: { min: number; max: number }) => Math.max(range.min - value, value - range.max, 0);
const report: any = { before: identity(), scope: 'Near-wrap authored ?179 / ?179.999 / ?180.001 degree inputs with coupled off-axis channels. Actual first-call residual must be inspected; boolean change does not imply scalar convergence. Offline sequence diagnostic only: 4 consecutive calls to the candidate sole-owner contact hinge projection (two per recorded pass). Records strict geometric/deviation/engineering-twist residuals after each call; afterLocal and afterMeasured field names are retained for comparison but both call the same new projector; does not change runtime iteration semantics or tolerances.', cases: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url)), cfg = BODY_VARIANTS[variant];
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin!: THREE.SkinnedMesh; root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
  const rest = captureJointAngleRestReference(skin.skeleton, cfg), baseline = serializeCustomPose(skin.skeleton, cfg, variant), bones = buildBoneByPoseKey(skin.skeleton, cfg);
  for (const side of ['L', 'R']) for (const limb of ['elbow', 'knee']) for (const mode of ['default', 'ranged', 'locked']) for (const authoredDeg of [-180.001, -179.999, -179, 179, 179.999, 180.001]) for (const offSign of [-1, 1]) {
    const key = `${side}_${limb === 'elbow' ? 'Forearm' : 'Leg'}`, parent = bones.get(`${side}_${limb === 'elbow' ? 'UpperArm' : 'UpLeg'}`)!, bone = bones.get(key)!;
    const field = limb === 'elbow' ? 'elbowFlexion' : 'kneeFlexion', deviation = limb === 'elbow' ? 'elbowDeviation' : 'kneeDeviation', rotation = limb === 'elbow' ? 'forearmRotation' : 'kneeRotation';
    const sign = authoredDeg < 0 ? -1 : 1;
    const constraints = mode === 'default' ? null : { [key]: { [field]: { availableRange: mode === 'locked' ? { min: 40, max: 40 } : { min: 25, max: 80 } } } };
    const range = getEffectiveRomRange(constraints, key, field)!, target = sign < 0 ? range.min : range.max;
    const pose = buildComposedCommandPose(baseline, key, [{ motion: field, degrees: authoredDeg }, { motion: deviation, degrees: offSign * 12 }, { motion: rotation, degrees: offSign * 35 }], cfg, baseline, rest)!;
    applyCustomPose(skin.skeleton, cfg, pose); root.quaternion.setFromEuler(new THREE.Euler(.8, .3, -.2)); root.updateMatrixWorld(true);
    const measured = () => { const geometric = measureHingeFlexion(parent, bone, key, rest)!, local = inspectClinicalAngles(bone, key, rest, constraints)!;
      const flexionViolation = violation(geometric, range), deviationViolation = violation(local.raw.abduction, local.ranges.abduction), twistViolation = violation(local.raw.rotation, local.ranges.rotation!);
      return { geometric, localFlexion: local.anatomicFlexion, deviation: local.raw.abduction, twist: local.raw.rotation,
        flexionViolation, deviationViolation, twistViolation, maximumViolation: Math.max(flexionViolation, deviationViolation, twistViolation) }; };
    const passes = [], initial = measured();
    for (let pass = 0; pass < 2; pass++) {
      const before = bone.quaternion.clone();
      clampContactHingeToRom(parent, bone, key, rest, constraints);
      const afterLocal = measured(), localQ = bone.quaternion.clone();
      clampContactHingeToRom(parent, bone, key, rest, constraints);
      const afterMeasured = measured();
      passes.push({ pass, afterLocal, afterMeasured, localTurnDeg: angle(before, localQ), measuredTurnDeg: angle(localQ, bone.quaternion), combinedTurnDeg: angle(before, bone.quaternion) });
    }
    report.cases.push({ variant, key, mode, sign, authoredDeg, offSign, range, initial, passes });
  }
}
report.after = identity(); report.sourceStable = report.before === report.after;
report.summary = Object.fromEntries(['default', 'ranged', 'locked'].map(mode => {
  const rows = report.cases.filter((row: any) => row.mode === mode);
  return [mode, { cases: rows.length,
    maximumAfterFirstLocalViolation: Math.max(...rows.map((r: any) => r.passes[0].afterLocal.maximumViolation)),
    maximumAfterFirstMeasuredViolation: Math.max(...rows.map((r: any) => r.passes[0].afterMeasured.maximumViolation)),
    maximumAfterSecondLocalViolation: Math.max(...rows.map((r: any) => r.passes[1].afterLocal.maximumViolation)),
    maximumAfterFinalMeasuredViolation: Math.max(...rows.map((r: any) => r.passes.at(-1).afterMeasured.maximumViolation)),
    maximumFinalCombinedTurnDeg: Math.max(...rows.map((r: any) => r.passes.at(-1).combinedTurnDeg)),
    maximumFinalLocalTurnDeg: Math.max(...rows.map((r: any) => r.passes.at(-1).localTurnDeg)),
    maximumFinalMeasuredTurnDeg: Math.max(...rows.map((r: any) => r.passes.at(-1).measuredTurnDeg)) }];
}));
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ sourceStable: report.sourceStable, cases: report.cases.length, summary: report.summary }));
