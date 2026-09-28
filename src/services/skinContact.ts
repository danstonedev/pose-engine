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
  /** How many vertices it has. */
  count: number;
  /**
   * The posed skin in world space, x, y and z for each vertex in turn: flat, because the loops run many times a frame
   * read it far faster from one array of numbers than from a vector object per vertex.
   */
  world: Float64Array;
  triangles: Triangle[];
  /** The same triangles, flat (three vertex indices each), for the loops run many times a frame. */
  tri: Uint32Array;
  owners: string[];
  /** Each vertex's owning bone as an index into `ownerNames`: a bone-name pattern is tested once per bone, not per vertex. */
  ownerIds: Uint16Array;
  ownerNames: string[];
  breathWeights: Float64Array;
  changed: boolean;
  /** Vertices moved this frame, whose normals are recomputed (the rest keep the model's own). */
  moved: Set<number>;
  /** Vertices pressed this frame (1), which a competing prop may not move again (resolve), and whether there are any. */
  pressed: Uint8Array;
  anyPressed: boolean;
  /** Each vertex's tissue stiffness, for the function it was read with. */
  tissue?: { of: (owner: string) => number; stiffness: Float32Array };
  /** Per bone, mesh world x bind inverse x bone world x bone inverse x bind (row-major 3 x 4), refilled by update(). */
  bones: Float64Array;
  /** The posed skin projected onto a prop's axes (resolve), kept to be filled again. */
  projected?: Float64Array;
  /** Where its vertices lie against a query's outline and openings (lowest), kept to be filled again. */
  sides?: Sides;
  /** Where on a grid of columns its vertices are (columns), kept to be filled again. */
  gridI?: Float64Array;
  gridJ?: Float64Array;
  /** Each vertex's triangles, in triangle order (offsets into `incident`), built the first time normals are needed. */
  incident?: { start: Uint32Array; tris: Uint32Array };
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

function bounds(points: XY[]) {
  return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
}

/**
 * A convex outline (counter-clockwise), with each edge p → q kept as the two tests the clip cuts by: from p along
 * e = q − p (`cross(p, q, point)`), and from q back along f = p − q (`cross(q, p, point)`). Eight numbers an edge:
 * p.x, p.y, e.x, e.y, q.x, q.y, f.x, f.y.
 */
interface Outline { edges: Float64Array; bb: ReturnType<typeof bounds>; beyond: Float64Array }
/**
 * How far past an edge (m) a triangle wholly beyond it must lie to be dropped without clipping it: far enough that no
 * rounding in the clip could keep a sliver of it (the clip's errors are some 1e-16 of the coordinates).
 */
const SURELY_BEYOND_M = 1e-9;
function outline(polygon: XY[]): Outline {
  const edges = new Float64Array(polygon.length * 8), beyond = new Float64Array(polygon.length);
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length]!;
    edges.set([p.x, p.y, q.x - p.x, q.y - p.y, q.x, q.y, p.x - q.x, p.y - q.y], i * 8);
    // The cross product the clip tests a point by is the edge's length times the point's distance inside it.
    beyond[i] = -SURELY_BEYOND_M * Math.hypot(q.x - p.x, q.y - p.y);
  });
  return { edges, bb: bounds(polygon), beyond };
}

/**
 * The polygons a clip passes through, x, y, z for each point in turn (x, y across the cut, z the height kept): reused
 * from one triangle to the next, since a frame clips thousands. Slot 0 and 1 take turns clipping to an outline; each
 * opening a piece is cut by takes three more (its remainder, in turns, and the piece cut off).
 */
const scratch: Float64Array[] = [];
function slot(k: number, points: number): Float64Array {
  let buffer = scratch[k];
  if (!buffer || buffer.length < points * 3) scratch[k] = buffer = new Float64Array(Math.max(96, points * 6));
  return buffer;
}
/**
 * Keep what of polygon `input` (its first `count` points) is on or inside the line from (px, py) along (ex, ey),
 * retaining the height where it crosses the line: the points go into `output`, and their number is returned. A convex
 * polygon can gain at most one point; `output` must hold twice `count` (a rounding-thin sliver can cross more often).
 */
function clipEdge(input: Float64Array, count: number, px: number, py: number, ex: number, ey: number, output: Float64Array): number {
  if (!count) return 0;
  let n = 0, qx = input[count * 3 - 3]!, qy = input[count * 3 - 2]!, qz = input[count * 3 - 1]!;
  let d0 = ex * (qy - py) - ey * (qx - px);
  for (let k = 0; k < count * 3; k += 3) {
    const cx = input[k]!, cy = input[k + 1]!, cz = input[k + 2]!, d1 = ex * (cy - py) - ey * (cx - px);
    if ((d0 >= 0) !== (d1 >= 0)) {
      const t = d0 / (d0 - d1);
      output[n] = qx + t * (cx - qx); output[n + 1] = qy + t * (cy - qy); output[n + 2] = qz + t * (cz - qz); n += 3;
    }
    if (d1 >= 0) { output[n] = cx; output[n + 1] = cy; output[n + 2] = cz; n += 3; }
    qx = cx; qy = cy; qz = cz; d0 = d1;
  }
  return n / 3;
}
/** Where clipTriangle leaves the clipped polygon. */
let clipped = slot(0, 3);
/**
 * Clip a triangle (x, y across the cut; z the height kept) to a convex outline, edge by edge, retaining the height at
 * the edge intersections: the polygon is left in `clipped`, and its number of points returned (0: none of it is inside).
 */
function clipTriangle(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, shape: Outline | null): number {
  let from = 0, buffer = slot(0, 3), count = 3;
  buffer[0] = ax; buffer[1] = ay; buffer[2] = az; buffer[3] = bx; buffer[4] = by; buffer[5] = bz; buffer[6] = cx; buffer[7] = cy; buffer[8] = cz;
  const e = shape?.edges;
  if (e) for (let o = 0; o < e.length && count; o += 8) {
    const into = slot(from ^ 1, 2 * count);
    count = clipEdge(buffer, count, e[o]!, e[o + 1]!, e[o + 2]!, e[o + 3]!, into);
    buffer = into; from ^= 1;
  }
  clipped = buffer;
  return count;
}
/**
 * The lowest point of what is kept of a polygon once `holes` from `level` on are cut out of it (Infinity: nothing is),
 * each opening cutting off, edge by edge, the piece outside that edge and going on with the rest. The pieces keep the
 * interpolated height at the rim.
 */
function lowestOutside(input: Float64Array, count: number, holes: Outline[], level: number): number {
  if (!count) return Infinity;
  if (level === holes.length) {
    let low = Infinity;
    for (let k = 2; k < count * 3; k += 3) low = Math.min(low, input[k]!);
    return low;
  }
  const { edges: e, bb } = holes[level]!;
  let left = true, right = true, near = true, far = true;
  for (let k = 0; k < count * 3; k += 3) {
    const x = input[k]!, y = input[k + 1]!;
    left &&= x < bb.minX; right &&= x > bb.maxX; near &&= y < bb.minY; far &&= y > bb.maxY;
  }
  // Wholly beside this opening's bounds: it cuts nothing off.
  if (left || right || near || far) return lowestOutside(input, count, holes, level + 1);
  const base = 2 + level * 3;
  let inside = input, remaining = count, turn = 0, low = Infinity;
  for (let o = 0; o < e.length && remaining; o += 8) {
    // The piece beyond this edge (clipped from q back along f), then what is inside it goes on to the next edge.
    const piece = slot(base + 2, 2 * remaining);
    const pieces = clipEdge(inside, remaining, e[o + 4]!, e[o + 5]!, e[o + 6]!, e[o + 7]!, piece);
    if (pieces) low = Math.min(low, lowestOutside(piece, pieces, holes, level + 1));
    const rest = slot(base + turn, 2 * remaining);
    remaining = clipEdge(inside, remaining, e[o]!, e[o + 1]!, e[o + 2]!, e[o + 3]!, rest);
    inside = rest; turn ^= 1;
  }
  return low;
}
/**
 * The lowest skin a support holds of a triangle (x, y across it; z the height): what of it is within the support's
 * outline, with its openings cut out (Infinity: none of it).
 */
function lowestSupported(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, shape: Outline | null, holes: Outline[]): number {
  const count = clipTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, shape);
  return lowestOutside(clipped, count, holes, 0);
}

const RAISE = 0, LOWER = 1, NEAREST = 2;
/**
 * Draw a skin triangle (vertices a, b, c, placed on a grid of `cols` by `rows` columns by its skin's gridI and gridJ)
 * into the columns: each corner into the column it is in, and each column centre inside it at its height there. A
 * height into `heights` (float32, as a column keeps it): RAISE keeps the most in each column, LOWER the least; NEAREST
 * takes, where `heights` has skin, the least of the height less it into `near.gap`.
 */
function draw(skin: Skin, a: number, b: number, c: number, cols: number, rows: number, heights: Float32Array, mode: number, near?: { gap: number }): void {
  const gi = skin.gridI!, gj = skin.gridJ!, world = skin.world;
  const ia = gi[a]!, ja = gj[a]!, ib = gi[b]!, jb = gj[b]!, ic = gi[c]!, jc = gj[c]!;
  if (Math.max(ia, ib, ic) < 0 || Math.max(ja, jb, jc) < 0 || Math.min(ia, ib, ic) >= cols || Math.min(ja, jb, jc) >= rows) return;
  const ay = world[a * 3 + 1]!, by = world[b * 3 + 1]!, cy = world[c * 3 + 1]!;
  const put = (k: number, y: number) => {
    if (mode === RAISE) { if (y > heights[k]!) heights[k] = y; }
    else if (mode === LOWER) { if (y < heights[k]!) heights[k] = y; }
    else if (heights[k]! > -Infinity) near!.gap = Math.min(near!.gap, Math.fround(y) - heights[k]!);
  };
  const corner = (i: number, j: number, y: number) => {
    const ci = Math.floor(i), cj = Math.floor(j);
    if (ci >= 0 && cj >= 0 && ci < cols && cj < rows) put(cj * cols + ci, y);
  };
  corner(ia, ja, ay); corner(ib, jb, by); corner(ic, jc, cy);
  const det = (ib - ia) * (jc - ja) - (ic - ia) * (jb - ja);
  if (Math.abs(det) < 1e-12) return;
  const i0 = Math.max(0, Math.ceil(Math.min(ia, ib, ic) - 0.5)), i1 = Math.min(cols - 1, Math.floor(Math.max(ia, ib, ic) - 0.5));
  const j0 = Math.max(0, Math.ceil(Math.min(ja, jb, jc) - 0.5)), j1 = Math.min(rows - 1, Math.floor(Math.max(ja, jb, jc) - 0.5));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = i + 0.5 - ia, y = j + 0.5 - ja;
    const wb = (x * (jc - ja) - (ic - ia) * y) / det, wc = ((ib - ia) * y - x * (jb - ja)) / det, wa = 1 - wb - wc;
    if (wa >= -1e-9 && wb >= -1e-9 && wc >= -1e-9) put(j * cols + i, wa * ay + wb * by + wc * cy);
  }
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

const _world = new THREE.Matrix4(), _bone = new THREE.Matrix4(), _vertex = new THREE.Vector3(), _local = new THREE.Vector3();
/**
 * The posed skin in world space, as SkinnedMesh.getVertexPosition and then the mesh's world matrix give it, with each
 * bone's matrices multiplied once for the mesh rather than once for every vertex and weight. `only` poses just those
 * vertices, and `using` names every bone they are weighted to: only those bones' matrices are brought up to date. A
 * mesh with morph targets in play is read through three.js.
 */
function posedWorld(skin: Skin, only?: Uint32Array, using?: Uint16Array): void {
  const mesh = skin.mesh, world = skin.world, geometry = mesh.geometry;
  // The mesh as it is now (a host may have changed it), read straight from its arrays where they hold plain values.
  const position = geometry.getAttribute('position'), joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
  const direct = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, size: number) =>
    !!attribute && !(attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !attribute.normalized && attribute.itemSize === size && attribute.count >= skin.count;
  if ((geometry.morphAttributes.position && mesh.morphTargetInfluences?.some(weight => weight !== 0)) || !direct(position, 3) || !direct(joints, 4) || !direct(weights, 4)) {
    const count = only ? only.length : skin.count;
    for (let n = 0; n < count; n++) {
      const i = only ? only[n]! : n;
      mesh.getVertexPosition(i, _vertex).applyMatrix4(mesh.matrixWorld);
      world[i * 3] = _vertex.x; world[i * 3 + 1] = _vertex.y; world[i * 3 + 2] = _vertex.z;
    }
    return;
  }
  const bones = mesh.skeleton.bones, inverses = mesh.skeleton.boneInverses, m = skin.bones;
  _world.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
  const refresh = using ? using.length : bones.length;
  for (let r = 0; r < refresh; r++) {
    const b = using ? using[r]! : r;
    const e = _bone.multiplyMatrices(bones[b]!.matrixWorld, inverses[b]!).premultiply(_world).multiply(mesh.bindMatrix).elements;
    const o = b * 12;
    m[o] = e[0]!; m[o + 1] = e[4]!; m[o + 2] = e[8]!; m[o + 3] = e[12]!;
    m[o + 4] = e[1]!; m[o + 5] = e[5]!; m[o + 6] = e[9]!; m[o + 7] = e[13]!;
    m[o + 8] = e[2]!; m[o + 9] = e[6]!; m[o + 10] = e[10]!; m[o + 11] = e[14]!;
  }
  // three.js blends a vertex's bone transforms by weight and takes the blend as a point: the bind inverse's and the
  // world's translation count once, whatever the weights sum to (hence 1 - their sum, below).
  const we = _world.elements, tx = we[12]!, ty = we[13]!, tz = we[14]!;
  const bind = position.array, bone = joints!.array, share = weights!.array, count = only ? only.length : skin.count;
  for (let n = 0; n < count; n++) {
    const i = only ? only[n]! : n;
    const px = bind[i * 3]!, py = bind[i * 3 + 1]!, pz = bind[i * 3 + 2]!;
    let x = 0, y = 0, z = 0, sum = 0;
    for (let k = i * 4; k < i * 4 + 4; k++) {
      const w = share[k]!;
      if (w === 0) continue;
      const o = bone[k]! * 12;
      x += w * (m[o]! * px + m[o + 1]! * py + m[o + 2]! * pz + m[o + 3]!);
      y += w * (m[o + 4]! * px + m[o + 5]! * py + m[o + 6]! * pz + m[o + 7]!);
      z += w * (m[o + 8]! * px + m[o + 9]! * py + m[o + 10]! * pz + m[o + 11]!);
      sum += w;
    }
    const rest = 1 - sum;
    world[i * 3] = x + rest * tx; world[i * 3 + 1] = y + rest * ty; world[i * 3 + 2] = z + rest * tz;
  }
}

const WHOLE = 0, NONE = 1, PART = 2;
/**
 * What clipping triangle a, b, c (x, y across the cut) to the convex outline keeps of it: it WHOLE, every corner on or
 * inside every edge (the test clipEdge keeps a corner by); NONE, every corner surely beyond one edge; else PART of it,
 * which only clipping it finds. No outline keeps everything.
 */
function kept(shape: Outline | null, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  if (!shape) return WHOLE;
  const e = shape.edges;
  let whole = true;
  for (let o = 0, k = 0; o < e.length; o += 8, k++) {
    const px = e[o]!, py = e[o + 1]!, ex = e[o + 2]!, ey = e[o + 3]!;
    const da = ex * (ay - py) - ey * (ax - px), db = ex * (by - py) - ey * (bx - px), dc = ex * (cy - py) - ey * (cx - px);
    if (da >= 0 && db >= 0 && dc >= 0) continue;
    whole = false;
    const beyond = shape.beyond[k]!;
    if (da < beyond && db < beyond && dc < beyond) return NONE;
  }
  return whole ? WHOLE : PART;
}
const CLEAR = 0, INSIDE = 1, CUT = 2;
/**
 * What cutting the openings out does to a triangle (a, b, c in world X/Z) already wholly over the support. CLEAR of
 * every opening (outside its bounds, or all three corners strictly outside one of its edges), the pieces it is cut into
 * cover all of it, so its lowest point is a corner's. Strictly INSIDE the one opening it meets (every corner on the
 * inner side of every edge, by the tests clipEdge cuts with, both ways round), it is removed whole. Else it is CUT.
 */
function openingsOf(holes: Outline[], ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  let met = 0;
  for (const { edges: e, bb } of holes) {
    if ((ax < bb.minX && bx < bb.minX && cx < bb.minX) || (ax > bb.maxX && bx > bb.maxX && cx > bb.maxX)
      || (az < bb.minY && bz < bb.minY && cz < bb.minY) || (az > bb.maxY && bz > bb.maxY && cz > bb.maxY)) continue;
    let inside = true, apart = false;
    for (let o = 0; o < e.length && !apart; o += 8) {
      const px = e[o]!, py = e[o + 1]!, ex = e[o + 2]!, ey = e[o + 3]!;
      const da = ex * (az - py) - ey * (ax - px), db = ex * (bz - py) - ey * (bx - px), dc = ex * (cz - py) - ey * (cx - px);
      if (da < 0 && db < 0 && dc < 0) { apart = true; continue; }
      if (!inside) continue;
      const qx = e[o + 4]!, qy = e[o + 5]!, fx = e[o + 6]!, fy = e[o + 7]!;
      if (da < 0 || db < 0 || dc < 0 || fx * (az - qy) - fy * (ax - qx) >= 0 || fx * (bz - qy) - fy * (bx - qx) >= 0 || fx * (cz - qy) - fy * (cx - qx) >= 0) inside = false;
    }
    if (apart) continue;
    if (!inside || ++met > 1) return CUT;
  }
  return met ? INSIDE : CLEAR;
}

/**
 * Where a skin's vertices lie against a query's outline and openings, each vertex worked out once for all the
 * triangles that share it (some six), as kept() and openingsOf() test a triangle's corners, and stamped with the query
 * it was worked out for. Against the outline: `inside` 1 on or inside every edge, and `beyond` the edges it is surely
 * beyond (a bit each). Against opening h (at v * holes + h): `open` bits 0 to 3 the sides of its bounds it is beyond (x
 * under, x over, z under, z over), and bit 4 strictly inside every edge; `apart` the edges it is outside (a bit each).
 * The openings' edges are tested only for a vertex of a triangle within their bounds (`hole` stamps those). Outlines
 * of up to 32 edges.
 */
interface Sides { shape: Uint32Array; inside: Uint8Array; beyond: Uint32Array; hole: Uint32Array; open: Uint8Array; apart: Uint32Array; holes: number }
const MOST_EDGES = 32;
function sidesOf(skin: Skin, holes: number): Sides {
  const sides = skin.sides;
  if (sides && sides.holes >= holes) return sides;
  const n = skin.count, per = Math.max(1, holes);
  return skin.sides = {
    shape: new Uint32Array(n), inside: new Uint8Array(n), beyond: new Uint32Array(n),
    hole: new Uint32Array(n), open: new Uint8Array(n * per), apart: new Uint32Array(n * per), holes: per,
  };
}
function markShape(sides: Sides, world: Float64Array, v: number, stamp: number, shape: Outline | null, holes: Outline[]): void {
  if (sides.shape[v] === stamp) return;
  sides.shape[v] = stamp;
  const x = world[v * 3]!, z = world[v * 3 + 2]!;
  let inside = 1, beyond = 0;
  if (shape) {
    const e = shape.edges;
    for (let o = 0, k = 0; o < e.length; o += 8, k++) {
      const d = e[o + 2]! * (z - e[o + 1]!) - e[o + 3]! * (x - e[o]!);
      if (d < 0) { inside = 0; if (d < shape.beyond[k]!) beyond |= 1 << k; }
    }
  }
  sides.inside[v] = inside; sides.beyond[v] = beyond;
  for (let h = 0; h < holes.length; h++) {
    const bb = holes[h]!.bb;
    sides.open[v * sides.holes + h] = (x < bb.minX ? 1 : 0) | (x > bb.maxX ? 2 : 0) | (z < bb.minY ? 4 : 0) | (z > bb.maxY ? 8 : 0);
  }
}
function markHoles(sides: Sides, world: Float64Array, v: number, stamp: number, holes: Outline[]): void {
  if (sides.hole[v] === stamp) return;
  sides.hole[v] = stamp;
  const x = world[v * 3]!, z = world[v * 3 + 2]!;
  for (let h = 0; h < holes.length; h++) {
    const e = holes[h]!.edges, at = v * sides.holes + h;
    let apart = 0, strict = 16;
    for (let o = 0, k = 0; o < e.length; o += 8, k++) {
      const d = e[o + 2]! * (z - e[o + 1]!) - e[o + 3]! * (x - e[o]!);
      if (d < 0) { apart |= 1 << k; strict = 0; }
      else if (strict && e[o + 6]! * (z - e[o + 5]!) - e[o + 7]! * (x - e[o + 4]!) >= 0) strict = 0;
    }
    sides.apart[at] = apart;
    sides.open[at] = (sides.open[at]! & 15) | strict;
  }
}

/** Each vertex's triangles (offsets into `tri`), in triangle order, each triangle once however many of its corners it is. */
function incidence(skin: Skin): { start: Uint32Array; tris: Uint32Array } {
  const n = skin.count, tri = skin.tri, start = new Uint32Array(n + 1);
  const each = (visit: (vertex: number, t: number) => void) => {
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t]!, b = tri[t + 1]!, c = tri[t + 2]!;
      visit(a, t); if (b !== a) visit(b, t); if (c !== a && c !== b) visit(c, t);
    }
  };
  each(vertex => { start[vertex + 1]!++; });
  for (let v = 0; v < n; v++) start[v + 1]! += start[v]!;
  const fill = start.slice(0, n), tris = new Uint32Array(start[n]!);
  each((vertex, t) => { tris[fill[vertex]!++] = t; });
  return { start, tris };
}

/**
 * New normals for the skin sharing a triangle with moved skin, the rest left as `normal` holds them: each as
 * BufferGeometry.computeVertexNormals gives it (its triangles' face normals summed in triangle order into float32, then
 * normalized), from only the triangles round it.
 */
function localNormals(skin: Skin, position: ArrayLike<number>, normal: { [index: number]: number }): void {
  const incident = skin.incident ??= incidence(skin);
  const { start, tris } = incident, tri = skin.tri, near = new Uint8Array(skin.count);
  for (const v of skin.moved) for (let k = start[v]!; k < start[v + 1]!; k++) { const t = tris[k]!; near[tri[t]!] = 1; near[tri[t + 1]!] = 1; near[tri[t + 2]!] = 1; }
  for (let v = 0; v < near.length; v++) {
    if (!near[v]) continue;
    let x = 0, y = 0, z = 0;
    for (let k = start[v]!; k < start[v + 1]!; k++) {
      const t = tris[k]!, a = tri[t]! * 3, b = tri[t + 1]! * 3, c = tri[t + 2]! * 3;
      const cbx = position[c]! - position[b]!, cby = position[c + 1]! - position[b + 1]!, cbz = position[c + 2]! - position[b + 2]!;
      const abx = position[a]! - position[b]!, aby = position[a + 1]! - position[b + 1]!, abz = position[a + 2]! - position[b + 2]!;
      x = Math.fround(x + (cby * abz - cbz * aby)); y = Math.fround(y + (cbz * abx - cbx * abz)); z = Math.fround(z + (cbx * aby - cby * abx));
    }
    const scale = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    normal[v * 3] = x * scale; normal[v * 3 + 1] = y * scale; normal[v * 3 + 2] = z * scale;
  }
}
const plain = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): attribute is THREE.BufferAttribute =>
  !(attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !attribute.normalized && attribute.array instanceof Float32Array;

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
      const breathWeights = Float64Array.from({ length: count }, (_, i) => {
        let weight = 0;
        for (let k = 0; k < 4; k++) if (/Spine|Breast/u.test(mesh.skeleton.bones[indices.getComponent(i, k)]?.name ?? '')) weight += weights.getComponent(i, k);
        return weight;
      });
      for (let i = 0; i < (index?.count ?? count); i += 3) triangles.push(index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2]);
      const tri = Uint32Array.from(triangles.flat());
      const ownerNames = [...new Set(owners)];
      const ownerIndex = new Map(ownerNames.map((name, i) => [name, i]));
      const ownerIds = Uint16Array.from(owners, owner => ownerIndex.get(owner)!);
      this.skins.push({
        mesh, original: mesh.geometry, geometry: null, count, world: new Float64Array(count * 3), triangles, tri, owners, ownerIds, ownerNames,
        breathWeights, changed: false, moved: new Set(), pressed: new Uint8Array(count), anyPressed: false, bones: new Float64Array(mesh.skeleton.bones.length * 12),
      });
    });
  }

  /**
   * Which of each skin's owning bones `pattern` names (1 or 0 per entry of `ownerNames`), tested once per bone name and
   * kept for the next call with the same pattern (a frame asks for the same few many times).
   */
  private readonly masks = new Map<string, Uint8Array[]>();
  private mask(pattern: RegExp): Uint8Array[] {
    // A global or sticky pattern carries state from one test to the next: tested afresh, from its start, each time.
    const stateful = pattern.global || pattern.sticky;
    const key = `${pattern.flags}/${pattern.source}`;
    let masks = stateful ? undefined : this.masks.get(key);
    if (!masks) {
      masks = this.skins.map(skin => Uint8Array.from(skin.ownerNames, name => { pattern.lastIndex = 0; return pattern.test(name) ? 1 : 0; }));
      if (!stateful) this.masks.set(key, masks);
    }
    return masks;
  }
  /** Each skin's vertices (in order) that `pattern` names. */
  private readonly members = new Map<string, Uint32Array[]>();
  private named(pattern: RegExp): Uint32Array[] {
    const key = `${pattern.flags}/${pattern.source}`;
    let lists = pattern.global || pattern.sticky ? undefined : this.members.get(key);
    if (!lists) {
      const masks = this.mask(pattern);
      lists = this.skins.map((skin, s) => {
        const mask = masks[s]!, ids = skin.ownerIds, out: number[] = [];
        for (let i = 0; i < ids.length; i++) if (mask[ids[i]!]) out.push(i);
        return Uint32Array.from(out);
      });
      if (!(pattern.global || pattern.sticky)) this.members.set(key, lists);
    }
    return lists;
  }
  /** Each skin's triangles (offsets into `tri`, in order) whose three corners are all skin that `pattern` names. */
  private readonly sets = new Map<string, Uint32Array[]>();
  private within(pattern: RegExp): Uint32Array[] {
    const key = `${pattern.flags}/${pattern.source}`;
    let sets = pattern.global || pattern.sticky ? undefined : this.sets.get(key);
    if (!sets) {
      const masks = this.mask(pattern);
      sets = this.skins.map((skin, s) => {
        const mask = masks[s]!, ids = skin.ownerIds, tri = skin.tri, out: number[] = [];
        for (let t = 0; t < tri.length; t += 3) if (mask[ids[tri[t]!]!] && mask[ids[tri[t + 1]!]!] && mask[ids[tri[t + 2]!]!]) out.push(t);
        return Uint32Array.from(out);
      });
      if (!(pattern.global || pattern.sticky)) this.sets.set(key, sets);
    }
    return sets;
  }

  /** Whether the skin has been posed by a whole update yet. */
  private posed = false;
  /** Which query of the skin's lowest point this is (Sides). */
  private stamp = 0;
  /**
   * Each skin's vertices a bone's subtree carries (any weight on it or below it), and every bone those vertices are
   * weighted to (the subtree's, and the bones it shares skin with), found the first time it is named.
   */
  private readonly carries = new Map<THREE.Object3D, { vertices: Uint32Array; bones: Uint16Array }[]>();

  /**
   * Once per rendered frame, after the skeleton and all breathing/sway overlays. `moved` says only it and what hangs from
   * it have turned since the last update, with no skin pressed in between (a solver turning one limb bone at a time): only
   * the skin they carry is posed again, and their matrices brought up to date. Otherwise everything is.
   */
  update(moved?: THREE.Object3D): void {
    if (moved && this.posed && !this.skins.some(skin => skin.changed)) {
      moved.updateMatrixWorld(true);
      this.inverses.clear();
      const carried = this.carried(moved);
      this.skins.forEach((skin, s) => posedWorld(skin, carried[s]!.vertices, carried[s]!.bones));
      return;
    }
    this.restore();
    this.root.updateMatrixWorld(true);
    for (const skin of this.skins) posedWorld(skin);
    this.posed = true;
  }
  private carried(moved: THREE.Object3D): { vertices: Uint32Array; bones: Uint16Array }[] {
    let lists = this.carries.get(moved);
    if (!lists) {
      const below = new Set<THREE.Object3D>();
      moved.traverse(object => { below.add(object); });
      lists = this.skins.map(skin => {
        const bones = skin.mesh.skeleton.bones, carried = Uint8Array.from(bones, bone => below.has(bone) ? 1 : 0), used = new Uint8Array(bones.length);
        const joints = skin.mesh.geometry.getAttribute('skinIndex'), weights = skin.mesh.geometry.getAttribute('skinWeight'), out: number[] = [];
        for (let i = 0; i < skin.count; i++) {
          let carries = false;
          for (let k = 0; k < 4; k++) if (weights.getComponent(i, k) !== 0 && carried[joints.getComponent(i, k)]) carries = true;
          if (!carries) continue;
          out.push(i);
          for (let k = 0; k < 4; k++) if (weights.getComponent(i, k) !== 0) used[joints.getComponent(i, k)] = 1;
        }
        return { vertices: Uint32Array.from(out), bones: Uint16Array.from(bones.flatMap((_, b) => used[b] ? [b] : [])) };
      });
      this.carries.set(moved, lists);
    }
    return lists;
  }

  /** Rib/abdominal excursion without moving the supported skeleton or its head. */
  breathe(base: THREE.Vector3, neck: THREE.Vector3, front: THREE.Vector3, left: THREE.Vector3, excursionM: number, supportY = -Infinity): void {
    if (!(excursionM > 0)) return;
    const up = neck.clone().sub(base), length = up.length();
    if (length < 0.01) return;
    up.divideScalar(length);
    const amount = Math.min(excursionM, 0.012);
    const delta = new THREE.Vector3();
    for (const skin of this.skins) for (let i = 0; i < skin.count; i++) {
      const weight = skin.breathWeights[i]!;
      if (weight < 0.001) continue;
      const world = skin.world, py = world[i * 3 + 1]!, rx = world[i * 3]! - base.x, ry = py - base.y, rz = world[i * 3 + 2]! - base.z;
      const t = (rx * up.x + ry * up.y + rz * up.z) / length;
      if (t <= 0 || t >= 1) continue;
      const envelope = Math.sin(Math.PI * t) * weight * amount;
      delta.copy(front).multiplyScalar(THREE.MathUtils.clamp((rx * front.x + ry * front.y + rz * front.z) / 0.14, -1, 1) * envelope)
        .addScaledVector(left, THREE.MathUtils.clamp((rx * left.x + ry * left.y + rz * left.z) / 0.18, -1, 1) * envelope * 0.4);
      // Loaded tissue stays against the support; expansion goes into free space.
      delta.y = Math.max(delta.y, supportY - py);
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
    if (!polygon && !openings.length) {
      const lists = supportBones ? this.named(supportBones) : null;
      for (let s = 0; s < this.skins.length; s++) {
        const world = this.skins[s]!.world, list = lists?.[s], count = list ? list.length : this.skins[s]!.count;
        for (let n = 0; n < count; n++) { const y = world[(list ? list[n]! : n) * 3 + 1]!; if (y >= floor && y < lowest) lowest = y; }
      }
      return lowest;
    }
    const shape = polygon ? outline(polygon) : null, bb = shape?.bb;
    const holes = openings.filter(p => p.length >= 3).map(outline);
    const sets = supportBones ? this.within(supportBones) : null;
    // Each vertex tested once against the outline and openings, where they have few enough edges to note by the bit.
    const byVertex = [shape, ...holes].every(item => !item || item.edges.length <= MOST_EDGES * 8), stamp = ++this.stamp;
    for (let s = 0; s < this.skins.length; s++) {
      const skin = this.skins[s]!, world = skin.world, tri = skin.tri, set = sets?.[s], count = set ? set.length : tri.length / 3;
      const sides = byVertex ? sidesOf(skin, holes.length) : null, per = sides?.holes ?? 0;
      for (let n = 0; n < count; n++) {
        const t = set ? set[n]! : n * 3, va = tri[t]!, vb = tri[t + 1]!, vc = tri[t + 2]!, a = va * 3, b = vb * 3, c = vc * 3;
        const ay = world[a + 1]!, by = world[b + 1]!, cy = world[c + 1]!;
        if (ay < floor && by < floor && cy < floor) continue;
        // What is kept of a triangle is no lower than its lowest corner (to the last bit of a clip's rounding): one no
        // lower than the lowest skin found so far cannot be lower.
        if (ay >= lowest && by >= lowest && cy >= lowest) continue;
        const ax = world[a]!, az = world[a + 2]!, bx = world[b]!, bz = world[b + 2]!, cx = world[c]!, cz = world[c + 2]!;
        if (bb && ((ax < bb.minX && bx < bb.minX && cx < bb.minX) || (ax > bb.maxX && bx > bb.maxX && cx > bb.maxX)
          || (az < bb.minY && bz < bb.minY && cz < bb.minY) || (az > bb.maxY && bz > bb.maxY && cz > bb.maxY))) continue;
        // Wholly over the support, the clip would keep the triangle as it is, or (wholly in an opening) drop it; wholly
        // off it, drop it.
        let over: number, opening = CLEAR;
        if (sides) {
          markShape(sides, world, va, stamp, shape, holes); markShape(sides, world, vb, stamp, shape, holes); markShape(sides, world, vc, stamp, shape, holes);
          over = sides.beyond[va]! & sides.beyond[vb]! & sides.beyond[vc]! ? NONE : sides.inside[va]! & sides.inside[vb]! & sides.inside[vc]! ? WHOLE : PART;
          if (over === WHOLE) for (let h = 0, met = 0; h < holes.length; h++) {
            const oa = va * per + h, ob = vb * per + h, oc = vc * per + h;
            if (sides.open[oa]! & sides.open[ob]! & sides.open[oc]! & 15) continue;
            markHoles(sides, world, va, stamp, holes); markHoles(sides, world, vb, stamp, holes); markHoles(sides, world, vc, stamp, holes);
            if (sides.apart[oa]! & sides.apart[ob]! & sides.apart[oc]!) continue;
            if (!(sides.open[oa]! & sides.open[ob]! & sides.open[oc]! & 16) || ++met > 1) { opening = CUT; break; }
            opening = INSIDE;
          }
        } else {
          over = kept(shape, ax, az, bx, bz, cx, cz);
          if (over === WHOLE) opening = openingsOf(holes, ax, az, bx, bz, cx, cz);
        }
        if (over === NONE) continue;
        if (over === WHOLE) {
          if (opening === CLEAR) { lowest = Math.min(lowest, ay, by, cy); continue; }
          if (opening === INSIDE) continue;
        }
        lowest = Math.min(lowest, lowestSupported(ax, az, ay, bx, bz, by, cx, cz, cy, shape, holes));
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
    const gridI = (x: number, z: number) => ((x - origin.x) * u.x + (z - origin.y) * u.y) / cell;
    const gridJ = (x: number, z: number) => ((x - origin.x) * v.x + (z - origin.y) * v.y) / cell;
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
      const stiffness = skin.tissue.stiffness, tri = skin.tri, world = skin.world;
      for (let t = 0; t < tri.length; t += 3) {
        const a = tri[t]!, b = tri[t + 1]!, c = tri[t + 2]!;
        const ay = world[a * 3 + 1]!, by = world[b * 3 + 1]!, cy = world[c * 3 + 1]!;
        if (Math.min(ay, by, cy) >= reach || Math.max(ay, by, cy) < floor) continue;
        const ax = world[a * 3]!, az = world[a * 3 + 2]!, bx = world[b * 3]!, bz = world[b * 3 + 2]!, cx = world[c * 3]!, cz = world[c * 3 + 2]!;
        const ia = gridI(ax, az), ja = gridJ(ax, az), ib = gridI(bx, bz), jb = gridJ(bx, bz), ic = gridI(cx, cz), jc = gridJ(cx, cz);
        // Each corner marks its own cell (a triangle smaller than a cell may hold no cell's centre)…
        if (ay >= floor) mark(Math.floor(ia), Math.floor(ja), ay, stiffness[a]!);
        if (by >= floor) mark(Math.floor(ib), Math.floor(jb), by, stiffness[b]!);
        if (cy >= floor) mark(Math.floor(ic), Math.floor(jc), cy, stiffness[c]!);
        // …and each cell centre inside it takes its height there.
        const det = (ib - ia) * (jc - ja) - (ic - ia) * (jb - ja);
        if (Math.abs(det) < 1e-12) continue;
        const i0 = Math.max(0, Math.ceil(Math.min(ia, ib, ic) - 0.5)), i1 = Math.min(cols - 1, Math.floor(Math.max(ia, ib, ic) - 0.5));
        const j0 = Math.max(0, Math.ceil(Math.min(ja, jb, jc) - 0.5)), j1 = Math.min(rows - 1, Math.floor(Math.max(ja, jb, jc) - 0.5));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = i + 0.5 - ia, y = j + 0.5 - ja;
          const wb = (x * (jc - ja) - (ic - ia) * y) / det, wc = ((ib - ia) * y - x * (jb - ja)) / det, wa = 1 - wb - wc;
          if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
          const h = wa * ay + wb * by + wc * cy;
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
    for (const skin of this.skins) for (let i = 0; i < skin.count; i++) {
      const world = skin.world, py = world[i * 3 + 1]!;
      if (py >= top || py < floor) continue;
      const px = world[i * 3]!, pz = world[i * 3 + 2]!, ci = Math.floor(gridI(px, pz)), cj = Math.floor(gridJ(px, pz));
      if (ci < 0 || cj < 0 || ci >= cols || cj >= rows || !foam[cj * cols + ci]) continue;
      const y = top - cushionDepth(field, px, pz);
      if (py < y) this.displace(skin, i, lift.set(0, y - py, 0));
    }
    return field;
  }

  /**
   * The grid of columns round `region` (`margin` beyond its skin, in cells of `cell`; m), every vertex of both parts
   * placed on it, and the top of `onto`'s skin over it (its highest point in each column, looking down; world y,
   * -Infinity where it has none), for one part resting on another: a hand on the abdomen, a forearm across it. A
   * triangle is drawn into the columns as draw() draws it (a triangle of both parts is `region`'s).
   */
  private tops(region: RegExp, onto: RegExp, cell: number, margin: number) {
    const regionMasks = this.mask(region), regionMembers = this.named(region), ontoMembers = this.named(onto);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let s = 0; s < this.skins.length; s++) {
      const world = this.skins[s]!.world;
      for (const i of regionMembers[s]!) {
        const x = world[i * 3]!, z = world[i * 3 + 2]!;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    if (!(maxX >= minX)) return null;
    const x0 = minX - margin, z0 = minZ - margin;
    const cols = Math.max(1, Math.ceil((maxX - minX + 2 * margin) / cell)), rows = Math.max(1, Math.ceil((maxZ - minZ + 2 * margin) / cell));
    const top = new Float32Array(cols * rows).fill(-Infinity);
    // Where on the grid each of the parts' vertices is (i across x, j across z, in cells), worked out once for all
    // the triangles that share it.
    for (let s = 0; s < this.skins.length; s++) {
      const skin = this.skins[s]!, world = skin.world, gi = skin.gridI ??= new Float64Array(skin.count), gj = skin.gridJ ??= new Float64Array(skin.count);
      for (const members of [regionMembers[s]!, ontoMembers[s]!]) for (const v of members) { gi[v] = (world[v * 3]! - x0) / cell; gj[v] = (world[v * 3 + 2]! - z0) / cell; }
    }
    const regionSets = this.within(region), ontoSets = this.within(onto);
    for (let s = 0; s < this.skins.length; s++) {
      const skin = this.skins[s]!, tri = skin.tri, ids = skin.ownerIds, mask = regionMasks[s]!;
      for (const t of ontoSets[s]!) {
        if (mask[ids[tri[t]!]!] && mask[ids[tri[t + 1]!]!] && mask[ids[tri[t + 2]!]!]) continue;
        draw(skin, tri[t]!, tri[t + 1]!, tri[t + 2]!, cols, rows, top, RAISE);
      }
    }
    return { top, cols, rows, x0, z0, regionSets };
  }

  /** The tops() grid, and `region`'s underside over it too (its lowest point in each column; Infinity where it has none). */
  private columns(region: RegExp, onto: RegExp, cell: number, margin: number) {
    const grid = this.tops(region, onto, cell, margin);
    if (!grid) return null;
    const { top, cols, rows, x0, z0, regionSets } = grid, under = new Float32Array(cols * rows).fill(Infinity);
    // Only a column both have skin in is read (indent), so the underside is drawn only over `onto`'s columns (a
    // triangle writes only the columns its corners span).
    let i0 = cols, i1 = -1, j0 = rows, j1 = -1;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (top[j * cols + i]! > -Infinity) { i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
    if (i1 >= 0) for (let s = 0; s < this.skins.length; s++) {
      const skin = this.skins[s]!, tri = skin.tri, gi = skin.gridI!, gj = skin.gridJ!;
      for (const t of regionSets[s]!) {
        const a = tri[t]!, b = tri[t + 1]!, c = tri[t + 2]!;
        if (Math.floor(Math.max(gi[a]!, gi[b]!, gi[c]!)) < i0 || Math.floor(Math.min(gi[a]!, gi[b]!, gi[c]!)) > i1
          || Math.floor(Math.max(gj[a]!, gj[b]!, gj[c]!)) < j0 || Math.floor(Math.min(gj[a]!, gj[b]!, gj[c]!)) > j1) continue;
        draw(skin, a, b, c, cols, rows, under, LOWER);
      }
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
    const u = new THREE.Vector3().crossVectors(Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const size = Math.ceil(2 * radiusM / cellM);
    // Each cell's crossings of the skin, as (height, facing, held) triples: facing 1 where the skin faces along the
    // normal, held 1 where it is the skin `own` names.
    const cells: (number[] | undefined)[] = new Array(size * size);
    const held = own ? this.mask(own) : null;
    const d = new THREE.Vector3();
    const local = (p: THREE.Vector3) => { d.subVectors(p, origin); return { i: (d.dot(u) + radiusM) / cellM, j: (d.dot(v) + radiusM) / cellM, h: d.dot(n) }; };
    const cross = (i: number, j: number, h: number, facing: number, mine: number) => {
      if (i < 0 || j < 0 || i >= size || j >= size) return;
      (cells[j * size + i] ??= []).push(h, facing, mine);
    };
    const reach = Math.hypot(radiusM * Math.SQRT2, SKIN_ALONG_REACH_M), within2 = reach * reach;
    for (let s = 0; s < this.skins.length; s++) {
      const skin = this.skins[s]!, world = skin.world, tri = skin.tri, ids = skin.ownerIds, mask = held?.[s];
      for (let t = 0; t < tri.length; t += 3) {
        const ia = tri[t]!, a = ia * 3, b = tri[t + 1]! * 3, c = tri[t + 2]! * 3;
        // Each corner from the origin.
        const ax = world[a]! - origin.x, ay = world[a + 1]! - origin.y, az = world[a + 2]! - origin.z;
        const bx = world[b]! - origin.x, by = world[b + 1]! - origin.y, bz = world[b + 2]! - origin.z;
        const cx = world[c]! - origin.x, cy = world[c + 1]! - origin.y, cz = world[c + 2]! - origin.z;
        if (ax * ax + ay * ay + az * az > within2 && bx * bx + by * by + bz * bz > within2 && cx * cx + cy * cy + cz * cz > within2) continue;
        // The mesh winds its outside counter-clockwise.
        const e1x = world[b]! - world[a]!, e1y = world[b + 1]! - world[a + 1]!, e1z = world[b + 2]! - world[a + 2]!;
        const e2x = world[c]! - world[a]!, e2y = world[c + 1]! - world[a + 1]!, e2z = world[c + 2]! - world[a + 2]!;
        const facing = (e1y * e2z - e1z * e2y) * n.x + (e1z * e2x - e1x * e2z) * n.y + (e1x * e2y - e1y * e2x) * n.z;
        if (Math.abs(facing) < 1e-12) continue;
        const Ai = (ax * u.x + ay * u.y + az * u.z + radiusM) / cellM, Aj = (ax * v.x + ay * v.y + az * v.z + radiusM) / cellM, Ah = ax * n.x + ay * n.y + az * n.z;
        const Bi = (bx * u.x + by * u.y + bz * u.z + radiusM) / cellM, Bj = (bx * v.x + by * v.y + bz * v.z + radiusM) / cellM, Bh = bx * n.x + by * n.y + bz * n.z;
        const Ci = (cx * u.x + cy * u.y + cz * u.z + radiusM) / cellM, Cj = (cx * v.x + cy * v.y + cz * v.z + radiusM) / cellM, Ch = cx * n.x + cy * n.y + cz * n.z;
        const side = facing > 0 ? 1 : 0, mine = mask ? mask[ids[ia]!]! : 1;
        const det = (Bi - Ai) * (Cj - Aj) - (Ci - Ai) * (Bj - Aj);
        const i0 = Math.max(0, Math.ceil(Math.min(Ai, Bi, Ci) - 0.5)), i1 = Math.min(size - 1, Math.floor(Math.max(Ai, Bi, Ci) - 0.5));
        const j0 = Math.max(0, Math.ceil(Math.min(Aj, Bj, Cj) - 0.5)), j1 = Math.min(size - 1, Math.floor(Math.max(Aj, Bj, Cj) - 0.5));
        let covered = false;
        if (Math.abs(det) > 1e-12) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = i + 0.5 - Ai, y = j + 0.5 - Aj;
          const wb = (x * (Cj - Aj) - (Ci - Ai) * y) / det, wc = ((Bi - Ai) * y - x * (Bj - Aj)) / det, wa = 1 - wb - wc;
          if (wa >= -1e-9 && wb >= -1e-9 && wc >= -1e-9) { cross(i, j, wa * Ah + wb * Bh + wc * Ch, side, mine); covered = true; }
        }
        // A triangle smaller than a cell still crosses the one it is in.
        if (!covered) cross(Math.floor((Ai + Bi + Ci) / 3), Math.floor((Aj + Bj + Cj) / 3), (Ah + Bh + Ch) / 3, side, mine);
      }
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
    const grid = this.tops(region, onto, cellM, cellM);
    if (!grid) return Infinity;
    // The least, over the columns both have skin in, of `region`'s underside less `onto`'s top: each triangle of
    // `region` against the top under it, as it would draw into its columns (columns()), and only where it could come
    // nearer than the nearest so far.
    const { top, cols, rows, regionSets } = grid;
    const near = { gap: Infinity };
    for (let s = 0; s < this.skins.length; s++) {
      const skin = this.skins[s]!, tri = skin.tri, gi = skin.gridI!, gj = skin.gridJ!, world = skin.world;
      for (const t of regionSets[s]!) {
        const a = tri[t]!, b = tri[t + 1]!, c = tri[t + 2]!;
        const i0 = Math.max(0, Math.floor(Math.min(gi[a]!, gi[b]!, gi[c]!))), i1 = Math.min(cols - 1, Math.floor(Math.max(gi[a]!, gi[b]!, gi[c]!)));
        const j0 = Math.max(0, Math.floor(Math.min(gj[a]!, gj[b]!, gj[c]!))), j1 = Math.min(rows - 1, Math.floor(Math.max(gj[a]!, gj[b]!, gj[c]!)));
        let highest = -Infinity;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) highest = Math.max(highest, top[j * cols + i]!);
        if (highest === -Infinity) continue;
        // Its heights are no lower than its lowest corner, less the sliver of its edges draw() lets in.
        const ay = world[a * 3 + 1]!, by = world[b * 3 + 1]!, cy = world[c * 3 + 1]!, low = Math.min(ay, by, cy);
        if (Math.fround(low - 2e-9 * (Math.max(ay, by, cy) - low) - 1e-12) - highest >= near.gap) continue;
        draw(skin, a, b, c, cols, rows, top, NEAREST, near);
      }
    }
    return near.gap;
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
    const down = new THREE.Vector3(), ontoMembers = this.named(onto), regionMasks = this.mask(region);
    for (let s = 0; s < this.skins.length; s++) {
      const skin = this.skins[s]!, ids = skin.ownerIds, regionMask = regionMasks[s]!;
      for (const i of ontoMembers[s]!) {
        if (regionMask[ids[i]!]) continue;
        const world = skin.world, k = cellOf(world[i * 3]!, world[i * 3 + 2]!);
        if (k < 0 || !(dent[k]! > 0) || world[i * 3 + 1]! < top[k]! - 0.015) continue;
        this.displace(skin, i, down.set(0, -dent[k]!, 0));
      }
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
    for (const skin of this.skins) for (let k = 1; k < skin.world.length; k += 3) skin.world[k]! += delta;
    // Flatten the compressed surface onto the support, with no residual overlap.
    if (compression > 0) {
      const sets = supportBones ? this.within(supportBones) : null;
      const shape = polygon ? outline(polygon) : null, holes = openings.filter(p => p.length >= 3).map(outline);
      for (let s = 0; s < this.skins.length; s++) {
        const skin = this.skins[s]!, world = skin.world, tri = skin.tri, set = sets?.[s], count = set ? set.length : tri.length / 3;
        const moves = new Map<number, number>();
        for (let n = 0; n < count; n++) {
          const t = set ? set[n]! : n * 3, ia = tri[t]!, ib = tri[t + 1]!, ic = tri[t + 2]!;
          const ay = world[ia * 3 + 1]!, by = world[ib * 3 + 1]!, cy = world[ic * 3 + 1]!;
          if (ay < floor && by < floor && cy < floor) continue;
          const ax = world[ia * 3]!, az = world[ia * 3 + 2]!, bx = world[ib * 3]!, bz = world[ib * 3 + 2]!, cx = world[ic * 3]!, cz = world[ic * 3 + 2]!;
          const over = kept(shape, ax, az, bx, bz, cx, cz);
          if (over === NONE) continue;
          const opening = over === WHOLE ? openingsOf(holes, ax, az, bx, bz, cx, cz) : CUT;
          if (opening === INSIDE) continue;
          const low = opening === CLEAR ? Math.min(ay, by, cy) : lowestSupported(ax, az, ay, bx, bz, by, cx, cz, cy, shape, holes);
          // Cut, and none of it over the support.
          if (low === Infinity) continue;
          const depth = Math.min(compression, Math.max(0, y - low));
          if (depth > 0) for (const i of [ia, ib, ic]) moves.set(i, Math.max(moves.get(i) ?? 0, depth));
        }
        for (const [i, depth] of moves) this.displace(skin, i, new THREE.Vector3(0, depth, 0));
      }
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
    // The posed skin along the three axes, projected once for all the prop's meshes.
    for (const skin of this.skins) {
      const world = skin.world, points = skin.projected ??= new Float64Array(world.length);
      for (let k = 0; k < world.length; k += 3) {
        const px = world[k]!, py = world[k + 1]!, pz = world[k + 2]!;
        points[k] = px * x.x + py * x.y + pz * x.z; points[k + 1] = px * y.x + py * y.y + pz * y.z; points[k + 2] = px * normal.x + py * normal.y + pz * normal.z;
      }
    }
    // Each triangle (an offset into its skin's `tri`) the prop must clear, and by how much.
    const constraints: { skin: Skin; t: number; required: number }[] = [];
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
      const shape = outline(polygon), near = Math.min(...corners.map(p => p.z));
      for (const skin of this.skins) {
        const points = skin.projected!, tri = skin.tri;
        for (let t = 0; t < tri.length; t += 3) {
          const ia = tri[t]! * 3, ib = tri[t + 1]! * 3, ic = tri[t + 2]! * 3;
          const ax = points[ia]!, ay = points[ia + 1]!, az = points[ia + 2]!, bx = points[ib]!, by = points[ib + 1]!, bz = points[ib + 2]!, cx = points[ic]!, cy = points[ic + 1]!, cz = points[ic + 2]!;
          if (Math.max(ax, bx, cx) < bb.minX || Math.min(ax, bx, cx) > bb.maxX || Math.max(ay, by, cy) < bb.minY || Math.min(ay, by, cy) > bb.maxY || Math.max(az, bz, cz) + SKIN_CONTACT_CLEARANCE_M < near) continue;
          if (kept(shape, ax, ay, bx, by, cx, cy) === NONE) continue;
          const overlap = clipTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, shape);
          if (!overlap) continue;
          let highest = -Infinity;
          for (let k = 2; k < overlap * 3; k += 3) highest = Math.max(highest, clipped[k]!);
          const required = highest + SKIN_CONTACT_CLEARANCE_M - near;
          if (required <= 0) continue;
          shift = Math.max(shift, required);
          constraints.push({ skin, t, required });
        }
      }
    });
    // Previously compressed tissue cannot be moved again by a competing prop.
    const fresh = constraints.every(({ skin, t }) => !skin.pressed[skin.tri[t]!] && !skin.pressed[skin.tri[t + 1]!] && !skin.pressed[skin.tri[t + 2]!]);
    const compression = fresh ? Math.min(shift, THREE.MathUtils.clamp(compressionM, 0, MAX_SKIN_COMPRESSION_M)) : 0;
    shift -= compression;
    if (shift > 0) moveWorld(object, normal.clone().multiplyScalar(shift));
    const moves = new Map<Skin, Map<number, number>>();
    if (compression > 0) for (const c of constraints) {
      const depth = Math.max(0, c.required - shift);
      if (!depth) continue;
      let vertices = moves.get(c.skin);
      if (!vertices) { vertices = new Map(); moves.set(c.skin, vertices); }
      for (let k = c.t; k < c.t + 3; k++) { const i = c.skin.tri[k]!; vertices.set(i, Math.max(vertices.get(i) ?? 0, depth)); }
    }
    for (const [skin, vertices] of moves) for (const [i, depth] of vertices) this.displace(skin, i, normal.clone().multiplyScalar(-depth));
    return shift;
  }

  private displace(skin: Skin, index: number, delta: THREE.Vector3, pressure = true): void {
    if (delta.lengthSq() < 1e-18) return;
    if (!skin.geometry) skin.geometry = skin.original.clone();
    if (!skin.changed) {
      const target = skin.geometry.getAttribute('position'), source = skin.original.getAttribute('position');
      if (plain(target) && plain(source) && target.array.length === source.array.length) (target.array as Float32Array).set(source.array as Float32Array);
      else for (let i = 0; i < source.count; i++) target.setXYZ(i, source.getX(i), source.getY(i), source.getZ(i));
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
    const world = skin.world, o = index * 3;
    world[o]! += delta.x; world[o + 1]! += delta.y; world[o + 2]! += delta.z;
    if (pressure) { skin.pressed[index] = 1; skin.anyPressed = true; }
    skin.moved.add(index);
    const local = _local.set(world[o]!, world[o + 1]!, world[o + 2]!).applyMatrix4(matrix);
    skin.geometry.getAttribute('position').setXYZ(index, local.x, local.y, local.z);
  }

  /**
   * Upload the corrected geometry once, after all contacts have been resolved. Only the moved skin and the skin
   * sharing a triangle with it take new normals: recomputed across a whole tile, the vertices split along its texture
   * seams lost the smoothing the model was exported with and shaded as creases (6 to 15° off, and up to 73°).
   */
  finish(): void {
    for (const skin of this.skins) if (skin.changed) {
      const geometry = skin.geometry!, position = geometry.getAttribute('position');
      position.needsUpdate = true;
      const normal = geometry.getAttribute('normal'), original = skin.original.getAttribute('normal');
      // The model's own normals everywhere, and new ones round what moved: computed there alone, not over the whole mesh.
      if (geometry.getIndex() && original && normal && plain(position) && plain(normal) && plain(original) && normal.array.length === original.array.length) {
        (normal.array as Float32Array).set(original.array as Float32Array);
        localNormals(skin, position.array, normal.array);
        normal.needsUpdate = true;
        geometry.computeBoundingSphere();
        continue;
      }
      geometry.computeVertexNormals();
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
    for (const skin of this.skins) {
      if (skin.changed) skin.mesh.geometry = skin.original;
      skin.changed = false;
      skin.moved.clear();
      if (skin.anyPressed) { skin.pressed.fill(0); skin.anyPressed = false; }
    }
    this.inverses.clear();
  }

  dispose(): void {
    this.restore();
    for (const skin of this.skins) skin.geometry?.dispose();
  }
}
