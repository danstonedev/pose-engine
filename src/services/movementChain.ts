/**
 * COMPOUND MOTION CHAINS (simMOVE Phase 4) — build a larger movement by
 * sequencing VALIDATED primitives, with cross-motion continuity so the body
 * never teleports between segments.
 *
 * The engine already supports continuity: a {@link ComposedMotion} with
 * `startFrom:'current'` folds onto the pose the body is CURRENTLY in (unmentioned
 * joints persist), and {@link sampleComposedMotion} threads a `currentPose` /
 * `currentRoot`. Phase 4 packages that into a chain runner — each segment after
 * the first continues from the previous segment's END pose + root — plus a seam
 * check so "no teleport between segments" is a MEASURED gate, and a per-segment
 * hook so each sub-movement can be scored against its own Phase-1 signature.
 *
 * Nothing new in the trajectory/measurement path — this is composition over the
 * existing sampler, so a chained segment is frame-for-frame identical to running
 * that segment standalone from the same start pose.
 */
import { sampleComposedMotion, type MotionRecording, type SampleComposedOptions } from './motionRecording';
import { resolveComposedMotion, type ComposedMotion } from './motionSequence';
import type { CustomPose } from '../types';

/** Force a segment to CONTINUE from the current on-stage pose (fold, don't
 *  reset). Templates default to `startFrom:'neutral'`, which would teleport the
 *  rest of the body back to anatomic at the seam — this is the opt-in to
 *  continuity. */
export function asContinuation(motion: ComposedMotion): ComposedMotion {
  return { ...motion, startFrom: 'current' };
}

export interface ChainedSegment {
  /** The (possibly continuation-forced) motion that was sampled. */
  motion: ComposedMotion;
  /** The segment's recording, sampled from the previous segment's end state.
   *  Empty (`frames: []`) when `status` is 'refused'. */
  recording: MotionRecording;
  /** 'ok' when the segment resolved + sampled; 'refused' when it produced no
   *  frames (unknown/unachievable motion) — the chain does NOT thread state
   *  through a refused segment (it can't continue from nothing). */
  status: 'ok' | 'refused';
  /** Max |joint-angle| discontinuity (deg) at this segment's START vs the
   *  previous OK segment's END — 0 for the first segment. NOTE: for a
   *  continuation this is ~0 BY CONSTRUCTION (the segment is sampled FROM the
   *  previous end pose), so it confirms the joint pose was threaded, not that the
   *  motion is physically continuous — pair it with {@link seamRootTranslateM} /
   *  {@link seamRootOrientDeg} for the whole-body seam. */
  seamDiscontinuityDeg: number;
  /** World-space root TRANSLATION jump (m) at the seam — catches a broken root
   *  thread that joint angles can't see (a body that snaps across the floor). */
  seamRootTranslateM: number;
  /** World-space root ORIENTATION jump (deg) at the seam. */
  seamRootOrientDeg: number;
}

/** Flatten a frame's measured angles to a `joint.motion → deg` map (the shape
 *  resolveComposedMotion's velocity governor seeds from). */
function flattenAngles(angles: Record<string, Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [j, set] of Object.entries(angles)) {
    for (const [m, v] of Object.entries(set)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[`${j}.${m}`] = v;
    }
  }
  return out;
}

/**
 * Max absolute joint-angle difference (deg) between recording `a`'s LAST frame
 * and recording `b`'s FIRST frame, over the joints they share — the "did the
 * body teleport at the seam?" metric. ~0 when `b` continued from `a`'s end.
 */
export function measureSeamContinuity(a: MotionRecording, b: MotionRecording): number {
  const la = a.frames[a.frames.length - 1]?.angles ?? {};
  const fb = b.frames[0]?.angles ?? {};
  let max = 0;
  for (const [j, set] of Object.entries(la)) {
    for (const [m, v] of Object.entries(set)) {
      const w = fb[j]?.[m];
      if (typeof w === 'number' && Number.isFinite(w) && typeof v === 'number' && Number.isFinite(v)) {
        max = Math.max(max, Math.abs(v - w));
      }
    }
  }
  return max;
}

/** Whole-body ROOT discontinuity at a seam: the world translation jump (m) and
 *  orientation jump (deg) between `a`'s last frame and `b`'s first. Joint angles
 *  are ~0 across a threaded seam by construction, but a dropped/incorrect root
 *  thread snaps the whole body across the world without moving a single joint —
 *  so this is the seam check that actually gates a TRAVELING/re-postured chain. */
export function measureSeamRootDiscontinuity(
  a: MotionRecording,
  b: MotionRecording,
): { translateM: number; orientDeg: number } {
  const ra = a.frames[a.frames.length - 1]?.root;
  const rb = b.frames[0]?.root;
  if (!ra || !rb) return { translateM: 0, orientDeg: 0 };
  const dt = Math.hypot(
    rb.translateM[0] - ra.translateM[0],
    rb.translateM[1] - ra.translateM[1],
    rb.translateM[2] - ra.translateM[2],
  );
  // Angle between the two orientation quaternions: 2·acos(|dot|).
  const dot = Math.abs(
    ra.orientQuat[0] * rb.orientQuat[0] +
      ra.orientQuat[1] * rb.orientQuat[1] +
      ra.orientQuat[2] * rb.orientQuat[2] +
      ra.orientQuat[3] * rb.orientQuat[3],
  );
  const orientDeg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
  return { translateM: dt, orientDeg };
}

/**
 * Sample a chain of motions with cross-motion continuity: the first segment
 * starts as authored (typically from neutral/anatomic); every later segment is
 * forced to `startFrom:'current'` and sampled from the previous segment's END
 * pose + root, so the body flows through the chain without snapping back. Returns
 * one {@link ChainedSegment} per input, each with its recording and the measured
 * seam discontinuity. Uses the SAME sampler as a standalone motion.
 *
 * A segment that RESOLVES to refused (or otherwise samples no frames) is recorded
 * with `status:'refused'` and does NOT advance the continuity state — the chain
 * continues from the last OK segment rather than crashing on, or silently
 * threading through, an empty recording.
 *
 * CAVEATS: the continuity origin is captured from the harness root AT CALL TIME
 * (all threaded translations are relative to it), so pass a harness at its
 * grounded rest. And per-segment SIGNATURE validation (Phase 1) is only
 * apples-to-apples when a segment starts from ≈ the pose its reference signature
 * was built from — true for return-to-neutral primitives; a segment whose driver
 * joints start displaced needs a matched-start reference.
 */
export function sampleMotionChain(
  segments: ComposedMotion[],
  baseOpts: Omit<SampleComposedOptions, 'currentPose' | 'currentRoot' | 'name' | 'sourceName'>,
): ChainedSegment[] {
  const out: ChainedSegment[] = [];
  let currentPose: CustomPose | null = null;
  let currentRoot: { quat?: [number, number, number, number]; translateM?: [number, number, number] } | null = null;
  let prev: MotionRecording | null = null;

  // sampleComposedMotion captures the harness root's CURRENT transform as its
  // grounded rest, and continuity is threaded via `currentRoot.translateM`
  // (offset from that rest). So the harness root must be at the SAME grounded
  // origin for every segment — otherwise a traveling segment's travel accumulates
  // into the next segment's rest and double-counts. Reset to the entry transform
  // before each segment.
  const harnessRoot = baseOpts.skeletonHarness.root;
  const rest0Pos = harnessRoot.position.clone();
  const rest0Quat = harnessRoot.quaternion.clone();

  for (let i = 0; i < segments.length; i += 1) {
    harnessRoot.position.copy(rest0Pos);
    harnessRoot.quaternion.copy(rest0Quat);
    harnessRoot.updateMatrixWorld(true);
    const motion = i === 0 ? segments[i]! : asContinuation(segments[i]!);
    // Seed the velocity governor from the previous OK segment's end angles (guard
    // against an empty previous recording — a refused segment leaves no frames).
    const currentAngles =
      prev && prev.frames.length > 0 ? flattenAngles(prev.frames[prev.frames.length - 1]!.angles) : undefined;
    // Thread BOTH continuity seeds into resolution: the angles seed the
    // velocity governor, and the root lets a heading-inheriting gait segment
    // (`inheritHeading` — the persistent-heading rebase, SEAM-1) rotate its
    // authored yaw plan onto the facing the previous segment actually left the
    // body at. Ignored (byte-identical) for every unflagged motion.
    const resolved = resolveComposedMotion(
      motion,
      baseOpts.variantCfg,
      currentAngles || currentRoot
        ? {
            ...(currentAngles ? { currentAngles } : {}),
            ...(currentRoot ? { currentRoot } : {}),
          }
        : undefined,
    );
    const recording = sampleComposedMotion(resolved, {
      ...baseOpts,
      currentPose,
      currentRoot,
      name: motion.name,
    });

    const last = recording.frames[recording.frames.length - 1];
    if (!last) {
      // Refused / empty: record it and DO NOT advance continuity state.
      out.push({ motion, recording, status: 'refused', seamDiscontinuityDeg: 0, seamRootTranslateM: 0, seamRootOrientDeg: 0 });
      continue;
    }
    const root = prev ? measureSeamRootDiscontinuity(prev, recording) : { translateM: 0, orientDeg: 0 };
    out.push({
      motion,
      recording,
      status: 'ok',
      seamDiscontinuityDeg: prev ? measureSeamContinuity(prev, recording) : 0,
      seamRootTranslateM: root.translateM,
      seamRootOrientDeg: root.orientDeg,
    });
    currentPose = last.pose;
    currentRoot = { quat: last.root.orientQuat, translateM: last.root.translateM };
    prev = recording;
  }
  return out;
}
