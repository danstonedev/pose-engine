import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildFootPlant } from '../services/footContact';
import { captureJointAngleRestReference, measureHingeFlexion, measureHingeFlexionFromCurrentMatrices, type JointAngleRestReference } from '../services/jointAngles';
import { createHandContactCalculationGraph } from '../services/handContactCalculationGraph';

const keys = ['L_Hand', 'L_Forearm', 'L_UpperArm', 'L_Shoulder'];
const state = (nodes: readonly THREE.Object3D[]) => nodes.map(node => ({
  p: node.position.toArray(), q: node.quaternion.toArray(), s: node.scale.toArray(), w: node.matrixWorld.toArray(),
}));
function smallRig() {
  const parent = new THREE.Group();
  const bones = keys.map(name => Object.assign(new THREE.Bone(), { name }));
  parent.add(bones[3]!);
  for (let index = 2; index >= 0; index--) { bones[index]!.position.y = .25; bones[index + 1]!.add(bones[index]!); }
  const finger = new THREE.Bone(); finger.position.y = .04; bones[0]!.add(finger);
  parent.updateMatrixWorld(true);
  return { parent, bones, finger };
}
async function actualRig(variant: keyof typeof BODY_VARIANTS) {
  const cfg = BODY_VARIANTS[variant];
  const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin!: THREE.SkinnedMesh;
  root.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = node as THREE.SkinnedMesh; });
  return { root, skin, cfg };
}

describe('private hand calculation graph ownership', () => {
  it.each(['male', 'female', 'neutral'] as const)('reads the same %s hinge value from refreshed private matrices without changing the graph', async variant => {
    const { root, skin, cfg } = await actualRig(variant);
    const rest = captureJointAngleRestReference(skin.skeleton, cfg);
    root.position.set(.3, -.2, .1); root.rotation.set(.8, -.4, .2); root.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const solver = buildFootPlant(skin, `${side}_Hand`, cfg)!;
      const graph = createHandContactCalculationGraph(solver.ctx.bones, solver.ctx.canonicalKeys)!;
      for (const turn of [0, -.8, .8, 2.6]) {
        graph.bones[1]!.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(turn, .2, -.1)));
        graph.bones[3]!.updateWorldMatrix(true, true);
        const before = state(graph.bones);
        const current = measureHingeFlexionFromCurrentMatrices(graph.bones[2]!, graph.bones[1]!, `${side}_Forearm`, rest);
        expect(state(graph.bones)).toEqual(before);
        expect(current).toBe(measureHingeFlexion(graph.bones[2]!, graph.bones[1]!, `${side}_Forearm`, rest));
      }
    }
  });

  it('keeps world accessor overrides on the fallback path', () => {
    const { bones } = smallRig();
    const rest: JointAngleRestReference = { pelvisWorldQuat: [0, 0, 0, 1],
      localQuats: { L_Forearm: [0, 0, 0, 1] }, worldQuats: { L_Forearm: [0, 0, 0, 1] },
      hingeAxes: { L_Forearm: [1, 0, 0] } };
    let calls = 0;
    const original = bones[0]!.getWorldPosition;
    bones[0]!.getWorldPosition = function (target) { calls++; return original.call(this, target).add(new THREE.Vector3(0, 0, .1)); };
    expect(createHandContactCalculationGraph(bones, keys)).toBeNull();
    expect(calls).toBe(0);
    const standardValue = measureHingeFlexionFromCurrentMatrices(bones[2]!, bones[1]!, 'L_Forearm', rest);
    expect(calls).toBe(0);
    expect(measureHingeFlexion(bones[2]!, bones[1]!, 'L_Forearm', rest)).not.toBe(standardValue);
    expect(calls).toBe(1);
  });

  it.each(['male', 'female', 'neutral'] as const)('preserves %s helpers and isolates calculation before committing only joint rotations', async variant => {
    const { root, skin, cfg } = await actualRig(variant);
    root.position.set(.3, -.2, .1); root.rotation.set(.2, .4, -.1); root.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const solver = buildFootPlant(skin, `${side}_Hand`, cfg)!;
      const all = skin.skeleton.bones, before = state(all);
      // Host references need not be serializable; the graph never clones userData.
      solver.ctx.bones[3]!.userData.cycle = solver.ctx.bones[3];
      const graph = createHandContactCalculationGraph(solver.ctx.bones, solver.ctx.canonicalKeys)!;
      expect(graph).not.toBeNull();
      expect(graph.actualBones).toEqual(solver.ctx.bones);
      expect(state(all)).toEqual(before);
      const paired = (actual: THREE.Object3D, copy: THREE.Object3D) => {
        expect(copy).not.toBe(actual); expect(copy.name).toBe(actual.name);
        expect(copy.matrixWorld.toArray()).toEqual(actual.matrixWorld.toArray());
        expect(copy.userData).toEqual({});
        if (actual === solver.ctx.bones[0]) { expect(copy.children).toHaveLength(0); return; }
        expect(copy.children).toHaveLength(actual.children.length);
        actual.children.forEach((child, index) => paired(child, copy.children[index]!));
      };
      paired(solver.ctx.bones[3]!, graph.bones[3]!);
      graph.bones[1]!.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .2));
      graph.bones[3]!.updateWorldMatrix(true, true);
      expect(state(all)).toEqual(before);
      const expectedWorlds = graph.bones.map(bone => bone.matrixWorld.toArray());
      graph.commitQuaternions();
      graph.actualBones.forEach((bone, index) => expect(bone.matrixWorld.toArray()).toEqual(expectedWorlds[index]));
      all.forEach((bone, index) => {
        expect(bone.position.toArray()).toEqual(before[index]!.p);
        expect(bone.scale.toArray()).toEqual(before[index]!.s);
        if (!graph.actualBones.includes(bone)) expect(bone.quaternion.toArray()).toEqual(before[index]!.q);
        if (bone.parent) expect(bone.matrixWorld.toArray()).toEqual(new THREE.Matrix4().multiplyMatrices(bone.parent.matrixWorld, bone.matrix).toArray());
      });
    }
  });

  it.each(['male', 'female', 'neutral'] as const)('falls back when the %s elbow hinge needs an omitted finger for its direction', async variant => {
    const { root, skin, cfg } = await actualRig(variant);
    const rest = captureJointAngleRestReference(skin.skeleton, cfg);
    const solver = buildFootPlant(skin, 'L_Hand', cfg)!;
    const [hand, forearm, upper] = solver.ctx.bones;
    const collapse = (node: THREE.Object3D) => { node.position.set(0, 0, 0); if (node !== hand) node.children.forEach(collapse); };
    forearm!.children.forEach(collapse); root.updateMatrixWorld(true);
    expect(measureHingeFlexion(upper!, forearm!, 'L_Forearm', rest)).not.toBeNull();
    const saved = hand!.children; hand!.children = [];
    expect(measureHingeFlexion(upper!, forearm!, 'L_Forearm', rest)).toBeNull();
    hand!.children = saved;
    expect(createHandContactCalculationGraph(solver.ctx.bones, solver.ctx.canonicalKeys)).toBeNull();
  });

  it.each(['quaternion', 'rotation', 'position', 'node getter', 'method', 'omitted finger hook'] as const)('rejects a custom %s before invoking it', kind => {
    const { bones, finger } = smallRig(); let calls = 0;
    if (kind === 'quaternion') bones[1]!.quaternion._onChange(() => { calls++; });
    if (kind === 'rotation') bones[1]!.rotation._onChange(() => { calls++; });
    if (kind === 'omitted finger hook') finger.quaternion._onChange(() => { calls++; });
    if (kind === 'position') Object.defineProperty(bones[1]!.position, 'x', { get() { calls++; return 0; } });
    if (kind === 'node getter') Object.defineProperty(bones[1], 'parent', { get() { calls++; return bones[2]; } });
    if (kind === 'method') bones[1]!.updateWorldMatrix = () => { calls++; };
    expect(createHandContactCalculationGraph(bones, keys)).toBeNull();
    expect(calls).toBe(0);
  });

  it.each(['manual local', 'manual world', 'manual ancestor', 'nonuniform', 'negative scale', 'custom node', 'mesh child', 'unknown chain', 'short segment'] as const)('leaves the original %s graph for the live solver', kind => {
    const { parent, bones } = smallRig();
    if (kind === 'manual local') bones[1]!.matrixAutoUpdate = false;
    if (kind === 'manual world') bones[1]!.matrixWorldAutoUpdate = false;
    if (kind === 'manual ancestor') parent.matrixAutoUpdate = false;
    if (kind === 'nonuniform') parent.scale.set(1, 2, 1);
    if (kind === 'negative scale') parent.scale.setScalar(-1);
    if (kind === 'custom node') { class Custom extends THREE.Bone {} bones[1]!.add(new Custom()); }
    if (kind === 'mesh child') bones[1]!.add(new THREE.Mesh());
    if (kind === 'short segment') bones[0]!.position.set(0, .00001, 0);
    const before = state(bones);
    expect(createHandContactCalculationGraph(bones, kind === 'unknown chain' ? keys.slice().reverse() : keys)).toBeNull();
    expect(state(bones)).toEqual(before);
  });
});
