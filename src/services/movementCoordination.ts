/**
 * MOVEMENT COORDINATION CHECKS (simMOVE Phase 2) — the "combination with the
 * other joints" half of the critic.
 *
 * A {@link KinematicSignature} (Phase 1) fingerprints each joint on its OWN
 * (direction, amplitude, peak time). What makes a compound movement look
 * NATURAL is how those joints relate: a squat's hip and knee flex in a roughly
 * fixed RATIO; a march swings a leg with the CONTRALATERAL arm (and apart from
 * the ipsilateral one); a sit-to-stand leads with trunk/hip FLEXION momentum
 * before the legs EXTEND to rise. This module scores those cross-joint relations
 * off the same recorded kinematics ({@link exportKinematics}).
 *
 * A {@link CoordinationSpec} is a small, declarative statement of the relations a
 * movement should exhibit; {@link checkCoordination} measures each on a recording
 * and returns per-rule pass/fail. Pure, deterministic, allocation-light — the
 * same lightweight-interpreter contract as the rest of the critic.
 *
 * Grounding: what the current engine actually produces (measured on the rig) —
 * INTER-phase coordination is real (the march's reciprocal arm/leg timing, the
 * sit-to-stand lean-before-rise) because it is authored as distinct keyframes;
 * INTRA-phase timing is still lockstep (every joint in one keyframe peaks at the
 * keyframe boundary), so a within-phase lead like "the ankle dorsiflexes ahead
 * of the knee in a squat descent" is NOT yet realized. These checks measure both
 * so the gap is visible and gated rather than assumed away.
 */

/** The subset of a kinematic export these checks read (structural — decoupled
 *  from motionRecording, like {@link SignatureSourceExport}). */
export interface CoordinationSourceExport {
  timesMs: number[];
  series: Record<string, number[]>;
  angularVelocityDegS: Record<string, number[]>;
  meta?: { durationMs?: number; name?: string };
}

/** A per-joint TIME landmark within a recording (all normalized 0..1):
 *   - 'peak'      — time of the maximum angle;
 *   - 'trough'    — time of the minimum angle;
 *   - 'maxVel'    — time of the max |angular velocity| (fragile on out-and-back
 *                   motions — the return stroke can win; prefer a directional one);
 *   - 'maxPosVel' — time of the most POSITIVE angular velocity (flexion momentum);
 *   - 'maxNegVel' — time of the most NEGATIVE angular velocity (extension momentum).
 * Every landmark returns null when the joint doesn't meaningfully move (so a rule
 * that references a non-moving joint FAILS rather than reading a t≈0 artifact). */
export type TimeMetric = 'peak' | 'trough' | 'maxVel' | 'maxPosVel' | 'maxNegVel';

/** Expected excursion RATIO between two joints: excursion(a) / excursion(b).
 *  AMPLITUDE-ONLY and sign-blind (excursion = max−min) — it establishes relative
 *  magnitude, NOT that the joints move in the right direction or phase. Pair it
 *  with an {@link OrderRule}/{@link TogetherRule} when direction/timing matter. */
export interface RatioRule {
  a: string;
  b: string;
  /** Expected excursion(a)/excursion(b). e.g. squat hip:knee 100:120 → 0.83. */
  ratio: number;
  /** Allowed relative deviation (default 0.25 = ±25%). */
  tolRel?: number;
}

/** `earlier`'s time landmark should come before `later`'s. Each endpoint's
 *  landmark is `earlierAt`/`laterAt` if set, else `by`, else 'peak'. A missing or
 *  non-moving joint fails the rule. Use directional velocity landmarks to express
 *  "flexion momentum before extension": earlier @ 'maxPosVel', later @ 'maxNegVel'. */
export interface OrderRule {
  earlier: string;
  later: string;
  /** Default landmark for BOTH endpoints (default 'peak'). */
  by?: TimeMetric;
  /** Override the `earlier` endpoint's landmark. */
  earlierAt?: TimeMetric;
  /** Override the `later` endpoint's landmark. */
  laterAt?: TimeMetric;
  /** Minimum lead as a fraction of duration for the order to count (default
   *  0.03 — a hair, just to require a real, not tied, ordering). */
  minLeadFrac?: number;
}

/** Two joints that should peak TOGETHER (same phase) — e.g. a marching leg and
 *  the contralateral arm. */
export interface TogetherRule {
  a: string;
  b: string;
  /** Max |Δ normalized peak time| to count as together (default 0.15). */
  tolFrac?: number;
  label?: string;
}

/** Two joints that should peak APART (different phases) — e.g. a marching leg
 *  and the IPSILATERAL arm (which swings on the opposite step). */
export interface ApartRule {
  a: string;
  b: string;
  /** Min |Δ normalized peak time| required (default 0.25). */
  minFrac?: number;
  label?: string;
}

export interface CoordinationSpec {
  name?: string;
  ratios?: RatioRule[];
  order?: OrderRule[];
  together?: TogetherRule[];
  apart?: ApartRule[];
}

export interface CoordinationRuleResult {
  kind: 'ratio' | 'order' | 'together' | 'apart';
  ok: boolean;
  detail: string;
}

export interface CoordinationResult {
  name?: string;
  accepted: boolean;
  results: CoordinationRuleResult[];
  reasons: string[];
}

// ── measurement primitives ───────────────────────────────────────────────────

/** A joint counts as "moving" for angle landmarks when its excursion ≥ this. */
export const MIN_LANDMARK_EXCURSION_DEG = 5;
/** …and for velocity landmarks when its peak |velocity| ≥ this (deg/s). */
export const MIN_LANDMARK_VELOCITY_DEG_S = 5;

function durationOf(ex: CoordinationSourceExport): number {
  const d = ex.meta?.durationMs ?? (ex.timesMs.length ? ex.timesMs[ex.timesMs.length - 1]! : 0);
  return d > 0 ? d : 1;
}

/** Excursion (max − min) of a series, or null when the key is absent. */
export function excursionOf(ex: CoordinationSourceExport, key: string): number | null {
  const v = ex.series[key];
  if (!v || v.length === 0) return null;
  let mn = Infinity;
  let mx = -Infinity;
  for (const x of v) {
    if (x < mn) mn = x;
    if (x > mx) mx = x;
  }
  return mx - mn;
}

/**
 * Normalized time (0..1) of a per-joint {@link TimeMetric} landmark, or `null`
 * when the joint does not meaningfully move (excursion below
 * {@link MIN_LANDMARK_EXCURSION_DEG} for angle landmarks, or peak |velocity|
 * below {@link MIN_LANDMARK_VELOCITY_DEG_S} for velocity landmarks). Returning
 * null for a non-moving joint is what stops a rule from being satisfied by the
 * ABSENCE of the motion it is supposed to check (red-team M#1): a flat series'
 * argmax/argmin lands on the first frame (t≈0), which would trivially satisfy an
 * "earlier before later" order — so we refuse to report a landmark there.
 */
export function timeAt(
  ex: CoordinationSourceExport,
  key: string,
  metric: TimeMetric,
): number | null {
  const dur = durationOf(ex);
  if (metric === 'peak' || metric === 'trough') {
    const v = ex.series[key];
    if (!v || v.length === 0) return null;
    let mn = Infinity;
    let mx = -Infinity;
    let tMax = 0;
    let tMin = 0;
    for (let i = 0; i < v.length; i += 1) {
      if (v[i]! > mx) { mx = v[i]!; tMax = ex.timesMs[i] ?? 0; }
      if (v[i]! < mn) { mn = v[i]!; tMin = ex.timesMs[i] ?? 0; }
    }
    if (mx - mn < MIN_LANDMARK_EXCURSION_DEG) return null; // not really moving
    return (metric === 'peak' ? tMax : tMin) / dur;
  }
  // velocity landmarks
  const w = ex.angularVelocityDegS[key];
  if (!w || w.length === 0) return null;
  let best = -Infinity; // the selected extremum's magnitude
  let t = 0;
  let peakAbs = 0;
  for (let i = 0; i < w.length; i += 1) {
    const vel = w[i]!;
    peakAbs = Math.max(peakAbs, Math.abs(vel));
    const cand = metric === 'maxVel' ? Math.abs(vel) : metric === 'maxPosVel' ? vel : -vel;
    if (cand > best) { best = cand; t = ex.timesMs[i] ?? 0; }
  }
  if (peakAbs < MIN_LANDMARK_VELOCITY_DEG_S) return null; // no real momentum either way
  // For a directional landmark, the selected extremum must actually be in that
  // direction (best > 0), else the joint never moved that way → no landmark.
  if ((metric === 'maxPosVel' || metric === 'maxNegVel') && best <= MIN_LANDMARK_VELOCITY_DEG_S) return null;
  return t / dur;
}

// ── the checker ──────────────────────────────────────────────────────────────

/**
 * Measure each rule in a {@link CoordinationSpec} against a recording's kinematic
 * export and report pass/fail. A missing joint key fails its rule (you cannot
 * confirm a relation you can't measure). Pure + deterministic.
 */
export function checkCoordination(
  ex: CoordinationSourceExport,
  spec: CoordinationSpec,
): CoordinationResult {
  const results: CoordinationRuleResult[] = [];
  const reasons: string[] = [];
  const fail = (kind: CoordinationRuleResult['kind'], detail: string) => {
    results.push({ kind, ok: false, detail });
    reasons.push(detail);
  };
  const pass = (kind: CoordinationRuleResult['kind'], detail: string) =>
    results.push({ kind, ok: true, detail });

  for (const r of spec.ratios ?? []) {
    const ea = excursionOf(ex, r.a);
    const eb = excursionOf(ex, r.b);
    if (ea == null || eb == null || eb === 0) {
      fail('ratio', `ratio ${r.a}:${r.b} — missing/zero excursion (${r.a}=${ea}, ${r.b}=${eb})`);
      continue;
    }
    const got = ea / eb;
    const tol = r.tolRel ?? 0.25;
    const ok = Math.abs(got - r.ratio) <= tol * r.ratio;
    (ok ? pass : fail)('ratio', `ratio ${r.a}:${r.b} expected ${r.ratio.toFixed(2)} ±${(tol * 100).toFixed(0)}%, got ${got.toFixed(2)}`);
  }

  for (const r of spec.order ?? []) {
    const eAt = r.earlierAt ?? r.by ?? 'peak';
    const lAt = r.laterAt ?? r.by ?? 'peak';
    const te = timeAt(ex, r.earlier, eAt);
    const tl = timeAt(ex, r.later, lAt);
    if (te == null || tl == null) {
      // A non-moving joint has no landmark → the ordering can't be confirmed,
      // so it FAILS (a lean-less sit-to-stand can't satisfy "lean before rise").
      fail('order', `order ${r.earlier}@${eAt} < ${r.later}@${lAt} — no landmark (joint absent or not moving)`);
      continue;
    }
    const lead = tl - te;
    const ok = lead >= (r.minLeadFrac ?? 0.03);
    (ok ? pass : fail)('order', `order ${r.earlier}@${eAt} before ${r.later}@${lAt}: ${(te * 100).toFixed(0)}% → ${(tl * 100).toFixed(0)}% (lead ${(lead * 100).toFixed(0)}%)`);
  }

  for (const r of spec.together ?? []) {
    const ta = timeAt(ex, r.a, 'peak');
    const tb = timeAt(ex, r.b, 'peak');
    if (ta == null || tb == null) {
      fail('together', `together ${r.label ?? `${r.a}/${r.b}`} — no landmark (joint absent or not moving)`);
      continue;
    }
    const d = Math.abs(ta - tb);
    const ok = d <= (r.tolFrac ?? 0.15);
    (ok ? pass : fail)('together', `together ${r.label ?? `${r.a}/${r.b}`}: peaks ${(ta * 100).toFixed(0)}% vs ${(tb * 100).toFixed(0)}% (Δ${(d * 100).toFixed(0)}%)`);
  }

  for (const r of spec.apart ?? []) {
    const ta = timeAt(ex, r.a, 'peak');
    const tb = timeAt(ex, r.b, 'peak');
    if (ta == null || tb == null) {
      fail('apart', `apart ${r.label ?? `${r.a}/${r.b}`} — no landmark (joint absent or not moving)`);
      continue;
    }
    const d = Math.abs(ta - tb);
    const ok = d >= (r.minFrac ?? 0.25);
    (ok ? pass : fail)('apart', `apart ${r.label ?? `${r.a}/${r.b}`}: peaks ${(ta * 100).toFixed(0)}% vs ${(tb * 100).toFixed(0)}% (Δ${(d * 100).toFixed(0)}%)`);
  }

  // VACUITY GUARD (red-team M#3): a spec with no rules (or all-empty rule lists)
  // has nothing to confirm — `[].every` would report accepted:true, a false
  // "coordination verified". Refuse instead.
  if (results.length === 0) {
    return {
      ...(spec.name ? { name: spec.name } : {}),
      accepted: false,
      results,
      reasons: ['no coordination rules to check (vacuous spec)'],
    };
  }

  return {
    ...(spec.name ? { name: spec.name } : {}),
    accepted: results.every((r) => r.ok),
    results,
    reasons,
  };
}
