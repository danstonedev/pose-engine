/**
 * KINEMATIC SIGNATURES + a deterministic movement scorer (simMOVE Phase 1) —
 * the lightweight, LLM-free half of the closed-loop critic.
 *
 * WHY. Phase 0 stopped whole-body TRAVEL from reversing. But "is this generated
 * movement actually the movement we asked for?" is a broader question: does each
 * joint move in the right DIRECTION, to a plausible AMPLITUDE, in the right
 * ORDER relative to the other joints? The engine already records everything
 * needed to answer that — {@link exportKinematics} gives per-joint angle series,
 * angular velocities, world trajectories, and root travel. This module distills
 * a recording into a compact SIGNATURE (the fingerprint that makes a movement
 * recognizable) and scores a candidate recording against a reference signature.
 *
 * It is pure arithmetic over the KinematicExport (no THREE, no rig, no LLM), so
 * it runs in well under a millisecond and is fully deterministic — exactly the
 * "streamlined light interpreter" the workstream is after. The intended loop:
 *   generate -> sampleComposedMotion (deterministic) -> exportKinematics ->
 *   scoreAgainstSignature(export, reference) -> accept, or reject + regenerate.
 *
 * A signature deliberately captures DIRECTION and SHAPE, not exact numbers:
 *   • per primary joint: signed PEAK + TROUGH (catches a flexion↔extension flip
 *     on a one-way motion), EXCURSION amplitude, and the normalized time of the
 *     peak and trough (catches a bidirectional flip — e.g. rotate-right-first
 *     instead of rotate-left-first — and cross-joint coordination scrambles);
 *   • net root TRAVEL direction (sign per world axis; +Z = forward, Phase 0);
 *   • which joints are PRIMARY (meaningful excursion) vs incidental coupling.
 */

/** The minimal shape of {@link exportKinematics}' result this module consumes —
 *  declared structurally so the scorer stays decoupled from motionRecording. */
export interface SignatureSourceExport {
  timesMs: number[];
  /** Angle-vs-time per 'joint.motion' (degrees, engine sign convention). */
  series: Record<string, number[]>;
  /** Whole-body model-root translation [x,y,z] meters per frame. */
  rootTranslateM: [number, number, number][];
  meta?: { durationMs?: number; name?: string };
}

/** One joint.motion's direction+shape fingerprint over the whole motion. */
export interface JointSignature {
  /** 'joint.motion', e.g. 'Neck.rotation'. */
  key: string;
  /** Max angle reached (signed, engine convention). */
  peakDeg: number;
  /** Min angle reached (signed). */
  minDeg: number;
  /** peakDeg − minDeg — how much this joint swept. */
  excursionDeg: number;
  /** Time of the peak (max) as a fraction of total duration, 0..1. */
  normPeakTime: number;
  /** Time of the trough (min) as a fraction of total duration, 0..1. */
  normTroughTime: number;
  /** Sign of the DOMINANT excursion (the larger-magnitude of peak/trough): +1
   *  when the joint mostly moves the positive way (e.g. flexion), −1 the
   *  negative way (extension). This is the primary reversal signal for a one-way
   *  motion; a bidirectional flip (same magnitudes, swapped order) is instead
   *  caught by normPeakTime/normTroughTime. */
  dominantSign: number;
}

/** A movement's compact, direction-aware fingerprint. */
export interface KinematicSignature {
  name?: string;
  durationMs: number;
  /** Primary joints (excursion ≥ the build threshold), sorted by key. */
  primary: JointSignature[];
  /** Sign per world axis of net root travel: −1 / 0 / +1 (0 = within the
   *  dead-zone). +Z is the body's physical forward facing (Phase 0). */
  travelSign: [number, number, number];
  /** Net root travel magnitude per axis (meters, signed) — kept for tolerance
   *  checks; the sign is what {@link travelSign} exposes. */
  netTravelM: [number, number, number];
}

export interface BuildSignatureOptions {
  /** A joint is PRIMARY when its excursion ≥ this (deg). Default 8° — below it
   *  is coupling/measurement noise, not a commanded motion. */
  primaryExcursionDeg?: number;
  /** Net |axis travel| below this (m) counts as no travel (sign 0). Default 0.05. */
  travelDeadzoneM?: number;
  /**
   * DRIVER allowlist of exact 'joint.motion' keys. When given, ONLY these keys
   * can be primary — the fingerprint is the joints the PLAN actually commands,
   * not every joint the readout shows moving. This is essential because some
   * readouts couple: the world-frame shoulder readout reports a phantom
   * "shoulder flexion/abduction" when the TRUNK flexes (the hanging arm's world
   * direction tilts), and its two in-plane fields cross-contaminate past
   * horizontal. Fingerprinting the drivers (e.g. Spine_Lower.flexion for a
   * lumbar screen) yields a faithful signature and a robust round-trip. Derive
   * the set from the motion plan with {@link driverKeysOf}.
   */
  joints?: readonly string[];
}

/** Structural shape of a composed motion for {@link driverKeysOf} (kept
 *  structural so this module never imports motionSequence). */
export interface DriverKeySource {
  keyframes: { targets?: { joint: string; motion: string }[] }[];
}

/** The set of 'joint.motion' keys a motion plan actually COMMANDS, sorted — the
 *  natural DRIVER allowlist for {@link buildSignatureFromExport}. */
export function driverKeysOf(motion: DriverKeySource): string[] {
  const set = new Set<string>();
  for (const kf of motion.keyframes ?? []) {
    for (const t of kf.targets ?? []) set.add(`${t.joint}.${t.motion}`);
  }
  return [...set].sort();
}

const DEFAULT_PRIMARY_EXCURSION_DEG = 8;
const DEFAULT_TRAVEL_DEADZONE_M = 0.05;

function extremaOf(values: number[], timesMs: number[], durationMs: number) {
  let peak = -Infinity;
  let min = Infinity;
  let tPeak = 0;
  let tMin = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    if (v > peak) {
      peak = v;
      tPeak = timesMs[i] ?? 0;
    }
    if (v < min) {
      min = v;
      tMin = timesMs[i] ?? 0;
    }
  }
  if (!Number.isFinite(peak)) {
    peak = 0;
    min = 0;
  }
  const dur = durationMs > 0 ? durationMs : 1;
  const dominant = Math.abs(peak) >= Math.abs(min) ? peak : min;
  return {
    peakDeg: peak,
    minDeg: min,
    excursionDeg: peak - min,
    normPeakTime: clamp01(tPeak / dur),
    normTroughTime: clamp01(tMin / dur),
    dominantSign: Math.sign(dominant) || 1,
  };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const signWithDeadzone = (x: number, dz: number): number => (x > dz ? 1 : x < -dz ? -1 : 0);

/**
 * Distill a {@link KinematicSignature} from a kinematic export. Rig-derived
 * (the export comes from sampling a motion on the real skeleton), never
 * hand-typed. Pure + deterministic.
 */
export function buildSignatureFromExport(
  ex: SignatureSourceExport,
  opts: BuildSignatureOptions = {},
): KinematicSignature {
  const primaryThresh = opts.primaryExcursionDeg ?? DEFAULT_PRIMARY_EXCURSION_DEG;
  const dz = opts.travelDeadzoneM ?? DEFAULT_TRAVEL_DEADZONE_M;
  const durationMs =
    ex.meta?.durationMs ?? (ex.timesMs.length ? ex.timesMs[ex.timesMs.length - 1]! : 0);

  const allow = opts.joints ? new Set(opts.joints) : null;
  const primary: JointSignature[] = [];
  for (const key of Object.keys(ex.series)) {
    if (allow && !allow.has(key)) continue; // driver allowlist: skip non-commanded joints
    const e = extremaOf(ex.series[key]!, ex.timesMs, durationMs);
    if (e.excursionDeg >= primaryThresh) primary.push({ key, ...e });
  }
  primary.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const n = ex.rootTranslateM.length;
  const first = n ? ex.rootTranslateM[0]! : [0, 0, 0];
  const last = n ? ex.rootTranslateM[n - 1]! : [0, 0, 0];
  const net: [number, number, number] = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];

  return {
    ...(ex.meta?.name ? { name: ex.meta.name } : {}),
    durationMs,
    primary,
    netTravelM: net,
    travelSign: [signWithDeadzone(net[0], dz), signWithDeadzone(net[1], dz), signWithDeadzone(net[2], dz)],
  };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface ScoreTolerances {
  /** A joint's excursion may differ from the reference by up to
   *  max(amplitudeAbsDeg, amplitudeRel · ref excursion). */
  amplitudeAbsDeg?: number;
  amplitudeRel?: number;
  /** A signed peak/trough only counts for the SIGN check when its magnitude
   *  exceeds this (deg) — below it the direction is not meaningfully defined. */
  signMagnitudeDeg?: number;
  /** A joint's normalized peak/trough time may differ from the reference by up
   *  to this fraction of the motion (catches order scrambles without being
   *  brittle to small tempo jitter). */
  peakTimeTol?: number;
}

const DEFAULT_TOLERANCES: Required<ScoreTolerances> = {
  amplitudeAbsDeg: 10,
  amplitudeRel: 0.3,
  signMagnitudeDeg: 6,
  peakTimeTol: 0.2,
};

export type JointTermStatus = 'ok' | 'missing' | 'sign-flipped' | 'amplitude-off' | 'timing-off';

export interface JointTermResult {
  key: string;
  status: JointTermStatus;
  /** True when this joint's every checked term passed. */
  ok: boolean;
  refExcursionDeg: number;
  candExcursionDeg: number;
  detail: string;
}

export interface DirectionTermResult {
  axis: 'x' | 'y' | 'z';
  ok: boolean;
  refSign: number;
  candSign: number;
}

export interface SignatureScore {
  /** Overall accept/reject. Reject when ANY reference primary joint is missing,
   *  sign-flipped, or grossly off in amplitude/timing, or root travel reversed. */
  accepted: boolean;
  /** 0..1 fraction of all checked terms that passed (joints × their terms + travel axes). */
  score: number;
  joints: JointTermResult[];
  travel: DirectionTermResult[];
  /** Human-readable one-liners for the first failing terms (for narration). */
  reasons: string[];
}

/**
 * Score a candidate export against a reference {@link KinematicSignature}.
 * Deterministic and allocation-light. Rejection is DELIBERATELY sensitive to
 * the three ways a movement goes wrong:
 *   1. a joint moving the WRONG WAY (sign-flip) — the reversal, per-joint;
 *   2. a joint with grossly wrong AMPLITUDE;
 *   3. joints peaking in the wrong ORDER (timing / coordination scramble).
 * Small within-tolerance tempo/amplitude jitter is accepted so the scorer is
 * not brittle against a faithful-but-not-identical reproduction.
 *
 * SCOPE (by design): scoring is judged over the REFERENCE's primary (driver)
 * joints + root travel only. Two consequences to be aware of:
 *   • It answers "did the commanded joints do the right thing?", NOT "…and
 *     nothing else moved" — extra motion in a NON-driver joint is invisible
 *     (red-team L2). Cross-motion cleanliness is a separate check if needed.
 *   • Direction/amplitude are judged on signed EXCURSION + dominant sign, not
 *     absolute offset, so a pure DC-offset of an otherwise-identical curve is
 *     not penalized (red-team L3). Unreachable from neutral-start templates.
 */
export function scoreAgainstSignature(
  candidate: SignatureSourceExport,
  reference: KinematicSignature,
  tolerances: ScoreTolerances = {},
  buildOpts: BuildSignatureOptions = {},
): SignatureScore {
  const tol = { ...DEFAULT_TOLERANCES, ...tolerances };

  // VACUITY GUARD (red-team M1): a reference with no primary joints AND no net
  // travel has nothing to check — scoring would otherwise return accepted:true
  // for ANY candidate (an accept-all footgun, e.g. a driver allowlist whose keys
  // matched no series key, or a movement whose joints all fell below threshold).
  // Refuse to validate against it instead of silently passing everything.
  if (reference.primary.length === 0 && reference.travelSign.every((s) => s === 0)) {
    return {
      accepted: false,
      score: 0,
      joints: [],
      travel: [],
      reasons: ['vacuous reference signature: no primary joints and no net travel — nothing to validate against'],
    };
  }

  const cand = buildSignatureFromExport(candidate, buildOpts);
  const candByKey = new Map(cand.primary.map((j) => [j.key, j]));

  const joints: JointTermResult[] = [];
  const reasons: string[] = [];
  let passedTerms = 0;
  let totalTerms = 0;

  for (const ref of reference.primary) {
    const c = candByKey.get(ref.key);
    // 3 terms per joint: sign, amplitude, timing.
    totalTerms += 3;
    if (!c) {
      joints.push({
        key: ref.key,
        status: 'missing',
        ok: false,
        refExcursionDeg: ref.excursionDeg,
        candExcursionDeg: 0,
        detail: `expected ${ref.key} to move (~${ref.excursionDeg.toFixed(0)}° excursion) but it was not primary in the candidate`,
      });
      reasons.push(`${ref.key}: missing`);
      continue;
    }

    // (1) SIGN — the DOMINANT excursion must point the same way as the
    // reference: a one-way flexion→extension flip inverts dominantSign and is
    // rejected here. The check is meaningful ONLY for a clearly one-directional
    // motion; a (near-)symmetric BIDIRECTIONAL motion (e.g. cervical rotation
    // ±70°) has no single direction — its dominantSign is decided by sub-degree
    // noise — so the sign term is skipped and its reversal (rotate the other way
    // first) is instead caught by TIMING below. Also skipped when the excursion
    // is too small to define any direction.
    const domMag = Math.max(Math.abs(ref.peakDeg), Math.abs(ref.minDeg));
    const subMag = Math.min(Math.abs(ref.peakDeg), Math.abs(ref.minDeg));
    const refBidirectional = subMag > tol.signMagnitudeDeg && subMag > 0.5 * domMag;
    let signOk: boolean;
    if (ref.excursionDeg <= tol.signMagnitudeDeg) {
      signOk = true; // too small to define a direction
    } else if (refBidirectional) {
      // Symmetric there-and-back (e.g. cervical rotation ±70°): no single dominant
      // direction, so compare the peak↔trough ORDER (rotate-the-other-way-first
      // reverses it). Order is robust even when the two extrema sit close together
      // in normalized time — a case where the timing terms alone could pass a
      // reversal (red-team L1).
      const refOrder = Math.sign(ref.normPeakTime - ref.normTroughTime);
      const candOrder = Math.sign(c.normPeakTime - c.normTroughTime);
      signOk = refOrder === 0 || candOrder === refOrder;
    } else {
      signOk = c.dominantSign === ref.dominantSign;
    }

    // (2) AMPLITUDE — excursion within tolerance.
    const ampBudget = Math.max(tol.amplitudeAbsDeg, tol.amplitudeRel * Math.abs(ref.excursionDeg));
    const ampOk = Math.abs(c.excursionDeg - ref.excursionDeg) <= ampBudget;

    // (3) TIMING — the peak AND trough must land near the reference's normalized
    // time (catches order scrambles). Only meaningful for the extremum that
    // actually carries motion (skip a ~0 side).
    const peakTimeOk =
      Math.abs(ref.peakDeg) <= tol.signMagnitudeDeg ||
      Math.abs(c.normPeakTime - ref.normPeakTime) <= tol.peakTimeTol;
    const troughTimeOk =
      Math.abs(ref.minDeg) <= tol.signMagnitudeDeg ||
      Math.abs(c.normTroughTime - ref.normTroughTime) <= tol.peakTimeTol;
    const timingOk = peakTimeOk && troughTimeOk;

    if (signOk) passedTerms += 1;
    if (ampOk) passedTerms += 1;
    if (timingOk) passedTerms += 1;

    const status: JointTermStatus = !signOk
      ? 'sign-flipped'
      : !ampOk
        ? 'amplitude-off'
        : !timingOk
          ? 'timing-off'
          : 'ok';
    const ok = signOk && ampOk && timingOk;
    if (!ok) {
      reasons.push(
        `${ref.key}: ${status} (ref peak ${ref.peakDeg.toFixed(0)}°/${(ref.normPeakTime * 100).toFixed(0)}%, ` +
          `cand peak ${c.peakDeg.toFixed(0)}°/${(c.normPeakTime * 100).toFixed(0)}%, exc ${ref.excursionDeg.toFixed(0)}→${c.excursionDeg.toFixed(0)}°)`,
      );
    }
    joints.push({
      key: ref.key,
      status,
      ok,
      refExcursionDeg: ref.excursionDeg,
      candExcursionDeg: c.excursionDeg,
      detail: status,
    });
  }

  // Root travel direction: each axis' sign must match (0 matches 0).
  const travel: DirectionTermResult[] = (['x', 'y', 'z'] as const).map((axis, i) => {
    totalTerms += 1;
    const refSign = reference.travelSign[i]!;
    const candSign = cand.travelSign[i]!;
    const ok = refSign === candSign;
    if (ok) passedTerms += 1;
    else reasons.push(`travel.${axis}: reference sign ${refSign} but candidate ${candSign}`);
    return { axis, ok, refSign, candSign };
  });

  const hardFail =
    joints.some((j) => j.status === 'missing' || j.status === 'sign-flipped') ||
    travel.some((t) => !t.ok) ||
    joints.some((j) => !j.ok); // amplitude/timing gross-miss also rejects

  return {
    accepted: !hardFail,
    score: totalTerms > 0 ? passedTerms / totalTerms : 1,
    joints,
    travel,
    reasons,
  };
}
