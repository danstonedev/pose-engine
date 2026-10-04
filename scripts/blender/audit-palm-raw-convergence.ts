/** Saved actual-state convergence; production iteration budget is unchanged. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { buildFootPlant } from '../../src/services/footContact';
import { computeJointAngles } from '../../src/services/jointAngles';
import { getEffectiveRomRange } from '../../src/services/romConstraints';
import { inspectClinicalAngles, setRomClampEnabled } from '../../src/services/poseRomClamp';
import { solveHandContactPose as original } from './captured-hand-solver-raw-original';
import { solveHandContactPose as traced } from './captured-hand-solver-raw-convergence';

setRomClampEnabled(false);
const [prefix, output] = process.argv.slice(2);
if (!prefix || !output) throw Error('Supply witness prefix and fresh output');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(['poseRomClamp', 'jointAngles', 'footContact', 'handContactPose'].map(name => [name, hash(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url)))]));
const angle = (a: number[], b: number[]) => {
  const q = new THREE.Quaternion().fromArray(a).normalize().conjugate().multiply(new THREE.Quaternion().fromArray(b).normalize());
  return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), Math.abs(q.w)) * 180 / Math.PI;
};
const maximumAngle = (a: number[][], b: number[][]) => Math.max(...a.map((q, i) => angle(q, b[i]!)));
const report: any = { capturedAt: new Date().toISOString(), before: hashes(), scope: 'Frozen coherent raw-J DLS and NNLS model, continuous measured hinge, unchanged objective/epsilon/limits. Compare original40 versus generous offline1000 on saved identical invocation inputs; the production cap is not changed. Final independent feasible-axis probes and projector idempotence are diagnostics, not claims of global optimality.', copies: Object.fromEntries(['raw-original', 'raw-pruned', 'raw-convergence'].map(name => [name, hash(readFileSync(new URL(`./captured-hand-solver-${name}.ts`, import.meta.url)))])), cases: [] };
const bytes = readFileSync(new URL('../../models/painmap3D_neutral.runtime.glb', import.meta.url));
report.assetSha256 = hash(bytes);
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
let skin!: THREE.SkinnedMesh;
root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
report.boneCount = skin.skeleton.bones.length;
for (const deltaDeg of [0, -5e-8, 5e-8]) {
  const input = `${prefix}.neutral.${deltaDeg}.witness.json`, inputBytes = readFileSync(input), capture = JSON.parse(inputBytes.toString('utf8'));
  for (const [ordinal, witness] of capture.witnesses.entries()) {
    const restore = () => {
      for (const entry of witness.objects) {
        const object = entry.path.reduce((node: THREE.Object3D, index: number) => node.children[index]!, root);
        if (object.name !== entry.name || object.type !== entry.type) throw Error(`Rig hierarchy mismatch: ${entry.name}`);
        object.position.fromArray(entry.position); object.quaternion.fromArray(entry.quaternion); object.scale.fromArray(entry.scale);
        object.matrixAutoUpdate = entry.matrixAutoUpdate; object.matrix.fromArray(entry.matrix);
      }
      root.updateMatrixWorld(true);
    };
    restore(); const solver = buildFootPlant(skin, witness.canonicalKeys[0], BODY_VARIANTS.neutral)!;
    if (JSON.stringify(solver.ctx.canonicalKeys) !== JSON.stringify(witness.canonicalKeys)) throw Error('Solver chain mismatch');
    const bones = solver.ctx.bones, initialQuats = bones.map(bone => bone.quaternion.toArray());
    const row: any = { input, inputSha256: hash(inputBytes), deltaDeg, ordinal, invocation: witness.invocation, tMs: witness.tMs, initialQuats, prior: witness.posturePrior, target: witness.target, runs: [] };
    row.initialMeasured = computeJointAngles(skin.skeleton, BODY_VARIANTS.neutral, 'neutral', witness.rest).joints;
    const baselineCase = report.cases.find((entry: any) => entry.deltaDeg === 0 && entry.ordinal === ordinal);
    if (baselineCase) row.initialDifference = { poseDeg: maximumAngle(initialQuats, baselineCase.initialQuats), priorDeg: maximumAngle(witness.posturePrior, baselineCase.prior), targetM: new THREE.Vector3().fromArray(witness.target).distanceTo(new THREE.Vector3().fromArray(baselineCase.target)) };
    const invoke = (fn: typeof original) => fn(solver, new THREE.Vector3().fromArray(witness.target), new THREE.Quaternion().fromArray(witness.orientation), witness.rest, witness.constraints,
      witness.elbowDirection ? new THREE.Vector3().fromArray(witness.elbowDirection) : undefined, witness.minimumElbowY, witness.elbowFlexionRadians,
      witness.posturePrior?.map((q: number[]) => new THREE.Quaternion().fromArray(q)));
    restore(); invoke(original);
    const originalLocals = skin.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
    const originalWorlds = skin.skeleton.bones.map(bone => bone.matrixWorld.toArray());
    for (const budget of [40, 1000]) {
      restore(); (globalThis as any).__iterationBudget = budget; (globalThis as any).__capturedHandTrace = [];
      const started = performance.now(); invoke(traced); const elapsedMs = performance.now() - started;
      const locals = skin.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
      const worlds = skin.skeleton.bones.map(bone => bone.matrixWorld.toArray());
      const quats = bones.map(bone => bone.quaternion.toArray()), points = bones.map(bone => bone.getWorldPosition(new THREE.Vector3()).toArray());
      const measured = computeJointAngles(skin.skeleton, BODY_VARIANTS.neutral, 'neutral', witness.rest).joints;
      const patientViolations = [], unsolvedPatientViolations = [];
      for (const [joint, fields] of Object.entries(witness.constraints ?? {})) for (const field of Object.keys(fields as object)) {
        const actual = measured[joint]?.[field], range = getEffectiveRomRange(witness.constraints, joint, field);
        if (actual !== undefined && range && (actual < range.min - .05 || actual > range.max + .05)) {
          const destination = solver.ctx.canonicalKeys.includes(joint) ? patientViolations : unsolvedPatientViolations;
          destination.push({ joint, field, actual, range, beforeInvocation: row.initialMeasured[joint]?.[field] });
        }
      }
      const result: any = { budget, elapsedMs, quats, points, wristErrorM: new THREE.Vector3().fromArray(points[0]!).distanceTo(new THREE.Vector3().fromArray(witness.target)), measured,
        inspected: Object.fromEntries(bones.map((bone, i) => [solver.ctx.canonicalKeys[i], inspectClinicalAngles(bone, solver.ctx.canonicalKeys[i], witness.rest, witness.constraints)])), patientViolations, unsolvedPatientViolations,
        trace: (globalThis as any).__capturedHandTrace, outputSha256: hash(Buffer.from(JSON.stringify([locals, worlds]))) };
      if (budget === 40) {
        result.exactOriginalLocals = JSON.stringify(locals) === JSON.stringify(originalLocals); result.exactOriginalWorlds = JSON.stringify(worlds) === JSON.stringify(originalWorlds);
        if (!result.exactOriginalLocals || !result.exactOriginalWorlds) throw Error('Diagnostic changed original40 output');
      }
      const baseline = baselineCase?.runs.find((entry: any) => entry.budget === budget);
      if (baseline) result.differenceFromBase = { degrees: maximumAngle(quats, baseline.quats), positionM: Math.max(...points.map((point, i) => new THREE.Vector3().fromArray(point).distanceTo(new THREE.Vector3().fromArray(baseline.points[i])))) };
      if (row.runs.length) result.differenceFrom40 = maximumAngle(quats, row.runs[0].quats);
      row.runs.push(result);
      console.log(JSON.stringify({ deltaDeg, ordinal, budget, initialDifference: row.initialDifference, wristErrorM: result.wristErrorM, differenceFromBase: result.differenceFromBase, differenceFrom40: result.differenceFrom40,
        trace: result.trace.map((trace: any) => ({ iterations: trace.iterations.length, stop: trace.stop, finalCost: trace.finalCost, projection: trace.finalProjectionChangeDeg, idempotence: trace.finalProjectionIdempotenceDeg, bestProbe: [...trace.finalProbes].sort((a, b) => b.improvement - a.improvement)[0] })), patientViolations }));
    }
    report.cases.push(row);
  }
}
report.after = hashes(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
