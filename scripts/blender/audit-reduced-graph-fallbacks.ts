import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { buildFootPlant } from '../../src/services/footContact';
import { measureHingeFlexion } from '../../src/services/jointAngles';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
import { solveHandContactPose as original } from './captured-hand-solver-current-graph-original';
import { solveHandContactPose as candidate } from './captured-hand-solver-current-graph-reduced';

setRomClampEnabled(false);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(new URL('../../models/painmap3D_neutral.runtime.glb', import.meta.url));
const witnessBytes = readFileSync(process.argv[2]!), witness = JSON.parse(witnessBytes.toString('utf8')).witnesses[0];
const report: any = { scope: 'Read-only production-safety review of frozen reduced graph. Original actual neutral rig state with deliberately unusual supported object/custom geometry conditions. Differences identify required eligibility/fallback guards; no runtime changes.', assetSha256: hash(bytes), witnessSha256: hash(witnessBytes), cases: [] };
for (const kind of ['ordinary', 'zero hand offset', 'collapsed forearm helpers and hand', 'cyclic userData', 'custom world getter', 'manual local matrix', 'manual world matrix', 'manual parent matrix', 'nonuniform parent scale']) {
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  for (const entry of witness.objects) {
    const node = entry.path.reduce((node: THREE.Object3D, i: number) => node.children[i]!, root);
    node.position.fromArray(entry.position); node.quaternion.fromArray(entry.quaternion); node.scale.fromArray(entry.scale);
    node.matrixAutoUpdate = entry.matrixAutoUpdate; node.matrix.fromArray(entry.matrix);
  }
  root.updateMatrixWorld(true);
  let skin!: THREE.SkinnedMesh; root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
  const solver = buildFootPlant(skin, witness.canonicalKeys[0], BODY_VARIANTS.neutral)!;
  const [hand, forearm, upper, shoulder] = solver.ctx.bones;
  if (kind === 'zero hand offset') hand!.position.set(0, 0, 0);
  if (kind === 'collapsed forearm helpers and hand') {
    const collapse = (node: THREE.Object3D) => { node.position.set(0, 0, 0); if (node !== hand) node.children.forEach(collapse); };
    forearm!.children.forEach(collapse);
  }
  if (kind === 'cyclic userData') shoulder!.userData.cycle = shoulder;
  if (kind === 'custom world getter') upper!.getWorldQuaternion = function(out) {
    THREE.Object3D.prototype.getWorldQuaternion.call(this, out);
    return out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .02));
  };
  if (kind === 'manual local matrix') forearm!.matrixAutoUpdate = false;
  if (kind === 'manual world matrix') forearm!.matrixWorldAutoUpdate = false;
  if (kind === 'manual parent matrix') { shoulder!.parent!.matrixAutoUpdate = false; shoulder!.parent!.matrixWorldAutoUpdate = false; }
  if (kind === 'nonuniform parent scale') shoulder!.parent!.scale.set(.97, 1.02, 1.01);
  root.updateMatrixWorld(true);
  const before = skin.skeleton.bones.map(bone => ({ p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone(), m: bone.matrix.clone(), w: bone.matrixWorld.clone() }));
  const restore = () => { skin.skeleton.bones.forEach((bone, i) => { const x = before[i]!; bone.position.copy(x.p); bone.quaternion.copy(x.q); bone.scale.copy(x.s); bone.matrix.copy(x.m); bone.matrixWorld.copy(x.w); }); root.updateWorldMatrix(true, true); };
  const hingeFull = measureHingeFlexion(upper!, forearm!, witness.canonicalKeys[1], witness.rest);
  const children = hand!.children; hand!.children = [];
  const hingeWithoutFingers = measureHingeFlexion(upper!, forearm!, witness.canonicalKeys[1], witness.rest); hand!.children = children;
  const invoke = (fn: typeof original) => fn(solver, new THREE.Vector3().fromArray(witness.target), new THREE.Quaternion().fromArray(witness.orientation), witness.rest, witness.constraints,
    witness.elbowDirection ? new THREE.Vector3().fromArray(witness.elbowDirection) : undefined, witness.minimumElbowY, witness.elbowFlexionRadians,
    witness.posturePrior?.map((q: number[]) => new THREE.Quaternion().fromArray(q)));
  const snapshot = () => skin.skeleton.bones.map(bone => [...bone.quaternion.toArray(), ...bone.matrixWorld.toArray()]);
  const run = (fn: typeof original) => { restore(); try { const result = invoke(fn); return { result, state: snapshot() }; } catch (error) { return { error: String(error) }; } };
  const a = run(original), b = run(candidate);
  const row: any = { kind, hingeFull, hingeWithoutFingers, originalError: a.error, candidateError: b.error,
    sameResult: JSON.stringify(a.result) === JSON.stringify(b.result), sameState: JSON.stringify(a.state) === JSON.stringify(b.state) };
  if (a.state && b.state) row.maximumQuaternionDifferenceDeg = Math.max(...a.state.map((bone, i) => {
    const delta = new THREE.Quaternion().fromArray(bone).normalize().conjugate().multiply(new THREE.Quaternion().fromArray(b.state![i]!).normalize());
    return 2 * Math.atan2(Math.hypot(delta.x, delta.y, delta.z), Math.abs(delta.w)) * 180 / Math.PI;
  }));
  report.cases.push(row); console.log(JSON.stringify(row));
}
writeFileSync(process.argv[3]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
