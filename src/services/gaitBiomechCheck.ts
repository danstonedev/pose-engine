// Biomech checks for the unified Validity Gate (Workstream A integration).
//
// This is the layer that folds the NORMATIVE-KINEMATICS ground truth
// (services/normativeGait — Winter/Perry/CGA curves, Froude, vertical-CoM band)
// into the animation-plausibility gate (services/validityGate) WITHOUT the gate
// depending on the normative data: the gate exposes a `runBiomechChecks` hook and
// this module implements it. Hosts wire it in with
// `assessValidity(resolved, frames, { runBiomechChecks: runGaitBiomechChecks })`.
//
// SCOPE: gait-shaped motions only. On anything else the checks return [] (the
// normative gait curves are meaningless for a squat/reach/lying motion). Every
// check is `severity: 'warn'` — a motion outside the normative kinematic band is
// a realism finding to surface, not a correctness FAILURE (unlike foot-skate /
// penetration / ROM, which are hard fails). Pure + deterministic.
//
// CHARTER NOTE: these compare authored KINEMATICS to normative kinematics — no
// forces, GRF, or muscle claims (see docs/design-benchmark-redteam.md §4).

import type { ComposedMotion, ResolvedComposedMotion } from './motionSequence';
import { looksLikeGaitPlan } from './gaitEnrichment';
import type { ValidityCheck, GateFrame } from './validityGate';
import {
  jointAngleRmsVsNormative,
  froudeNumber,
  classifyFroude,
  VERTICAL_COM_CM,
  type NormativeSagittalJoint,
  type GaitAngleSample,
} from './normativeGait';

/** Below this net horizontal travel (m) a "gait" is treadmill/in-place — Froude
 *  (which needs real forward speed) is skipped and noted rather than reported ~0. */
const IN_PLACE_TRAVEL_M = 0.3;
/** A gait whose CoM vertical excursion falls outside this band (cm) warns. The
 *  engine authors glide/normal/bounce = 3/5/8 cm on purpose, so the warn band is
 *  wider than the 4–5 cm normal target — it catches a FLOATY (≈0) or ballooned
 *  arc, not a deliberate glide/bounce. */
const VERTICAL_COM_WARN_CM: readonly [number, number] = [2, 9];
/** A joint whose trajectory sits within ±1 SD of the normative curve at fewer
 *  than this fraction of phase points warns (targets #1–#3). */
const WITHIN_BAND_WARN_FRACTION = 0.5;
/** A frame is "travelling" when its horizontal speed clears this fraction of the
 *  clip's peak. Low on purpose: the job is to cut a standing hold (speed ~0), not
 *  to judge which parts of a gait are fast enough. */
const MOVING_FRACTION_OF_PEAK = 0.1;
/** A frame departing the opening pose by more than this (deg, any joint) has left
 *  the ready-settle hold — the same onset bound trimRecordingLoopCycle uses. */
const READY_SETTLE_ONSET_DEG = 6;
/** Shorter apparent heads than this are ordinary first-frame motion, not a hold.
 *  Guards the offline sampler, whose frame 0 IS the motion start. */
const MIN_READY_SETTLE_MS = 100;

/**
 * The distal bone + motion field carrying each sagittal joint's flexion in the
 * sampler's `frame.angles` (see jointAngles.ts), for a given side.
 *
 * THE SIDE IS NOT ARBITRARY, which is what the hardcoded `L_` here used to
 * assume. A normative curve runs initial contact to initial contact OF THE LIMB
 * IT DESCRIBES, so phase 0 belongs to whichever limb opens the cycle; the other
 * limb is half a cycle out of phase and grading it against the same curve reads a
 * correct gait as a broken one. Measured on the shipped walk over its steady
 * cycle: the lead limb scores knee RMS 9.5 deg / 0.57 within-band, the contralateral
 * limb 25.9 deg / 0.14 — same motion, same curve, opposite verdict.
 */
const jointSource = (
  joint: NormativeSagittalJoint,
  side: 'L' | 'R',
): { boneKey: string; motion: string } => {
  const bone = { hipFlexion: 'UpLeg', kneeFlexion: 'Leg', ankleFlexion: 'Foot' }[joint];
  return { boneKey: `${side}_${bone}`, motion: joint };
};

function horizontalDist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);
}

/** Net horizontal body travel (m) first→last. Prefers the `CoM` WORLD track
 *  (always sampled, and it moves with the body including the derived foot-driven
 *  travel); falls back to `Hips` then the authored `root.translateM` (which is
 *  ≈0 net for a foot-driven walk, where travel is emergent, not authored). */
function netTravelM(frames: readonly GateFrame[]): number | null {
  const first = frames[0];
  const last = frames[frames.length - 1];
  const p0 = first?.worldTracks?.CoM ?? first?.worldTracks?.Hips ?? first?.root?.translateM;
  const p1 = last?.worldTracks?.CoM ?? last?.worldTracks?.Hips ?? last?.root?.translateM;
  if (!p0 || !p1) return null;
  return horizontalDist(p0, p1);
}

/** Leg length (m) for Froude = HIP HEIGHT above the ground on the first frame —
 *  the standard characteristic length L in the walking-Froude literature
 *  (v²/(g·L)), and the character's own scale so it normalizes across variants.
 *  The tracked-bone set has no upper-leg bone, so use the pelvis (`Hips`) height
 *  above the floor (given `floorY`, else the lowest sampled foot). */
function legLengthM(frames: readonly GateFrame[], floorY?: number): number | null {
  const t = frames[0]?.worldTracks;
  const hipY = t?.Hips?.[1];
  if (hipY == null) return null;
  let ground = floorY;
  if (ground == null) {
    const feet = [t?.L_Foot?.[1], t?.R_Foot?.[1]].filter((y): y is number => y != null);
    if (feet.length) ground = Math.min(...feet);
  }
  if (ground == null) return null;
  const L = hipY - ground;
  return L > 0.2 ? L : null;
}

/** Peak-to-peak vertical excursion (cm) of the CoM track over the clip. */
function verticalComExcursionCm(frames: readonly GateFrame[]): number | null {
  let min = Infinity;
  let max = -Infinity;
  for (const f of frames) {
    const y = f.worldTracks?.CoM?.[1];
    if (y == null) continue;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return (max - min) * 100;
}

/**
 * The contiguous stretch of frames over which the body is actually translating.
 *
 * Leading and trailing frames whose instantaneous horizontal speed is under a
 * small fraction of the clip's peak are the standing initiation and the settle
 * hold; they carry time but no travel, so leaving them in deflates any speed
 * measured as displacement ÷ duration. Only the HEAD and TAIL are trimmed —
 * within-gait slow frames (double support, a braking step) are part of the gait
 * and stay. Falls back to the full clip whenever trimming would leave too little
 * to measure.
 */
function travellingWindow(frames: readonly GateFrame[]): readonly GateFrame[] {
  if (frames.length < 4) return frames;
  const pos = (f: GateFrame) => f.worldTracks?.CoM ?? f.worldTracks?.Hips ?? f.root?.translateM;
  const speeds: number[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const a = pos(frames[i - 1]!);
    const b = pos(frames[i]!);
    const dt = (frames[i]!.tMs - frames[i - 1]!.tMs) / 1000;
    speeds.push(a && b && dt > 0 ? horizontalDist(a, b) / dt : 0);
  }
  const peak = Math.max(...speeds);
  if (!(peak > 0)) return frames;
  const floor = peak * MOVING_FRACTION_OF_PEAK;
  let lo = 0;
  while (lo < speeds.length && speeds[lo]! < floor) lo += 1;
  let hi = speeds.length - 1;
  while (hi > lo && speeds[hi]! < floor) hi -= 1;
  const out = frames.slice(lo, hi + 2);
  return out.length >= 3 ? out : frames;
}

/** One gait cycle of a joint's flexion as `{phasePct, deg}` from the frames'
 *  measured angles, phase = tMs mapped linearly onto [0,100] over `window`
 *  (the gait cycle), or over the whole clip when no window is given. */
function jointSamples(
  frames: readonly GateFrame[],
  joint: NormativeSagittalJoint,
  window?: { fromMs: number; toMs: number; leadSide: 'L' | 'R' },
): GaitAngleSample[] {
  const src = jointSource(joint, window?.leadSide ?? 'L');
  const span0 = window
    ? frames.filter((f) => f.tMs >= window.fromMs && f.tMs <= window.toMs)
    : frames;
  if (span0.length < 2) return [];
  const t0 = span0[0]!.tMs;
  const span = span0[span0.length - 1]!.tMs - t0;
  if (span <= 0) return [];
  const out: GaitAngleSample[] = [];
  for (const f of span0) {
    const deg = f.angles?.[src.boneKey]?.[src.motion];
    if (typeof deg === 'number' && Number.isFinite(deg)) {
      out.push({ phasePct: ((f.tMs - t0) / span) * 100, deg });
    }
  }
  return out;
}

/** Largest per-joint difference (deg) between two angle sets. */
function maxAngleDepartureDeg(
  a: Record<string, Record<string, number>>,
  b: Record<string, Record<string, number>>,
): number {
  let max = 0;
  for (const [joint, setA] of Object.entries(a)) {
    const setB = b[joint];
    if (!setB) continue;
    for (const [field, va] of Object.entries(setA)) {
      const vb = setB[field];
      if (typeof va === 'number' && typeof vb === 'number') max = Math.max(max, Math.abs(va - vb));
    }
  }
  return max;
}

/**
 * How far into the FRAMES the motion actually starts, ms.
 *
 * `gaitCycleMs` is authored on the RESOLVED clock, where the motion begins at 0.
 * A recording need not share that origin: simMOVE's live playback tap captures a
 * standing ready-settle hold (~950 ms) ahead of the motion, so its frame times run
 * roughly a second later than the resolved ones. Applying the window to those
 * frames without correcting for the head selects the standing hold and the
 * initiation instead of the gait — measured, a 250 ms head alone drops the knee
 * from 0.67 within-band to 0.19 and Froude from 0.213 to 0.058, which is precisely
 * the gap between what the offline suite reported and what the UI card showed.
 *
 * The head is found the way trimRecordingLoopCycle finds it: the first frame that
 * departs the opening pose. Below {@link MIN_READY_SETTLE_MS} the answer is 0, so
 * the offline sampler — whose frame 0 already IS the motion — is untouched.
 */
function readySettleHeadMs(frames: readonly GateFrame[]): number {
  const first = frames[0];
  if (!first?.angles) return 0;
  // The motion starts at the END of the hold, not at the frame that has already
  // moved 6° — returning the departing frame would shift the window late by however
  // long the motion takes to clear the bound, which is a real fraction of a stride.
  let lastStill = first.tMs;
  for (const f of frames) {
    if (!f.angles) continue;
    if (maxAngleDepartureDeg(first.angles, f.angles) > READY_SETTLE_ONSET_DEG) {
      const head = lastStill - first.tMs;
      return head >= MIN_READY_SETTLE_MS ? head : 0;
    }
    lastStill = f.tMs;
  }
  return 0;
}

/**
 * The gait cycle to phase against, from the window the BUILDER published.
 *
 * Not derived here on purpose. A travel clip is initiation → step-off → cycle →
 * braking step → settle, and nothing in the resolved motion distinguishes the
 * contaminated step-off stance from a steady one — every rule tried against the
 * stance schedule picked a window measurably worse than the authored one. The
 * builder assembles the keyframes, so the builder is the only honest source; a
 * motion that publishes none is skipped rather than guessed at.
 */
function gaitCycleWindow(
  resolved: ResolvedComposedMotion,
  frames: readonly GateFrame[],
): { fromMs: number; toMs: number; leadSide: 'L' | 'R' } | null {
  const c = resolved.gaitCycleMs;
  if (!c || !Number.isFinite(c.fromMs) || !Number.isFinite(c.toMs) || c.toMs <= c.fromMs) return null;
  const leadSide: 'L' | 'R' = c.leadFoot.startsWith('R') ? 'R' : 'L';
  const head = readySettleHeadMs(frames);
  const shifted = { fromMs: c.fromMs + head, toMs: c.toMs + head, leadSide };
  // A shifted window running past the end means the head estimate is wrong for
  // this recording; an unshifted window is the safer reading, and the frame-count
  // guards downstream still skip if it selects too little.
  const last = frames[frames.length - 1]?.tMs;
  if (last != null && shifted.toMs > last) {
    return { fromMs: c.fromMs, toMs: c.toMs, leadSide };
  }
  return shifted;
}


/**
 * The biomech half of the Validity Gate — plug into
 * {@link import('./validityGate').assessValidity} as `runBiomechChecks`.
 * Returns normative-kinematics warns for a gait-shaped motion; [] otherwise.
 */
export function runGaitBiomechChecks(
  resolved: ResolvedComposedMotion,
  frames: readonly GateFrame[] | undefined,
  ctx?: { floorY?: number },
): { checks: ValidityCheck[]; skipped: string[] } {
  // Gait-shape guard: only travelling/reciprocal gait gets normative gait norms.
  const isGait =
    resolved.footDrivenTravel === true ||
    looksLikeGaitPlan(resolved as unknown as ComposedMotion);
  if (!isGait || !frames || frames.length < 3) return { checks: [], skipped: [] };

  const checks: ValidityCheck[] = [];
  const skipped: string[] = [];
  let froudeFr: number | null = null;
  // DECLARED, not inferred. Classifying by the MEASURED Froude would excuse the
  // very motion the walk check exists to catch: a walk fast enough to be a run
  // would be relabelled a run and then pass.
  const declaredRegime = resolved.gaitRegime ?? 'walk';

  // ── Froude number (target #10) — dimensionless comfortable-walk speed ────────
  // Skipped for in-place / treadmill gait (net travel < IN_PLACE_TRAVEL_M):
  // Froude needs real forward speed, and reporting ~0 would be misleading.
  // MEASURE WHILE TRAVELLING. Froude is v²/(g·L), and v has to be the gait's
  // speed — but a travel clip opens with a standing initiation and closes with a
  // settle HOLD, both of which contribute duration and no displacement. Dividing
  // net travel by the WHOLE clip duration therefore reports a speed the body never
  // had: on the shipped walk that is 0.56 m/s against an actual 1.48 m/s, so a
  // comfortable walk (Fr 0.21) was being reported as Fr 0.03 and classified
  // 'slow'. The check still passed — it only asks "is this secretly a run?" — so
  // nothing surfaced it. Trimming the stationary head and tail is generic: it
  // needs no keyframe semantics, and for a clip that travels throughout it is a
  // no-op.
  // Prefer the builder-published gait cycle: it is exactly one cycle of steady
  // gait, so displacement ÷ duration over it IS the gait's speed. Without one,
  // fall back to trimming the stationary head and tail.
  const cycle = gaitCycleWindow(resolved, frames);
  const moving = cycle
    ? (() => {
        const w = frames.filter((f) => f.tMs >= cycle.fromMs && f.tMs <= cycle.toMs);
        return w.length >= 3 ? w : travellingWindow(frames);
      })()
    : travellingWindow(frames);
  const travel = netTravelM(moving);
  const durS = (moving[moving.length - 1]!.tMs - moving[0]!.tMs) / 1000;
  const leg = legLengthM(frames, ctx?.floorY);
  if (travel != null && travel >= IN_PLACE_TRAVEL_M && durS > 0 && leg != null) {
    const speed = travel / durS;
    const fr = froudeNumber(speed, leg);
    froudeFr = fr;
    const regime = classifyFroude(fr);
    const inRunRegime = regime === 'run-regime';
    // REGIME-AWARE VERDICT. Asking "is this secretly a run?" is the right question
    // of a WALK and the wrong question of a run — a declared run scoring Fr 1.4 is
    // a correct run, and failing it for that is failing a motion for being what it
    // says it is. A declared run instead has to CLEAR the transition band.
    const pass = declaredRegime === 'run' ? inRunRegime : !inRunRegime;
    checks.push({
      id: 'froude',
      pass,
      severity: 'warn',
      measured: Number(fr.toFixed(3)),
      threshold: 0.5,
      unit: 'Fr',
      note:
        declaredRegime === 'run'
          ? `Froude ${fr.toFixed(2)} (${regime}); a run should clear the walk→run transition ≈ 0.5${inRunRegime ? '' : ' — this "run" is still in the walking regime'}`
          : `Froude ${fr.toFixed(2)} (${regime}); comfortable walk ≈ 0.25, walk→run ≈ 0.5${inRunRegime ? ' — this "walk" is in the run regime' : ''}`,
    });
  }

  // ── Vertical CoM excursion (target #6) — floaty/ballooned catch ──────────────
  const comCm = verticalComExcursionCm(frames);
  if (comCm != null) {
    const [lo, hi] = VERTICAL_COM_WARN_CM;
    const ok = comCm >= lo && comCm <= hi;
    checks.push({
      id: 'vertical-com',
      pass: ok,
      severity: 'warn',
      measured: Number(comCm.toFixed(2)),
      threshold: hi,
      unit: 'cm',
      note: `CoM vertical excursion ${comCm.toFixed(1)} cm (normal ${VERTICAL_COM_CM[0]}–${VERTICAL_COM_CM[1]} cm; glide/bounce widen the accepted band to ${lo}–${hi})`,
    });
  }

  // ── Joint-angle RMS vs normative ±1 SD (targets #1–#3) ───────────────────────
  //
  // TWO PRECONDITIONS, both of which this check used to ignore, and both of which
  // made it report a confident number for a comparison that was not valid.
  //
  //  1. THE CURVES ARE WALKING CURVES. normativeGait bundles Winter/Perry/CGA
  //     SAGITTAL WALKING data. Running kinematics genuinely differ — swing-phase
  //     knee flexion roughly doubles — so grading a run against them measures the
  //     walk/run difference, not the run's quality. Measured on the rig, the
  //     shipped run scores RMS 35-52° against these curves at EVERY cycle window
  //     tried; that is the curves being wrong for the motion, not the motion being
  //     wrong. Same mistake as grading a run's Froude against walking norms.
  //  2. PHASE 0-100% MUST BE ONE GAIT CYCLE. `jointSamples` maps the WHOLE CLIP
  //     onto 0-100%. A travel clip is initiation → step-off → cycle → braking step
  //     → settle, so on the shipped walk the actual gait cycle occupies only ~36%
  //     of the phase axis and the rest is entry and exit. The normative curve is
  //     defined initial-contact to initial-contact of ONE limb, so that comparison
  //     comes out meaningless: the walk measures 0.19 within-band phased over the
  //     clip against 0.57 phased over its steady cycle — a false warn either way,
  //     because nothing in the number reflects the gait.
  //
  // Reporting SKIPPED rather than a warn is the honest outcome, and it follows the
  // rule the geometric checks already use: a check that cannot see what it claims
  // to measure must say so instead of emitting a verdict. What would make this
  // measurable is a gait-cycle window published by the builders (they author the
  // keyframes, so they know it) — until that exists, this stays silent rather than
  // wrong.
  const cycleSpan = cycle;
  if (!frames.some((f) => f.angles)) {
    skipped.push('normative joint curves — no measured joint angles in the frames');
  } else if (declaredRegime === 'run') {
    skipped.push(
      'normative joint curves — the bundled curves are WALKING norms and this motion declares the run regime',
    );
  } else if (!cycleSpan) {
    skipped.push(
      'normative joint curves — the motion publishes no gaitCycleMs window, and phasing a ' +
        'whole multi-phase clip onto the normative 0-100% axis compares misaligned curves',
    );
  } else {
    for (const joint of ['kneeFlexion', 'hipFlexion', 'ankleFlexion'] as NormativeSagittalJoint[]) {
      const samples = jointSamples(frames, joint, cycleSpan);
      if (samples.length < 3) continue;
      const r = jointAngleRmsVsNormative(samples, joint);
      checks.push({
        id: `normative-${joint}`,
        pass: r.withinBandFraction >= WITHIN_BAND_WARN_FRACTION,
        severity: 'warn',
        measured: Number(r.withinBandFraction.toFixed(2)),
        threshold: WITHIN_BAND_WARN_FRACTION,
        unit: 'within±1SD',
        note: `${joint}: ${(r.withinBandFraction * 100).toFixed(0)}% of cycle within ±1 SD of normal (RMS ${r.rmsDeg.toFixed(1)}°, worst ${r.worstDevDeg.toFixed(0)}° at ${r.worstPhasePct.toFixed(0)}%)`,
      });
    }
  }

  return { checks, skipped };
}
