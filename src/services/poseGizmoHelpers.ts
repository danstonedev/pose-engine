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
 * while keeping the outer 'E' camera-space ring.
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

/** Convenience: drop the confusing 'XYZE' free-rotation trackball, keeping the
 *  'E' eye/camera-space ring and the X/Y/Z planar rings. */
export function removeGizmoFreeRotate(helper: Object3D): void {
  removeGizmoHandles(helper, ['XYZE']);
}
