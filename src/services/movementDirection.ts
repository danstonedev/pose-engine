/**
 * Deterministic movement-direction validator (simMOVE Phase 0 — the
 * belt-and-suspenders catch for travel reversals).
 *
 * The semantic vocabulary in {@link ./motionSequence} stops the model from ever
 * AUTHORING a raw axis sign — but a plan can still be built the old raw-root
 * way, and a raw `root.translateM` can still be reversed by hand. This module
 * is the independent VERIFIER: given what the body actually did (a kinematic
 * export from `exportKinematics`, or a sampled recording from
 * `sampleComposedMotion`) PLUS the intended semantic direction(s), it measures
 * the NET root travel + ending orientation and checks the SIGN against intent.
 * When the raw path went backward it hands back the corrected translate — the
 * auto-flip a host can apply to un-reverse the plan.
 *
 * It reuses the ONE sign table the resolver applies
 * ({@link TRAVEL_DIRECTION_AXIS} / {@link postureRootOrient}), so intent,
 * mapping, and check can never drift apart. Pure + allocation-light (module
 * scratch quaternion/euler, no per-call THREE churn) and free of Svelte/DOM, so
 * hosts and the headless battery run the identical code.
 */
import * as THREE from 'three';
import {
  TRAVEL_DIRECTION_AXIS,
  postureRootOrient,
  type SemanticPosture,
  type TravelDirection,
} from './motionSequence';

// ── Evidence shapes (structural — declared locally so this stays dependency-
//    light; a real KinematicExport / MotionRecording satisfies them verbatim) ──

/** Minimal view of a `KinematicExport` (from `exportKinematics`). */
export interface KinematicExportEvidence {
  /** Whole-body model-root translation [x,y,z] meters, per frame. */
  rootTranslateM: [number, number, number][];
  summary?: {
    root?: {
      /** Sparse orientation timeline; the last key point is the ending pose. */
      orientationKeyPoints?: { tMs: number; orientQuat: [number, number, number, number] }[];
    };
  };
}

/** Minimal view of a `MotionRecording` (from `sampleComposedMotion`). */
export interface MotionRecordingEvidence {
  frames: {
    root: {
      translateM: [number, number, number];
      orientQuat?: [number, number, number, number];
    };
  }[];
}

/** Escape hatch: a caller that already measured net root travel (last − first)
 *  and, optionally, the ending world orientation quaternion. */
export interface NetRootEvidence {
  netRootTranslateM: [number, number, number];
  endOrientQuat?: [number, number, number, number];
}

/** Anything the validator can measure travel/orientation from. */
export type MovementDirectionEvidence =
  | KinematicExportEvidence
  | MotionRecordingEvidence
  | NetRootEvidence;

// ── Intent / result ──────────────────────────────────────────────────────────

/** What the plan MEANT to do, in the semantic vocabulary. */
export interface DirectionIntent {
  /** Intended travel direction(s): a single 'forward', or several for a
   *  combined move (e.g. ['forward','up'] for a step-up). */
  travel?: TravelDirection | readonly TravelDirection[];
  /** Intended ending whole-body posture (orientation check). */
  posture?: SemanticPosture;
  /** The RAW translate the plan authored (when it used the raw-root path rather
   *  than the semantic sugar). Supplied so a detected reversal returns a
   *  concrete corrected vector — the auto-flip — instead of only a verdict. */
  authoredTranslateM?: [number, number, number];
}

export type TravelStatus = 'ok' | 'reversed' | 'insufficient';

/** Per intended-direction verdict against measured net travel. */
export interface TravelAxisFinding {
  direction: TravelDirection;
  axis: 'x' | 'y' | 'z';
  expectedSign: 1 | -1;
  /** Signed measured displacement along `axis`, meters. */
  measuredMeters: number;
  measuredSign: 1 | 0 | -1;
  /** 'ok' = right way + enough travel; 'reversed' = went the OPPOSITE way;
   *  'insufficient' = barely moved (|travel| below the threshold), unverifiable. */
  status: TravelStatus;
}

/** Ending-orientation verdict against an intended posture. */
export interface PostureOrientFinding {
  posture: SemanticPosture;
  expected: { pitchDeg: number; rollDeg: number };
  measured: { pitchDeg: number; rollDeg: number };
  status: 'ok' | 'wrong' | 'unverifiable';
}

export interface MovementDirectionResult {
  /** True when every checked travel axis is 'ok' and any posture check is 'ok'
   *  (checks with no evidence to verify against do not fail the result). */
  ok: boolean;
  /** True when at least one travel axis came back 'reversed' — the reversal the
   *  whole layer exists to catch. */
  reversed: boolean;
  travel: TravelAxisFinding[];
  posture?: PostureOrientFinding;
  /** Present ONLY when a reversal was detected: the corrected translateM — the
   *  authored raw translate (or, absent that, the measured net travel) with the
   *  reversed axes' signs flipped. The raw-root auto-flip a host can apply. */
  suggestedTranslateM?: [number, number, number];
  /** Human-readable one-liner (host logs / narration). */
  message: string;
}

export interface MovementDirectionOptions {
  /** Minimum |displacement| (m) an intended axis must show to count as real
   *  motion; below it the axis is 'insufficient' (not confidently reversed).
   *  Default 0.02 m. */
  minMeters?: number;
  /** Tolerance (deg) for a posture pitch/roll match. Default 25°. */
  postureToleranceDeg?: number;
}

// ── Evidence normalization ───────────────────────────────────────────────────

interface NormalizedEvidence {
  netTranslate: [number, number, number];
  endOrientQuat?: [number, number, number, number];
}

function sub3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Reduce any evidence shape to net root travel (+ optional ending orient).
 *  Returns null when there is nothing to measure (empty frames / series). */
function normalizeEvidence(ev: MovementDirectionEvidence): NormalizedEvidence | null {
  if ('netRootTranslateM' in ev) {
    return {
      netTranslate: [...ev.netRootTranslateM],
      ...(ev.endOrientQuat ? { endOrientQuat: ev.endOrientQuat } : {}),
    };
  }
  if ('frames' in ev) {
    const frames = ev.frames;
    if (!frames || frames.length === 0) return null;
    const first = frames[0]!.root.translateM;
    const last = frames[frames.length - 1]!.root.translateM;
    const endQuat = frames[frames.length - 1]!.root.orientQuat;
    return {
      netTranslate: sub3(last, first),
      ...(endQuat ? { endOrientQuat: endQuat } : {}),
    };
  }
  if ('rootTranslateM' in ev) {
    const r = ev.rootTranslateM;
    if (!r || r.length === 0) return null;
    const kps = ev.summary?.root?.orientationKeyPoints;
    const endQuat = kps && kps.length ? kps[kps.length - 1]!.orientQuat : undefined;
    return {
      netTranslate: sub3(r[r.length - 1]!, r[0]!),
      ...(endQuat ? { endOrientQuat: endQuat } : {}),
    };
  }
  return null;
}

/** Measure net root travel (last − first) from any evidence shape, or null when
 *  there is nothing to measure. Exported as a small reusable pure helper. */
export function measureNetRootTravel(
  ev: MovementDirectionEvidence,
): [number, number, number] | null {
  const n = normalizeEvidence(ev);
  return n ? n.netTranslate : null;
}

// ── Direction → axis (single source of truth: the resolver's own table) ──────

function axisOfDirection(dir: TravelDirection): { axis: 'x' | 'y' | 'z'; index: 0 | 1 | 2; sign: 1 | -1 } {
  const a = TRAVEL_DIRECTION_AXIS[dir];
  if (a[0] !== 0) return { axis: 'x', index: 0, sign: a[0] > 0 ? 1 : -1 };
  if (a[1] !== 0) return { axis: 'y', index: 1, sign: a[1] > 0 ? 1 : -1 };
  return { axis: 'z', index: 2, sign: a[2] > 0 ? 1 : -1 };
}

// ── Posture (orientation) decomposition ──────────────────────────────────────

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const DEG = 180 / Math.PI;

/** Decompose a root orientation quaternion (identity = upright) into pitch/roll
 *  degrees under the SAME YXZ order `rootOrientQuat` composes with, so the check
 *  inverts the mapping exactly. */
function pitchRollOf(quat: [number, number, number, number]): { pitchDeg: number; rollDeg: number } {
  _q.set(quat[0], quat[1], quat[2], quat[3]);
  _e.setFromQuaternion(_q, 'YXZ');
  return { pitchDeg: _e.x * DEG, rollDeg: _e.z * DEG };
}

/** Smallest absolute angular difference (deg), wrapping at ±180. */
function angDiffDeg(a: number, b: number): number {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return Math.abs(d);
}

// ── The validator ────────────────────────────────────────────────────────────

/**
 * Verify that a movement's MEASURED net root travel + ending orientation match
 * the intended semantic direction(s). The core anti-reversal check: `travel`
 * intent 'forward' expects a net +Z displacement (the way the body faces); a
 * plan that actually moved −Z comes back `status:'reversed'` and (for the
 * raw-root path) with a `suggestedTranslateM` whose Z sign is flipped.
 *
 * Pure; measures only what the evidence contains. A requested check with no
 * evidence (e.g. posture intent but no orientation timeline) is reported
 * 'unverifiable' and does NOT fail `ok`.
 */
export function validateMovementDirection(
  evidence: MovementDirectionEvidence,
  intent: DirectionIntent,
  opts: MovementDirectionOptions = {},
): MovementDirectionResult {
  const minMeters = opts.minMeters ?? 0.02;
  const postureTol = opts.postureToleranceDeg ?? 25;

  const norm = normalizeEvidence(evidence);
  if (!norm) {
    return { ok: false, reversed: false, travel: [], message: 'no evidence: nothing to measure' };
  }

  const dirs: TravelDirection[] = intent.travel == null
    ? []
    : Array.isArray(intent.travel)
      ? [...intent.travel]
      : [intent.travel as TravelDirection];

  const travel: TravelAxisFinding[] = [];
  let anyReversed = false;
  // Base for the auto-flip: the authored raw translate if given, else the
  // measured net travel (so a reversal always yields a concrete correction).
  const flipBase: [number, number, number] = intent.authoredTranslateM
    ? [...intent.authoredTranslateM]
    : [...norm.netTranslate];
  let flipped = false;

  for (const dir of dirs) {
    const { axis, index, sign } = axisOfDirection(dir);
    const measured = norm.netTranslate[index]!;
    const measuredSign: 1 | 0 | -1 = measured > 1e-9 ? 1 : measured < -1e-9 ? -1 : 0;
    let status: TravelStatus;
    if (Math.abs(measured) < minMeters) {
      status = 'insufficient';
    } else if (measuredSign === sign) {
      status = 'ok';
    } else {
      status = 'reversed';
      anyReversed = true;
      flipBase[index] = -flipBase[index]!; // un-reverse this axis
      flipped = true;
    }
    travel.push({ direction: dir, axis, expectedSign: sign, measuredMeters: measured, measuredSign, status });
  }

  // Posture (orientation) check — only when both intent + evidence exist.
  let posture: PostureOrientFinding | undefined;
  if (intent.posture != null) {
    const expectedOrient = postureRootOrient(intent.posture);
    const expected = { pitchDeg: expectedOrient.pitchDeg ?? 0, rollDeg: expectedOrient.rollDeg ?? 0 };
    if (norm.endOrientQuat) {
      const measured = pitchRollOf(norm.endOrientQuat);
      const ok =
        angDiffDeg(measured.pitchDeg, expected.pitchDeg) <= postureTol &&
        angDiffDeg(measured.rollDeg, expected.rollDeg) <= postureTol;
      posture = { posture: intent.posture, expected, measured, status: ok ? 'ok' : 'wrong' };
    } else {
      posture = { posture: intent.posture, expected, measured: { pitchDeg: NaN, rollDeg: NaN }, status: 'unverifiable' };
    }
  }

  const travelOk = travel.every((t) => t.status === 'ok');
  const postureOk = !posture || posture.status !== 'wrong';
  const ok = travelOk && postureOk;

  const parts: string[] = [];
  for (const t of travel) {
    parts.push(
      t.status === 'ok'
        ? `${t.direction}: ok (${t.measuredMeters.toFixed(3)}m ${t.axis})`
        : t.status === 'reversed'
          ? `${t.direction}: REVERSED (measured ${t.measuredMeters.toFixed(3)}m ${t.axis}, wrong sign)`
          : `${t.direction}: insufficient travel (${t.measuredMeters.toFixed(3)}m ${t.axis})`,
    );
  }
  if (posture) {
    parts.push(
      posture.status === 'ok'
        ? `posture ${posture.posture}: ok`
        : posture.status === 'wrong'
          ? `posture ${posture.posture}: WRONG (pitch ${posture.measured.pitchDeg.toFixed(1)}°, roll ${posture.measured.rollDeg.toFixed(1)}°)`
          : `posture ${posture.posture}: unverifiable (no orientation evidence)`,
    );
  }
  if (parts.length === 0) parts.push('no direction intent supplied');

  return {
    ok,
    reversed: anyReversed,
    travel,
    ...(posture ? { posture } : {}),
    ...(flipped ? { suggestedTranslateM: flipBase } : {}),
    message: parts.join('; '),
  };
}
