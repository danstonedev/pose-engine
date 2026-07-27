/**
 * SELF-INTERSECTION (limb clearance) — does the body pass through itself?
 *
 * WHY THIS EXISTS. Reported from the deployed build: the model's fingers and
 * hands moved *through* its legs during swing. Nothing caught it, and nothing
 * could have — every gate in this engine measured ANGLES, and a pose can be
 * perfectly inside every ROM band, perfectly phased, perfectly grounded, and
 * still have the hand occupying the same space as the thigh. Joint-space
 * validity and volumetric validity are different claims, and only the first was
 * ever being made.
 *
 * It also long predated the report. Measured across the travel walk, the true
 * minimum hand↔leg SURFACE distance was **0.27 cm** before the movement-realism
 * work and **0.57 cm** after it — both effectively touching, both wrong, and the
 * work that got blamed had in fact moved it slightly the right way.
 *
 * WHAT THIS MODEL IS. Each limb segment is a CAPSULE: a line between two bones
 * plus a radius. Clearance between two segments is the distance between their
 * centre-lines minus the two radii, so a negative number is interpenetration
 * depth in metres. That is an approximation of a mesh, and deliberately so —
 * a per-vertex check is exact but costs O(V²) per frame and cannot run inside a
 * build-time gate. The capsule model is validated AGAINST the per-vertex ground
 * truth in `limbClearance.test.ts`, which is what makes it trustworthy rather
 * than merely cheap.
 *
 * WHAT IT DOES NOT KNOW IS INTENT. Limbs touching can be exactly right — a
 * sit-to-stand rests its hands on its thighs — or exactly wrong, and nothing in
 * a resolved motion distinguishes them. So this module REPORTS clearance and
 * leaves the verdict to callers who know what the motion is for: the validity
 * gate warns on contact and fails only on burial, while a gait that must never
 * touch asserts that directly in its own test.
 *
 * CHARTER. Pure, deterministic, no THREE, no sampling — the caller hands in
 * world-space bone positions, exactly as {@link ValidityReport} consumers do.
 */

/** A world-space point. */
export type Vec3 = readonly [number, number, number];

/**
 * A limb segment as a capsule: the two canonical bone keys forming its
 * centre-line, plus the radius of flesh around it.
 *
 * RADII ARE RIG-MEASURED, NOT GUESSED. Each is the **p90** distance from the
 * segment's centre-line to the mesh vertices that bone dominantly skins, taken
 * on the bind pose of `painmap3D_male.runtime.glb` (see limbClearance.test.ts,
 * which re-derives them and fails if the rig drifts from these numbers):
 *
 *   segment    p50      p90      p99      max
 *   thigh    0.0901   0.1027   0.1178   0.1248
 *   shank    0.0497   0.0691   0.0851   0.0858
 *   forearm  0.0370   0.0482   0.0504   0.0521
 *   hand     0.0428   0.0734   0.0972   0.0983
 *
 * p90 rather than max on purpose. The tail of that distribution is the few
 * vertices furthest from the bone — a spread thumb, the crest of the glute —
 * and sizing every capsule to its outlier would report constant false collisions
 * between limbs that in life merely pass close. p90 describes the limb; the max
 * describes its worst vertex.
 */
export interface LimbSegment {
  id: string;
  from: string;
  to: string;
  radiusM: number;
}

export const THIGH_RADIUS_M = 0.1027;
export const SHANK_RADIUS_M = 0.0691;
export const FOREARM_RADIUS_M = 0.0482;
export const HAND_RADIUS_M = 0.0734;

export const LIMB_SEGMENTS: readonly LimbSegment[] = [
  { id: 'L_thigh', from: 'L_UpLeg', to: 'L_Leg', radiusM: THIGH_RADIUS_M },
  { id: 'R_thigh', from: 'R_UpLeg', to: 'R_Leg', radiusM: THIGH_RADIUS_M },
  { id: 'L_shank', from: 'L_Leg', to: 'L_Foot', radiusM: SHANK_RADIUS_M },
  { id: 'R_shank', from: 'R_Leg', to: 'R_Foot', radiusM: SHANK_RADIUS_M },
  { id: 'L_forearm', from: 'L_Forearm', to: 'L_Hand', radiusM: FOREARM_RADIUS_M },
  { id: 'R_forearm', from: 'R_Forearm', to: 'R_Hand', radiusM: FOREARM_RADIUS_M },
  // The hand is a capsule from the wrist to the middle knuckle. It is the
  // SHORTEST segment here and the fattest relative to its length, which is why
  // the fingers were what showed through the thigh first.
  { id: 'L_hand', from: 'L_Hand', to: 'L_Mid1', radiusM: HAND_RADIUS_M },
  { id: 'R_hand', from: 'R_Hand', to: 'R_Mid1', radiusM: HAND_RADIUS_M },
] as const;

/**
 * The pairs worth checking, and ONLY those. Self-intersection is not a
 * whole-body N² problem in practice: adjacent segments legitimately touch (a
 * forearm meets its own hand), and the torso is not modelled here at all. These
 * are the arm↔leg pairs a gait can realistically drive together.
 */
export const CLEARANCE_PAIRS: readonly (readonly [string, string])[] = [
  ['L_hand', 'L_thigh'],
  ['R_hand', 'R_thigh'],
  ['L_hand', 'R_thigh'],
  ['R_hand', 'L_thigh'],
  ['L_forearm', 'L_thigh'],
  ['R_forearm', 'R_thigh'],
  ['L_hand', 'L_shank'],
  ['R_hand', 'R_shank'],
] as const;

const sub = (a: Vec3, b: Vec3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const addScaled = (a: Vec3, d: Vec3, t: number): [number, number, number] => [
  a[0] + d[0] * t,
  a[1] + d[1] * t,
  a[2] + d[2] * t,
];
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Shortest distance between two line SEGMENTS (not infinite lines).
 *
 * The clamped-parameter form: solve the unconstrained closest-approach, then
 * clamp both parameters into [0,1] and re-solve the other against the clamp.
 * Degenerate (near-zero-length) segments fall back to point-to-segment, which is
 * why a hand capsule barely longer than its own radius still measures sanely.
 */
export function segmentDistance(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const EPS = 1e-12;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) return dist(p1, p2);
  if (a <= EPS) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  return dist(addScaled(p1, d1, s), addScaled(p2, d2, t));
}

export interface ClearanceFinding {
  /** `"<segA> vs <segB>"`. */
  pair: string;
  /** Centre-line distance minus both radii, metres. NEGATIVE = interpenetrating. */
  clearanceM: number;
  /** Index of the frame where the minimum occurred. */
  frameIndex: number;
  /** Position in the clip, 0..100. */
  framePct: number;
}

export interface ClearanceReport {
  /** Every checked pair, worst-first. */
  findings: ClearanceFinding[];
  /** The single worst clearance across all pairs, metres. */
  worstM: number;
  /** Pairs that could not be measured because a bone was not tracked. */
  untracked: string[];
}

/**
 * Minimum surface clearance per pair across a set of world-space frames.
 *
 * `frames[i]` maps canonical bone key → world position. Bones absent from the
 * tracks make their pair unmeasurable rather than passing silently — a check
 * that quietly reports "fine" because it could not see anything is worse than
 * no check, and that is precisely how the hand-through-thigh defect survived.
 */
export function measureLimbClearance(
  frames: readonly Record<string, Vec3>[],
  opts?: {
    segments?: readonly LimbSegment[];
    pairs?: readonly (readonly [string, string])[];
  },
): ClearanceReport {
  const segments = opts?.segments ?? LIMB_SEGMENTS;
  const pairs = opts?.pairs ?? CLEARANCE_PAIRS;
  const segById = new Map(segments.map((s) => [s.id, s]));
  const findings: ClearanceFinding[] = [];
  const untracked: string[] = [];

  for (const [aId, bId] of pairs) {
    const A = segById.get(aId);
    const B = segById.get(bId);
    if (!A || !B) {
      untracked.push(`${aId} vs ${bId}`);
      continue;
    }
    let best = Infinity;
    let bestIdx = -1;
    let sawAny = false;
    for (let i = 0; i < frames.length; i += 1) {
      const f = frames[i]!;
      const a0 = f[A.from];
      const a1 = f[A.to];
      const b0 = f[B.from];
      const b1 = f[B.to];
      if (!a0 || !a1 || !b0 || !b1) continue;
      sawAny = true;
      const c = segmentDistance(a0, a1, b0, b1) - A.radiusM - B.radiusM;
      if (c < best) {
        best = c;
        bestIdx = i;
      }
    }
    if (!sawAny) {
      untracked.push(`${aId} vs ${bId}`);
      continue;
    }
    findings.push({
      pair: `${aId} vs ${bId}`,
      clearanceM: best,
      frameIndex: bestIdx,
      framePct: frames.length > 1 ? (bestIdx / (frames.length - 1)) * 100 : 0,
    });
  }
  findings.sort((x, y) => x.clearanceM - y.clearanceM);
  return {
    findings,
    worstM: findings.length ? findings[0]!.clearanceM : Infinity,
    untracked,
  };
}
