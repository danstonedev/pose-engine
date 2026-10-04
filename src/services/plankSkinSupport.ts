import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';
import { applyCustomPose, buildBoneByPoseKey } from './poseRig';
import { createPosedVertexReader } from './posedGeometry';
import { createStageTwistOverlay } from './stageTwistOverlay';

/** Measured foot/toe skin supplies the height of a prepared plank's lower
 * support. This transfers the geometric support construction authored in
 * halfway-trunkpushup-authoring. Local joints and body pitch remain authored;
 * rootMotion owns translation, and the arm contact solver owns the palms. */
export function createPlankSkinSupport(options: {
  root: THREE.Object3D; skinned: THREE.SkinnedMesh;
  variantCfg: BodyVariantConfig; baselinePose?: CustomPose;
}) {
  const { root, skinned, variantCfg } = options;
  const points: Record<'L' | 'R', [number, number, number]> = { L: [0, 0, 0], R: [0, 0, 0] };
  let refs: { skin: THREE.SkinnedMesh; vertex: number; side: 'L' | 'R' }[] = [];
  let referenceKey = '';
  const identities = new WeakMap<object, number>();
  let nextIdentity = 1;
  const identity = (object: object) => {
    let value = identities.get(object);
    if (!value) { value = nextIdentity++; identities.set(object, value); }
    return value;
  };
  let bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  const skins: THREE.SkinnedMesh[] = [];
  const reader = createPosedVertexReader(), twist = createStageTwistOverlay();
  const saved = skinned.skeleton.bones.map(bone => ({ quaternion: bone.quaternion.clone(), position: bone.position.clone() }));
  if (options.baselinePose) applyCustomPose(skinned.skeleton, variantCfg, options.baselinePose);
  twist.reset(skinned.skeleton, variantCfg);
  skinned.skeleton.bones.forEach((bone, index) => {
    bone.quaternion.copy(saved[index]!.quaternion); bone.position.copy(saved[index]!.position);
  });
  root.updateWorldMatrix(true, true);

  function refreshReferences() {
    skins.length = 0;
    root.traverse(object => {
      const skin = object as THREE.SkinnedMesh;
      if (skin.isSkinnedMesh && skin.skeleton.bones.includes(skinned.skeleton.bones[0]!)) skins.push(skin);
    });
    const key = JSON.stringify(skins.map(skin => {
      const attribute = (name: string) => {
        const value = skin.geometry.getAttribute(name);
        const data = value instanceof THREE.InterleavedBufferAttribute ? value.data : value;
        return [identity(value), identity(data), identity(data.array), value.count, value.itemSize, value.normalized, data.version];
      };
      return [skin.uuid, skin.geometry.uuid, attribute('skinIndex'), attribute('skinWeight'),
        skin.skeleton.bones.map(bone => [bone.uuid, bone.name, bone.parent?.uuid])];
    }));
    if (key === referenceKey) return;
    bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
    refs = [];
    for (const skin of skins) {
      const indices = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
      const owners = skin.skeleton.bones.map(bone => {
        for (const side of ['L', 'R'] as const) {
          const foot = bones.get(`${side}_Foot`);
          if (!foot) continue;
          for (let parent: THREE.Object3D | null = bone; parent; parent = parent.parent) if (parent === foot) return side;
        }
        return null;
      });
      for (let vertex = 0; vertex < indices.count; vertex++) {
        let dominant = 0;
        for (let slot = 1; slot < weights.itemSize; slot++) if (weights.getComponent(vertex, slot) > weights.getComponent(vertex, dominant)) dominant = slot;
        const side = owners[indices.getComponent(vertex, dominant)];
        if (side) refs.push({ skin, vertex, side });
      }
    }
    for (const side of ['L', 'R'] as const) {
      if (!bones.get(`${side}_Toes`) || !refs.some(ref => ref.side === side)) throw Error(`Missing measured ${side} plank foot/toe support`);
    }
    referenceKey = key;
  }

  function prepare() {
    refreshReferences();
    const minimumY = { L: Infinity, R: Infinity };
    const witnesses = { L: new THREE.Vector3(), R: new THREE.Vector3() };
    twist.sampleWithTwist(() => {
      root.updateWorldMatrix(true, true); reader.beginMeasurement();
      const world = new THREE.Vector3();
      for (const ref of refs) {
        reader.getVertexPosition(ref.skin, ref.vertex, world).applyMatrix4(ref.skin.matrixWorld);
        if (world.y < minimumY[ref.side]) { minimumY[ref.side] = world.y; witnesses[ref.side].copy(world); }
      }
    });
    root.updateWorldMatrix(true, true);
    for (const side of ['L', 'R'] as const) {
      if (!Number.isFinite(minimumY[side])) throw Error(`Missing finite ${side} plank skin support`);
      bones.get(`${side}_Toes`)!.worldToLocal(witnesses[side]).toArray(points[side]);
    }
    return { minimumY };
  }
  return { prepare, points };
}
