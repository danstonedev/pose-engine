/**
 * COMPOSED-MOTION RIG DERIVATIONS — extracted from ExamStage3D.
 *
 * When a composed motion starts, four tables are derived by PRE-PASSING its
 * trajectory over the live rig: the calibrated gait vertical, the foot-driven
 * forward travel, the medio-lateral shuttle, and the heel-strike accents. Each
 * one poses the rig at sampled times, reads where the body actually lands, and
 * fits a correction — so they all depend on the rig, not just on the authored
 * keyframes. That is why they live here rather than in the pure `rootMotion`
 * helpers they call: this module is the RIG-FACING half, and it owns the one
 * shared pre-pass (`previewTrajectoryAt`) the four must agree on.
 *
 * The derivations POSE THE RIG TRANSIENTLY. That is safe because the player
 * re-poses every frame; nothing downstream reads the rig between a derivation
 * and the next frame.
 *
 * Every function is a PURE FUNCTION OF (context, trajectory, params) → table:
 * nothing is stored here, so the stage keeps owning the `composed*` state its
 * per-frame appliers read. Given a fake rig + a fake trajectory the whole
 * module is unit-testable, which the stage component itself is not.
 *
 * Loaded via dynamic import (like the other three-using services) so importing
 * ExamStage3D never pulls three into a host's SSR/prerender graph.
 */
import * as THREE from 'three';
import { applyCustomPose, buildBoneByPoseKey } from './poseRig';
import {
  GAIT_VERTICAL_MAX_RISE_M,
  authoredToTrajectoryTimeScale,
  scaleStanceWindowsMs,
} from './motionRecording';
import {
  NO_VERTICAL_CALIBRATION,
  applyVerticalCalibration,
  captureFloorReference,
  deriveFootDrivenTravel,
  deriveGaitLateralShuttle,
  deriveHeelStrikeAccents,
  deriveVerticalCalibration,
  headingProfileLookup,
  pinRootToFloor,
} from './rootMotion';
import type { PoseTrajectory } from './motionTrajectory';
import type { getBodyVariant } from '../anatomy/bodyVariants';

type VariantCfg = ReturnType<typeof getBodyVariant>;
type FloorRef = ReturnType<typeof captureFloorReference>;

/** A planned stance window in TRAJECTORY time. */
export interface StanceWindow {
  foot: string;
  fromMs: number;
  toMs: number;
  travelLock?: boolean;
}

/** The authored-timing fields the time-scaling helpers read off a resolved motion. */
interface AuthoredTiming {
  keyframes: { durationMs: number; holdMs: number }[];
  loop: boolean;
  reps: number;
}

/**
 * The live rig as the derivations see it. The stage passes an object of getters
 * over its own refs, so this stays a live view (never a stale snapshot) without
 * the derivations reaching into component state.
 */
export interface StageRigContext {
  readonly root: THREE.Object3D | null;
  readonly skinned: THREE.SkinnedMesh | null;
  readonly variantCfg: VariantCfg | null;
  readonly floor: FloorRef | null;
  /** The grounded rest transform every trajectory sample is composed onto. */
  readonly rootRestPos: THREE.Vector3;
  readonly rootRestQuat: THREE.Quaternion;
  /** Invoked on every absolute root write — keeps the pelvis-shift tracker honest. */
  clearPelvisShiftBake(): void;
}

/** The vertical-calibration state a heel-strike derivation rides on. */
export interface VerticalCalibrationState {
  table: ReturnType<typeof deriveVerticalCalibration>;
  cycleMs: number;
  phaseOffsetMs: number;
  rampMs: number;
}

/** What {@link ComposedDerivations.verticalCalibration} resolves to. */
export interface VerticalCalibrationResult {
  table: ReturnType<typeof deriveVerticalCalibration>;
  /** Cycle length (ms) the table was derived from; 0 when uncalibrated. */
  cycleMs: number;
}

export interface ComposedDerivations {
  /** Pose the rig at `tMs` of `traj` on the playback root base and return the
   *  sample. Exposed for derivations layered on top of these four. */
  previewTrajectoryAt(traj: PoseTrajectory, tMs: number): ReturnType<PoseTrajectory['sampleAt']>;
  /** Measure the emergent grounded pelvis arc and fit it to `targetCm` of
   *  excursion. Identity (`NO_VERTICAL_CALIBRATION`, cycle 0) when uncalibrated,
   *  unplanted, or the rig is unavailable. */
  verticalCalibration(
    traj: PoseTrajectory,
    targetCm: number | undefined,
    hasPlanted: boolean,
    plantsActive: boolean,
  ): VerticalCalibrationResult;
  /** Derive the +Z travel that keeps the planted foot world-fixed, along the
   *  motion's heading. Null when disabled/unplanted/rig-unavailable. */
  footDrivenTravel(
    traj: PoseTrajectory,
    enabled: boolean,
    hasPlanted: boolean,
    stanceWindows?: StanceWindow[],
    headingDeg?: number,
    headingAt?: (tMs: number) => number,
  ): ReturnType<typeof deriveFootDrivenTravel> | null;
  /** Derive the stance-locked ±X pelvis ride toward the planted foot,
   *  perpendicular to the heading. Null unless the motion requests it. */
  lateralShuttle(
    traj: PoseTrajectory,
    shuttleCm: number | undefined,
    hasPlanted: boolean,
    stanceWindows?: StanceWindow[],
    headingDeg?: number,
    headingAt?: (tMs: number) => number,
  ): ReturnType<typeof deriveGaitLateralShuttle> | null;
  /** Derive the footfall dip-and-recover accents on the CALIBRATED root-Y arc.
   *  Must run after the vertical calibration for the same motion (it rides on
   *  that arc). Null without a planned stance schedule. */
  heelStrikeAccents(
    traj: PoseTrajectory,
    enabled: boolean,
    stanceWindows: StanceWindow[] | undefined,
    vcal: VerticalCalibrationState,
  ): ReturnType<typeof deriveHeelStrikeAccents>;
}

/**
 * SEAM-2: re-time a motion's planned stance windows from AUTHORED ms into
 * TRAJECTORY ms with the same uniform factor the trajectory applies, so the
 * derivations stay phase-locked to the knots at any pace (mirrors the offline
 * sampler — one source of truth for the time base).
 */
export function scaledStanceWindows(
  traj: PoseTrajectory,
  resolvedMotion: AuthoredTiming & { gaitStanceWindowsMs?: StanceWindow[] },
): StanceWindow[] | undefined {
  return scaleStanceWindowsMs(
    resolvedMotion.gaitStanceWindowsMs,
    authoredToTrajectoryTimeScale(resolvedMotion, traj.totalMs),
  );
}

/**
 * The per-time heading lookup of a CURVED motion, scaled by the SAME factor as
 * {@link scaledStanceWindows} so heading and stance phase can never drift apart
 * at a non-1 pace. Undefined for a constant heading (the legacy path).
 */
export function scaledHeadingAt(
  traj: PoseTrajectory,
  resolvedMotion: AuthoredTiming & { headingProfileMs?: { tMs: number; headingDeg: number }[] },
): ((tMs: number) => number) | undefined {
  const prof = resolvedMotion.headingProfileMs;
  if (!prof || prof.length < 2) return undefined;
  const scale = authoredToTrajectoryTimeScale(resolvedMotion, traj.totalMs);
  const lookup = headingProfileLookup(prof);
  return scale > 0 ? (tMs: number): number => lookup(tMs / scale) : lookup;
}

export function createComposedDerivations(ctx: StageRigContext): ComposedDerivations {
  const _rootQA = new THREE.Quaternion();

  /** True when every ref the pre-pass dereferences is present. */
  function rigReady(): boolean {
    return !!(ctx.skinned && ctx.variantCfg && ctx.floor && ctx.root);
  }

  /**
   * SHARED TRAJECTORY PRE-PASS. Pose the rig at `tMs` of `traj` and place the
   * root on the SAME base applyTrajectoryRoot uses — rest ∘ sample, then the
   * floor pin when the sample is planted — and return the sample. All four
   * derivations pre-pass exactly this way, so one source of truth keeps them
   * from drifting apart from each other or from the offline sampler. Callers
   * must have checked {@link rigReady} first.
   */
  function previewTrajectoryAt(traj: PoseTrajectory, tMs: number) {
    const s = traj.sampleAt(tMs);
    applyCustomPose(ctx.skinned!.skeleton, ctx.variantCfg!, s.pose);
    _rootQA.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
    ctx.root!.quaternion.copy(ctx.rootRestQuat).multiply(_rootQA);
    ctx.root!.position.set(
      ctx.rootRestPos.x + s.rootTranslate[0],
      ctx.rootRestPos.y + s.rootTranslate[1],
      ctx.rootRestPos.z + s.rootTranslate[2],
    );
    ctx.clearPelvisShiftBake(); // transient absolute write — keep the tracker honest
    ctx.root!.updateMatrixWorld(true);
    if (s.planted) pinRootToFloor(ctx.root!, ctx.skinned!.skeleton, ctx.variantCfg!, ctx.floor!);
    return s;
  }

  /** Resolve both foot bones for a gait derivation (null when either is absent). */
  function footBones(): { rBone: THREE.Bone; lBone: THREE.Bone } | null {
    const bones = buildBoneByPoseKey(ctx.skinned!.skeleton, ctx.variantCfg!);
    const rBone = bones.get('R_Foot');
    const lBone = bones.get('L_Foot');
    return rBone && lBone ? { rBone, lBone } : null;
  }

  function verticalCalibration(
    traj: PoseTrajectory,
    targetCm: number | undefined,
    hasPlanted: boolean,
    plantsActive: boolean,
  ): VerticalCalibrationResult {
    if (targetCm == null || !hasPlanted || !rigReady()) {
      return { table: NO_VERTICAL_CALIBRATION, cycleMs: 0 };
    }
    const table = deriveVerticalCalibration(
      (u01) => {
        previewTrajectoryAt(traj, u01 * traj.totalMs);
        return ctx.root!.position.y;
      },
      targetCm / 100,
      48,
      // smooth: round the sharp double-support valley. When feet are foot-plant IK'd
      // (the travelling walk), clamp how far the smoothed pelvis may rise above the pin
      // so a planted stance leg doesn't over-reach and slide the foot — the SAME
      // maxRiseM the offline sampler passes, under the SAME plants-active condition
      // (DET-LOCK-01 lockstep); the contact-free in-place walk (treadmill) has no such
      // foot to over-reach, so no clamp.
      true,
      plantsActive ? GAIT_VERTICAL_MAX_RISE_M : undefined,
    );
    return { table, cycleMs: traj.totalMs };
  }

  function footDrivenTravel(
    traj: PoseTrajectory,
    enabled: boolean,
    hasPlanted: boolean,
    stanceWindows?: StanceWindow[],
    headingDeg = 0,
    headingAt?: (tMs: number) => number,
  ): ReturnType<typeof deriveFootDrivenTravel> | null {
    if (!enabled || !hasPlanted || !rigReady()) return null;
    const feet = footBones();
    if (!feet) return null;
    const { rBone, lBone } = feet;
    return deriveFootDrivenTravel(
      (tMs) => {
        const s = previewTrajectoryAt(traj, tMs);
        const rp = rBone.getWorldPosition(new THREE.Vector3());
        const lp = lBone.getWorldPosition(new THREE.Vector3());
        // An un-pinned sample is a run's ballistic FLIGHT gap (both feet
        // airborne): the travel derivation holds its advance through it
        // (mirrors the offline sampler's closure exactly).
        return { rz: rp.z, ry: rp.y, rx: rp.x, lz: lp.z, ly: lp.y, lx: lp.x, bothAirborne: !s.planted };
      },
      traj.totalMs,
      stanceWindows,
      120,
      headingDeg,
      headingAt,
    );
  }

  function lateralShuttle(
    traj: PoseTrajectory,
    shuttleCm: number | undefined,
    hasPlanted: boolean,
    stanceWindows?: StanceWindow[],
    headingDeg = 0,
    headingAt?: (tMs: number) => number,
  ): ReturnType<typeof deriveGaitLateralShuttle> | null {
    if (!shuttleCm || shuttleCm <= 0 || !hasPlanted || !rigReady()) return null;
    const feet = footBones();
    if (!feet) return null;
    const { rBone, lBone } = feet;
    return deriveGaitLateralShuttle(
      (tMs) => {
        previewTrajectoryAt(traj, tMs);
        const rp = rBone.getWorldPosition(new THREE.Vector3());
        const lp = lBone.getWorldPosition(new THREE.Vector3());
        return { rx: rp.x, ry: rp.y, rz: rp.z, lx: lp.x, ly: lp.y, lz: lp.z };
      },
      traj.totalMs,
      shuttleCm / 100,
      stanceWindows,
      120,
      headingDeg,
      headingAt,
    );
  }

  function heelStrikeAccents(
    traj: PoseTrajectory,
    enabled: boolean,
    stanceWindows: StanceWindow[] | undefined,
    vcal: VerticalCalibrationState,
  ): ReturnType<typeof deriveHeelStrikeAccents> {
    if (!enabled || !stanceWindows?.length || !rigReady()) return null;
    return deriveHeelStrikeAccents(
      (tMs) => {
        const s = previewTrajectoryAt(traj, tMs);
        let y = ctx.root!.position.y;
        if (s.planted && (vcal.table.gain !== 1 || vcal.table.smoothed)) {
          // Same phase mapping + entry ramp as applyTrajectoryRoot (loop-form
          // table alignment, DET-LOCK-02) — identity for non-loop gaits.
          const u01 = vcal.cycleMs > 0 ? (tMs - vcal.phaseOffsetMs) / vcal.cycleMs : 0;
          let yc = applyVerticalCalibration(y, vcal.table, u01);
          if (vcal.rampMs > 0 && tMs < vcal.rampMs) yc = y + (yc - y) * (tMs / vcal.rampMs);
          y = yc;
        }
        return y;
      },
      stanceWindows.map((w) => w.fromMs),
      traj.totalMs,
    );
  }

  return {
    previewTrajectoryAt,
    verticalCalibration,
    footDrivenTravel,
    lateralShuttle,
    heelStrikeAccents,
  };
}
