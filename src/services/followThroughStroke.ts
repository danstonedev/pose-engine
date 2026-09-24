/**
 * THE FOLLOW-THROUGH STROKE TRAIL — the c each delayed bone takes off its own
 * progress through a flowing stroke (motionStagger.followThroughStrokeLag),
 * solved once per build for motionTrajectory.buildPoseTrajectory, which applies
 * it as c·s²(1 − s)² in sampleAt.
 *
 * Everything here is arithmetic on the knots, and the answer does not depend on
 * how it is organised: every c is the one the per-stroke solver
 * ({@link strokeLagCoefficient}'s contract below) gives, to the bit. What is
 * organised is the cost, because a stroke's c is not cheap — its speed cap
 * samples the stroke's SQUAD path nine times — and a gait build solves a few
 * hundred of them:
 *
 *   - within a build, a stroke whose inputs all match (to 1e-9) one already
 *     solved takes that one's c ({@link StrokeIndex}, O(1) per lookup — a scan
 *     of every solved stroke made a motion of distinct strokes O(n²));
 *   - what every delayed bone shares through one segment — the lockstep
 *     chain's progress, its fastest rate, where its speed-check instants fall on
 *     a path table — is worked out once per segment ({@link ChainStroke});
 *   - the nine path samples share their sines: three's slerp takes sin((1 − t)θ)
 *     and sin(tθ), and at t = k/8 those are the same nine values, seven of them
 *     new; the outer slerp needs none at its two ends;
 *   - across builds, a stroke solved before is found by its exact inputs
 *     ({@link StrokeMemo}): the sampler and the stage build the same motion,
 *     every rate a motion is sampled at rebuilds it, and the stage builds a
 *     looping gait's one-shot and then its loop from the same cycle (the run
 *     loop: 212 of the loop's 399 strokes).
 */

import { followThroughStrokeLag, type FollowThroughStrokeLag } from './motionStagger';

type Q = [number, number, number, number]; // x,y,z,w

// ── the progress curve and its rate ──────────────────────────────────────────

/** Normalized cubic Hermite from 0 to 1 over s ∈ [0,1] with end slopes `mu0`,
 *  `mu1` (in s units) — the time-warp's segment shape. Exactly 0 at s = 0 and 1
 *  at s = 1 for any slopes. */
export function hermite01(s: number, mu0: number, mu1: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (s3 - 2 * s2 + s) * mu0 + (-2 * s3 + 3 * s2) + (s3 - s2) * mu1;
}

/** Instants across a stroke at which a bone's angular speed is checked. */
const STROKE_SPEED_SAMPLES = 24;
/** Those instants s = j/STROKE_SPEED_SAMPLES, and 1 − s. */
const SPEED_S = Array.from({ length: STROKE_SPEED_SAMPLES + 1 }, (_, j) => j / STROKE_SPEED_SAMPLES);
const SPEED_U = SPEED_S.map((s) => 1 - s);

/** One stroke's progress curve hermite01(s, μ0, μ1) − c·s²(1 − s)², with what
 *  every c shares worked out once. Its rate d/ds is the cubic
 *  ((a3·s + a2)·s + a1)·s + μ0 with a3 = −4c, a2 = b2 + 6c, a1 = b1 − 2c: the
 *  same sums, in the same order, that each call once formed afresh, so every
 *  rate — and every c a bisection settles on — is the same to the bit. */
interface StrokeProgress {
  mu0: number;
  mu1: number;
  /** 3μ0 + 3μ1 − 6 */
  b2: number;
  /** 6 − 4μ0 − 2μ1 */
  b1: number;
  /** hermite01 at each speed-check instant ({@link SPEED_S}), filled on first use. */
  at: number[] | null;
  /** The instant {@link speedFits} last found over its cap, checked first next
   *  time (a bisection's next c is close by, so it is likeliest to fail there). */
  hot: number;
}

function strokeProgress(mu0: number, mu1: number): StrokeProgress {
  return { mu0, mu1, b2: 3 * mu0 + 3 * mu1 - 6, b1: 6 - 4 * mu0 - 2 * mu1, at: null, hot: 0 };
}

function progressAt(p: StrokeProgress): number[] {
  let at = p.at;
  if (!at) {
    at = [];
    for (let j = 0; j <= STROKE_SPEED_SAMPLES; j += 1) at.push(hermite01(SPEED_S[j]!, p.mu0, p.mu1));
    p.at = at;
  }
  return at;
}

/** d/ds of the progress curve at s, trailing by c. */
function lagRate(p: StrokeProgress, s: number, c: number): number {
  const a3 = -4 * c;
  const a2 = p.b2 + 6 * c;
  const a1 = p.b1 - 2 * c;
  return ((a3 * s + a2) * s + a1) * s + p.mu0;
}

/** {@link lagRateRange}'s answer: one object, overwritten by every call and read
 *  straight after it (the bisections call it ~40 times a stroke). */
const rateRange = { lo: 0, hi: 0 };

/** Least and greatest rate d/ds over s ∈ [0,1] of the progress curve trailing by
 *  c — a cubic, so its extremes are its ends (μ0, μ1: the lag term leaves both
 *  slopes alone) and its interior stationary points. */
function lagRateRange(p: StrokeProgress, c: number): typeof rateRange {
  const a3 = -4 * c;
  const a2 = p.b2 + 6 * c;
  const a1 = p.b1 - 2 * c;
  let lo = Math.min(p.mu0, p.mu1);
  let hi = Math.max(p.mu0, p.mu1);
  // Stationary points: 3·a3·s² + 2·a2·s + a1 = 0 (NaN: none).
  const qa = 3 * a3;
  const qb = 2 * a2;
  let r0 = NaN;
  let r1 = NaN;
  if (Math.abs(qa) < 1e-12) {
    if (Math.abs(qb) > 1e-12) r0 = -a1 / qb;
  } else {
    const disc = qb * qb - 4 * qa * a1;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      r0 = (-qb + sq) / (2 * qa);
      r1 = (-qb - sq) / (2 * qa);
    }
  }
  if (r0 > 0 && r0 < 1) {
    const r = lagRate(p, r0, c);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  if (r1 > 0 && r1 < 1) {
    const r = lagRate(p, r1, c);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  rateRange.lo = lo;
  rateRange.hi = hi;
  return rateRange;
}

/** True when trailing by c keeps the bone going forwards and its progress rate
 *  at or under `rateCap`. */
function rateFits(p: StrokeProgress, c: number, rateCap: number): boolean {
  const { lo, hi } = lagRateRange(p, c);
  return lo >= 0 && hi <= rateCap;
}

// ── the stroke's path and its speed ──────────────────────────────────────────

/** Intervals a stroke's path-speed table splits its SQUAD parameter into. The
 *  speed is smooth along the path: 8 interval means through a Catmull–Rom keep
 *  the run and sprint loops' capped strokes within 1.001 × their cap (16 linear
 *  intervals, at twice the cost, 1.002; 12 linear 1.013). */
const PATH_SPEED_INTERVALS = 8;
/** Below this summed spread (rad) of a stroke's four SQUAD quaternions the bone
 *  holds still through it: nothing to cap. */
const STILL_PATH_RAD = 1e-6;

/** Geodesic angle (rad) between two unit quaternions — atan2 of the relative
 *  rotation conj(a)·b, well conditioned at the tiny steps a speed table takes. */
function qAngle(a: Q, b: Q): number {
  return qAngleOf(-a[0], -a[1], -a[2], a[3], b[0], b[1], b[2], b[3]);
}

/** {@link qAngle} between the path samples k and k + 1 in {@link SAMPLES}. */
function sampleStep(k: number): number {
  const o = 4 * k;
  return qAngleOf(-SAMPLES[o]!, -SAMPLES[o + 1]!, -SAMPLES[o + 2]!, SAMPLES[o + 3]!, SAMPLES[o + 4]!, SAMPLES[o + 5]!, SAMPLES[o + 6]!, SAMPLES[o + 7]!);
}

/** qAngle from conj(a) = (ax, ay, az, aw) and b. */
function qAngleOf(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number): number {
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w));
}

/** True when the rotation between a and b is certainly far above
 *  STILL_PATH_RAD, read cheaply off their 4-D dot: it is 2·acos(|a·b|/(|a||b|)),
 *  so |a·b|² ≤ 0.999998·|a|²|b|² puts it above 2.8e-3 rad — past any rounding
 *  of the exact sum it stands in for. */
function clearlyApart(a: Q, b: Q): boolean {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
  const bb = b[0] * b[0] + b[1] * b[1] + b[2] * b[2] + b[3] * b[3];
  return dot * dot <= 0.999998 * aa * bb;
}

/**
 * One end-fixed slerp of a stroke's SQUAD — three's Quaternion.slerp from `a`
 * toward `b`, set up for the path table's instants t = k/8. Three's slerp takes
 * sin((1 − t)θ) and sin(tθ); 1 − k/8 is (8 − k)/8 exactly, so across the nine
 * instants those are the same nine sines, taken once here ({@link sines}) —
 * the same calls on the same arguments, so each sample is three's to the bit.
 */
class SlerpTable {
  ax = 0;
  ay = 0;
  az = 0;
  aw = 0;
  bx = 0;
  by = 0;
  bz = 0;
  bw = 0;
  /** three lerps and normalizes past this dot, instead of slerping. */
  lerp = false;
  sin = 0;
  /** sin((k/8)·θ), k = 0..8 (unused when {@link lerp}). */
  readonly sines = new Float64Array(PATH_SPEED_INTERVALS + 1);

  set(a: ArrayLike<number>, b: ArrayLike<number>): void {
    this.ax = a[0]!;
    this.ay = a[1]!;
    this.az = a[2]!;
    this.aw = a[3]!;
    let x = b[0]!;
    let y = b[1]!;
    let z = b[2]!;
    let w = b[3]!;
    let dot = this.ax * x + this.ay * y + this.az * z + this.aw * w;
    if (dot < 0) {
      x = -x;
      y = -y;
      z = -z;
      w = -w;
      dot = -dot;
    }
    this.bx = x;
    this.by = y;
    this.bz = z;
    this.bw = w;
    this.lerp = !(dot < 0.9995);
    if (this.lerp) return;
    const n = PATH_SPEED_INTERVALS;
    const theta = Math.acos(dot);
    this.sin = Math.sin(theta);
    // k = 0: sin(0·θ) = +0 (θ > 0 here). k = n: sin(1·θ), the sine just taken.
    this.sines[0] = 0;
    for (let k = 1; k < n; k += 1) this.sines[k] = Math.sin((k / n) * theta);
    this.sines[n] = this.sin;
  }

  /** The slerp at t = k/8, into out[o..o+3]. */
  at(k: number, out: Float64Array, o: number): void {
    const n = PATH_SPEED_INTERVALS;
    const t = k / n;
    if (!this.lerp) {
      const s = this.sines[n - k]! / this.sin;
      const u = this.sines[k]! / this.sin;
      out[o] = this.ax * s + this.bx * u;
      out[o + 1] = this.ay * s + this.by * u;
      out[o + 2] = this.az * s + this.bz * u;
      out[o + 3] = this.aw * s + this.bw * u;
      return;
    }
    lerpNormalize(this.ax, this.ay, this.az, this.aw, this.bx, this.by, this.bz, this.bw, 1 - t, t, out, o);
  }
}

/** three's small-angle branch of slerp: lerp, then Quaternion.normalize. */
function lerpNormalize(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
  s: number, t: number, out: Float64Array, o: number,
): void {
  const x = ax * s + bx * t;
  const y = ay * s + by * t;
  const z = az * s + bz * t;
  const w = aw * s + bw * t;
  let l = Math.sqrt(x * x + y * y + z * z + w * w);
  if (l === 0) {
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 1;
    return;
  }
  l = 1 / l;
  out[o] = x * l;
  out[o + 1] = y * l;
  out[o + 2] = z * l;
  out[o + 3] = w * l;
}

/** THREE.Quaternion.slerp(a → b, t) in full, from a[ai..] and b[bi..] into
 *  out[o..] (out may alias a). At t = 0 — both ends of every stroke's outer
 *  slerp — three's slerp is a·1 + b·0 (sin(1·θ)/sin θ is exactly 1, sin(0)/sin θ
 *  exactly 0), taken here without the acos and sines. */
function slerpInto(
  a: Float64Array, ai: number, b: Float64Array, bi: number, t: number, out: Float64Array, o: number,
): void {
  const ax = a[ai]!;
  const ay = a[ai + 1]!;
  const az = a[ai + 2]!;
  const aw = a[ai + 3]!;
  let x = b[bi]!;
  let y = b[bi + 1]!;
  let z = b[bi + 2]!;
  let w = b[bi + 3]!;
  let dot = ax * x + ay * y + az * z + aw * w;
  if (dot < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
    dot = -dot;
  }
  let s = 1 - t;
  if (dot < 0.9995) {
    // At t = 0, s and t already are the 1 and 0 the sines would give.
    if (t !== 0) {
      const theta = Math.acos(dot);
      const sin = Math.sin(theta);
      s = Math.sin(s * theta) / sin;
      t = Math.sin(t * theta) / sin;
    }
    out[o] = ax * s + x * t;
    out[o + 1] = ay * s + y * t;
    out[o + 2] = az * s + z * t;
    out[o + 3] = aw * s + w * t;
    return;
  }
  lerpNormalize(ax, ay, az, aw, x, y, z, w, s, t, out, o);
}

const ALONG = new SlerpTable();
const CONTROLS = new SlerpTable();
/** The nine path samples of the stroke being solved, 4 components each. */
const SAMPLES = new Float64Array(4 * (PATH_SPEED_INTERVALS + 1));

/** A stroke's SQUAD, slerp(slerp(q0, q1, t), slerp(s0, s1, t), 2t(1 − t)), at
 *  t = k/8 for k = 0..8, into {@link SAMPLES} — squad's value to the bit. */
function squadTable(q0: ArrayLike<number>, q1: ArrayLike<number>, s0: ArrayLike<number>, s1: ArrayLike<number>): Float64Array {
  const n = PATH_SPEED_INTERVALS;
  ALONG.set(q0, q1);
  CONTROLS.set(s0, s1);
  for (let k = 0; k <= n; k += 1) {
    const o = 4 * k;
    const t = k / n;
    ALONG.at(k, SAMPLES, o);
    CONTROLS.at(k, CONTROL_SAMPLE, 0);
    slerpInto(SAMPLES, o, CONTROL_SAMPLE, 0, 2 * t * (1 - t), SAMPLES, o);
  }
  return SAMPLES;
}
const CONTROL_SAMPLE = new Float64Array(4);

/** A stroke's SQUAD at t = k/8, k = 0..8, as the path-speed table samples it.
 *  Exported for the suite, which pins it to three's own slerp bit for bit. */
export function strokeSquadTable(
  q0: [number, number, number, number],
  q1: [number, number, number, number],
  s0: [number, number, number, number],
  s1: [number, number, number, number],
): [number, number, number, number][] {
  const samples = squadTable(q0, q1, s0, s1);
  return Array.from({ length: PATH_SPEED_INTERVALS + 1 }, (_, k) => [
    samples[4 * k]!,
    samples[4 * k + 1]!,
    samples[4 * k + 2]!,
    samples[4 * k + 3]!,
  ]);
}

/** A stroke's path-speed table as {@link speedFits} reads it: per interval
 *  between two table entries, [p1, p2 − p1, and the Catmull–Rom sums
 *  p2 − p0, 2p0 − 5p1 + 4p2 − p3, 3(p1 − p2) + p3 − p0] — each formed once, in
 *  the order the interpolation writes it. */
const PATH = new Float64Array(5 * (PATH_SPEED_INTERVALS - 1));
const MEANS = new Float64Array(PATH_SPEED_INTERVALS);

/** A SQUAD stroke's mean angular speed along its own parameter (rad per unit of
 *  it) over each of PATH_SPEED_INTERVALS equal intervals, into {@link PATH}; or
 *  false when the bone holds still through the stroke. The path is not uniform
 *  in its parameter — its pace follows the knot tangents, slow by a
 *  zero-tangent knot, fast toward one whose neighbours lie far apart — so a
 *  bone's progress rate is not its speed. */
function pathSpeedTable(q0: Q, q1: Q, s0: Q, s1: Q): boolean {
  const moving = clearlyApart(q0, q1) || clearlyApart(q0, s0) || clearlyApart(q1, s1);
  if (!moving && qAngle(q0, q1) + qAngle(q0, s0) + qAngle(q1, s1) < STILL_PATH_RAD) return false;
  const n = PATH_SPEED_INTERVALS;
  squadTable(q0, q1, s0, s1);
  for (let j = 1; j <= n; j += 1) MEANS[j - 1] = sampleStep(j - 1) * n;
  for (let i = 0; i <= n - 2; i += 1) {
    const p1 = MEANS[i]!;
    const p2 = MEANS[i + 1]!;
    const p0 = i > 0 ? MEANS[i - 1]! : 2 * p1 - p2;
    const p3 = i + 2 < n ? MEANS[i + 2]! : 2 * p2 - p1;
    const k = 5 * i;
    PATH[k] = p1;
    PATH[k + 1] = p2 - p1;
    PATH[k + 2] = p2 - p0;
    PATH[k + 3] = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    PATH[k + 4] = 3 * (p1 - p2) + p3 - p0;
  }
  return true;
}

/** True when no speed-check instant of a bone whose progress is `p`, trailing
 *  by c, runs faster than `cap` along {@link PATH} — the fastest it moves
 *  through the stroke (rad per unit of the stroke's time) is at most `cap`.
 *  Which instant fails first does not change the answer, so the one that
 *  failed last is tried first. The path speed at progress l is a Catmull–Rom
 *  through the interval means (each second-order exact at its interval's
 *  middle), linear beyond the outer two. */
function speedFits(p: StrokeProgress, c: number, cap: number): boolean {
  const at = progressAt(p);
  const path = PATH;
  const n = PATH_SPEED_INTERVALS;
  const a3 = -4 * c;
  const a2 = p.b2 + 6 * c;
  const a1 = p.b1 - 2 * c;
  const mu0 = p.mu0;
  let j = p.hot;
  for (let m = 0; m <= STROKE_SPEED_SAMPLES; m += 1) {
    const s = SPEED_S[j]!;
    const u = SPEED_U[j]!;
    const l = at[j]! - c * s * s * u * u;
    const x = Math.min(1, Math.max(0, l)) * n - 0.5;
    const i = Math.max(0, Math.min(n - 2, Math.floor(x)));
    const t = x - i;
    const k = 5 * i;
    const speed =
      x < 0 || x > n - 1
        ? path[k]! + path[k + 1]! * t
        : path[k]! + 0.5 * t * (path[k + 2]! + t * (path[k + 3]! + t * path[k + 4]!));
    if (speed * Math.abs(((a3 * s + a2) * s + a1) * s + mu0) > cap) {
      p.hot = j;
      return false;
    }
    j = j === STROKE_SPEED_SAMPLES ? 0 : j + 1;
  }
  return true;
}

// ── one segment's lockstep chain, shared by every delayed bone through it ────

/**
 * The lockstep chain through one segment — λ0, λ1, the shared time-warp's
 * slopes over it — and what that fixes for every delayed bone: its fastest
 * progress rate, and at each speed-check instant its progress (so the Catmull–
 * Rom cell and offset a path table is read at) and |rate|. What a bone adds is
 * its path table, so the chain's fastest speed along it is nine table reads a
 * bone ({@link lockPeak}).
 */
class ChainStroke {
  readonly progress: StrokeProgress;
  /** lagRateRange(λ, 0).hi */
  readonly rateHi: number;
  private readonly cell: number[] = [];
  private readonly offset: number[] = [];
  private readonly outer: boolean[] = [];
  private readonly rate: number[] = [];

  constructor(lock0: number, lock1: number) {
    this.progress = strokeProgress(lock0, lock1);
    this.rateHi = lagRateRange(this.progress, 0).hi;
    const p = this.progress;
    const at = progressAt(p);
    const n = PATH_SPEED_INTERVALS;
    const c = 0;
    const a3 = -4 * c;
    const a2 = p.b2 + 6 * c;
    const a1 = p.b1 - 2 * c;
    for (let j = 0; j <= STROKE_SPEED_SAMPLES; j += 1) {
      const s = SPEED_S[j]!;
      const u = SPEED_U[j]!;
      const l = at[j]! - c * s * s * u * u;
      const x = Math.min(1, Math.max(0, l)) * n - 0.5;
      const i = Math.max(0, Math.min(n - 2, Math.floor(x)));
      this.cell.push(5 * i);
      this.offset.push(x - i);
      this.outer.push(x < 0 || x > n - 1);
      this.rate.push(Math.abs(((a3 * s + a2) * s + a1) * s + p.mu0));
    }
  }

  /** Fastest the lockstep chain moves a bone along {@link PATH} through this
   *  segment (rad per unit of the segment's time). */
  lockPeak(): number {
    let peak = 0;
    for (let j = 0; j <= STROKE_SPEED_SAMPLES; j += 1) {
      const k = this.cell[j]!;
      const t = this.offset[j]!;
      const speed =
        (this.outer[j]
          ? PATH[k]! + PATH[k + 1]! * t
          : PATH[k]! + 0.5 * t * (PATH[k + 2]! + t * (PATH[k + 3]! + t * PATH[k + 4]!))) * this.rate[j]!;
      if (speed > peak) peak = speed;
    }
    return peak;
  }
}

/** Largest c ≤ `bad` (bisected `steps` times from [0, bad]) that `fits`. */
function largest(fits: (c: number) => boolean, bad: number, steps: number): number {
  let ok = 0;
  for (let i = 0; i < steps; i += 1) {
    const mid = (ok + bad) / 2;
    if (fits(mid)) ok = mid;
    else bad = mid;
  }
  return ok;
}

/** The c the progress rate alone allows (0: none), from `target` down: the
 *  rate is linear in c at every s, so its greatest value is convex and its
 *  least concave in c — the c whose rate fits form one interval holding 0, and
 *  bisection finds its end. */
function rateTrail(p: StrokeProgress, target: number, rateCap: number): number {
  if (!rateFits(p, 0, rateCap)) return 0; // its turns already spend the stroke's budget
  return rateFits(p, target, rateCap) ? target : largest((c) => rateFits(p, c, rateCap), target, 40);
}

/**
 * The lag coefficient c for one delayed bone through one flowing stroke
 * (motionStagger.followThroughStrokeLag): its own Hermite runs with slopes
 * μ0, μ1 and the lockstep chain's with λ0, λ1 ({@link ChainStroke}). c/16 is
 * the progress it gives up at mid-stroke, so c = 16 · midLag · rate(½) trails
 * by midLag of the stroke's time there. It is cut back until the bone never
 * runs backwards and neither its progress rate nor its angular speed along the
 * stroke's path exceeds rateCeiling × the chain's fastest: the rate by
 * {@link rateTrail}, then the speed, checked at STROKE_SPEED_SAMPLES instants,
 * which only ever cuts that c further. The rate cap alone let the path's own
 * unevenness through: a run's hand peaked 1.29× and a sprint's fingers 1.50×
 * their lockstep speed inside a stroke, against 1/(1 − d) = 1.19 / 1.22. The
 * path's speed table is built only for a stroke the rate leaves a lag.
 */
function strokeLagCoefficient(
  mu0: number,
  mu1: number,
  chain: ChainStroke,
  budget: FollowThroughStrokeLag,
  q0: Q,
  q1: Q,
  s0: Q,
  s1: Q,
): number {
  const target = 16 * budget.midLag * (1.5 - (mu0 + mu1) / 4);
  if (!(target > 0)) return 0;
  const rateCap = budget.rateCeiling * chain.rateHi;
  const p = strokeProgress(mu0, mu1);
  const byRate = rateTrail(p, target, rateCap);
  if (!(byRate > 0)) return 0;
  if (!pathSpeedTable(q0, q1, s0, s1)) return byRate; // it holds still: no speed to cap
  const speedCap = budget.rateCeiling * chain.lockPeak();
  if (speedFits(p, byRate, speedCap)) return byRate;
  if (!speedFits(p, 0, speedCap)) return 0;
  // To 1/256 of the rate's c, rounded down: the speed only trims the trail.
  return largest((c) => rateFits(p, c, rateCap) && speedFits(p, c, speedCap), byRate, 8);
}

// ── finding a stroke already solved ──────────────────────────────────────────

/** Two strokes of one bone are the same stroke when each of their inputs agrees
 *  to this share: a repeated cycle strokes through the same poses on the same
 *  slopes, but re-times its knots by rounding-level amounts. */
export const SAME_STROKE_REL = 1e-9;
/** A stroke's inputs: the bone's own and the lockstep chain's knot slopes over
 *  it (4), then its four SQUAD quaternions (16). */
export const STROKE_INPUTS = 20;
/** The inputs the stroke index files a stroke under — its four slopes and the
 *  quaternion it leaves from. A stroke that matches matches on these too, so it
 *  is always in a cell the lookup visits; the rest are checked, not filed. */
const STROKE_KEYED = 8;
/** Width of the grid those inputs are filed on: 2⁻²⁰ ≈ 1e-6, about a thousand
 *  of the tolerance at the inputs' scale (slopes near 1, quaternion components
 *  at most 1), so a matching input all but always shares a cell. */
const STROKE_CELL = 2 ** -20;
/** More cells than this to visit and a lookup scans every solved stroke. */
const STROKE_PROBES_MAX = 64;
/** Up to this many solved strokes a lookup scans them all (cheaper than the
 *  grid at that size, and the same answer); past it, it uses the grid. */
const STROKE_SCAN_MAX = 16;

function sameStrokeInput(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_STROKE_REL * (1 + Math.abs(a));
}

/** A grid cell's bucket key (MurmurHash3's mixing, 32-bit). A weaker mix put
 *  the neighbouring cells a lookup visits at an input on a cell edge — every
 *  slope of an evenly timed stroke, 1 exactly — into filled buckets about a
 *  third of the time. Which bucket a cell lands in only costs comparisons:
 *  every candidate is checked on all its inputs. */
function strokeCellHash(cell: number[]): number {
  let h = 0x811c9dc5;
  for (let d = 0; d < STROKE_KEYED; d += 1) {
    let k = Math.imul(cell[d]! | 0, 0xcc9e2d51);
    k = Math.imul((k << 15) | (k >>> 17), 0x1b873593);
    h ^= k;
    h = (Math.imul((h << 13) | (h >>> 19), 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Stroke comparisons made by every {@link StrokeIndex} — each compares all
 *  twenty inputs of one solved stroke with the stroke looked up. The suite
 *  reads it to gate the build's lookups as linear in its strokes. */
export const strokeIndexCounters = { comparisons: 0 };

/**
 * The strokes of one bone already solved, so each distinct stroke's c is found
 * once. {@link StrokeIndex.find} answers what scanning every solved stroke in
 * order for the first whose inputs all match ({@link sameStrokeInput}) answers,
 * but looks only in the grid cells within the tolerance of each filed input —
 * one, unless an input sits within 1e-9 of a cell edge — so a motion's n
 * strokes cost O(n), not O(n²). Scanning every solved stroke instead made a
 * motion of distinct strokes quadratic: with one delayed bone, 16× the knots
 * took 34–122× the time (followThroughContinuity.test.ts).
 */
export class StrokeIndex {
  private readonly buckets = new Map<number, number[]>();
  /** Solved strokes in order — what a lookup scans when it cannot use the grid. */
  private readonly solved: number[] = [];
  private readonly inputs: (number[] | undefined)[] = [];
  /** Solved strokes (in order) filed in the grid so far: the grid is built
   *  only once a lookup needs it. */
  private filed = 0;
  private readonly lo = new Array<number>(STROKE_KEYED).fill(0);
  private readonly hi = new Array<number>(STROKE_KEYED).fill(0);
  private readonly cell = new Array<number>(STROKE_KEYED).fill(0);

  /** The earliest solved stroke whose inputs all match `v`, or −1. */
  find(v: readonly number[]): number {
    if (this.solved.length <= STROKE_SCAN_MAX) return this.scan(v);
    while (this.filed < this.solved.length) this.file(this.solved[this.filed++]!);
    let probes = 1;
    for (let d = 0; d < STROKE_KEYED; d += 1) {
      const a = v[d]!;
      if (!Number.isFinite(a)) return this.scan(v);
      // Every b within the tolerance of a, and a little more for rounding
      // (a/2⁻²⁰ is exact, so this is the cell of a ∓ reach).
      const x = a / STROKE_CELL;
      const reach = (SAME_STROKE_REL * (1 + Math.abs(a)) * (1 + 1e-6)) / STROKE_CELL;
      const lo = Math.floor(x - reach);
      const hi = Math.floor(x + reach);
      this.lo[d] = lo;
      this.hi[d] = hi;
      this.cell[d] = lo;
      if (hi !== lo) {
        probes *= hi - lo + 1;
        if (probes > STROKE_PROBES_MAX) return this.scan(v);
      }
    }
    let best = -1;
    for (;;) {
      const bucket = this.buckets.get(strokeCellHash(this.cell));
      if (bucket) {
        for (const j of bucket) {
          if (best >= 0 && j >= best) break;
          if (this.matches(v, j)) {
            best = j;
            break;
          }
        }
      }
      if (probes === 1) return best;
      let d = 0;
      while (d < STROKE_KEYED && this.cell[d] === this.hi[d]) {
        this.cell[d] = this.lo[d]!;
        d += 1;
      }
      if (d === STROKE_KEYED) return best;
      this.cell[d] += 1;
    }
  }

  /** Add stroke `i` (solved after every stroke already added) under a copy of
   *  its inputs. */
  add(i: number, v: readonly number[]): void {
    this.inputs[i] = v.slice(0, STROKE_INPUTS);
    this.solved.push(i);
  }

  /** File stroke `i` in the grid cell of its keyed inputs. */
  private file(i: number): void {
    const own = this.inputs[i]!;
    // A stroke with a filed input that is not finite matches no stroke whose
    // input there is finite: only a scan need see it.
    for (let d = 0; d < STROKE_KEYED; d += 1) {
      if (!Number.isFinite(own[d]!)) return;
      this.cell[d] = Math.floor(own[d]! / STROKE_CELL);
    }
    const key = strokeCellHash(this.cell);
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(i);
    else this.buckets.set(key, [i]);
  }

  private matches(v: readonly number[], j: number): boolean {
    strokeIndexCounters.comparisons += 1;
    const w = this.inputs[j]!;
    for (let d = 0; d < STROKE_INPUTS; d += 1) if (!sameStrokeInput(v[d]!, w[d]!)) return false;
    return true;
  }

  private scan(v: readonly number[]): number {
    for (const j of this.solved) if (this.matches(v, j)) return j;
    return -1;
  }
}

// ── strokes solved in earlier builds ─────────────────────────────────────────

/** Strokes the memo holds before it starts afresh (21 doubles each: ~690 KB). */
const MEMO_ENTRIES = 4096;
/** A memo key: the stroke's inputs, then the bone's delay (its budget). */
const MEMO_WIDTH = STROKE_INPUTS + 1;

/**
 * Every c solved lately, by the exact bits of its stroke's inputs and the
 * bone's delay — everything the solve reads — so what it returns is the c a
 * fresh solve of the same inputs gives, to the bit. The sampler and the stage
 * build the same motion; a gait builds its one-shot and then its loop from the
 * same cycle; a replay rebuilds it. Only a stroke no earlier stroke of its own
 * build matches reaches it (that match, to 1e-9, is {@link StrokeIndex}'s and
 * decides the c first), and it is cleared whole when full.
 */
class StrokeMemo {
  private readonly keys = new Float64Array(MEMO_ENTRIES * MEMO_WIDTH);
  private readonly keyBits = new Uint32Array(this.keys.buffer);
  private readonly lags = new Float64Array(MEMO_ENTRIES);
  /** Open addressing over twice the entries: entry index, or −1. */
  private readonly slots = new Int32Array(2 * MEMO_ENTRIES).fill(-1);
  private count = 0;
  private readonly probe = new Float64Array(MEMO_WIDTH);
  private readonly probeBits = new Uint32Array(this.probe.buffer);
  private slot = 0;

  /** Look up the stroke `v` of a bone at `delay`: its c, or NaN (no c is NaN).
   *  Leaves the probe staged for {@link add}. */
  find(v: readonly number[], delay: number): number {
    const probe = this.probe;
    for (let d = 0; d < STROKE_INPUTS; d += 1) probe[d] = v[d]!;
    probe[STROKE_INPUTS] = delay;
    const e = this.locate();
    return e < 0 ? NaN : this.lags[e]!;
  }

  /** File c under the probe the last {@link find} staged (and missed). */
  add(c: number): void {
    if (this.count === MEMO_ENTRIES) {
      this.clear();
      this.locate();
    }
    const e = this.count;
    this.count += 1;
    this.keys.set(this.probe, e * MEMO_WIDTH);
    this.lags[e] = c;
    this.slots[this.slot] = e;
  }

  /** The entry holding the staged probe, or −1 with {@link slot} left at the
   *  empty slot it would go in. */
  private locate(): number {
    const bits = this.probeBits;
    let h = 0x811c9dc5;
    for (let d = 0; d < 2 * MEMO_WIDTH; d += 1) h = Math.imul(h ^ bits[d]!, 0x01000193);
    const mask = 2 * MEMO_ENTRIES - 1;
    let slot = (h ^ (h >>> 15)) & mask;
    for (;;) {
      const e = this.slots[slot]!;
      if (e < 0) break;
      if (this.sameKey(e)) return e;
      slot = (slot + 1) & mask;
    }
    this.slot = slot;
    return -1;
  }

  clear(): void {
    this.slots.fill(-1);
    this.count = 0;
  }

  private sameKey(e: number): boolean {
    const bits = this.probeBits;
    const base = 2 * MEMO_WIDTH * e;
    for (let d = 0; d < 2 * MEMO_WIDTH; d += 1) if (this.keyBits[base + d] !== bits[d]) return false;
    return true;
  }
}

let memo: StrokeMemo | null = null;

/** Forget every stroke solved in earlier builds. For the suite, which times
 *  cold builds; a build's output is the same either way. */
export function clearFollowThroughStrokeMemo(): void {
  memo?.clear();
}

// ── one build's strokes ──────────────────────────────────────────────────────

/**
 * The flowing strokes of one build: the shared time-warp's knot slopes and
 * segment spans, and which knots stop. {@link lags} solves one delayed bone.
 */
export class FollowThroughStrokes {
  private readonly chains: (ChainStroke | undefined)[];
  private readonly inputs = new Array<number>(STROKE_INPUTS).fill(0);

  constructor(
    private readonly slopes: readonly number[],
    private readonly spans: readonly number[],
    private readonly stops: readonly boolean[],
  ) {
    this.chains = new Array<ChainStroke | undefined>(spans.length);
  }

  /**
   * Per segment, the c of the c·s²(1 − s)² a bone at `delay` trails the chain
   * by through a flowing stroke; 0 for a segment that leaves or reaches a stop
   * (leaving one, the dwell already trails; reaching one, the arrival — and any
   * late brake — stays the chain's). `q`, `s`: its aligned knot quaternions and
   * SQUAD controls; `own`: its own time-warp slope at each knot (per ms).
   */
  lags(q: readonly Q[], s: readonly Q[], own: readonly number[], delay: number): number[] {
    const n = q.length;
    const budget = followThroughStrokeLag(delay);
    const lag = new Array<number>(n - 1).fill(0);
    // A repeated cycle strokes through the same poses on the same slopes in
    // every rep, so each distinct stroke's c is found once and looked up by
    // its inputs after that: a 20-cycle walk solves 430 of its 7,920 flowing
    // bone-strokes, and the lookup stays O(1) however many distinct strokes a
    // motion has.
    const index = new StrokeIndex();
    const inputs = this.inputs;
    const stored = (memo ??= new StrokeMemo());
    for (let i = 0; i < n - 1; i += 1) {
      if (this.stops[i] || this.stops[i + 1]) continue;
      const h = this.spans[i]!;
      const qa = q[i]!;
      const qb = q[i + 1]!;
      const sa = s[i]!;
      const sb = s[i + 1]!;
      inputs[0] = own[i]! * h;
      inputs[1] = own[i + 1]! * h;
      inputs[2] = this.slopes[i]! * h;
      inputs[3] = this.slopes[i + 1]! * h;
      for (let c = 0; c < 4; c += 1) {
        inputs[4 + c] = qa[c]!;
        inputs[8 + c] = qb[c]!;
        inputs[12 + c] = sa[c]!;
        inputs[16 + c] = sb[c]!;
      }
      const same = index.find(inputs);
      if (same >= 0) {
        lag[i] = lag[same]!;
        continue;
      }
      let c = stored.find(inputs, delay);
      if (c !== c) {
        const chain = (this.chains[i] ??= new ChainStroke(inputs[2]!, inputs[3]!));
        c = strokeLagCoefficient(inputs[0]!, inputs[1]!, chain, budget, qa, qb, sa, sb);
        stored.add(c);
      }
      lag[i] = c;
      index.add(i, inputs);
    }
    return lag;
  }
}
