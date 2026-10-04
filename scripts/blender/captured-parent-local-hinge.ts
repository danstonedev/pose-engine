/** OFFLINE candidate only. Rotational invariance replaces a world-space
 * projected angle by the same angle in the parent's local frame. This is
 * mathematically equivalent for a rigid, positively uniformly scaled parent;
 * actual Float32 rest rotations and operation ordering can differ numerically.
 * No current clinical or sensitivity tolerance is changed by this experiment. */
import * as THREE from 'three';
import type { JointAngleRestReference } from '../../src/services/jointAngles';

export const localReadoutCounts = { prepared: 0, rejected: 0, measured: 0 };
export function createParentLocalHingeReadout(
  parent: THREE.Bone, bone: THREE.Bone, key: string, rest: JointAngleRestReference,
) {
  const reject = () => { localReadoutCounts.rejected++; return null; };
  const sign = key.endsWith('_Forearm') ? -1 : key.endsWith('_Leg') ? 1 : null;
  const storedAxis = rest.hingeAxes?.[key];
  if (!sign || !storedAxis || bone.parent !== parent || !(bone.scale.x > 0)
    || bone.scale.x !== bone.scale.y || bone.scale.y !== bone.scale.z) return reject();
  const firstDirectionNode = (origin: THREE.Object3D) => {
    const start = new THREE.Vector3().setFromMatrixPosition(origin.matrixWorld);
    const queue = [...origin.children]; let guard = 0;
    while (queue.length && guard++ < 64) {
      const candidate = queue.shift()!;
      if (new THREE.Vector3().setFromMatrixPosition(candidate.matrixWorld).sub(start).lengthSq() >= 1e-8) return candidate;
      queue.push(...candidate.children);
    }
    return null;
  };
  // Match the actual readout's BFS ownership; do not substitute a preferred
  // landmark for a helper selected by the shared measurement.
  const continuation = firstDirectionNode(bone);
  if (firstDirectionNode(parent) !== bone || continuation?.parent !== bone) return reject();
  const e = parent.matrixWorld.elements;
  const columns = [new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(e[4], e[5], e[6]), new THREE.Vector3(e[8], e[9], e[10])];
  const lengths = columns.map(v => v.length()), scale = Math.max(...lengths);
  const distortion = Math.max(...lengths.map(v => Math.abs(v / scale - 1)),
    Math.abs(columns[0]!.dot(columns[1]!) / scale ** 2), Math.abs(columns[0]!.dot(columns[2]!) / scale ** 2), Math.abs(columns[1]!.dot(columns[2]!) / scale ** 2));
  if (!(scale > 0) || !Number.isFinite(distortion) || distortion > 1e-6 || parent.matrixWorld.determinant() <= 0
    || bone.position.length() * scale <= .001 || continuation.position.length() * scale * bone.scale.x <= .001) return reject();
  const p = bone.position.clone().normalize(), axis = new THREE.Vector3().fromArray(storedAxis).normalize();
  const distalOffset = continuation.position.clone(), d = new THREE.Vector3(), pp = new THREE.Vector3(), dd = new THREE.Vector3(), cross = new THREE.Vector3();
  localReadoutCounts.prepared++;
  return { distortion, parentDirectionNode: bone.name, continuationNode: continuation.name,
    measure() {
      localReadoutCounts.measured++;
      d.copy(distalOffset).applyQuaternion(bone.quaternion).normalize();
      pp.copy(p).addScaledVector(axis, -p.dot(axis)); dd.copy(d).addScaledVector(axis, -d.dot(axis));
      if (pp.lengthSq() < 1e-10 || dd.lengthSq() < 1e-10) return 0;
      pp.normalize(); dd.normalize();
      return Math.atan2(cross.crossVectors(pp, dd).dot(axis), pp.dot(dd)) * (180 / Math.PI) * sign;
    },
  };
}
