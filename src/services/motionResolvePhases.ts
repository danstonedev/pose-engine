/**
 * Resolution PHASES for {@link resolveComposedMotion} (services/motionSequence).
 *
 * `resolveComposedMotion` is the single truth path both the live stage
 * (ExamStage3D.stepTrajectory) and the offline sampler
 * (motionRecording.sampleComposedMotion) run a {@link ComposedMotion} through,
 * so the two can never disagree about what a motion IS. This module holds that
 * path's ordered phases as named functions, each taking and returning EXPLICIT
 * state instead of closing over the resolver's mutable locals, so the resolver
 * itself reads as the pipeline it always was:
 *
 *   validate shape → travel sugar → gait plumbing → entry-heading rebase →
 *   gaze → peak-timing → relaxed hands → per-keyframe resolve (clamp + local
 *   velocity floor) → loop-wrap floor → whole-plan re-timing → guarding/sway
 *   bake → gait schedule → assemble → artifact re-timing
 *
 * STRUCTURAL ONLY. Every phase here is the resolver's original code moved
 * verbatim — no number, default or ordering changed — because a behaviour drift
 * in this path makes recordings diverge from what the stage plays, the silent
 * class of bug this layer exists to prevent. The phases that are genuinely pure
 * (shape validation, the entry-heading rebase, the loop-wrap floor, the
 * whole-plan dilation, the result assembly, the authored→resolved time remap)
 * are exported and directly unit-tested; the ones that are in-place mutators
 * mutate the fresh objects the resolver owns, matching `bakeGuardingSway`'s
 * house convention.
 *
 * Pure math on plain data — no scene, no Svelte.
 */
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { DerivedGaitStanceSchedule } from './gaitEnrichment';
import { resolveCommandTarget } from './movementCommand';
import type { RomScenarioConstraints } from './romConstraints';
import {
  MAX_KEYFRAMES,
  MAX_KEYFRAME_MS,
  MAX_TARGETS_PER_KEYFRAME,
  MIN_KEYFRAME_MS,
  VELOCITY_CLASS_CAPS,
  isRelaxedHandAdd,
  minKeyframeMsFor,
  rebaseMotionYaw,
  resolveKeyframeRoot,
  rootYawDegFromQuat,
  type ComposedMotion,
  type ResolveComposedOptions,
  type ResolvedComposedMotion,
  type ResolvedSequenceKeyframe,
  type SequenceTargetOutcome,
  type StanceMode,
} from './motionSequence';

const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ── PHASE 1: shape + limits ─────────────────────────────────────────────────

/**
 * Validate a composed motion's OUTER shape — the checks that refuse before any
 * transform runs. Returns the refusal reason, or `null` when the motion is
 * well-shaped enough to enter the pipeline. Per-keyframe shape errors are
 * caught later, by {@link resolveKeyframePlan}. Pure.
 */
export function validateComposedShape(motion: ComposedMotion): string | null {
  if (!motion || !Array.isArray(motion.keyframes)) return 'invalid-shape';
  if (motion.keyframes.length === 0) return 'no-keyframes';
  if (motion.keyframes.length > MAX_KEYFRAMES) return `too-many-keyframes (max ${MAX_KEYFRAMES})`;
  return null;
}

// ── PHASE 2: persistent heading — entry-yaw rebase (SEAM-1) ─────────────────

/** Numerical guard: live entry yaws below this (deg) skip the rebase, so a
 *  motion entering at its expected heading stays byte-identical. */
const HEADING_REBASE_EPS_DEG = 0.01;

/** Normalize a yaw delta to (−180, 180] so the rebase always takes the short
 *  way around (an entry of −179° vs an expected 180° is a +1° correction, not
 *  a −359° spin). */
export function normalizeYawDeg(d: number): number {
  let n = ((d % 360) + 360) % 360; // [0, 360)
  if (n > 180) n -= 360; // (−180, 180]
  return n;
}

/** The heading (deg) a motion's author assumed the body faces at t=0: the
 *  constant `headingDeg`, else the heading profile's first point, else 0. The
 *  persistent-heading rebase corrects by (live entry yaw − this), so a motion
 *  already authored for its live entry (the TUG's `headingDeg:180` walk-back,
 *  a figure-eight's second lobe) rebases by ~0 and stays as authored. */
export function motionEntryHeadingDeg(motion: ComposedMotion): number {
  if (typeof motion.headingDeg === 'number' && Number.isFinite(motion.headingDeg)) {
    return motion.headingDeg;
  }
  const p0 = Array.isArray(motion.headingProfileMs) ? motion.headingProfileMs[0] : undefined;
  if (p0 && typeof p0.headingDeg === 'number' && Number.isFinite(p0.headingDeg)) {
    return p0.headingDeg;
  }
  return 0;
}

/**
 * PERSISTENT HEADING (SEAM-1): a heading-inheriting motion (`inheritHeading` —
 * the gait builders set it) that starts from the CURRENT pose is rebased by the
 * body's live entry yaw, so "walk forward" means forward FROM THE CURRENT
 * FACING — a walk chained after a 180° turn continues away, instead of whipping
 * the body back to the authored world yaw and walking off the pre-turn heading.
 * The correction is (live yaw − the heading the author assumed at entry),
 * shortest way around, so a motion already authored for its entry (a
 * `headingDeg:180` walk-back entered facing 180) rebases by ~0.
 *
 * Applied inside the ONE resolution path the offline sampler and the live stage
 * both consume — so the two can never disagree on the heading frame. Strictly
 * opt-in + guarded: unflagged motions, 'neutral' starts, an un-threaded root, an
 * undefined heading (a lying body), and sub-epsilon deltas all skip the rebase
 * and return the input motion unchanged (identity). Pure.
 */
export function applyEntryHeadingRebase(
  motion: ComposedMotion,
  currentRoot: ResolveComposedOptions['currentRoot'],
): ComposedMotion {
  if (motion.inheritHeading !== true || motion.startFrom === 'neutral' || !currentRoot?.quat) {
    return motion;
  }
  const entryYaw = rootYawDegFromQuat(currentRoot.quat);
  if (entryYaw == null) return motion;
  const delta = normalizeYawDeg(entryYaw - motionEntryHeadingDeg(motion));
  if (Math.abs(delta) > HEADING_REBASE_EPS_DEG) return rebaseMotionYaw(motion, delta);
  return motion;
}

// ── PHASE 3: per-keyframe resolve — clamp + local velocity floor ────────────

/** One keyframe's AUTHORED clock + its velocity/MIN floor, kept parallel to the
 *  resolved keyframes for the whole-plan re-timing decision (AI-TIME-01) and
 *  for the authored→resolved artifact remap. */
export interface KeyframeTiming {
  authoredMs: number;
  authoredHoldMs: number;
  floorMs: number;
}

/** The live/scenario state {@link resolveKeyframePlan} resolves against. */
export interface KeyframePlanContext {
  variantCfg?: BodyVariantConfig;
  /** Per-scenario ROM constraints threaded into every target's
   *  {@link resolveCommandTarget} (normative ∩ scenario). */
  constraints?: RomScenarioConstraints | null;
  /** CURRENT measured angles keyed `joint.motion`, seeding each target's
   *  velocity 'from' value (cross-motion continuity). Omit for a 'neutral'
   *  start — every joint then measures from 0°, the registry's clinical zero. */
  seedAngles?: Record<string, number>;
}

/** Everything the per-keyframe pass produces, handed forward explicitly. */
export interface KeyframePlan {
  /** Shape-refusal reason for the WHOLE motion, or null when every keyframe
   *  validated. When set, every other field is meaningless. */
  refusal: string | null;
  keyframes: ResolvedSequenceKeyframe[];
  outcomes: SequenceTargetOutcome[];
  /** Outcomes belonging to relaxedHands background adds — excluded from the
   *  achievability contract and from a refused motion's outcome report. */
  relaxedOutcomes: Set<SequenceTargetOutcome>;
  kfTiming: KeyframeTiming[];
  /** Surviving AUTHORED targets (background hand adds never count). */
  survivors: number;
  /** Keyframes carrying a root directive or explicit stance change — a motion
   *  built only of those (e.g. "lie down on your back": root pitch −90, zero
   *  joint targets) is a VALID posture-only movement, never a refusal. */
  postureDirectives: number;
}

/**
 * Resolve every keyframe: validate its shape, clamp each target through
 * {@link resolveCommandTarget} (the SAME truth path as single commands —
 * normative ROM ∩ scenario constraints, the refusal rule, the painful arc), and
 * apply the LOCAL realistic-velocity duration floor.
 *
 * Refused targets are DROPPED from their keyframe but fully REPORTED in
 * `outcomes`; the surviving siblings still play. Overflow past
 * {@link MAX_TARGETS_PER_KEYFRAME} is non-fatal and reported per-target with
 * reason 'target-limit'. A malformed keyframe refuses the whole motion via
 * `refusal`.
 */
export function resolveKeyframePlan(motion: ComposedMotion, ctx: KeyframePlanContext): KeyframePlan {
  const motionStance: StanceMode = motion.stance === 'planted' ? 'planted' : 'floating';
  const outcomes: SequenceTargetOutcome[] = [];
  const relaxedOutcomes = new Set<SequenceTargetOutcome>();
  const resolvedKeyframes: ResolvedSequenceKeyframe[] = [];
  const kfTiming: KeyframeTiming[] = [];
  /** Last clamped value per `joint.motion` — the previous keyframe's position
   *  for the velocity check. Seeded from the CURRENT measured angle (cross-motion
   *  continuity) when the caller threads them; otherwise from neutral 0°. */
  const lastClamped = new Map<string, number>();
  if (ctx.seedAngles) {
    for (const [key, deg] of Object.entries(ctx.seedAngles)) {
      if (typeof deg === 'number' && Number.isFinite(deg)) lastClamped.set(key, deg);
    }
  }
  let survivors = 0;
  let postureDirectives = 0;
  const fail = (refusal: string): KeyframePlan => ({
    refusal,
    keyframes: resolvedKeyframes,
    outcomes,
    relaxedOutcomes,
    kfTiming,
    survivors,
    postureDirectives,
  });

  for (const [ki, kf] of motion.keyframes.entries()) {
    if (!kf || typeof kf !== 'object') {
      return fail(`keyframe ${ki}: needs at least one target, root, or stance change`);
    }
    // EFFECTIVE root = raw root.orient/translateM merged with the semantic
    // travel/posture sugar (raw wins per component; see resolveKeyframeRoot).
    // A malformed raw root OR a malformed semantic input refuses here, through
    // the SAME shape-error path as everything else.
    const kfRoot = resolveKeyframeRoot(kf);
    if (kfRoot === 'invalid') {
      return fail(`keyframe ${ki}: malformed root transform or travel/posture`);
    }
    const hasStanceChange = kf.stance === 'planted' || kf.stance === 'floating';
    const requestedTargets = Array.isArray(kf.targets) ? kf.targets : [];
    // A keyframe is valid with ≥1 target OR a root directive OR a stance
    // change (posture-only keyframes carry the previous joint pose forward).
    if (requestedTargets.length === 0 && !kfRoot && !hasStanceChange) {
      return fail(`keyframe ${ki}: needs at least one target, root, or stance change`);
    }
    if (kfRoot || hasStanceChange) postureDirectives += 1;
    if (!isFiniteNum(kf.durationMs) || kf.durationMs < 0) {
      return fail(`keyframe ${ki}: durationMs must be a non-negative number`);
    }
    if (kf.holdMs != null && (!isFiniteNum(kf.holdMs) || kf.holdMs < 0)) {
      return fail(`keyframe ${ki}: holdMs must be a non-negative number`);
    }
    if (kf.velocityClass != null && VELOCITY_CLASS_CAPS[kf.velocityClass] == null) {
      return fail(`keyframe ${ki}: unknown velocityClass`);
    }
    const velCap = VELOCITY_CLASS_CAPS[kf.velocityClass ?? 'deliberate'];

    // Overflow beyond MAX_TARGETS_PER_KEYFRAME is NON-FATAL: the first N (in the
    // deterministic order received) play; the rest are refused per-target with
    // reason 'target-limit' — the keyframe and plan survive. The truncation is
    // by ARRIVAL ORDER, which carries no notion of importance, so for a gait it
    // amputates whichever side the coordinator appends last rather than shedding
    // anything it could afford to lose. See the note on the constant.
    const keptTargets = requestedTargets.slice(0, MAX_TARGETS_PER_KEYFRAME);
    const overflowTargets = requestedTargets.slice(MAX_TARGETS_PER_KEYFRAME);

    const targets: ResolvedSequenceKeyframe['targets'] = [];
    let maxDeltaDeg = 0;
    for (const t of keptTargets) {
      if (!t || typeof t.joint !== 'string' || typeof t.motion !== 'string') {
        return fail(`keyframe ${ki}: malformed target`);
      }
      const r = resolveCommandTarget(
        { action: 'set-joint', joint: t.joint, motion: t.motion, targetDegrees: t.targetDegrees },
        ctx.variantCfg,
        // Planted (closed-chain) = weight-bearing: ankle DF may reach its WB max.
        // Falls back to the motion-level stance when a keyframe doesn't set its own
        // (templates carry stance at the top level, not per phase). Scenario
        // constraints (per-patient ROM overrides) are threaded so composed motion
        // clamps to normative ∩ scenario, the same truth path as single commands.
        {
          weightBearing: (kf.stance ?? motion.stance) === 'planted',
          constraints: ctx.constraints,
        },
      );
      const outcome: SequenceTargetOutcome = {
        keyframe: ki,
        joint: t.joint,
        motion: t.motion,
        status: r.status,
        requestedDegrees: t.targetDegrees,
      };
      if (r.clampedDegrees != null) outcome.clampedDegrees = r.clampedDegrees;
      if (r.limitedBy != null) outcome.limitedBy = r.limitedBy;
      if (r.painful != null) outcome.painful = r.painful;
      if (r.reason != null) outcome.reason = r.reason;
      const isRelaxedAdd = isRelaxedHandAdd(t);
      if (isRelaxedAdd) relaxedOutcomes.add(outcome);
      outcomes.push(outcome);

      if (r.status === 'refused' || r.clampedDegrees == null) continue; // dropped, reported

      const key = `${t.joint}.${t.motion}`;
      const from = lastClamped.get(key) ?? 0; // first command of a joint: from neutral
      // A relaxedHands background add never PACES the keyframe either. The
      // velocity floor exists so an authored movement cannot be played faster
      // than a body can move it; the resting hand is not the movement, it is
      // posture that rides along, and the digits are light and fast in a way the
      // 240°/s whole-limb cap does not describe. Letting it in meant a deeper
      // resting curl silently stretched every short keyframe in the app — a hip
      // raise paced by how far the fingers had to travel. Same reasoning that
      // already keeps these adds out of `survivors` below.
      if (!isRelaxedAdd) maxDeltaDeg = Math.max(maxDeltaDeg, Math.abs(r.clampedDegrees - from));
      lastClamped.set(key, r.clampedDegrees);
      // A joint.motion re-commanded within one keyframe: last wins (absolute).
      const dup = targets.findIndex((x) => x.joint === t.joint && x.motion === t.motion);
      if (dup >= 0) targets.splice(dup, 1);
      targets.push({ joint: t.joint, motion: t.motion, clampedDegrees: r.clampedDegrees });
      // A relaxedHands background add never counts toward achievability — a
      // motion whose AUTHORED targets all refuse must still refuse as a whole
      // (the cosmetic resting hand cannot rescue a bogus plan into 'ok').
      if (!isRelaxedAdd) survivors += 1;
    }
    for (const t of overflowTargets) {
      outcomes.push({
        keyframe: ki,
        joint: t && typeof t.joint === 'string' ? t.joint : '',
        motion: t && typeof t.motion === 'string' ? t.motion : '',
        status: 'refused',
        requestedDegrees: t && typeof t.targetDegrees === 'number' ? t.targetDegrees : Number.NaN,
        reason: 'target-limit',
      });
    }

    // Realistic timing: the fastest joint may not exceed this keyframe's
    // velocity-class cap (default 'deliberate' = 240°/s). This is the LOCAL
    // floor; a plan where MOST keyframes violate is instead re-timed as a
    // whole after the loop (AI-TIME-01), which overwrites these durations
    // with one uniform dilation so the authored rhythm survives.
    // Both halves of the floor follow the keyframe's velocity class: the angular
    // cap AND the absolute minimum. A 'deliberate' keyframe (the default) keeps
    // the historic max(150, delta/240) exactly.
    const floorMs = Math.max(
      minKeyframeMsFor(kf.velocityClass),
      (maxDeltaDeg / velCap) * 1000,
    );
    kfTiming.push({ authoredMs: kf.durationMs, authoredHoldMs: kf.holdMs ?? 0, floorMs });
    let durationMs = kf.durationMs < floorMs ? Math.ceil(floorMs) : kf.durationMs;
    // Any adjustment away from the request — raised to the floor OR lowered to
    // the playability cap — is reported so the caller can narrate honestly.
    let timingAdjusted = kf.durationMs < floorMs;
    // Playability beats both the request AND the velocity floor: a keyframe may
    // never exceed MAX_KEYFRAME_MS (an unbounded duration would freeze a host's
    // serialized command chain forever).
    if (durationMs > MAX_KEYFRAME_MS) {
      durationMs = MAX_KEYFRAME_MS;
      timingAdjusted = true;
    }
    const holdMs = Math.min(kf.holdMs ?? 0, MAX_KEYFRAME_MS);
    if ((kf.holdMs ?? 0) > MAX_KEYFRAME_MS) timingAdjusted = true;
    resolvedKeyframes.push({
      targets,
      durationMs,
      holdMs,
      ...(kf.velocityClass != null ? { velocityClass: kf.velocityClass } : {}),
      ...(timingAdjusted ? { timingAdjusted: true } : {}),
      ...(kfRoot ? { root: kfRoot } : {}),
      stance: kf.stance === 'planted' || kf.stance === 'floating' ? kf.stance : motionStance,
      ...(kf.groundingPosture ? { groundingPosture: kf.groundingPosture } : {}),
    });
  }

  return {
    refusal: null,
    keyframes: resolvedKeyframes,
    outcomes,
    relaxedOutcomes,
    kfTiming,
    survivors,
    postureDirectives,
  };
}

// ── PHASE 4: loop-wrap velocity floor (SEAM-7 / DET-RES-01) ─────────────────

/**
 * A looping gait's FIRST keyframe is entered, at playback, from the loop WRAP
 * (the last keyframe flows velocity-continuously back into it — buildLoop-
 * Trajectory records one seamless period, no from-neutral intro). The per-
 * keyframe floor in {@link resolveKeyframePlan}, though, seeds kf0 from NEUTRAL,
 * so it charges kf0 the full from-rest delta the wrap never actually asks for:
 * the walk's contact keyframe reads a 40° knee swing from 0° but only 35° from
 * its terminal-stance predecessor. That over-conservative floor (a) sits a hair
 * under the authored duration — a spurious floor-margin cliff (SEAM-7: walk kf0
 * at 1.3 ms margin) — and (b) under pace floors kf0 while its symmetric mirror
 * keyframe (seeded from ITS real predecessor) does not, injecting a one-sided
 * step-time limp (DET-RES-01: ~0.4% at speed 1.05, growing with pace). Re-seed
 * kf0's floor from the loop-wrap pose so the cycle floors SYMMETRICALLY (both
 * mirror keyframes, or — as with the shipped walk — neither): each commanded
 * joint's "from" is its value at the END of the cycle (the last keyframe that
 * sets it, carry-forward semantics; a joint only kf0 touches wraps to its own
 * value → zero delta). Only kf0's floor moves; kf1…kfN already saw their true
 * predecessors. Non-looping motions have a real from-rest/from-current entry,
 * so they are untouched. Speed-1 templates are byte-identical (the walk's kf0
 * is unfloored either way — the wrap floor only relaxes it further).
 *
 * Mutates `keyframes[0]` and `kfTiming[0]` in place (the resolver owns these
 * fresh objects); a no-op for a non-looping or single-keyframe plan.
 */
export function applyLoopWrapFloor(
  keyframes: ResolvedSequenceKeyframe[],
  kfTiming: KeyframeTiming[],
  isLoop: boolean,
): void {
  if (!isLoop || keyframes.length < 2) return;
  const kf0 = keyframes[0]!;
  const velCap0 = VELOCITY_CLASS_CAPS[kf0.velocityClass ?? 'deliberate'];
  // The pose the loop wraps INTO kf0 from: the latest value set for each
  // joint.motion, scanning keyframes backward (carry-forward = last wins).
  const wrapFrom = new Map<string, number>();
  for (let i = keyframes.length - 1; i >= 1; i -= 1) {
    for (const t of keyframes[i]!.targets) {
      const key = `${t.joint}.${t.motion}`;
      if (!wrapFrom.has(key)) wrapFrom.set(key, t.clampedDegrees);
    }
  }
  let wrapDelta = 0;
  for (const t of kf0.targets) {
    // A joint no later keyframe re-commands wraps to kf0's OWN value (set at
    // kf0, carried unchanged round the cycle, back to kf0) → zero delta.
    const from = wrapFrom.get(`${t.joint}.${t.motion}`) ?? t.clampedDegrees;
    wrapDelta = Math.max(wrapDelta, Math.abs(t.clampedDegrees - from));
  }
  const wrapFloor = Math.max(
    minKeyframeMsFor(kf0.velocityClass),
    (wrapDelta / velCap0) * 1000,
  );
  const t0 = kfTiming[0]!;
  t0.floorMs = wrapFloor; // the whole-plan violator count reads THIS floor
  // Recompute kf0's duration + honesty flag from the wrap floor, on the same
  // rules as the main loop (floor raise, MAX cap, hold cap).
  let dur0 = t0.authoredMs < wrapFloor ? Math.ceil(wrapFloor) : t0.authoredMs;
  let adjusted0 = t0.authoredMs < wrapFloor;
  if (dur0 > MAX_KEYFRAME_MS) {
    dur0 = MAX_KEYFRAME_MS;
    adjusted0 = true;
  }
  if (t0.authoredHoldMs > MAX_KEYFRAME_MS) adjusted0 = true;
  kf0.durationMs = dur0;
  if (adjusted0) kf0.timingAdjusted = true;
  else delete kf0.timingAdjusted;
}

// ── PHASE 5: whole-plan re-timing (AI-TIME-01) ──────────────────────────────

/**
 * The per-keyframe floor stretches each violating keyframe by its OWN ratio, so
 * a uniformly-too-fast plan (an AI's "quick" 8-phase gait cycle) has its phases
 * floored by DIFFERENT ratios — the authored Perry-style phase PROPORTIONS
 * (e.g. 168/160/236/236 ms per half-cycle) flatten toward a uniform metronome
 * and the gait loses its rhythm. When a STRICT MAJORITY of the keyframes violate
 * their floors (violators × 2 > keyframes, and ≥ 2 keyframes exist), the plan as
 * a whole asked for a faster tempo than the velocity governor allows — so re-time
 * the WHOLE plan by the single worst stretch ratio instead: uniform time dilation
 * preserves every phase proportion, and each dilated duration still clears its own
 * floor by construction (dur·r ≥ dur·(floor/dur)).
 *
 * The threshold is deliberately MAJORITY-ONLY (documented decision): an
 * isolated violation in an otherwise-realistic plan keeps the local floor —
 * dilating a slow plan wholesale to fix one rushed keyframe would
 * needlessly slow everything (the existing local behavior is kept, tested).
 * Cyclic-ness alone deliberately does NOT trigger it either: a paced looping
 * template's one-sided floor bump is instead cured at its SOURCE by
 * {@link applyLoopWrapFloor} (SEAM-7 / DET-RES-01), which re-seeds kf0 from its
 * real playback predecessor so the cycle floors symmetrically — no wholesale
 * dilation (and no cadence loss) needed for the paced walk.
 *
 * HONESTY + TIME-BASE COHERENCE: every re-timed keyframe is flagged
 * `timingAdjusted` (the same honesty note the local floor uses), holds
 * dilate with durations (ONE clock), and the ms-authored artifacts declared
 * against that clock — `contacts`, `gaitStanceWindowsMs`, `headingProfileMs` —
 * are re-timed by {@link buildAuthoredToResolvedRemap}, so they stay on their
 * phases and the shared authored→trajectory totals mapping (motionRecording
 * `authoredToTrajectoryTimeScale`, which reads THESE resolved keyframes) keeps
 * them aligned by construction. A zero-duration keyframe is a teleport request,
 * not a rhythm — it keeps its local MIN floor and never drives (or receives) the
 * dilation.
 *
 * Mutates `keyframes` in place; returns the applied stretch ratio (1 = no
 * dilation, the local floors stand).
 */
export function applyWholePlanRetiming(
  keyframes: ResolvedSequenceKeyframe[],
  kfTiming: readonly KeyframeTiming[],
): number {
  let planStretch = 1;
  const n = kfTiming.length;
  const violators = kfTiming.filter((t) => t.authoredMs < t.floorMs).length;
  if (n >= 2 && violators * 2 > n) {
    // Zero-duration keyframes never drive the ratio (a teleport request, not
    // a rhythm); if ALL violators were degenerate, planStretch stays 1 and
    // the local floors above stand.
    for (const t of kfTiming) {
      if (t.authoredMs > 0) planStretch = Math.max(planStretch, t.floorMs / t.authoredMs);
    }
    if (planStretch > 1) {
      for (let i = 0; i < keyframes.length; i += 1) {
        const rk = keyframes[i]!;
        const t = kfTiming[i]!;
        if (t.authoredMs > 0) {
          rk.durationMs = Math.min(MAX_KEYFRAME_MS, Math.ceil(t.authoredMs * planStretch));
          rk.timingAdjusted = true;
        }
        if (t.authoredHoldMs > 0) {
          rk.holdMs = Math.min(MAX_KEYFRAME_MS, Math.ceil(t.authoredHoldMs * planStretch));
          rk.timingAdjusted = true;
        }
      }
    }
  }
  return planStretch;
}

// ── PHASE 6: assemble the resolved result ──────────────────────────────────

/** The resolved parts {@link assembleResolvedMotion} folds together with the
 *  authored motion's pass-through fields. */
export interface ResolvedMotionParts {
  keyframes: ResolvedSequenceKeyframe[];
  outcomes: SequenceTargetOutcome[];
  startFrom: 'current' | 'neutral';
  /** Gait-enrichment stance schedule derived from the FINAL resolved clock, or
   *  null when the plan needs none. Overrides the authored contacts/windows
   *  (only ever present for a plan that authored neither). */
  derivedSchedule: DerivedGaitStanceSchedule | null;
  /** Honesty notes for every resolve-time attachment/conversion. */
  gaitNotes: string[];
}

/**
 * Fold the resolved keyframes/outcomes together with the authored motion's
 * validated pass-through fields into the final {@link ResolvedComposedMotion}.
 * Every clamp here is a believability band on a PASS-THROUGH value (reps 1..50,
 * gait vertical 1..12 cm, lateral shuttle ≤ 6 cm), and every filter drops
 * malformed entries rather than playing along garbage. Pure — nothing is
 * mutated, including the input motion.
 */
export function assembleResolvedMotion(
  motion: ComposedMotion,
  parts: ResolvedMotionParts,
): ResolvedComposedMotion {
  const { keyframes, outcomes, startFrom, derivedSchedule, gaitNotes } = parts;
  return {
    status: 'ok',
    ...(motion.name ? { name: motion.name } : {}),
    keyframes,
    outcomes,
    loop: !!motion.loop,
    // FINITE reps: clamped to a sane ceiling (a long set, not an accidental
    // forever-run); 1 when unset. Ignored downstream when `loop` is true.
    reps:
      typeof motion.reps === 'number' && Number.isFinite(motion.reps)
        ? Math.max(1, Math.min(50, Math.round(motion.reps)))
        : 1,
    startFrom,
    // POSTURE ENDPOINTS: pass the authored start/end posture through so the
    // executor commits it transactionally (PR 1 runtime foundation).
    ...(motion.startPosture ? { startPosture: motion.startPosture } : {}),
    ...(motion.endPosture ? { endPosture: motion.endPosture } : {}),
    ...(motion.modifiers ? { modifiers: motion.modifiers } : {}),
    ...(Array.isArray(motion.contacts) && motion.contacts.length
      ? { contacts: motion.contacts.filter((c) => c && typeof c.foot === 'string') }
      : {}),
    // CALIBRATED GAIT VERTICAL: clamped to a believable band (1-12 cm) so a
    // request can never flatten the walk to a slide or balloon it to a hop.
    ...(typeof motion.verticalCalibrationCm === 'number' &&
    Number.isFinite(motion.verticalCalibrationCm)
      ? { verticalCalibrationCm: Math.max(1, Math.min(12, motion.verticalCalibrationCm)) }
      : {}),
    ...(motion.footDrivenTravel ? { footDrivenTravel: true } : {}),
    // MEDIO-LATERAL SHUTTLE: clamped to a believable band (0-6 cm) — a request
    // can never swing the pelvis outside its own base of support. The planned
    // stance windows (when authored) pass through with malformed entries dropped.
    ...(typeof motion.lateralShuttleCm === 'number' &&
    Number.isFinite(motion.lateralShuttleCm) &&
    motion.lateralShuttleCm > 0
      ? { lateralShuttleCm: Math.min(6, motion.lateralShuttleCm) }
      : {}),
    // GAIT CYCLE window: pass through when well formed. Consumers that phase
    // against normative curves need it and skip without it, so a malformed one is
    // dropped rather than half-trusted.
    ...(motion.gaitCycleMs != null &&
    Number.isFinite(motion.gaitCycleMs.fromMs) &&
    Number.isFinite(motion.gaitCycleMs.toMs) &&
    motion.gaitCycleMs.toMs > motion.gaitCycleMs.fromMs &&
    typeof motion.gaitCycleMs.leadFoot === 'string'
      ? { gaitCycleMs: { ...motion.gaitCycleMs } }
      : {}),
    ...(motion.gaitRegime === 'walk' || motion.gaitRegime === 'run'
      ? { gaitRegime: motion.gaitRegime }
      : {}),
    ...(Array.isArray(motion.gaitStanceWindowsMs) && motion.gaitStanceWindowsMs.length
      ? {
          gaitStanceWindowsMs: motion.gaitStanceWindowsMs.filter(
            (w) =>
              w != null &&
              typeof w.foot === 'string' &&
              Number.isFinite(w.fromMs) &&
              Number.isFinite(w.toMs) &&
              w.toMs > w.fromMs,
          ),
        }
      : {}),
    ...(motion.settleEnds ? { settleEnds: true } : {}),
    // Heel-strike accent: only the explicit opt-OUT survives resolution (the
    // default-on behaviour is the absence of the flag).
    ...(motion.heelStrikeAccent === false ? { heelStrikeAccent: false } : {}),
    // TRAVEL HEADING: pass through only a finite, non-zero heading (0 IS the
    // default straight-ahead — omitting it keeps heading-0 plans byte-identical).
    ...(typeof motion.headingDeg === 'number' &&
    Number.isFinite(motion.headingDeg) &&
    motion.headingDeg !== 0
      ? { headingDeg: motion.headingDeg }
      : {}),
    // CURVED TRAVEL HEADING: pass through only a well-formed profile — ≥2
    // finite, time-ordered points (anything less is not a curve; the constant
    // headingDeg above already covers it). Malformed entries drop the whole
    // profile rather than curving along garbage.
    ...(() => {
      const prof = motion.headingProfileMs;
      if (!Array.isArray(prof) || prof.length < 2) return {};
      const ok = prof.every(
        (p, i) =>
          p != null &&
          Number.isFinite(p.tMs) &&
          Number.isFinite(p.headingDeg) &&
          (i === 0 || p.tMs >= prof[i - 1]!.tMs),
      );
      return ok
        ? { headingProfileMs: prof.map((p) => ({ tMs: p.tMs, headingDeg: p.headingDeg })) }
        : {};
    })(),
    ...(motion.flowIn ? { flowIn: true } : {}),
    ...(motion.balanceAssist ? { balanceAssist: true } : {}),
    ...(motion.weightedDescent ? { weightedDescent: true } : {}),
    ...(motion.holdUnmentioned ? { holdUnmentioned: true } : {}),
    // GAIT ENRICHMENT: the derived stance schedule + matching foot-plant
    // contacts (only ever present for a plumbing-free gait-shaped travel plan,
    // which by definition authored neither field — nothing is overridden), and
    // the honesty notes for every resolve-time attachment/conversion.
    ...(derivedSchedule
      ? {
          contacts: derivedSchedule.contacts,
          gaitStanceWindowsMs: derivedSchedule.gaitStanceWindowsMs,
        }
      : {}),
    ...(gaitNotes.length ? { notes: gaitNotes } : {}),
  };
}

// ── PHASE 7: artifact re-timing from resolved keyframe boundaries ──────────

/** Maps a time on the AUTHORED clock onto the RESOLVED clock. Non-finite and
 *  non-positive inputs pass through untouched. */
export type AuthoredTimeRemap = (t: number | undefined) => number | undefined;

/**
 * Build the piecewise-linear map from the AUTHORED cumulative keyframe
 * boundaries onto the RESOLVED ones (SEAM-7, part 2) — the per-keyframe-boundary
 * refinement of R1's authored→trajectory TOTAL mapping.
 *
 * The ms-authored artifacts (`contacts`, `gaitStanceWindowsMs`,
 * `headingProfileMs`) are declared at KEYFRAME BOUNDARIES on the AUTHORED clock;
 * any per-keyframe re-timing (the velocity floor, the loop-wrap floor, the
 * whole-plan dilation) shifts those boundaries, so every artifact time must be
 * remapped through this function. A window that ended AT the half-cycle keyframe
 * boundary still ends exactly there in the resolved clock — even when a SINGLE
 * isolated keyframe floored (the old uniform-ratio rescale only rode the
 * whole-plan dilation and left an isolated bump's windows behind). The shared
 * authored→trajectory totals factor then carries them onto trajectory time by
 * construction. Boundary-aligned times map EXACTLY (the authored artifacts
 * always are); non-finite whole-motion pins and negatives pass through.
 *
 * Returns `null` when NO keyframe boundary moved — the caller then skips the
 * remap entirely and stays byte-identical. Pure.
 */
export function buildAuthoredToResolvedRemap(
  kfTiming: readonly KeyframeTiming[],
  keyframes: readonly { durationMs: number; holdMs: number }[],
): AuthoredTimeRemap | null {
  const n = keyframes.length;
  const bAuth = new Array<number>(n);
  const bRes = new Array<number>(n);
  let accA = 0;
  let accR = 0;
  let reflowed = false;
  for (let i = 0; i < n; i += 1) {
    accA += kfTiming[i]!.authoredMs + kfTiming[i]!.authoredHoldMs;
    accR += keyframes[i]!.durationMs + keyframes[i]!.holdMs;
    bAuth[i] = accA;
    bRes[i] = accR;
    if (accA !== accR) reflowed = true;
  }
  if (!reflowed) return null;
  return (t: number | undefined): number | undefined => {
    if (typeof t !== 'number' || !Number.isFinite(t)) return t;
    if (t <= 0) return t; // start (0) and any negative pass through
    let prevA = 0;
    let prevR = 0;
    for (let i = 0; i < n; i += 1) {
      if (t <= bAuth[i]! + 1e-9) {
        const spanA = bAuth[i]! - prevA;
        const frac = spanA > 0 ? (t - prevA) / spanA : 0;
        return prevR + frac * (bRes[i]! - prevR);
      }
      prevA = bAuth[i]!;
      prevR = bRes[i]!;
    }
    // Past the last boundary: keep the tail's distance from cycle end.
    return t + (bRes[n - 1]! - bAuth[n - 1]!);
  };
}

/**
 * Apply an authored→resolved time remap to a resolved motion's ms-authored
 * artifacts, in place. Mutates only the artifact arrays (fresh copies replace
 * them); the keyframes are untouched. See
 * {@link buildAuthoredToResolvedRemap} for when this must run.
 */
export function remapResolvedArtifactTimes(
  resolved: ResolvedComposedMotion,
  remapMs: AuthoredTimeRemap,
): void {
  if (resolved.contacts) {
    resolved.contacts = resolved.contacts.map((c) => ({
      ...c,
      ...(c.fromMs != null ? { fromMs: remapMs(c.fromMs)! } : {}),
      ...(c.toMs != null ? { toMs: remapMs(c.toMs)! } : {}),
    }));
  }
  if (resolved.gaitStanceWindowsMs) {
    resolved.gaitStanceWindowsMs = resolved.gaitStanceWindowsMs.map((w) => ({
      ...w,
      fromMs: remapMs(w.fromMs)!,
      toMs: remapMs(w.toMs)!,
    }));
  }
  if (resolved.headingProfileMs) {
    resolved.headingProfileMs = resolved.headingProfileMs.map((p) => ({
      ...p,
      tMs: remapMs(p.tMs)!,
    }));
  }
  if (resolved.gaitCycleMs) {
    resolved.gaitCycleMs = {
      ...resolved.gaitCycleMs,
      fromMs: remapMs(resolved.gaitCycleMs.fromMs)!,
      toMs: remapMs(resolved.gaitCycleMs.toMs)!,
    };
  }
}
