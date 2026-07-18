/**
 * WHOLE-BODY CENTER OF MASS + BALANCE (gravity's grip on movement).
 *
 * The composed system posed and measured JOINTS accurately, but knew nothing about
 * the body's mass: whether a movement keeps the centre of mass (COM) balanced over
 * the feet, or is about to topple. This is the measurable foundation for that — the
 * whole-body COM, the base of support (BoS) under the feet, and the margin of
 * stability (how far the COM's ground projection sits inside the BoS). The
 * closed-chain foot-rooted planting (services/rootMotion) that keeps quasi-static
 * movements balanced is graded against these measurements.
 *
 * The COM is the mass-weighted sum of each body segment's COM, using standard
 * anthropometric segment parameters [Winter, *Biomechanics and Motor Control of
 * Human Movement*, 4th ed., Table 4.1]: each segment's mass as a fraction of total
 * body mass, and its COM as a fraction of the proximal→distal segment length. The
 * segment endpoints are the rig's joint world positions, so the COM tracks the
 * live pose. Mass fractions are dimensionless, so no subject mass is needed — the
 * COM is a position, not a force.
 *
 * Pure THREE on a live skeleton — no Svelte/DOM.
 */
import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import { buildBoneByPoseKey } from './poseRig';

/** One body segment: the two joints that bound it, its share of body mass, and
 *  where its COM sits along it (fraction of length from the PROXIMAL joint). */
interface SegmentParam {
  proximal: string;
  distal: string;
  /** Fraction of TOTAL body mass. A per-side limb segment carries this each. */
  mass: number;
  /** COM location as a fraction of the proximal→distal length (0 = proximal). */
  com: number;
}

/**
 * Winter Table 4.1 segment parameters, mapped to the rig's canonical bones. The
 * axial chain (pelvis → lumbar → thorax → head/neck) is split across the spine
 * bones; each limb segment is listed once and prefixed L_/R_ at build. Total mass
 * fractions sum to ~1.0 (pelvis .142 + abdomen .139 + thorax .216 + head/neck .081
 * + 2×(upperarm .028 + forearm .016 + hand .006 + thigh .100 + shank .0465 + foot
 * .0145) = 1.000).
 */
const AXIAL_SEGMENTS: SegmentParam[] = [
  { proximal: 'Hips', distal: 'Spine_Lower', mass: 0.142, com: 0.5 }, // pelvis
  { proximal: 'Spine_Lower', distal: 'Spine_Upper', mass: 0.139, com: 0.5 }, // lumbar / abdomen
  { proximal: 'Spine_Upper', distal: 'Neck', mass: 0.216, com: 0.5 }, // thorax
  // Head+neck: proximal at the neck base, COM up near the head bone (skull).
  { proximal: 'Neck', distal: 'Head', mass: 0.081, com: 1.0 },
];

const LIMB_SEGMENTS = (s: 'L_' | 'R_'): SegmentParam[] => [
  { proximal: `${s}UpperArm`, distal: `${s}Forearm`, mass: 0.028, com: 0.436 },
  { proximal: `${s}Forearm`, distal: `${s}Hand`, mass: 0.016, com: 0.43 },
  { proximal: `${s}Hand`, distal: `${s}Hand`, mass: 0.006, com: 0.5 }, // hand ≈ at the wrist bone
  { proximal: `${s}UpLeg`, distal: `${s}Leg`, mass: 0.1, com: 0.433 }, // thigh
  { proximal: `${s}Leg`, distal: `${s}Foot`, mass: 0.0465, com: 0.433 }, // shank
  { proximal: `${s}Foot`, distal: `${s}Toes`, mass: 0.0145, com: 0.5 }, // foot
];

const SEGMENTS: SegmentParam[] = [
  ...AXIAL_SEGMENTS,
  ...LIMB_SEGMENTS('L_'),
  ...LIMB_SEGMENTS('R_'),
];

export interface BodyCoM {
  /** World-space centre of mass, meters [x, y, z]. */
  world: [number, number, number];
  /** Sum of the mass fractions actually located (≈1.0 when every bone resolved;
   *  less if some are missing — the COM is still their mass-weighted average). */
  massCovered: number;
}

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * Whole-body COM from a prebuilt canonical-key → bone map (the low-level form the
 * sampler uses so it doesn't rebuild the map every frame). Caller must have
 * updated world matrices. A missing segment is skipped and its mass excluded from
 * the normalisation, so the result stays a true mass-weighted mean of the
 * segments present.
 */
export function computeBodyCoMFromBones(bones: Map<string, THREE.Bone>): BodyCoM {
  let mx = 0;
  let my = 0;
  let mz = 0;
  let mtot = 0;
  for (const seg of SEGMENTS) {
    const pb = bones.get(seg.proximal);
    const db = bones.get(seg.distal);
    if (!pb || !db) continue;
    pb.getWorldPosition(_p);
    db.getWorldPosition(_d);
    mx += (_p.x + (_d.x - _p.x) * seg.com) * seg.mass;
    my += (_p.y + (_d.y - _p.y) * seg.com) * seg.mass;
    mz += (_p.z + (_d.z - _p.z) * seg.com) * seg.mass;
    mtot += seg.mass;
  }
  return {
    world: mtot > 0 ? [mx / mtot, my / mtot, mz / mtot] : [0, 0, 0],
    massCovered: mtot,
  };
}

/**
 * Whole-body COM at the current pose. Caller must have updated world matrices
 * (the sampler/stage do). Convenience wrapper over
 * {@link computeBodyCoMFromBones} that resolves the bone map for you.
 */
export function computeBodyCoM(skeleton: THREE.Skeleton, variantCfg: BodyVariantConfig): BodyCoM {
  return computeBodyCoMFromBones(buildBoneByPoseKey(skeleton, variantCfg));
}

// ─────────────────────────────────────────────────────────────────────────────
// BASE OF SUPPORT + MARGIN OF STABILITY (does gravity keep the body up?)
//
// The COM tells you where the body's mass is; balance is whether that mass's
// GROUND PROJECTION falls within the BASE OF SUPPORT — the footprint the planted
// feet press into the floor. For static/quasi-static posture, the body stays up
// iff the COM projects inside the base; the signed distance from the projection
// to the base boundary is the MARGIN OF STABILITY (+ inside / stable, − outside /
// toppling). This is the physics the movement system was blind to: a deep
// forward hinge drives the COM out over the toes (margin → 0 and past), and a
// real body must keep the pelvis over planted feet to hold it in — exactly what
// closed-chain foot-rooted planting (services/rootMotion) produces.
//
// The rig carries an ankle (Foot) and a toe-base (Toes) bone per foot but no
// heel/sole edges, so each foot's sole is reconstructed as a rectangle around
// those two points using adult foot geometry. Approximate by construction — good
// to a couple of centimetres, which is the right resolution for a balance margin.
// ─────────────────────────────────────────────────────────────────────────────

/** Foot sole geometry (meters, adult) used to rebuild the footprint rectangle
 *  from the ankle + toe-base bones. */
const FOOT_HALF_WIDTH_M = 0.045; // ~9 cm sole width
const HEEL_BEHIND_M = 0.06; // heel ~6 cm behind the ankle
const TOE_AHEAD_M = 0.03; // toe tip ~3 cm ahead of the toe-base bone
/** A foot whose ANKLE sits within this band of the floor bears weight and
 *  contributes to the base; a higher ankle is a swing/lifted foot. Keyed to the
 *  ankle, not the lowest point: a lifted, knee-flexed leg leaves its toe dangling
 *  near the floor, which the lowest point would misread as still bearing. 5 cm
 *  clears the lifted foot of a single-leg stance (ankle rises ~8 cm) while
 *  tolerating a moderate heel-raise (ankle up, forefoot still planted). */
const CONTACT_BAND_M = 0.05;

/** The foot bones that bound each foot's sole (ankle → forefoot). */
const FEET: { key: string; foot: string; toe: string }[] = [
  { key: 'L_Foot', foot: 'L_Foot', toe: 'L_Toes' },
  { key: 'R_Foot', foot: 'R_Foot', toe: 'R_Toes' },
];

/** One foot's ground contact: ankle + forefoot world XZ, its lowest world-Y (for
 *  contact selection), and whether it is currently bearing weight. */
export interface FootContactXZ {
  key: string;
  /** World [x, z] of the ankle (Foot bone). */
  ankle: [number, number];
  /** World [x, z] of the forefoot (Toes bone; falls back to the ankle). */
  toe: [number, number];
  /** World-Y of the ANKLE — the floor reference AND weight-bearing test. Toes can
   *  rotate below the floor in a deep pose and dangle near it on a lifted leg, so
   *  the ankle (not the lowest point) is the reliable ground/contact signal. */
  ankleY: number;
  contact: boolean;
}

/** The support polygon under the bearing feet. */
export interface BaseOfSupport {
  /** Convex-hull vertices of the footprint on the floor plane, world [x, z],
   *  counter-clockwise. Empty when airborne. */
  polygon: [number, number][];
  /** Area centroid of the polygon — the neutral "over the base" target. */
  center: [number, number];
  /** Floor height (world-Y) the base sits on. */
  floorY: number;
  /** Keys of the feet contributing to the base (e.g. `['R_Foot']` single-leg). */
  contacts: string[];
  /** No foot in contact — the body is unsupported (mid-jump / mid-flight). */
  airborne: boolean;
}

/** Whole-body balance at one instant. */
export interface BalanceState {
  /** World COM [x, y, z]. */
  com: [number, number, number];
  /** COM projected straight down to the floor plane, world [x, z]. */
  comGround: [number, number];
  base: BaseOfSupport;
  /** Signed distance from the COM projection to the base boundary, meters:
   *  + inside (stable), − outside (toppling). `null` when airborne. */
  marginM: number | null;
  /** COM projection lies inside the base (marginM > 0). */
  balanced: boolean;
}

/** The four sole corners (heel L/R, toe L/R) of one foot, world [x, z]. The
 *  forward axis is the ankle→toe direction on the floor; if the foot points
 *  straight down (plantarflexed, ankle over toe) it defaults to body-forward. */
function footprintCorners(ankle: [number, number], toe: [number, number]): [number, number][] {
  let fx = toe[0] - ankle[0];
  let fz = toe[1] - ankle[1];
  const len = Math.hypot(fx, fz);
  if (len < 1e-4) {
    fx = 0;
    fz = 1; // default forward = world +Z (the way the body faces)
  } else {
    fx /= len;
    fz /= len;
  }
  const px = -fz; // left-perpendicular
  const pz = fx;
  const heelX = ankle[0] - fx * HEEL_BEHIND_M;
  const heelZ = ankle[1] - fz * HEEL_BEHIND_M;
  const tipX = toe[0] + fx * TOE_AHEAD_M;
  const tipZ = toe[1] + fz * TOE_AHEAD_M;
  const w = FOOT_HALF_WIDTH_M;
  return [
    [heelX + px * w, heelZ + pz * w],
    [heelX - px * w, heelZ - pz * w],
    [tipX - px * w, tipZ - pz * w],
    [tipX + px * w, tipZ + pz * w],
  ];
}

/** Monotone-chain convex hull of 2D points, returned counter-clockwise. Fewer
 *  than 3 unique points pass through as-is (a degenerate base). */
function convexHull(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = pts.length;
  if (n < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Area centroid of a polygon (falls back to the vertex mean when degenerate). */
function polygonCentroid(poly: [number, number][]): [number, number] {
  const n = poly.length;
  if (n === 0) return [0, 0];
  const vmean = (): [number, number] => {
    let sx = 0;
    let sz = 0;
    for (const p of poly) {
      sx += p[0];
      sz += p[1];
    }
    return [sx / n, sz / n];
  };
  if (n < 3) return vmean();
  let a2 = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i += 1) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const c = p[0] * q[1] - q[0] * p[1];
    a2 += c;
    cx += (p[0] + q[0]) * c;
    cz += (p[1] + q[1]) * c;
  }
  if (Math.abs(a2) < 1e-9) return vmean();
  return [cx / (3 * a2), cz / (3 * a2)];
}

/** Distance from a point to a segment in 2D. */
function pointSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const l2 = ex * ex + ez * ez;
  let t = l2 > 0 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * ex), p[1] - (a[1] + t * ez));
}

/** Signed distance from a point to a convex polygon (CCW): + inside, − outside,
 *  magnitude = distance to the nearest boundary edge. This is the margin of
 *  stability when the point is the COM ground projection. */
function signedDistToConvex(p: [number, number], poly: [number, number][]): number {
  const n = poly.length;
  if (n < 3) return -pointSegDist(p, poly[0] ?? [0, 0], poly[n - 1] ?? [0, 0]);
  let inside = true;
  let nearest = Infinity;
  for (let i = 0; i < n; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    // CCW interior is to the LEFT of each directed edge a→b.
    const crossZ = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (crossZ < 0) inside = false;
    nearest = Math.min(nearest, pointSegDist(p, a, b));
  }
  return inside ? nearest : -nearest;
}

/** Signed margin of stability: distance from a COM ground projection to the base
 *  boundary, meters (+ inside / stable, − outside / toppling). `null` when the
 *  base is airborne (no support to measure against). */
export function marginOfStability(
  comGround: [number, number],
  base: BaseOfSupport,
): number | null {
  if (base.airborne || base.polygon.length < 3) return null;
  return signedDistToConvex(comGround, base.polygon);
}

/** Build the base of support from the bearing feet (those flagged `contact`).
 *  Feet's soles are unioned and convex-hulled. Airborne when none bear weight. */
export function baseOfSupport(feet: FootContactXZ[], floorY: number): BaseOfSupport {
  const bearing = feet.filter((f) => f.contact);
  if (bearing.length === 0) {
    return { polygon: [], center: [0, 0], floorY, contacts: [], airborne: true };
  }
  const pts: [number, number][] = [];
  for (const f of bearing) pts.push(...footprintCorners(f.ankle, f.toe));
  const polygon = convexHull(pts);
  return {
    polygon,
    center: polygonCentroid(polygon),
    floorY,
    contacts: bearing.map((f) => f.key),
    airborne: false,
  };
}

/** Read both feet's ankle/toe world XZ + lowest-Y from a bone map. Contact is
 *  left false — the caller flags it once the floor level is known. */
function readFeetFromBones(bones: Map<string, THREE.Bone>): FootContactXZ[] {
  const out: FootContactXZ[] = [];
  for (const { key, foot, toe } of FEET) {
    const fb = bones.get(foot);
    if (!fb) continue;
    fb.getWorldPosition(_p);
    const ankle: [number, number] = [_p.x, _p.z];
    let toeXZ: [number, number] = ankle;
    let toeY = _p.y;
    const tb = bones.get(toe);
    if (tb) {
      tb.getWorldPosition(_d);
      toeXZ = [_d.x, _d.z];
    }
    out.push({ key, ankle, toe: toeXZ, ankleY: _p.y, contact: false });
  }
  return out;
}

/** Flag which feet bear weight, given the floor level (ankle within the band). */
function flagContacts(feet: FootContactXZ[], floorY: number): void {
  for (const f of feet) f.contact = f.ankleY <= floorY + CONTACT_BAND_M;
}

/**
 * Whole-body balance at the current pose: COM, its ground projection, the base of
 * support under the bearing feet, and the signed margin of stability. Caller must
 * have updated world matrices.
 *
 * `floorY` is the ground level the feet stand on. Omit it and the LOWEST foot is
 * taken as the floor (the right default for a standing query — at least one foot
 * always bears weight, never spuriously "airborne"). Pass the known floor (e.g.
 * the sampler's captured floor reference) so a genuinely airborne pose — both
 * feet lifted above the ground in a jump — is detected as unsupported.
 */
export function computeBalanceState(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  opts: { floorY?: number } = {},
): BalanceState {
  const bones = buildBoneByPoseKey(skeleton, variantCfg);
  const com = computeBodyCoMFromBones(bones).world;
  const feet = readFeetFromBones(bones);
  const floorY = opts.floorY ?? feet.reduce((m, f) => Math.min(m, f.ankleY), Infinity);
  flagContacts(feet, Number.isFinite(floorY) ? floorY : 0);
  const base = baseOfSupport(feet, Number.isFinite(floorY) ? floorY : 0);
  const comGround: [number, number] = [com[0], com[2]];
  const marginM = base.airborne ? null : signedDistToConvex(comGround, base.polygon);
  return { com, comGround, base, marginM, balanced: marginM != null && marginM > 0 };
}

// ── Per-frame balance timeline (pure post-pass over a recording) ─────────────

/** Minimal structural view of a recording the balance timeline reads — just the
 *  per-frame world tracks (COM + feet), decoupled from motionRecording. */
export interface BalanceTimelineSource {
  frames: { tMs: number; worldTracks?: Record<string, [number, number, number]> }[];
}

/** Balance at one recorded frame. */
export interface BalanceFrame {
  tMs: number;
  comGround: [number, number];
  /** Base centroid, or null when airborne. */
  baseCenter: [number, number] | null;
  /** Margin of stability, meters (+ inside / − outside); null when airborne. */
  marginM: number | null;
  contacts: string[];
  airborne: boolean;
}

/** Balance across a whole recording — the "did the movement stay balanced?" answer. */
export interface BalanceTimeline {
  frames: BalanceFrame[];
  /** Worst (minimum) margin over the supported frames, m; null if never supported. */
  minMarginM: number | null;
  /** Fraction of frames whose COM projected inside the base (0..1). */
  balancedFraction: number;
  /** Fraction of frames airborne (0..1). */
  airborneFraction: number;
}

/** Ankle tracks — the stable floor reference (see the floor note below). */
const BALANCE_ANKLE_KEYS = ['L_Foot', 'R_Foot'] as const;

/** Read both feet from a frame's world tracks (same shape as {@link readFeetFromBones}). */
function readFeetFromTracks(tracks: Record<string, [number, number, number]>): FootContactXZ[] {
  const out: FootContactXZ[] = [];
  for (const { key, foot, toe } of FEET) {
    const fp = tracks[foot];
    if (!fp) continue;
    const ankle: [number, number] = [fp[0], fp[2]];
    let toeXZ: [number, number] = ankle;
    const tp = tracks[toe];
    if (tp) toeXZ = [tp[0], tp[2]];
    out.push({ key, ankle, toe: toeXZ, ankleY: fp[1], contact: false });
  }
  return out;
}

/**
 * Compute the balance margin over an entire recording from its world tracks
 * (needs `CoM`, `L_Foot`/`R_Foot`, `L_Toes`/`R_Toes` tracked — the sampler tracks
 * all of them). Pure — a post-pass, mirroring measureContactSlide.
 *
 * The floor is the lowest foot point over the whole clip unless `floorY` is
 * given; per frame, a foot bears weight when within {@link CONTACT_BAND_M} of it,
 * so a jump's flight frames (both feet above the floor) read as airborne and a
 * single-leg phase reads a one-foot base.
 */
export function computeBalanceTimeline(
  src: BalanceTimelineSource,
  opts: { floorY?: number } = {},
): BalanceTimeline {
  let floorY = opts.floorY;
  if (floorY == null) {
    // Floor = lowest ANKLE over the clip. Ankles are the stable ground reference;
    // toes can rotate below the floor in a deep hinge/squat, which would drag a
    // whole-clip minimum below the true floor and read planted feet as "lifted".
    let m = Infinity;
    for (const f of src.frames) {
      const t = f.worldTracks;
      if (!t) continue;
      for (const k of BALANCE_ANKLE_KEYS) {
        const p = t[k];
        if (p) m = Math.min(m, p[1]);
      }
    }
    floorY = Number.isFinite(m) ? m : 0;
  }
  const frames: BalanceFrame[] = [];
  let minMargin: number | null = null;
  let balancedCount = 0;
  let airborneCount = 0;
  for (const f of src.frames) {
    const tracks = f.worldTracks ?? {};
    const com = tracks['CoM'];
    const feet = readFeetFromTracks(tracks);
    flagContacts(feet, floorY);
    const base = baseOfSupport(feet, floorY);
    const comGround: [number, number] = com ? [com[0], com[2]] : [0, 0];
    if (base.airborne || !com) {
      if (base.airborne) airborneCount += 1;
      frames.push({
        tMs: f.tMs,
        comGround,
        baseCenter: null,
        marginM: null,
        contacts: base.contacts,
        airborne: base.airborne,
      });
      continue;
    }
    const margin = signedDistToConvex(comGround, base.polygon);
    if (margin > 0) balancedCount += 1;
    if (minMargin == null || margin < minMargin) minMargin = margin;
    frames.push({
      tMs: f.tMs,
      comGround,
      baseCenter: base.center,
      marginM: margin,
      contacts: base.contacts,
      airborne: false,
    });
  }
  const n = Math.max(1, src.frames.length);
  return {
    frames,
    minMarginM: minMargin,
    balancedFraction: balancedCount / n,
    airborneFraction: airborneCount / n,
  };
}
