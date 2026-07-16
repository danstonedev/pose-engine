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
import * as THREE from 'three';
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
  /** The segment's recording, sampled from the previous segment's end state. */
  recording: MotionRecording;
  /** Max |joint-angle| discontinuity (deg) at this segment's START vs the
   *  previous segment's END — 0 for the first segment; small = no teleport. */
  seamDiscontinuityDeg: number;
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

/**
 * Sample a chain of motions with cross-motion continuity: the first segment
 * starts as authored (typically from neutral/anatomic); every later segment is
 * forced to `startFrom:'current'` and sampled from the previous segment's END
 * pose + root, so the body flows through the chain without snapping back. Returns
 * one {@link ChainedSegment} per input, each with its recording and the measured
 * seam discontinuity. Uses the SAME sampler as a standalone motion.
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
    const currentAngles = prev ? flattenAngles(prev.frames[prev.frames.length - 1]!.angles) : undefined;
    const resolved = resolveComposedMotion(motion, baseOpts.variantCfg, currentAngles ? { currentAngles } : undefined);
    const recording = sampleComposedMotion(resolved, {
      ...baseOpts,
      currentPose,
      currentRoot,
      name: motion.name,
    });
    const seamDiscontinuityDeg = prev ? measureSeamContinuity(prev, recording) : 0;
    out.push({ motion, recording, seamDiscontinuityDeg });

    const last = recording.frames[recording.frames.length - 1];
    if (last) {
      currentPose = last.pose;
      currentRoot = { quat: last.root.orientQuat, translateM: last.root.translateM };
    }
    prev = recording;
  }
  return out;
}
