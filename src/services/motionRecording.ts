/**
 * Motion recording + timeline editing + kinematic export (simMOVE).
 *
 * Three pure, headless-testable layers over the composed-motion machinery:
 *
 * 1. OFFLINE SAMPLER — {@link sampleComposedMotion} replays a resolved
 *    composed motion through the SAME per-keyframe interpolation the stage
 *    uses ({@link composedTweenEase} + blendCustomPoseWithBaseline + the
 *    root slerp/lerp + the planted foot-pin), applying each sampled pose to
 *    a headless skeleton and MEASURING computeJointAngles per frame. The
 *    easing lives HERE and ExamStage3D imports it, so stage playback and
 *    offline sampling cannot diverge. Deterministic: same input → an
 *    identical recording — which is what makes AI cross-checking instant
 *    (no visual playback needed).
 *
 * 2. EDIT OPERATIONS — trim / split / bake-a-frame-edit / rename / concat,
 *    all pure and non-mutating (they return new recordings).
 *
 * 3. KINEMATIC EXPORT — {@link exportKinematics} turns a recording into a
 *    JSON-serializable dataset (angle-vs-time series, angular velocities,
 *    world trajectories, speeds, per-joint and per-bone summaries) whose
 *    field meanings are documented INSIDE the export (`schema`), so a second
 *    AI can interpret it without side-channel docs. {@link exportKinematicsCsv}
 *    is the compact spreadsheet twin.
 *
 * Pure THREE on plain data / live skeletons — no Svelte, no DOM.
 */
import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';
import {
  computeJointAngles,
  type JointAngleRestReference,
} from './jointAngles';
import {
  applyCustomPose,
  blendCustomPose,
  buildBoneByPoseKey,
  serializeCustomPose,
} from './poseRig';
import {
  buildFootPlant,
  solveFootPlant,
  solveFootPlantWeighted,
  PLANT_RELEASE_BLEND_MS,
  buildHandPlant,
  solveHandReach,
  type FootPlantSolver,
} from './footContact';
import { computeBodyCoMFromBones } from './centerOfMass';
import {
  buildSequencePoses,
  type ResolvedComposedMotion,
} from './motionSequence';
import {
  applyVerticalCalibration,
  applyWeightedDescent,
  captureFloorReference,
  captureFootFrames,
  deriveFootDrivenTravel,
  deriveGaitLateralShuttle,
  deriveHeelStrikeAccents,
  deriveVerticalCalibration,
  deriveWeightedDescent,
  FOOT_ROOT_DRIFT_M,
  headingProfileLookup,
  heelStrikeOffsetAt,
  NO_VERTICAL_CALIBRATION,
  pinRootToFloor,
  pinContactsToFloor,
  groundingContactsFor,
  plantStanceFoot,
  rotateRestReferenceByRoot,
  stanceFootDrift,
  weightedDescentApplies,
  type FootDrivenTravel,
  type HeelStrikeAccents,
  type LateralShuttle,
  type VerticalCalibration,
  type WeightedDescentReshape,
} from './rootMotion';
import { balanceCoordination } from './balanceCoordination';
import { composedTweenEase, stagedBlendWithBaseline } from './motionStagger';
export { stagedBlendWithBaseline };
import { buildComposedTrajectory, buildLoopTrajectory } from './motionTrajectory';
export { buildComposedTrajectory, buildLoopTrajectory };

// ── Shared easing (the ONE tween curve stage + sampler use) ─────────────────

/**
 * The composed-motion tween easing — ease-in-out cubic. Defined in
 * ./motionStagger (co-located with the proximal→distal onset warp so the two
 * can never drift apart) and re-exported here for API stability: ExamStage3D's
 * pose tween and existing callers import it from this module.
 */
export { composedTweenEase };

/** The default exam-command tween duration, ms (mirrors ExamStage3D). */
export const COMMAND_TWEEN_MS = 600;

// ── Authored-ms → trajectory-ms (the ONE gait time-base factor) ──────────────

/**
 * The ONE authored-ms → trajectory-ms factor for everything a motion declares
 * against its AUTHORED keyframe clock: the planned stance schedule
 * (`gaitStanceWindowsMs`), the foot-plant `contacts` from/to windows, and the
 * heading profile. The trajectory re-times the authored durations by
 * `modifiers.timeScale` (paceGait's cadence) and expands finite reps, so
 * trajectory time = authored time × (totalMs / authoredMs) — anything declared
 * in authored ms must be scaled by this factor before it is compared with a
 * trajectory-time clock.
 *
 * SEAM-2: the stance WINDOWS were always scaled this way but the plant CONTACTS
 * were applied raw, so at any pace ≠ 1 the pinned stance phases ran 1/timeScale
 * out of sync with the trajectory — the planted foot slid tens of cm inside its
 * window and popped at release. Sampler AND stage now derive the factor from
 * THIS helper only, so the two time bases can never diverge again.
 * Identity (1) at timeScale 1 and for a degenerate/empty motion.
 */
export function authoredToTrajectoryTimeScale(
  motion: {
    keyframes: { durationMs?: number; holdMs?: number }[];
    loop?: boolean;
    reps?: number;
  },
  trajectoryTotalMs: number,
): number {
  const authoredMs =
    motion.keyframes.reduce((s, k) => s + (k.durationMs ?? 0) + (k.holdMs ?? 0), 0) *
    (motion.loop ? 1 : Math.max(1, motion.reps ?? 1));
  return authoredMs > 0 && trajectoryTotalMs > 0 ? trajectoryTotalMs / authoredMs : 1;
}

/**
 * Scale a planned stance-window schedule (or any fromMs/toMs window list) from
 * authored ms into trajectory ms by {@link authoredToTrajectoryTimeScale}'s
 * factor. Every other field (foot, travelLock, …) is carried through untouched.
 * Undefined/empty in → undefined out (the no-schedule path stays falsy).
 */
export function scaleStanceWindowsMs<T extends { fromMs: number; toMs: number }>(
  windows: readonly T[] | undefined,
  scale: number,
): T[] | undefined {
  if (!windows?.length) return undefined;
  return windows.map((w) => ({ ...w, fromMs: w.fromMs * scale, toMs: w.toMs * scale }));
}

// ── Recording types ──────────────────────────────────────────────────────────

/** One sampled frame: the pose on the skeleton, the MEASURED clinical angles,
 *  the whole-body root state, and (optionally) tracked-bone world positions. */
export interface RecordedFrame {
  /** Time since recording start, ms. */
  tMs: number;
  /** The full CustomPose on the skeleton at this instant. */
  pose: CustomPose;
  /** MEASURED clinical joint angles (computeJointAngles().joints — degrees,
   *  engine sign convention), keyed joint → motion field. */
  angles: Record<string, Record<string, number>>;
  /** Model-root state relative to its grounded rest transform: orientation
   *  quaternion [x,y,z,w] (identity = upright) and translation in meters
   *  (INCLUDES any planted foot-pin Y shift — the honest world position). */
  root: { orientQuat: [number, number, number, number]; translateM: [number, number, number] };
  /** World positions (meters) of the tracked bone set, keyed by canonical
   *  bone key (default pelvis/head/hands/feet). */
  worldTracks?: Record<string, [number, number, number]>;
}

export type MotionRecordingSourceKind = 'composed' | 'clip' | 'command' | 'manual';

/** A captured movement: uniformly-sampled frames plus provenance. */
export interface MotionRecording {
  id: string;
  name: string;
  variant: string;
  sourceKind: MotionRecordingSourceKind;
  /** Human label of the source motion (composed-motion name / clip id). */
  sourceName?: string;
  sampleHz: number;
  frames: RecordedFrame[];
  /** Caller-stamped creation time (the pure layer never reads the clock). */
  createdAtIso?: string;
}

/** Canonical bones tracked by default (world trajectories). Feet AND forefeet
 *  are tracked so the balance post-pass ({@link computeBalanceTimeline}) can
 *  rebuild the base of support from the recording alone. The whole-body centre of
 *  mass is added per frame under the reserved key `CoM` (not a bone). */
export const DEFAULT_TRACKED_BONES = [
  'Hips',
  'Head',
  'L_Hand',
  'R_Hand',
  'L_Foot',
  'R_Foot',
  'L_Toes',
  'R_Toes',
] as const;

/** Total duration of a recording, ms (last frame's timestamp). */
export function recordingDurationMs(rec: MotionRecording): number {
  return rec.frames.length ? rec.frames[rec.frames.length - 1]!.tMs : 0;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Deterministic FNV-1a hash of a string, hex. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function copyAngles(
  joints: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [j, set] of Object.entries(joints)) out[j] = { ...set };
  return out;
}

function copyFrame(f: RecordedFrame, tMs: number): RecordedFrame {
  return {
    tMs,
    pose: f.pose,
    angles: f.angles,
    root: {
      orientQuat: [...f.root.orientQuat],
      translateM: [...f.root.translateM],
    },
    ...(f.worldTracks ? { worldTracks: f.worldTracks } : {}),
  };
}

const QUAT_IDENTITY: [number, number, number, number] = [0, 0, 0, 1];
const isIdentityQuat = (q: [number, number, number, number]) =>
  Math.abs(q[0]) < 1e-6 && Math.abs(q[1]) < 1e-6 && Math.abs(q[2]) < 1e-6;

// ── 1. Offline sampler ───────────────────────────────────────────────────────

/** The headless rig the sampler drives — the SAME objects the stage holds. */
export interface SkeletonSampleHarness {
  /** Model root (the GLB scene) — the sampler rides root orient/translate on
   *  it, treating its transform AT CALL TIME as the grounded rest transform. */
  root: THREE.Object3D;
  /** The skinned mesh whose skeleton is posed + measured. */
  skinned: THREE.SkinnedMesh;
}

export interface SampleComposedOptions {
  /** Full-skeleton anatomic-rest pose (same contract as buildSequencePoses). */
  baselinePose: CustomPose;
  variantCfg: BodyVariantConfig;
  /** Rest reference captured at anatomic (required for shoulder elevation). */
  rest: JointAngleRestReference;
  skeletonHarness: SkeletonSampleHarness;
  /** Samples per second (default 30, clamped 1..120). */
  sampleHz?: number;
  /** Canonical keys whose world positions are tracked per frame. */
  trackedBones?: readonly string[];
  /** Recording label (defaults to the motion's name). */
  name?: string;
  sourceKind?: MotionRecordingSourceKind;
  sourceName?: string;
  /** Continuity seeds — the pose/root the body is currently in (mirrors the
   *  stage's cross-motion continuity). Omit to sample from anatomic rest. */
  currentPose?: CustomPose | null;
  currentRoot?: {
    quat?: [number, number, number, number];
    translateM?: [number, number, number];
  } | null;
  /**
   * Feet to keep planted in the world (Phase 3 closed-chain contact): each
   * declared foot is IK-pinned to the world position it holds at the start of
   * the motion, so it does NOT slide as the root travels. Applied per frame
   * AFTER the FK pose + root transform (and after any planted floor-pin). Omit
   * for the default open-chain behavior — existing recordings are unaffected.
   */
  contacts?: {
    foot: string;
    /** Stance WINDOW: pin this foot only while `fromMs ≤ t ≤ toMs` (heel-strike
     *  to toe-off). The plant target is (re)captured at the first frame the foot
     *  ENTERS its window, so alternating steps each pin at their own contact
     *  point. Omit both for a whole-motion pin (the original single-stance
     *  behaviour). A foot that alternates (real gait) is passed as several
     *  windowed entries — one per stance phase. */
    fromMs?: number;
    toMs?: number;
  }[];
  /**
   * For a LOOPING motion (`resolved.loop`), sample ONE seamless period of the
   * periodic loop trajectory ({@link buildLoopTrajectory}) instead of the
   * one-shot pass. The result is a clean, replayable cycle — no standing/intro
   * pose, velocity-continuous across the wrap — so a saved recording loops
   * without the per-cycle snap. Ignored for non-looping motions or a
   * single-keyframe cycle. Off by default (existing recordings unaffected).
   */
  loopCycle?: boolean;
}

interface SampleSegment {
  kind: 'travel' | 'hold';
  fromPose: CustomPose;
  toPose: CustomPose;
  fromQuat: [number, number, number, number];
  toQuat: [number, number, number, number];
  fromTranslate: [number, number, number];
  toTranslate: [number, number, number];
  planted: boolean;
  durMs: number;
}

const _sq = new THREE.Quaternion();
const _sqB = new THREE.Quaternion();
const _sqC = new THREE.Quaternion();
const _sv = new THREE.Vector3();
const _svB = new THREE.Vector3();

// FOOT_ROOT_DRIFT_M (the drift above which a planted frame is re-rooted at the
// stance foot) is imported from services/rootMotion — one constant shared with
// the live stage and the balanceCoordination pre-pass.

/** How far (m) the SMOOTHED gait vertical may raise the pelvis above the live floor-pin
 *  when the stance feet are foot-plant IK'd. Rounding the double-support valley raises
 *  the pelvis; too much makes a planted stance leg over-reach and slide the foot. This
 *  bounds the over-reach so the smoothing stays foot-safe (rig-swept vs the slide gate).
 *  Exported because the live stage's mirror deriveVerticalCalibration call MUST pass the
 *  SAME clamp under the same plants-active condition (DET-LOCK-01 lockstep — source-pinned
 *  in stageReliability.test.ts), or live playback diverges from every recording. */
export const GAIT_VERTICAL_MAX_RISE_M = 0.025;

/**
 * Offline-sample a RESOLVED composed motion: replay the exact per-keyframe
 * easing/tween interpolation, holds, root transforms (slerp/lerp + planted
 * foot-pin) the stage plays, applying each sampled pose to the headless
 * skeleton and measuring {@link computeJointAngles} per frame.
 *
 * Deterministic — same input produces a deep-equal recording (the id is a
 * content hash; `createdAtIso` is intentionally NOT stamped here).
 * The harness is left at the final frame's state.
 */
export function sampleComposedMotion(
  resolved: ResolvedComposedMotion,
  opts: SampleComposedOptions,
): MotionRecording {
  const { baselinePose, variantCfg, rest, skeletonHarness } = opts;
  const { root, skinned } = skeletonHarness;
  const hz = Math.max(1, Math.min(120, opts.sampleHz ?? 30));
  const tracked = opts.trackedBones ?? DEFAULT_TRACKED_BONES;
  const name = opts.name ?? resolved.name ?? 'recording';

  const empty = (): MotionRecording => ({
    id: `rec-${fnv(name + hz)}`,
    name,
    variant: variantCfg.id,
    sourceKind: opts.sourceKind ?? 'composed',
    ...(opts.sourceName ?? resolved.name ? { sourceName: opts.sourceName ?? resolved.name } : {}),
    sampleHz: hz,
    frames: [],
  });
  if (resolved.status !== 'ok' || resolved.keyframes.length === 0) return empty();

  // BALANCE COORDINATION (COM-driven postural control): for a motion flagged
  // `balanceAssist`, measure each keyframe's COM-vs-base offset on this harness
  // and fold ROM-clamped re-centering targets into the resolved keyframes —
  // BEFORE the trajectory is built, at the same pipeline point the live stage
  // applies the SAME pure transform (lockstep, like the vertical-calibration
  // pre-pass). Identity for unflagged/excluded motions (gait/travel, loops,
  // floating, lying, grounding postures), so they stay byte-identical. Skipped
  // when the caller overrides contacts (the plant solver would own the legs).
  if (!opts.contacts?.length) {
    resolved = balanceCoordination(resolved, {
      root,
      skinned,
      variantCfg,
      baselinePose,
      rest,
      currentPose: opts.currentPose ?? null,
      currentRoot: opts.currentRoot ?? null,
    });
  }

  // The harness transform at call time IS the grounded rest transform the
  // composed root state rides on (mirrors the stage's rootRestPos/Quat).
  const rootRestPos = root.position.clone();
  const rootRestQuat = root.quaternion.clone();
  // Foot-rooted planting re-roots via root.applyMatrix4, which re-decomposes the
  // root matrix — and that is not perfectly scale-neutral, so root.scale drifts a
  // hair each plant. The sampler already sets root position/quaternion per frame
  // authoritatively; scale is reset alongside them (below) so the drift can never
  // accumulate across frames or leak into a later sample on the same harness.
  const rootRestScale = root.scale.clone();

  // Floor reference is captured at anatomic rest (upright, baseline pose) —
  // same as the stage capturing it right after boot grounding. The foot FRAMES
  // (full rest world transform of each ankle) are captured here too, for
  // closed-chain foot-rooted planting of the quasi-static planted set.
  applyCustomPose(skinned.skeleton, variantCfg, baselinePose);
  root.updateMatrixWorld(true);
  const floorRef = captureFloorReference(skinned.skeleton, variantCfg);
  const footFrames = captureFootFrames(skinned.skeleton, variantCfg);

  // CONTACT PLANTS (Phase 3): build the leg IK chains now, but capture each
  // foot's world target LAZILY at the first sampled frame (after that frame's FK
  // pose + root transform). Capturing at the real first frame — not the baseline
  // pose + root-at-rest — is what makes a plant correct for BOTH a neutral start
  // AND the default startFrom:'current' continuity path (the foot pins where it
  // actually IS at t=0, not where it would be at anatomic rest). Red-team Finding 1.
  interface FootPlant {
    solver: FootPlantSolver;
    /** Stance window [fromMs, toMs]; ±Infinity = pin for the whole motion. */
    fromMs: number;
    toMs: number;
    /** World target, captured lazily when the foot first enters its window; reset
     *  on leaving so the NEXT stance window re-pins at the new contact point. */
    target: THREE.Vector3 | null;
    /** PER-WINDOW plant-clamp rest frame (CURVED heading only): the rest
     *  reference rotated by the heading at THIS window's start, so each stance
     *  window's leg-IK ROM clamps read against the body orientation the walk
     *  actually holds through that stance. Absent (constant heading / heading
     *  0) ⇒ the shared `plantRest` below — the byte-identical legacy path. */
    rest?: JointAngleRestReference;
  }
  const footPlants: FootPlant[] = [];
  // Honour contacts the MOTION declares (resolved.contacts) when the caller
  // doesn't pass an explicit override — so a travel-gait motion plants its feet
  // the same way in the sampler as on the live stage.
  const activeContacts = opts.contacts ?? resolved.contacts ?? [];
  for (const c of activeContacts) {
    const solver = buildFootPlant(skinned, c.foot, variantCfg);
    if (solver) {
      footPlants.push({
        solver,
        fromMs: typeof c.fromMs === 'number' ? c.fromMs : -Infinity,
        toMs: typeof c.toMs === 'number' ? c.toMs : Infinity,
        target: null,
      });
    }
  }
  // PLANT-CLAMP REST FRAME: the leg-IK ROM clamps decompose bone WORLD quats
  // against the rest reference, so a walk on a ROTATED heading must clamp
  // against the heading-rotated reference (else the whole-body yaw reads as
  // spurious hip abduction/rotation and the "clamped" solve drags the planted
  // foot). Rotated ONCE per motion by the constant heading; the knee hinge
  // axis keeps the ORIGINAL rest (solveFootPlant's hingeAxisRest — local axes
  // are picked in the un-rotated frame). Heading 0 keeps the very same `rest`
  // object — the legacy byte-identical path.
  const plantHeadingDeg = resolved.headingDeg ?? 0;
  const plantRest =
    plantHeadingDeg !== 0 && footPlants.length > 0
      ? rotateRestReferenceByRoot(
          rest,
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            (plantHeadingDeg * Math.PI) / 180,
          ),
        )
      : rest;
  // CURVED heading (roadmap 6.2): one rotated clamp frame per CONTACT WINDOW,
  // at the heading the profile holds at that window's START (authored ms — the
  // same time base the contacts are declared in). A single constant rotation
  // can't serve an arc: by the last stance the body has yawed the full turn
  // away from it, and the mis-framed ROM clamps read the yaw as spurious hip
  // angles (the very failure the wave-4 rotated rest fixed for constant
  // headings). Within one window the heading still drifts by up to ~turn/2 —
  // measured on the rig at turnDeg 90 the residual stays inside the gentle-arc
  // slide budget (gaitCurvedWalk.test.ts), so a per-frame re-rotation is not
  // needed. Absent profile ⇒ no per-window rests (legacy byte-identical path).
  const headingAtAuthoredMs =
    resolved.headingProfileMs && resolved.headingProfileMs.length >= 2
      ? headingProfileLookup(resolved.headingProfileMs)
      : null;
  if (headingAtAuthoredMs) {
    for (const fp of footPlants) {
      const h = headingAtAuthoredMs(Number.isFinite(fp.fromMs) ? fp.fromMs : 0);
      fp.rest =
        h !== 0
          ? rotateRestReferenceByRoot(
              rest,
              new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                (h * Math.PI) / 180,
              ),
            )
          : rest;
    }
  }

  const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest, {
    currentPose: opts.currentPose ?? null,
    currentRoot: opts.currentRoot ?? null,
  });

  // HAND PLANTS (Phase 3 Tier B): a grounding posture may declare a hand as a
  // 'reach' contact (plank/push-up rest on the hands). Build an arm IK chain per
  // such hand once; per frame it pins the hand to a fixed floor point so it stays
  // planted as the chest lowers — the arm folds (elbow flexes), which IS the
  // push-up. Mirror of the foot plant, on the arm chain. Empty for every motion
  // that declares no reach contact (all pre-Tier-B content), so they are unchanged.
  interface HandPlant {
    solver: FootPlantSolver;
    bone: string;
    target: THREE.Vector3 | null;
  }
  const handPlants: HandPlant[] = [];
  {
    const reachBones = new Set<string>();
    for (const r of built.roots) {
      if (!r.groundingPosture) continue;
      for (const c of groundingContactsFor(r.groundingPosture, floorRef)) {
        if (c.mode === 'reach') reachBones.add(c.bone);
      }
    }
    for (const bone of reachBones) {
      const solver = buildHandPlant(skinned, bone, variantCfg);
      if (solver) handPlants.push({ solver, bone, target: null });
    }
  }

  const timeScale = Math.min(1.5, Math.max(0.4, resolved.modifiers?.timeScale ?? 1));
  const startNeutral = resolved.startFrom === 'neutral';
  let prevPose: CustomPose =
    startNeutral ? baselinePose : opts.currentPose ?? baselinePose;
  let prevQuat: [number, number, number, number] =
    !startNeutral && opts.currentRoot?.quat ? [...opts.currentRoot.quat] : [...QUAT_IDENTITY];
  let prevTranslate: [number, number, number] =
    !startNeutral && opts.currentRoot?.translateM ? [...opts.currentRoot.translateM] : [0, 0, 0];

  // CONTINUOUS TRAJECTORY (services/motionTrajectory): one velocity-continuous
  // spline that FLOWS THROUGH the keyframe waypoints instead of the old
  // stop-at-every-keyframe segment tween. Built by the SAME shared function the
  // live stage uses, so a recording is frame-for-frame what the stage shows.
  // A LOOPING motion recorded with `loopCycle` captures ONE seamless period of
  // the periodic loop trajectory (no intro pose, velocity-continuous wrap) so
  // the saved clip is itself a clean, replayable cycle. Otherwise the one-shot
  // pass is recorded (start pose → keyframes), exactly as before.
  const useLoopCycle =
    opts.loopCycle === true && resolved.loop === true && built.poses.length >= 2;
  const { trajectory } = useLoopCycle
    ? buildLoopTrajectory(built, { timeScale })
    : buildComposedTrajectory(built, {
        startPose: prevPose,
        startQuat: prevQuat,
        startTranslate: prevTranslate,
        timeScale,
        reps: resolved.reps,
        // A foot-driven travelling gait is a steady cadence, not a gesture: keep the
        // limb swing uniform at the ends (no ease-in whip / halt) — UNLESS the motion
        // authors its own initiation/termination ramps (`settleEnds`), in which case
        // the ends are genuine stops (ease from standstill, brake to quiet standing).
        cyclicEnds: resolved.footDrivenTravel === true && resolved.settleEnds !== true,
        // MOMENTUM-PRESERVING SEAM (opt-in): the first knot is a fly-through so a
        // chained motion enters with velocity; the final settle still stops.
        flowIn: resolved.flowIn === true,
      });
  const totalMs = trajectory.totalMs;
  const dtMs = 1000 / hz;
  const boneByKey = buildBoneByPoseKey(skinned.skeleton, variantCfg);

  // AUTHORED→TRAJECTORY TIME BASE (SEAM-2): the one shared factor that maps the
  // motion's authored keyframe clock onto trajectory time — see the helper doc.
  // The foot-plant CONTACT windows were built above in authored ms (their
  // per-window heading rests must be looked up on the authored clock); re-time
  // them here, once the trajectory's total is known, so the per-frame window
  // checks below compare like with like. ±Infinity (whole-motion pins) scale to
  // themselves; identity at timeScale 1 keeps the un-paced path byte-exact.
  const authoredToTraj = authoredToTrajectoryTimeScale(resolved, totalMs);
  if (authoredToTraj !== 1) {
    for (const fp of footPlants) {
      fp.fromMs *= authoredToTraj;
      fp.toMs *= authoredToTraj;
    }
  }

  // CALIBRATED GAIT VERTICAL (mean-preserving reshape). When the motion asks for
  // a target excursion, do a cheap PRE-PASS over one cycle to measure the
  // EMERGENT floor-pinned pelvis arc (the compass-gait vault the pin produces),
  // then derive a scale that maps its peak-to-peak to the target while HOLDING
  // its mean (so the feet stay grounded on average and only deviate by
  // (1-gain)·½-excursion at the extremes). Applied per frame to root.y ONLY —
  // every clinical joint angle is left exactly as authored (contrast a foot-lock
  // IK, which would corrupt the stance hip). Skipped unless the motion is planted
  // (a floating motion has no floor-pin arc to reshape).
  let vcal: VerticalCalibration = NO_VERTICAL_CALIBRATION;
  const vcalTargetM =
    resolved.verticalCalibrationCm != null ? resolved.verticalCalibrationCm / 100 : null;
  if (vcalTargetM != null && built.roots.some((r) => r.stance === 'planted')) {
    vcal = deriveVerticalCalibration((u01) => {
      const s = trajectory.sampleAt(u01 * totalMs);
      applyCustomPose(skinned.skeleton, variantCfg, s.pose);
      _sq.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
      root.quaternion.copy(rootRestQuat).multiply(_sq);
      root.position.set(
        rootRestPos.x + s.rootTranslate[0],
        rootRestPos.y + s.rootTranslate[1],
        rootRestPos.z + s.rootTranslate[2],
      );
      root.updateMatrixWorld(true);
      if (s.planted) pinRootToFloor(root, skinned.skeleton, variantCfg, floorRef);
      return root.position.y;
      // smooth: round the sharp double-support valley. When feet are foot-plant IK'd
      // (the travelling walk), clamp how far the smoothed pelvis may rise above the pin
      // so a planted stance leg doesn't over-reach and slide the foot; the contact-free
      // in-place walk (treadmill) has no such foot to over-reach, so no clamp.
    }, vcalTargetM, 48, true, footPlants.length > 0 ? GAIT_VERTICAL_MAX_RISE_M : undefined);
  }

  // FOOT-DRIVEN FORWARD TRAVEL (root motion from foot placement). A PRE-PASS poses
  // the in-place FK + floor-pin over the cycle and reads the feet, then derives a
  // forward (+Z) offset that keeps the planted (lower) foot world-fixed — so the
  // stance foot never slides and the swing foot rides the body forward, with the
  // stride emerging from the authored ROM (no independent stride, no foot-lock IK).
  //
  // MEDIO-LATERAL SHUTTLE (the X sibling): the same feet pre-pass derives the
  // stance-phase-locked pelvis ride TOWARD the planted foot (the gait weight
  // transfer), zero at the double-support handoffs. Both are root-only offsets;
  // the shared closure keeps the two derivations reading identical feet.
  let footDriven: FootDrivenTravel | null = null;
  let lateralShuttle: LateralShuttle | null = null;
  let heelStrike: HeelStrikeAccents | null = null;
  {
    const rBone = boneByKey.get('R_Foot');
    const lBone = boneByKey.get('L_Foot');
    const wantsTravel = resolved.footDrivenTravel === true;
    const shuttleM = (resolved.lateralShuttleCm ?? 0) / 100;
    const hasPlanted = built.roots.some((r) => r.stance === 'planted');
    if (rBone && lBone && hasPlanted && (wantsTravel || shuttleM > 0)) {
      const sampleFeet = (tMs: number) => {
        const s = trajectory.sampleAt(tMs);
        applyCustomPose(skinned.skeleton, variantCfg, s.pose);
        _sq.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
        root.quaternion.copy(rootRestQuat).multiply(_sq);
        root.position.set(
          rootRestPos.x + s.rootTranslate[0],
          rootRestPos.y + s.rootTranslate[1],
          rootRestPos.z + s.rootTranslate[2],
        );
        root.updateMatrixWorld(true);
        if (s.planted) pinRootToFloor(root, skinned.skeleton, variantCfg, floorRef);
        rBone.getWorldPosition(_sv);
        lBone.getWorldPosition(_svB);
        // An un-pinned sample is a run's ballistic FLIGHT gap (both feet
        // airborne): the travel derivation holds its advance through it.
        return {
          rz: _sv.z, ry: _sv.y, rx: _sv.x, lz: _svB.z, ly: _svB.y, lx: _svB.x,
          bothAirborne: !s.planted,
        };
      };
      // The planned stance schedule is authored ms; the trajectory runs at
      // authored/timeScale — scale it by the SAME shared factor as the plant
      // contacts (SEAM-2: one source of truth) so every derivation stays
      // phase-locked to the knots at any pace.
      const scale = authoredToTraj;
      const windows = scaleStanceWindowsMs(resolved.gaitStanceWindowsMs, scale);
      // TRAVEL HEADING: the derived ride goes along (sinH, cosH), shuttle along
      // the perpendicular — 0 (the default) is the byte-identical legacy +Z/+X.
      // A CURVED walk (headingProfileMs) instead hands both derivations the
      // per-time heading lookup — authored ms scaled to trajectory time by the
      // SAME factor as the stance windows, so heading and stance phase can
      // never drift apart at a non-1 pace.
      const headingDeg = resolved.headingDeg ?? 0;
      const headingAtTraj =
        headingAtAuthoredMs && scale > 0
          ? (tMs: number): number => headingAtAuthoredMs(tMs / scale)
          : undefined;
      if (wantsTravel)
        footDriven = deriveFootDrivenTravel(sampleFeet, totalMs, windows, 120, headingDeg, headingAtTraj);
      if (shuttleM > 0)
        lateralShuttle = deriveGaitLateralShuttle(
          sampleFeet, totalMs, shuttleM, windows, 120, headingDeg, headingAtTraj,
        );
      // HEEL-STRIKE TRANSIENT (footfall accent — roadmap 4.6): GAIT-ONLY — a
      // foot-driven motion with a planned stance schedule (and no explicit
      // opt-out). Each window START is a foot-contact instant; the pre-pass
      // reads the SMOOTHED vertical (the same pin + calibration sampleAt
      // applies) around each contact and derives a brief dip-and-recover
      // accent, amplitude from the pre-contact descent rate. Null for every
      // other motion, so they stay byte-identical.
      if (wantsTravel && windows?.length && resolved.heelStrikeAccent !== false) {
        heelStrike = deriveHeelStrikeAccents(
          (tMs) => {
            const s = trajectory.sampleAt(tMs);
            applyCustomPose(skinned.skeleton, variantCfg, s.pose);
            _sq.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
            root.quaternion.copy(rootRestQuat).multiply(_sq);
            root.position.set(
              rootRestPos.x + s.rootTranslate[0],
              rootRestPos.y + s.rootTranslate[1],
              rootRestPos.z + s.rootTranslate[2],
            );
            root.updateMatrixWorld(true);
            if (s.planted) pinRootToFloor(root, skinned.skeleton, variantCfg, floorRef);
            let y = root.position.y;
            if (s.planted && (vcal.gain !== 1 || vcal.smoothed)) {
              y = applyVerticalCalibration(y, vcal, totalMs > 0 ? tMs / totalMs : 0);
            }
            return y;
          },
          windows.map((w) => w.fromMs),
          totalMs,
        );
      }
    }
  }

  // CLOSED-CHAIN FOOT-ROOTED PLANTING (services/rootMotion.plantStanceFoot) — the
  // real fix for the quasi-static planted set (squat, hip-hinge, sit-to-stand,
  // single-leg). A pelvis-rooted FK swings the stance leg forward, so those
  // movements kick the feet out 35–94 cm; re-rooting the rigid body at the stance
  // foot restores it to its standing frame, so the SAME authored angles read as
  // the real closed-chain movement (feet planted, pelvis placed by the chain, COM
  // over the base — balance for free), every joint angle untouched. Used INSTEAD
  // of the vertical-only floor pin for a planted, non-travelling, non-looping
  // motion that declares no explicit foot contacts (a travel gait owns its foot
  // placement via footDrivenTravel/contacts; a loop is cyclic).
  //
  // In-place ONLY: a motion that travels (authored root translate) places its
  // feet at NEW ground positions, so restoring the stance foot to its ORIGINAL
  // rest frame would fight the travel (moonwalk the body backward). Foot-rooting
  // is for the body FOLDING/DROPPING over stationary feet, not for stepping.
  const HORIZ_TRAVEL_EPS = 0.02; // 2 cm — below this the root is "in place"
  const travels = built.roots.some(
    (r) => Math.hypot(r.translateM[0], r.translateM[2]) > HORIZ_TRAVEL_EPS,
  );
  // AIRBORNE motions (a jump/hop with a floating phase) must NOT foot-root: the feet
  // genuinely leave the ground, so re-rooting the rigid body to hold the stance foot
  // at its rest frame fights the flight and snaps the body tens of cm at each
  // planted↔floating transition. Those use the plain vertical floor-pin (planted) +
  // free flight (floating). Foot-rooting is for quasi-static PLANTED folds only.
  const hasFloating = built.roots.some((r) => r.stance === 'floating');
  // REORIENTED (lying) postures must NOT foot-root either: plantStanceFoot restores
  // the stance foot to its UPRIGHT-standing rest frame, which rigidly rotates the
  // body back toward standing and clobbers the authored supine/prone/side-lying
  // orientation. A lying body grounds on the plain vertical floor-pin (its feet are
  // co-planar with the back), which touches only Y and leaves the orient intact.
  const reorients = built.roots.some((r) => Math.abs(r.quat[3]) < 0.999);
  // A motion with a GROUNDING POSTURE (sitting / quadruped / …) grounds on a
  // posture-scoped contact set (the pelvis on a seat, hands on the floor) via the
  // vertical pinContactsToFloor — never the foot-root, whose re-root to the upright
  // foot frame would fight the seated/quadruped placement. Both are Y-only pins, so
  // switching between the feet-pin and the posture-pin across the transition stays
  // smooth (no rigid re-root jump).
  const hasGroundingPosture = built.roots.some((r) => r.groundingPosture != null);
  const useFootRoot =
    !resolved.footDrivenTravel &&
    !resolved.loop &&
    !travels &&
    !hasFloating &&
    !reorients &&
    !hasGroundingPosture &&
    activeContacts.length === 0 &&
    built.roots.some((r) => r.stance === 'planted');

  // GRAVITY-SHAPED GROUNDED DESCENT (weighted lowers — roadmap 3.3): for a
  // motion flagged `weightedDescent` (and admitted by the hard exclusion gate),
  // a PRE-PASS samples the fully-grounded root-Y arc of this trajectory — the
  // SAME posture-pin / foot-root / floor-pin grounding sampleAt applies — and
  // derives a per-span re-timing toward the gravity profile (slow early, fast
  // late, arrested by the grounding; services/rootMotion). Applied per frame in
  // sampleAt, mirrored by the live stage at the same pipeline point (the
  // vertical-calibration lockstep pattern). Null — the strict identity — for
  // every unflagged/excluded motion, so they stay byte-identical. The flagged
  // class excludes vcal, so the calibrated-vertical branch never overlaps.
  let weightedDescent: WeightedDescentReshape | null = null;
  if (!useLoopCycle && !opts.contacts?.length && weightedDescentApplies(resolved)) {
    weightedDescent = deriveWeightedDescent((tMs) => {
      const s = trajectory.sampleAt(tMs);
      applyCustomPose(skinned.skeleton, variantCfg, s.pose);
      _sq.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
      root.quaternion.copy(rootRestQuat).multiply(_sq);
      root.position.set(
        rootRestPos.x + s.rootTranslate[0],
        rootRestPos.y + s.rootTranslate[1],
        rootRestPos.z + s.rootTranslate[2],
      );
      root.scale.copy(rootRestScale);
      root.updateMatrixWorld(true);
      if (s.planted && s.groundingPosture) {
        pinContactsToFloor(
          root,
          skinned.skeleton,
          variantCfg,
          groundingContactsFor(s.groundingPosture, floorRef),
        );
      } else if (
        useFootRoot &&
        s.planted &&
        (stanceFootDrift(root, skinned.skeleton, variantCfg, footFrames) ?? 0) > FOOT_ROOT_DRIFT_M
      ) {
        plantStanceFoot(root, skinned.skeleton, variantCfg, footFrames);
      } else if (s.planted) {
        pinRootToFloor(root, skinned.skeleton, variantCfg, floorRef);
      }
      return root.position.y;
    }, totalMs);
  }

  /** Sample the rig at absolute time t and read back one frame. */
  const sampleAt = (tMs: number): RecordedFrame => {
    const sample = trajectory.sampleAt(tMs);
    const pose = sample.pose;
    applyCustomPose(skinned.skeleton, variantCfg, pose);

    // Root orient/translate come from the same continuous spline; (planted) pin
    // the deepest foot back to floor level.
    _sq.set(sample.rootQuat[0], sample.rootQuat[1], sample.rootQuat[2], sample.rootQuat[3]);
    root.quaternion.copy(rootRestQuat).multiply(_sq);
    root.position.set(
      rootRestPos.x + sample.rootTranslate[0],
      rootRestPos.y + sample.rootTranslate[1],
      rootRestPos.z + sample.rootTranslate[2],
    );
    root.scale.copy(rootRestScale); // clear any prior-frame plant scale drift
    root.updateMatrixWorld(true);
    let footRooted = false;
    let groundReachSolved = false;
    // Re-root at the stance foot only when the pelvis-rooted FK actually swung it
    // off its planted position (a squat/hinge/sit-to-stand folds the body over the
    // feet — big drift). When the stance foot is already home (a single-leg stance
    // leaves the bearing leg untouched — ~0 drift), the vertical pin is enough and
    // a re-root would only perturb the measurement frame, so fall through to it.
    if (sample.planted && sample.groundingPosture) {
      // POSTURE-SCOPED GROUNDING: rest on the posture's contact set (the pelvis on a
      // seat for 'sitting', the toes+hands on the floor for a plank) via the
      // explicit-target vertical pin — not the feet.
      const contacts = groundingContactsFor(sample.groundingPosture, floorRef);
      pinContactsToFloor(root, skinned.skeleton, variantCfg, contacts);
      // REACH CONTACTS: bring each declared reach bone (a planted hand) to the floor
      // and LATCH it there, so it stays put as the body lowers over it (the arm folds
      // — the push-up). Latch-on-contact avoids freezing a bad point mid-transition.
      if (handPlants.length) {
        const reach = new Set(contacts.filter((c) => c.mode === 'reach').map((c) => c.bone));
        for (const hp of handPlants) {
          if (!reach.has(hp.bone)) {
            hp.target = null; // this posture doesn't plant this hand — release it
            continue;
          }
          solveHandReach(hp.solver, hp, floorRef.floorY, rest);
          groundReachSolved = true;
        }
        if (groundReachSolved) root.updateMatrixWorld(true);
      }
    } else if (useFootRoot && sample.planted && (stanceFootDrift(root, skinned.skeleton, variantCfg, footFrames) ?? 0) > FOOT_ROOT_DRIFT_M) {
      // The SAME authored angles now read as the real closed-chain movement — feet
      // planted, pelvis placed by the chain, COM over the base (balance for free).
      // This RIGIDLY rotates the root (not just Y), so orientation is recomputed below.
      plantStanceFoot(root, skinned.skeleton, variantCfg, footFrames);
      footRooted = true;
    } else if (sample.planted) {
      pinRootToFloor(root, skinned.skeleton, variantCfg, floorRef);
      // Calibrated gait vertical: reshape the grounded pelvis arc to the requested
      // excursion (root-only; joints untouched) — amplitude-scaled about its cycle
      // mean, and (for gait) temporally SMOOTHED by cycle phase so the sharp
      // double-support drop rounds into a glide. Identity for every uncalibrated
      // motion, so they are byte-identical.
      if (vcal.gain !== 1 || vcal.smoothed) {
        const u01 = totalMs > 0 ? tMs / totalMs : 0;
        root.position.y = applyVerticalCalibration(root.position.y, vcal, u01);
        root.updateMatrixWorld(true);
      }
    }
    // Gravity-shaped descent (weighted lowers): inside a derived descent span,
    // re-time the grounded root-Y toward the gravity profile — clamped to the
    // live pin's hover/dip band. Root-Y ONLY (joints untouched); identity for
    // every frame outside a span and for every unflagged/excluded motion.
    if (weightedDescent && sample.planted) {
      const yShaped = applyWeightedDescent(root.position.y, weightedDescent, tMs);
      if (yShaped !== root.position.y) {
        root.position.y = yShaped;
        root.updateMatrixWorld(true);
      }
    }
    // Heel-strike transient (gait only): the brief footfall dip-and-recover ON
    // TOP of the smoothed vertical, at each stance-window contact instant.
    // Root-Y only; exactly 0 outside every accent span (and null for every
    // non-gait motion), so unaccented playback is byte-identical. Tracked so a
    // foot-plant target captured mid-accent pins at the NATURAL contact point
    // (below) and the dip is absorbed by the leg IK.
    let heelStrikeY = 0;
    if (heelStrike && sample.planted) {
      heelStrikeY = heelStrikeOffsetAt(heelStrike, tMs);
      if (heelStrikeY !== 0) {
        root.position.y += heelStrikeY;
        root.updateMatrixWorld(true);
      }
    }
    // Foot-driven travel: advance the root ALONG THE HEADING (offset·(sinH,
    // cosH); straight-ahead heading 0 is a pure +Z ride, byte-identical to the
    // old z-only path) so the planted foot stays world-fixed. Horizontal only —
    // independent of the vertical pin/calibration. The medio-lateral shuttle
    // rides the root along the heading's PERPENDICULAR toward the stance foot
    // the same way; both precede the foot plants, which hold each stance foot
    // fixed while the pelvis travels over it. (The `!== 0` guards keep the
    // heading-0 cross-axis adds from ever touching the other channel.)
    if (footDriven || lateralShuttle) {
      if (footDriven) {
        // CURVED heading: the derivation pre-accumulated the (x, z) arc — each
        // advance already rode the heading at its own time. Constant heading
        // keeps the offset·heading ride (byte-identical at heading 0).
        if (footDriven.at) {
          const [ox, oz] = footDriven.at(tMs);
          root.position.x += ox;
          root.position.z += oz;
        } else {
          const off = footDriven.zAt(tMs);
          root.position.z += off * footDriven.heading[1];
          if (footDriven.heading[0] !== 0) root.position.x += off * footDriven.heading[0];
        }
      }
      if (lateralShuttle) {
        // CURVED heading: the shuttle rides the INSTANTANEOUS perpendicular.
        if (lateralShuttle.at) {
          const [ox, oz] = lateralShuttle.at(tMs);
          root.position.x += ox;
          root.position.z += oz;
        } else {
          const lat = lateralShuttle.xAt(tMs);
          root.position.x += lat * lateralShuttle.lateral[0];
          if (lateralShuttle.lateral[1] !== 0) root.position.z += lat * lateralShuttle.lateral[1];
        }
      }
      root.updateMatrixWorld(true);
    }

    // CONTACT PLANTS: pin each declared foot back to its captured world target,
    // so it does not slide as the root travels (the leg hip/knee flex to carry
    // the pelvis over the fixed foot). Applied after the floor-pin; the measured
    // angles + tracks below then reflect the IK'd leg, and `effPose` re-serializes
    // it so the recorded pose stays consistent with the measurement.
    let effPose = pose;
    let anyPlant = false;
    for (const fp of footPlants) {
      const inWindow = tMs >= fp.fromMs - 1e-6 && tMs <= fp.toMs + 1e-6;
      if (!inWindow) {
        // PLANT RELEASE BLEND (SEAM-3): when a stance window ends, ramp the
        // leg-IK correction 1→0 over PLANT_RELEASE_BLEND_MS instead of dropping
        // it in one frame — the toe-off pop snapped the released foot ~20 cm
        // (and the leg joints ~17°/frame) back to their FK pose. The captured
        // target survives ONLY through the ramp; the hold is NOT extended (the
        // FK swing takes over continuously — the foot may move, just never
        // discontinuously). Skipped when a later window has already re-pinned
        // the same foot: its full solve owns the leg.
        const w = fp.target ? 1 - (tMs - fp.toMs) / PLANT_RELEASE_BLEND_MS : 0;
        const footRepinned =
          w > 0 &&
          w < 1 &&
          footPlants.some(
            (o) =>
              o !== fp &&
              o.solver.footKey === fp.solver.footKey &&
              tMs >= o.fromMs - 1e-6 &&
              tMs <= o.toMs + 1e-6,
          );
        if (!fp.target || w <= 0 || w >= 1 || footRepinned) {
          fp.target = null; // released (or superseded) — the next stance re-captures
          continue;
        }
        solveFootPlantWeighted(fp.solver, fp.target, fp.rest ?? plantRest, rest, w);
        anyPlant = true;
        continue;
      }
      // Lazily pin the target to where the foot IS as it ENTERS its window
      // (post-FK, post-root): frame 0 for a whole-motion pin, or heel-strike for
      // a windowed stance phase, so each alternating step plants at its own point.
      // A heel-strike accent active at capture time has dipped the WHOLE root, so
      // remove its offset from the captured Y: the foot pins at its natural floor
      // contact and the transient dip is absorbed by the leg IK (the loading
      // knee), instead of burying the foot by the dip for the entire stance.
      if (!fp.target) {
        fp.target = fp.solver.ctx.bones[0]!.getWorldPosition(new THREE.Vector3());
        fp.target.y -= heelStrikeY;
      }
      // Per-window rotated clamp frame for a CURVED heading; the shared
      // (constant-heading) plantRest otherwise. The ORIGINAL rest always
      // names the knee hinge axis (solveFootPlant's hingeAxisRest).
      solveFootPlant(fp.solver, fp.target, fp.rest ?? plantRest, rest);
      anyPlant = true;
    }
    if (anyPlant || groundReachSolved) {
      // A foot plant OR a grounding-posture hand reach re-solved a limb — re-read
      // the pose so the recorded angles/tracks reflect the IK'd limb.
      root.updateMatrixWorld(true);
      effPose = serializeCustomPose(skinned.skeleton, variantCfg, variantCfg.id);
    }

    // Measure against the (possibly reoriented) rest reference — same as the
    // stage's activeRestRef(). `_sqB` = the WORLD-frame root delta from rest
    // (`root.quaternion · rootRestQuat⁻¹`), the convention rotateRestReferenceByRoot
    // (and the stage's rootOrientDelta) measures with. `_sqC` is left holding
    // rootRestQuat⁻¹ for the orientQuat below.
    _sqB.copy(root.quaternion).multiply(_sqC.copy(rootRestQuat).invert());
    // The recorded `orientQuat` is the LOCAL delta (rootRestQuat⁻¹ · root.quaternion)
    // — the convention the stage's applyRootState replays and its recording tap
    // captures. On the pin-only path that is exactly the authored spin `_sq`
    // (byte-identical to before); a foot-rooted plant re-roots the body, so
    // recompute it from the live root (_sqC already holds rootRestQuat⁻¹).
    let orientQuat: [number, number, number, number];
    if (footRooted) {
      _sqC.multiply(root.quaternion); // rootRestQuat⁻¹ · root.quaternion
      orientQuat = [_sqC.x, _sqC.y, _sqC.z, _sqC.w];
    } else {
      orientQuat = [_sq.x, _sq.y, _sq.z, _sq.w];
    }
    const measureRest = isIdentityQuat(orientQuat)
      ? rest
      : rotateRestReferenceByRoot(rest, _sqB);
    const report = computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, measureRest);

    const worldTracks: Record<string, [number, number, number]> = {};
    for (const key of tracked) {
      const bone = boneByKey.get(key);
      if (!bone) continue;
      bone.getWorldPosition(_sv);
      worldTracks[key] = [_sv.x, _sv.y, _sv.z];
    }
    // Whole-body centre of mass (gravity's grip): the mass-weighted summary of
    // the pose, under the reserved key `CoM`. Tracked every frame so the balance
    // margin (COM projection vs base of support) is derivable from the recording.
    worldTracks.CoM = computeBodyCoMFromBones(boneByKey).world;

    return {
      tMs,
      pose: effPose,
      angles: copyAngles(report.joints as Record<string, Record<string, number>>),
      root: {
        orientQuat,
        translateM: [
          root.position.x - rootRestPos.x,
          root.position.y - rootRestPos.y,
          root.position.z - rootRestPos.z,
        ],
      },
      worldTracks,
    };
  };

  const frames: RecordedFrame[] = [];
  const steps = Math.floor(totalMs / dtMs + 1e-6);
  for (let k = 0; k <= steps; k += 1) frames.push(sampleAt(k * dtMs));
  if (steps * dtMs < totalMs - 1e-3) frames.push(sampleAt(totalMs));

  // Leave the shared harness root as we found it (grounded rest). The sampler
  // mutates root.position/quaternion every frame — and a foot-rooted plant also
  // ROTATES it — so without this a later sample on the same harness would capture
  // a mutated root as its "rest", poisoning rootRestQuat + the foot frames.
  root.position.copy(rootRestPos);
  root.quaternion.copy(rootRestQuat);
  root.scale.copy(rootRestScale);
  root.updateMatrixWorld(true);

  return {
    id: `rec-${fnv(JSON.stringify(resolved) + '|' + hz + '|' + variantCfg.id + '|' + name + (useLoopCycle ? '|loop' : ''))}`,
    name,
    variant: variantCfg.id,
    sourceKind: opts.sourceKind ?? 'composed',
    ...(opts.sourceName ?? resolved.name ? { sourceName: opts.sourceName ?? resolved.name } : {}),
    sampleHz: hz,
    frames,
  };
}

// ── 2. Edit operations (pure, non-mutating) ─────────────────────────────────

/** Keep only the frames within [startMs, endMs] and re-zero timestamps. */
export function trimRecording(
  rec: MotionRecording,
  startMs: number,
  endMs: number,
): MotionRecording {
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  const kept = rec.frames.filter((f) => f.tMs >= lo - 1e-6 && f.tMs <= hi + 1e-6);
  const zero = kept.length ? kept[0]!.tMs : 0;
  return { ...rec, frames: kept.map((f) => copyFrame(f, f.tMs - zero)) };
}

/** Split at the playhead into two re-zeroed clips. The frame nearest `atMs`
 *  becomes the last frame of A AND the first frame of B (a clean seam). */
export function splitRecording(
  rec: MotionRecording,
  atMs: number,
): [MotionRecording, MotionRecording] {
  if (rec.frames.length < 2) {
    return [
      { ...rec, id: `${rec.id}-a`, name: `${rec.name} · 1`, frames: rec.frames.map((f) => copyFrame(f, f.tMs)) },
      { ...rec, id: `${rec.id}-b`, name: `${rec.name} · 2`, frames: [] },
    ];
  }
  let cut = 0;
  let best = Infinity;
  for (const [i, f] of rec.frames.entries()) {
    const d = Math.abs(f.tMs - atMs);
    if (d < best) {
      best = d;
      cut = i;
    }
  }
  cut = Math.max(0, Math.min(rec.frames.length - 1, cut));
  const aFrames = rec.frames.slice(0, cut + 1);
  const bFrames = rec.frames.slice(cut);
  const bZero = bFrames[0]!.tMs;
  return [
    { ...rec, id: `${rec.id}-a`, name: `${rec.name} · 1`, frames: aFrames.map((f) => copyFrame(f, f.tMs)) },
    { ...rec, id: `${rec.id}-b`, name: `${rec.name} · 2`, frames: bFrames.map((f) => copyFrame(f, f.tMs - bZero)) },
  ];
}

export interface BakeFrameEditOptions {
  /** Blend half-window, ms — neighbors within ±blendMs receive a linearly
   *  falling share of the edit so it doesn't pop. Default 300; 0 = only the
   *  nearest frame is replaced. */
  blendMs?: number;
  /** MEASURED angles for the edited pose (from the live stage / a measure
   *  pass). Used verbatim on the edited frame and blended numerically into
   *  neighbors when no `measure` fn is supplied. */
  editedAngles?: Record<string, Record<string, number>>;
  /** Re-measure a blended pose's clinical angles (caller applies the pose to
   *  a skeleton and reads computeJointAngles). When supplied it is used for
   *  the edited frame AND every blended neighbor — the measured truth path. */
  measure?: (pose: CustomPose) => Record<string, Record<string, number>>;
}

/** Numeric linear blend of two angle reports (fields present on both sides). */
function blendAngles(
  a: Record<string, Record<string, number>>,
  b: Record<string, Record<string, number>>,
  t: number,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [j, setA] of Object.entries(a)) {
    const setB = b[j];
    const dst: Record<string, number> = {};
    for (const [k, va] of Object.entries(setA)) {
      const vb = setB?.[k];
      dst[k] = typeof vb === 'number' ? va + (vb - va) * t : va;
    }
    out[j] = dst;
  }
  return out;
}

/**
 * Replace the frame nearest `atMs` with `editedPose` and blend the edit
 * linearly into neighbors within ±blendMs (weight 1 at the edited frame,
 * falling to 0 at the window edge) so the bake doesn't pop. Angles are
 * re-measured via `opts.measure` when supplied, else blended numerically
 * from `opts.editedAngles`. World tracks of touched frames are retained
 * as-sampled (an edited pose's trajectories are re-derivable by re-measuring).
 * Pure — returns a new recording.
 */
export function bakeFrameEdit(
  rec: MotionRecording,
  atMs: number,
  editedPose: CustomPose,
  opts: BakeFrameEditOptions = {},
): MotionRecording {
  if (rec.frames.length === 0) return { ...rec, frames: [] };
  const blendMs = Math.max(0, opts.blendMs ?? 300);
  let idx = 0;
  let best = Infinity;
  for (const [i, f] of rec.frames.entries()) {
    const d = Math.abs(f.tMs - atMs);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  const centerT = rec.frames[idx]!.tMs;
  const editedAngles =
    opts.measure?.(editedPose) ?? opts.editedAngles ?? rec.frames[idx]!.angles;

  const frames = rec.frames.map((f, i) => {
    const d = Math.abs(f.tMs - centerT);
    if (i === idx) {
      return { ...copyFrame(f, f.tMs), pose: editedPose, angles: editedAngles };
    }
    if (blendMs <= 0 || d >= blendMs) return f;
    const w = 1 - d / blendMs; // 1 at the edit, 0 at the window edge
    const pose = blendCustomPose(f.pose, editedPose, w) ?? f.pose;
    const angles = opts.measure
      ? opts.measure(pose)
      : blendAngles(f.angles, editedAngles, w);
    return { ...copyFrame(f, f.tMs), pose, angles };
  });
  return { ...rec, frames };
}

/** Rename (pure). */
export function renameRecording(rec: MotionRecording, name: string): MotionRecording {
  return { ...rec, name };
}

/** Append `b` after `a` (b's frames shifted past a's end by one sample). */
export function concatRecordings(
  a: MotionRecording,
  b: MotionRecording,
  name?: string,
): MotionRecording {
  const offset = recordingDurationMs(a) + 1000 / Math.max(1, a.sampleHz);
  return {
    ...a,
    id: `${a.id}+${b.id}`,
    name: name ?? `${a.name} + ${b.name}`,
    frames: [
      ...a.frames.map((f) => copyFrame(f, f.tMs)),
      ...b.frames.map((f) => copyFrame(f, f.tMs + offset)),
    ],
  };
}

/** Round every numeric payload (quats/positions/angles/tracks) to `precision`
 *  decimals — the compact form for explicit library saves (storage quota). */
export function compactRecording(rec: MotionRecording, precision = 4): MotionRecording {
  const r = (n: number) => {
    const p = 10 ** precision;
    return Math.round(n * p) / p;
  };
  const r3 = (a: [number, number, number]): [number, number, number] => [r(a[0]), r(a[1]), r(a[2])];
  const r4 = (a: [number, number, number, number]): [number, number, number, number] => [
    r(a[0]),
    r(a[1]),
    r(a[2]),
    r(a[3]),
  ];
  return {
    ...rec,
    frames: rec.frames.map((f) => ({
      tMs: r(f.tMs),
      pose: {
        variant: f.pose.variant,
        schemaVersion: f.pose.schemaVersion,
        bones: Object.fromEntries(Object.entries(f.pose.bones ?? {}).map(([k, q]) => [k, r4(q)])),
        ...(f.pose.positions
          ? {
              positions: Object.fromEntries(
                Object.entries(f.pose.positions).map(([k, p]) => [k, r3(p)]),
              ),
            }
          : {}),
      },
      angles: Object.fromEntries(
        Object.entries(f.angles).map(([j, set]) => [
          j,
          Object.fromEntries(Object.entries(set).map(([k, v]) => [k, r(v)])),
        ]),
      ),
      root: { orientQuat: r4(f.root.orientQuat), translateM: r3(f.root.translateM) },
      ...(f.worldTracks
        ? {
            worldTracks: Object.fromEntries(
              Object.entries(f.worldTracks).map(([k, p]) => [k, r3(p)]),
            ),
          }
        : {}),
    })),
  };
}

// ── 3. Kinematic export ──────────────────────────────────────────────────────

export interface JointKinematicSummary {
  peakDeg: number;
  minDeg: number;
  excursionDeg: number;
  peakVelocityDegS: number;
  /** Timestamp of the peak (max) angle, ms. */
  timeOfPeakMs: number;
}

export interface BoneKinematicSummary {
  pathLengthM: number;
  peakSpeedMs: number;
}

export interface KinematicExport {
  /** Self-describing docs — a second AI reads THIS to interpret the fields. */
  schema: string;
  meta: {
    name: string;
    id: string;
    variant: string;
    sourceKind: MotionRecordingSourceKind;
    sourceName?: string;
    sampleHz: number;
    durationMs: number;
    frameCount: number;
    createdAtIso?: string;
  };
  /** Frame timestamps, ms (shared x-axis of every series below). */
  timesMs: number[];
  /** Angle-vs-time, degrees, keyed 'joint.motion' (engine sign convention). */
  series: Record<string, number[]>;
  /** Finite-difference angular velocity, °/s, same keys + length as series. */
  angularVelocityDegS: Record<string, number[]>;
  /** World position [x,y,z] meters per frame, keyed by tracked bone. */
  trajectories: Record<string, [number, number, number][]>;
  /** Finite-difference speed, m/s, per tracked bone (same length). */
  speedsMs: Record<string, number[]>;
  /** Model-root translation [x,y,z] meters per frame. */
  rootTranslateM: [number, number, number][];
  summary: {
    joints: Record<string, JointKinematicSummary>;
    bones: Record<string, BoneKinematicSummary>;
    root: {
      /** Component-wise max |translation| plus the peak magnitude, meters. */
      maxTranslateM: { x: number; y: number; z: number; magnitude: number };
      /** Sparse orientation timeline: first/last frame plus every frame whose
       *  orientation moved >10° from the previous key point. */
      orientationKeyPoints: { tMs: number; orientQuat: [number, number, number, number] }[];
    };
  };
  /** Caller-attached provenance (e.g. the source ComposedMotion plan) so
   *  intent and measured outcome travel together. */
  provenance?: Record<string, unknown>;
}

const EXPORT_SCHEMA_DOC =
  'simMOVE kinematic export v1. All angles are MEASURED clinical joint angles in degrees ' +
  '(computed from the 3D skeleton each frame, engine sign convention: + flexion / + abduction / ' +
  '+ internal rotation; right-side joints mirrored so symmetric poses read symmetric). ' +
  "`timesMs` is the shared time axis (ms since recording start, uniformly sampled at meta.sampleHz). " +
  "`series['Joint.motion'][i]` is that joint motion's angle at timesMs[i]; " +
  "`angularVelocityDegS` is its central finite-difference derivative in deg/s (one-sided at the ends; ~0 during holds). " +
  "`trajectories[bone][i]` is that bone's world position [x,y,z] in meters (x = subject-left+, y = up+, z+ = the way the body faces / forward — the mesh physically faces world +Z; NOTE the clinical angle readout labels this axis the opposite way, so use +z=forward when reasoning about travel/direction from these positions); " +
  '`speedsMs[bone]` is its finite-difference speed in m/s. ' +
  '`rootTranslateM[i]` is the whole-body model-root translation from its grounded stance origin (includes planted-stance floor pinning). ' +
  '`summary.joints` gives per joint.motion peak/min/excursion angle (deg), peak |angular velocity| (deg/s) and the time of the peak angle; ' +
  '`summary.bones` gives per tracked bone the total path length (m) and peak speed (m/s); ' +
  "`summary.root.orientationKeyPoints` is a sparse whole-body orientation timeline (quaternion [x,y,z,w], identity = upright). " +
  "`provenance` (when present) carries the source motion plan (e.g. the ComposedMotion keyframes the AI requested) so requested intent " +
  'can be compared against these measured outcomes.';

/** Central finite difference (one-sided at the ends). Rate per second. */
function finiteDiff(values: number[], timesMs: number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  if (n < 2) return out;
  for (let i = 0; i < n; i += 1) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const dt = timesMs[i1]! - timesMs[i0]!;
    out[i] = dt > 0 ? ((values[i1]! - values[i0]!) / dt) * 1000 : 0;
  }
  return out;
}

const dist3 = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

export interface ExportKinematicsOptions {
  /** Attached verbatim as `provenance` (e.g. the source ComposedMotion JSON). */
  provenance?: Record<string, unknown>;
}

/**
 * Turn a recording into the JSON-serializable kinematic dataset described by
 * its own `schema` string: per joint.motion angle + angular-velocity series,
 * tracked-bone world trajectories + speeds, root travel, and summaries.
 */
export function exportKinematics(
  rec: MotionRecording,
  opts: ExportKinematicsOptions = {},
): KinematicExport {
  const timesMs = rec.frames.map((f) => f.tMs);

  // Union of every joint.motion present with a finite value.
  const keys = new Set<string>();
  for (const f of rec.frames) {
    for (const [j, set] of Object.entries(f.angles)) {
      for (const [k, v] of Object.entries(set)) {
        if (typeof v === 'number' && Number.isFinite(v)) keys.add(`${j}.${k}`);
      }
    }
  }

  const series: Record<string, number[]> = {};
  const angularVelocityDegS: Record<string, number[]> = {};
  const joints: Record<string, JointKinematicSummary> = {};
  for (const key of [...keys].sort()) {
    const dot = key.indexOf('.');
    const j = key.slice(0, dot);
    const m = key.slice(dot + 1);
    let prev = 0;
    const vals = rec.frames.map((f) => {
      const v = f.angles[j]?.[m];
      prev = typeof v === 'number' && Number.isFinite(v) ? v : prev;
      return prev;
    });
    const vel = finiteDiff(vals, timesMs);
    series[key] = vals;
    angularVelocityDegS[key] = vel;
    let peakDeg = -Infinity;
    let minDeg = Infinity;
    let timeOfPeakMs = 0;
    let peakVelocityDegS = 0;
    for (let i = 0; i < vals.length; i += 1) {
      if (vals[i]! > peakDeg) {
        peakDeg = vals[i]!;
        timeOfPeakMs = timesMs[i]!;
      }
      if (vals[i]! < minDeg) minDeg = vals[i]!;
      if (Math.abs(vel[i]!) > Math.abs(peakVelocityDegS)) peakVelocityDegS = vel[i]!;
    }
    if (!Number.isFinite(peakDeg)) {
      peakDeg = 0;
      minDeg = 0;
    }
    joints[key] = {
      peakDeg,
      minDeg,
      excursionDeg: peakDeg - minDeg,
      peakVelocityDegS,
      timeOfPeakMs,
    };
  }

  // Tracked-bone trajectories + speeds + summaries.
  const boneKeys = new Set<string>();
  for (const f of rec.frames) for (const k of Object.keys(f.worldTracks ?? {})) boneKeys.add(k);
  const trajectories: Record<string, [number, number, number][]> = {};
  const speedsMs: Record<string, number[]> = {};
  const bones: Record<string, BoneKinematicSummary> = {};
  for (const bone of [...boneKeys].sort()) {
    let prev: [number, number, number] = [0, 0, 0];
    const pts = rec.frames.map((f) => {
      const p = f.worldTracks?.[bone];
      prev = p ? [p[0], p[1], p[2]] : prev;
      return prev;
    });
    trajectories[bone] = pts;
    const speeds = new Array<number>(pts.length).fill(0);
    let pathLengthM = 0;
    let peakSpeedMs = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(pts.length - 1, i + 1);
      const dt = timesMs[i1]! - timesMs[i0]!;
      speeds[i] = dt > 0 ? (dist3(pts[i0]!, pts[i1]!) / dt) * 1000 : 0;
      if (speeds[i]! > peakSpeedMs) peakSpeedMs = speeds[i]!;
      if (i > 0) pathLengthM += dist3(pts[i - 1]!, pts[i]!);
    }
    speedsMs[bone] = speeds;
    bones[bone] = { pathLengthM, peakSpeedMs };
  }

  // Root travel + sparse orientation key points.
  const rootTranslateM = rec.frames.map(
    (f) => [...f.root.translateM] as [number, number, number],
  );
  let mx = 0;
  let my = 0;
  let mz = 0;
  let mag = 0;
  for (const t of rootTranslateM) {
    mx = Math.max(mx, Math.abs(t[0]));
    my = Math.max(my, Math.abs(t[1]));
    mz = Math.max(mz, Math.abs(t[2]));
    mag = Math.max(mag, Math.hypot(t[0], t[1], t[2]));
  }
  const orientationKeyPoints: { tMs: number; orientQuat: [number, number, number, number] }[] = [];
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  for (const [i, f] of rec.frames.entries()) {
    const last = orientationKeyPoints[orientationKeyPoints.length - 1];
    if (!last || i === rec.frames.length - 1) {
      orientationKeyPoints.push({ tMs: f.tMs, orientQuat: [...f.root.orientQuat] });
      continue;
    }
    qa.set(last.orientQuat[0], last.orientQuat[1], last.orientQuat[2], last.orientQuat[3]);
    qb.set(f.root.orientQuat[0], f.root.orientQuat[1], f.root.orientQuat[2], f.root.orientQuat[3]);
    if ((qa.angleTo(qb) * 180) / Math.PI > 10) {
      orientationKeyPoints.push({ tMs: f.tMs, orientQuat: [...f.root.orientQuat] });
    }
  }

  return {
    schema: EXPORT_SCHEMA_DOC,
    meta: {
      name: rec.name,
      id: rec.id,
      variant: rec.variant,
      sourceKind: rec.sourceKind,
      ...(rec.sourceName ? { sourceName: rec.sourceName } : {}),
      sampleHz: rec.sampleHz,
      durationMs: recordingDurationMs(rec),
      frameCount: rec.frames.length,
      ...(rec.createdAtIso ? { createdAtIso: rec.createdAtIso } : {}),
    },
    timesMs,
    series,
    angularVelocityDegS,
    trajectories,
    speedsMs,
    rootTranslateM,
    summary: {
      joints,
      bones,
      root: { maxTranslateM: { x: mx, y: my, z: mz, magnitude: mag }, orientationKeyPoints },
    },
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
  };
}

/**
 * Compact wide CSV: `tMs` + one column per joint.motion angle (degrees,
 * 2-decimal), one row per frame — the spreadsheet quick-look twin of
 * {@link exportKinematics}.
 */
export function exportKinematicsCsv(rec: MotionRecording): string {
  const keys = new Set<string>();
  for (const f of rec.frames) {
    for (const [j, set] of Object.entries(f.angles)) {
      for (const [k, v] of Object.entries(set)) {
        if (typeof v === 'number' && Number.isFinite(v)) keys.add(`${j}.${k}`);
      }
    }
  }
  const cols = [...keys].sort();
  const lines = [`tMs,${cols.join(',')}`];
  for (const f of rec.frames) {
    const row = [String(Math.round(f.tMs))];
    for (const key of cols) {
      const dot = key.indexOf('.');
      const v = f.angles[key.slice(0, dot)]?.[key.slice(dot + 1)];
      row.push(typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '');
    }
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
