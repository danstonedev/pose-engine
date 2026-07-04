/**
 * Clinical camera controls — the pure math + the shared interaction-model
 * contract. The DOM-side handle (createClinicalCameraControls) needs a
 * browser and is exercised by the consuming viewers; these tests lock the
 * Node-testable pieces: the defaults object (the interaction model as
 * data), NDC conversion, keyboard dolly stepping, and the focus/reset
 * view-pose interpolation.
 */
import { describe, expect, it } from 'vitest';
import {
  CLINICAL_CAMERA_ARIA_LABEL,
  CLINICAL_CAMERA_DEFAULTS,
  CLINICAL_CAMERA_TWEEN_MS,
  CLINICAL_DOLLY_STEP_FRACTION,
  clientToNdc,
  easeInOutCubic,
  interpolateViewPose,
  resolveDollyDistance,
  type CameraViewPose,
} from '../services/clinicalCameraControls';

describe('CLINICAL_CAMERA_DEFAULTS (the shared interaction model, as data)', () => {
  it('enables screen-space pan at the agreed speed', () => {
    expect(CLINICAL_CAMERA_DEFAULTS.enablePan).toBe(true);
    expect(CLINICAL_CAMERA_DEFAULTS.screenSpacePanning).toBe(true);
    expect(CLINICAL_CAMERA_DEFAULTS.panSpeed).toBeCloseTo(0.8, 5);
  });

  it('zooms to the cursor with a close-inspection min distance', () => {
    expect(CLINICAL_CAMERA_DEFAULTS.zoomToCursor).toBe(true);
    // 0.35 m: close enough to fill the frame with a foot (the ankle pilot's
    // subject); the old fixed 1.2 m kept students at torso distance.
    expect(CLINICAL_CAMERA_DEFAULTS.minDistance).toBeCloseTo(0.35, 5);
    expect(CLINICAL_CAMERA_DEFAULTS.maxDistance).toBe(6);
  });

  it('keeps the damped-orbit + polar-clamp feel unchanged', () => {
    expect(CLINICAL_CAMERA_DEFAULTS.enableDamping).toBe(true);
    expect(CLINICAL_CAMERA_DEFAULTS.dampingFactor).toBeCloseTo(0.12, 5);
    expect(CLINICAL_CAMERA_DEFAULTS.maxPolarAngle).toBeCloseTo(Math.PI * 0.92, 9);
  });

  it('documents the full interaction model in the aria label', () => {
    for (const phrase of ['rotate', 'pan', 'zoom', 'double-click', 'arrow keys', '0 resets']) {
      expect(CLINICAL_CAMERA_ARIA_LABEL).toContain(phrase);
    }
  });
});

describe('clientToNdc', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it('maps the rect center to the NDC origin', () => {
    const ndc = clientToNdc(300, 150, rect);
    expect(ndc.x).toBeCloseTo(0, 9);
    expect(ndc.y).toBeCloseTo(0, 9);
  });

  it('maps corners with y flipped (NDC y is up)', () => {
    const tl = clientToNdc(100, 50, rect);
    expect(tl.x).toBeCloseTo(-1, 9);
    expect(tl.y).toBeCloseTo(1, 9);
    const br = clientToNdc(500, 250, rect);
    expect(br.x).toBeCloseTo(1, 9);
    expect(br.y).toBeCloseTo(-1, 9);
  });

  it('survives a degenerate zero-size rect without dividing by zero', () => {
    const ndc = clientToNdc(10, 10, { left: 10, top: 10, width: 0, height: 0 });
    expect(Number.isFinite(ndc.x)).toBe(true);
    expect(Number.isFinite(ndc.y)).toBe(true);
  });
});

describe('resolveDollyDistance (keyboard +/− zoom steps)', () => {
  const bounds = {
    min: CLINICAL_CAMERA_DEFAULTS.minDistance,
    max: CLINICAL_CAMERA_DEFAULTS.maxDistance,
  };

  it('steps ~10% of the current distance in and out', () => {
    expect(resolveDollyDistance(2, 1, bounds)).toBeCloseTo(2 * (1 - CLINICAL_DOLLY_STEP_FRACTION), 9);
    expect(resolveDollyDistance(2, -1, bounds)).toBeCloseTo(2 / (1 - CLINICAL_DOLLY_STEP_FRACTION), 9);
  });

  it('in-then-out returns to the starting distance (steps are inverses)', () => {
    const inThenOut = resolveDollyDistance(resolveDollyDistance(2, 1, bounds), -1, bounds);
    expect(inThenOut).toBeCloseTo(2, 9);
  });

  it('clamps at the close-inspection floor and the far cap', () => {
    expect(resolveDollyDistance(0.36, 1, bounds)).toBe(bounds.min);
    expect(resolveDollyDistance(5.9, -1, bounds)).toBe(bounds.max);
    // Already at a bound: stepping further stays pinned.
    expect(resolveDollyDistance(bounds.min, 1, bounds)).toBe(bounds.min);
    expect(resolveDollyDistance(bounds.max, -1, bounds)).toBe(bounds.max);
  });

  it('recovers to the floor from garbage input', () => {
    expect(resolveDollyDistance(Number.NaN, 1, bounds)).toBe(bounds.min);
    expect(resolveDollyDistance(0, -1, bounds)).toBe(bounds.min);
  });
});

describe('interpolateViewPose (focus / reset tween math)', () => {
  const from: CameraViewPose = { target: [0, 1, 0], position: [0, 1.4, 3.4] };
  const to: CameraViewPose = { target: [0.2, 0.1, 0.1], position: [0, 1.4, 3.4] };

  it('returns the endpoints exactly at t=0 and t=1 (and clamps beyond)', () => {
    expect(interpolateViewPose(from, to, 0)).toEqual(from);
    expect(interpolateViewPose(from, to, 1)).toEqual(to);
    expect(interpolateViewPose(from, to, -0.5)).toEqual(from);
    expect(interpolateViewPose(from, to, 1.5)).toEqual(to);
  });

  it('moves only the target when the camera position is shared (focus tween)', () => {
    const mid = interpolateViewPose(from, to, 0.5);
    expect(mid.position).toEqual(from.position);
    expect(mid.target[0]).toBeCloseTo(0.1, 9);
    expect(mid.target[1]).toBeCloseTo(0.55, 9);
    expect(mid.target[2]).toBeCloseTo(0.05, 9);
  });

  it('easeInOutCubic is clamped, symmetric, and hits the half point', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(2)).toBe(1);
    // Symmetry about the midpoint.
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 9);
  });

  it('tween duration stays in the sub-half-second "responsive" band', () => {
    expect(CLINICAL_CAMERA_TWEEN_MS).toBeGreaterThanOrEqual(200);
    expect(CLINICAL_CAMERA_TWEEN_MS).toBeLessThanOrEqual(500);
  });
});
