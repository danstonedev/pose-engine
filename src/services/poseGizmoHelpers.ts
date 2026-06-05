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
 * Constrain the X/Y/Z rotate PICKERS to the visible (camera-facing) half-arc.
 *
 * three.js draws each planar rotate ring as a 180° half-arc that `update()`
 * spins to face the camera, but the matching PICKER is a full 360° torus. So a
 * user can grab the undrawn far half of the ring — and the far side of a
 * rotation wheel turns the opposite way, which reads as "inverted" because that
 * half isn't visible. (We keep the half-arc visuals: filling them to 360° would
 * break plane alignment, since three differentiates the rings purely via that
 * camera-facing spin.)
 *
 * Fix: shrink each picker torus to a half-arc with the SAME base orientation as
 * the visible ring's CircleGeometry (rotateY then rotateX by 90°). `update()`
 * applies the same camera-facing quaternion to the gizmo and its picker, so the
 * half-picker tracks the visible half exactly — you can only grab what you see,
 * and rotation always reads in the correct direction.
 *
 * Targets only the fat picker tori (tube ≈ 0.1); the thin visible rings
 * (tube ≈ 0.0075) and translate/scale handles (cylinders/boxes) are left alone.
 *
 * `grabTube` sets the (invisible) hit-band radius — three's default 0.1 is hard
 * to grab, so we widen it. The visible ring is untouched; only the grab area grows.
 */
export function restrictRotatePickersToVisibleHalf(helper: Object3D, grabTube = 0.22): void {
  helper.traverse((obj) => {
    if (obj.name !== 'X' && obj.name !== 'Y' && obj.name !== 'Z') return;
    const mesh = obj as Mesh;
    const geo = mesh.geometry as (TorusGeometry & {
      parameters?: {
        radius: number;
        tube: number;
        radialSegments: number;
        tubularSegments: number;
        arc: number;
      };
    }) | undefined;
    const p = geo?.parameters;
    if (!p || typeof p.arc !== 'number') return; // not a torus (translate/scale handle)
    if (p.tube <= 0.05) return; // thin visible ring — leave the visual untouched
    if (p.arc <= Math.PI + 0.01) return; // already a half picker

    // Rebuild as a half-arc with the visible ring's base orientation so the
    // picker overlays exactly the camera-facing half-arc that's drawn.
    const half = new TorusGeometry(
      p.radius,
      grabTube,
      p.radialSegments ?? 4,
      p.tubularSegments ?? 24,
      Math.PI,
    );
    half.rotateY(Math.PI / 2);
    half.rotateX(Math.PI / 2);
    geo.dispose?.();
    mesh.geometry = half;
  });
}

/**
 * One-call configuration for a pose rotate gizmo so every app is identical:
 *  - remove the 'XYZE' free-rotation trackball (keep the outer 'E' camera ring
 *    and the aligned X/Y/Z half-arc rings),
 *  - restrict the X/Y/Z pickers to the visible half so rotation can't be grabbed
 *    on the invisible far half (which would turn the joint the opposite way).
 */
export function configurePoseRotateGizmo(helper: Object3D): void {
  removeGizmoFreeRotate(helper);
  restrictRotatePickersToVisibleHalf(helper);
}
