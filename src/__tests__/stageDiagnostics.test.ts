import { describe, expect, it } from 'vitest';
import {
  axisTiltDeg,
  computeStageDiagnostics,
  type DriverFlags,
  type StageDiagnosticsInputs,
} from '../services/stageDiagnostics';

/** A bone whose world position is (x, y, z) — only elements 12/13/14 matter. */
function boneAt(x: number, y: number, z = 0) {
  const elements = new Array(16).fill(0);
  elements[12] = x;
  elements[13] = y;
  elements[14] = z;
  return { matrixWorld: { elements } };
}

const NO_DRIVER: DriverFlags = {
  activeTween: false,
  composedActive: false,
  activeMotion: false,
  activeTrajectory: false,
  idleOverlayOn: false,
  idlePivotOn: false,
};

function inputs(over: Partial<StageDiagnosticsInputs> = {}): StageDiagnosticsInputs {
  return {
    rootX: 0,
    rootRestX: 0,
    driver: NO_DRIVER,
    livelinessOnsetSec: 0,
    livelinessOnsetTotalSec: 0.4,
    swayMod: 0,
    shiftModM: 0,
    ...over,
  };
}

describe('axisTiltDeg', () => {
  it('is 0 when either bone is missing', () => {
    expect(axisTiltDeg(undefined, boneAt(0, 1))).toBe(0);
    expect(axisTiltDeg(boneAt(0, 1), undefined)).toBe(0);
  });

  it('is 0 for a perfectly vertical axis', () => {
    expect(axisTiltDeg(boneAt(0, 0), boneAt(0, 1))).toBeCloseTo(0, 6);
  });

  it('is POSITIVE when the upper bone is displaced +X (patient left)', () => {
    // from (0,0) to (1,1): atan2(1,1) = 45°
    expect(axisTiltDeg(boneAt(0, 0), boneAt(1, 1))).toBeCloseTo(45, 4);
  });

  it('is NEGATIVE when the upper bone is displaced -X (patient right)', () => {
    expect(axisTiltDeg(boneAt(0, 0), boneAt(-1, 1))).toBeCloseTo(-45, 4);
  });
});

describe('computeStageDiagnostics — state precedence', () => {
  const cases: Array<[Partial<DriverFlags>, string]> = [
    [{ activeTween: true, composedActive: true, activeMotion: true }, 'transition'],
    [{ composedActive: true, activeMotion: true, activeTrajectory: true }, 'composed'],
    [{ activeMotion: true, activeTrajectory: true, idleOverlayOn: true }, 'clip'],
    [{ activeTrajectory: true, idleOverlayOn: true }, 'travel'],
    [{ idleOverlayOn: true }, 'idle'],
    [{}, 'held'],
  ];
  for (const [flags, expected] of cases) {
    it(`→ ${expected}`, () => {
      const d = computeStageDiagnostics(inputs({ driver: { ...NO_DRIVER, ...flags } }));
      expect(d.state).toBe(expected);
    });
  }
});

describe('computeStageDiagnostics — measurements', () => {
  it('reports trunk (hips→head) and lumbar (lower→upper) tilt', () => {
    const d = computeStageDiagnostics(
      inputs({
        hips: boneAt(0, 0),
        head: boneAt(1, 1),
        lower: boneAt(0, 0),
        upper: boneAt(-1, 1),
      }),
    );
    expect(d.trunkTiltDeg).toBeCloseTo(45, 4);
    expect(d.lumbarTiltDeg).toBeCloseTo(-45, 4);
  });

  it('falls back to lower for hips when hips is absent', () => {
    const d = computeStageDiagnostics(inputs({ lower: boneAt(0, 0), head: boneAt(1, 1) }));
    expect(d.trunkTiltDeg).toBeCloseTo(45, 4); // used lower as hips
  });

  it('pelvis shift is (rootX - rootRestX) in cm', () => {
    expect(computeStageDiagnostics(inputs({ rootX: 0.15, rootRestX: 0 })).pelvisShiftCm).toBeCloseTo(15, 6);
    expect(computeStageDiagnostics(inputs({ rootX: -0.03, rootRestX: 0 })).pelvisShiftCm).toBeCloseTo(-3, 6);
  });

  it('liveliness ramps 0..100 only while a motion drives, and clamps', () => {
    // no motion → 0 regardless of onset
    expect(computeStageDiagnostics(inputs({ livelinessOnsetSec: 1 })).livelinessPct).toBe(0);
    // clip driving, mid-ramp
    const mid = computeStageDiagnostics(
      inputs({ driver: { ...NO_DRIVER, activeMotion: true }, livelinessOnsetSec: 0.2, livelinessOnsetTotalSec: 0.4 }),
    );
    expect(mid.livelinessPct).toBeCloseTo(50, 4);
    // past full ramp → clamped 100
    const full = computeStageDiagnostics(
      inputs({ driver: { ...NO_DRIVER, composedActive: true }, livelinessOnsetSec: 5, livelinessOnsetTotalSec: 0.4 }),
    );
    expect(full.livelinessPct).toBe(100);
  });

  it('passes modifiers through (sway 0..1, shift m→cm)', () => {
    const d = computeStageDiagnostics(inputs({ swayMod: 0.7, shiftModM: 0.1 }));
    expect(d.swayMod).toBe(0.7);
    expect(d.shiftModCm).toBeCloseTo(10, 6);
  });
});
