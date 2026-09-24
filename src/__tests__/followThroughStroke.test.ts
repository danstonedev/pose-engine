/**
 * THE FOLLOW-THROUGH STROKE TRAIL, AGAINST ITS PLAIN FORM.
 *
 * services/followThroughStroke solves the c each delayed bone trails the chain
 * by through a flowing stroke, organised for cost: a keyed index finds a stroke
 * already solved, the lockstep chain's share of a segment is worked out once,
 * the path table's nine SQUAD samples share their sines, and a memo keeps the
 * strokes solved in earlier builds. None of that may change a single bit of
 * any c. So each piece is held here against the plain algorithm it stands in
 * for — the one ec3d0eb ran, written out below as the reference: every lookup
 * the answer a scan of every solved stroke gives, and every c the one the
 * unorganised solver gives, cold or from the memo.
 *
 * The motion-level gates (trail, speed caps, continuity) are in
 * followThroughContinuity.test.ts; this file pins that the organised solver IS
 * the reference, so those gates read the same numbers they were set on.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { POSE_SCHEMA_VERSION } from '../types';
import {
  clearFollowThroughStrokeMemo,
  FollowThroughStrokes,
  StrokeIndex,
  STROKE_INPUTS,
  strokeIndexCounters,
} from '../services/followThroughStroke';
import { buildPoseTrajectory, type TrajectoryKnot } from '../services/motionTrajectory';
import { followThroughStrokeLag } from '../services/motionStagger';

type Q = [number, number, number, number];

/** The tolerance two strokes' inputs must agree to, written out here so that
 *  loosening the engine's constant is caught, not followed. */
const SAME_STROKE_REL = 1e-9;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_STROKE_REL * (1 + Math.abs(a));

/** mulberry32: a float LCG step (seed × 1103515245 overflows 2⁵³) falls into a
 *  short cycle within a few thousand draws, which would repeat "new" poses. */
let seed = 20260925;
const rnd = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rot = (deg: number, axis: [number, number, number]): Q => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), (deg * Math.PI) / 180);
  return [q.x, q.y, q.z, q.w];
};
const randQ = (deg: number): Q => rot((rnd() - 0.5) * 2 * deg, [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
const turn = (q: Q, deg: number): Q => {
  const r = new THREE.Quaternion(...q).multiply(new THREE.Quaternion(...rot(deg, [rnd() - 0.5, rnd() - 0.5, 1])));
  return [r.x, r.y, r.z, r.w];
};
const align = (a: Q, b: Q): Q => (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b);

// ── the reference: ec3d0eb's solver, unorganised ─────────────────────────────

function hermite01(s: number, mu0: number, mu1: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (s3 - 2 * s2 + s) * mu0 + (-2 * s3 + 3 * s2) + (s3 - s2) * mu1;
}
function lagRate(s: number, mu0: number, mu1: number, c: number): number {
  const a3 = -4 * c;
  const a2 = 3 * mu0 + 3 * mu1 - 6 + 6 * c;
  const a1 = 6 - 4 * mu0 - 2 * mu1 - 2 * c;
  return ((a3 * s + a2) * s + a1) * s + mu0;
}
function lagRateRange(mu0: number, mu1: number, c: number): [number, number] {
  const a3 = -4 * c;
  const a2 = 3 * mu0 + 3 * mu1 - 6 + 6 * c;
  const a1 = 6 - 4 * mu0 - 2 * mu1 - 2 * c;
  let lo = Math.min(mu0, mu1);
  let hi = Math.max(mu0, mu1);
  const qa = 3 * a3;
  const qb = 2 * a2;
  const roots: number[] = [];
  if (Math.abs(qa) < 1e-12) {
    if (Math.abs(qb) > 1e-12) roots.push(-a1 / qb);
  } else {
    const disc = qb * qb - 4 * qa * a1;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-qb + sq) / (2 * qa), (-qb - sq) / (2 * qa));
    }
  }
  for (const s of roots) {
    if (s <= 0 || s >= 1) continue;
    const r = lagRate(s, mu0, mu1, c);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  return [lo, hi];
}
function squad(q0: Q, q1: Q, s0: Q, s1: Q, t: number): Q {
  const a = new THREE.Quaternion(...q0).slerp(new THREE.Quaternion(...q1), t);
  const c = new THREE.Quaternion(...s0).slerp(new THREE.Quaternion(...s1), t);
  a.slerp(c, 2 * t * (1 - t));
  return [a.x, a.y, a.z, a.w];
}
function qAngle(a: Q, b: Q): number {
  const [ax, ay, az, aw] = [-a[0], -a[1], -a[2], a[3]];
  const [bx, by, bz, bw] = b;
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w));
}
function pathSpeedTable(q0: Q, q1: Q, s0: Q, s1: Q): number[] | null {
  if (qAngle(q0, q1) + qAngle(q0, s0) + qAngle(q1, s1) < 1e-6) return null;
  const n = 8;
  const table: number[] = [];
  let prev = squad(q0, q1, s0, s1, 0);
  for (let j = 1; j <= n; j += 1) {
    const cur = squad(q0, q1, s0, s1, j / n);
    table.push(qAngle(prev, cur) * n);
    prev = cur;
  }
  return table;
}
function pathSpeedAt(path: number[], l: number): number {
  const n = path.length;
  const x = Math.min(1, Math.max(0, l)) * n - 0.5;
  const i = Math.max(0, Math.min(n - 2, Math.floor(x)));
  const t = x - i;
  const p1 = path[i]!;
  const p2 = path[i + 1]!;
  if (x < 0 || x > n - 1) return p1 + (p2 - p1) * t;
  const p0 = i > 0 ? path[i - 1]! : 2 * p1 - p2;
  const p3 = i + 2 < n ? path[i + 2]! : 2 * p2 - p1;
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}
function strokePeakSpeed(path: number[], mu0: number, mu1: number, c: number): number {
  let peak = 0;
  for (let j = 0; j <= 24; j += 1) {
    const s = j / 24;
    const l = hermite01(s, mu0, mu1) - c * s * s * (1 - s) * (1 - s);
    const speed = pathSpeedAt(path, l) * Math.abs(lagRate(s, mu0, mu1, c));
    if (speed > peak) peak = speed;
  }
  return peak;
}
function strokeLagCoefficient(mu0: number, mu1: number, lock0: number, lock1: number, pathSpeed: () => number[] | null, delay: number): number {
  const budget = followThroughStrokeLag(delay);
  const target = 16 * budget.midLag * (1.5 - (mu0 + mu1) / 4);
  if (!(target > 0)) return 0;
  const rateCap = budget.rateCeiling * lagRateRange(lock0, lock1, 0)[1];
  const rateFits = (c: number): boolean => {
    const [lo, hi] = lagRateRange(mu0, mu1, c);
    return lo >= 0 && hi <= rateCap;
  };
  const largest = (fits: (c: number) => boolean, bad: number, steps: number): number => {
    let ok = 0;
    for (let i = 0; i < steps; i += 1) {
      const mid = (ok + bad) / 2;
      if (fits(mid)) ok = mid;
      else bad = mid;
    }
    return ok;
  };
  if (!rateFits(0)) return 0;
  const byRate = rateFits(target) ? target : largest(rateFits, target, 40);
  if (!(byRate > 0)) return 0;
  const path = pathSpeed();
  if (!path) return byRate;
  const speedCap = budget.rateCeiling * strokePeakSpeed(path, lock0, lock1, 0);
  const speedFits = (c: number): boolean => strokePeakSpeed(path, mu0, mu1, c) <= speedCap;
  if (speedFits(byRate)) return byRate;
  if (!speedFits(0)) return 0;
  return largest((c) => rateFits(c) && speedFits(c), byRate, 8);
}
/** ec3d0eb's per-bone loop: scan every solved stroke for one that matches. */
function referenceLags(q: Q[], s: Q[], own: number[], slopes: number[], spans: number[], stops: boolean[], delay: number): number[] {
  const n = q.length;
  const lag = new Array<number>(n - 1).fill(0);
  const found: number[] = [];
  const nearQ = (a: Q, b: Q) => near(a[0], b[0]) && near(a[1], b[1]) && near(a[2], b[2]) && near(a[3], b[3]);
  for (let i = 0; i < n - 1; i += 1) {
    if (stops[i] || stops[i + 1]) continue;
    const h = spans[i]!;
    const same = found.find((j) => {
      const hj = spans[j]!;
      return (
        near(own[i]! * h, own[j]! * hj) &&
        near(own[i + 1]! * h, own[j + 1]! * hj) &&
        near(slopes[i]! * h, slopes[j]! * hj) &&
        near(slopes[i + 1]! * h, slopes[j + 1]! * hj) &&
        nearQ(q[i]!, q[j]!) &&
        nearQ(q[i + 1]!, q[j + 1]!) &&
        nearQ(s[i]!, s[j]!) &&
        nearQ(s[i + 1]!, s[j + 1]!)
      );
    });
    if (same !== undefined) {
      lag[i] = lag[same]!;
      continue;
    }
    lag[i] = strokeLagCoefficient(own[i]! * h, own[i + 1]! * h, slopes[i]! * h, slopes[i + 1]! * h, () => pathSpeedTable(q[i]!, q[i + 1]!, s[i]!, s[i + 1]!), delay);
    found.push(i);
  }
  return lag;
}

// ── random bone series, shaped like the ones a build hands the solver ────────

interface Series {
  q: Q[];
  s: Q[];
  own: number[];
  slopes: number[];
  spans: number[];
  stops: boolean[];
  delay: number;
}

/** A bone's knots: moving, holding still, or repeating a cycle whose knots are
 *  re-timed by rounding-level amounts (some inside the match tolerance, some
 *  just outside it). */
function randomSeries(kind: 'moving' | 'still' | 'cycle' | 'small'): Series {
  const n = kind === 'cycle' ? 6 * (3 + Math.floor(rnd() * 4)) : 3 + Math.floor(rnd() * 30);
  const q: Q[] = [];
  const period = n / 6;
  for (let i = 0; i < n; i += 1) {
    const raw =
      kind === 'still'
        ? rot(23, [1, 2, 3])
        : kind === 'cycle' && i >= period
          ? q[i - period]!
          : kind === 'small'
            ? turn(q[i - 1] ?? rot(10, [0, 1, 0]), 0.05 + rnd() * 2)
            : randQ(rnd() < 0.1 ? 170 : 60);
    q.push(i === 0 ? raw : align(q[i - 1]!, [...raw] as Q));
  }
  const stops = q.map((_, i) => i === 0 || i === n - 1 || (kind !== 'cycle' && rnd() < 0.12));
  const s: Q[] = q.map((qi, i) => (stops[i] || rnd() < 0.08 ? [...qi] as Q : kind === 'still' ? [...qi] as Q : turn(qi, rnd() * 15)));
  if (kind === 'cycle') for (let i = period; i < n; i += 1) s[i] = [...s[i - period]!] as Q;
  const spans: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    if (kind === 'cycle' && i >= period) {
      const r = rnd();
      // Re-timed by 1e-12, 4e-10 or 3e-9 of itself: the first two match, the last does not.
      const eps = r < 0.4 ? 1e-12 : r < 0.7 ? 4e-10 : 3e-9;
      spans.push(spans[i - period]! * (1 + (rnd() < 0.5 ? eps : -eps)));
    } else {
      const r = rnd();
      spans.push(r < 0.04 ? 1e-6 : r < 0.1 ? 2 + rnd() * 8 : 60 + rnd() * 400);
    }
  }
  const slopes = q.map((_, i) => (stops[i] ? 0 : 1 / (50 + rnd() * 400)));
  if (kind === 'cycle') for (let i = period; i < n; i += 1) slopes[i] = stops[i] ? 0 : slopes[i - period]!;
  const own = slopes.map((m) => m * (rnd() < 0.5 ? 1 : 0.55 + 0.45 * rnd()));
  if (kind === 'cycle') for (let i = period; i < n; i += 1) own[i] = stops[i] ? 0 : (own[i - period]! / (slopes[i - period]! || 1)) * slopes[i]!;
  const delays = [0.0225, 0.045, 0.09, 0.1125, 0.135, 0.1575, 0.18];
  return { q, s, own, slopes, spans, stops, delay: delays[Math.floor(rnd() * delays.length)]! };
}

describe('the organised stroke solver is the plain one, to the bit', () => {
  it('every c equals the reference solver’s — cold, from the memo, and after it is cleared', () => {
    seed = 20260925;
    const kinds = ['moving', 'still', 'cycle', 'small'] as const;
    let strokes = 0;
    let trailing = 0;
    let reused = 0;
    const misses: string[] = [];
    clearFollowThroughStrokeMemo();
    for (let trial = 0; trial < 240; trial += 1) {
      const b = randomSeries(kinds[trial % kinds.length]!);
      const want = referenceLags(b.q, b.s, b.own, b.slopes, b.spans, b.stops, b.delay);
      // Cold (a fresh memo for this bone's strokes), then again (every stroke
      // from the memo), then after clearing it — and the same strokes on a bone
      // of another delay, which the memo holds under the first one's.
      const other = b.delay === 0.18 ? 0.135 : 0.18;
      const wantOther = referenceLags(b.q, b.s, b.own, b.slopes, b.spans, b.stops, other);
      for (const pass of ['cold', 'memo', 'other delay', 'cleared'] as const) {
        if (pass === 'cleared') clearFollowThroughStrokeMemo();
        const delay = pass === 'other delay' ? other : b.delay;
        const expected = pass === 'other delay' ? wantOther : want;
        const got = new FollowThroughStrokes(b.slopes, b.spans, b.stops).lags(b.q, b.s, b.own, delay);
        expected.forEach((c, i) => {
          if (!Object.is(got[i], c)) misses.push(`trial ${trial} (${kinds[trial % kinds.length]}, ${pass}), segment ${i}: ${got[i]} vs ${c}`);
        });
      }
      strokes += want.length;
      trailing += want.filter((c) => c > 0).length;
      reused += want.filter((c, i) => i > 0 && want.indexOf(c) < i && c > 0).length;
    }
    expect(misses.slice(0, 5), `${misses.length} of ${4 * strokes} c differ from the reference`).toEqual([]);
    // The draw covers what it claims to: strokes that trail, and repeats.
    expect(trailing).toBeGreaterThan(400);
    expect(reused).toBeGreaterThan(50);
  });

  it('the stroke index answers every lookup as a scan of every solved stroke does', () => {
    seed = 20260926;
    // Inputs that stress the grid: values on and beside its cell edges (2⁻²⁰),
    // at and just past the tolerance either way, ±0, subnormals, huge
    // magnitudes, NaN and ±Infinity; strokes added out of the order they
    // match in, so the earliest of several matches must win.
    const CELL = 2 ** -20;
    const special = [0, -0, 5e-324, -5e-324, 1e-310, 1e303, -1e303, NaN, Infinity, -Infinity, CELL, -CELL, 3 * CELL, 1, -1];
    const value = (): number => {
      const r = rnd();
      if (r < 0.03) return special[Math.floor(rnd() * special.length)]!;
      if (r < 0.45) return (Math.floor(rnd() * 64) - 32) * CELL + (rnd() < 0.5 ? 1 : -1) * rnd() * 3e-9;
      return (rnd() - 0.5) * 4;
    };
    /** a moved by `k` × the tolerance around it (k < 1 matches, k > 1 does not). */
    const moved = (a: number, k: number): number => a + (rnd() < 0.5 ? 1 : -1) * k * SAME_STROKE_REL * (1 + Math.abs(a));
    /** A stroke like `base`: every input within the tolerance; one just past it;
     *  each on either side of it; or a fresh one. */
    const like = (base: number[]): number[] => {
      const r = rnd();
      if (r < 0.35) return base.map((a) => (rnd() < 0.5 ? a : moved(a, 0.999999 * rnd())));
      if (r < 0.6) {
        const d = Math.floor(rnd() * STROKE_INPUTS);
        return base.map((a, i) => (i === d ? moved(a, 1.000001) : a));
      }
      if (r < 0.8) return base.map((a) => (rnd() < 0.9 ? a : moved(a, rnd() < 0.5 ? 0.999999 : 1.000001)));
      return base.map(() => value());
    };
    let lookups = 0;
    let hits = 0;
    const misses: string[] = [];
    for (let run = 0; run < 60; run += 1) {
      const index = new StrokeIndex();
      const solved: number[][] = [];
      const ids: number[] = [];
      for (let i = 0; i < 400; i += 1) {
        const base = solved.length && rnd() < 0.6 ? solved[Math.floor(rnd() * solved.length)]! : null;
        const v = base ? like(base) : Array.from({ length: STROKE_INPUTS }, () => value());
        let want = -1;
        for (let k = 0; k < solved.length; k += 1) {
          if (solved[k]!.every((w, d) => near(v[d]!, w))) {
            want = ids[k]!;
            break;
          }
        }
        const got = index.find(v);
        lookups += 1;
        if (want >= 0) hits += 1;
        if (got !== want) misses.push(`run ${run}, lookup ${i}: ${got} vs ${want}`);
        // The builder files only strokes it solved (a miss); file some hits too,
        // so a lookup can match several and must return the earliest.
        if (want < 0 || rnd() < 0.2) {
          index.add(i, v);
          solved.push(v);
          ids.push(i);
        }
      }
    }
    expect(misses.slice(0, 5), `${misses.length} of ${lookups} lookups differ from the scan`).toEqual([]);
    expect(hits).toBeGreaterThan(lookups / 5);
  });

  it('a build’s stroke lookups grow linearly with its strokes (a count, which no load moves)', () => {
    seed = 20260927;
    // The wall-clock gate in followThroughContinuity.test.ts reads the same
    // thing through the timer; this counts the stroke comparisons the index
    // makes. ec3d0eb scanned every solved stroke: n distinct strokes cost
    // n(n − 1)/2 comparisons, so 16× the strokes cost ~256× (measured on a
    // copy of it with the count added, these four delayed bones: 493,024 →
    // 127,888,024 comparisons in both regimes, 259×). Keyed: 544 → 544, the
    // first sixteen strokes of each bone scanned and none after. The gate is
    // twice linear, 32×.
    const knotAt = (t: number, q: Q, stop: boolean): TrajectoryKnot => ({
      timeMs: t,
      pose: { variant: 'male', bones: { L_Forearm: q, L_Hand: q, R_Index1: q, Neck: q }, schemaVersion: POSE_SCHEMA_VERSION },
      rootQuat: [0, 0, 0, 1],
      rootTranslate: [0, 0, 0],
      stop,
      planted: true,
    });
    const held = (n: number): TrajectoryKnot[] => {
      const q = rot(17, [1, 2, 3]);
      let t = 0;
      return Array.from({ length: n }, (_, i) => knotAt(i === 0 ? 0 : (t += 80 + 80 * rnd()), q, i === 0 || i === n - 1));
    };
    const moving = (n: number): TrajectoryKnot[] => Array.from({ length: n }, (_, i) => knotAt(i * 120, randQ(35), i === 0 || i === n - 1));
    for (const [label, knotsOf] of [
      ['held still on unevenly timed knots', held],
      ['every knot a new pose', moving],
    ] as const) {
      const comparisons = (n: number): number => {
        clearFollowThroughStrokeMemo();
        strokeIndexCounters.comparisons = 0;
        buildPoseTrajectory(knotsOf(n));
        return strokeIndexCounters.comparisons;
      };
      const [small, big] = [comparisons(500), comparisons(8000)];
      // eslint-disable-next-line no-console
      console.log(`stroke index, ${label}: 500 knots ${small} comparisons, 8,000 knots ${big} (${(big / small).toFixed(1)}×)`);
      expect(small, `${label}: comparisons at 500 knots`).toBeGreaterThan(0);
      expect(big / small, `${label}: comparisons for 16× the strokes`).toBeLessThan(32);
    }
  });
});
