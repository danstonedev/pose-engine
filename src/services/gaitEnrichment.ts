/**
 * RESOLVE-TIME GAIT PLUMBING for gait-shaped composed plans
 * (AI-PLUMB-01/02/03, AI-SEAM-01).
 *
 * The deterministic gait builders owe their realism to OPTIONAL fields on
 * {@link ComposedMotion} — `verticalCalibrationCm`, `contacts`,
 * `gaitStanceWindowsMs`, `lateralShuttleCm`, `footDrivenTravel`, `settleEnds` —
 * that an AI compose tool schema mostly cannot express (and host coercion
 * strips). An AI-composed 8-phase walk therefore bypassed ALL of the gait
 * machinery: measured 68 cm planted-foot slide vs the template's 2.6 cm (26×),
 * a 12.4 cm 100-ms pelvis drop vs 5.2 (failing the engine's own recording
 * gate), zero medio-lateral weight shift vs 5.5 cm, and a 1.03 m/s teleport
 * start vs 0.15.
 *
 * This module closes the gap AT RESOLVE TIME — the one path the offline
 * sampler and the live stage both consume — with three pure pieces:
 *
 * 1. {@link looksLikeGaitPlan}: a CONSERVATIVE, STRUCTURAL (never textual)
 *    predicate for "this plan is a reciprocal gait". False positives are worse
 *    than false negatives: a squat, lunge, kick, single-leg stand or
 *    sit-to-stand must never trip it (a march-in-place may — the enrichment is
 *    correct there too).
 * 2. {@link hasAuthoredGaitPlumbing}: plans that already author ANY of the gait
 *    machinery are builder-grade and are NEVER touched — which is also what
 *    keeps every deterministic builder byte-identical (they author these
 *    fields; enrichment only serves plans that bypass all of them). The
 *    in-place `walk` TEMPLATE (no plumbing fields — its vertical arrives via
 *    the executor-level `gaitBounce`) is preserved byte-identical too, because
 *    enrichment additionally requires net root travel (see below) and the
 *    in-place template authors none. An AI in-place gait loop is structurally
 *    indistinguishable from that template (by design — it's a faithful copy),
 *    so it deliberately resolves the same way the template does.
 * 3. {@link planGaitEnrichment}: for a gait-shaped, un-plumbed plan whose
 *    keyframe roots carry NET horizontal travel, convert the authored travel to
 *    the builders' foot-driven form — strip the horizontal drift from the
 *    keyframe roots, attach `footDrivenTravel` + `settleEnds` + the walk
 *    template's calibrated vertical + lateral shuttle, and (post-resolution,
 *    once the velocity floor has fixed the real keyframe times) a derived
 *    stance schedule + foot-plant contacts ({@link deriveGaitStanceSchedule}).
 *    A LOOPING travel plan additionally resolves as ONE-SHOT: a loop whose
 *    cycle carries net root displacement glide-snaps the body back every wrap
 *    (measured −7.4 m/s, 12.9 cm/frame — AI-SEAM-01), so the least-surprising
 *    honest behavior is one full traveled pass braking to quiet standing.
 *    A NON-gait looping plan with net travel is not converted (its keyframes
 *    are not a gait; foot-driven travel would be fiction) — it resolves
 *    non-looping with a note instead of shipping the teleport wrap.
 *
 * Every attachment is reported on `ResolvedComposedMotion.notes` (the
 * motion-level honesty surface) so hosts can narrate "gait plumbing attached:
 * vertical, contacts, shuttle" instead of silently rewriting the plan.
 *
 * Pure math on plain data — no scene, no Svelte, no imports from the template
 * library (the two default targets are pinned here and cross-asserted against
 * the builders in tests, keeping the dependency graph acyclic).
 */
import {
  TRAVEL_DIRECTION_AXIS,
  type ComposedMotion,
  type SequenceKeyframe,
  type StanceContact,
} from './motionSequence';

// ── Tunables (structural thresholds — see looksLikeGaitPlan) ────────────────

/** Fewest keyframes a plan needs before it can read as a gait (a 2-keyframe
 *  "walk sketch" is not a gait cycle; the reference cycle is 8). */
export const GAIT_MIN_KEYFRAMES = 4;
/** Minimum |left − right| hip-flexion split (deg) for a keyframe to count as a
 *  reciprocal extreme — below this the legs are moving together (squat-class). */
export const GAIT_RECIPROCAL_MIN_DEG = 10;
/** Anti-phase check: at a reciprocal extreme the swing-side hip must be flexed
 *  at least this much… */
export const GAIT_ANTIPHASE_FLEX_MIN_DEG = 15;
/** …while the stance-side hip is past neutral into extension (≤ this). A
 *  repetitive single-leg kick whose off leg never extends does NOT read as
 *  gait — real reciprocal gait extends the trailing hip every step. */
export const GAIT_ANTIPHASE_EXT_MAX_DEG = -5;
/** Minimum |Δ(left−right)| between successive keyframes for a stance-side
 *  trend (below = double-support handoff; the span joins the next window). */
export const GAIT_TREND_EPS_DEG = 6;
/** Net horizontal root displacement (m) below which a plan is "in place". */
export const GAIT_TRAVEL_EPS_M = 0.05;
/** Body pitch/roll (deg) beyond which a plan is not upright walking. */
export const GAIT_UPRIGHT_MAX_TILT_DEG = 20;

// ── Enrichment defaults (pinned to the deterministic walk's — see tests) ────

/** Calibrated gait vertical attached to an enriched travel gait, cm. MUST equal
 *  the walk builders' NORMAL_GAIT_VERTICAL_CM (movementTemplates) — asserted by
 *  gaitEnrichment.test.ts against buildTravelWalk's authored value. */
export const GAIT_ENRICH_VERTICAL_CM = 5;
/** Medio-lateral pelvis shuttle attached to an enriched travel gait, cm. MUST
 *  equal the walk builders' GAIT_SHUTTLE_CM — asserted against buildTravelWalk. */
export const GAIT_ENRICH_SHUTTLE_CM = 2.5;
/** Entry-ramp floor (ms) for an enriched gait whose FIRST keyframe is already a
 *  mid-stride pose. The deterministic walk spends initiation (300 ms APA) +
 *  step-off (400 ms) easing from quiet standing into its first full stride —
 *  an AI plan jumps straight to the stride pose, so the whole entry reach (and
 *  its entry-reach root cancellation) lands inside one short keyframe: measured
 *  1.03 m/s root speed in the first 150 ms vs the template's 0.15. Raising the
 *  first keyframe to this floor spreads the same entry over the template's
 *  timing class (ease from a standstill — the trajectory's first knot is a
 *  stop), bounding the entry root speed without inventing new physics. */
export const GAIT_ENRICH_ENTRY_MS = 900;
/** Brake-ramp floor (ms) for an enriched ONE-SHOT gait whose LAST keyframe is a
 *  mid-stride pose: the final span is lengthened so the settle into the last
 *  pose decelerates over the deterministic termination's timing class instead
 *  of freezing at full stride speed (the template authors a braking step +
 *  feet-together settle; a bare AI cycle has neither). */
export const GAIT_ENRICH_BRAKE_MS = 600;

const HIP_L = 'L_UpLeg';
const HIP_R = 'R_UpLeg';
const HIP_MOTION = 'hipFlexion';
const HORIZONTAL_DIRECTIONS = new Set(['forward', 'backward', 'left', 'right']);

const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A keyframe's authored hip-flexion targets (last-wins within the keyframe,
 *  mirroring the resolver's duplicate rule), or undefined per side. */
function hipTargets(kf: SequenceKeyframe): { l?: number; r?: number } {
  let l: number | undefined;
  let r: number | undefined;
  for (const t of kf.targets ?? []) {
    if (!t || t.motion !== HIP_MOTION || !isFiniteNum(t.targetDegrees)) continue;
    if (t.joint === HIP_L) l = t.targetDegrees;
    else if (t.joint === HIP_R) r = t.targetDegrees;
  }
  return { l, r };
}

/** The effective horizontal translate a keyframe authors, mirroring the
 *  resolver's precedence (raw `root.translateM` wins; `travel` sugar fills).
 *  Returns undefined when the keyframe authors no horizontal translate, and
 *  'invalid' for a malformed root/travel (the caller then declines to enrich —
 *  resolution will refuse the plan through its own shape-error path). */
function keyframeXZ(kf: SequenceKeyframe): { x: number; z: number } | undefined | 'invalid' {
  const raw = kf.root?.translateM;
  if (raw != null) {
    if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(isFiniteNum)) return 'invalid';
    return { x: raw[0]!, z: raw[2]! };
  }
  const travel = kf.travel;
  if (travel != null) {
    if (
      typeof travel !== 'object' ||
      !isFiniteNum(travel.meters) ||
      TRAVEL_DIRECTION_AXIS[travel.direction] == null
    ) {
      return 'invalid';
    }
    const axis = TRAVEL_DIRECTION_AXIS[travel.direction];
    return { x: axis[0] * travel.meters, z: axis[2] * travel.meters };
  }
  return undefined;
}

/** Structural per-plan analysis backing {@link looksLikeGaitPlan} (exported for
 *  the resolver + tests; hosts only need the boolean predicate). */
export interface GaitPlanAnalysis {
  /** The conservative structural verdict — see {@link looksLikeGaitPlan}. */
  isGait: boolean;
  /** Sign alternations of the left−right hip split across the plan. */
  alternations: number;
  /** Per-keyframe stance side for the span ARRIVING at each keyframe: the foot
   *  under the EXTENDING hip bears weight (the swing hip flexes to advance).
   *  Double-support (flat) spans join the following stance window, mirroring
   *  the deterministic builders' schedule. Only meaningful when `isGait`. */
  stanceByKf: ('L' | 'R')[];
  /** Net authored horizontal root displacement across the plan, meters. */
  netTravelM: { x: number; z: number };
  /** True when any keyframe roots/travel were malformed (never enrich those —
   *  resolution refuses them through its own shape-error path). */
  malformedRoots: boolean;
}

/**
 * Analyze a composed plan's gait structure. Pure + total: any input shape
 * returns an analysis (never throws); a non-gait plan reports `isGait: false`.
 */
export function analyzeGaitPlan(motion: ComposedMotion): GaitPlanAnalysis {
  const kfs = (Array.isArray(motion?.keyframes) ? motion.keyframes : []).filter(
    (kf): kf is SequenceKeyframe => kf != null && typeof kf === 'object',
  );
  const rawCount = Array.isArray(motion?.keyframes) ? motion.keyframes.length : 0;
  const hasMalformedKf = kfs.length !== rawCount;

  // NET TRAVEL first — needed for the loop-travel conversion even when the
  // plan is NOT a gait (AI-SEAM-01's refuse-the-loop branch): effective
  // horizontal root displacement, carry-forward absolute roots, raw translate
  // winning over travel sugar per the resolver's precedence.
  let malformedRoots = hasMalformedKf;
  let curX = 0;
  let curZ = 0;
  for (const kf of kfs) {
    const xz = keyframeXZ(kf);
    if (xz === 'invalid') malformedRoots = true;
    else if (xz) {
      curX = xz.x;
      curZ = xz.z;
    }
  }
  const none: GaitPlanAnalysis = {
    isGait: false,
    alternations: 0,
    stanceByKf: [],
    netTravelM: { x: curX, z: curZ },
    malformedRoots,
  };
  if (hasMalformedKf || kfs.length < GAIT_MIN_KEYFRAMES) return none;

  // PLANTED + UPRIGHT (structural): every keyframe grounded on the feet, no
  // lying/quadruped reorientation anywhere. Gait machinery is meaningless (and
  // harmful) off the feet, so any doubt disqualifies.
  const motionPlanted = motion.stance === 'planted';
  for (const kf of kfs) {
    const planted = kf.stance != null ? kf.stance === 'planted' : motionPlanted;
    if (!planted) return none;
    if (kf.groundingPosture != null) return none;
    if (kf.posture != null && kf.posture !== 'upright') return none;
    const orient = kf.root?.orient;
    if (orient != null) {
      if (orient.quat != null) return none; // arbitrary orientation — not upright walking
      if (Math.abs(orient.pitchDeg ?? 0) > GAIT_UPRIGHT_MAX_TILT_DEG) return none;
      if (Math.abs(orient.rollDeg ?? 0) > GAIT_UPRIGHT_MAX_TILT_DEG) return none;
    }
  }

  // HIP SPLIT SERIES (carry-forward, like keyframe pose folding): d = L − R.
  // Reciprocal gait alternates d's sign; legs-together movement keeps |d| ≈ 0.
  interface Sample {
    kfIndex: number;
    l: number;
    r: number;
    d: number;
  }
  const samples: Sample[] = [];
  let lastL: number | undefined;
  let lastR: number | undefined;
  for (const [i, kf] of kfs.entries()) {
    const { l, r } = hipTargets(kf);
    if (l != null) lastL = l;
    if (r != null) lastR = r;
    if (lastL != null && lastR != null) {
      samples.push({ kfIndex: i, l: lastL, r: lastR, d: lastL - lastR });
    }
  }
  if (samples.length < GAIT_MIN_KEYFRAMES) return none;

  // ALTERNATIONS: sign flips of d between successive reciprocal extremes.
  let alternations = 0;
  let lastSign = 0;
  for (const s of samples) {
    if (Math.abs(s.d) < GAIT_RECIPROCAL_MIN_DEG) continue;
    const sign = s.d > 0 ? 1 : -1;
    if (lastSign !== 0 && sign !== lastSign) alternations += 1;
    lastSign = sign;
  }

  // ANTI-PHASE BOTH WAYS: each leg takes a turn swinging (hip flexed ≥ 15°)
  // while the OTHER is past neutral into extension (≤ −5°) — the signature of
  // reciprocal gait no squat/lunge/kick/single-leg-stand plan produces.
  const leftSwings = samples.some(
    (s) => s.l >= GAIT_ANTIPHASE_FLEX_MIN_DEG && s.r <= GAIT_ANTIPHASE_EXT_MAX_DEG,
  );
  const rightSwings = samples.some(
    (s) => s.r >= GAIT_ANTIPHASE_FLEX_MIN_DEG && s.l <= GAIT_ANTIPHASE_EXT_MAX_DEG,
  );

  const isGait =
    leftSwings && rightSwings && (alternations >= 2 || (motion.loop === true && alternations >= 1));

  // STANCE SIDE per arriving span: the foot under the hip that EXTENDS across
  // the span bears weight (Δd > 0 ⇒ R extending relative to L ⇒ R stance).
  // Flat spans (double support) join the FOLLOWING stance window — exactly
  // where the deterministic builders put the handoff (the outgoing window ends
  // at the reciprocal extreme; the incoming one owns the weight transfer).
  const stanceByKf: ('L' | 'R')[] = [];
  if (isGait) {
    const dByKf = new Map<number, number>(samples.map((s) => [s.kfIndex, s.d]));
    const trend: (0 | 1 | -1)[] = [];
    let prevD = 0; // the entry pose is quiet standing (d = 0) by convention
    for (let i = 0; i < kfs.length; i += 1) {
      const d = dByKf.get(i);
      if (d == null) {
        trend.push(0);
        continue;
      }
      const delta = d - prevD;
      trend.push(Math.abs(delta) <= GAIT_TREND_EPS_DEG ? 0 : delta > 0 ? 1 : -1);
      prevD = d;
    }
    // Fill flat spans forward from the NEXT trending span; a trailing flat run
    // (terminal double support) keeps the PREVIOUS side.
    let next: 'L' | 'R' | undefined;
    const filled: ('L' | 'R' | undefined)[] = new Array(kfs.length).fill(undefined);
    for (let i = kfs.length - 1; i >= 0; i -= 1) {
      if (trend[i] === 1) next = 'R';
      else if (trend[i] === -1) next = 'L';
      filled[i] = next;
    }
    let prev: 'L' | 'R' = filled[0] ?? 'R';
    for (let i = 0; i < kfs.length; i += 1) {
      if (filled[i] != null) prev = filled[i]!;
      stanceByKf.push(prev);
    }
  }

  return { isGait, alternations, stanceByKf, netTravelM: { x: curX, z: curZ }, malformedRoots };
}

/**
 * TRUE when a composed plan is structurally a reciprocal upright gait:
 * ≥ {@link GAIT_MIN_KEYFRAMES} keyframes, planted + upright throughout, with
 * anti-phase left/right hip flexion whose split alternates sign across the plan
 * (looping, or spanning ≥ 2 alternations). Conservative by construction —
 * squats, lunges, kicks, single-leg stands and sit-to-stands read false; a
 * march-in-place may read true (the enrichment is correct there too).
 */
export function looksLikeGaitPlan(motion: ComposedMotion): boolean {
  return analyzeGaitPlan(motion).isGait;
}

/**
 * TRUE when the plan already authors ANY of the engine's gait machinery.
 * Such a plan is builder-grade (the deterministic gait builders author all of
 * it; a partially-plumbed authored plan knows what it's doing) and resolve-time
 * enrichment must never second-guess it — this is also the guarantee that every
 * deterministic builder resolves byte-identical.
 */
export function hasAuthoredGaitPlumbing(motion: ComposedMotion): boolean {
  return (
    motion.contacts != null ||
    motion.gaitStanceWindowsMs != null ||
    motion.verticalCalibrationCm != null ||
    motion.lateralShuttleCm != null ||
    motion.footDrivenTravel != null ||
    motion.settleEnds != null ||
    motion.heelStrikeAccent != null ||
    motion.headingDeg != null ||
    motion.headingProfileMs != null ||
    motion.inheritHeading != null
  );
}

/** What {@link planGaitEnrichment} decided at resolve entry. */
export interface GaitEnrichmentPlan {
  /** The (possibly rewritten) motion to resolve in place of the input. */
  motion: ComposedMotion;
  /** True when a stance schedule + contacts should be derived AFTER keyframe
   *  timing is resolved (the velocity floor may re-time keyframes, and the
   *  windows must live on the RESOLVED authored clock the sampler/stage scale
   *  by `authoredToTrajectoryTimeScale`). */
  deriveStanceSchedule: boolean;
  /** Per-keyframe stance sides for {@link deriveGaitStanceSchedule}. */
  stanceByKf: ('L' | 'R')[];
  /** Honesty notes for `ResolvedComposedMotion.notes`. */
  notes: string[];
}

/** Strip a keyframe's HORIZONTAL travel (raw x/z + horizontal `travel` sugar),
 *  keeping vertical translate and every orient — the converted plan's travel is
 *  re-derived from foot placement instead. */
function stripHorizontalTravel(kf: SequenceKeyframe): SequenceKeyframe {
  const out: SequenceKeyframe = { ...kf };
  if (out.travel != null && HORIZONTAL_DIRECTIONS.has(out.travel.direction)) delete out.travel;
  const t = out.root?.translateM;
  if (out.root != null && Array.isArray(t) && t.length === 3) {
    const root = { ...out.root };
    if (t[1] !== 0) root.translateM = [0, t[1]!, 0];
    else delete root.translateM;
    if (root.translateM != null || root.orient != null) out.root = root;
    else delete out.root;
  }
  return out;
}

/**
 * Decide the resolve-time gait plumbing for one composed plan. Returns null for
 * every plan that must pass through untouched (non-gait in-place plans, plans
 * with authored plumbing, malformed roots, gait plans without net travel —
 * which includes the deterministic in-place walk template). Otherwise returns
 * the rewritten motion + notes; the caller resolves the rewritten motion and,
 * when `deriveStanceSchedule` is set, attaches
 * {@link deriveGaitStanceSchedule}'s windows/contacts to the resolved output.
 */
export function planGaitEnrichment(motion: ComposedMotion): GaitEnrichmentPlan | null {
  if (!motion || !Array.isArray(motion.keyframes) || motion.keyframes.length === 0) return null;
  if (hasAuthoredGaitPlumbing(motion)) return null;

  const analysis = analyzeGaitPlan(motion);
  if (analysis.malformedRoots) return null;
  const { x: netX, z: netZ } = analysis.netTravelM;
  const netM = Math.hypot(netX, netZ);
  const hasTravel = netM > GAIT_TRAVEL_EPS_M;
  if (!hasTravel) return null; // in-place plans resolve exactly like the in-place template

  const notes: string[] = [];

  if (!analysis.isGait) {
    // AI-SEAM-01 (non-gait branch): a LOOPING plan whose cycle nets root
    // displacement glide-snaps back every wrap (measured 12.9 cm/frame). The
    // keyframes are not a gait, so foot-driven conversion would be fiction —
    // resolve as non-looping instead of shipping the teleport.
    if (motion.loop === true) {
      notes.push(
        'loop-travel: the authored keyframes carry net root travel, which would snap back every loop wrap — resolved as a single pass instead',
      );
      return {
        motion: { ...motion, loop: false },
        deriveStanceSchedule: false,
        stanceByKf: [],
        notes,
      };
    }
    return null; // one-shot authored travel on a non-gait plan is legitimate
  }

  // GAIT-SHAPED TRAVEL PLAN → the deterministic travel-walk plumbing.
  // Strip the authored horizontal drift (travel is re-derived from foot
  // placement — ONE source of truth, exactly like buildTravelWalk) and attach
  // the machinery the plan structurally asked for but could not express.
  const keyframes = motion.keyframes.map(stripHorizontalTravel);
  const enriched: ComposedMotion = {
    ...motion,
    keyframes,
    footDrivenTravel: true,
    settleEnds: true,
    verticalCalibrationCm: GAIT_ENRICH_VERTICAL_CM,
    lateralShuttleCm: GAIT_ENRICH_SHUTTLE_CM,
  };
  notes.push(
    'gait plumbing attached: authored root travel re-derived from foot placement (footDrivenTravel; the planted foot stays world-fixed)',
    `gait plumbing attached: calibrated vertical ${GAIT_ENRICH_VERTICAL_CM} cm`,
    `gait plumbing attached: lateral weight-shift shuttle ${GAIT_ENRICH_SHUTTLE_CM} cm`,
    'gait plumbing attached: settle ends (ease in from standstill, brake to quiet standing)',
  );

  if (motion.loop === true) {
    // AI-SEAM-01 (gait branch): a travel gait cannot loop — the wrap would
    // teleport the body back (the very defect being fixed). One honest,
    // fully-plumbed traveled pass instead.
    enriched.loop = false;
    notes.push(
      'loop-travel: a looping plan cannot carry net travel (the wrap would teleport) — resolved as one traveled pass that brakes to a stop',
    );
  }

  // ENTRY / BRAKE RAMPS: a plan whose first (last) keyframe is already a
  // mid-stride pose reaches (leaves) it over the deterministic initiation +
  // step-off (termination) timing class, so the entry eases from a genuine
  // standstill (the trajectory's first knot is a stop; the entry-reach root
  // cancellation spreads with it) and the settle decelerates instead of
  // freezing at stride speed. Mid-stride = a reciprocal hip split at the
  // boundary keyframe; a plan that already authors a slow boundary keeps it.
  const splitAt = (kf: SequenceKeyframe): number => {
    const { l, r } = hipTargets(kf);
    return l != null && r != null ? Math.abs(l - r) : 0;
  };
  const first = enriched.keyframes[0]!;
  if (splitAt(first) >= GAIT_RECIPROCAL_MIN_DEG && (first.durationMs ?? 0) < GAIT_ENRICH_ENTRY_MS) {
    enriched.keyframes = [{ ...first, durationMs: GAIT_ENRICH_ENTRY_MS }, ...enriched.keyframes.slice(1)];
    notes.push(
      `gait plumbing attached: entry eased over ${GAIT_ENRICH_ENTRY_MS} ms (the plan starts at a mid-stride pose)`,
    );
  }
  const lastIdx = enriched.keyframes.length - 1;
  const last = enriched.keyframes[lastIdx]!;
  if (splitAt(last) >= GAIT_RECIPROCAL_MIN_DEG && (last.durationMs ?? 0) < GAIT_ENRICH_BRAKE_MS) {
    enriched.keyframes = [
      ...enriched.keyframes.slice(0, lastIdx),
      { ...last, durationMs: GAIT_ENRICH_BRAKE_MS },
    ];
    notes.push(
      `gait plumbing attached: final step braked over ${GAIT_ENRICH_BRAKE_MS} ms (the plan ends at a mid-stride pose)`,
    );
  }

  // TRAVEL HEADING from the authored drift direction (0 = straight ahead +Z is
  // the derivations' default and is omitted, keeping the common case
  // byte-minimal). Folded into the keyframe root yaw ONLY when the plan
  // authors no orients at all — never override an authored field.
  const headingDeg = Math.round((Math.atan2(netX, netZ) * 180) / Math.PI * 10) / 10;
  if (Math.abs(headingDeg) > 1) {
    const authorsOrient = motion.keyframes.some((k) => k.root?.orient != null || k.posture != null);
    if (!authorsOrient) {
      enriched.headingDeg = headingDeg;
      enriched.keyframes = enriched.keyframes.map((k) => ({
        ...k,
        root: { ...(k.root ?? {}), orient: { ...(k.root?.orient ?? {}), yawDeg: headingDeg } },
      }));
      notes.push(`gait plumbing attached: travel heading ${headingDeg}° from the authored drift direction`);
    }
  }

  return {
    motion: enriched,
    deriveStanceSchedule: true,
    stanceByKf: analysis.stanceByKf,
    notes,
  };
}

/** The note the resolver appends when {@link deriveGaitStanceSchedule}
 *  successfully attaches the derived windows + contacts (kept separate from
 *  {@link planGaitEnrichment}'s notes because the schedule is only derivable
 *  once keyframe timing has resolved). */
export const GAIT_SCHEDULE_NOTE =
  'gait plumbing attached: stance windows + foot-plant contacts derived from the reciprocal hip pattern';

/** The derived stance schedule + foot-plant contacts for an enriched gait. */
export interface DerivedGaitStanceSchedule {
  gaitStanceWindowsMs: { foot: string; fromMs: number; toMs: number }[];
  contacts: StanceContact[];
}

/**
 * Build the stance-window schedule + matching foot-plant contacts from the
 * RESOLVED keyframe timing (durations after the velocity floor — the authored
 * clock the sampler/stage scale by `authoredToTrajectoryTimeScale`, so the
 * derived windows ride the same time base as every other declared-ms field)
 * and the per-keyframe stance sides from {@link analyzeGaitPlan}. Consecutive
 * same-side spans merge into one window; contacts mirror the windows exactly,
 * so the pinned foot and the travel/shuttle derivations follow ONE schedule.
 * Returns null when the resolved keyframe count no longer matches the analysis
 * (e.g. a plan that authored `peakAt` leads was expanded) — enrichment then
 * simply omits the schedule rather than guessing.
 */
export function deriveGaitStanceSchedule(
  resolvedKeyframes: { durationMs: number; holdMs?: number }[],
  stanceByKf: ('L' | 'R')[],
): DerivedGaitStanceSchedule | null {
  if (resolvedKeyframes.length !== stanceByKf.length || stanceByKf.length === 0) return null;
  const windows: { foot: string; fromMs: number; toMs: number }[] = [];
  let t = 0;
  for (let i = 0; i < resolvedKeyframes.length; i += 1) {
    const kf = resolvedKeyframes[i]!;
    const from = t;
    t += (kf.durationMs ?? 0) + (kf.holdMs ?? 0);
    const foot = stanceByKf[i] === 'L' ? 'L_Foot' : 'R_Foot';
    const last = windows[windows.length - 1];
    if (last && last.foot === foot) last.toMs = t;
    else windows.push({ foot, fromMs: from, toMs: t });
  }
  const valid = windows.filter((w) => w.toMs > w.fromMs);
  if (!valid.length) return null;
  return {
    gaitStanceWindowsMs: valid,
    contacts: valid.map((w) => ({ foot: w.foot, fromMs: w.fromMs, toMs: w.toMs })),
  };
}
