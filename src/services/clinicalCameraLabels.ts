/**
 * Clinical camera vocabulary — the three-free half of the camera-controls module.
 *
 * PoseViewer, ObservationViewer and ExamStage3D each need `isCoarsePointer()` and
 * `resolveClinicalCameraAriaLabel()` during render, before any WebGL exists, so those
 * imports have to be static. They all correctly `await import()` the heavy
 * `createClinicalCameraControls` factory inside `onMount` — but the two light helpers
 * lived in the same module, and a static import of any binding pulls the whole module in.
 * `clinicalCameraControls.ts` imports both `three` and `OrbitControls` at module scope, so
 * every one of those static imports defeated the lazy-three contract the components
 * document, and `src/index.ts` re-exports all three components.
 *
 * Nothing here may import `three`, directly or transitively. That is the entire point of
 * the file.
 */

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
