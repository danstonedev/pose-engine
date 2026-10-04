import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { buildHandPlant } from '../../src/services/footContact';
import { computeJointAngles } from '../../src/services/jointAngles';
import { solveHandContactPose } from './captured-hand-solver-clinical-initial-prior';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Supply browser witness and fresh report');
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = readFileSync(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url));
const inputBytes = readFileSync(input), captures = JSON.parse(inputBytes.toString('utf8'));
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
let skin!: THREE.SkinnedMesh; root.traverse(n => { if (!skin && (n as THREE.SkinnedMesh).isSkinnedMesh) skin = n as THREE.SkinnedMesh; });
const report: any = { scope: 'Offline explicit initial-posture policy candidate on the exact browser setup pair; same40-step cap/objective weights/clinical bounds. This is not source promotion or motion acceptance.', inputSha256: hash(inputBytes), assetSha256: hash(bytes), solverSha256: hash(readFileSync(new URL('./captured-hand-solver-clinical-initial-prior.ts', import.meta.url))), cases: [] };
for (const mode of ['independent', 'stage']) {
  const w = captures.find((row: any) => row.mode === mode && row.tMs === 0 && !row.posturePrior);
  if (!w) throw Error('Missing first no-prior setup');
  for (const entry of w.objects) {
    const node = entry.path.reduce((current: THREE.Object3D, index: number) => current.children[index]!, root);
    if (node.name !== entry.name) throw Error('Hierarchy mismatch');
    node.position.fromArray(entry.position); node.quaternion.fromArray(entry.quaternion); node.scale.fromArray(entry.scale); node.matrixAutoUpdate = entry.matrixAutoUpdate; node.matrix.fromArray(entry.matrix);
  }
  root.updateMatrixWorld(true);
  const solver = buildHandPlant(skin, w.canonicalKeys[0], BODY_VARIANTS.male)!;
  const result = solveHandContactPose(solver, new THREE.Vector3().fromArray(w.target), new THREE.Quaternion().fromArray(w.orientation), w.rest, w.constraints,
    w.elbowDirection ? new THREE.Vector3().fromArray(w.elbowDirection) : undefined, w.minimumElbowY, w.elbowFlexionRadians, undefined);
  const after = solver.ctx.bones.map(b => b.quaternion.toArray());
  const angle = (a: number[], b: number[]) => { const q = new THREE.Quaternion().fromArray(a).normalize().conjugate().multiply(new THREE.Quaternion().fromArray(b).normalize()); return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), Math.abs(q.w)) * 180 / Math.PI; };
  const row = { mode, result, after, maximumDifferenceDeg: report.cases.length ? Math.max(...after.map((q, i) => angle(q, report.cases[0].after[i]))) : null,
    angles: computeJointAngles(skin.skeleton, BODY_VARIANTS.male, 'male', w.rest).joints };
  report.cases.push(row); console.log(JSON.stringify(row));
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
