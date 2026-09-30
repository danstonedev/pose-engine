import { Vector3, Box3, type Object3D, type SkinnedMesh } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

/** Independent current-pose skin envelopes. Measures arm vertices inside each
 * thigh/calf hull, not distance to the same capsules used by the runtime guard. */
export function armLegSkinContact(root: Object3D) {
  type Ref = { mesh: SkinnedMesh; index: number };
  const legs = new Map<string, Ref[]>(), arms: Ref[] = [];
  const point = ({ mesh, index }: Ref) => {
    const p = new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), index);
    return mesh.applyBoneTransform(index, p).applyMatrix4(mesh.matrixWorld);
  };
  root.traverse(o => {
    const mesh = o as SkinnedMesh; if (!mesh.isSkinnedMesh) return;
    const ids = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
    for (let index = 0; index < ids.count; index++) {
      let name = '', best = 0;
      for (let j = 0; j < 4; j++) if (weights.getComponent(index, j) > best) {
        best = weights.getComponent(index, j); name = mesh.skeleton.bones[ids.getComponent(index, j)]!.name;
      }
      if (best < .65) continue;
      const leg = /_([LR])_(Thigh|Calf)(?:Twist\d+)?$/.exec(name);
      if (leg) { const key = leg[1]! + leg[2]!, refs = legs.get(key) ?? []; refs.push({mesh,index}); legs.set(key,refs); }
      if (/_([LR])_(Forearm(?:Twist\d+)?|Hand|Index\d|Mid\d|Ring\d|Pinky\d|Thumb\d)$/.test(name)) arms.push({mesh,index});
    }
  });
  if (legs.size !== 4 || !arms.length) throw Error('Missing arm/leg skin');
  return () => {
    root.updateMatrixWorld(true);
    const points = arms.map(point); let penetration = 0;
    for (const refs of legs.values()) {
      const surface = refs.map(point), box = new Box3().setFromPoints(surface);
      const candidates = points.filter(p => box.containsPoint(p)); if (!candidates.length) continue;
      const hull = new ConvexHull().setFromPoints(surface);
      for (const p of candidates) {
        let margin = -Infinity;
        for (const face of hull.faces) margin = Math.max(margin, face.normal.dot(p) - face.constant);
        penetration = Math.max(penetration, -margin);
      }
    }
    return penetration;
  };
}
