/**
 * Unit tests for the extracted recording-tap lifecycle (services/stageRecordingTap).
 *
 * The tap owns only the buffer + sample-throttle; the stage snapshot is injected
 * as `buildFrame`. With a fake clock + fake buildFrame the whole lifecycle is
 * deterministic, so these pin the throttle math, frame-0/settle capture, the
 * caller-stamped metadata, and the null-frame guard — the invariants the live
 * rAF loop relies on.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRecordingTap } from '../services/stageRecordingTap';
import type { RecordedFrame } from '../services/motionRecording';

/** Minimal RecordedFrame stub — the tap never inspects its contents, only the
 *  tMs it was asked to build (so we can assert relative timing). */
function frameAt(tMs: number): RecordedFrame {
  return {
    tMs,
    pose: {},
    angles: {},
    root: { orientQuat: [0, 0, 0, 1], translateM: [0, 0, 0] },
    worldTracks: {},
  } as unknown as RecordedFrame;
}

const META = { id: 'rec-test', variant: 'v1', createdAtIso: '2020-01-01T00:00:00.000Z' };

describe('stageRecordingTap', () => {
  it('is inactive until started and active after start', () => {
    const tap = createRecordingTap();
    expect(tap.active).toBe(false);
    tap.start(undefined, 0, (t) => frameAt(t));
    expect(tap.active).toBe(true);
  });

  it('captures frame 0 (the starting pose) at start, at motion-relative t=0', () => {
    const tap = createRecordingTap();
    const build = vi.fn((t: number) => frameAt(t));
    tap.start({ sampleHz: 30 }, 1000, build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(0); // startT === now, so tMs = 0
  });

  it('throttles samples to the requested rate (30 Hz ⇒ ~33 ms spacing, −4 ms tol)', () => {
    const tap = createRecordingTap();
    const build = vi.fn((t: number) => frameAt(t));
    tap.start({ sampleHz: 30 }, 0, build); // frame 0
    // interval = 1000/30 - 4 ≈ 29.3 ms
    tap.sample(20, build); // too soon → no capture
    expect(build).toHaveBeenCalledTimes(1);
    tap.sample(30, build); // ≥ 29.3 → capture (tMs = 30)
    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenLastCalledWith(30);
    tap.sample(45, build); // 45-30=15 < 29.3 → no capture
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('sample() is a no-op when not recording', () => {
    const tap = createRecordingTap();
    const build = vi.fn((t: number) => frameAt(t));
    tap.sample(100, build);
    expect(build).not.toHaveBeenCalled();
  });

  it('stop() captures the settle frame, stamps caller meta, and returns the recording', () => {
    const tap = createRecordingTap();
    tap.start({ sampleHz: 60, name: 'squat', sourceKind: 'composed', sourceName: 'Squat x5' }, 0, (t) =>
      frameAt(t),
    );
    tap.sample(20, (t) => frameAt(t)); // 1000/60-4 ≈ 12.7 → captures at 20
    const rec = tap.stop(50, (t) => frameAt(t), META);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('rec-test');
    expect(rec!.variant).toBe('v1');
    expect(rec!.createdAtIso).toBe('2020-01-01T00:00:00.000Z');
    expect(rec!.name).toBe('squat');
    expect(rec!.sourceKind).toBe('composed');
    expect(rec!.sourceName).toBe('Squat x5');
    expect(rec!.sampleHz).toBe(60);
    // frame0 (t=0) + sample (t=20) + settle (t=50)
    expect(rec!.frames.map((f) => f.tMs)).toEqual([0, 20, 50]);
    expect(tap.active).toBe(false);
  });

  it('stop() returns null when nothing was recording', () => {
    const tap = createRecordingTap();
    expect(tap.stop(0, (t) => frameAt(t), META)).toBeNull();
  });

  it('drops null frames (stage not ready) without pushing', () => {
    const tap = createRecordingTap();
    tap.start({ sampleHz: 30 }, 0, () => null); // frame 0 unbuildable
    tap.sample(100, () => null);
    const rec = tap.stop(200, () => null, META);
    expect(rec!.frames).toHaveLength(0);
  });

  it('clamps sampleHz into [1, 120] and defaults to 30', () => {
    const build = (t: number) => frameAt(t);
    const lo = createRecordingTap();
    lo.start({ sampleHz: 0 }, 0, build);
    expect(lo.stop(0, build, META)!.sampleHz).toBe(1);
    const hi = createRecordingTap();
    hi.start({ sampleHz: 9000 }, 0, build);
    expect(hi.stop(0, build, META)!.sampleHz).toBe(120);
    const def = createRecordingTap();
    def.start(undefined, 0, build);
    expect(def.stop(0, build, META)!.sampleHz).toBe(30);
  });

  it('defaults name/sourceKind and omits sourceName when unset', () => {
    const tap = createRecordingTap();
    const build = (t: number) => frameAt(t);
    tap.start(undefined, 0, build);
    const rec = tap.stop(0, build, META)!;
    expect(rec.name).toBe('recording');
    expect(rec.sourceKind).toBe('manual');
    expect('sourceName' in rec).toBe(false);
  });

  it('a second start() restarts the buffer (frames do not carry over)', () => {
    const tap = createRecordingTap();
    const build = (t: number) => frameAt(t);
    tap.start({ sampleHz: 30 }, 0, build);
    tap.sample(100, build); // buffered
    tap.start({ sampleHz: 30 }, 500, build); // restart at a new startT
    const rec = tap.stop(600, build, META)!;
    // only the new run's frame0 (t=0) + settle (t=100) — old frames gone
    expect(rec.frames.map((f) => f.tMs)).toEqual([0, 100]);
  });
});
