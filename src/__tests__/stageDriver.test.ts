/**
 * DRIVER OWNERSHIP + SUPERSESSION (deferred fix #5).
 *
 * Two defects lived in the four-boolean driver model:
 *
 *  1. "What is driving the skeleton?" had no single answer. Every consumer
 *     re-derived it (`!activeMotionId && !composedActive && !activeTween &&
 *     !activeTrajectory`), so a new mechanism could silently miss a gate.
 *  2. The clip path had NO supersession. `runMotionImpl` awaited an uncached
 *     clip load and re-checked only `disposed` afterwards, while an out-of-band
 *     Stop bypasses the serialized command chain. Worse, the Stop handler only
 *     advanced the generation via `cancelComposed()` — i.e. only when a COMPOSED
 *     motion happened to be active. With a clip mid-load and nothing composed
 *     running, Stop hit no branch at all and the superseded clip played anyway.
 *
 * These tests own the model itself; `stageDriverWiring.test.ts` pins that the
 * stage actually routes through it.
 */
import { describe, expect, it } from 'vitest';
import { createStageDriver, type DriverMechanism } from '../services/stageDriver';

describe('driver ownership — one question instead of four booleans', () => {
  it('starts idle with nothing running', () => {
    const d = createStageDriver();
    expect(d.idle).toBe(true);
    expect(d.running).toEqual([]);
  });

  it('any running mechanism ends idle; clearing them all restores it', () => {
    const all: DriverMechanism[] = ['clip', 'composed', 'tween', 'trajectory'];
    for (const m of all) {
      const d = createStageDriver();
      d.setRunning(m, true);
      expect(d.idle, `${m} must end idle`).toBe(false);
      expect(d.isRunning(m)).toBe(true);
      d.setRunning(m, false);
      expect(d.idle, `clearing ${m} must restore idle`).toBe(true);
    }
  });

  it('tracks overlapping mechanisms — a composed motion also runs its trajectory', () => {
    const d = createStageDriver();
    d.setRunning('composed', true);
    d.setRunning('trajectory', true);
    expect(d.running).toEqual(['composed', 'trajectory']);
    // The trajectory finishing does NOT end the motion…
    d.setRunning('trajectory', false);
    expect(d.idle).toBe(false);
    expect(d.running).toEqual(['composed']);
    // …the composed motion ending does.
    d.setRunning('composed', false);
    expect(d.idle).toBe(true);
  });

  it('setRunning is idempotent (a mechanism can re-register without double-counting)', () => {
    const d = createStageDriver();
    d.setRunning('clip', true);
    d.setRunning('clip', true);
    d.setRunning('clip', false);
    expect(d.idle).toBe(true);
  });

  it('reports running mechanisms in a stable order for diagnostics', () => {
    const d = createStageDriver();
    d.setRunning('trajectory', true);
    d.setRunning('clip', true);
    d.setRunning('tween', true);
    expect(d.running).toEqual(['clip', 'tween', 'trajectory']);
  });
});

describe('supersession — a stale async command cannot win', () => {
  it('a claim holds while nothing supersedes it', () => {
    const d = createStageDriver();
    const claim = d.snapshot();
    expect(d.holds(claim)).toBe(true);
  });

  it('any takeover supersedes every outstanding claim', () => {
    const d = createStageDriver();
    const a = d.snapshot();
    const b = d.snapshot();
    d.supersede();
    expect(d.holds(a)).toBe(false);
    expect(d.holds(b)).toBe(false);
    // A claim taken AFTER the takeover holds again.
    expect(d.holds(d.snapshot())).toBe(true);
  });

  it('running mechanisms are independent of the generation (a takeover does not fake idle)', () => {
    const d = createStageDriver();
    d.setRunning('composed', true);
    d.supersede();
    expect(d.idle).toBe(false); // the old motion is still running until it tears down
    d.setRunning('composed', false);
    expect(d.idle).toBe(true);
  });

  it('THE RACE: Stop during an uncached clip load supersedes it (fix #4)', () => {
    const d = createStageDriver();
    // runMotionImpl snapshots the generation, then awaits the clip load…
    const claim = d.snapshot();
    // …an out-of-band Stop lands mid-load. It now ALWAYS advances the generation,
    // where before it did so only when a composed motion was active — so with a
    // clip loading and nothing composed running it was a complete no-op.
    d.supersede();
    // …the load resolves. The clip must NOT take the skeleton.
    expect(d.holds(claim)).toBe(false);
  });

  it('an uncontested clip load still plays (the guard is not over-eager)', () => {
    const d = createStageDriver();
    const claim = d.snapshot();
    // Nothing happens during the load — mechanisms starting/stopping are not
    // takeovers, so they must not spuriously supersede a loading command.
    d.setRunning('tween', true);
    d.setRunning('tween', false);
    expect(d.holds(claim)).toBe(true);
  });
});

describe('cancellation — a user Stop is distinguishable from being overtaken', () => {
  it('a marked generation reads back as cancelled; an unmarked one does not', () => {
    const d = createStageDriver();
    const stopped = d.seq;
    d.markCancelled(stopped);
    expect(d.wasCancelled(stopped)).toBe(true);
    expect(d.wasCancelled(stopped + 1)).toBe(false);
  });

  it('only the marked generation is cancelled — a later command is merely superseded', () => {
    const d = createStageDriver();
    const first = d.seq;
    d.markCancelled(first); // user pressed Stop on the first motion
    const second = d.supersede(); // a newer command arrives
    expect(d.wasCancelled(first)).toBe(true);
    expect(d.wasCancelled(second)).toBe(false);
  });

  it('clearCancelled consumes the mark (the awaiting command reported it)', () => {
    const d = createStageDriver();
    d.markCancelled(d.seq);
    d.clearCancelled();
    expect(d.wasCancelled(d.seq)).toBe(false);
  });
});
