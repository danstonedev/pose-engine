import { TorusGeometry, type Object3D, type Mesh } from 'three';

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

/**
 * Replace the half-arc (180°) X/Y/Z rotate rings with FULL 360° circles.
 *
 * three.js draws each planar rotate ring as a half-arc that `update()` spins to
 * face the camera, but the PICKER for that ring is a full torus. So the user can
 * grab the undrawn far half of the ring — and the far side of a rotation wheel
 * turns the opposite way, which reads as "inverted" because that half isn't
 * visible. Drawing the full ring makes the grab area match what's shown, so the
 * rotation is legible from any side.
 *
 * Only the thin visible rings (tube ≈ 0.0075) are swapped; the fat invisible
 * picker tori (tube ≈ 0.1) are left full/grabbable, and translate/scale handles
 * (cylinders/boxes, not tori) are ignored.
 */
export function fillRotateRings(helper: Object3D): void {
  helper.traverse((obj) => {
    if (obj.name !== 'X' && obj.name !== 'Y' && obj.name !== 'Z') return;
    const mesh = obj as Mesh;
    const geo = mesh.geometry as (TorusGeometry & {
      parameters?: { radius: number; tube: number; radialSegments: number; arc: number };
    }) | undefined;
    const p = geo?.parameters;
    if (!p || typeof p.arc !== 'number') return; // not a torus (translate/scale handle)
    if (p.tube > 0.05) return; // fat picker torus — leave it full + grabbable
    if (p.arc >= Math.PI * 2 - 0.01) return; // already a full ring (e.g. E)

    // Rebuild as a full ring with the same base orientation three's
    // CircleGeometry helper uses (rotateY then rotateX by 90°).
    const full = new TorusGeometry(p.radius, p.tube, p.radialSegments ?? 3, 64, Math.PI * 2);
    full.rotateY(Math.PI / 2);
    full.rotateX(Math.PI / 2);
    geo.dispose?.();
    mesh.geometry = full;
  });
}

/**
 * One-call configuration for a pose rotate gizmo so every app is identical:
 *  - remove the 'XYZE' free-rotation trackball (keep outer 'E' camera ring),
 *  - draw full X/Y/Z planar rings (so rotation isn't grabbed on an invisible
 *    far half and read as inverted).
 */
export function configurePoseRotateGizmo(helper: Object3D): void {
  removeGizmoFreeRotate(helper);
  fillRotateRings(helper);
}
