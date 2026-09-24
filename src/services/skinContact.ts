import * as THREE from 'three';

/** Render-time geometric contact. Distances are metres, not force estimates. */
export const SKIN_CONTACT_CLEARANCE_M = 0.001;
export const MAX_SKIN_COMPRESSION_M = 0.004;
type Point = { x: number; y: number; z: number };
type XY = Pick<Point, 'x' | 'y'>;
type Triangle = [number, number, number];
interface Skin {
  mesh: THREE.SkinnedMesh;
  original: THREE.BufferGeometry;
  geometry: THREE.BufferGeometry | null;
  world: THREE.Vector3[];
  triangles: Triangle[];
  owners: string[];
  breathWeights: number[];
  changed: boolean;
}
const cross = (a: XY, b: XY, c: XY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** Counter-clockwise convex silhouette of a transformed mesh bounding box. */
function hull(points: XY[]): XY[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (items: XY[]) => {
    const out: XY[] = [];
    for (const p of items) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 1e-12) out.pop();
      out.push(p);
    }
    return out;
  };
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}

/** Clip a skin triangle to a prop silhouette, retaining depth at edge intersections. */
function clip(points: Point[], polygon: XY[]): Point[] {
  let output = points;
  for (let i = 0; i < polygon.length && output.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
    const input = output;
    output = [];
    let previous = input[input.length - 1]!, d0 = cross(a, b, previous);
    for (const current of input) {
      const d1 = cross(a, b, current);
      if ((d0 >= 0) !== (d1 >= 0)) {
        const t = d0 / (d0 - d1);
        output.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y), z: previous.z + t * (current.z - previous.z) });
      }
      if (d1 >= 0) output.push(current);
      previous = current; d0 = d1;
    }
  }
  return output;
}

function bounds(points: XY[]) {
  return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
}

function moveWorld(object: THREE.Object3D, delta: THREE.Vector3): void {
  const position = object.getWorldPosition(new THREE.Vector3()).add(delta);
  object.position.copy(object.parent ? object.parent.worldToLocal(position) : position);
  object.updateMatrixWorld(true);
}

/**
 * All instruments use the same final posed skin, including neighbouring limbs.
 * A conservative convex silhouette per rigid mesh prevents an arm/dial/palm
 * crossing skin between landmark samples. Only translation along the supplied
 * outward direction changes; measured angles and instrument geometry are kept.
 *
 * Pressure may displace the actual skin by at most 4 mm. This is a bounded
 * geometric approximation for kinematic playback, not simMOVE's native force
 * solver. Triangle corners share the displacement so even a small prop landing
 * inside a large skin triangle cannot disappear through an undeformed face.
 */
export class SkinContact {
  private readonly skins: Skin[] = [];
  private readonly inverses = new Map<THREE.SkinnedMesh, THREE.Matrix4[]>();
  private readonly displaced = new Set<THREE.Vector3>();

  constructor(private readonly root: THREE.Object3D) {
    root.traverse(object => {
      const mesh = object as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.geometry.getAttribute('skinIndex')) return;
      const count = mesh.geometry.getAttribute('position').count;
      const index = mesh.geometry.getIndex();
      const triangles: Triangle[] = [];
      const indices = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
      const owners = Array.from({ length: count }, (_, i) => {
        let slot = 0;
        for (let k = 1; k < 4; k++) if (weights.getComponent(i, k) > weights.getComponent(i, slot)) slot = k;
        return mesh.skeleton.bones[indices.getComponent(i, slot)]?.name ?? '';
      });
      const breathWeights = Array.from({ length: count }, (_, i) => {
        let weight = 0;
        for (let k = 0; k < 4; k++) if (/Spine|Breast/u.test(mesh.skeleton.bones[indices.getComponent(i, k)]?.name ?? '')) weight += weights.getComponent(i, k);
        return weight;
      });
      for (let i = 0; i < (index?.count ?? count); i += 3) triangles.push(index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2]);
      this.skins.push({ mesh, original: mesh.geometry, geometry: null, world: Array.from({ length: count }, () => new THREE.Vector3()), triangles, owners, breathWeights, changed: false });
    });
  }

  /** Once per rendered frame, after the skeleton and all breathing/sway overlays. */
  update(): void {
    this.restore();
    this.root.updateMatrixWorld(true);
    for (const skin of this.skins) for (let i = 0; i < skin.world.length; i++) skin.mesh.getVertexPosition(i, skin.world[i]!).applyMatrix4(skin.mesh.matrixWorld);
  }

  /** Rib/abdominal excursion without moving the supported skeleton or its head. */
  breathe(base: THREE.Vector3, neck: THREE.Vector3, front: THREE.Vector3, left: THREE.Vector3, excursionM: number, supportY = -Infinity): void {
    if (!(excursionM > 0)) return;
    const up = neck.clone().sub(base), length = up.length();
    if (length < 0.01) return;
    up.divideScalar(length);
    const amount = Math.min(excursionM, 0.012);
    for (const skin of this.skins) for (let i = 0; i < skin.world.length; i++) {
      const weight = skin.breathWeights[i]!;
      if (weight < 0.001) continue;
      const p = skin.world[i]!, relative = p.clone().sub(base);
      const t = relative.dot(up) / length;
      if (t <= 0 || t >= 1) continue;
      const envelope = Math.sin(Math.PI * t) * weight * amount;
      const delta = front.clone().multiplyScalar(THREE.MathUtils.clamp(relative.dot(front) / 0.14, -1, 1) * envelope)
        .addScaledVector(left, THREE.MathUtils.clamp(relative.dot(left) / 0.18, -1, 1) * envelope * 0.4);
      // Loaded tissue stays against the support; expansion goes into free space.
      delta.y = Math.max(delta.y, supportY - p.y);
      this.displace(skin, i, delta, false);
    }
  }

  /** Lowest skin within a finite horizontal support (triangle interiors included). */
  lowest(polygon?: XY[], supportBones?: RegExp): number {
    let lowest = Infinity;
    const bb = polygon ? bounds(polygon) : null;
    for (const skin of this.skins) {
      if (!polygon) { for (let i = 0; i < skin.world.length; i++) if (!supportBones || supportBones.test(skin.owners[i]!)) lowest = Math.min(lowest, skin.world[i]!.y); continue; }
      for (const triangle of skin.triangles) {
        if (supportBones && !triangle.every(i => supportBones.test(skin.owners[i]!))) continue;
        const points = triangle.map(i => ({ x: skin.world[i]!.x, y: skin.world[i]!.z, z: skin.world[i]!.y }));
        if (points.every(p => p.x < bb!.minX) || points.every(p => p.x > bb!.maxX) || points.every(p => p.y < bb!.minY) || points.every(p => p.y > bb!.maxY)) continue;
        for (const p of clip(points, polygon)) lowest = Math.min(lowest, p.z);
      }
    }
    return lowest;
  }

  /** Ground only an engaged support; the caller decides when intentional lift-off releases it. */
  support(y: number, polygon: XY[] | undefined, settle: boolean, compressionM = 0, supportBones?: RegExp): number {
    const lowest = this.lowest(polygon, supportBones);
    if (!Number.isFinite(lowest) || (!settle && lowest >= y)) return 0;
    const compression = THREE.MathUtils.clamp(compressionM, 0, MAX_SKIN_COMPRESSION_M);
    const delta = y - lowest - compression;
    moveWorld(this.root, new THREE.Vector3(0, delta, 0));
    this.inverses.clear();
    for (const skin of this.skins) for (const p of skin.world) p.y += delta;
    // Flatten the compressed surface onto the support, with no residual overlap.
    if (compression > 0) for (const skin of this.skins) {
      const moves = new Map<number, number>();
      for (const triangle of skin.triangles) {
        if (supportBones && !triangle.every(i => supportBones.test(skin.owners[i]!))) continue;
        const points = triangle.map(i => ({ x: skin.world[i]!.x, y: skin.world[i]!.z, z: skin.world[i]!.y }));
        const overlap = polygon ? clip(points, polygon) : points;
        if (!overlap.length) continue;
        const depth = Math.min(compression, Math.max(0, y - Math.min(...overlap.map(p => p.z))));
        if (depth > 0) for (const i of triangle) moves.set(i, Math.max(moves.get(i) ?? 0, depth));
      }
      for (const [i, depth] of moves) this.displace(skin, i, new THREE.Vector3(0, depth, 0));
    }
    return delta;
  }

  /** Resolve every visible solid mesh in a prop, then optionally compress the contacting skin. */
  resolve(object: THREE.Object3D, outward: THREE.Vector3, compressionM = 0): number {
    if (!object.visible || outward.lengthSq() < 1e-12) return 0;
    const normal = outward.clone().normalize();
    const x = new THREE.Vector3().crossVectors(Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), normal).normalize();
    const y = new THREE.Vector3().crossVectors(normal, x);
    const project = (p: THREE.Vector3): Point => ({ x: p.dot(x), y: p.dot(y), z: p.dot(normal) });
    const projected = this.skins.map(skin => ({ skin, points: skin.world.map(project) }));
    const constraints: { skin: Skin; triangle: Triangle; required: number }[] = [];
    let shift = 0;
    object.updateWorldMatrix(true, true);
    object.traverseVisible(child => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.skinContact === false) return;
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box || box.isEmpty()) return;
      const corners: Point[] = [];
      for (const a of [box.min.x, box.max.x]) for (const b of [box.min.y, box.max.y]) for (const c of [box.min.z, box.max.z]) corners.push(project(new THREE.Vector3(a, b, c).applyMatrix4(mesh.matrixWorld)));
      const polygon = hull(corners), bb = bounds(corners);
      if (polygon.length < 3) return;
      const near = Math.min(...corners.map(p => p.z));
      for (const { skin, points } of projected) for (const triangle of skin.triangles) {
        const a = points[triangle[0]]!, b = points[triangle[1]]!, c = points[triangle[2]]!;
        if (Math.max(a.x, b.x, c.x) < bb.minX || Math.min(a.x, b.x, c.x) > bb.maxX || Math.max(a.y, b.y, c.y) < bb.minY || Math.min(a.y, b.y, c.y) > bb.maxY || Math.max(a.z, b.z, c.z) + SKIN_CONTACT_CLEARANCE_M < near) continue;
        const overlap = clip([a, b, c], polygon);
        if (!overlap.length) continue;
        const required = Math.max(...overlap.map(p => p.z)) + SKIN_CONTACT_CLEARANCE_M - near;
        if (required <= 0) continue;
        shift = Math.max(shift, required);
        constraints.push({ skin, triangle, required });
      }
    });
    // Previously compressed tissue cannot be moved again by a competing prop.
    const fresh = constraints.every(c => c.triangle.every(i => !this.displaced.has(c.skin.world[i]!)));
    const compression = fresh ? Math.min(shift, THREE.MathUtils.clamp(compressionM, 0, MAX_SKIN_COMPRESSION_M)) : 0;
    shift -= compression;
    if (shift > 0) moveWorld(object, normal.clone().multiplyScalar(shift));
    const moves = new Map<Skin, Map<number, number>>();
    if (compression > 0) for (const c of constraints) {
      const depth = Math.max(0, c.required - shift);
      if (!depth) continue;
      let vertices = moves.get(c.skin);
      if (!vertices) { vertices = new Map(); moves.set(c.skin, vertices); }
      for (const i of c.triangle) vertices.set(i, Math.max(vertices.get(i) ?? 0, depth));
    }
    for (const [skin, vertices] of moves) for (const [i, depth] of vertices) this.displace(skin, i, normal.clone().multiplyScalar(-depth));
    return shift;
  }

  private displace(skin: Skin, index: number, delta: THREE.Vector3, pressure = true): void {
    if (delta.lengthSq() < 1e-18) return;
    if (!skin.geometry) skin.geometry = skin.original.clone();
    if (!skin.changed) {
      const target = skin.geometry.getAttribute('position'), source = skin.original.getAttribute('position');
      for (let i = 0; i < source.count; i++) target.setXYZ(i, source.getX(i), source.getY(i), source.getZ(i));
      skin.mesh.geometry = skin.geometry;
      skin.changed = true;
    }
    const mesh = skin.mesh;
    let matrices = this.inverses.get(mesh);
    if (!matrices) {
      matrices = mesh.skeleton.bones.map((bone, i) => bone.matrixWorld.clone().multiply(mesh.skeleton.boneInverses[i]!));
      this.inverses.set(mesh, matrices);
    }
    const indices = skin.original.getAttribute('skinIndex'), weights = skin.original.getAttribute('skinWeight');
    const matrix = new THREE.Matrix4();
    matrix.elements.fill(0);
    for (let j = 0; j < 4; j++) {
      const weight = weights.getComponent(index, j);
      if (!weight) continue;
      const bone = matrices[indices.getComponent(index, j)]!;
      for (let k = 0; k < 16; k++) matrix.elements[k]! += bone.elements[k]! * weight;
    }
    matrix.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix).premultiply(mesh.matrixWorld).invert();
    const point = skin.world[index]!.add(delta);
    if (pressure) this.displaced.add(point);
    const local = point.clone().applyMatrix4(matrix);
    skin.geometry.getAttribute('position').setXYZ(index, local.x, local.y, local.z);
  }

  /** Upload the corrected geometry once, after all contacts have been resolved. */
  finish(): void {
    for (const skin of this.skins) if (skin.changed) {
      skin.geometry!.getAttribute('position').needsUpdate = true;
      skin.geometry!.computeVertexNormals();
      skin.geometry!.computeBoundingSphere();
    }
  }

  /** Restore after rendering so loads, recordings, reloads and undo use the original mesh. */
  restore(): void {
    for (const skin of this.skins) { if (skin.changed) skin.mesh.geometry = skin.original; skin.changed = false; }
    this.inverses.clear();
    this.displaced.clear();
  }

  dispose(): void {
    this.restore();
    for (const skin of this.skins) skin.geometry?.dispose();
  }
}
