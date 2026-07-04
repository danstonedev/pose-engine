/**
 * Clinical camera controls — the pure math + the shared interaction-model
 * contract. The DOM-side handle (createClinicalCameraControls) needs a
 * browser and is exercised by the consuming viewers; these tests lock the
 * Node-testable pieces: the defaults object (the interaction model as
 * data), NDC conversion, keyboard dolly stepping, the focus/reset
 * view-pose interpolation, the cooperative touch-gesture config (the P0
 * mobile scroll-trap fix), the coarse-pointer probe, the touch gesture
 * vocabulary, and the double-tap recognizer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  CLINICAL_CAMERA_ARIA_LABEL,
  CLINICAL_CAMERA_ARIA_LABEL_TOUCH,
  CLINICAL_CAMERA_DEFAULTS,
  CLINICAL_CAMERA_GESTURE_LEGEND,
  CLINICAL_CAMERA_GESTURE_LEGEND_TOUCH,
  CLINICAL_CAMERA_TWEEN_MS,
  CLINICAL_COOPERATIVE_TOUCH_ACTION,
  CLINICAL_DOLLY_STEP_FRACTION,
  CLINICAL_DOUBLE_TAP_MS,
  CLINICAL_TAP_MAX_MS,
  CLINICAL_TAP_SLOP_PX,
  clientToNdc,
  createDoubleTapTracker,
  easeInOutCubic,
  interpolateViewPose,
  isCoarsePointer,
  resolveClinicalCameraAriaLabel,
  resolveClinicalCameraGestureLegend,
  resolveDollyDistance,
  resolveTouchGestureConfig,
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

describe('resolveTouchGestureConfig (cooperative touch — the P0 scroll-trap fix)', () => {
  it('coarse pointer + opt-in → one finger scrolls the page, two move the camera', () => {
    const cfg = resolveTouchGestureConfig(true, true);
    expect(cfg.cooperative).toBe(true);
    // null (not a TOUCH constant) → OrbitControls' switch falls through to
    // the no-gesture state: one finger does NOT orbit.
    expect(cfg.one).toBeNull();
    // Two-finger drag rotates, pinch zooms.
    expect(cfg.two).toBe(THREE.TOUCH.DOLLY_ROTATE);
    // pan-y: the browser owns one-finger VERTICAL swipes (page scroll) while
    // multi-touch + horizontal gestures still reach the controls.
    expect(cfg.touchAction).toBe('pan-y');
    expect(cfg.touchAction).toBe(CLINICAL_COOPERATIVE_TOUCH_ACTION);
  });

  it('defaults OFF: the option must be an explicit opt-in', () => {
    // Omitted option (factory passes undefined) — never cooperative.
    expect(resolveTouchGestureConfig(undefined, true).cooperative).toBe(false);
    expect(resolveTouchGestureConfig(false, true).cooperative).toBe(false);
  });

  it('fine pointers keep the mouse model even when the host opts in', () => {
    const cfg = resolveTouchGestureConfig(true, false);
    expect(cfg.cooperative).toBe(false);
    expect(cfg.one).toBe(THREE.TOUCH.ROTATE);
    expect(cfg.two).toBe(THREE.TOUCH.DOLLY_PAN);
    expect(cfg.touchAction).toBe('none');
  });

  it('the non-cooperative branch mirrors the OrbitControls touch defaults', () => {
    // Locked so the "factory only applies the cooperative branch" contract
    // stays honest: this data must equal what three ships out of the box.
    const cfg = resolveTouchGestureConfig(false, false);
    expect(cfg.one).toBe(THREE.TOUCH.ROTATE); // three's touches.ONE default
    expect(cfg.two).toBe(THREE.TOUCH.DOLLY_PAN); // three's touches.TWO default
  });
});

describe('isCoarsePointer (matchMedia capability probe)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false where matchMedia does not exist (SSR / Node)', () => {
    expect(typeof globalThis.matchMedia).toBe('undefined');
    expect(isCoarsePointer()).toBe(false);
  });

  it('reflects the (pointer: coarse) media query when matchMedia exists', () => {
    const matchMedia = vi.fn((query: string) => ({ matches: /coarse/.test(query) }));
    vi.stubGlobal('matchMedia', matchMedia);
    expect(isCoarsePointer()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse)');

    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(isCoarsePointer()).toBe(false);
  });

  it('survives a throwing matchMedia (older engines) as fine-pointer', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('unsupported query');
    });
    expect(isCoarsePointer()).toBe(false);
  });
});

describe('gesture vocabulary (aria label + legend, touch variant)', () => {
  it('touch aria label speaks the cooperative model', () => {
    for (const phrase of ['Two-finger', 'pinch', 'double-tap', 'scrolls the page']) {
      expect(CLINICAL_CAMERA_ARIA_LABEL_TOUCH).toContain(phrase);
    }
    // The mouse vocabulary must NOT leak into the touch label.
    expect(CLINICAL_CAMERA_ARIA_LABEL_TOUCH).not.toContain('right-drag');
    expect(CLINICAL_CAMERA_ARIA_LABEL_TOUCH).not.toContain('double-click');
  });

  it('touch legend is the agreed chip line', () => {
    expect(CLINICAL_CAMERA_GESTURE_LEGEND_TOUCH).toBe(
      'Two-finger drag moves · pinch zooms · double-tap focuses',
    );
  });

  it('resolvers pick touch vocabulary only for the cooperative model', () => {
    expect(resolveClinicalCameraAriaLabel(true)).toBe(CLINICAL_CAMERA_ARIA_LABEL_TOUCH);
    expect(resolveClinicalCameraAriaLabel(false)).toBe(CLINICAL_CAMERA_ARIA_LABEL);
    expect(resolveClinicalCameraGestureLegend(true)).toBe(CLINICAL_CAMERA_GESTURE_LEGEND_TOUCH);
    expect(resolveClinicalCameraGestureLegend(false)).toBe(CLINICAL_CAMERA_GESTURE_LEGEND);
    // No matchMedia (this Node env) → capability default is the mouse model.
    expect(resolveClinicalCameraAriaLabel()).toBe(CLINICAL_CAMERA_ARIA_LABEL);
  });
});

describe('createDoubleTapTracker (touch double-tap → focus-or-reset)', () => {
  const tap = (
    t: ReturnType<typeof createDoubleTapTracker>,
    id: number,
    x: number,
    y: number,
    downAt: number,
    upAt: number = downAt + 40,
  ): boolean => {
    t.down(id, x, y, downAt);
    return t.up(id, x, y, upAt);
  };

  it('two quick taps in place read as a double-tap', () => {
    const t = createDoubleTapTracker();
    expect(tap(t, 1, 100, 100, 0)).toBe(false); // first tap arms
    expect(tap(t, 2, 104, 98, 200)).toBe(true); // second tap fires
  });

  it('a slow second tap does not chain (and re-arms as a fresh first tap)', () => {
    const t = createDoubleTapTracker();
    expect(tap(t, 1, 100, 100, 0)).toBe(false);
    expect(tap(t, 2, 100, 100, 40 + CLINICAL_DOUBLE_TAP_MS + 1)).toBe(false);
    // …but that late tap armed a new sequence:
    expect(tap(t, 3, 100, 100, 40 + CLINICAL_DOUBLE_TAP_MS + 200)).toBe(true);
  });

  it('far-apart taps do not chain', () => {
    const t = createDoubleTapTracker();
    expect(tap(t, 1, 100, 100, 0)).toBe(false);
    expect(tap(t, 2, 300, 100, 150)).toBe(false);
  });

  it('a long press or a swipe is not a tap', () => {
    const t = createDoubleTapTracker();
    // Long press: held past the tap ceiling.
    t.down(1, 100, 100, 0);
    expect(t.up(1, 100, 100, CLINICAL_TAP_MAX_MS + 50)).toBe(false);
    // Swipe: traveled past the slop radius.
    t.down(2, 100, 100, 500);
    expect(t.up(2, 100 + CLINICAL_TAP_SLOP_PX + 10, 100, 540)).toBe(false);
    // Neither armed a sequence a following tap could complete.
    expect(tap(t, 3, 100, 100, 700)).toBe(false);
  });

  it('multi-touch (a pinch/two-finger drag) voids the sequence', () => {
    const t = createDoubleTapTracker();
    expect(tap(t, 1, 100, 100, 0)).toBe(false); // armed
    // Two fingers land — a camera gesture, not a tap.
    t.down(2, 90, 100, 100);
    t.down(3, 110, 100, 105);
    expect(t.up(2, 90, 100, 140)).toBe(false);
    expect(t.up(3, 110, 100, 145)).toBe(false);
    // The earlier armed tap must NOT pair with a tap after the pinch.
    expect(tap(t, 4, 100, 100, 200)).toBe(false);
  });

  it('pointercancel (the browser claimed the swipe for scrolling) resets state', () => {
    const t = createDoubleTapTracker();
    expect(tap(t, 1, 100, 100, 0)).toBe(false); // armed
    t.down(2, 100, 100, 100);
    t.cancel(); // browser took the gesture → page scrolled
    expect(tap(t, 3, 100, 100, 200)).toBe(false); // sequence voided
    expect(tap(t, 4, 100, 100, 320)).toBe(true); // fresh double-tap still works
  });
});
