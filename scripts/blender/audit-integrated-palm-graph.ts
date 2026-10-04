/** Compare frozen hand solvers on actual retained invocation inputs. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { buildFootPlant } from '../../src/services/footContact';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
import { solveHandContactPose as original } from './captured-hand-solver-guarded-original';
import { solveHandContactPose as candidate } from '../../src/services/handContactPose';
const graphCounts = { scope: 'Production wrapper; eligibility proved independently in guarded helper comparison' };

setRomClampEnabled(false);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const src = new URL('../../src/', import.meta.url);
const hashes = () => Object.fromEntries(readdirSync(src, { recursive: true }).map(String).filter(name => !name.includes('__tests__') && /\.(?:[cm]?ts|svelte|[cm]?js)$/.test(name)).sort().map(name => [name.replaceAll('\\', '/'), digest(readFileSync(new URL(name.replaceAll('\\', '/'), src)))]));
const variant = (process.argv.find(value => value.startsWith('--variant='))?.slice(10) ?? 'neutral') as keyof typeof BODY_VARIANTS;
if (!['male','female','neutral'].includes(variant)) throw Error('Invalid body');
const [output, ...prefixes] = process.argv.slice(2).filter(value => !value.startsWith('--variant='));
if (!output || !prefixes.length) throw Error('Provide fresh report path and witness prefixes');
const report: any = { scope: 'Frozen pre-integration production solver versus actual integrated production solver. Copy only solved joint rotations back, then full original root update. Exact all101 local/world comparison, no production changes; timing diagnostic only.',
  capturedAt: new Date().toISOString(), before: hashes(), copies: Object.fromEntries(['guarded-original', 'guarded-reduced'].map(kind => [kind,
    digest(readFileSync(new URL(`./captured-hand-solver-${kind}.ts`, import.meta.url)))])), cases: [] };
const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
report.variant = variant; report.assetSha256 = digest(bytes);
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
let skin!: THREE.SkinnedMesh;
root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
for (const prefix of prefixes) for (const deltaDeg of [0, -5e-8, 5e-8]) {
  const input = `${prefix}.${variant}.${deltaDeg}.witness.json`, inputBytes = readFileSync(input);
  const capture = JSON.parse(inputBytes.toString('utf8'));
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
    restore();
    const solver = buildFootPlant(skin, witness.canonicalKeys[0], BODY_VARIANTS[variant])!;
    if (JSON.stringify(solver.ctx.canonicalKeys) !== JSON.stringify(witness.canonicalKeys)) throw Error('Solver chain mismatch');
    const solve = (fn: typeof original) => {
      restore(); const started = performance.now();
      const result = fn(solver, new THREE.Vector3().fromArray(witness.target), new THREE.Quaternion().fromArray(witness.orientation), witness.rest,
        witness.constraints, witness.elbowDirection ? new THREE.Vector3().fromArray(witness.elbowDirection) : undefined,
        witness.minimumElbowY, witness.elbowFlexionRadians,
        witness.posturePrior?.map((value: number[]) => new THREE.Quaternion().fromArray(value)));
      const elapsedMs = performance.now() - started;
      return { elapsedMs, result, locals: skin.skeleton.bones.map(bone => [bone.name, bone.position.toArray(), bone.quaternion.toArray(), bone.scale.toArray()]),
        worlds: skin.skeleton.bones.map(bone => [bone.name, bone.matrixWorld.toArray()]) };
    };
    let a: ReturnType<typeof solve>, b: ReturnType<typeof solve>;
    if (report.cases.length % 2) { b = solve(candidate); a = solve(original); } else { a = solve(original); b = solve(candidate); }
    const row = { input, inputSha256: digest(inputBytes), ordinal, invocation: witness.invocation, tMs: witness.tMs,
      exactResult: JSON.stringify(a.result) === JSON.stringify(b.result), exactLocals: JSON.stringify(a.locals) === JSON.stringify(b.locals), exactWorlds: JSON.stringify(a.worlds) === JSON.stringify(b.worlds),
      originalMs: a.elapsedMs, candidateMs: b.elapsedMs,
      originalOutputSha256: digest(Buffer.from(JSON.stringify([a.locals, a.worlds]))),
      candidateOutputSha256: digest(Buffer.from(JSON.stringify([b.locals, b.worlds]))) };
    report.cases.push(row);
  }
}
report.graphCounts = graphCounts; report.after = hashes(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
report.exactAll = report.cases.every((row: any) => row.exactLocals && row.exactWorlds && row.exactResult);
report.totalOriginalMs = report.cases.reduce((sum: number, row: any) => sum + row.originalMs, 0);
report.totalCandidateMs = report.cases.reduce((sum: number, row: any) => sum + row.candidateMs, 0);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ cases: report.cases.length, graphCounts, sourceStable: report.sourceStable, exactAll: report.exactAll,
  originalMs: report.totalOriginalMs, candidateMs: report.totalCandidateMs }));
if (!report.sourceStable || !report.exactAll) process.exitCode = 1;
