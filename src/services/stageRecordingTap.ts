/**
 * MOTION RECORDING TAP — extracted from ExamStage3D.
 *
 * Owns the ACTIVE-RECORDING lifecycle: the sample buffer, the requested rate,
 * and the frame-throttle clock. It samples the live stage into a
 * {@link MotionRecording} while active and works across every driver (clip,
 * exam tween, composed playback, or idle manual time) because it never touches
 * the scene itself — the stage injects a {@link BuildFrame} that snapshots the
 * current pose/root/angles, and the tap just decides WHEN to call it and where
 * to store the result.
 *
 * Pure w.r.t. the clock: every method takes `nowMs` from the caller and the
 * clock-derived recording metadata (id / createdAtIso) is caller-stamped, so
 * the tap is fully deterministic under a fake clock + fake `buildFrame` in
 * tests. Negligible overhead when idle: `sample()` is one null check per frame.
 */
import type {
  MotionRecording,
  MotionRecordingSourceKind,
  RecordedFrame,
} from './motionRecording';

export interface RecordingStartOpts {
  sampleHz?: number;
  name?: string;
  sourceKind?: MotionRecordingSourceKind;
  sourceName?: string;
}

/** Snapshot one RecordedFrame at motion-relative time `tMs` (null when the
 *  stage can't sample yet — no skeleton/variant/rest/root). Injected by the
 *  stage; the tap never reads the scene. */
export type BuildFrame = (tMs: number) => RecordedFrame | null;

/** Clock/random-derived metadata the pure tap can't produce itself — the
 *  component stamps it at stop time. */
export interface RecordingStampMeta {
  id: string;
  variant: string;
  createdAtIso: string;
}

export interface RecordingTap {
  /** Begin sampling at `opts.sampleHz` (default 30, clamped 1–120); captures
   *  frame 0 (the starting pose) immediately. A second call restarts. */
  start(opts: RecordingStartOpts | undefined, nowMs: number, buildFrame: BuildFrame): void;
  /** Stop sampling, capture the settle frame at `nowMs`, and return the
   *  recording (null when nothing was recording). */
  stop(nowMs: number, buildFrame: BuildFrame, meta: RecordingStampMeta): MotionRecording | null;
  /** Throttled per-frame sampler — call every rAF. No-op when inactive or the
   *  sample interval hasn't elapsed. */
  sample(nowMs: number, buildFrame: BuildFrame): void;
  /** True while a recording is being captured. */
  readonly active: boolean;
}

export function createRecordingTap(): RecordingTap {
  interface ActiveRecording {
    sampleHz: number;
    name: string;
    sourceKind: MotionRecordingSourceKind;
    sourceName?: string;
    startT: number;
    lastSample: number;
    frames: RecordedFrame[];
  }
  let recording: ActiveRecording | null = null;

  function capture(rec: ActiveRecording, nowMs: number, buildFrame: BuildFrame): void {
    const frame = buildFrame(nowMs - rec.startT);
    if (frame) rec.frames.push(frame);
  }

  function start(
    opts: RecordingStartOpts | undefined,
    nowMs: number,
    buildFrame: BuildFrame,
  ): void {
    recording = {
      sampleHz: Math.max(1, Math.min(120, opts?.sampleHz ?? 30)),
      name: opts?.name ?? 'recording',
      sourceKind: opts?.sourceKind ?? 'manual',
      ...(opts?.sourceName ? { sourceName: opts.sourceName } : {}),
      startT: nowMs,
      lastSample: nowMs,
      frames: [],
    };
    capture(recording, nowMs, buildFrame); // frame 0 — the starting pose
  }

  function stop(
    nowMs: number,
    buildFrame: BuildFrame,
    meta: RecordingStampMeta,
  ): MotionRecording | null {
    const rec = recording;
    recording = null;
    if (!rec) return null;
    // Final frame at stop time so the settle pose is always captured.
    capture(rec, nowMs, buildFrame);
    return {
      id: meta.id,
      name: rec.name,
      variant: meta.variant,
      sourceKind: rec.sourceKind,
      ...(rec.sourceName ? { sourceName: rec.sourceName } : {}),
      sampleHz: rec.sampleHz,
      frames: rec.frames,
      createdAtIso: meta.createdAtIso,
    };
  }

  function sample(nowMs: number, buildFrame: BuildFrame): void {
    if (!recording) return;
    // Same throttle as the motionReportHz streaming: fire when the sample
    // interval has elapsed (−4 ms tolerance so a slightly-early rAF still hits).
    if (nowMs - recording.lastSample >= 1000 / recording.sampleHz - 4) {
      recording.lastSample = nowMs;
      capture(recording, nowMs, buildFrame);
    }
  }

  return {
    start,
    stop,
    sample,
    get active() {
      return recording !== null;
    },
  };
}
