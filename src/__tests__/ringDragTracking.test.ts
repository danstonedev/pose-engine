/**
 * EVERY RING TURNS, FROM EVERY VIEW, WITHOUT JUMPING.
 *
 * The gizmo used to turn a pointer into a rotation by intersecting the ray with
 * the ring's PLANE and reading the bearing of the hit point. That has a view
 * direction where it cannot work at all: seen edge-on the ray becomes coplanar
 * with the ring, the intersection fails, and the drag silently does nothing.
 *
 * Measured across camera azimuths before the change, sweeping each ring along
 * its own screen-space tangent — the path a finger takes when following it:
 *
 *     ring          rotation delivered
 *     Y (level)     0.0° at EVERY azimuth   — a whole axis, permanently dead
 *     X             0.0° at its edge-on azimuth, ~11°/sample jumps near it
 *     Z             0.0° at its edge-on azimuth
 *
 * `RingDragImpl` now finds the point on the ring that passes closest to the
 * ray, which is defined for every view because a line and a circle always have
 * a nearest approach. The same sweep now delivers rotation at every azimuth on
 * all three rings, and no sample moves the bone more than the search window.
 *
 * These drive the REAL gizmo, not a copy of its math.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PoseRotateRingGizmo } from '../services/poseRotateRings';

const DEG = 180 / Math.PI;
const CENTER = new THREE.Vector3(0, 1, 0);
/** The per-sample cap the search window imposes, plus a little slack. */
const MAX_STEP_DEG = 9;

type RingAxis = 'X' | 'Y' | 'Z';

function sceneAt(azimDeg: number) {
  const gizmo = new PoseRotateRingGizmo();
  const cam = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100);
  const a = azimDeg / DEG;
  cam.position.set(CENTER.x + Math.sin(a) * 3, CENTER.y, CENTER.z + Math.cos(a) * 3);
  cam.lookAt(CENTER);
  cam.updateMatrixWorld(true);
  gizmo.update(cam, CENTER, new THREE.Quaternion(), true);
  gizmo.group.updateMatrixWorld(true);
  return { gizmo, cam };
}

/** World unit vectors for a ring's axis and its in-plane basis, matching
 *  `beginDrag`'s cyclic construction. */
function basis(axis: RingAxis) {
  const a = new THREE.Vector3(axis === 'X' ? 1 : 0, axis === 'Y' ? 1 : 0, axis === 'Z' ? 1 : 0);
  const u = new THREE.Vector3(a.z, a.x, a.y).normalize();
  return { a, u, v: a.clone().cross(u).normalize() };
}

/**
 * Grab the named ring and sweep the pointer along that ring's OWN screen-space
 * tangent — what a finger does when following it, whatever the view. Returns
 * the rotation delivered and the worst single-sample movement of the bone.
 */
function followRing(azimDeg: number, axis: RingAxis, sweepNdc = 0.2) {
  const { gizmo, cam } = sceneAt(azimDeg);
  const rc = new THREE.Raycaster();
  const q0 = new THREE.Quaternion();

  let drag: ReturnType<PoseRotateRingGizmo['beginDrag']> = null;
  let start = new THREE.Vector2();
  for (let d = 0; d < 360 && !drag; d += 3) {
    const t = d / DEG;
    const p = new THREE.Vector2(Math.cos(t) * 0.16 * 0.62, Math.sin(t) * 0.16);
    rc.setFromCamera(p, cam);
    const cand = gizmo.beginDrag(rc, {
      centerWorld: CENTER,
      frameQuat: new THREE.Quaternion(),
      boneLocalQuat: q0,
      parentWorldQuat: new THREE.Quaternion(),
    });
    if (cand?.axis === axis) {
      drag = cand;
      start = p;
    }
  }
  if (!drag) return null;

  const R = gizmo.group.scale.x;
  const { u, v } = basis(axis);
  const project = (t: number) => {
    const w = CENTER.clone()
      .addScaledVector(u, Math.cos(t) * R)
      .addScaledVector(v, Math.sin(t) * R)
      .project(cam);
    return new THREE.Vector2(w.x, w.y);
  };
  // θ of the grab point, found by nearest screen projection.
  let theta = 0;
  let bestD = Infinity;
  for (let d = 0; d < 360; d += 1) {
    const q = project(d / DEG);
    const dd = q.distanceTo(start);
    if (dd < bestD) {
      bestD = dd;
      theta = d / DEG;
    }
  }
  const tangent = project(theta + 0.05).sub(project(theta - 0.05));
  if (tangent.length() < 1e-6) return null; // tangent points at the camera
  tangent.normalize();

  let worstStep = 0;
  let prev = q0.clone();
  let last = q0.clone();
  for (let i = 1; i <= 120; i += 1) {
    const f = (i / 120) * sweepNdc;
    rc.setFromCamera(new THREE.Vector2(start.x + tangent.x * f, start.y + tangent.y * f), cam);
    last = drag.update(rc).clone();
    worstStep = Math.max(worstStep, prev.angleTo(last) * DEG);
    prev = last.clone();
  }
  gizmo.dispose();
  return { rotated: q0.angleTo(last) * DEG, worstStep };
}

const AZIMUTHS = [0, 5, 15, 30, 45, 60, 75, 85, 90];
const RINGS: RingAxis[] = ['X', 'Y', 'Z'];

describe('a ring responds from every view', () => {
  it('turns the bone on every ring at every azimuth — no dead view', () => {
    // THE defect. The horizontal ring delivered 0.0° at every azimuth with the
    // camera level with the joint, and each other ring died at its own edge-on
    // angle. A view that silently does nothing is worse than one that snaps:
    // there is no feedback to tell the user to try a different angle.
    for (const azim of AZIMUTHS) {
      for (const axis of RINGS) {
        const r = followRing(azim, axis);
        expect(r, `${axis} at azimuth ${azim}° must be grabbable`).not.toBeNull();
        expect(r!.rotated, `${axis} at azimuth ${azim}° delivered no rotation`).toBeGreaterThan(1);
      }
    }
  });

  it('never moves the bone more than the search window in one sample', () => {
    // The other half: responding is only an improvement if it responds SMOOTHLY.
    // The search window caps how far one pointer sample can carry the joint, so
    // an ill-conditioned view degrades into a slower drag rather than a jump.
    for (const azim of AZIMUTHS) {
      for (const axis of RINGS) {
        const r = followRing(azim, axis);
        expect(r!.worstStep, `${axis} at azimuth ${azim}° jumped`).toBeLessThan(MAX_STEP_DEG);
      }
    }
  });
});

describe('the ordinary face-on drag is untouched', () => {
  it('follows the pointer around the ring, smoothly and about 1:1', () => {
    // The gesture the gizmo exists for, and the one that already worked: an arc
    // around a face-on ring. Measured 119.6° of rotation for 120° of pointer
    // sweep, worst sample 0.5°.
    const { gizmo, cam } = sceneAt(0); // Z ring faces this camera
    const rc = new THREE.Raycaster();
    const q0 = new THREE.Quaternion();
    const at = (deg: number) => {
      const a = deg / DEG;
      return new THREE.Vector2(Math.cos(a) * 0.16 * 0.62, Math.sin(a) * 0.16);
    };
    rc.setFromCamera(at(20), cam);
    const drag = gizmo.beginDrag(rc, {
      centerWorld: CENTER,
      frameQuat: new THREE.Quaternion(),
      boneLocalQuat: q0,
      parentWorldQuat: new THREE.Quaternion(),
    });
    expect(drag?.axis, 'the face-on ring').toBe('Z');

    let worst = 0;
    let prev = q0.clone();
    let last = q0.clone();
    for (let i = 1; i <= 250; i += 1) {
      rc.setFromCamera(at(20 + (120 * i) / 250), cam);
      last = drag!.update(rc).clone();
      worst = Math.max(worst, prev.angleTo(last) * DEG);
      prev = last.clone();
    }
    const rotated = q0.angleTo(last) * DEG;
    expect(rotated, 'about 1:1 with the 120° pointer sweep').toBeGreaterThan(100);
    expect(rotated).toBeLessThan(140);
    expect(worst, 'and perfectly smooth').toBeLessThan(2);
    gizmo.dispose();
  });
});
