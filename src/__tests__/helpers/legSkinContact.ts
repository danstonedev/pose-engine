import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

/** Independent skin-envelope check for the gait tests. Each calf, foot and
 * distal thigh gets its own current-pose hull, so flexed knees do not fill in
 * the empty space between the thigh and calf. Proximal pelvic attachments are
 * excluded. Conservative convex envelopes, not exact triangle collision.
 */
export function legSkinContact(root: THREE.Object3D, bones: ReadonlyMap<string, THREE.Bone>) {
  type Ref = { mesh: THREE.SkinnedMesh; index: number };
  const groups = new Map<string, Ref[]>();
  const point = (r: Ref) => {
    const p = new THREE.Vector3().fromBufferAttribute(r.mesh.geometry.getAttribute('position'), r.index);
    r.mesh.applyBoneTransform(r.index, p);
    return p.applyMatrix4(r.mesh.matrixWorld);
  };
  root.updateMatrixWorld(true);
  root.traverse(o => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const ids = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
    if (!ids || !weights) return;
    for (let index = 0; index < ids.count; index++) {
      let name = '', best = 0;
      for (let k = 0; k < 4; k++) {
        if (weights.getComponent(index, k) > best) {
          best = weights.getComponent(index, k);
          name = mesh.skeleton.bones[ids.getComponent(index, k)]?.name ?? '';
        }
      }
      const match = /_([LR])_(Thigh(?:Twist\d+)?|Calf(?:Twist\d+)?|Foot|ToeBase)$/.exec(name);
      if (!match || best < .65) continue;
      const side = match[1]!, part = match[2]!.startsWith('Thigh') ? 'thigh' : match[2]!.startsWith('Calf') ? 'calf' : 'foot';
      const ref = { mesh, index };
      if (part === 'thigh') {
        const hip = bones.get(`${side}_UpLeg`)!.getWorldPosition(new THREE.Vector3());
        const knee = bones.get(`${side}_Leg`)!.getWorldPosition(new THREE.Vector3());
        const axis = knee.clone().sub(hip), u = point(ref).sub(hip).dot(axis) / axis.lengthSq();
        if (u < .35) continue;
      }
      const key = `${side}/${part}`, refs = groups.get(key) ?? [];
      refs.push(ref); groups.set(key, refs);
    }
  });
  if (groups.size !== 6) throw new Error(`Missing leg surface samples: ${[...groups.keys()]}`);
  return () => {
    root.updateMatrixWorld(true);
    const patches = [...groups].map(([key, refs]) => {
      const points = refs.map(point);
      return { key, points, box: new THREE.Box3().setFromPoints(points), hull: new ConvexHull().setFromPoints(points) };
    });
    let penetrationM = 0, pair = '';
    for (const a of patches) for (const b of patches) {
      if (a.key[0] === b.key[0] || !a.box.intersectsBox(b.box)) continue;
      for (const p of a.points) {
        if (!b.box.containsPoint(p)) continue;
        let margin = -Infinity;
        for (const f of b.hull.faces) margin = Math.max(margin, f.normal.dot(p) - f.constant);
        if (-margin > penetrationM) { penetrationM = -margin; pair = `${a.key} / ${b.key}`; }
      }
    }
    return { penetrationM, pair };
  };
}
