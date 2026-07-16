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

/** Expected excursion RATIO between two joints: excursion(a) / excursion(b). */
export interface RatioRule {
  a: string;
  b: string;
  /** Expected excursion(a)/excursion(b). e.g. squat hip:knee 100:120 → 0.83. */
  ratio: number;
  /** Allowed relative deviation (default 0.25 = ±25%). */
  tolRel?: number;
}

/** `earlier` should reach its peak (or max |velocity|) before `later`. */
export interface OrderRule {
  earlier: string;
  later: string;
  /** Compare peak ANGLE times ('peak', default) or max |angular velocity|
   *  times ('maxVel') — the latter expresses "momentum before …". */
  by?: 'peak' | 'maxVel';
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

/** Normalized time (0..1) of the peak (max) angle, or null when the key is absent. */
export function normPeakTimeOf(ex: CoordinationSourceExport, key: string): number | null {
  const v = ex.series[key];
  if (!v || v.length === 0) return null;
  let mx = -Infinity;
  let t = 0;
  for (let i = 0; i < v.length; i += 1) {
    if (v[i]! > mx) {
      mx = v[i]!;
      t = ex.timesMs[i] ?? 0;
    }
  }
  return t / durationOf(ex);
}

/** Normalized time (0..1) of the max |angular velocity|, or null when absent. */
export function normMaxVelTimeOf(ex: CoordinationSourceExport, key: string): number | null {
  const v = ex.angularVelocityDegS[key];
  if (!v || v.length === 0) return null;
  let mx = -Infinity;
  let t = 0;
  for (let i = 0; i < v.length; i += 1) {
    const a = Math.abs(v[i]!);
    if (a > mx) {
      mx = a;
      t = ex.timesMs[i] ?? 0;
    }
  }
  return t / durationOf(ex);
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
    const by = r.by ?? 'peak';
    const tOf = by === 'maxVel' ? normMaxVelTimeOf : normPeakTimeOf;
    const te = tOf(ex, r.earlier);
    const tl = tOf(ex, r.later);
    if (te == null || tl == null) {
      fail('order', `order ${r.earlier} < ${r.later} (${by}) — missing key`);
      continue;
    }
    const lead = tl - te;
    const ok = lead >= (r.minLeadFrac ?? 0.03);
    (ok ? pass : fail)('order', `order ${r.earlier} before ${r.later} (${by}): ${(te * 100).toFixed(0)}% → ${(tl * 100).toFixed(0)}% (lead ${(lead * 100).toFixed(0)}%)`);
  }

  for (const r of spec.together ?? []) {
    const ta = normPeakTimeOf(ex, r.a);
    const tb = normPeakTimeOf(ex, r.b);
    if (ta == null || tb == null) {
      fail('together', `together ${r.label ?? `${r.a}/${r.b}`} — missing key`);
      continue;
    }
    const d = Math.abs(ta - tb);
    const ok = d <= (r.tolFrac ?? 0.15);
    (ok ? pass : fail)('together', `together ${r.label ?? `${r.a}/${r.b}`}: peaks ${(ta * 100).toFixed(0)}% vs ${(tb * 100).toFixed(0)}% (Δ${(d * 100).toFixed(0)}%)`);
  }

  for (const r of spec.apart ?? []) {
    const ta = normPeakTimeOf(ex, r.a);
    const tb = normPeakTimeOf(ex, r.b);
    if (ta == null || tb == null) {
      fail('apart', `apart ${r.label ?? `${r.a}/${r.b}`} — missing key`);
      continue;
    }
    const d = Math.abs(ta - tb);
    const ok = d >= (r.minFrac ?? 0.25);
    (ok ? pass : fail)('apart', `apart ${r.label ?? `${r.a}/${r.b}`}: peaks ${(ta * 100).toFixed(0)}% vs ${(tb * 100).toFixed(0)}% (Δ${(d * 100).toFixed(0)}%)`);
  }

  return {
    ...(spec.name ? { name: spec.name } : {}),
    accepted: results.every((r) => r.ok),
    results,
    reasons,
  };
}
