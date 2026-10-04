/** Diagnostic only: exact patient-limit reconstruction threshold on a saved rig. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clampMeasuredPatientHinge } from '../../src/services/poseRomClamp';
import { measureHingeFlexion } from '../../src/services/jointAngles';
import { clampMeasuredPatientHinge as continuousHinge } from './captured-hinge-continuous-rom-clamp';

const [witnessPath, output] = process.argv.slice(2);
if (!witnessPath || !output) throw Error('Provide saved witness and fresh report');
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = readFileSync(witnessPath), witness = JSON.parse(bytes.toString()).witnesses[0];
const asset = readFileSync(new URL('../../models/painmap3D_neutral.runtime.glb', import.meta.url));
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.byteLength), '')).scene;
for (const entry of witness.objects) {
  const object = entry.path.reduce((node: THREE.Object3D, child: number) => node.children[child]!, root);
  object.position.fromArray(entry.position); object.quaternion.fromArray(entry.quaternion); object.scale.fromArray(entry.scale);
  object.matrixAutoUpdate = entry.matrixAutoUpdate; object.matrix.fromArray(entry.matrix);
}
root.updateMatrixWorld(true);
const bones = witness.boneNames.map((name: string) => root.getObjectByName(name) as THREE.Bone);
const forearm = bones[1]!, parent = bones[2]!, key = witness.canonicalKeys[1], before = forearm.quaternion.clone();
const axis = new THREE.Vector3().fromArray(witness.rest.hingeAxes[key])
  .applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()))
  .applyQuaternion(forearm.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
const angle = (a: THREE.Quaternion, b: THREE.Quaternion) => {
  const q = a.clone().normalize().invert().multiply(b.clone().normalize());
  return THREE.MathUtils.radToDeg(2 * Math.atan2(Math.hypot(q.x, q.y, q.z), Math.abs(q.w)));
};
const report: any = { scope: 'Saved neutral arm; only measured patient elbow projection. Actual patient125-degree upper limit unchanged. Artificial tiny offsets expose the numerical reconstruction threshold, not a movement acceptance test.',
  witnessSha256: hash(bytes), assetSha256: hash(asset), scriptSha256: hash(readFileSync(new URL(import.meta.url))),
  productionProjectorSha256: hash(readFileSync(new URL('../../src/services/poseRomClamp.ts', import.meta.url))),
  diagnosticProjectorSha256: hash(readFileSync(new URL('./captured-hinge-continuous-rom-clamp.ts', import.meta.url))), cases: [] };
const upper = witness.constraints[key].elbowFlexion.availableRange.max;
for (const offset of [0, 1e-7 - 1e-10, 1e-7 + 1e-10, 2e-7]) for (const mode of ['ordinary', 'continuous']) {
  forearm.quaternion.copy(before); root.updateMatrixWorld(true);
  for (let i = 0; i < 4; i++) {
    const current = measureHingeFlexion(parent, forearm, key, witness.rest)!;
    forearm.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, -(upper + offset - current) * Math.PI / 180)).normalize();
    root.updateMatrixWorld(true);
  }
  const input = forearm.quaternion.clone(), inputFlexion = measureHingeFlexion(parent, forearm, key, witness.rest);
  const project = mode === 'ordinary' ? clampMeasuredPatientHinge : continuousHinge;
  const changed = project(parent, forearm, key, witness.rest, witness.constraints);
  const first = forearm.quaternion.clone(), outputFlexion = measureHingeFlexion(parent, forearm, key, witness.rest);
  project(parent, forearm, key, witness.rest, witness.constraints);
  report.cases.push({ mode, intendedOffsetDeg: offset, inputFlexion, outputFlexion, changed,
    correctionDeg: angle(input, first), idempotenceDeg: angle(first, forearm.quaternion), input: input.toArray(), output: first.toArray() });
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report.cases.map(({ input, output, ...row }: any) => row), null, 2));
