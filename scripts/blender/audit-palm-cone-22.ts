import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { buildFootPlant } from '../../src/services/footContact';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
import { solveHandContactPose as original } from './captured-hand-solver-cone22-original';
import { solveHandContactPose as probed } from './captured-hand-solver-cone22-probed';

setRomClampEnabled(false);
const [prefix, destination] = process.argv.slice(2);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = () => Object.fromEntries(['poseRomClamp', 'jointAngles', 'handContactPose', 'footContact'].map(name => [name, hash(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url)))]));
const report: any = { before: source(), scope: 'Every finite-difference probe of frozen source-prior solver on saved1133/4166 inputs. Compare selected-joint projection with the full top-down projection used by accepted steps at identical raw perturbations; restore partial pose exactly. Diagnostic must leave all101 final locals/world matrices byte-identical. No runtime changes.',
  copies: Object.fromEntries(['original', 'probed'].map(name => [name, hash(readFileSync(new URL(`./captured-hand-solver-cone22-${name}.ts`, import.meta.url)))])), cases: [] };
const bytes = readFileSync(new URL('../../models/painmap3D_neutral.runtime.glb', import.meta.url));
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
report.assetSha256 = hash(bytes);
for (const deltaDeg of [0, -5e-8, 5e-8]) {
  const inputBytes = readFileSync(`${prefix}.neutral.${deltaDeg}.witness.json`), capture = JSON.parse(inputBytes.toString('utf8'));
  for (const [ordinal, witness] of capture.witnesses.entries()) {
    const restore = () => {
      for (const entry of witness.objects) {
        const object = entry.path.reduce((node: THREE.Object3D, i: number) => node.children[i]!, root);
        assert.equal(object.name, entry.name); assert.equal(object.type, entry.type);
        object.position.fromArray(entry.position); object.quaternion.fromArray(entry.quaternion); object.scale.fromArray(entry.scale);
        object.matrixAutoUpdate = entry.matrixAutoUpdate; object.matrix.fromArray(entry.matrix);
      }
      root.updateMatrixWorld(true);
    };
    restore(); const solver = buildFootPlant(skinned, witness.canonicalKeys[0], BODY_VARIANTS.neutral)!;
    assert.deepEqual(solver.ctx.canonicalKeys, witness.canonicalKeys);
    const invoke = (fn: typeof original) => fn(solver, new THREE.Vector3().fromArray(witness.target), new THREE.Quaternion().fromArray(witness.orientation), witness.rest, witness.constraints,
      witness.elbowDirection ? new THREE.Vector3().fromArray(witness.elbowDirection) : undefined, witness.minimumElbowY, witness.elbowFlexionRadians,
      witness.posturePrior?.map((q: number[]) => new THREE.Quaternion().fromArray(q)));
    const snapshot = () => skinned.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray(), ...bone.matrixWorld.toArray()]);
    const result = invoke(original), expected = snapshot();
    const exactWitness = JSON.stringify(solver.ctx.bones.map(bone => bone.quaternion.toArray())) === JSON.stringify(witness.after);
    restore(); (globalThis as any).__coneAudit = []; const diagnosticResult = invoke(probed);
    assert.deepEqual(snapshot(), expected, 'Diagnostic changed final101 bone locals/worlds'); assert.deepEqual(diagnosticResult, result);
    const traces = (globalThis as any).__coneAudit as any[], probes = traces.flatMap(trace => trace.probes.map((probe: any) => ({ ...probe, guided: trace.guided })));
    const ranked = probes.flatMap(probe => probe.differences.map((difference: any) => ({ ...probe, differences: undefined, affected: difference.joint, degrees: difference.degrees }))).sort((a, b) => b.degrees - a.degrees);
    const row = { deltaDeg, ordinal, invocation: witness.invocation, tMs: witness.tMs, inputSha256: hash(inputBytes), exactWitness, exactFinalLocalsAndWorlds: true,
      result, probeCount: probes.length, maximum: ranked[0], consequentialProbes: ranked.filter(row => row.degrees > 1e-8).slice(0, 30), traces };
    report.cases.push(row); console.log(JSON.stringify({ deltaDeg, ordinal, invocation: witness.invocation, tMs: witness.tMs, exactWitness, probeCount: probes.length, maximum: row.maximum }));
  }
}
report.after = source(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(destination!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
