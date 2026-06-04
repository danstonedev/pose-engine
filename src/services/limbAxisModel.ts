/**
 * Limb-axis model: per-limb proximal→distal polyline built from the live
 * skeleton, with a projection routine that converts a painted texel's
 * world-space position into a scalar `s` (cm along the limb, measured from
 * the proximal anchor). The model is the foundation for the
 * centralization vs peripheralization metric — see
 * docs / plan: `one-potential-gold-mine-curried-giraffe.md`.
 *
 * Design points worth knowing:
 *  - The model MUST share `engineRevision` with the SurfaceMeasurementEngine
 *    whose `texelWorldMap` it projects against. Mismatched revisions mean
 *    the texel world coords reflect a different pose than the polyline.
 *  - Upper-extremity proximal anchor is `Spine_Upper` (not the shoulder
 *    bone), making the metric invariant to shoulder shrug and giving
 *    shoulder-cap paint a defensible s ≈ 0.
 *  - Terminal-bone tips (Hand → handTip, Toes → toeTip) prefer the
 *    farthest skeletal descendant; if absent, extrapolate from the parent
 *    bone direction with documented ratios.
 *  - All distances are reported in centimetres derived from
 *    `metersPerWorldUnit × 100`. Cross-variant comparison should consume
 *    `meanDistalNormalized` (s/L), not raw cm.
 */
import * as THREE from 'three';
import {
  normalizeBoneNameForVariant,
  type BodyVariantConfig,
  type BodyVariantId,
} from '../anatomy/bodyVariants';
import type { BodySide } from '../types';

// ── Public types ──────────────────────────────────────────────────────────

export type LimbId =
  | 'left-upper-extremity'
  | 'right-upper-extremity'
  | 'left-lower-extremity'
  | 'right-lower-extremity'
  | 'axial-spine';

export type LimbSide = 'left' | 'right' | 'midline';

export const ALL_LIMB_IDS: readonly LimbId[] = [
  'left-upper-extremity',
  'right-upper-extremity',
  'left-lower-extremity',
  'right-lower-extremity',
  'axial-spine',
];

export interface LimbAxisVec3 {
  x: number;
  y: number;
  z: number;
}

export interface LimbAxisSegment {
  fromBoneKey: string;
  toBoneKey: string;
  from: LimbAxisVec3;
  to: LimbAxisVec3;
  lengthWorld: number;
  cumAtFromWorld: number;
}

export interface LimbAxis {
  limbId: LimbId;
  side: LimbSide;
  /** Ordered proximal→distal. `points[0]` = proximal anchor. */
  points: LimbAxisVec3[];
  segments: LimbAxisSegment[];
  totalLengthWorld: number;
  totalLengthCm: number;
  /** Canonical bone key → cumulative s (cm) at that joint. */
  jointStations: Record<string, number>;
  /** True if any anchor fallback or terminal-tip extrapolation was used. */
  degradedAnchor: boolean;
}

export interface LimbAxisModel {
  engineRevision: number;
  variantId: BodyVariantId;
  metersPerWorldUnit: number;
  axes: Record<LimbId, LimbAxis | null>;
}

export interface LimbAxisProjection {
  sCm: number;
  perpDistWorld: number;
}

export interface LimbAxisProfile {
  limbId: LimbId;
  side: LimbSide;
  totalLengthCm: number;
  burdenCm2: number;
  outlierBurdenCm2: number;
  meanDistalCm: number;
  meanDistalNormalized: number;
  stdDevDistalCm: number;
  p50DistalCm: number;
  p95DistalCm: number;
  proximalShareCm2: number;
  middleShareCm2: number;
  distalShareCm2: number;
  histogram10: number[];
}

export type LimbAxisProfileMap = Partial<Record<LimbId, LimbAxisProfile>>;

export type LimbAxisAccumulationResult = 'accumulated' | 'outlier' | 'no-axis';

export interface LimbAxisAccumulator {
  accumulate(limbId: LimbId, sCm: number, weightWorld: number): void;
  recordOutlier(limbId: LimbId, weightWorld: number): void;
  /** One-shot project + outlier-classify + accumulate. Cheaper than calling
   *  projectOntoAxis externally because the projection scratch and the
   *  outlier threshold logic stay encapsulated. Returns the classification
   *  so callers can drive diagnostic overlays without re-projecting. */
  classifyAndAccumulate(
    limbId: LimbId,
    wx: number,
    wy: number,
    wz: number,
    weightWorld: number,
  ): LimbAxisAccumulationResult;
  finalize(areaScaleCm2PerWorldUnit: number): LimbAxisProfileMap;
  hasData(): boolean;
}

export type RegionToLimbBucket = 'upper' | 'lower' | 'axial';

// ── Constants ─────────────────────────────────────────────────────────────

/** Hand-tip extrapolation when no finger bones exist on the rig.
 *  handTip = handPos + (handPos − forearmPos) × HAND_PROXY_RATIO.
 *  Calibrated so the projected hand region matches typical adult
 *  forearm-to-fingertip proportions (≈ 0.85 of forearm length). */
export const HAND_PROXY_RATIO = 0.85;

/** Toe-tip extrapolation analogue. Foot+toe extends ~0.4 × foot length
 *  beyond the Toes joint. */
export const TOE_PROXY_RATIO = 0.4;

/** A texel whose perpendicular distance to its assigned limb exceeds
 *  this fraction of the limb's total length is treated as an outlier.
 *  Catches atlas-mapping errors instead of silently corrupting the
 *  headline number. */
export const OUTLIER_PERP_FRACTION = 0.5;

const INTERNAL_HIST_BINS = 100;
const EXPORT_HIST_BINS = 10;

/** Mapping from the 20 region IDs (regions.ts) to which limb they
 *  belong to. shoulder maps to 'upper' (anchored at Spine_Upper so
 *  shoulder-cap paint reads s ≈ 0–5 cm); hip maps to 'lower'. */
export const REGION_TO_LIMB: Record<string, RegionToLimbBucket> = {
  shoulder: 'upper',
  'upper-arm': 'upper',
  elbow: 'upper',
  forearm: 'upper',
  wrist: 'upper',
  'hand-fingers': 'upper',
  hip: 'lower',
  thigh: 'lower',
  knee: 'lower',
  'lower-leg': 'lower',
  ankle: 'lower',
  'foot-toes': 'lower',
  'head-face': 'axial',
  neck: 'axial',
  'upper-chest': 'axial',
  'upper-back-scapular': 'axial',
  abdomen: 'axial',
  'mid-back': 'axial',
  pelvis: 'axial',
  'sacral-gluteal': 'axial',
};

export function resolveLimbIdForRegion(regionKey: string, side: BodySide): LimbId | null {
  const bucket = REGION_TO_LIMB[regionKey];
  if (!bucket) return null;
  if (bucket === 'axial') return 'axial-spine';
  if (side === 'left') return bucket === 'upper' ? 'left-upper-extremity' : 'left-lower-extremity';
  if (side === 'right') {
    return bucket === 'upper' ? 'right-upper-extremity' : 'right-lower-extremity';
  }
  return null;
}

// ── Skeleton plumbing ─────────────────────────────────────────────────────

const _scratch = new THREE.Vector3();
const _scratch2 = new THREE.Vector3();

function readWorldPos(bone: THREE.Bone): LimbAxisVec3 {
  const v = bone.getWorldPosition(_scratch);
  return { x: v.x, y: v.y, z: v.z };
}

function buildLookup(
  skeleton: THREE.Skeleton,
  variant: BodyVariantConfig,
): Map<string, THREE.Bone> {
  const map = new Map<string, THREE.Bone>();
  for (const bone of skeleton.bones) {
    const norm = normalizeBoneNameForVariant(bone.name, variant.boneNameMap);
    if (!norm.canonical) continue;
    const sidePrefix = norm.side === 'Left' ? 'L_' : norm.side === 'Right' ? 'R_' : '';
    map.set(`${sidePrefix}${norm.canonical}`, bone);
  }
  return map;
}

/** Return the skeletal descendant of `start` that is farthest in
 *  world-space distance. Used for hand/toe tip resolution so we pick the
 *  longest finger / toe ray rather than whichever child happens to be
 *  first in the rig's serialization order. */
function farthestSkeletalDescendant(start: THREE.Bone): THREE.Bone | null {
  const origin = start.getWorldPosition(new THREE.Vector3());
  let best: THREE.Bone | null = null;
  let bestDistSq = 0;
  const stack: THREE.Bone[] = [];
  for (const c of start.children) {
    if ((c as THREE.Bone).isBone === true) stack.push(c as THREE.Bone);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    const here = cur.getWorldPosition(_scratch2);
    const dx = here.x - origin.x;
    const dy = here.y - origin.y;
    const dz = here.z - origin.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > bestDistSq) {
      bestDistSq = d;
      best = cur;
    }
    for (const c of cur.children) {
      if ((c as THREE.Bone).isBone === true) stack.push(c as THREE.Bone);
    }
  }
  return best;
}

function extrapolateTip(
  parentPos: LimbAxisVec3,
  terminalPos: LimbAxisVec3,
  ratio: number,
): LimbAxisVec3 {
  return {
    x: terminalPos.x + (terminalPos.x - parentPos.x) * ratio,
    y: terminalPos.y + (terminalPos.y - parentPos.y) * ratio,
    z: terminalPos.z + (terminalPos.z - parentPos.z) * ratio,
  };
}

// ── Polyline construction ─────────────────────────────────────────────────

interface ChainStep {
  key: string;
  pos: LimbAxisVec3;
}

function assembleAxis(
  limbId: LimbId,
  side: LimbSide,
  chain: ChainStep[],
  degraded: boolean,
  metersPerWorldUnit: number,
): LimbAxis | null {
  if (chain.length < 2) return null;
  const points: LimbAxisVec3[] = chain.map((c) => c.pos);
  const segments: LimbAxisSegment[] = [];
  const jointStations: Record<string, number> = {};
  jointStations[chain[0].key] = 0;
  let cum = 0;
  for (let i = 0; i < chain.length - 1; i += 1) {
    const a = chain[i].pos;
    const b = chain[i + 1].pos;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    segments.push({
      fromBoneKey: chain[i].key,
      toBoneKey: chain[i + 1].key,
      from: a,
      to: b,
      lengthWorld: len,
      cumAtFromWorld: cum,
    });
    cum += len;
    jointStations[chain[i + 1].key] = cum;
  }
  if (cum <= 0) return null;
  return {
    limbId,
    side,
    points,
    segments,
    totalLengthWorld: cum,
    totalLengthCm: cum * metersPerWorldUnit * 100,
    jointStations,
    degradedAnchor: degraded,
  };
}

interface UpperAnchorPick {
  key: string;
  pos: LimbAxisVec3;
  degraded: boolean;
}

function pickUpperAnchor(lookup: Map<string, THREE.Bone>): UpperAnchorPick {
  const preferred: { key: string; degraded: boolean }[] = [
    { key: 'Spine_Upper', degraded: false },
    { key: 'Spine_Mid', degraded: true },
    { key: 'Hips', degraded: true },
  ];
  for (const p of preferred) {
    const b = lookup.get(p.key);
    if (b) return { key: p.key, pos: readWorldPos(b), degraded: p.degraded };
  }
  return { key: 'World_Origin', pos: { x: 0, y: 0, z: 0 }, degraded: true };
}

function buildUpperLimb(
  lookup: Map<string, THREE.Bone>,
  side: 'L' | 'R',
  metersPerWorldUnit: number,
): LimbAxis | null {
  const prefix = side === 'L' ? 'L_' : 'R_';
  const limbId: LimbId = side === 'L' ? 'left-upper-extremity' : 'right-upper-extremity';
  const limbSide: LimbSide = side === 'L' ? 'left' : 'right';

  const upperArm = lookup.get(`${prefix}UpperArm`);
  const forearm = lookup.get(`${prefix}Forearm`);
  const hand = lookup.get(`${prefix}Hand`);
  if (!upperArm || !forearm || !hand) return null;

  const anchor = pickUpperAnchor(lookup);
  const shoulder = lookup.get(`${prefix}Shoulder`);

  const chain: ChainStep[] = [{ key: anchor.key, pos: anchor.pos }];
  if (shoulder) chain.push({ key: `${prefix}Shoulder`, pos: readWorldPos(shoulder) });
  const upperArmPos = readWorldPos(upperArm);
  const forearmPos = readWorldPos(forearm);
  const handPos = readWorldPos(hand);
  chain.push({ key: `${prefix}UpperArm`, pos: upperArmPos });
  chain.push({ key: `${prefix}Forearm`, pos: forearmPos });
  chain.push({ key: `${prefix}Hand`, pos: handPos });

  const tipBone = farthestSkeletalDescendant(hand);
  let tipPos: LimbAxisVec3;
  let tipDegraded = false;
  if (tipBone) {
    tipPos = readWorldPos(tipBone);
  } else {
    tipPos = extrapolateTip(forearmPos, handPos, HAND_PROXY_RATIO);
    tipDegraded = true;
  }
  chain.push({ key: `${prefix}HandTip`, pos: tipPos });

  return assembleAxis(limbId, limbSide, chain, anchor.degraded || tipDegraded, metersPerWorldUnit);
}

function buildLowerLimb(
  lookup: Map<string, THREE.Bone>,
  side: 'L' | 'R',
  metersPerWorldUnit: number,
): LimbAxis | null {
  const prefix = side === 'L' ? 'L_' : 'R_';
  const limbId: LimbId = side === 'L' ? 'left-lower-extremity' : 'right-lower-extremity';
  const limbSide: LimbSide = side === 'L' ? 'left' : 'right';

  const upLeg = lookup.get(`${prefix}UpLeg`);
  const leg = lookup.get(`${prefix}Leg`);
  const foot = lookup.get(`${prefix}Foot`);
  if (!upLeg || !leg || !foot) return null;

  const hips = lookup.get('Hips');
  let anchorKey = 'Hips';
  let anchorPos: LimbAxisVec3;
  let degraded = false;
  if (hips) {
    anchorPos = readWorldPos(hips);
  } else {
    anchorPos = { x: 0, y: 0, z: 0 };
    anchorKey = 'World_Origin';
    degraded = true;
  }

  const chain: ChainStep[] = [{ key: anchorKey, pos: anchorPos }];
  chain.push({ key: `${prefix}UpLeg`, pos: readWorldPos(upLeg) });
  chain.push({ key: `${prefix}Leg`, pos: readWorldPos(leg) });
  const footPos = readWorldPos(foot);
  chain.push({ key: `${prefix}Foot`, pos: footPos });

  const toes = lookup.get(`${prefix}Toes`);
  let toesPos: LimbAxisVec3 | null = null;
  if (toes) {
    toesPos = readWorldPos(toes);
    chain.push({ key: `${prefix}Toes`, pos: toesPos });
  }

  const tipBone = toes ? farthestSkeletalDescendant(toes) : null;
  let tipPos: LimbAxisVec3;
  let tipDegraded = false;
  if (tipBone) {
    tipPos = readWorldPos(tipBone);
  } else if (toesPos) {
    tipPos = extrapolateTip(footPos, toesPos, TOE_PROXY_RATIO);
    tipDegraded = true;
  } else {
    // No Toes bone at all → extrapolate from Leg→Foot direction.
    const legPos = readWorldPos(leg);
    tipPos = extrapolateTip(legPos, footPos, TOE_PROXY_RATIO);
    tipDegraded = true;
  }
  chain.push({ key: `${prefix}ToeTip`, pos: tipPos });

  return assembleAxis(limbId, limbSide, chain, degraded || tipDegraded, metersPerWorldUnit);
}

function buildAxialSpine(
  lookup: Map<string, THREE.Bone>,
  metersPerWorldUnit: number,
): LimbAxis | null {
  const order: string[] = ['Hips', 'Spine_Lower', 'Spine_Mid', 'Spine_Upper', 'Neck', 'Head'];
  const chain: ChainStep[] = [];
  let degraded = false;
  for (const key of order) {
    const b = lookup.get(key);
    if (b) chain.push({ key, pos: readWorldPos(b) });
    else degraded = true;
  }
  return assembleAxis('axial-spine', 'midline', chain, degraded, metersPerWorldUnit);
}

export function buildLimbAxisModel(
  skeleton: THREE.Skeleton,
  variant: BodyVariantConfig,
  engineRevision: number,
  metersPerWorldUnit: number,
): LimbAxisModel {
  // Make sure every bone's world matrix is current. Cheap if already up
  // to date; necessary if the caller just mutated bone.position/quaternion
  // without an explicit updateMatrixWorld pass.
  for (const bone of skeleton.bones) bone.updateMatrixWorld(false);
  const lookup = buildLookup(skeleton, variant);
  const axes: Record<LimbId, LimbAxis | null> = {
    'left-upper-extremity': buildUpperLimb(lookup, 'L', metersPerWorldUnit),
    'right-upper-extremity': buildUpperLimb(lookup, 'R', metersPerWorldUnit),
    'left-lower-extremity': buildLowerLimb(lookup, 'L', metersPerWorldUnit),
    'right-lower-extremity': buildLowerLimb(lookup, 'R', metersPerWorldUnit),
    'axial-spine': buildAxialSpine(lookup, metersPerWorldUnit),
  };
  return {
    engineRevision,
    variantId: variant.id,
    metersPerWorldUnit,
    axes,
  };
}

// ── Projection (hot path: allocation-free) ────────────────────────────────

/** Project (wx, wy, wz) onto the limb polyline. Writes into `out` and
 *  returns it. No allocation in the inner loop. `out.sCm` is the cm
 *  position along the limb measured from the proximal anchor;
 *  `out.perpDistWorld` is the perpendicular distance from point to the
 *  foot of projection, in WORLD units (not cm — caller compares this to
 *  axis.totalLengthWorld). */
export function projectOntoAxis(
  wx: number,
  wy: number,
  wz: number,
  axis: LimbAxis,
  metersPerWorldUnit: number,
  out: LimbAxisProjection,
): LimbAxisProjection {
  let bestPerpSq = Infinity;
  let bestS = 0;
  const segs = axis.segments;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const ax = seg.from.x;
    const ay = seg.from.y;
    const az = seg.from.z;
    const vx = seg.to.x - ax;
    const vy = seg.to.y - ay;
    const vz = seg.to.z - az;
    const ux = wx - ax;
    const uy = wy - ay;
    const uz = wz - az;
    const vv = vx * vx + vy * vy + vz * vz;
    if (vv <= 0) continue;
    let t = (ux * vx + uy * vy + uz * vz) / vv;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const fx = ax + t * vx;
    const fy = ay + t * vy;
    const fz = az + t * vz;
    const dx = wx - fx;
    const dy = wy - fy;
    const dz = wz - fz;
    const perpSq = dx * dx + dy * dy + dz * dz;
    if (perpSq < bestPerpSq) {
      bestPerpSq = perpSq;
      bestS = seg.cumAtFromWorld + t * seg.lengthWorld;
    }
  }
  out.sCm = bestS * metersPerWorldUnit * 100;
  out.perpDistWorld = Number.isFinite(bestPerpSq) ? Math.sqrt(bestPerpSq) : 0;
  return out;
}

export function createProjection(): LimbAxisProjection {
  return { sCm: 0, perpDistWorld: 0 };
}

// ── Accumulator ───────────────────────────────────────────────────────────

interface LimbStats {
  sumW: number;
  sumWS: number;
  sumWS2: number;
  outlierW: number;
  histInternal: Float64Array;
  totalLengthCm: number;
  side: LimbSide;
}

export function createLimbAxisAccumulator(model: LimbAxisModel): LimbAxisAccumulator {
  const stats = new Map<LimbId, LimbStats>();
  const scratchProj: LimbAxisProjection = { sCm: 0, perpDistWorld: 0 };

  function ensure(limbId: LimbId): LimbStats | null {
    let s = stats.get(limbId);
    if (s) return s;
    const axis = model.axes[limbId];
    if (!axis || axis.totalLengthCm <= 0) return null;
    s = {
      sumW: 0,
      sumWS: 0,
      sumWS2: 0,
      outlierW: 0,
      histInternal: new Float64Array(INTERNAL_HIST_BINS),
      totalLengthCm: axis.totalLengthCm,
      side: axis.side,
    };
    stats.set(limbId, s);
    return s;
  }

  function accumulateInternal(s: LimbStats, sCm: number, weightWorld: number) {
    s.sumW += weightWorld;
    s.sumWS += weightWorld * sCm;
    s.sumWS2 += weightWorld * sCm * sCm;
    let bin = Math.floor((sCm / s.totalLengthCm) * INTERNAL_HIST_BINS);
    if (bin < 0) bin = 0;
    else if (bin >= INTERNAL_HIST_BINS) bin = INTERNAL_HIST_BINS - 1;
    s.histInternal[bin] += weightWorld;
  }

  return {
    accumulate(limbId, sCm, weightWorld) {
      if (!Number.isFinite(sCm) || !Number.isFinite(weightWorld) || weightWorld <= 0) return;
      const s = ensure(limbId);
      if (!s) return;
      accumulateInternal(s, sCm, weightWorld);
    },
    recordOutlier(limbId, weightWorld) {
      if (!Number.isFinite(weightWorld) || weightWorld <= 0) return;
      const s = ensure(limbId);
      if (!s) return;
      s.outlierW += weightWorld;
    },
    classifyAndAccumulate(limbId, wx, wy, wz, weightWorld) {
      if (!Number.isFinite(weightWorld) || weightWorld <= 0) return 'no-axis';
      const axis = model.axes[limbId];
      if (!axis || axis.totalLengthWorld <= 0) return 'no-axis';
      const s = ensure(limbId);
      if (!s) return 'no-axis';
      projectOntoAxis(wx, wy, wz, axis, model.metersPerWorldUnit, scratchProj);
      if (scratchProj.perpDistWorld > axis.totalLengthWorld * OUTLIER_PERP_FRACTION) {
        s.outlierW += weightWorld;
        return 'outlier';
      }
      accumulateInternal(s, scratchProj.sCm, weightWorld);
      return 'accumulated';
    },
    finalize(areaScaleCm2PerWorldUnit) {
      const out: LimbAxisProfileMap = {};
      for (const limbId of ALL_LIMB_IDS) {
        const s = stats.get(limbId);
        if (!s || s.sumW <= 0) continue;
        const profile = finalizeStats(limbId, s, areaScaleCm2PerWorldUnit);
        if (profile) out[limbId] = profile;
      }
      return out;
    },
    hasData() {
      for (const [, s] of stats) {
        if (s.sumW > 0) return true;
      }
      return false;
    },
  };
}

function finalizeStats(
  limbId: LimbId,
  s: LimbStats,
  areaScale: number,
): LimbAxisProfile | null {
  if (s.sumW <= 0 || s.totalLengthCm <= 0) return null;
  const meanDistalCm = s.sumWS / s.sumW;
  const rawVar = s.sumWS2 / s.sumW - meanDistalCm * meanDistalCm;
  const variance = rawVar > 0 ? rawVar : 0;
  const stdDevDistalCm = Math.sqrt(variance);
  const meanDistalNormalized = meanDistalCm / s.totalLengthCm;
  const { p50DistalCm, p95DistalCm } = burdenPercentilesCm(s);
  const thirds = thirdsAndExportHist(s, areaScale);
  return {
    limbId,
    side: s.side,
    totalLengthCm: s.totalLengthCm,
    burdenCm2: s.sumW * areaScale,
    outlierBurdenCm2: s.outlierW * areaScale,
    meanDistalCm,
    meanDistalNormalized,
    stdDevDistalCm,
    p50DistalCm,
    p95DistalCm,
    proximalShareCm2: thirds.proximal,
    middleShareCm2: thirds.middle,
    distalShareCm2: thirds.distal,
    histogram10: thirds.histogram10,
  };
}

function burdenPercentilesCm(s: LimbStats): { p50DistalCm: number; p95DistalCm: number } {
  if (s.sumW <= 0) return { p50DistalCm: 0, p95DistalCm: 0 };
  const total = s.sumW;
  const target50 = 0.5 * total;
  const target95 = 0.95 * total;
  const binWidthCm = s.totalLengthCm / INTERNAL_HIST_BINS;
  let cum = 0;
  let p50 = 0;
  let p95 = 0;
  let found50 = false;
  let found95 = false;
  for (let i = 0; i < INTERNAL_HIST_BINS; i += 1) {
    const w = s.histInternal[i];
    if (w <= 0) continue;
    const cumNext = cum + w;
    if (!found50 && cumNext >= target50) {
      const frac = (target50 - cum) / w;
      p50 = (i + frac) * binWidthCm;
      found50 = true;
    }
    if (!found95 && cumNext >= target95) {
      const frac = (target95 - cum) / w;
      p95 = (i + frac) * binWidthCm;
      found95 = true;
    }
    cum = cumNext;
    if (found50 && found95) break;
  }
  return { p50DistalCm: p50, p95DistalCm: p95 };
}

function thirdsAndExportHist(
  s: LimbStats,
  areaScale: number,
): {
  proximal: number;
  middle: number;
  distal: number;
  histogram10: number[];
} {
  const binWidthCm = s.totalLengthCm / INTERNAL_HIST_BINS;
  const lengthThird = s.totalLengthCm / 3;
  const exportBinSize = INTERNAL_HIST_BINS / EXPORT_HIST_BINS;
  let proximalW = 0;
  let middleW = 0;
  let distalW = 0;
  const histogram10 = new Array<number>(EXPORT_HIST_BINS).fill(0);
  for (let i = 0; i < INTERNAL_HIST_BINS; i += 1) {
    const w = s.histInternal[i];
    if (w <= 0) continue;
    const binCenterCm = (i + 0.5) * binWidthCm;
    if (binCenterCm < lengthThird) proximalW += w;
    else if (binCenterCm < 2 * lengthThird) middleW += w;
    else distalW += w;
    let exportBin = Math.floor(i / exportBinSize);
    if (exportBin >= EXPORT_HIST_BINS) exportBin = EXPORT_HIST_BINS - 1;
    histogram10[exportBin] += w;
  }
  for (let i = 0; i < EXPORT_HIST_BINS; i += 1) histogram10[i] *= areaScale;
  return {
    proximal: proximalW * areaScale,
    middle: middleW * areaScale,
    distal: distalW * areaScale,
    histogram10,
  };
}
