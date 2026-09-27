import * as THREE from 'three';

/** Render-time geometric contact. Distances are metres, not force estimates. */
export const SKIN_CONTACT_CLEARANCE_M = 0.001;
export const MAX_SKIN_COMPRESSION_M = 0.004;
/** A dent in soft tissue keeps its full depth this far past what rests in it (m): about a skin triangle's width. */
const DENT_MARGIN_M = 0.012;
/** How hard soft tissue pushes back for each metre it is pressed (Pa/m), where a caller names none. */
export const DEFAULT_TISSUE_STIFFNESS = 600_000;

/** A foam layer the body lies or sits on: flat-topped at rest, of finite depth, and compressible. */
export interface Cushion {
  /** Height of the foam's top at rest (world y). */
  top: number;
  /** Its outline: convex and counter-clockwise in world X/Z (as x, y). Its first edge sets the field's grid. */
  polygon: Pick<Point, 'x' | 'y'>[];
  /** Openings through it (a prone face hole), convex. */
  openings?: Pick<Point, 'x' | 'y'>[][];
  /** How deep the foam is (m): skin further below its top is under it, not in it. */
  thicknessM: number;
  /** How hard it pushes back for each metre it is pressed in (Pa/m: the pressure per metre of compression). */
  stiffness: number;
}

export interface PressOptions {
  /** The weight the cushion carries (N): the pressure field is scaled to carry it. */
  loadN: number;
  /** How hard the tissue over each bone pushes back for each metre it is pressed (Pa/m), by the skin's owning bone. */
  tissue?: (owner: string) => number;
  /** The field's cell (m); default 1.5 cm. */
  cellM?: number;
  /** How far the foam's dip reaches past the skin pressing it (m); default half the foam's depth. */
  spreadM?: number;
}

/** What a cushion bears: how its surface is pressed down, and the pressure on it. */
export interface CushionField {
  /** Cell (i, j) is centred at origin + (i + 0.5) cellM u + (j + 0.5) cellM v (world X/Z as x, y); index j * cols + i. */
  origin: Pick<Point, 'x' | 'y'>; u: Pick<Point, 'x' | 'y'>; v: Pick<Point, 'x' | 'y'>;
  cellM: number; cols: number; rows: number;
  /** Which cells are foam (inside the outline, clear of its openings). */
  foam: Uint8Array;
  /** How far the foam's top is pressed down in each cell (m). */
  deflection: Float32Array;
  /** The contact pressure in each cell (Pa), scaled so the cells together carry the load. */
  pressure: Float32Array;
  /** The area bearing (m²) and the highest pressure on it (Pa). */
  areaM2: number; peakPa: number;
  /**
   * How much further the body would sink (m; negative: rise) for the foam and tissue, as they are pressed, to carry
   * the load by themselves: how far the depth it was laid at is from the depth its own weight would give it.
   */
  imbalanceM: number;
}
/** SkinContact.skinAlong's reach: across the normal, and how far a height it keeps to rest on may lie from the origin's. */
export interface SkinAlongOptions {
  /**
   * The skin of what is held, by its owning bone (a leg, for a hand holding it): what a thing laid on it rests on and
   * rises out of. The rest of the skin it only must stay out of. Default: all of it.
   */
  own?: RegExp;
  /** Round the origin across the normal (m); default 20 cm, a hand and its wrist. */
  radiusM?: number;
  /** Skin to rest on is taken this far under the origin's level along the normal, and this far over it (m); default 5 cm each. */
  below?: number;
  above?: number;
  /** The grid's cell (m); default 5 mm. */
  cellM?: number;
}
/** The posed skin round a point, seen along a direction out of it (SkinContact.skinAlong). */
export interface SkinProfile {
  /**
   * The skin something laid over `point` rests on: its height there, m along the direction from the origin. Of the
   * held skin (`own`) facing along the direction (not the far side of a limb, nor another limb's side facing the thing
   * laid on it), the part nearest the origin's level within the reach given (the buttocks beside a hand on the sacrum,
   * not the far thigh beyond a hand on the inner thigh); -Infinity where there is none.
   */
  height(point: THREE.Vector3): number;
  /** How far `point` must move along the direction to come out of the held skin (m; 0 outside it): a finger curled into the limb it holds. */
  rise(point: THREE.Vector3): number;
  /**
   * How far `point` is inside the skin there (m along the direction, the nearer way out; 0 outside it): of the held
   * skin, the rest (`other`: a wrist or forearm in the other leg, which resting on the skin under the palm says
   * nothing about), or all of it. Inside is between skin facing along the direction beyond it and skin facing back
   * against it behind it.
   */
  depth(point: THREE.Vector3, of?: 'own' | 'other' | 'all'): number;
}
/** How far along the normal skinAlong reaches from its origin, either way (m): past a hand's wrist and forearm. */
const SKIN_ALONG_REACH_M = 0.3;
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
  /** Vertices moved this frame, whose normals are recomputed (the rest keep the model's own). */
  moved: Set<number>;
  /** Each vertex's tissue stiffness, for the function it was read with. */
  tissue?: { of: (owner: string) => number; stiffness: Float32Array };
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
    output = clipEdge(output, polygon[i]!, polygon[(i + 1) % polygon.length]!);
  }
  return output;
}

function clipEdge(input: Point[], a: XY, b: XY): Point[] {
  if (!input.length) return [];
  const output: Point[] = [];
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
  return output;
}

/** Remove convex openings; the remaining pieces retain interpolated skin height at the rim. */
function supportedParts(points: Point[], polygon: XY[] | undefined, openings: { polygon: XY[]; bb: ReturnType<typeof bounds> }[]): Point[][] {
  let parts = [polygon ? clip(points, polygon) : points];
  for (const { polygon: opening, bb } of openings) {
    parts = parts.flatMap(part => {
      if (!part.length) return [];
      if (part.every(p => p.x < bb.minX) || part.every(p => p.x > bb.maxX) || part.every(p => p.y < bb.minY) || part.every(p => p.y > bb.maxY)) return [part];
      let inside = part;
      const outside: Point[][] = [];
      for (let i = 0; i < opening.length && inside.length; i++) {
        const a = opening[i]!, b = opening[(i + 1) % opening.length]!;
        const piece = clipEdge(inside, b, a);
        if (piece.length) outside.push(piece);
        inside = clipEdge(inside, a, b);
      }
      return outside;
    });
  }
  return parts;
}

function bounds(points: XY[]) {
  return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
}

/**
 * A cushion at rest, nothing on it: its grid (along the outline's first edge, and across it), which cells are foam,
 * and a flat surface. SkinContact.press() lays its field out on the same grid, so a drawn foam and the skin pressed
 * into it agree.
 */
export function cushionGrid(cushion: Pick<Cushion, 'polygon' | 'openings'>, cellM = 0.015): CushionField {
  const { polygon } = cushion, cell = cellM;
  const a0 = polygon[0]!, a1 = polygon[1]!, length = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
  const u = { x: (a1.x - a0.x) / length, y: (a1.y - a0.y) / length }, v = { x: -u.y, y: u.x };
  const us = polygon.map(p => p.x * u.x + p.y * u.y), vs = polygon.map(p => p.x * v.x + p.y * v.y);
  const u0 = Math.min(...us), v0 = Math.min(...vs);
  const cols = Math.max(1, Math.ceil((Math.max(...us) - u0) / cell - 1e-9)), rows = Math.max(1, Math.ceil((Math.max(...vs) - v0) / cell - 1e-9));
  const origin = { x: u0 * u.x + v0 * v.x, y: u0 * u.y + v0 * v.y };
  const n = cols * rows;
  const within = (p: XY, shape: XY[]) => shape.every((a, k) => cross(a, shape[(k + 1) % shape.length]!, p) >= 0);
  const holes = (cushion.openings ?? []).filter(p => p.length >= 3);
  const foam = new Uint8Array(n);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const p = { x: origin.x + (i + 0.5) * cell * u.x + (j + 0.5) * cell * v.x, y: origin.y + (i + 0.5) * cell * u.y + (j + 0.5) * cell * v.y };
    foam[j * cols + i] = within(p, polygon) && !holes.some(hole => within(p, hole)) ? 1 : 0;
  }
  return { origin, u, v, cellM: cell, cols, rows, foam, deflection: new Float32Array(n), pressure: new Float32Array(n), areaM2: 0, peakPa: 0, imbalanceM: 0 };
}

/** How far a cushion's surface is pressed down at world (x, z) (m), between its cells' centres. */
export function cushionDepth(field: CushionField, x: number, z: number): number {
  const { origin, u, v, cellM, cols, rows, deflection } = field;
  const gx = THREE.MathUtils.clamp(((x - origin.x) * u.x + (z - origin.y) * u.y) / cellM - 0.5, 0, cols - 1);
  const gy = THREE.MathUtils.clamp(((x - origin.x) * v.x + (z - origin.y) * v.y) / cellM - 0.5, 0, rows - 1);
  const i = Math.min(Math.max(0, cols - 2), Math.floor(gx)), j = Math.min(Math.max(0, rows - 2), Math.floor(gy));
  const fx = gx - i, fy = gy - j;
  const at = (ii: number, jj: number) => deflection[Math.min(rows - 1, jj) * cols + Math.min(cols - 1, ii)]!;
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
}

/**
 * A foam's surface over the cells: pressed where the skin presses it (`raw`), and bent down past it by a separable
 * Gaussian of `radius` cells, never above the pressed depth where the skin is. Foam cells only.
 */
function spreadDip(raw: Float32Array, foam: Uint8Array, cols: number, rows: number, radius: number): Float32Array {
  const out = new Float32Array(raw.length);
  if (!(radius > 0.25)) { for (let c = 0; c < raw.length; c++) out[c] = foam[c] ? raw[c]! : 0; return out; }
  const r = Math.ceil(radius * 2), sigma = radius;
  const weights = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      let value = 0;
      for (let k = -r; k <= r; k++) {
        const ii = horizontal ? i + k : i, jj = horizontal ? j : j + k;
        if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
        value += from[jj * cols + ii]! * weights[k + r]!;
      }
      to[j * cols + i] = value / sum;
    }
  };
  const across = new Float32Array(raw.length);
  pass(raw, across, true);
  pass(across, out, false);
  for (let c = 0; c < raw.length; c++) out[c] = foam[c] ? Math.max(raw[c]!, out[c]!) : 0;
  return out;
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
  /** The last cushion's grid (its cells and which are foam), kept while the cushion stays where it is. */
  private grid: { key: string; field: CushionField } | null = null;

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
      this.skins.push({ mesh, original: mesh.geometry, geometry: null, world: Array.from({ length: count }, () => new THREE.Vector3()), triangles, owners, breathWeights, changed: false, moved: new Set() });
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

  /**
   * Lowest skin within a finite horizontal support, excluding openings. Polygons are convex and CCW in world X/Z;
   * triangle interiors count at the rim. A support is a slab, not a column: skin wholly below `floor` (its underside)
   * hangs beneath it, beside its edge, and is not in it (a hand hanging under a plinth's edge, counted, lifted the arm
   * or the whole patient 36 cm).
   */
  lowest(polygon?: XY[], supportBones?: RegExp, openings: XY[][] = [], floor = -Infinity): number {
    let lowest = Infinity;
    const bb = polygon ? bounds(polygon) : null;
    const holes = openings.filter(p => p.length >= 3).map(polygon => ({ polygon, bb: bounds(polygon) }));
    for (const skin of this.skins) {
      if (!polygon && !openings.length) { for (let i = 0; i < skin.world.length; i++) if ((!supportBones || supportBones.test(skin.owners[i]!)) && skin.world[i]!.y >= floor) lowest = Math.min(lowest, skin.world[i]!.y); continue; }
      for (const triangle of skin.triangles) {
        if (supportBones && !triangle.every(i => supportBones.test(skin.owners[i]!))) continue;
        const points = triangle.map(i => ({ x: skin.world[i]!.x, y: skin.world[i]!.z, z: skin.world[i]!.y }));
        if (points.every(p => p.z < floor)) continue;
        if (bb && (points.every(p => p.x < bb.minX) || points.every(p => p.x > bb.maxX) || points.every(p => p.y < bb.minY) || points.every(p => p.y > bb.maxY))) continue;
        for (const part of supportedParts(points, polygon, holes)) for (const p of part) lowest = Math.min(lowest, p.z);
      }
    }
    return lowest;
  }

  /**
   * Press the posed skin into a foam cushion it has been laid into (the caller lowers the body to the depth it rests at).
   * Where the skin is below the foam's top, the two give like springs in series: the foam by its stiffness, the tissue
   * over each bone by its own, so bony skin (a heel, the back of the skull) dents the foam and soft tissue (a buttock, a
   * calf) flattens against it. The foam's dip reaches a little past the skin (its surface bends; it is not cut at the
   * skin's edge), and the skin under it rests on it. Returns the field for drawing the foam and its pressure.
   */
  press(cushion: Cushion, options: PressOptions): CushionField {
    const { top, thicknessM: thickness, stiffness: kf } = cushion;
    const tissueOf = options.tissue ?? (() => DEFAULT_TISSUE_STIFFNESS);
    const key = JSON.stringify([cushion.polygon, cushion.openings ?? [], options.cellM ?? null]);
    if (this.grid?.key !== key) this.grid = { key, field: cushionGrid(cushion, options.cellM) };
    const { origin, u, v, cellM: cell, cols, rows, foam } = this.grid.field;
    const n = cols * rows;
    const gridI = (p: THREE.Vector3) => ((p.x - origin.x) * u.x + (p.z - origin.y) * u.y) / cell;
    const gridJ = (p: THREE.Vector3) => ((p.x - origin.x) * v.x + (p.z - origin.y) * v.y) / cell;
    // The body's underside over each cell (the lowest skin in it) and the tissue there, from skin in the foam or just
    // above it (which the body sinks onto if it is carrying too little).
    const floor = top - thickness, reach = top + thickness;
    const under = new Float32Array(n).fill(Infinity), soft = new Float32Array(n);
    const mark = (i: number, j: number, y: number, k: number) => {
      if (i < 0 || j < 0 || i >= cols || j >= rows) return;
      const c = j * cols + i;
      if (foam[c] && y < under[c]!) { under[c] = y; soft[c] = k; }
    };
    for (const skin of this.skins) {
      if (skin.tissue?.of !== tissueOf) skin.tissue = { of: tissueOf, stiffness: Float32Array.from(skin.owners, owner => tissueOf(owner)) };
      const stiffness = skin.tissue.stiffness;
      for (const [a, b, c] of skin.triangles) {
        const pa = skin.world[a]!, pb = skin.world[b]!, pc = skin.world[c]!;
        if (Math.min(pa.y, pb.y, pc.y) >= reach || Math.max(pa.y, pb.y, pc.y) < floor) continue;
        const ia = gridI(pa), ja = gridJ(pa), ib = gridI(pb), jb = gridJ(pb), ic = gridI(pc), jc = gridJ(pc);
        // Each corner marks its own cell (a triangle smaller than a cell may hold no cell's centre)…
        for (const [i, j, p, k] of [[ia, ja, pa, a], [ib, jb, pb, b], [ic, jc, pc, c]] as const) if (p.y >= floor) mark(Math.floor(i), Math.floor(j), p.y, stiffness[k]!);
        // …and each cell centre inside it takes its height there.
        const det = (ib - ia) * (jc - ja) - (ic - ia) * (jb - ja);
        if (Math.abs(det) < 1e-12) continue;
        const i0 = Math.max(0, Math.ceil(Math.min(ia, ib, ic) - 0.5)), i1 = Math.min(cols - 1, Math.floor(Math.max(ia, ib, ic) - 0.5));
        const j0 = Math.max(0, Math.ceil(Math.min(ja, jb, jc) - 0.5)), j1 = Math.min(rows - 1, Math.floor(Math.max(ja, jb, jc) - 0.5));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = i + 0.5 - ia, y = j + 0.5 - ja;
          const wb = (x * (jc - ja) - (ic - ia) * y) / det, wc = ((ib - ia) * y - x * (jb - ja)) / det, wa = 1 - wb - wc;
          if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
          const h = wa * pa.y + wb * pb.y + wc * pc.y;
          if (h < floor) continue;
          mark(i, j, h, stiffness[wa >= wb && wa >= wc ? a : wb >= wc ? b : c]!);
        }
      }
    }
    // Springs in series: the pressure through foam and tissue for an overlap. The foam bottoms out short of its depth,
    // beyond which the tissue alone gives.
    const cap = 0.85 * thickness;
    const foamPart = (overlap: number, kt: number) => Math.min(cap, overlap * kt / (kf + kt));
    const pressureAt = (overlap: number, kt: number) => {
      if (overlap <= 0) return 0;
      const foamDip = foamPart(overlap, kt);
      return foamDip < cap ? kf * foamDip : Math.max(kf * cap, kt * (overlap - cap));
    };
    const area = cell * cell;
    // The cells with skin over them, the only ones that can bear.
    const bearing: number[] = [];
    for (let c = 0; c < n; c++) if (under[c]! < Infinity) bearing.push(c);
    const carried = (extra: number) => {
      let sum = 0;
      for (const c of bearing) sum += pressureAt(top - under[c]! + extra, soft[c]!) * area;
      return sum;
    };
    // How far the body is from carrying its load as it lies (bisection: carried rises with sinking).
    let imbalanceM = 0;
    if (options.loadN > 0) {
      let low = -thickness, high = thickness;
      if (carried(high) < options.loadN) imbalanceM = high;
      else {
        // To a hundredth of a millimetre.
        for (let k = 0; k < 14; k++) { const mid = (low + high) / 2; if (carried(mid) < options.loadN) low = mid; else high = mid; }
        imbalanceM = (low + high) / 2;
      }
    }
    // The foam where the skin is in it; then its surface, bent past the skin by a blur that never lifts it.
    const raw = new Float32Array(n), pressure = new Float32Array(n);
    let total = 0;
    for (const c of bearing) {
      const overlap = top - under[c]!;
      if (!(overlap > 0)) continue;
      raw[c] = foamPart(overlap, soft[c]!);
      pressure[c] = pressureAt(overlap, soft[c]!);
      total += pressure[c]! * area;
    }
    const deflection = spreadDip(raw, foam, cols, rows, (options.spreadM ?? thickness / 2) / cell);
    let areaM2 = 0, peakPa = 0;
    const scale = total > 0 && options.loadN > 0 ? options.loadN / total : 1;
    for (let c = 0; c < n; c++) if (pressure[c]! > 0) { pressure[c] = pressure[c]! * scale; areaM2 += area; peakPa = Math.max(peakPa, pressure[c]!); }
    // The skin under the foam's surface rests on it: its tissue gives the rest of the overlap.
    const field: CushionField = { origin, u, v, cellM: cell, cols, rows, foam, deflection, pressure, areaM2, peakPa, imbalanceM };
    const lift = new THREE.Vector3();
    for (const skin of this.skins) for (let i = 0; i < skin.world.length; i++) {
      const p = skin.world[i]!;
      if (p.y >= top || p.y < floor) continue;
      const ci = Math.floor(gridI(p)), cj = Math.floor(gridJ(p));
      if (ci < 0 || cj < 0 || ci >= cols || cj >= rows || !foam[cj * cols + ci]) continue;
      const y = top - cushionDepth(field, p.x, p.z);
      if (p.y < y) this.displace(skin, i, lift.set(0, y - p.y, 0));
    }
    return field;
  }

  /**
   * The top of `onto`'s skin (its highest point in each column, looking down) and `region`'s underside (its lowest),
   * over a grid around `region` (m; world y, -Infinity / Infinity where the part has no skin), for one part resting on
   * another: a hand on the abdomen, a forearm across it.
   */
  private columns(region: RegExp, onto: RegExp, cell: number, margin: number) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const skin of this.skins) for (let i = 0; i < skin.world.length; i++) {
      if (!region.test(skin.owners[i]!)) continue;
      const p = skin.world[i]!;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    if (!(maxX >= minX)) return null;
    const x0 = minX - margin, z0 = minZ - margin;
    const cols = Math.max(1, Math.ceil((maxX - minX + 2 * margin) / cell)), rows = Math.max(1, Math.ceil((maxZ - minZ + 2 * margin) / cell));
    const top = new Float32Array(cols * rows).fill(-Infinity), under = new Float32Array(cols * rows).fill(Infinity);
    const raster = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, write: (k: number, y: number) => void) => {
      const ia = (a.x - x0) / cell, ja = (a.z - z0) / cell, ib = (b.x - x0) / cell, jb = (b.z - z0) / cell, ic = (c.x - x0) / cell, jc = (c.z - z0) / cell;
      if (Math.max(ia, ib, ic) < 0 || Math.max(ja, jb, jc) < 0 || Math.min(ia, ib, ic) >= cols || Math.min(ja, jb, jc) >= rows) return;
      for (const [i, j, p] of [[ia, ja, a], [ib, jb, b], [ic, jc, c]] as const) {
        const ci = Math.floor(i), cj = Math.floor(j);
        if (ci >= 0 && cj >= 0 && ci < cols && cj < rows) write(cj * cols + ci, p.y);
      }
      const det = (ib - ia) * (jc - ja) - (ic - ia) * (jb - ja);
      if (Math.abs(det) < 1e-12) return;
      const i0 = Math.max(0, Math.ceil(Math.min(ia, ib, ic) - 0.5)), i1 = Math.min(cols - 1, Math.floor(Math.max(ia, ib, ic) - 0.5));
      const j0 = Math.max(0, Math.ceil(Math.min(ja, jb, jc) - 0.5)), j1 = Math.min(rows - 1, Math.floor(Math.max(ja, jb, jc) - 0.5));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = i + 0.5 - ia, y = j + 0.5 - ja;
        const wb = (x * (jc - ja) - (ic - ia) * y) / det, wc = ((ib - ia) * y - x * (jb - ja)) / det, wa = 1 - wb - wc;
        if (wa >= -1e-9 && wb >= -1e-9 && wc >= -1e-9) write(j * cols + i, wa * a.y + wb * b.y + wc * c.y);
      }
    };
    for (const skin of this.skins) for (const [a, b, c] of skin.triangles) {
      const inRegion = region.test(skin.owners[a]!) && region.test(skin.owners[b]!) && region.test(skin.owners[c]!);
      const inOnto = !inRegion && onto.test(skin.owners[a]!) && onto.test(skin.owners[b]!) && onto.test(skin.owners[c]!);
      if (inRegion) raster(skin.world[a]!, skin.world[b]!, skin.world[c]!, (k, y) => { if (y < under[k]!) under[k] = y; });
      else if (inOnto) raster(skin.world[a]!, skin.world[b]!, skin.world[c]!, (k, y) => { if (y > top[k]!) top[k] = y; });
    }
    const cellOf = (x: number, z: number) => {
      const i = Math.floor((x - x0) / cell), j = Math.floor((z - z0) / cell);
      return i < 0 || j < 0 || i >= cols || j >= rows ? -1 : j * cols + i;
    };
    return { top, under, cols, rows, cell, x0, z0, cellOf };
  }

  /**
   * The posed skin round `origin`, seen along unit `normal` (out of the skin there): for fitting a rigid thing laid
   * against it, its underside toward the skin (an examiner's hand), where a measured outline would fit it only roughly.
   * `radiusM` round the origin across the normal, in cells of `cellM`.
   */
  skinAlong(origin: THREE.Vector3, normal: THREE.Vector3, { own, radiusM = 0.2, below = 0.05, above = 0.05, cellM = 0.005 }: SkinAlongOptions = {}): SkinProfile {
    const n = normal.clone().normalize();
    const a = new THREE.Vector3().crossVectors(Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), n).normalize();
    const b = new THREE.Vector3().crossVectors(n, a);
    const size = Math.ceil(2 * radiusM / cellM);
    // Each cell's crossings of the skin, as (height, facing, held) triples: facing 1 where the skin faces along the
    // normal, held 1 where it is the skin `own` names.
    const cells: (number[] | undefined)[] = new Array(size * size);
    const owned = new Map<string, number>();
    const held = (owner: string) => { let value = owned.get(owner); if (value === undefined) { value = !own || own.test(owner) ? 1 : 0; owned.set(owner, value); } return value; };
    const d = new THREE.Vector3();
    const local = (p: THREE.Vector3) => { d.subVectors(p, origin); return { i: (d.dot(a) + radiusM) / cellM, j: (d.dot(b) + radiusM) / cellM, h: d.dot(n) }; };
    const cross = (i: number, j: number, h: number, facing: number, mine: number) => {
      if (i < 0 || j < 0 || i >= size || j >= size) return;
      (cells[j * size + i] ??= []).push(h, facing, mine);
    };
    const reach = Math.hypot(radiusM * Math.SQRT2, SKIN_ALONG_REACH_M), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    for (const skin of this.skins) for (const [ia, ib, ic] of skin.triangles) {
      const pa = skin.world[ia]!, pb = skin.world[ib]!, pc = skin.world[ic]!;
      if (pa.distanceToSquared(origin) > reach * reach && pb.distanceToSquared(origin) > reach * reach && pc.distanceToSquared(origin) > reach * reach) continue;
      // The mesh winds its outside counter-clockwise.
      const facing = e1.subVectors(pb, pa).cross(e2.subVectors(pc, pa)).dot(n);
      if (Math.abs(facing) < 1e-12) continue;
      const A = local(pa), B = local(pb), C = local(pc), side = facing > 0 ? 1 : 0, mine = held(skin.owners[ia] ?? '');
      const det = (B.i - A.i) * (C.j - A.j) - (C.i - A.i) * (B.j - A.j);
      const i0 = Math.max(0, Math.ceil(Math.min(A.i, B.i, C.i) - 0.5)), i1 = Math.min(size - 1, Math.floor(Math.max(A.i, B.i, C.i) - 0.5));
      const j0 = Math.max(0, Math.ceil(Math.min(A.j, B.j, C.j) - 0.5)), j1 = Math.min(size - 1, Math.floor(Math.max(A.j, B.j, C.j) - 0.5));
      let covered = false;
      if (Math.abs(det) > 1e-12) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = i + 0.5 - A.i, y = j + 0.5 - A.j;
        const wb = (x * (C.j - A.j) - (C.i - A.i) * y) / det, wc = ((B.i - A.i) * y - x * (B.j - A.j)) / det, wa = 1 - wb - wc;
        if (wa >= -1e-9 && wb >= -1e-9 && wc >= -1e-9) { cross(i, j, wa * A.h + wb * B.h + wc * C.h, side, mine); covered = true; }
      }
      // A triangle smaller than a cell still crosses the one it is in.
      if (!covered) cross(Math.floor((A.i + B.i + C.i) / 3), Math.floor((A.j + B.j + C.j) / 3), (A.h + B.h + C.h) / 3, side, mine);
    }
    const cellOf = (point: THREE.Vector3) => {
      const { i, j, h } = local(point);
      const ci = Math.floor(i), cj = Math.floor(j);
      return { crossings: ci < 0 || cj < 0 || ci >= size || cj >= size ? undefined : cells[cj * size + ci], h };
    };
    /**
     * Where `point` is in the skin `of` which part (1 held, 0 the rest, -1 all): the nearest crossing beyond it along
     * the normal and behind it, and whether it is inside (between skin facing along the normal beyond it and skin
     * facing back against it behind it; skin on one side only is the edge of a limb seen side-on, where the grid can
     * miss its steep flank).
     */
    const within = (point: THREE.Vector3, of: number) => {
      const { crossings, h } = cellOf(point);
      let over = Infinity, overFacing = 0, under = -Infinity, underFacing = 1;
      if (crossings) for (let k = 0; k < crossings.length; k += 3) {
        if (of >= 0 && crossings[k + 2] !== of) continue;
        const at = crossings[k]!;
        if (at >= h && at < over) { over = at; overFacing = crossings[k + 1]!; }
        if (at < h && at > under) { under = at; underFacing = crossings[k + 1]!; }
      }
      return { h, over, under, inside: over < Infinity && !!overFacing && under > -Infinity && !underFacing };
    };
    return {
      height(point) {
        const { crossings } = cellOf(point);
        let best = -Infinity;
        if (crossings) for (let k = 0; k < crossings.length; k += 3) {
          const h = crossings[k]!;
          if (crossings[k + 1] && crossings[k + 2] && h >= -below && h <= above && (best === -Infinity || Math.abs(h) < Math.abs(best))) best = h;
        }
        return best;
      },
      rise(point) {
        const { h, over, inside } = within(point, 1);
        return inside ? over - h : 0;
      },
      depth(point, of = 'all') {
        const { h, over, under, inside } = within(point, of === 'own' ? 1 : of === 'other' ? 0 : -1);
        return inside ? Math.min(over - h, h - under) : 0;
      },
    };
  }

  /**
   * How far `region`'s skin lies above `onto`'s beneath it, looking straight down (m; negative: sunk into it), the least
   * over where one lies over the other: a hand resting on the abdomen, a forearm across it. Infinity where nothing of
   * `onto` is under `region`.
   */
  gap(region: RegExp, onto: RegExp, cellM = 0.005): number {
    const grid = this.columns(region, onto, cellM, cellM);
    if (!grid) return Infinity;
    let gap = Infinity;
    for (let k = 0; k < grid.top.length; k++) if (grid.top[k]! > -Infinity && grid.under[k]! < Infinity) gap = Math.min(gap, grid.under[k]! - grid.top[k]!);
    return gap;
  }

  /**
   * Soft tissue giving under a part resting on it: `onto`'s skin under `region` is pressed down out of it, by up to
   * `depthM`, and fades over `spreadM` around it, so a hand rests in a shallow dent in the abdomen or a breast rather
   * than through it. Only the top of `onto` moves (skin within 1.5 cm of its highest point in each column).
   */
  indent(region: RegExp, onto: RegExp, depthM: number, spreadM = 0.02, cellM = 0.005): void {
    if (!(depthM > 0)) return;
    const grid = this.columns(region, onto, cellM, spreadM + DENT_MARGIN_M + cellM);
    if (!grid) return;
    const { top, under, cols, rows, cellOf } = grid;
    const push = new Float32Array(top.length);
    for (let k = 0; k < top.length; k++) if (top[k]! > -Infinity && under[k]! < Infinity) push[k] = THREE.MathUtils.clamp(top[k]! - under[k]! + SKIN_CONTACT_CLEARANCE_M, 0, depthM);
    // Full depth a skin triangle (about 2 cm) past the part: a triangle half in the dent would hold its middle up
    // into the part resting there.
    const reach = Math.ceil(DENT_MARGIN_M / cellM), wide = new Float32Array(push.length);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      let deepest = 0;
      for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < cols && jj < rows && di * di + dj * dj <= reach * reach) deepest = Math.max(deepest, push[jj * cols + ii]!);
      }
      wide[j * cols + i] = deepest;
    }
    const dent = spreadDip(wide, new Uint8Array(top.length).fill(1), cols, rows, spreadM / cellM / 2);
    const down = new THREE.Vector3();
    for (const skin of this.skins) for (let i = 0; i < skin.world.length; i++) {
      if (!onto.test(skin.owners[i]!) || region.test(skin.owners[i]!)) continue;
      const p = skin.world[i]!, k = cellOf(p.x, p.z);
      if (k < 0 || !(dent[k]! > 0) || p.y < top[k]! - 0.015) continue;
      this.displace(skin, i, down.set(0, -dent[k]!, 0));
    }
  }

  /** Ground only an engaged support; the caller decides when intentional lift-off releases it. `floor` as for lowest(). */
  support(y: number, polygon: XY[] | undefined, settle: boolean, compressionM = 0, supportBones?: RegExp, openings: XY[][] = [], floor = -Infinity): number {
    const lowest = this.lowest(polygon, supportBones, openings, floor);
    if (!Number.isFinite(lowest) || (!settle && lowest >= y)) return 0;
    const compression = THREE.MathUtils.clamp(compressionM, 0, MAX_SKIN_COMPRESSION_M);
    const delta = y - lowest - compression;
    moveWorld(this.root, new THREE.Vector3(0, delta, 0));
    this.inverses.clear();
    for (const skin of this.skins) for (const p of skin.world) p.y += delta;
    // Flatten the compressed surface onto the support, with no residual overlap.
    if (compression > 0) for (const skin of this.skins) {
      const holes = openings.filter(p => p.length >= 3).map(polygon => ({ polygon, bb: bounds(polygon) }));
      const moves = new Map<number, number>();
      for (const triangle of skin.triangles) {
        if (supportBones && !triangle.every(i => supportBones.test(skin.owners[i]!))) continue;
        const points = triangle.map(i => ({ x: skin.world[i]!.x, y: skin.world[i]!.z, z: skin.world[i]!.y }));
        if (points.every(p => p.z < floor)) continue;
        const overlap = supportedParts(points, polygon, holes).flat();
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
    skin.moved.add(index);
    const local = point.clone().applyMatrix4(matrix);
    skin.geometry.getAttribute('position').setXYZ(index, local.x, local.y, local.z);
  }

  /**
   * Upload the corrected geometry once, after all contacts have been resolved. Only the moved skin and the skin
   * sharing a triangle with it take new normals: recomputed across a whole tile, the vertices split along its texture
   * seams lost the smoothing the model was exported with and shaded as creases (6 to 15° off, and up to 73°).
   */
  finish(): void {
    for (const skin of this.skins) if (skin.changed) {
      const geometry = skin.geometry!;
      geometry.getAttribute('position').needsUpdate = true;
      geometry.computeVertexNormals();
      const normal = geometry.getAttribute('normal'), original = skin.original.getAttribute('normal');
      if (original && normal && original.count === normal.count) {
        const near = new Uint8Array(normal.count);
        for (const triangle of skin.triangles) if (skin.moved.has(triangle[0]) || skin.moved.has(triangle[1]) || skin.moved.has(triangle[2])) for (const i of triangle) near[i] = 1;
        for (let i = 0; i < normal.count; i++) if (!near[i]) normal.setXYZ(i, original.getX(i), original.getY(i), original.getZ(i));
        normal.needsUpdate = true;
      }
      geometry.computeBoundingSphere();
    }
  }

  /** Restore after rendering so loads, recordings, reloads and undo use the original mesh. */
  restore(): void {
    for (const skin of this.skins) { if (skin.changed) skin.mesh.geometry = skin.original; skin.changed = false; skin.moved.clear(); }
    this.inverses.clear();
    this.displaced.clear();
  }

  dispose(): void {
    this.restore();
    for (const skin of this.skins) skin.geometry?.dispose();
  }
}
