/**
 * CONTINUOUS MOTION TRAJECTORY — the dynamical model that replaces per-keyframe
 * stop-start playback.
 *
 * THEORY. The composed system was accurate about POSES (ROM-clamped, measured to
 * sub-degree) but naive about DYNAMICS: it played a multi-keyframe motion as a
 * sequence of INDEPENDENT ease-in-out tweens, each decelerating to zero velocity
 * at every keyframe and re-accelerating. That stop-start-stop is the dominant
 * reason composed motion reads as robotic — a velocity problem, not a pose one.
 *
 * This module plays the whole motion as ONE continuous trajectory that FLOWS
 * THROUGH the keyframe waypoints, with two decoupled parts:
 *
 *   1. PATH — a spherical spline (SQUAD, Shoemake) through each bone's quaternion
 *      at the knots. SQUAD is C¹ in its parameter and passes through every knot
 *      exactly, so it rounds the corners between keyframes instead of kinking.
 *   2. TIME-WARP — a monotone C¹ scalar map u(t) from wall-clock time to knot
 *      index, whose slope is ZERO only at genuine stops (start, a held keyframe,
 *      the end) and continuous & non-zero at interior fly-through waypoints.
 *
 * Angular velocity = dPath/du · du/dt. Because du/dt is continuous and only zero
 * at stops, the mannequin never stops at an interior waypoint (naturalness) yet
 * eases to rest at real stops (minimum-jerk feel). Because u(t_k) == k exactly,
 * the pose at every keyframe's scheduled time is EXACTLY that keyframe's pose —
 * so ROM clamping and goniometric measurement are untouched; only the path and
 * speed BETWEEN keyframes change. The live stage and the offline sampler both
 * build the trajectory here, so a recording stays frame-for-frame with the stage.
 *
 * FOLLOW-THROUGH (roadmap 2.2): on top of the shared time-warp, each BONE's
 * segment-local spline parameter is warped by the proximal→distal delay scheme
 * from ./motionStagger ({@link trajectoryBoneDelay}): local′ = clamp((local −
 * d)/(1 − d)). Distal arm segments start each inter-knot arc later and chase,
 * so the hand drags behind the shoulder through every reversal — TEMPORAL
 * overlap, not just pose-space. Both endpoints of the warp are fixed points
 * (0→0, 1→1), so every bone still reaches every knot exactly at its knot time
 * and the settle/measurement contract holds bit-for-bit. Root motion rides the
 * un-warped parameter, and legs are exempt (see trajectoryBoneDelay) so the
 * foot-plant IK and slide budgets are never fought.
 */

import * as THREE from 'three';
import type { CustomPose } from '../types';
import { POSE_SCHEMA_VERSION } from '../types';
import { trajectoryBoneDelay } from './motionStagger';

/** One waypoint of the motion: an absolute pose + root state at an absolute time. */
export interface TrajectoryKnot {
  timeMs: number;
  pose: CustomPose;
  rootQuat: [number, number, number, number];
  rootTranslate: [number, number, number];
  /** Zero-velocity here: the motion start, a held keyframe, and the final knot. */
  stop: boolean;
  /** A REVERSAL EXTREMUM (e.g. the terminal overshoot knot): the SQUAD PATH
   *  tangent is zeroed — the pose decelerates into this knot and eases back out
   *  along the path — but the TIME-warp keeps flowing (unlike `stop`, the body
   *  never freezes). Without this, SQUAD's neighbor-derived tangent carries the
   *  full inbound arc's momentum through the knot and deepens a ~3% overshoot
   *  into a wild swing. */
  pathExtremum?: boolean;
  /** SETTLE SHAPE (roadmap 5.5): velocity class of the keyframe ARRIVING at this
   *  STOP knot. Shapes the time-warp's deceleration into the stop — 'deliberate'
   *  (or absent) keeps today's symmetric PCHIP ease byte-identical; 'functional'
   *  arrives with a later, brisker deceleration; 'ballistic' brakes latest
   *  (composing with the terminal overshoot knot). Ignored on non-stop knots. */
  settleClass?: 'deliberate' | 'functional' | 'ballistic';
  planted: boolean;
  /** Grounding posture the body rests in at this knot (sitting/quadruped/…), or
   *  undefined for the default feet floor-pin. */
  groundingPosture?: string;
}

export interface TrajectorySample {
  pose: CustomPose;
  rootQuat: [number, number, number, number];
  rootTranslate: [number, number, number];
  planted: boolean;
  /** Grounding posture the body rests in for this frame, or undefined = feet-pin. */
  groundingPosture?: string;
}

export interface PoseTrajectory {
  totalMs: number;
  /** Pose + root at absolute time tMs (clamped to [0, totalMs]). */
  sampleAt(tMs: number): TrajectorySample;
}

// ── quaternion log/exp on the unit sphere (for SQUAD control points) ─────────

type Q = [number, number, number, number]; // x,y,z,w

function qMul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
function qConj(a: Q): Q {
  return [-a[0], -a[1], -a[2], a[3]];
}
/** Put b in the same hemisphere as a (unit quaternions double-cover SO(3)). */
function qAlign(a: Q, b: Q): Q {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0
    ? [-b[0], -b[1], -b[2], -b[3]]
    : b;
}
/** log of a UNIT quaternion → pure quaternion (vector part = axis·angle). */
function qLog(q: Q): [number, number, number] {
  const v = Math.hypot(q[0], q[1], q[2]);
  const w = Math.min(1, Math.max(-1, q[3]));
  if (v < 1e-9) return [0, 0, 0];
  const theta = Math.atan2(v, w);
  const k = theta / v;
  return [q[0] * k, q[1] * k, q[2] * k];
}
/** exp of a pure quaternion (vector part) → unit quaternion. */
function qExp(u: [number, number, number]): Q {
  const theta = Math.hypot(u[0], u[1], u[2]);
  if (theta < 1e-9) return [0, 0, 0, 1];
  const s = Math.sin(theta) / theta;
  return [u[0] * s, u[1] * s, u[2] * s, Math.cos(theta)];
}

/** SQUAD intermediate control at knot i, given aligned neighbours i-1,i,i+1. */
function squadControl(prev: Q, cur: Q, next: Q): Q {
  const invCur = qConj(cur);
  const ln = qLog(qMul(invCur, next));
  const lp = qLog(qMul(invCur, prev));
  const avg: [number, number, number] = [
    -(ln[0] + lp[0]) / 4,
    -(ln[1] + lp[1]) / 4,
    -(ln[2] + lp[2]) / 4,
  ];
  return qMul(cur, qExp(avg));
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _qe = new THREE.Quaternion();

/** SQUAD(q0,q1,s0,s1,t) = slerp( slerp(q0,q1,t), slerp(s0,s1,t), 2t(1-t) ). */
function squad(q0: Q, q1: Q, s0: Q, s1: Q, t: number): Q {
  _qa.set(q0[0], q0[1], q0[2], q0[3]);
  _qb.set(q1[0], q1[1], q1[2], q1[3]);
  _qc.set(s0[0], s0[1], s0[2], s0[3]);
  _qd.set(s1[0], s1[1], s1[2], s1[3]);
  _qa.slerp(_qb, t); // slerp(q0,q1,t)
  _qc.slerp(_qd, t); // slerp(s0,s1,t)
  _qe.copy(_qa).slerp(_qc, 2 * t * (1 - t));
  return [_qe.x, _qe.y, _qe.z, _qe.w];
}

// ── monotone C¹ time-warp: absolute time → knot index u ──────────────────────

// ── Per-velocity-class settle shapes (roadmap 5.5) ───────────────────────────
/** LATE-BRAKE intensity per velocity class — how much the segment INTO a stop
 *  knot delays its deceleration. The braking segment's within-segment parameter
 *  is composed with w(s) = s·(1 − b·s·(1−s)): w(0)=0, w(1)=1 and w′(0)=1 keep
 *  u(t_k)=k and the C¹ entry slope EXACT, while progress lags mid-segment and
 *  catches up late — the profile holds speed longer and brakes later/harder the
 *  bigger `b`. Monotone for b < 3 (w′ ≥ 1 − b/3 > 0). 'deliberate' (and any
 *  absent class) takes the b = 0 path untouched — byte-identical to today's
 *  symmetric ease. 'ballistic' composes with the terminal overshoot knot: the
 *  shaped segment is the overshoot→target settle, so a fast ending sails past
 *  the pose and arrests LATE, like a limb with mass. */
const SETTLE_BRAKE_LATENESS: Readonly<Record<string, number>> = {
  functional: 0.75,
  ballistic: 1.5,
};

/** Piecewise-cubic-Hermite map from knot times to knot index. Slope is forced
 *  to 0 at `stop` knots and set to the (monotone) PCHIP secant blend elsewhere,
 *  so u(t) passes through (t_k, k) exactly, is C¹, and never overshoots.
 *  `brakes` (parallel to `times`, all-0 when absent) carries the per-knot
 *  late-brake intensity ({@link SETTLE_BRAKE_LATENESS}) applied to the segment
 *  ARRIVING at that knot — non-zero only on stop knots whose keyframe carries a
 *  functional/ballistic velocity class. */
function buildTimeWarp(
  times: number[],
  stops: boolean[],
  brakes?: number[],
): (t: number) => number {
  const n = times.length;
  const m = new Array<number>(n).fill(0); // du/dt at each knot
  const h = new Array<number>(n - 1);
  const d = new Array<number>(n - 1); // secant slope of index-vs-time = 1/h
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = Math.max(1e-6, times[i + 1]! - times[i]!);
    d[i] = 1 / h[i]!;
  }
  for (let i = 0; i < n; i += 1) {
    if (stops[i]) {
      m[i] = 0;
      continue;
    }
    if (i === 0) m[i] = d[0]!;
    else if (i === n - 1) m[i] = d[n - 2]!;
    else {
      // Weighted harmonic mean (Fritsch–Carlson) keeps u(t) monotone.
      const w1 = 2 * h[i]! + h[i - 1]!;
      const w2 = h[i]! + 2 * h[i - 1]!;
      m[i] = (w1 + w2) / (w1 / d[i - 1]! + w2 / d[i]!);
    }
  }
  return (t: number): number => {
    if (t <= times[0]!) return 0;
    if (t >= times[n - 1]!) return n - 1;
    let i = 0;
    while (i < n - 2 && t > times[i + 1]!) i += 1;
    let s = (t - times[i]!) / h[i]!; // 0..1 within segment
    // SETTLE SHAPE (roadmap 5.5): a segment braking into a functional/ballistic
    // stop composes the LATE-BRAKE warp w(s) = s·(1 − b·s·(1−s)) — endpoints and
    // the entry slope are fixed points (u(t_k)=k and C¹ continuity hold exactly;
    // the arrival slope stays 0 since m[i+1]=0 at a stop), monotone for b < 3,
    // and progress lags mid-segment then catches up late: speed is held longer
    // and the deceleration lands later and harder. b = 0 (every 'deliberate' or
    // unclassed stop, and every non-stop knot) leaves `s` untouched.
    const b = brakes ? brakes[i + 1]! : 0;
    if (b > 0 && stops[i + 1]) s = s * (1 - b * s * (1 - s));
    const s2 = s * s;
    const s3 = s2 * s;
    // Hermite basis for value (indices i, i+1) and tangents (scaled by h).
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    return h00 * i + h10 * (h[i]! * m[i]!) + h01 * (i + 1) + h11 * (h[i]! * m[i + 1]!);
  };
}

// ── trajectory assembly ──────────────────────────────────────────────────────

/** Build a continuous, velocity-continuous trajectory through the knots.
 *  Requires ≥1 knot; with a single knot it is a constant pose. */
export function buildPoseTrajectory(knots: TrajectoryKnot[]): PoseTrajectory {
  const n = knots.length;
  const times = knots.map((k) => k.timeMs);
  const stops = knots.map((k) => k.stop);
  // Zero-tangent knots for the SQUAD PATH: real stops AND reversal extrema
  // (which keep flowing in TIME — only `stops` feeds the time-warp).
  const pathStops = knots.map((k) => k.stop || k.pathExtremum === true);
  const totalMs = n > 0 ? times[n - 1]! : 0;

  if (n <= 1) {
    const only = knots[0];
    return {
      totalMs,
      sampleAt: () => ({
        pose: only ? clonePose(only.pose) : emptyPose(),
        rootQuat: only ? [...only.rootQuat] : [0, 0, 0, 1],
        rootTranslate: only ? [...only.rootTranslate] : [0, 0, 0],
        planted: only?.planted ?? false,
      }),
    };
  }

  // Per-knot late-brake intensity (roadmap 5.5): non-zero only where a STOP knot
  // carries a functional/ballistic settle class. All-zero (every knot deliberate
  // or unclassed) passes `undefined` — the exact pre-shape warp path.
  const brakes = knots.map((k) =>
    k.stop && k.settleClass ? SETTLE_BRAKE_LATENESS[k.settleClass] ?? 0 : 0,
  );
  const warp = buildTimeWarp(times, stops, brakes.some((b) => b > 0) ? brakes : undefined);

  // Per bone key, the aligned quaternion series across knots + SQUAD controls.
  // Bones absent at a knot carry forward the previous knot's value.
  const boneKeys = new Set<string>();
  for (const k of knots) for (const key of Object.keys(k.pose.bones ?? {})) boneKeys.add(key);

  interface BoneSeries {
    q: Q[]; // aligned quaternion per knot
    s: Q[]; // SQUAD control per knot
    /** Proximal→distal follow-through onset delay (fraction of a segment). */
    delay: number;
  }
  const series = new Map<string, BoneSeries>();
  for (const key of boneKeys) {
    const q: Q[] = [];
    let carry: Q = [0, 0, 0, 1];
    for (let i = 0; i < n; i += 1) {
      const raw = knots[i]!.pose.bones?.[key];
      const cur: Q = raw ? [raw[0], raw[1], raw[2], raw[3]] : carry;
      const aligned = i === 0 ? cur : qAlign(q[i - 1]!, cur);
      q.push(aligned);
      carry = aligned;
    }
    const s: Q[] = [];
    for (let i = 0; i < n; i += 1) {
      // A STOP knot (start / held keyframe / end) — or a reversal EXTREMUM —
      // gets a zero-velocity PATH tangent: control == the knot itself. This both
      // eases in/out without overshoot and keeps a hold (two equal stop knots)
      // exactly constant — otherwise the SQUAD control points bend the path away
      // from the held pose mid-segment.
      if (pathStops[i]) {
        s.push([...q[i]!]);
        continue;
      }
      const prev = q[Math.max(0, i - 1)]!;
      const next = q[Math.min(n - 1, i + 1)]!;
      s.push(squadControl(prev, q[i]!, next));
    }
    series.set(key, { q, s, delay: trajectoryBoneDelay(key) });
  }

  // Root orientation series (single quaternion) + controls; translate lerps.
  const rq: Q[] = [];
  for (let i = 0; i < n; i += 1) {
    const cur = knots[i]!.rootQuat;
    rq.push(i === 0 ? [...cur] : qAlign(rq[i - 1]!, [...cur]));
  }
  const rs: Q[] = [];
  for (let i = 0; i < n; i += 1)
    rs.push(
      pathStops[i]
        ? [...rq[i]!]
        : squadControl(rq[Math.max(0, i - 1)]!, rq[i]!, rq[Math.min(n - 1, i + 1)]!),
    );

  // ── Gravity-true ballistic vertical ────────────────────────────────────────
  // A FLOATING span (airborne — no floor pin) is a projectile: its vertical must
  // follow a constant-g PARABOLA, not the linear knot lerp (which makes a jump
  // read as an eased hang instead of an accelerating fall). Find each maximal run
  // of floating knots flanked by planted knots (a complete take-off→landing) and,
  // during it, drive root-Y from an endpoint-preserving parabola peaking at the
  // authored apex: y(τ) = y0 + (y1−y0)·τ + 4·A·τ(1−τ), A = apex − (y0+y1)/2. Then
  // d²y/dτ² = −8A is constant (constant acceleration = gravity's shape); with the
  // builders setting the flight DURATION to 2√(2·apex/g) (see ballisticFlightMs)
  // that acceleration equals real g, and the "hang" emerges naturally from the low
  // vertical velocity near the apex. ROOT-Y ONLY — joint angles, planted spans, and
  // every knot pose/time are untouched, so it's a pure, deterministic reshape and a
  // strict no-op for grounded motion (no floating knots ⇒ empty `flights`).
  const flights: { startMs: number; endMs: number; y0: number; y1: number; apexY: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    if (knots[i]!.planted) continue;
    const j0 = i;
    let j1 = i;
    while (j1 + 1 < n && !knots[j1 + 1]!.planted) j1 += 1;
    i = j1; // skip past this floating run
    const before = j0 - 1;
    const after = j1 + 1;
    // Both planted flanks required — a complete flight. Incomplete runs at the very
    // ends (e.g. a loop trajectory's wrapped padding) are left to the linear lerp.
    if (before < 0 || after >= n) continue;
    const startMs = knots[before]!.timeMs;
    const endMs = knots[after]!.timeMs;
    if (endMs <= startMs) continue;
    let apexY = -Infinity;
    for (let m = j0; m <= j1; m += 1) apexY = Math.max(apexY, knots[m]!.rootTranslate[1]);
    const y0 = knots[before]!.rootTranslate[1];
    const y1 = knots[after]!.rootTranslate[1];
    if (apexY <= Math.max(y0, y1) + 1e-4) continue; // a flat float, not a hop — leave it
    flights.push({ startMs, endMs, y0, y1, apexY });
  }
  // In a flight span: the airborne vertical (parabola) AND whether the floor-pin
  // must be suppressed. `airborne` is the STRICT interior — the flanking contact
  // knots (take-off, landing) keep their own planted state so the pin grounds them;
  // everything in between is a projectile and must NOT be pinned (otherwise the
  // segment travelling INTO the planted landing pins the body while it is still
  // metres up the arc — a hard drop-snap on contact).
  const ballistic = (tMs: number): { y: number; airborne: boolean } | null => {
    for (const f of flights) {
      if (tMs < f.startMs || tMs > f.endMs) continue;
      const tau = (tMs - f.startMs) / (f.endMs - f.startMs);
      const A = f.apexY - (f.y0 + f.y1) / 2;
      const y = f.y0 + (f.y1 - f.y0) * tau + 4 * A * tau * (1 - tau);
      return { y, airborne: tMs > f.startMs && tMs < f.endMs };
    }
    return null;
  };

  return {
    totalMs,
    sampleAt(tMs: number): TrajectorySample {
      const tClamped = Math.min(totalMs, Math.max(0, tMs));
      const u = warp(tClamped);
      const k = Math.min(n - 2, Math.max(0, Math.floor(u)));
      const local = Math.min(1, Math.max(0, u - k));

      const bones: Record<string, [number, number, number, number]> = {};
      for (const [key, bs] of series) {
        // FOLLOW-THROUGH warp: the delayed-and-renormalized per-bone parameter
        // (same scheme as motionStagger.stagedBlendWithBaseline, applied to the
        // SEGMENT-LOCAL spline parameter). local′(0)=0 and local′(1)=1, so knot
        // arrival — and thus every settle measurement — is exact; the lag lives
        // strictly mid-segment. delay==0 (root-adjacent, legs) is the identity.
        const d = bs.delay;
        const lb = d > 0 ? (local <= d ? 0 : (local - d) / (1 - d)) : local;
        bones[key] = squad(bs.q[k]!, bs.q[k + 1]!, bs.s[k]!, bs.s[k + 1]!, lb);
      }

      const rootQ = squad(rq[k]!, rq[k + 1]!, rs[k]!, rs[k + 1]!, local);
      const a = knots[k]!.rootTranslate;
      const b = knots[k + 1]!.rootTranslate;
      const rootTranslate: [number, number, number] = [
        a[0] + (b[0] - a[0]) * local,
        a[1] + (b[1] - a[1]) * local,
        a[2] + (b[2] - a[2]) * local,
      ];
      // Planted state follows the segment we are travelling INTO.
      let planted = knots[k + 1]!.planted;
      // Airborne vertical follows the gravity parabola, not the linear lerp — and a
      // body in flight is NOT floor-pinned (else it snaps to the ground the instant
      // the segment into the planted landing begins, while still up the arc).
      if (flights.length) {
        const b = ballistic(tClamped);
        if (b != null) {
          rootTranslate[1] = b.y;
          if (b.airborne) planted = false;
        }
      }

      return {
        pose: { variant: knots[k]!.pose.variant, bones, schemaVersion: POSE_SCHEMA_VERSION },
        rootQuat: rootQ,
        rootTranslate,
        planted,
        groundingPosture: knots[k + 1]!.groundingPosture,
      };
    },
  };
}

/** Minimal shape of buildSequencePoses' output that the trajectory needs. */
export interface SequenceBuildLike {
  poses: CustomPose[];
  roots: {
    quat: [number, number, number, number];
    translateM: [number, number, number];
    stance?: string;
    groundingPosture?: string;
  }[];
  durationsMs: number[];
  holdsMs: number[];
  /** Parallel to `poses`: each keyframe's velocity class ('deliberate' when
   *  absent). Drives the terminal pre-settle overshoot — only fast
   *  (functional/ballistic) endings arrive with enough momentum to sell it. */
  velocityClasses?: readonly ('deliberate' | 'functional' | 'ballistic' | undefined)[];
}

// ── Terminal pre-settle overshoot (roadmap 2.3) ──────────────────────────────
/** Fraction of the inbound (final-segment) travel the fly-through overshoot
 *  knot extends past the target. */
const TERMINAL_OVERSHOOT_FRACTION = 0.03;
/** How long before the final stop the overshoot knot sits (capped at 40% of
 *  the final segment so short endings keep a real approach). */
const TERMINAL_OVERSHOOT_LEAD_MS = 120;
/** Inbound travel (max single-bone rotation, deg) below which the ending is a
 *  drift, not an arrival at speed — no overshoot. */
const TERMINAL_OVERSHOOT_MIN_TRAVEL_DEG = 2;

/** Largest single-bone rotation (deg) between two knot poses (absent keys
 *  carry forward, i.e. contribute zero travel). */
function maxBoneTravelDeg(from: CustomPose, to: CustomPose): number {
  let maxRad = 0;
  for (const [key, b] of Object.entries(to.bones ?? {})) {
    const a = from.bones?.[key];
    if (!a) continue;
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    maxRad = Math.max(maxRad, 2 * Math.acos(Math.min(1, dot)));
  }
  return (maxRad * 180) / Math.PI;
}

/**
 * Build the fly-through OVERSHOOT knot for a final stop arriving at speed:
 * every bone extrapolated `TERMINAL_OVERSHOOT_FRACTION` past its target along
 * its own inbound geodesic (q(t) = prev·(prev⁻¹·arr)^t evaluated at 1+f), so a
 * fast ending sails ~3% past the pose and settles back instead of dead-
 * stopping — limbs read as having mass. The knot is an interior fly-through:
 * the FINAL knot, its time, and its stop stay byte-identical, so the settled
 * pose and every measurement are untouched.
 *
 * ROOT motion does NOT overshoot: the root state at the knot is the plain
 * segment interpolant (slerp/lerp at the knot's time fraction), keeping the
 * root path — and with it the floor-pin / grounding behaviour — unchanged. The
 * mass cue lives in the limbs; an overshooting root could dip through the
 * floor-pin on a landing.
 */
function terminalOvershootKnot(prev: TrajectoryKnot, arrival: TrajectoryKnot): TrajectoryKnot | null {
  const segMs = arrival.timeMs - prev.timeMs;
  if (segMs <= 1) return null;
  if (maxBoneTravelDeg(prev.pose, arrival.pose) < TERMINAL_OVERSHOOT_MIN_TRAVEL_DEG) return null;
  const leadMs = Math.min(TERMINAL_OVERSHOOT_LEAD_MS, segMs * 0.4);
  const tMs = arrival.timeMs - leadMs;
  const frac = (tMs - prev.timeMs) / segMs;

  const bones: Record<string, [number, number, number, number]> = {};
  for (const [key, arrRaw] of Object.entries(arrival.pose.bones ?? {})) {
    const arr: Q = [arrRaw[0], arrRaw[1], arrRaw[2], arrRaw[3]];
    const prevRaw = prev.pose.bones?.[key];
    if (!prevRaw) {
      bones[key] = [...arr]; // no inbound travel for this bone — no overshoot
      continue;
    }
    const p = qAlign(arr, [prevRaw[0], prevRaw[1], prevRaw[2], prevRaw[3]]);
    // q(1+f) = arr · (prev⁻¹·arr)^f — powers of one quaternion commute, so this
    // is the exact geodesic extrapolation past the target.
    const delta = qLog(qMul(qConj(p), arr));
    bones[key] = qMul(
      arr,
      qExp([
        delta[0] * TERMINAL_OVERSHOOT_FRACTION,
        delta[1] * TERMINAL_OVERSHOOT_FRACTION,
        delta[2] * TERMINAL_OVERSHOOT_FRACTION,
      ]),
    );
  }

  // Root: plain interpolants — see doc above.
  _qa.set(prev.rootQuat[0], prev.rootQuat[1], prev.rootQuat[2], prev.rootQuat[3]);
  _qb.set(arrival.rootQuat[0], arrival.rootQuat[1], arrival.rootQuat[2], arrival.rootQuat[3]);
  _qa.slerp(_qb, frac);
  const a = prev.rootTranslate;
  const b = arrival.rootTranslate;
  return {
    timeMs: tMs,
    pose: { variant: arrival.pose.variant, bones, schemaVersion: POSE_SCHEMA_VERSION },
    rootQuat: [_qa.x, _qa.y, _qa.z, _qa.w],
    rootTranslate: [
      a[0] + (b[0] - a[0]) * frac,
      a[1] + (b[1] - a[1]) * frac,
      a[2] + (b[2] - a[2]) * frac,
    ],
    stop: false,
    // A reversal extremum: the path decelerates into the overshoot and eases
    // back to the target — time keeps flowing (no stall).
    pathExtremum: true,
    planted: arrival.planted,
    ...(arrival.groundingPosture ? { groundingPosture: arrival.groundingPosture } : {}),
  };
}

export interface ComposedTrajectory {
  trajectory: PoseTrajectory;
  /** Absolute ms at which each keyframe SETTLES (arrival, before any hold) — the
   *  instants the stage/sampler measure the achieved pose. */
  settleAtMs: number[];
}

/**
 * THE shared builder both the live stage and the offline sampler use to turn a
 * resolved keyframe sequence into one continuous trajectory. Keeping it here (one
 * function, one knot layout) is what guarantees a recording is frame-for-frame
 * what the stage shows. A keyframe that holds — or the final keyframe — is a STOP
 * (zero velocity); interior keyframes are fly-throughs.
 */
export function buildComposedTrajectory(
  built: SequenceBuildLike,
  opts: {
    startPose: CustomPose;
    startQuat: [number, number, number, number];
    startTranslate: [number, number, number];
    timeScale: number;
    /** FINITE reps: replay the whole cycle this many times (default 1) — the
     *  repeat happens HERE, at trajectory time, so the authored plan stays small
     *  (a "50 jumps" is a 6-keyframe motion). Each rep flows into the next
     *  (interior rep boundaries are fly-throughs unless the last keyframe holds);
     *  only the FINAL keyframe of the LAST rep is the settle stop. */
    reps?: number;
    /** CYCLIC ends (locomotion): a travelling gait is a steady rhythm, not a
     *  gesture — easing to zero velocity at the start (the neutral→gait entry) and
     *  end makes the limbs whip in to catch up and halt at the finish, so the arm
     *  swing reads as ACCELERATED at both ends. When set, the first and last knots
     *  are fly-throughs (non-stop): the entry begins already at swing velocity and
     *  the exit doesn't brake, so the cadence stays uniform. Knot TIMES are
     *  unchanged (foot contacts / footDrivenTravel stay in sync). */
    cyclicEnds?: boolean;
    /** MOMENTUM-PRESERVING SEAM (roadmap 4.4, opt-in): every cross-command seam
     *  otherwise brakes to zero — the start knot is a stop, so a motion chained
     *  after a walk/kick eases in from rest and the carried momentum dies at the
     *  seam. When set, ONLY the FIRST knot becomes a fly-through (stop:false —
     *  the same boundary mechanics `cyclicEnds` uses for both ends): the entry
     *  time-warp slope is the first segment's secant instead of 0, so the chained
     *  motion ENTERS with velocity. Everything else is untouched — interior
     *  holds, the FINAL stop (and its terminal pre-settle overshoot), knot times,
     *  and the settle/measurement contract (u(t_k)=k) are byte-identical, and an
     *  unflagged build is byte-identical to today. Redundant under `cyclicEnds`
     *  (which already frees both ends). */
    flowIn?: boolean;
  },
): ComposedTrajectory {
  const { startPose, startQuat, startTranslate, timeScale } = opts;
  const reps = Math.max(1, Math.floor(opts.reps ?? 1));
  const cyclicEnds = opts.cyclicEnds === true;
  // flowIn frees ONLY the entry knot (the final settle still stops).
  const flowIn = opts.flowIn === true;
  const n = built.poses.length;
  const knots: TrajectoryKnot[] = [
    {
      timeMs: 0,
      pose: startPose,
      rootQuat: startQuat,
      rootTranslate: startTranslate,
      stop: !cyclicEnds && !flowIn,
      planted: built.roots[0]?.stance === 'planted',
      groundingPosture: built.roots[0]?.groundingPosture,
    },
  ];
  // Settle instants for the FIRST rep only — the stage measures one cycle (all
  // reps replay the same keyframes), so `settleAtMs` maps 1:1 to resolved.keyframes.
  const settleAtMs: number[] = [];
  // Index (in `knots`) of the final keyframe's ARRIVAL knot — the terminal stop
  // a pre-settle overshoot may be inserted before.
  let finalArrivalIdx = -1;
  let tCursor = 0;
  for (let r = 0; r < reps; r += 1) {
    for (let i = 0; i < n; i += 1) {
      const rs = built.roots[i]!;
      const planted = rs.stance === 'planted';
      const isVeryLast = r === reps - 1 && i === n - 1;
      const holdMs = Math.min((built.holdsMs[i] ?? 0) / timeScale, 10_000);
      tCursor += built.durationsMs[i]! / timeScale;
      if (r === 0) settleAtMs.push(tCursor);
      if (isVeryLast) finalArrivalIdx = knots.length;
      const stop = holdMs > 0 || (isVeryLast && !cyclicEnds);
      // SETTLE SHAPE (roadmap 5.5): a STOP arrival (a held keyframe or the final
      // settle) carries its keyframe's velocity class, so the time-warp brakes
      // later/harder for functional/ballistic arrivals. 'deliberate'/absent adds
      // nothing — the knot (and the whole warp) stays byte-identical.
      const cls = built.velocityClasses?.[i];
      const settleClass =
        stop && (cls === 'functional' || cls === 'ballistic') ? { settleClass: cls } : {};
      knots.push({
        timeMs: tCursor,
        pose: built.poses[i]!,
        rootQuat: rs.quat,
        rootTranslate: rs.translateM,
        stop,
        ...settleClass,
        planted,
        groundingPosture: rs.groundingPosture,
      });
      if (holdMs > 0) {
        tCursor += holdMs;
        knots.push({
          timeMs: tCursor,
          pose: built.poses[i]!,
          rootQuat: rs.quat,
          rootTranslate: rs.translateM,
          stop: true,
          groundingPosture: rs.groundingPosture,
          planted,
        });
      }
    }
  }

  // TERMINAL PRE-SETTLE OVERSHOOT (roadmap 2.3): a motion whose FINAL keyframe
  // arrives at speed (functional/ballistic velocity class) gets ONE fly-through
  // knot at target + ~3% of the inbound travel, ~120 ms before the stop — the
  // ending overshoots and settles instead of dead-stopping servo-perfect, so
  // fast recoveries (a kick's leg coming down) read as limbs with mass. The
  // final knot, its time, and its stop flag are untouched: the settled pose —
  // and everything measured from it — stays byte-exact. Deliberate (clinical
  // default) endings, cyclic gait ends, and near-zero-travel endings are
  // exempt; a flight-flanking segment is left alone so the ballistic parabola's
  // planted↔floating span detection is never perturbed.
  const finalClass = built.velocityClasses?.[n - 1] ?? 'deliberate';
  if (
    !cyclicEnds &&
    finalArrivalIdx >= 1 &&
    (finalClass === 'functional' || finalClass === 'ballistic')
  ) {
    const prev = knots[finalArrivalIdx - 1]!;
    const arrival = knots[finalArrivalIdx]!;
    if (prev.planted === arrival.planted) {
      const over = terminalOvershootKnot(prev, arrival);
      if (over) knots.splice(finalArrivalIdx, 0, over);
    }
  }

  return { trajectory: buildPoseTrajectory(knots), settleAtMs };
}

export interface LoopTrajectory {
  /** A PERIODIC trajectory: `totalMs` is one cycle, and sampling wraps
   *  seamlessly (sampleAt(period⁻) flows into sampleAt(0) with matched
   *  velocity). Sample it with `elapsed = rawMs % totalMs`. */
  trajectory: PoseTrajectory;
  /** Phase time (ms) of the LAST keyframe within the cycle — where a first
   *  pass (start → … → last keyframe) leaves the body. The stage enters the
   *  loop clock here so the very first wrap (last → first) is the smooth
   *  cycle transition, not a snap. */
  enterAtMs: number;
}

/**
 * Build a SEAMLESS, velocity-continuous LOOP trajectory over a resolved
 * keyframe cycle — the fix for the looping-motion seam.
 *
 * The open {@link buildComposedTrajectory} is right for a one-shot motion but
 * wrong to loop: it prepends the (often neutral) START pose as knot 0 and marks
 * both ends STOPS, so `rawMs % total` playback snaps the body back through the
 * start pose and stalls to zero velocity once per cycle (a standing "hitch" for
 * gait). This builder instead treats the N keyframe poses as a periodic ring:
 *   • the start/intro pose is NOT part of the cycle (no snap-to-standing);
 *   • the wrap segment last→first is a real fly-through (the authored cycle
 *     transition — e.g. gait terminal-stance → next initial-contact), so the
 *     motion keeps flowing across the seam instead of stopping;
 *   • a keyframe that HOLDS stays a genuine per-cycle pause (a held rep top).
 *
 * Mechanism: lay the N keyframes at phase times within one period (the wrap
 * last→first takes the "into-first" duration), then PAD one wrapped keyframe on
 * each side so the underlying open SQUAD + PCHIP time-warp compute the correct
 * PERIODIC tangents at the seam. Sampling maps `t mod period` into that padded
 * window, so the first and last real anchors carry identical two-sided tangents
 * → C¹ across the wrap. Pure; both stage and (future) sampler can share it.
 */
export function buildLoopTrajectory(
  built: SequenceBuildLike,
  opts: { timeScale: number },
): LoopTrajectory {
  const { timeScale } = opts;
  const n = built.poses.length;
  const ts = Math.min(1.5, Math.max(0.4, timeScale || 1));
  // Per-cycle segment durations (travel INTO each keyframe) and dwells, scaled
  // and floored so the time-warp never divides by zero.
  const dur = built.durationsMs.map((d) => Math.max(1e-3, (d ?? 0) / ts));
  const hold = built.holdsMs.map((h) => Math.min(Math.max(0, (h ?? 0)) / ts, 10_000));

  // Degenerate cycles can't loop meaningfully — a constant pose is the honest
  // answer (the caller only reaches here when resolved.loop is true).
  if (n < 2) {
    const only = built.poses[0];
    const root0 = built.roots[0];
    const flat: PoseTrajectory = {
      totalMs: dur[0] ?? 1,
      sampleAt: () => ({
        pose: only ? clonePose(only) : emptyPose(),
        rootQuat: root0 ? [...root0.quat] : [0, 0, 0, 1],
        rootTranslate: root0 ? [...root0.translateM] : [0, 0, 0],
        planted: root0?.stance === 'planted',
      }),
    };
    return { trajectory: flat, enterAtMs: 0 };
  }

  const knotAt = (i: number, timeMs: number, stop: boolean): TrajectoryKnot => {
    const rs = built.roots[i]!;
    return {
      timeMs,
      pose: built.poses[i]!,
      rootQuat: rs.quat,
      rootTranslate: rs.translateM,
      stop,
      planted: rs.stance === 'planted',
    };
  };

  // Lay the cycle out in phase time, first keyframe at τ=0. A held keyframe adds
  // a second (stop) knot at the end of its dwell. The wrap last→first takes
  // dur[0] (travel into the first keyframe), added after the last keyframe.
  const cycle: TrajectoryKnot[] = [];
  let cursor = 0;
  let enterAtMs = 0;
  for (let i = 0; i < n; i += 1) {
    if (i > 0) cursor += dur[i]!;
    if (i === n - 1) enterAtMs = cursor; // where a first pass leaves the body
    cycle.push(knotAt(i, cursor, hold[i]! > 0));
    if (hold[i]! > 0) {
      cursor += hold[i]!;
      cycle.push(knotAt(i, cursor, true));
    }
  }
  const period = cursor + dur[0]!; // + the wrap segment back into the first knot

  // PERIODIC PADDING: one wrapped keyframe on each side seeds the correct
  // two-sided tangents at the seam. Left = the last keyframe placed dur[0]
  // before τ=0; right = the first keyframe placed at τ=period (closing the wrap
  // segment) plus the second keyframe one step further for the first knot's
  // right neighbour.
  const lastIdx = n - 1;
  const leftPad = knotAt(lastIdx, -dur[0]!, hold[lastIdx]! > 0);
  const closeFirst = knotAt(0, period, hold[0]! > 0);
  const rightPad = knotAt(1 % n, period + dur[1 % n]!, hold[1 % n]! > 0);
  const padded = [leftPad, ...cycle, closeFirst, rightPad];

  const inner = buildPoseTrajectory(padded);
  const wrap = (t: number): number => ((t % period) + period) % period;
  return {
    trajectory: {
      totalMs: period,
      sampleAt: (tMs: number) => inner.sampleAt(wrap(tMs)),
    },
    enterAtMs,
  };
}

function clonePose(p: CustomPose): CustomPose {
  const bones: Record<string, [number, number, number, number]> = {};
  for (const [k, v] of Object.entries(p.bones ?? {})) bones[k] = [v[0], v[1], v[2], v[3]];
  return { variant: p.variant, bones, schemaVersion: POSE_SCHEMA_VERSION };
}
function emptyPose(): CustomPose {
  return { variant: 'male', bones: {}, schemaVersion: POSE_SCHEMA_VERSION };
}
