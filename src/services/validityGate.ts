/**
 * UNIFIED BUILD-TIME VALIDITY GATE (Workstream A — the animation-craft half).
 *
 * A single, deterministic, auditable pass/fail over a RESOLVED composed motion.
 * The 3D-animation industry turns "the 12 Principles" into MEASURED plausibility
 * gates — foot-skating ratio, CoM-in-support, penetration, seam-jerk — and the
 * ROM registry is our normative-kinematic clamp. This module folds those
 * scattered thresholds into ONE gate that emits an auditable
 * {@link ValidityReport} for every template and every AI-composed clip.
 *
 * It generalizes `simmove/src/kinematicGrade.ts` (the rig-FREE teleport/floor/
 * gait-plumbing seed) into the engine and lifts it from plan-structural to
 * RESOLVED-geometric: given a pre-sampled world-space frame set (the offline
 * sampler's `MotionRecording.frames`, or any equivalent), it measures the
 * geometry that only shows up once the rig plays. Without frames it still runs
 * the STRUCTURAL checks (ROM-clamp invariant), so the gate is usable rig-free.
 *
 * CHARTER. Pure, deterministic, side-effect-free. Two calls on the same inputs
 * return byte-identical reports. No sampling, no THREE, no DOM here — the caller
 * samples the rig (the headless GLB harness in src/__tests__) and hands the
 * frames in. Kinematic only: this gate makes NO dynamic / ground-reaction-force
 * / joint-moment / muscle claims (see docs/design-benchmark-redteam.md §4).
 *
 * WHAT IT CHECKS (docs/design-benchmark-redteam.md Gap 1 + §3 plausibility gates):
 *   • foot-skate ratio   — fraction of planted-contact frames whose foot slides
 *                          faster than a plant should (the industry metric). A
 *                          TRAVELLING gait must keep its planted foot world-fixed
 *                          (fail); an IN-PLACE / treadmill clip legitimately
 *                          slides (warn — the same in-place exemption
 *                          kinematicGrade draws for the walk template).
 *   • CoM-in-base        — the whole-body CoM ground projection vs the base of
 *                          support (reuse centerOfMass / computeBalanceTimeline).
 *                          STATIC geometry — only run on quasi-static motions
 *                          (a walk/run/jump legitimately vaults its CoM out).
 *   • penetration        — a tracked bone below the floor (feet the must-have;
 *                          toes tolerate the third-rocker dip).
 *   • seam-jerk          — max root + key-joint velocity discontinuity (2nd
 *                          position difference / dt) — the teleport idea from
 *                          kinematicGrade, generalized to every tracked joint.
 *   • ROM violation      — every RESOLVED target inside its romRegistry band.
 *                          Resolution already clamps, so a violation on the
 *                          RESOLVED output is a real bug (asserts the invariant).
 *
 * BIOMECH CHECKS (Workstream A integration) plug in at the marked extension
 * point below — this module deliberately does NOT implement the normative-gait
 * curves / RMS / Froude / vertical-CoM checks (a sibling module owns those).
 */
import type { ResolvedComposedMotion } from './motionSequence';
import { computeBalanceTimeline } from './centerOfMass';
import { getRomFieldDefinition } from './romRegistry';

// ── Report types ─────────────────────────────────────────────────────────────

/** One graded plausibility check. `measured` vs `threshold` (in `unit`) is the
 *  auditable number; `note` is the human-readable finding; `framePct` locates
 *  the worst offending frame (0..100) when the check is frame-scoped. */
export interface ValidityCheck {
  id: string;
  pass: boolean;
  /** 'fail' blocks the gate (overall→fail); 'warn' only lowers the score. */
  severity: 'fail' | 'warn';
  measured: number;
  threshold: number;
  unit: string;
  note: string;
  framePct?: number;
}

/** The whole gate verdict over one resolved motion. */
export interface ValidityReport {
  /** fail = any severity:'fail' check failed; warn = only warns failed; else pass. */
  overall: 'pass' | 'warn' | 'fail';
  /** Normalized 0..1 blend (pass=1, failed-warn=0.5, failed-fail=0, mean). */
  score: number;
  checks: ValidityCheck[];
  /** Ids of checks that did not run, each with the reason. */
  skipped: string[];
}

/** A pre-sampled world-space frame — the geometric checks' input. This is a
 *  structural SUBSET of the offline sampler's `RecordedFrame`
 *  (services/motionRecording), so `assessValidity(resolved, recording.frames)`
 *  just works; a rig-free caller can synthesize the same shape. */
export interface GateFrame {
  /** Time since motion start, ms. */
  tMs: number;
  /** World positions (m) of the tracked bones, keyed by canonical key, plus the
   *  whole-body centre of mass under the reserved key `CoM`
   *  (services/centerOfMass). Feet/toes are needed for foot-skate + penetration
   *  + CoM-in-base; `CoM` for CoM-in-base. */
  worldTracks?: Record<string, [number, number, number]>;
  /** Model-root world translation (m), used as the root track for seam-jerk.
   *  Falls back to the `Hips` world track when absent. */
  root?: { translateM: [number, number, number] };
}

/** The extension point the Workstream-A INTEGRATION fills — see the marked block
 *  in {@link assessValidity}. Returns extra checks (normativeGait RMS / Froude /
 *  vertical-CoM …) to fold into the same report. This module never implements it. */
export type BiomechCheckHook = (
  resolved: ResolvedComposedMotion,
  frames: readonly GateFrame[] | undefined,
  ctx: { floorY?: number },
) => ValidityCheck[];

export interface ValidityGateOptions {
  /** Known ground-plane world-Y (the rig's captured floor reference). Given, the
   *  penetration check measures against the TRUE floor (so a foot authored below
   *  it is caught) and the CoM base uses it; omitted, the floor is inferred as
   *  the lowest foot ankle over the clip (can't catch a below-floor foot). */
  floorY?: number;
  /** Per-check threshold overrides (host tuning / regression pinning). */
  thresholds?: Partial<ValidityThresholds>;
  /** BIOMECH CHECKS extension hook (Workstream A integration). */
  runBiomechChecks?: BiomechCheckHook;
}

// ── Thresholds (exported so tests + hosts cite the SAME numbers) ─────────────

export interface ValidityThresholds {
  /** A foot ankle within this height of the floor (m) is a ground contact —
   *  the industry ~5 cm plant band (metrics survey arxiv 2503.12763). */
  footContactHeightM: number;
  /** A contact-frame foot sliding faster than this (m/s) is skating — 2.5 cm per
   *  30 fps frame, the industry foot-skate slide threshold. */
  footSkateSpeedMs: number;
  /** Fraction of a foot's planted-contact frames allowed to skate before the
   *  ratio flags. A travelling gait keeps its planted foot world-fixed (≈0); a
   *  brief-stance run touches this from touchdown/push-off transients. */
  footSkateRatioMax: number;
  /** Net horizontal root travel (m) at/above which a motion counts as
   *  TRAVELLING — its planted foot MUST hold (foot-skate is then a FAIL). Below
   *  it the clip is in-place/treadmill and slide is a stylistic WARN. */
  travelEpsM: number;
  /** CoM ground projection allowed this far (m) outside the reconstructed base
   *  before the margin flags — absorbs the ±couple-cm footprint reconstruction
   *  (centerOfMass) + the quasi-static approximation. */
  comBaseToleranceM: number;
  /** CoM this far (m) outside the base is a gross topple (severity FAIL); a
   *  smaller excursion warns (the rig's vertical-pin grounding runs a floor-
   *  pinned quasi-static CoM a little behind its reconstructed base). */
  comBaseGrossM: number;
  /** Max root/key-joint velocity discontinuity (m/s), 2nd position difference /
   *  dt. Above shipped ballistic landings (~7 m/s), far below a keyframe
   *  teleport (~100 m/s). */
  seamJerkMaxMs: number;
  /** A foot ANKLE / non-foot bone this far (m) below the floor is penetration. */
  penetrationAnkleEpsM: number;
  /** A TOE this far (m) below the floor is penetration — larger, because the
   *  third-rocker push-off legitimately rotates the toe a few cm under. */
  penetrationToeEpsM: number;
  /** A RESOLVED target may sit this far (deg) outside its ROM band before it
   *  flags (clamp round-off tolerance). */
  romEpsDeg: number;
}

export const DEFAULT_VALIDITY_THRESHOLDS: ValidityThresholds = {
  footContactHeightM: 0.05,
  footSkateSpeedMs: 0.75,
  footSkateRatioMax: 0.5,
  travelEpsM: 0.3,
  comBaseToleranceM: 0.05,
  comBaseGrossM: 0.25,
  seamJerkMaxMs: 12,
  penetrationAnkleEpsM: 0.02,
  penetrationToeEpsM: 0.06,
  romEpsDeg: 0.5,
};

// ── Tracked-key groups ───────────────────────────────────────────────────────

const FOOT_ANKLE_KEYS = ['L_Foot', 'R_Foot'] as const;
const TOE_KEYS = ['L_Toes', 'R_Toes'] as const;
/** Bones the seam-jerk metric watches (root handled separately). */
const SEAM_JOINT_KEYS = ['Hips', 'Head', 'L_Hand', 'R_Hand', 'L_Foot', 'R_Foot'] as const;

// ── Small helpers ────────────────────────────────────────────────────────────

const distXZ = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);

const round = (n: number, places = 3): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Per-frame dt (s) — frame i's timestep is tMs[i]−tMs[i−1]. Guards a zero. */
function frameDtS(frames: readonly GateFrame[], i: number): number {
  const dt = (frames[i]!.tMs - frames[i - 1]!.tMs) / 1000;
  return dt > 1e-9 ? dt : 1e-9;
}

const pct = (i: number, n: number): number => (n <= 1 ? 0 : round((i / (n - 1)) * 100, 1));

/**
 * The quasi-static, planted class the CoM-over-base geometry is valid for —
 * the same exclusions {@link balanceCoordination}/`balanceAssistApplies` draws,
 * minus the opt-in flag. A gait / travelling / looping / ballistic / reoriented
 * / grounding-posture motion vaults or reorients its CoM by design, so the
 * static base test does not apply and the check is SKIPPED for it.
 */
function isQuasiStaticMotion(r: ResolvedComposedMotion): boolean {
  if (r.loop === true || r.footDrivenTravel === true) return false;
  if (r.contacts?.length) return false; // scheduled gait plant — moving base
  for (const kf of r.keyframes) {
    if (kf.stance === 'floating') return false; // airborne ballistics own their arc
    if (kf.groundingPosture != null) return false; // rests on its own contact set
    const o = kf.root?.orient;
    if (o && (o.quat != null || Math.abs(o.pitchDeg ?? 0) > 20 || Math.abs(o.rollDeg ?? 0) > 20)) {
      return false; // reoriented / lying — CoM-over-FEET is meaningless
    }
    const t = kf.root?.translateM;
    if (t && Math.hypot(t[0], t[2]) > 0.05) return false; // authored horizontal travel
  }
  return r.keyframes.some((kf) => kf.stance === 'planted');
}

/** Net horizontal displacement of the root (or Hips) across the clip — the
 *  "does it travel?" signal that decides foot-skate severity. */
function netTravelM(frames: readonly GateFrame[]): number {
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  const a = first.root?.translateM ?? first.worldTracks?.Hips;
  const b = last.root?.translateM ?? last.worldTracks?.Hips;
  if (!a || !b) return 0;
  return distXZ(a, b);
}

// ── The checks ───────────────────────────────────────────────────────────────

/** FOOT-SKATE RATIO — fraction of a foot's planted-contact frames (ankle within
 *  `footContactHeightM` of the floor) whose horizontal foot speed exceeds
 *  `footSkateSpeedMs`. A planted foot should be world-fixed; a travelling gait
 *  that slides it is a FAIL, an in-place/treadmill clip a WARN. */
function checkFootSkate(
  frames: readonly GateFrame[],
  floorY: number,
  travels: boolean,
  th: ValidityThresholds,
): ValidityCheck | null {
  const n = frames.length;
  if (!frames.some((f) => f.worldTracks?.L_Foot || f.worldTracks?.R_Foot)) return null;
  let worstRatio = 0;
  let worstSpeed = 0;
  let worstFrame = 0;
  for (const foot of FOOT_ANKLE_KEYS) {
    let contactPairs = 0;
    let skating = 0;
    for (let i = 1; i < n; i += 1) {
      const a = frames[i - 1]!.worldTracks?.[foot];
      const b = frames[i]!.worldTracks?.[foot];
      if (!a || !b) continue;
      // A pair counts only when BOTH ends are firmly planted — this excludes the
      // touchdown/lift-off transients (foot still descending/rising) that are
      // not skate.
      if (a[1] >= floorY + th.footContactHeightM || b[1] >= floorY + th.footContactHeightM) continue;
      contactPairs += 1;
      const speed = distXZ(a, b) / frameDtS(frames, i);
      if (speed > th.footSkateSpeedMs) skating += 1;
      if (speed > worstSpeed) {
        worstSpeed = speed;
        worstFrame = i;
      }
    }
    const ratio = contactPairs ? skating / contactPairs : 0;
    if (ratio > worstRatio) worstRatio = ratio;
  }
  const pass = worstRatio <= th.footSkateRatioMax;
  const severity: 'fail' | 'warn' = travels ? 'fail' : 'warn';
  const note = pass
    ? `planted feet hold — ${round(worstRatio * 100, 0)}% of contact frames slide > ` +
      `${th.footSkateSpeedMs} m/s (worst ${round(worstSpeed, 2)} m/s)`
    : `${round(worstRatio * 100, 0)}% of planted-contact frames slide > ${th.footSkateSpeedMs} m/s ` +
      `(worst ${round(worstSpeed, 2)} m/s) — ${travels ? 'a travelling gait must keep its planted foot world-fixed' : 'in-place slide (treadmill convention)'}`;
  return {
    id: 'foot-skate',
    pass,
    severity,
    measured: round(worstRatio, 3),
    threshold: th.footSkateRatioMax,
    unit: 'ratio',
    note,
    framePct: pct(worstFrame, n),
  };
}

/** COM-IN-BASE — worst (min) margin of stability over the supported frames
 *  (reuse computeBalanceTimeline). Static geometry: caller restricts to
 *  quasi-static motions. A small excursion outside the reconstructed base warns
 *  (base ±cm + vertical-pin grounding); a gross one fails. */
function checkComInBase(
  frames: readonly GateFrame[],
  floorY: number | undefined,
  th: ValidityThresholds,
): ValidityCheck | null {
  if (!frames.some((f) => f.worldTracks?.CoM)) return null;
  const tl = computeBalanceTimeline(
    { frames: frames.map((f) => ({ tMs: f.tMs, worldTracks: f.worldTracks })) },
    floorY != null ? { floorY } : {},
  );
  if (tl.minMarginM == null) return null; // never supported (all airborne)
  const worst = tl.minMarginM;
  // Locate the worst-margin frame for framePct.
  let worstFrame = 0;
  let worstVal = Infinity;
  tl.frames.forEach((bf, i) => {
    if (bf.marginM != null && bf.marginM < worstVal) {
      worstVal = bf.marginM;
      worstFrame = i;
    }
  });
  const pass = worst >= -th.comBaseToleranceM;
  const severity: 'fail' | 'warn' = worst < -th.comBaseGrossM ? 'fail' : 'warn';
  const note = pass
    ? `CoM stays over the base — worst margin ${round(worst * 100, 1)} cm inside`
    : `CoM projects ${round(-worst * 100, 1)} cm OUTSIDE the base of support ` +
      `(${severity === 'fail' ? 'gross — topple' : 'within the base-reconstruction + vertical-pin grounding band'})`;
  return {
    id: 'com-in-base',
    pass,
    severity,
    measured: round(worst, 3),
    threshold: -th.comBaseToleranceM,
    unit: 'm',
    note,
    framePct: pct(worstFrame, frames.length),
  };
}

/** PENETRATION — a tracked bone below the floor beyond its tolerance. Feet/other
 *  bones use the tight ankle epsilon; toes a larger one (the third-rocker push-
 *  off legitimately dips the toe a few cm under). Needs a floor reference. */
function checkPenetration(
  frames: readonly GateFrame[],
  floorY: number | undefined,
  th: ValidityThresholds,
): ValidityCheck | null {
  // The floor: the caller's known reference, else the lowest ankle over the clip
  // (which by definition can't be undercut by a foot — so a below-floor foot is
  // only caught when the caller supplies the true floor).
  let floor = floorY;
  if (floor == null) {
    let m = Infinity;
    for (const f of frames) {
      for (const k of FOOT_ANKLE_KEYS) {
        const p = f.worldTracks?.[k];
        if (p) m = Math.min(m, p[1]);
      }
    }
    floor = Number.isFinite(m) ? m : 0;
  }
  const epsOf = (key: string): number =>
    (TOE_KEYS as readonly string[]).includes(key) ? th.penetrationToeEpsM : th.penetrationAnkleEpsM;
  let worstBelowM = -Infinity; // most-below (Y under floor), signed positive = below
  let worstViolation = -Infinity; // belowM − eps, maximized
  let worstBone = '';
  let worstEps = th.penetrationAnkleEpsM;
  let worstFrame = 0;
  let sawTrack = false;
  frames.forEach((f, i) => {
    const tracks = f.worldTracks;
    if (!tracks) return;
    for (const [key, p] of Object.entries(tracks)) {
      if (key === 'CoM') continue;
      sawTrack = true;
      const belowM = floor! - p[1];
      const violation = belowM - epsOf(key);
      if (violation > worstViolation) {
        worstViolation = violation;
        worstBelowM = belowM;
        worstBone = key;
        worstEps = epsOf(key);
        worstFrame = i;
      }
    }
  });
  if (!sawTrack) return null;
  const pass = worstViolation <= 0;
  const note = pass
    ? `no bone sinks through the floor — deepest ${worstBone} ${round(Math.max(0, worstBelowM) * 100, 1)} cm below (tol ${round(worstEps * 100, 1)} cm)`
    : `${worstBone} sinks ${round(worstBelowM * 100, 1)} cm below the floor (tol ${round(worstEps * 100, 1)} cm)`;
  return {
    id: 'penetration',
    pass,
    severity: 'fail',
    measured: round(worstBelowM, 3),
    threshold: round(worstEps, 3),
    unit: 'm',
    note,
    framePct: pct(worstFrame, frames.length),
  };
}

/** SEAM-JERK — max velocity discontinuity (m/s), the 2nd position difference
 *  |p₊−2p+p₋|/dt over the root and every key joint. Smooth motion (even fast
 *  ballistics) stays bounded; a keyframe teleport spikes far past the ceiling.
 *  Generalizes kinematicGrade's root-only teleport metric. */
function checkSeamJerk(frames: readonly GateFrame[], th: ValidityThresholds): ValidityCheck | null {
  const n = frames.length;
  if (n < 3) return null;
  const seriesOf = (key: string | 'root'): ([number, number, number] | undefined)[] =>
    frames.map((f) =>
      key === 'root' ? f.root?.translateM ?? f.worldTracks?.Hips : f.worldTracks?.[key],
    );
  const tracks: (string | 'root')[] = ['root', ...SEAM_JOINT_KEYS];
  let worst = 0;
  let worstTrack = 'root';
  let worstFrame = 0;
  let sawAny = false;
  for (const key of tracks) {
    const s = seriesOf(key);
    for (let i = 1; i < n - 1; i += 1) {
      const p0 = s[i - 1];
      const p1 = s[i];
      const p2 = s[i + 1];
      if (!p0 || !p1 || !p2) continue;
      sawAny = true;
      const sd = Math.hypot(
        p2[0] - 2 * p1[0] + p0[0],
        p2[1] - 2 * p1[1] + p0[1],
        p2[2] - 2 * p1[2] + p0[2],
      );
      const vDisc = sd / frameDtS(frames, i);
      if (vDisc > worst) {
        worst = vDisc;
        worstTrack = key;
        worstFrame = i;
      }
    }
  }
  if (!sawAny) return null;
  const pass = worst <= th.seamJerkMaxMs;
  const note = pass
    ? `motion is continuous — worst velocity discontinuity ${round(worst, 2)} m/s (${worstTrack})`
    : `velocity discontinuity ${round(worst, 2)} m/s on ${worstTrack} — a seam/teleport (human motion stays < ${th.seamJerkMaxMs} m/s)`;
  return {
    id: 'seam-jerk',
    pass,
    severity: 'fail',
    measured: round(worst, 2),
    threshold: th.seamJerkMaxMs,
    unit: 'm/s',
    note,
    framePct: pct(worstFrame, n),
  };
}

/** ROM VIOLATION — every RESOLVED target inside its romRegistry band. Resolution
 *  clamps through that same band, so an out-of-band value on the RESOLVED output
 *  is a real invariant break (a bug), not an authoring choice. Structural — runs
 *  with or without frames. */
function checkRomViolation(
  resolved: ResolvedComposedMotion,
  th: ValidityThresholds,
): ValidityCheck {
  let worstOver = 0;
  let worstNote = '';
  let worstKf = 0;
  const nKf = resolved.keyframes.length;
  resolved.keyframes.forEach((kf, ki) => {
    for (const t of kf.targets) {
      const def = getRomFieldDefinition(t.joint, t.motion);
      if (!def) continue; // no band to assert against — skip
      const { min, max } = def.range;
      const over = t.clampedDegrees > max ? t.clampedDegrees - max : min - t.clampedDegrees;
      if (over > worstOver) {
        worstOver = over;
        worstKf = ki;
        const side = t.clampedDegrees > max ? `> max ${max}` : `< min ${min}`;
        worstNote = `${t.joint}.${t.motion} = ${round(t.clampedDegrees, 1)}° (${side}°) at keyframe ${ki}`;
      }
    }
  });
  const pass = worstOver <= th.romEpsDeg;
  return {
    id: 'rom-violation',
    pass,
    severity: 'fail',
    measured: round(worstOver, 2),
    threshold: th.romEpsDeg,
    unit: 'deg',
    note: pass
      ? 'every resolved target sits inside its ROM band'
      : `RESOLVED target out of ROM band — ${worstNote} (resolution should have clamped this)`,
    framePct: pct(worstKf, nKf),
  };
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * Assess a RESOLVED composed motion against the plausibility + ROM gates.
 *
 * `frames` is an optional pre-sampled world-space frame set (the offline
 * sampler's `MotionRecording.frames`, or any {@link GateFrame}[]). PRESENT →
 * the geometric checks (foot-skate, CoM-in-base, penetration, seam-jerk) run;
 * ABSENT → only the STRUCTURAL check (ROM-clamp invariant) runs and the
 * geometric ones are listed in `skipped` (so the gate is usable rig-free).
 *
 * Pure + deterministic: same inputs → byte-identical {@link ValidityReport}.
 */
export function assessValidity(
  resolved: ResolvedComposedMotion,
  frames?: readonly GateFrame[],
  opts: ValidityGateOptions = {},
): ValidityReport {
  const th: ValidityThresholds = { ...DEFAULT_VALIDITY_THRESHOLDS, ...(opts.thresholds ?? {}) };

  // A refused / empty resolution plays nothing — grade vacuously clean (mirrors
  // kinematicGrade's "nothing will play" contract).
  if (resolved.status !== 'ok' || resolved.keyframes.length === 0) {
    return {
      overall: 'pass',
      score: 1,
      checks: [],
      skipped: ['all — resolution refused or empty (nothing plays)'],
    };
  }

  const checks: ValidityCheck[] = [];
  const skipped: string[] = [];

  // ── Structural checks (always run) ─────────────────────────────────────────
  checks.push(checkRomViolation(resolved, th));

  // ── Geometric checks (need sampled frames) ─────────────────────────────────
  const hasFrames = !!frames && frames.length >= 2;
  if (hasFrames) {
    const fr = frames!;
    const travels = resolved.footDrivenTravel === true || netTravelM(fr) >= th.travelEpsM;

    const skate = checkFootSkate(fr, opts.floorY ?? inferFloorY(fr), travels, th);
    if (skate) checks.push(skate);
    else skipped.push('foot-skate — no foot world tracks in frames');

    if (isQuasiStaticMotion(resolved)) {
      const com = checkComInBase(fr, opts.floorY, th);
      if (com) checks.push(com);
      else skipped.push('com-in-base — no CoM track / never supported');
    } else {
      skipped.push('com-in-base — dynamic motion (CoM legitimately leaves the base; static check N/A)');
    }

    const pen = checkPenetration(fr, opts.floorY, th);
    if (pen) checks.push(pen);
    else skipped.push('penetration — no world tracks in frames');

    const seam = checkSeamJerk(fr, th);
    if (seam) checks.push(seam);
    else skipped.push('seam-jerk — fewer than 3 usable frames');
  } else {
    skipped.push(
      'foot-skate, com-in-base, penetration, seam-jerk — no sampled frames (structural mode)',
    );
  }

  // ── BIOMECH CHECKS (Workstream A integration) ──────────────────────────────
  // normativeGait RMS / Froude / vertical-CoM excursion / Perry-timing / GDI-lite
  // plug in HERE for gait-shaped motions. A sibling module (src/services/
  // normativeGait.ts) owns the biomech curves; the INTEGRATOR wires it in by
  // passing `opts.runBiomechChecks`. This module deliberately does NOT implement
  // the biomech curves — it only provides the hook + folds the results into the
  // one report. When no hook is given the gate records the gap in `skipped`.
  if (opts.runBiomechChecks) {
    for (const c of opts.runBiomechChecks(resolved, frames, { floorY: opts.floorY })) checks.push(c);
  } else {
    skipped.push(
      'biomech (normativeGait RMS / Froude / vertical-CoM / Perry-timing) — no runBiomechChecks hook (Workstream A integration point)',
    );
  }

  // ── Score + overall ────────────────────────────────────────────────────────
  const failing = checks.filter((c) => !c.pass);
  const overall: ValidityReport['overall'] = failing.some((c) => c.severity === 'fail')
    ? 'fail'
    : failing.length
      ? 'warn'
      : 'pass';
  const score = checks.length
    ? round(
        checks.reduce((s, c) => s + (c.pass ? 1 : c.severity === 'warn' ? 0.5 : 0), 0) / checks.length,
        3,
      )
    : 1;

  return { overall, score, checks, skipped };
}

/** Infer the ground plane from frames alone — the lowest foot ankle over the
 *  clip. Used only by foot-skate's contact band when the caller gives no floor. */
function inferFloorY(frames: readonly GateFrame[]): number {
  let m = Infinity;
  for (const f of frames) {
    for (const k of FOOT_ANKLE_KEYS) {
      const p = f.worldTracks?.[k];
      if (p) m = Math.min(m, p[1]);
    }
  }
  return Number.isFinite(m) ? m : 0;
}
