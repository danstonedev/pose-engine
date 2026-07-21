/**
 * BETWEEN-COMMAND RETURN-TO-READY — the natural beat a person makes when directed
 * through movements one after another: from wherever the last move left the body,
 * ease back to a neutral standing "ready" stance and pause briefly before the next.
 *
 * This module holds the PURE, headless-testable decision + timing; the live stage
 * (ExamStage3D) applies the settle itself by easing the current pose to the anatomic
 * baseline (via the existing staged pose tween) while keeping the body IN PLACE
 * (no teleport to the origin), then holding {@link READY_HOLD_MS}. Kept pure here so
 * the "is a settle warranted?" logic is unit-tested without a live stage.
 */
import type { CustomPose } from '../types';

/** Ease-to-neutral duration, ms — the return-to-standing before the next move. */
export const READY_SETTLE_MS = 650;
/** Dwell at the ready stance once reached, ms — the "pause at a ready stance" beat. */
export const READY_HOLD_MS = 300;

/** Body is "off ready" in POSE beyond this per-bone angle (deg) ⇒ ease back first. */
export const READY_POSE_TOLERANCE_DEG = 7;
/** Body has travelled this far off origin (m, horizontal) ⇒ a settle is warranted. */
export const READY_ROOT_TOLERANCE_M = 0.03;
/** Root sits this far off the grounded standing Y (m, vertical) ⇒ a settle is
 *  warranted (SEAM-10). A motion that ends with the pelvis raised/lowered but
 *  otherwise at ready must TWEEN the root back down to the floor, not snap it —
 *  so the vertical drift is checked alongside pose/horizontal/orientation. */
export const READY_ROOT_VERTICAL_TOLERANCE_M = 0.01;

/**
 * Max per-bone rotation difference (deg) between two poses — 0 when identical. Used
 * to tell whether the body is meaningfully OFF its neutral stance (so the next
 * command should show a visible return-to-ready) versus already standing ready.
 */
export function maxPoseAngleDiffDeg(a: CustomPose, b: CustomPose): number {
  const ab = a.bones ?? {};
  const bb = b.bones ?? {};
  let max = 0;
  for (const key of Object.keys(bb)) {
    const qa = ab[key];
    const qb = bb[key];
    if (!qa || !qb) continue;
    const dot = Math.min(1, Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]));
    const deg = (2 * Math.acos(dot) * 180) / Math.PI;
    if (deg > max) max = deg;
  }
  return max;
}

/**
 * Whether a return-to-ready settle is warranted before the next command: the body
 * has drifted off its neutral stance in POSE, travelled off origin, or been
 * reoriented (root not upright). When false, the body is already at ready and the
 * next move can begin without an artificial reset.
 */
export function readyTransitionNeeded(args: {
  poseAngleDiffDeg: number;
  rootHorizontalM: number;
  /** |w| of the root orientation quaternion relative to rest (1 = perfectly upright). */
  rootUprightW: number;
  /** |Y| of the root off the grounded standing Y (m). Omitted ⇒ 0 (byte-identical
   *  to the pre-SEAM-10 decision). A body left above/below the floor triggers the
   *  tweened settle so the reset eases the pelvis to the ground, never snaps it. */
  rootVerticalM?: number;
}): boolean {
  return (
    args.poseAngleDiffDeg > READY_POSE_TOLERANCE_DEG ||
    args.rootHorizontalM > READY_ROOT_TOLERANCE_M ||
    (args.rootVerticalM ?? 0) > READY_ROOT_VERTICAL_TOLERANCE_M ||
    args.rootUprightW < 0.999
  );
}

/**
 * The grounded-standing root state the ready-reset TWEENS toward (SEAM-10): the
 * body stands up IN PLACE — horizontal position preserved (no teleport/slide back
 * to the origin), orientation returned upright, and the vertical dropped to the
 * grounded standing Y (0 relative to the grounded rest). Encoded here (pure) so
 * the live stage's ready-reset tween lands the root at the correct grounded Y by
 * construction — eased, never snapped.
 */
export function readyResetRootTarget(
  fromTranslateM: readonly [number, number, number],
): { toQuat: [number, number, number, number]; toTranslateM: [number, number, number] } {
  return {
    toQuat: [0, 0, 0, 1],
    toTranslateM: [fromTranslateM[0], 0, fromTranslateM[2]],
  };
}
