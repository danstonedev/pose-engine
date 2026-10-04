/** Audit the exact captured playback solve without rerunning its trajectory.
 * <witness-prefix ending .json> <fresh-report.json>
 * Reads prefix.neutral.{0,-5e-8,5e-8}.witness.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clampBoneToRom, inspectClinicalAngles, setRomClampEnabled } from '../../src/services/poseRomClamp';
import { computeJointAngles } from '../../src/services/jointAngles';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { buildFootPlant } from '../../src/services/footContact';
import { solveHandContactPose } from '../../src/services/handContactPose';
import { solveHandContactPose as traceHandContactPose } from './captured-hand-solver-trace';
import { solveHandContactPose as traceHandContactPoseV2 } from './captured-hand-solver-trace-v2';
import { solveHandContactPose as traceHandContactPoseV3 } from './captured-hand-solver-trace-v3';
import { solveHandContactPose as traceConvergence } from './captured-hand-solver-convergence';
import { solveHandContactPose as traceContinuous } from './captured-hand-solver-consistent-contact';
import { clampBoneToRom as continuousClamp, clampMeasuredPatientHinge } from './captured-hinge-continuous-rom-clamp';

setRomClampEnabled(false);
(globalThis as any).__probeEpsilon = Number(process.argv[8] ?? .001);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const files = ['poseRomClamp', 'jointAngles', 'handContactPose', 'footContact', 'motionRigInputKey'];
const hashes = () => Object.fromEntries(files.map(name => [name, digest(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url)))]));
const [prefix, output] = process.argv.slice(2);
const traced = process.argv[4]?.startsWith('trace');
(globalThis as any).__iterationBudget=Number(process.argv[5]??40);(globalThis as any).__rawDirection=process.argv[6]==='raw';(globalThis as any).__continuousProjection=process.argv[7]==='continuous';
if (!prefix || !output) throw Error('Provide witness prefix and fresh report');
const report: any = { derivativeEpsilon: (globalThis as any).__probeEpsilon, offlineSolverSha256:digest(readFileSync(new URL('./captured-hand-solver-consistent-contact.ts',import.meta.url))), scriptSha256:digest(readFileSync(new URL(import.meta.url))), before: hashes(), scope: 'Actual captured neutral patient playback state; per-joint versus full-chain clinical projection. Explicit diagnostic finite difference epsilon in report and existing clinical/patient limits. No production edits.', cases: [] };
const quaternionAngle = (a: THREE.Quaternion, b: THREE.Quaternion) => {
  const delta = a.clone().normalize().conjugate().multiply(b.clone().normalize());
  return 2 * Math.atan2(Math.hypot(delta.x, delta.y, delta.z), Math.abs(delta.w)) * 180 / Math.PI;
};
for (const deltaDeg of [0, -5e-8, 5e-8]) {
  const inputBytes = readFileSync(`${prefix}.neutral.${deltaDeg}.witness.json`), capture = JSON.parse(inputBytes.toString('utf8'));
  const bytes = readFileSync(new URL('../../models/painmap3D_neutral.runtime.glb', import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  for (const [invocationOrdinal, witness] of capture.witnesses.entries()) {
    for (const entry of witness.objects) {
      const object = entry.path.reduce((node: THREE.Object3D, child: number) => node.children[child]!, root);
      if (object.name !== entry.name || object.type !== entry.type) throw Error(`Rig hierarchy mismatch: ${entry.name}`);
      object.position.fromArray(entry.position); object.quaternion.fromArray(entry.quaternion); object.scale.fromArray(entry.scale);
      object.matrixAutoUpdate = entry.matrixAutoUpdate; object.matrix.fromArray(entry.matrix);
    }
    root.updateMatrixWorld(true);
    const bones = witness.boneNames.map((name: string) => root.getObjectByName(name) as THREE.Bone), keys = witness.canonicalKeys;
    let skin!: THREE.SkinnedMesh; root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
    const clone = () => bones.map((bone: THREE.Bone) => bone.quaternion.clone());
    const restore = (pose: THREE.Quaternion[]) => { bones.forEach((bone: THREE.Bone, index: number) => bone.quaternion.copy(pose[index]!)); root.updateMatrixWorld(true); };
    const jointProjection = (index: number) => {
      ((globalThis as any).__continuousProjection ? continuousClamp : clampBoneToRom)(bones[index], keys[index], witness.rest, witness.constraints, true);
      if (index + 1 < bones.length) clampMeasuredPatientHinge(bones[index + 1], bones[index], keys[index], witness.rest, witness.constraints);
    };
    const projectAll = () => { for (let joint = bones.length - 1; joint >= 0; joint--) jointProjection(joint); root.updateMatrixWorld(true); };
    const compare = (a: THREE.Quaternion[], b: THREE.Quaternion[]) => a.map((quat, index) => ({ key: keys[index], degrees: quaternionAngle(quat, b[index]!) })).sort((a, b) => b.degrees - a.degrees);
    const clinical = () => ({ clampFields: Object.fromEntries(bones.map((bone: THREE.Bone, index: number) => [keys[index], inspectClinicalAngles(bone, keys[index], witness.rest, witness.constraints)])),
      measured: computeJointAngles(skin.skeleton, BODY_VARIANTS.neutral, 'neutral', witness.rest).joints });
    const residual = () => {
      root.updateMatrixWorld(true);
      const point = bones[0].getWorldPosition(new THREE.Vector3()).sub(new THREE.Vector3().fromArray(witness.target));
      const rotation = new THREE.Quaternion().fromArray(witness.orientation).multiply(bones[0].getWorldQuaternion(new THREE.Quaternion()).invert());
      if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
      const length = Math.hypot(rotation.x, rotation.y, rotation.z), factor = length > 1e-10 ? -.12 * 2 * Math.atan2(length, rotation.w) / length : -.24;
      const values = [point.x, point.y, point.z, rotation.x * factor, rotation.y * factor, rotation.z * factor];
      if (witness.minimumElbowY != null) values.push(Math.min(0, bones[1].getWorldPosition(new THREE.Vector3()).y - witness.minimumElbowY));
      for (let joint = 0; joint < bones.length; joint++) {
        const q = new THREE.Quaternion().fromArray(witness.posturePrior[joint]).invert().multiply(bones[joint].quaternion).normalize();
        if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        const length = Math.hypot(q.x, q.y, q.z), factor = length > 1e-10 ? .012 * 2 * Math.atan2(length, q.w) / length : .024;
        values.push(q.x * factor, q.y * factor, q.z * factor);
      }
      return values;
    };
    const before = clone(); projectAll(); const first = clone(), firstClinical = clinical();
    projectAll(); const second = clone(), secondClinical = clinical();
    const row: any = { deltaDeg, invocationOrdinal, invocation: witness.invocation, tMs: witness.tMs, capturedSourceDigest: capture.sourceBefore, inputSha256: digest(inputBytes), assetSha256: digest(bytes),
      initialProjection: compare(before, first), secondProjection: compare(first, second), firstClinical, secondClinical, probes: [] };
    for (let joint = 0; joint < bones.length; joint++) for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      restore(first); const direction = new THREE.Vector3().setComponent(axis, 1);
      bones[joint].quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(direction, sign * .001));
      jointProjection(joint); const partialPose = clone(), partialResidual = residual(), partialClinical = clinical();
      // Compare the projected proposal used by the accepted step at exactly
      // the same raw perturbation, not a second projection of its partial result.
      restore(first); bones[joint].quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(direction, sign * .001));
      projectAll(); const fullPose = clone(), fullResidual = residual();
      row.probes.push({ joint: keys[joint], axis, sign, poseDifference: compare(partialPose, fullPose),
        residualDifferenceNorm: Math.hypot(...partialResidual.map((value, i) => value - fullResidual[i]!)),
        finiteDifferenceColumnDifferenceNorm: Math.hypot(...partialResidual.map((value, i) => (value - fullResidual[i]!) / .001)),
        partialClinical, fullClinical: clinical() });
    }
    row.probes.sort((a: any, b: any) => b.finiteDifferenceColumnDifferenceNorm - a.finiteDifferenceColumnDifferenceNorm);
    restore(witness.after.map((q: number[]) => new THREE.Quaternion().fromArray(q)));
    const finalPose = clone(); projectAll(); row.finalReprojection = compare(finalPose, clone());
    const solver = buildFootPlant(skin, keys[0], BODY_VARIANTS.neutral)!;
    if (JSON.stringify(solver.ctx.canonicalKeys) !== JSON.stringify(keys)) throw Error('Captured and reconstructed chains differ');
    restore(before);
    const started = performance.now();
    (globalThis as any).__capturedHandTrace = [];
    (process.argv[4] === 'trace5' ? traceContinuous : process.argv[4] === 'trace4' ? traceConvergence : process.argv[4] === 'trace3' ? traceHandContactPoseV3 : process.argv[4] === 'trace2' ? traceHandContactPoseV2 : traced ? traceHandContactPose : solveHandContactPose)(solver, new THREE.Vector3().fromArray(witness.target), new THREE.Quaternion().fromArray(witness.orientation),
      witness.rest, witness.constraints, witness.elbowDirection ? new THREE.Vector3().fromArray(witness.elbowDirection) : undefined, witness.minimumElbowY, witness.elbowFlexionRadians,
      witness.posturePrior.map((q: number[]) => new THREE.Quaternion().fromArray(q)));
    row.currentSolve = { elapsedMs: performance.now() - started, quats: clone().map((q: THREE.Quaternion) => q.toArray()),
      points: bones.map((bone: THREE.Bone) => bone.getWorldPosition(new THREE.Vector3()).toArray()), clinical: clinical(),
      wristErrorM: bones[0].getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(witness.target)),
      changeFromStoredOldSolve: compare(finalPose, clone()), ...(traced ? { trace: (globalThis as any).__capturedHandTrace } : {}) };
    const baselineCase = report.cases.find((entry: any) => entry.deltaDeg === 0 && entry.invocationOrdinal === invocationOrdinal);
    if (baselineCase) {
      const baseline = baselineCase.currentSolve;
      row.currentSolve.differenceFromBase = compare(baseline.quats.map((q: number[]) => new THREE.Quaternion().fromArray(q)), clone());
      row.currentSolve.positionDifferenceFromBaseM = Math.max(...row.currentSolve.points.map((p: number[], index: number) => new THREE.Vector3().fromArray(p).distanceTo(new THREE.Vector3().fromArray(baseline.points[index]))));
    }
    report.cases.push(row);
    console.log(JSON.stringify({ deltaDeg, secondProjection: row.secondProjection[0], worstProbe: {
      joint: row.probes[0].joint, axis: row.probes[0].axis, sign: row.probes[0].sign, poseDifference: row.probes[0].poseDifference[0], columnDifference: row.probes[0].finiteDifferenceColumnDifferenceNorm,
    }, finalReprojection: row.finalReprojection[0], currentSolve: { elapsedMs: row.currentSolve.elapsedMs,
      wristErrorM: row.currentSolve.wristErrorM, changeFromStoredOldSolve: row.currentSolve.changeFromStoredOldSolve[0],
      differenceFromBase: row.currentSolve.differenceFromBase?.[0], positionDifferenceFromBaseM: row.currentSolve.positionDifferenceFromBaseM } }));
  }
}
report.after = hashes(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
