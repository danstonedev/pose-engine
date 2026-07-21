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

/** The distal bone key + motion field carrying each sagittal joint's flexion in
 *  the sampler's `frame.angles` (see jointAngles.ts). Left side is representative
 *  for a symmetric gait; a future per-side pass can grade both. */
const JOINT_SOURCE: Record<NormativeSagittalJoint, { boneKey: string; motion: string }> = {
  hipFlexion: { boneKey: 'L_UpLeg', motion: 'hipFlexion' },
  kneeFlexion: { boneKey: 'L_Leg', motion: 'kneeFlexion' },
  ankleFlexion: { boneKey: 'L_Foot', motion: 'ankleFlexion' },
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

/** One gait cycle of a joint's flexion as `{phasePct, deg}` from the frames'
 *  measured angles, phase = tMs mapped linearly onto [0,100] over the clip. */
function jointSamples(
  frames: readonly GateFrame[],
  joint: NormativeSagittalJoint,
): GaitAngleSample[] {
  const src = JOINT_SOURCE[joint];
  const t0 = frames[0]!.tMs;
  const span = frames[frames.length - 1]!.tMs - t0;
  if (span <= 0) return [];
  const out: GaitAngleSample[] = [];
  for (const f of frames) {
    const deg = f.angles?.[src.boneKey]?.[src.motion];
    if (typeof deg === 'number' && Number.isFinite(deg)) {
      out.push({ phasePct: ((f.tMs - t0) / span) * 100, deg });
    }
  }
  return out;
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
): ValidityCheck[] {
  // Gait-shape guard: only travelling/reciprocal gait gets normative gait norms.
  const isGait =
    resolved.footDrivenTravel === true ||
    looksLikeGaitPlan(resolved as unknown as ComposedMotion);
  if (!isGait || !frames || frames.length < 3) return [];

  const checks: ValidityCheck[] = [];

  // ── Froude number (target #10) — dimensionless comfortable-walk speed ────────
  // Skipped for in-place / treadmill gait (net travel < IN_PLACE_TRAVEL_M):
  // Froude needs real forward speed, and reporting ~0 would be misleading.
  const travel = netTravelM(frames);
  const durS = (frames[frames.length - 1]!.tMs - frames[0]!.tMs) / 1000;
  const leg = legLengthM(frames, ctx?.floorY);
  if (travel != null && travel >= IN_PLACE_TRAVEL_M && durS > 0 && leg != null) {
    const speed = travel / durS;
    const fr = froudeNumber(speed, leg);
    const regime = classifyFroude(fr);
    const runRegime = regime === 'run-regime';
    checks.push({
      id: 'froude',
      pass: !runRegime,
      severity: 'warn',
      measured: Number(fr.toFixed(3)),
      threshold: 0.5,
      unit: 'Fr',
      note: `Froude ${fr.toFixed(2)} (${regime}); comfortable walk ≈ 0.25, walk→run ≈ 0.5${runRegime ? ' — this "walk" is in the run regime' : ''}`,
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
  if (frames.some((f) => f.angles)) {
    for (const joint of ['kneeFlexion', 'hipFlexion', 'ankleFlexion'] as NormativeSagittalJoint[]) {
      const samples = jointSamples(frames, joint);
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

  return checks;
}
