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

/**
 * Which rotate rings a joint must NOT offer, by ring axis ('x' | 'y' | 'z').
 *
 * A ring is a promise that the joint turns on that axis. Two joints break that
 * promise, and both used to be left to the host to remember:
 *
 *  - THE WRIST'S pro/sup ring. Forearm rotation belongs to the forearm, and the
 *    hand shows the same motion a second time. Long-standing rule; it lived
 *    inline in one host and not the other.
 *
 *  - A HINGE'S FRONTAL ring — the knee's and elbow's varus/valgus. This one
 *    caused real damage. `clampHinge` allows ±5° there on a knee, as PLAY
 *    rather than as a range to pose within, so the ring can move essentially
 *    nothing. Dragging it on a FLEXED knee did far worse than nothing:
 *    rig-measured with the real gizmo, an ordinary rotate gesture on a knee at
 *    90°, 120° and 135° of flexion ended at −15.0° every time — the
 *    hyperextension floor — with single-sample bone jumps of 43°, 114° and 79°.
 *
 *    Driving the frontal axis swings the shin toward the swing-twist
 *    decomposition's pole, where flexion stops being recoverable; the clamp
 *    then reads a flexion it should not trust and bounds it to the wrong end of
 *    the range. Full flexion becomes full extension. Not offering the ring
 *    removes the gesture, which is also the honest UI: there is no varus to
 *    pose.
 *
 * Pass the joint's driving-ring map (`computeDrivingRingMap`) so the axis is
 * resolved per rig binding rather than assumed — on this rig the knee's frontal
 * ring is 'z', but that is a fact about the bind, not a constant.
 */
export function hiddenRingsForJoint(
  canonicalKey: string | null | undefined,
  drivingRings: Partial<Record<'sagittal' | 'frontal' | 'transverse', { ring: 'x' | 'y' | 'z' }>> | undefined,
  isHinge: (key: string | null | undefined) => boolean,
): ('x' | 'y' | 'z')[] {
  if (!canonicalKey || !drivingRings) return [];
  const hidden = new Set<'x' | 'y' | 'z'>();
  if (canonicalKey === 'L_Hand' || canonicalKey === 'R_Hand') {
    const proSup = drivingRings.transverse?.ring;
    if (proSup) hidden.add(proSup);
  }
  if (isHinge(canonicalKey)) {
    const frontal = drivingRings.frontal?.ring;
    if (frontal) hidden.add(frontal);
  }
  return [...hidden];
}
