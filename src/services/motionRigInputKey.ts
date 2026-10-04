import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';
import type { JointAngleRestReference } from './jointAngles';
import type { ResolvedComposedMotion } from './motionSequence';
import type { RomScenarioConstraints } from './romConstraints';
import { buildBoneByPoseKey } from './poseRig';
import { isRomClampActive } from './poseRomClamp';

interface MotionRigInputs {
  resolvedMotion: ResolvedComposedMotion;
  baselinePose: CustomPose;
  variantCfg: BodyVariantConfig;
  rest: JointAngleRestReference;
  constraints?: RomScenarioConstraints | null;
  skeletonHarness: { root: THREE.Object3D; skinned: THREE.SkinnedMesh };
  /** The transform restored by each trajectory probe, independent of playback. */
  rootTransform?: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
}

const attributeIds = new WeakMap<object, number>();
let nextAttributeId = 1;
function attributeIdentity(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined) {
  if (!attribute) return null;
  let id = attributeIds.get(attribute);
  if (!id) { id = nextAttributeId++; attributeIds.set(attribute, id); }
  return [id, attribute.count, attribute.itemSize, attribute.normalized,
    attribute instanceof THREE.InterleavedBufferAttribute
      ? [attribute.data.version, attribute.offset, attribute.data.stride] : attribute.version];
}

/** Exact cache identity for planning that observes the posed production skin.
 * Geometry edits follow Three's needsUpdate/version contract. Bone poses reset
 * by the sampler are represented by their baseline; unowned helpers and manual
 * matrices remain actual inputs. No geometry values or pose values are rounded.
 */
export function motionRigInputKey(options: MotionRigInputs): string {
  const nodes: unknown[] = [], parents: unknown[] = [];
  const { root, skinned } = options.skeletonHarness;
  const resetBones = new Map([...buildBoneByPoseKey(skinned.skeleton, options.variantCfg)]
    .map(([key, bone]) => [bone as THREE.Object3D, key]));
  for (let parent = root.parent; parent; parent = parent.parent) {
    parents.push([parent.uuid, parent.position.toArray(), parent.quaternion.toArray(), parent.scale.toArray(),
      parent.matrixAutoUpdate, ...(parent.matrixAutoUpdate ? [] : [parent.matrix.toArray()]),
      parent.matrixWorldAutoUpdate, ...(parent.matrixWorldAutoUpdate ? [] : [parent.matrixWorld.toArray()])]);
  }
  root.traverse(node => {
    const skin = node as THREE.SkinnedMesh;
    const resetKey = resetBones.get(node);
    const resetRoot = node === root ? options.rootTransform : undefined;
    const position = resetRoot?.position.toArray() ?? (resetKey ? options.baselinePose.positions?.[resetKey] : undefined);
    const quaternion = resetRoot?.quaternion.toArray() ?? (resetKey ? options.baselinePose.bones[resetKey] : undefined);
    nodes.push([node.uuid, node.parent?.uuid, position ?? node.position.toArray(), quaternion ?? node.quaternion.toArray(),
      resetRoot?.scale.toArray() ?? node.scale.toArray(),
      node.matrixAutoUpdate, ...(node.matrixAutoUpdate ? [] : [node.matrix.toArray()]),
      node.matrixWorldAutoUpdate, ...(node.matrixWorldAutoUpdate ? [] : [node.matrixWorld.toArray()]),
      ...(skin.isSkinnedMesh ? [skin.geometry.uuid, skin.bindMode, skin.bindMatrix.toArray(),
        skin.skeleton.bones.map(bone => bone.uuid), skin.skeleton.boneInverses.map(matrix => matrix.toArray()),
        attributeIdentity(skin.geometry.getAttribute('position')), attributeIdentity(skin.geometry.getAttribute('skinIndex')),
        attributeIdentity(skin.geometry.getAttribute('skinWeight')), attributeIdentity(skin.geometry.index),
        skin.morphTargetInfluences, skin.geometry.morphTargetsRelative,
        Object.entries(skin.geometry.morphAttributes).map(([key, attributes]) => [key, attributes?.map(attributeIdentity)])] : []),
    ]);
  });
  return JSON.stringify([isRomClampActive(), options.resolvedMotion, options.baselinePose, options.variantCfg, options.rest,
    options.constraints, skinned.uuid, parents, nodes]);
}
