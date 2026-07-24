/**
 * Live-stage diagnostic readout (measure-only) — the pure computation behind the
 * on-canvas HUD. Extracted from ExamStage3D so it is unit-testable and the
 * component keeps only the per-frame plumbing.
 *
 * Reads the ACTUAL rendered pose (world matrices, after the idle / motion
 * overlays are baked), so a transient onset tilt the clean joint-angle report
 * never sees is still reported. Sign convention: + = the patient's LEFT (+X),
 * matching the engine's lateral sign. Never mutates anything.
 */

export interface StageDiagnostics {
  /** Current frame source. */
  state: 'transition' | 'composed' | 'clip' | 'travel' | 'idle' | 'held';
  /** Whole-trunk lateral lean (Hips→Head world axis), degrees. */
  trunkTiltDeg: number;
  /** Low-back segment lateral lean (Spine_Lower→Spine_Upper), degrees. */
  lumbarTiltDeg: number;
  /** Root lateral offset from grounded rest, centimetres. */
  pelvisShiftCm: number;
  /** Idle overlay currently baked. */
  idle: boolean;
  /** Ankle-pivot idle sway currently baked. */
  pivot: boolean;
  /** Motion-liveliness onset ramp, 0..100 (0 when no motion drives). */
  livelinessPct: number;
  /** balance-sway modifier, 0..1. */
  swayMod: number;
  /** pelvis-shift modifier request, centimetres. */
  shiftModCm: number;
}

/** Minimal shape of a THREE.Object3D whose world matrix is current. */
export interface WorldMatrixed {
  matrixWorld: { elements: ArrayLike<number> };
}

/** Which driver owns the skeleton this frame (used for the `state` label). */
export interface DriverFlags {
  activeTween: boolean;
  composedActive: boolean;
  activeMotion: boolean;
  activeTrajectory: boolean;
  idleOverlayOn: boolean;
  idlePivotOn: boolean;
}

export interface StageDiagnosticsInputs {
  /** Spine_Lower bone (low back). */
  lower?: WorldMatrixed;
  /** Spine_Upper bone (thorax). */
  upper?: WorldMatrixed;
  /** Head bone. */
  head?: WorldMatrixed;
  /** Hips bone; falls back to `lower` when absent. */
  hips?: WorldMatrixed;
  /** modelRoot.position.x (world metres). */
  rootX: number;
  /** rootRestPos.x — the grounded rest X the shift is measured from. */
  rootRestX: number;
  driver: DriverFlags;
  /** Seconds since the current motion's onset. */
  livelinessOnsetSec: number;
  /** Onset ramp duration (LIVELINESS_ONSET_SEC). */
  livelinessOnsetTotalSec: number;
  /** balance-sway modifier 0..1. */
  swayMod: number;
  /** pelvis-shift modifier request, metres. */
  shiftModM: number;
}

/** Lateral lean (deg) of the axis `from`→`to`, read straight from world
 *  matrices (elements 12/13 = x/y). + = +X (patient's left). 0 if either bone
 *  is missing. */
export function axisTiltDeg(from: WorldMatrixed | undefined, to: WorldMatrixed | undefined): number {
  if (!from || !to) return 0;
  const fe = from.matrixWorld.elements;
  const te = to.matrixWorld.elements;
  return (Math.atan2(te[12] - fe[12], te[13] - fe[13]) * 180) / Math.PI;
}

/** Compute the measure-only diagnostic snapshot for the current frame. Pure. */
export function computeStageDiagnostics(i: StageDiagnosticsInputs): StageDiagnostics {
  const hips = i.hips ?? i.lower;
  const motionOn = i.driver.activeMotion || i.driver.composedActive;
  const state: StageDiagnostics['state'] = i.driver.activeTween
    ? 'transition'
    : i.driver.composedActive
      ? 'composed'
      : i.driver.activeMotion
        ? 'clip'
        : i.driver.activeTrajectory
          ? 'travel'
          : i.driver.idleOverlayOn
            ? 'idle'
            : 'held';
  return {
    state,
    trunkTiltDeg: axisTiltDeg(hips, i.head),
    lumbarTiltDeg: axisTiltDeg(i.lower, i.upper),
    pelvisShiftCm: (i.rootX - i.rootRestX) * 100,
    idle: i.driver.idleOverlayOn,
    pivot: i.driver.idlePivotOn,
    livelinessPct:
      motionOn && i.livelinessOnsetTotalSec > 0
        ? Math.min(1, i.livelinessOnsetSec / i.livelinessOnsetTotalSec) * 100
        : 0,
    swayMod: i.swayMod,
    shiftModCm: i.shiftModM * 100,
  };
}
