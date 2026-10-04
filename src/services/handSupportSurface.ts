import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

export interface PalmSupportPlane {
  /** Measured support-plane outward normal in the hand's rotation-local frame. */
  normalLocal: THREE.Vector3;
  /** Offset from wrist to the supporting plane, in metres. */
  depthM: number;
  normalDeviationDeg: number;
  patchClearanceM: { heel: number; thenar: number; ulnar: number };
  contactSpanM: number;
  contactTriangleAreaM2: number;
  vertexCount: number;
}

/** Fit actual heel/thenar/ulnar skin support, using the same geometric procedure
 * as scripts/blender/derive-palm-support-plane.py. This is target authoring, not
 * a pressure or tissue model. Call at contact capture, never every render frame.
 * The skin-support normal replaces the bone landmark plane only for an explicit
 * surface contact. Existing arm ROM checks still decide whether it is reachable.
 */
export function fittedPalmNormal(
  referenceSkin: THREE.SkinnedMesh,
  hand: THREE.Bone,
  metacarpalNormalLocal: THREE.Vector3,
  palmForwardLocal: THREE.Vector3,
): THREE.Vector3 {
  return fitPalmSupportPlane(referenceSkin, hand, metacarpalNormalLocal, palmForwardLocal).normalLocal;
}

export function fitPalmSupportPlane(
  referenceSkin: THREE.SkinnedMesh,
  hand: THREE.Bone,
  metacarpalNormalLocal: THREE.Vector3,
  palmForwardLocal: THREE.Vector3,
): PalmSupportPlane {
  let model: THREE.Object3D = referenceSkin;
  while (model.parent && !(model.parent as THREE.Scene).isScene) model = model.parent;
  model.updateWorldMatrix(true, true);
  const origin = hand.getWorldPosition(new THREE.Vector3());
  const inverse = hand.getWorldQuaternion(new THREE.Quaternion()).normalize().invert();
  const forward = palmForwardLocal.clone().normalize();
  const palmar = metacarpalNormalLocal.clone().normalize();
  const lateral = palmar.clone().cross(forward).normalize();
  if (![forward, palmar, lateral].every(v => Number.isFinite(v.lengthSq()) && v.lengthSq() > .99)) {
    throw new Error(`Missing palm frame for ${hand.name}`);
  }
  const local = new THREE.Vector3();
  const project = (point: THREE.Vector3) => new THREE.Vector3(point.dot(forward), point.dot(lateral), point.dot(palmar));
  const prefix = hand.name.replace(/Hand$/, '');
  const landmark = (part: string) => {
    const bone = referenceSkin.skeleton.bones.find(value => value.name === prefix + part);
    if (!bone) throw new Error(`Missing palm landmark ${prefix + part}`);
    return project(bone.getWorldPosition(new THREE.Vector3()).sub(origin).applyQuaternion(inverse));
  };
  const anchors = [new THREE.Vector3(), landmark('Thumb1'), landmark('Pinky1')];
  const distalLimit = Math.max(...['Index1', 'Mid1', 'Ring1', 'Pinky1'].map(part => landmark(part).x));
  const points: THREE.Vector3[] = [];
  const patches: number[][] = [[], [], []];
  model.traverse(object => {
    const skin = object as THREE.SkinnedMesh;
    if (!skin.isSkinnedMesh || !skin.skeleton.bones.includes(hand)) return;
    const owned = skin.skeleton.bones.map(bone => {
      let ancestor: THREE.Object3D | null = bone;
      while (ancestor && ancestor !== hand) ancestor = ancestor.parent;
      return ancestor === hand;
    });
    const indices = skin.geometry.getAttribute('skinIndex');
    const weights = skin.geometry.getAttribute('skinWeight');
    const positions = skin.geometry.getAttribute('position');
    if (!indices || !weights || !positions) return;
    skin.skeleton.update();
    for (let vertex = 0; vertex < positions.count; vertex++) {
      let influence = 0, dominantWeight = -Infinity, dominantBone = -1;
      for (let slot = 0; slot < weights.itemSize; slot++) {
        const boneIndex = indices.getComponent(vertex, slot), weight = weights.getComponent(vertex, slot);
        if (owned[boneIndex]) influence += weight;
        if (weight > dominantWeight) { dominantWeight = weight; dominantBone = boneIndex; }
      }
      if (influence < .5) continue;
      skin.getVertexPosition(vertex, local).applyMatrix4(skin.matrixWorld).sub(origin).applyQuaternion(inverse);
      const point = project(local);
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('Nonfinite palm support skin');
      const pointIndex = points.push(point) - 1;
      const boneName = skin.skeleton.bones[dominantBone]?.name;
      if ((boneName !== hand.name && boneName !== prefix + 'Thumb1') || point.x > distalLimit) continue;
      let patch = 0, distance = Infinity;
      for (let i = 0; i < anchors.length; i++) {
        const next = (point.x - anchors[i]!.x) ** 2 + (point.y - anchors[i]!.y) ** 2;
        if (next < distance) { distance = next; patch = i; }
      }
      // A Voronoi boundary can otherwise label an ulnar point as thenar on the
      // neutral rig. Keep each distal patch on its actual landmark's side.
      if (patch > 0 && point.y * anchors[patch]!.y <= 0) continue;
      patches[patch]!.push(pointIndex);
    }
  });
  if (points.length < 4 || patches.some(patch => !patch.length)) throw new Error(`Incomplete palm support skin for ${hand.name}`);
  const hull = new ConvexHull().setFromPoints(points);
  const candidates = [new THREE.Vector3(0, 0, 1), ...hull.faces
    .filter(face => face.normal.z >= Math.cos(25 * Math.PI / 180)).map(face => face.normal)];
  const assess = (normal: THREE.Vector3) => {
    let depthM = -Infinity;
    for (const point of points) depthM = Math.max(depthM, point.dot(normal));
    const witnesses = patches.map(patch => {
      let index = patch[0]!, maximum = -Infinity;
      for (const candidate of patch) {
        const next = points[candidate]!.dot(normal);
        if (next > maximum) { maximum = next; index = candidate; }
      }
      return index;
    });
    const gaps = witnesses.map(index => depthM - points[index]!.dot(normal));
    const angle = Math.acos(THREE.MathUtils.clamp(normal.z, -1, 1));
    return { normal, depthM, witnesses, gaps, angle, score: Math.round(Math.max(...gaps) * 1e8) };
  };
  let best = assess(candidates[0]!);
  for (const normal of candidates.slice(1)) {
    const next = assess(normal);
    if (next.score < best.score || next.score === best.score && next.angle < best.angle) best = next;
  }
  const [a, b, c] = best.witnesses.map(index => points[index]!);
  return {
    normalLocal: forward.multiplyScalar(best.normal.x).addScaledVector(lateral, best.normal.y).addScaledVector(palmar, best.normal.z).normalize(),
    depthM: best.depthM, normalDeviationDeg: best.angle * 180 / Math.PI,
    patchClearanceM: { heel: best.gaps[0]!, thenar: best.gaps[1]!, ulnar: best.gaps[2]! },
    contactSpanM: Math.max(a!.distanceTo(b!), a!.distanceTo(c!), b!.distanceTo(c!)),
    contactTriangleAreaM2: b!.clone().sub(a!).cross(c!.clone().sub(a!)).length() / 2,
    vertexCount: points.length,
  };
}

/** Measure the current hand's actual skin in the requested support orientation.
 * Geometry stays unchanged. The result is a wrist height above a horizontal
 * plane, not tissue compression or a force estimate. All material-split meshes
 * sharing this hand are inspected; a missing surface must not become a wrist
 * center fallback. Finger descendants are included through rig ancestry. */
export function handSupportSurfaceHeight(
  referenceSkin: THREE.SkinnedMesh,
  hand: THREE.Bone,
  orientation: THREE.Quaternion,
): number {
  let model: THREE.Object3D = referenceSkin;
  while (model.parent && !(model.parent as THREE.Scene).isScene) model = model.parent;
  model.updateWorldMatrix(true, true);
  const origin = hand.getWorldPosition(new THREE.Vector3());
  const rotation = orientation.clone().normalize().multiply(hand.getWorldQuaternion(new THREE.Quaternion()).normalize().invert());
  const point = new THREE.Vector3();
  let minimumY = Infinity;
  model.traverse(object => {
    const skin = object as THREE.SkinnedMesh;
    if (!skin.isSkinnedMesh || !skin.skeleton.bones.includes(hand)) return;
    const owned = skin.skeleton.bones.map(bone => {
      let ancestor: THREE.Object3D | null = bone;
      while (ancestor && ancestor !== hand) ancestor = ancestor.parent;
      return ancestor === hand;
    });
    const indices = skin.geometry.getAttribute('skinIndex');
    const weights = skin.geometry.getAttribute('skinWeight');
    const positions = skin.geometry.getAttribute('position');
    if (!indices || !weights || !positions) return;
    skin.skeleton.update();
    for (let vertex = 0; vertex < positions.count; vertex++) {
      let influence = 0;
      for (let slot = 0; slot < weights.itemSize; slot++) {
        if (owned[indices.getComponent(vertex, slot)]) influence += weights.getComponent(vertex, slot);
      }
      if (influence < .5) continue;
      skin.getVertexPosition(vertex, point).applyMatrix4(skin.matrixWorld).sub(origin).applyQuaternion(rotation);
      if (!Number.isFinite(point.y)) throw new Error('Nonfinite hand support surface');
      minimumY = Math.min(minimumY, point.y);
    }
  });
  if (!Number.isFinite(minimumY)) throw new Error(`Missing hand support skin for ${hand.name}`);
  return -minimumY;
}
