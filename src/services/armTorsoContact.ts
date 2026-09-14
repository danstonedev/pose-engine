/** Mesh-derived torso contact for local reach experiments.
 *
 * The convex envelope is conservative around the waist/axilla. It is not a
 * deformable-skin simulation or a complete self-collision model. Rebuild it
 * when the trunk pose changes. Arm samples use the current skinned vertices.
 */
import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

interface SkinPoint { mesh: THREE.SkinnedMesh; index: number; name: string }
export interface TorsoContactReport {
  /** Deepest sampled arm-surface burial in the torso envelope, metres. */
  penetrationM: number;
  penetratingPoints: number;
  samples: number;
  worstPoint: THREE.Vector3 | null;
}

const TORSO = /_(Pelvis|Waist|Spine01|Spine02)$/;
const ARM = /_([LR])_(Upperarm|UpperarmTwist\d+|Forearm|ForearmTwist\d+|Hand|Index\d|Mid\d|Ring\d|Pinky\d|Thumb\d)$/;

function worldPoint(ref: SkinPoint, out: THREE.Vector3): THREE.Vector3 {
  out.fromBufferAttribute(ref.mesh.geometry.getAttribute('position'), ref.index);
  ref.mesh.applyBoneTransform(ref.index, out);
  return out.applyMatrix4(ref.mesh.matrixWorld);
}

export function createArmTorsoContact(root: THREE.Object3D) {
  const torso: SkinPoint[] = [];
  const arms: Record<'L' | 'R', SkinPoint[]> = { L: [], R: [] };
  root.traverse(object => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const indices = mesh.geometry.getAttribute('skinIndex');
    const weights = mesh.geometry.getAttribute('skinWeight');
    const position = mesh.geometry.getAttribute('position');
    if (!indices || !weights || !position) return;
    for (let index = 0; index < position.count; index += 1) {
      let dominant = '';
      let maximum = -1;
      let torsoWeight = 0;
      for (let k = 0; k < 4; k += 1) {
        const weight = weights.getComponent(index, k);
        const name = mesh.skeleton.bones[indices.getComponent(index, k)]?.name ?? '';
        if (TORSO.test(name)) torsoWeight += weight;
        if (weight > maximum) { maximum = weight; dominant = name; }
      }
      const ref = { mesh, index, name: dominant };
      if (torsoWeight > 0.9) torso.push(ref);
      const arm = ARM.exec(dominant);
      // Mixed attachment vertices join arm and torso by design. Restrict the
      // sampled patch to vertices clearly carried by an arm bone.
      if (arm && maximum > 0.65) arms[arm[1] as 'L' | 'R'].push(ref);
    }
  });
  if (torso.length < 4 || !arms.L.length || !arms.R.length) return null;
  const hull = new ConvexHull();
  const point = new THREE.Vector3();
  let vertices: THREE.Vector3[] = [];
  const refresh = () => {
    root.updateMatrixWorld(true);
    vertices = torso.map(ref => worldPoint(ref, new THREE.Vector3()));
    hull.setFromPoints(vertices);
  };
  refresh();

  // The shoulder is a continuous attachment, not two disjoint solids. Omit
  // upper-arm vertices in the neutral axillary seam; keeping them would report
  // ~3 cm of convex-envelope burial on the untouched male rig. Distal arm/hand
  // samples are never exempted. This explicit approximation needs mesh-level
  // contact refinement before use as a validated anatomical constraint.
  for (const side of ['L', 'R'] as const) {
    arms[side] = arms[side].filter(ref => {
      if (!/_Upperarm(?:Twist\d+)?$/.test(ref.name)) return true;
      worldPoint(ref, point);
      let margin = -Infinity;
      for (const face of hull.faces) margin = Math.max(margin, face.normal.dot(point) - face.constant);
      return margin > 0.01;
    });
  }

  const inspect = (side: 'L' | 'R', toleranceM = 0.003): TorsoContactReport => {
    root.updateMatrixWorld(true);
    let penetrationM = 0;
    let penetratingPoints = 0;
    let worstPoint: THREE.Vector3 | null = null;
    for (const ref of arms[side]) {
      worldPoint(ref, point);
      // The deepest (least negative) plane bounds distance to the envelope's
      // exterior for interior points. Positive means outside a supporting plane.
      let margin = -Infinity;
      for (const face of hull.faces) margin = Math.max(margin, face.normal.dot(point) - face.constant);
      if (margin < -toleranceM) penetratingPoints += 1;
      if (-margin > penetrationM) {
        penetrationM = -margin;
        worstPoint = point.clone();
      }
    }
    return { penetrationM, penetratingPoints, samples: arms[side].length, worstPoint };
  };
  return { refresh, inspect, get envelopePoints() { return vertices; } };
}
