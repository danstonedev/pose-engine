import type { Object3D } from 'three';

/**
 * Helpers for configuring a three.js TransformControls rotate gizmo for pose
 * editing. TransformControls builds all of its handles once (per mode), so
 * removing a handle from the helper hierarchy persists across mode/space
 * changes and across re-attach.
 *
 * The rotate gizmo's handles are named: 'X','Y','Z' (planar rings),
 * 'E' (eye/camera-space rotation — the larger outer ring) and 'XYZE'
 * (a free-rotation trackball the SAME radius as the planar rings). The
 * XYZE free-rotate handle reads as a confusing inner ring that overlaps the
 * planar controls and drags with an inverted feel, so pose UIs remove it
 * while keeping the outer 'E' camera-space ring and the X/Y/Z rings.
 *
 * NOTE: we deliberately keep three's stock half-arc visuals AND its stock
 * full-torus pickers. Attempts to "fill" the rings to 360° or to shrink the
 * pickers to the visible half both failed: three differentiates the rings via a
 * per-frame camera-facing spin, so a filled ring tilts out of the joint plane,
 * and a half-picker no longer coincides with the drawn ring (you grab empty
 * space). The stock full picker always lies in the visible ring's plane, so what
 * you see is what you grab. (Cost: the invisible far half of a ring can still
 * rotate the opposite way — a minor stock quirk.)
 */

/** Remove the named handles (e.g. ['XYZE']) from a TransformControls helper —
 *  both the visible gizmo handle and its invisible picker, so the handle is
 *  neither drawn nor interactable. Safe to call once after getHelper(). */
export function removeGizmoHandles(helper: Object3D, names: readonly string[]): void {
  const doomed: Object3D[] = [];
  helper.traverse((obj) => {
    if (obj.name && names.includes(obj.name)) doomed.push(obj);
  });
  for (const obj of doomed) obj.parent?.remove(obj);
}

/** Drop the confusing 'XYZE' free-rotation trackball, keeping the 'E'
 *  eye/camera-space ring and the X/Y/Z planar rings. */
export function removeGizmoFreeRotate(helper: Object3D): void {
  removeGizmoHandles(helper, ['XYZE']);
}

/** One-call configuration for a pose rotate gizmo so every app is identical:
 *  drop the 'XYZE' free-rotation trackball, keep the outer 'E' camera ring and
 *  the stock X/Y/Z rings (whose pickers coincide with the drawn rings). */
export function configurePoseRotateGizmo(helper: Object3D): void {
  removeGizmoFreeRotate(helper);
}

/** Configuration for the full-ring rotate gizmo (`PoseRotateRingGizmo`): remove
 *  three's XYZE trackball AND its X/Y/Z rings/pickers, keeping only the 'E'
 *  camera-space ring. The X/Y/Z rings are then drawn + grabbed by the overlay
 *  gizmo, so what you see is what you grab and grabbing works from anywhere. */
export function configureRingRotateGizmo(helper: Object3D): void {
  removeGizmoHandles(helper, ['XYZE', 'X', 'Y', 'Z']);
}
