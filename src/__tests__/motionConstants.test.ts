/**
 * motionConstants — the ONE playback time-scale clamp.
 *
 * This module exists because the same `[0.4, 1.5]` clamp had been hand-inlined in
 * five places (gaitModifiers x2, motionRecording, motionSequence, motionTrajectory)
 * plus a sixth copy in the simMOVE instruction parser, and the copies had drifted
 * into THREE different null/NaN behaviours. These tests pin the unified semantic so
 * the drift cannot come back silently.
 */
import { describe, it, expect } from 'vitest';
import { TIME_SCALE_MIN, TIME_SCALE_MAX, clampTimeScale } from '../services/motionConstants';

describe('motionConstants — bounds', () => {
  it('publishes the engine playback domain', () => {
    expect(TIME_SCALE_MIN).toBe(0.4);
    expect(TIME_SCALE_MAX).toBe(1.5);
  });
});

describe('clampTimeScale — in-range values pass through', () => {
  it('leaves a value inside the domain untouched', () => {
    for (const v of [0.4, 0.5, 0.75, 1, 1.25, 1.5]) {
      expect(clampTimeScale(v)).toBe(v);
    }
  });
});

describe('clampTimeScale — out-of-range values clamp to the bound', () => {
  it('floors below the minimum', () => {
    expect(clampTimeScale(0.1)).toBe(TIME_SCALE_MIN);
    expect(clampTimeScale(-3)).toBe(TIME_SCALE_MIN);
  });
  it('ceilings above the maximum', () => {
    expect(clampTimeScale(2)).toBe(TIME_SCALE_MAX);
    expect(clampTimeScale(1000)).toBe(TIME_SCALE_MAX);
  });
});

describe('clampTimeScale — "unset" resolves to real time, not to a bound', () => {
  // The `?? 1` copies let NaN through Math.max and poisoned every downstream
  // duration with NaN; the guard here is the fix, so it is pinned explicitly.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '1.2'],
    ['an object', {}],
  ])('%s resolves to 1', (_label, input) => {
    expect(clampTimeScale(input)).toBe(1);
  });

  it('never returns a non-finite number for any input', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, 'x', {}, []]) {
      expect(Number.isFinite(clampTimeScale(v))).toBe(true);
    }
  });
});

describe('clampTimeScale — an explicit 0 floors, it does not snap back to real time', () => {
  // motionTrajectory's old `|| 1` swallowed a deliberate 0 and played it at 1x,
  // disagreeing with all four other sites (which floored it to 0.4). The majority
  // behaviour wins: 0 is a finite request and is clamped like any other.
  it('treats 0 as a finite request', () => {
    expect(clampTimeScale(0)).toBe(TIME_SCALE_MIN);
    expect(clampTimeScale(-0)).toBe(TIME_SCALE_MIN);
  });
});
