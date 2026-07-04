/**
 * Clinical camera controls — the ONE shared OrbitControls configuration +
 * interaction model for the in-repo viewers (PoseViewer, ObservationViewer,
 * ExamStage3D). These three components each hand-rolled the same controls
 * block and the copies had already drifted once (pan on/off, fixed
 * minDistance); this helper is now the single source of truth.
 *
 * INTERACTION MODEL (shared by every clinical viewer):
 *   - drag                → rotate (damped; polar clamp keeps the camera
 *                           from going fully under the floor)
 *   - right-drag / two-finger drag → pan (screen-space, panSpeed 0.8)
 *   - scroll / pinch      → zoom TO THE CURSOR (zoomToCursor), down to
 *                           0.35 m so a student can fill the frame with a
 *                           foot or a hand, out to 6 m (a fixed cap ≈ 1.8×
 *                           the head-to-toe framing distance — kept constant
 *                           rather than derived so hosts get identical
 *                           behavior regardless of container aspect)
 *   - double-click        → FOCUS-OR-RESET: on a model hit, smoothly move
 *                           the orbit target to the hit point (double-click
 *                           the ankle, then scroll in); on a miss, smoothly
 *                           return to the captured home view
 *   - keyboard (container focus): arrow keys pan (OrbitControls
 *                           listenToKeyEvents), + / = and − dolly in/out in
 *                           ~10% steps, 0 / Home resets the view
 *
 * COOPERATIVE TOUCH (opt-in via `allowPageScrollOnMiss`, coarse pointers
 * only): on phones a ≥60vh canvas that claims every one-finger swipe traps
 * the student on the 3D stage — the page can never scroll. With the option
 * set and `(pointer: coarse)` matching:
 *   - one-finger swipe    → NOT a camera gesture (touches.ONE = null); the
 *                           canvas carries `touch-action: pan-y`, so vertical
 *                           swipes scroll the page
 *   - two-finger drag     → rotate; pinch → zoom (TOUCH.DOLLY_ROTATE)
 *   - double-TAP          → the same focus-or-reset as double-click (a
 *                           touch-synthesized handler — iOS Safari does not
 *                           reliably emit dblclick for double-taps)
 * Default false → the existing model everywhere; fine pointers are never
 * affected. The gesture vocabulary (aria label / legend) has a touch
 * variant selected by pointer capability.
 *
 * The helper owns NO render loop: the component's existing parked rAF loop
 * calls `update()` once per frame (before `controls.update()`), and every
 * camera mutation funnels through the component's `requestRender` so the
 * dirty-flag machinery keeps working. Focus/reset tweens are camera-only —
 * they never touch poses — and any user gesture cancels them.
 *
 * Pure math (NDC conversion, dolly stepping, view-pose interpolation) is
 * exported separately so it stays unit-testable in Node.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ── Shared configuration (the interaction model, as data) ──────────────────

/** OrbitControls settings every clinical viewer shares. Applied via
 *  Object.assign so tests can lock the model without a DOM. */
export const CLINICAL_CAMERA_DEFAULTS = {
  enableDamping: true,
  dampingFactor: 0.12,
  enablePan: true,
  screenSpacePanning: true,
  panSpeed: 0.8,
  enableZoom: true,
  zoomToCursor: true,
  /** Close enough to fill the frame with a foot (the ankle pilot's whole
   *  subject) without clipping into the mesh at typical FOVs. */
  minDistance: 0.35,
  /** Fixed far cap — ≈1.8× the head-to-toe framing distance (~3.4 m at
   *  40° FOV for the male variant). Constant by design; see module doc. */
  maxDistance: 6,
  maxPolarAngle: Math.PI * 0.92,
} as const;

/** Fraction of the current distance one keyboard dolly step covers. */
export const CLINICAL_DOLLY_STEP_FRACTION = 0.1;

/** Duration of the focus / reset camera tweens (ms). */
export const CLINICAL_CAMERA_TWEEN_MS = 320;

/** Concise interaction summary for the focusable container's aria-label. */
export const CLINICAL_CAMERA_ARIA_LABEL =
  '3D patient. Drag to rotate, right-drag to pan, scroll to zoom, ' +
  'double-click to focus, arrow keys pan, + and − zoom, 0 resets.';

/** Touch variant of {@link CLINICAL_CAMERA_ARIA_LABEL} — the cooperative
 *  coarse-pointer vocabulary (one finger belongs to the page). */
export const CLINICAL_CAMERA_ARIA_LABEL_TOUCH =
  '3D patient. Two-finger drag moves the camera, pinch zooms, ' +
  'double-tap focuses, double-tap empty space resets. ' +
  'One-finger swipe scrolls the page.';

/** Short gesture-legend line hosts render under the stage (mouse). */
export const CLINICAL_CAMERA_GESTURE_LEGEND =
  'Drag rotates · right-drag pans · scroll zooms · double-click focuses';

/** Short gesture-legend line hosts render under the stage (touch). */
export const CLINICAL_CAMERA_GESTURE_LEGEND_TOUCH =
  'Two-finger drag moves · pinch zooms · double-tap focuses';

/** True when the device's PRIMARY pointer is coarse (a finger). Safe
 *  everywhere: no matchMedia (SSR, Node tests) → false. */
export function isCoarsePointer(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** Aria label for the active gesture model: touch vocabulary when the
 *  cooperative coarse-pointer model is in effect, mouse vocabulary
 *  otherwise. Defaults to plain pointer capability for hosts that always
 *  run cooperative gestures on touch. */
export function resolveClinicalCameraAriaLabel(
  cooperativeTouch: boolean = isCoarsePointer(),
): string {
  return cooperativeTouch ? CLINICAL_CAMERA_ARIA_LABEL_TOUCH : CLINICAL_CAMERA_ARIA_LABEL;
}

/** Gesture-legend counterpart of {@link resolveClinicalCameraAriaLabel}. */
export function resolveClinicalCameraGestureLegend(
  cooperativeTouch: boolean = isCoarsePointer(),
): string {
  return cooperativeTouch ? CLINICAL_CAMERA_GESTURE_LEGEND_TOUCH : CLINICAL_CAMERA_GESTURE_LEGEND;
}

// ── Cooperative touch-gesture configuration (pure, Node-testable) ──────────

/** CSS touch-action while cooperative gestures are active: the browser owns
 *  one-finger VERTICAL swipes (page scroll); everything else — horizontal
 *  one-finger drags, two-finger drag, pinch, double-tap — reaches the
 *  controls as pointer events (pan-y excludes browser pinch-zoom and
 *  double-tap-zoom on the element). */
export const CLINICAL_COOPERATIVE_TOUCH_ACTION = 'pan-y';

/** Resolved touch-gesture model for one stage. */
export interface ClinicalTouchGestures {
  /** Value for OrbitControls `touches.ONE` — `null` means one finger is NOT
   *  a camera gesture (three r183 has no TOUCH.NONE; `null` falls through
   *  OrbitControls' switch to the no-gesture state and is the typed way to
   *  disable it). */
  one: THREE.TOUCH | null;
  /** Value for OrbitControls `touches.TWO`. */
  two: THREE.TOUCH;
  /** CSS touch-action for the canvas + its container. */
  touchAction: 'none' | 'pan-y';
  /** True when the cooperative model is active (opt-in ∧ coarse pointer). */
  cooperative: boolean;
}

/** Decide the touch-gesture model. Cooperative gestures require BOTH the
 *  embedder's opt-in (`allowPageScrollOnMiss`, default false) and a coarse
 *  primary pointer — fine-pointer devices keep the mouse model untouched.
 *  The non-cooperative branch mirrors the OrbitControls defaults and is
 *  never written back (the factory only applies the cooperative branch), so
 *  default-mode behavior is bit-identical to before this option existed. */
export function resolveTouchGestureConfig(
  allowPageScrollOnMiss: boolean | undefined,
  coarsePointer: boolean,
): ClinicalTouchGestures {
  if ((allowPageScrollOnMiss ?? false) && coarsePointer) {
    return {
      one: null,
      two: THREE.TOUCH.DOLLY_ROTATE,
      touchAction: CLINICAL_COOPERATIVE_TOUCH_ACTION,
      cooperative: true,
    };
  }
  return {
    one: THREE.TOUCH.ROTATE,
    two: THREE.TOUCH.DOLLY_PAN,
    touchAction: 'none',
    cooperative: false,
  };
}

// ── Double-tap detection (pure, Node-testable) ──────────────────────────────

/** A press held longer than this is a drag/hold, not a tap (ms). */
export const CLINICAL_TAP_MAX_MS = 300;
/** Finger travel within one tap beyond this is a swipe, not a tap (px). */
export const CLINICAL_TAP_SLOP_PX = 14;
/** Max gap between two tap RELEASES that still reads as a double-tap (ms). */
export const CLINICAL_DOUBLE_TAP_MS = 350;
/** Max distance between the two taps of a double-tap (px). */
export const CLINICAL_DOUBLE_TAP_RADIUS_PX = 40;

export interface DoubleTapTracker {
  /** Feed a touch pointerdown. */
  down(id: number, x: number, y: number, time: number): void;
  /** Feed a touch pointerup. Returns true when this release completes a
   *  double-tap (single-finger, low-travel, inside the time/space window). */
  up(id: number, x: number, y: number, time: number): boolean;
  /** Feed a touch pointercancel (the browser claimed the gesture, e.g. for
   *  page scroll) — resets all tap state. */
  cancel(): void;
}

/** Small state machine that recognizes single-finger double-taps from raw
 *  touch pointer events. Any multi-touch involvement (a second finger down)
 *  voids the sequence — a pinch must never end in a surprise focus jump. */
export function createDoubleTapTracker(): DoubleTapTracker {
  let activeTouches = 0;
  let candidate: { id: number; x: number; y: number; time: number } | null = null;
  let lastTap: { x: number; y: number; time: number } | null = null;
  return {
    down(id, x, y, time) {
      activeTouches += 1;
      if (activeTouches > 1) {
        candidate = null;
        lastTap = null;
        return;
      }
      candidate = { id, x, y, time };
    },
    up(id, x, y, time) {
      activeTouches = Math.max(0, activeTouches - 1);
      const cand = candidate;
      candidate = null;
      if (!cand || cand.id !== id) return false;
      const isTap =
        time - cand.time <= CLINICAL_TAP_MAX_MS &&
        Math.hypot(x - cand.x, y - cand.y) <= CLINICAL_TAP_SLOP_PX;
      if (!isTap) {
        lastTap = null;
        return false;
      }
      if (
        lastTap &&
        time - lastTap.time <= CLINICAL_DOUBLE_TAP_MS &&
        Math.hypot(x - lastTap.x, y - lastTap.y) <= CLINICAL_DOUBLE_TAP_RADIUS_PX
      ) {
        lastTap = null;
        return true;
      }
      lastTap = { x, y, time };
      return false;
    },
    cancel() {
      activeTouches = Math.max(0, activeTouches - 1);
      candidate = null;
      lastTap = null;
    },
  };
}

// ── Pure math (Node-testable) ───────────────────────────────────────────────

/** Convert client-space coordinates to normalized device coordinates
 *  (x,y ∈ [−1, 1], y up) within `rect` (the canvas bounding rect). */
export function clientToNdc(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  const w = rect.width > 0 ? rect.width : 1;
  const h = rect.height > 0 ? rect.height : 1;
  return {
    x: ((clientX - rect.left) / w) * 2 - 1,
    y: -(((clientY - rect.top) / h) * 2 - 1),
  };
}

/** Next camera-to-target distance for one keyboard dolly step.
 *  `direction` +1 zooms IN (shorter distance), −1 zooms OUT. The step is a
 *  fraction of the CURRENT distance (matching scroll-wheel feel) and the
 *  result is clamped to [min, max]. */
export function resolveDollyDistance(
  currentDistance: number,
  direction: 1 | -1,
  bounds: { min: number; max: number },
  stepFraction: number = CLINICAL_DOLLY_STEP_FRACTION,
): number {
  if (!Number.isFinite(currentDistance) || currentDistance <= 0) return bounds.min;
  const factor = direction > 0 ? 1 - stepFraction : 1 / (1 - stepFraction);
  return Math.max(bounds.min, Math.min(bounds.max, currentDistance * factor));
}

/** Smooth-step easing used by the focus/reset tweens. */
export function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** A camera view pose: orbit target + camera position (plain data). */
export interface CameraViewPose {
  target: [number, number, number];
  position: [number, number, number];
}

/** Interpolate between two view poses at eased parameter `t ∈ [0,1]`.
 *  Component-wise lerp is sufficient here: focus tweens move only the
 *  target, and reset tweens travel short arcs where a straight camera path
 *  reads as intentional rather than swooping. */
export function interpolateViewPose(
  from: CameraViewPose,
  to: CameraViewPose,
  t: number,
): CameraViewPose {
  const k = Math.max(0, Math.min(1, t));
  // Exact endpoints (a + (b−a)·1 drifts in floating point) so a settled
  // tween lands ON the captured home view, not epsilon-off it.
  if (k === 0) return { target: [...from.target], position: [...from.position] };
  if (k === 1) return { target: [...to.target], position: [...to.position] };
  const lerp = (a: number, b: number) => a + (b - a) * k;
  return {
    target: [
      lerp(from.target[0], to.target[0]),
      lerp(from.target[1], to.target[1]),
      lerp(from.target[2], to.target[2]),
    ],
    position: [
      lerp(from.position[0], to.position[0]),
      lerp(from.position[1], to.position[1]),
      lerp(from.position[2], to.position[2]),
    ],
  };
}

// ── DOM-side handle ─────────────────────────────────────────────────────────

export interface ClinicalCameraControlsOptions {
  camera: THREE.PerspectiveCamera;
  /** The renderer's canvas — pointer gestures + double-click land here. */
  domElement: HTMLElement;
  /** Focusable container (tabindex=0) for the keyboard path: arrow-key pan
   *  via listenToKeyEvents plus +/−/0/Home handling. Omit to skip keyboard
   *  wiring (e.g. decorative viewers). */
  keyElement?: HTMLElement | null;
  /** The component's dirty-flag hook — every camera mutation calls this. */
  requestRender: () => void;
  /** Root object raycast on double-click; return null while no model is
   *  loaded (double-click then falls through to reset). */
  getPickRoot: () => THREE.Object3D | null;
  /** Opt-in cooperative touch gestures for scrollable host pages. When true
   *  AND the primary pointer is coarse (`(pointer: coarse)`), one-finger
   *  swipes are left to the browser (`touch-action: pan-y` → the page
   *  scrolls), two-finger drag rotates, pinch zooms, and double-TAP runs
   *  the same focus-or-reset as double-click. Default false — the existing
   *  one-finger-orbit model everywhere; fine pointers are never affected. */
  allowPageScrollOnMiss?: boolean;
}

export interface ClinicalCameraControlsHandle {
  /** The configured OrbitControls (shared clinical defaults applied). */
  controls: OrbitControls;
  /** True when cooperative touch gestures are active on THIS stage
   *  (`allowPageScrollOnMiss` ∧ coarse pointer) — hosts pick the touch
   *  gesture vocabulary (aria label / legend) off this. */
  cooperativeTouch: boolean;
  /** Snapshot the CURRENT camera/target as the home view — call right after
   *  the component's own framing math has positioned the camera. */
  captureHomeView(): void;
  /** True once a home view has been captured. */
  hasHomeView(): boolean;
  /** Smoothly move the orbit target to `point` (camera stays put — the
   *  student scrolls in from there). */
  focusOn(point: THREE.Vector3): void;
  /** Smoothly return to the captured home view (no-op before capture). */
  resetView(): void;
  /** Keyboard-style dolly by one ~10% step. +1 in, −1 out. */
  dollyStep(direction: 1 | -1): void;
  /** Advance any active focus/reset tween. Call once per rAF frame BEFORE
   *  `controls.update()`. Uses performance.now() internally. */
  update(): void;
  /** Remove all listeners and dispose the OrbitControls. */
  dispose(): void;
}

/**
 * Create + configure OrbitControls with the shared clinical interaction
 * model and wire the focus-or-reset + keyboard affordances. See the module
 * doc for the exact model.
 */
export function createClinicalCameraControls(
  opts: ClinicalCameraControlsOptions,
): ClinicalCameraControlsHandle {
  const { camera, domElement, keyElement, requestRender, getPickRoot } = opts;

  const controls = new OrbitControls(camera, domElement);
  Object.assign(controls, CLINICAL_CAMERA_DEFAULTS);

  // Cooperative touch (P0 "3D stage scroll trap"): on coarse pointers with
  // the opt-in set, one finger belongs to the PAGE and two fingers to the
  // camera. Applied only when cooperative — the default path leaves the
  // OrbitControls touch model and every touch-action style byte-identical
  // to the pre-option behavior.
  const touchGestures = resolveTouchGestureConfig(opts.allowPageScrollOnMiss, isCoarsePointer());
  if (touchGestures.cooperative) {
    controls.touches.ONE = touchGestures.one;
    controls.touches.TWO = touchGestures.two;
    // Both OrbitControls.connect() and createMannequinRenderer hard-set
    // `touch-action: none`; override AFTER construction so one-finger
    // vertical swipes reach the browser's scroller. The container gets the
    // same value — it is the hit surface wherever it outsizes the canvas.
    domElement.style.touchAction = touchGestures.touchAction;
    if (keyElement && keyElement !== domElement) {
      keyElement.style.touchAction = touchGestures.touchAction;
    }
  }

  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();

  let home: { target: THREE.Vector3; position: THREE.Vector3 } | null = null;

  interface ActiveTween {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromPosition: THREE.Vector3;
    toPosition: THREE.Vector3;
    start: number;
  }
  let tween: ActiveTween | null = null;

  function startTween(toTarget: THREE.Vector3, toPosition: THREE.Vector3 | null): void {
    tween = {
      fromTarget: controls.target.clone(),
      toTarget: toTarget.clone(),
      fromPosition: camera.position.clone(),
      // null → hold the camera where it is (focus tween moves target only).
      toPosition: (toPosition ?? camera.position).clone(),
      start: performance.now(),
    };
    requestRender();
  }

  function update(): void {
    if (!tween) return;
    const t = (performance.now() - tween.start) / CLINICAL_CAMERA_TWEEN_MS;
    if (t >= 1) {
      // Exact endpoints so a reset lands ON the home view, not epsilon-off.
      controls.target.copy(tween.toTarget);
      camera.position.copy(tween.toPosition);
      tween = null;
    } else {
      const eased = easeInOutCubic(t);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
      camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
    }
    requestRender();
  }

  // A user gesture takes over immediately — never fight the hand.
  const cancelTween = () => {
    tween = null;
  };
  controls.addEventListener('start', cancelTween);

  function captureHomeView(): void {
    home = { target: controls.target.clone(), position: camera.position.clone() };
  }

  function resetView(): void {
    if (!home) return;
    startTween(home.target, home.position);
  }

  function focusOn(point: THREE.Vector3): void {
    startTween(point, null);
  }

  function dollyStep(direction: 1 | -1): void {
    cancelTween();
    const offset = camera.position.clone().sub(controls.target);
    const dist = offset.length();
    if (dist < 1e-9) return;
    const next = resolveDollyDistance(dist, direction, {
      min: controls.minDistance,
      max: controls.maxDistance,
    });
    camera.position.copy(controls.target).addScaledVector(offset.normalize(), next);
    controls.update();
    requestRender();
  }

  // ── Double-click / double-tap: focus the hit point, or reset on a miss ───
  function focusOrResetAt(clientX: number, clientY: number): void {
    const rect = domElement.getBoundingClientRect();
    const ndc = clientToNdc(clientX, clientY, rect);
    const root = getPickRoot();
    if (root) {
      _ndc.set(ndc.x, ndc.y);
      raycaster.setFromCamera(_ndc, camera);
      // SkinnedMesh.raycast is pose-aware (bone transforms applied), so the
      // hit lands on the CURRENT — possibly antalgic — surface.
      const hits = raycaster.intersectObject(root, true);
      if (hits.length > 0) {
        focusOn(hits[0].point);
        return;
      }
    }
    resetView();
  }

  /** While set, ignore dblclick — a touch double-tap already handled the
   *  gesture and some browsers ALSO synthesize dblclick from it. */
  let suppressDblClickUntil = 0;

  const onDblClick = (ev: MouseEvent) => {
    if (performance.now() < suppressDblClickUntil) return;
    focusOrResetAt(ev.clientX, ev.clientY);
  };
  domElement.addEventListener('dblclick', onDblClick);

  // Touch double-tap → the same focus-or-reset. Cooperative mode only:
  // there one finger no longer orbits (so a tap is unambiguous) and iOS
  // Safari does not reliably synthesize dblclick from double-taps.
  const doubleTap = createDoubleTapTracker();
  const onTouchPointerDown = (ev: PointerEvent) => {
    if (ev.pointerType !== 'touch') return;
    doubleTap.down(ev.pointerId, ev.clientX, ev.clientY, performance.now());
  };
  const onTouchPointerUp = (ev: PointerEvent) => {
    if (ev.pointerType !== 'touch') return;
    const now = performance.now();
    if (doubleTap.up(ev.pointerId, ev.clientX, ev.clientY, now)) {
      suppressDblClickUntil = now + 700;
      focusOrResetAt(ev.clientX, ev.clientY);
    }
  };
  const onTouchPointerCancel = (ev: PointerEvent) => {
    if (ev.pointerType !== 'touch') return;
    doubleTap.cancel();
  };
  if (touchGestures.cooperative) {
    domElement.addEventListener('pointerdown', onTouchPointerDown);
    domElement.addEventListener('pointerup', onTouchPointerUp);
    domElement.addEventListener('pointercancel', onTouchPointerCancel);
  }

  // ── Keyboard path (container must be focusable) ──────────────────────────
  const onKeyDown = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case '+':
      case '=':
        dollyStep(1);
        break;
      case '-':
      case '_':
        dollyStep(-1);
        break;
      case '0':
      case 'Home':
        resetView();
        break;
      default:
        return; // arrows are handled by OrbitControls' own key listener
    }
    ev.preventDefault();
  };
  if (keyElement) {
    // Arrow-key pan (OrbitControls prevents default only when it handles a key).
    controls.listenToKeyEvents(keyElement);
    keyElement.addEventListener('keydown', onKeyDown);
  }

  return {
    controls,
    cooperativeTouch: touchGestures.cooperative,
    captureHomeView,
    hasHomeView: () => home !== null,
    focusOn,
    resetView,
    dollyStep,
    update,
    dispose: () => {
      tween = null;
      domElement.removeEventListener('dblclick', onDblClick);
      if (touchGestures.cooperative) {
        domElement.removeEventListener('pointerdown', onTouchPointerDown);
        domElement.removeEventListener('pointerup', onTouchPointerUp);
        domElement.removeEventListener('pointercancel', onTouchPointerCancel);
      }
      if (keyElement) {
        keyElement.removeEventListener('keydown', onKeyDown);
        // Only when wired — three's stopListenToKeyEvents throws if
        // listenToKeyEvents was never called (null key-events element).
        controls.stopListenToKeyEvents();
      }
      controls.removeEventListener('start', cancelTween);
      controls.dispose();
    },
  };
}
