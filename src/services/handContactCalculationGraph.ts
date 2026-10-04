import * as THREE from 'three';

export interface HandContactCalculationGraph {
  /** Private nodes in the caller's effector-to-root order. */
  bones: THREE.Bone[];
  /** Original nodes; only their rotations are committed after a successful solve. */
  actualBones: readonly THREE.Bone[];
  commitQuaternions(): void;
}

const example = new THREE.Object3D();
const methodNames = ['updateMatrix', 'updateMatrixWorld', 'updateWorldMatrix',
  'getWorldPosition', 'getWorldQuaternion', 'getWorldScale'] as const;
const callbacks = ['rotation', 'quaternion'] as const;
const functionSource = Function.prototype.toString;
const callbackSource = Object.fromEntries(callbacks.map(key => [key,
  functionSource.call((example[key] as unknown as { _onChangeCallback: () => void })._onChangeCallback)]));
const defaultMethods = Object.fromEntries(methodNames.map(key => [key, example[key]]));
const allowedAncestors = new Set([THREE.Object3D.prototype, THREE.Bone.prototype, THREE.Group.prototype, THREE.Scene.prototype]);
const allowedDescendants = new Set([THREE.Object3D.prototype, THREE.Bone.prototype]);

function standardTransformValue(value: object, prototype: object, callback?: string): boolean {
  if (Object.getPrototypeOf(value) !== prototype) return false;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) return false;
    if (typeof descriptor.value === 'function') {
      if (key !== '_onChangeCallback' || callback === undefined
        || functionSource.call(descriptor.value) !== callback) return false;
    }
  }
  return true;
}

function standardNode(node: THREE.Object3D, ancestor: boolean): boolean {
  if (!(ancestor ? allowedAncestors : allowedDescendants).has(Object.getPrototypeOf(node))) return false;
  // Inspect descriptors before reading fields so an overridden getter cannot
  // run during the eligibility check. Ordinary userData/render hooks are unused.
  for (const key of [...methodNames, ...callbacks, 'position', 'scale', 'matrix', 'matrixWorld',
    'matrixAutoUpdate', 'matrixWorldAutoUpdate', 'matrixWorldNeedsUpdate', 'parent', 'children', 'name', 'pivot']) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor?.get || descriptor?.set) return false;
  }
  if (methodNames.some(key => node[key] !== defaultMethods[key])) return false;
  if (!node.matrixAutoUpdate || !node.matrixWorldAutoUpdate) return false;
  if (!standardTransformValue(node.position, THREE.Vector3.prototype)
    || !standardTransformValue(node.scale, THREE.Vector3.prototype)
    || !standardTransformValue(node.quaternion, THREE.Quaternion.prototype, callbackSource.quaternion)
    || !standardTransformValue(node.rotation, THREE.Euler.prototype, callbackSource.rotation)
    || !standardTransformValue(node.matrix, THREE.Matrix4.prototype)
    || !standardTransformValue(node.matrixWorld, THREE.Matrix4.prototype)) return false;
  const pivot = (node as THREE.Object3D & { pivot?: THREE.Vector3 | null }).pivot;
  if (pivot != null) return false;
  const { x, y, z } = node.scale;
  if (!Number.isFinite(x) || x <= 0 || x !== y || y !== z) return false;
  if (![...node.position.toArray(), ...node.quaternion.toArray()].every(Number.isFinite)) return false;
  return Math.abs(node.quaternion.lengthSq() - 1) <= 1e-6;
}

/** A synchronous private FK graph for the standard four-bone planted arm.
 *
 * Keep all proximal helpers and their child order. The numerical solver reads
 * no digits when each direct segment supplies a meaningful hinge direction.
 * Positive uniform scale keeps those lengths fixed during rotation. The margin
 * is only an optimization eligibility check around jointAngles' 0.1 mm direction
 * cutoff; all other rigs continue through the original solver.
 *
 * Custom transforms/callbacks, manual matrices, nonuniform scale and unfamiliar
 * chains deliberately return null. Runtime-local callback source comparison is
 * a conservative Three compatibility check, not a security boundary. A host
 * with custom hooks must retain the original live-node calculation.
 */
export function createHandContactCalculationGraph(
  bones: readonly THREE.Bone[],
  canonicalKeys: readonly (string | null)[],
): HandContactCalculationGraph | null {
  if (bones.length !== 4 || canonicalKeys.length !== 4) return null;
  const side = canonicalKeys[0]?.match(/^([LR])_Hand$/)?.[1];
  if (!side || canonicalKeys.some((key, i) => key !== `${side}_${['Hand', 'Forearm', 'UpperArm', 'Shoulder'][i]}`)) return null;
  if (bones.some(bone => Object.getPrototypeOf(bone) !== THREE.Bone.prototype)) return null;
  const actualBones = [...bones], actualRoot = actualBones[3]!, actualHand = actualBones[0]!;
  const seen = new Set<THREE.Object3D>();
  const queue: THREE.Object3D[] = [actualRoot];
  while (queue.length) {
    const node = queue.pop()!;
    if (seen.has(node) || !standardNode(node, false)) return null;
    seen.add(node);
    if (!Array.isArray(node.children) || Object.getPrototypeOf(node.children) !== Array.prototype
      || Object.values(Object.getOwnPropertyDescriptors(node.children)).some(d => d.get || d.set)) return null;
    for (const child of node.children) {
      if (Object.getOwnPropertyDescriptor(child, 'parent')?.get || Object.getOwnPropertyDescriptor(child, 'parent')?.set) return null;
      if (child.parent !== node) return null; queue.push(child);
    }
  }
  for (let node = actualRoot.parent; node; node = node.parent) {
    if (seen.has(node) || !standardNode(node, true)) return null;
    seen.add(node);
  }
  for (let i = 0; i < bones.length - 1; i++) if (bones[i]!.parent !== bones[i + 1]) return null;
  const scaleAt = (bone: THREE.Bone) => {
    let scale = 1;
    for (let node: THREE.Object3D | null = bone; node; node = node.parent) scale *= node.scale.x;
    return scale;
  };
  // This also prevents BFS from falling through a collapsed forearm/hand and
  // taking its direction from a finger that the private graph would omit.
  for (const index of [0, 1]) {
    const lengthM = actualBones[index]!.position.length() * scaleAt(actualBones[index + 1]!);
    if (!Number.isFinite(lengthM) || lengthM <= .001) return null;
  }
  actualRoot.updateWorldMatrix(true, true);
  const mapped = new Map<THREE.Object3D, THREE.Object3D>();
  const copy = (node: THREE.Object3D): THREE.Object3D => {
    const result = Object.getPrototypeOf(node) === THREE.Bone.prototype ? new THREE.Bone() : new THREE.Object3D();
    mapped.set(node, result);
    result.name = node.name;
    result.rotation.order = node.rotation.order;
    result.position.copy(node.position); result.quaternion.copy(node.quaternion); result.scale.copy(node.scale);
    result.matrix.copy(node.matrix); result.matrixWorld.copy(node.matrixWorld);
    result.matrixAutoUpdate = node.matrixAutoUpdate; result.matrixWorldAutoUpdate = node.matrixWorldAutoUpdate;
    result.matrixWorldNeedsUpdate = node.matrixWorldNeedsUpdate;
    // Do not call clone/copy: userData can contain cyclic host references, and
    // no mesh, render callback, constructor override or scene state belongs here.
    if (node !== actualHand) for (const child of node.children) result.add(copy(child));
    return result;
  };
  const privateRoot = copy(actualRoot);
  if (actualRoot.parent) {
    const anchor = new THREE.Object3D();
    anchor.matrixAutoUpdate = false; anchor.matrixWorldAutoUpdate = false;
    anchor.matrixWorld.copy(actualRoot.parent.matrixWorld);
    privateRoot.parent = anchor;
  }
  const privateBones = actualBones.map(bone => mapped.get(bone)! as THREE.Bone);
  return { bones: privateBones, actualBones, commitQuaternions() {
    actualBones.forEach((bone, i) => bone.quaternion.copy(privateBones[i]!.quaternion));
    actualRoot.updateWorldMatrix(true, true);
  } };
}
