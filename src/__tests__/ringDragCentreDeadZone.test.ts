/**
 * A RING DRAG MUST NOT ROTATE THE BONE WHEN THE POINTER CROSSES THE CENTRE.
 *
 * The gizmo turns a pointer ray into a rotation by intersecting it with the
 * ring's plane and reading the bearing of the hit point about the ring centre.
 * That bearing is `atan2` of a vector whose length goes to zero AT the centre,
 * so it swings freely there: a stroke that passes through the middle of the
 * ring flips it ~180° between two consecutive samples.
 *
 * Measured before the fix, on a steady stroke of 0.002 NDC per sample — far
 * finer than a real pointermove stream — the bone rotated 90° in ONE sample, at
 * every viewing angle from face-on to edge-on.
 *
 * That is the reported snap. 90° of unrequested rotation lands a joint well
 * past its limit, and the ROM clamp then bounds the result to whichever end of
 * the range the wrapped angle fell outside of, so a knee near full flexion
 * arrives at full extension.
 *
 * These drive the REAL gizmo, not a copy of its math.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PoseRotateRingGizmo } from '../services/poseRotateRings';

const DEG = 180 / Math.PI;
const CENTER = new THREE.Vector3(0, 1, 0);

function scene() {
  const gizmo = new PoseRotateRingGizmo();
  const cam = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100);
  cam.position.set(0.45, 1, 3);
  cam.lookAt(CENTER);
  cam.updateMatrixWorld(true);
  gizmo.update(cam, CENTER, new THREE.Quaternion(), true);
  gizmo.group.updateMatrixWorld(true);
  return { gizmo, cam };
}

/**
 * Run a pointer stroke through the gizmo and report, in degrees, the largest
 * rotation the BONE takes in a single sample and the total it ends up with.
 * `path` is in NDC, the space a real pointer arrives in.
 */
function stroke(path: THREE.Vector2[]): { worstStep: number; total: number } | null {
  const { gizmo, cam } = scene();
  const rc = new THREE.Raycaster();
  const q0 = new THREE.Quaternion();

  rc.setFromCamera(path[0], cam);
  const drag = gizmo.beginDrag(rc, {
    centerWorld: CENTER,
    frameQuat: new THREE.Quaternion(),
    boneLocalQuat: q0,
    parentWorldQuat: new THREE.Quaternion(),
  });
  if (!drag) return null;

  let worstStep = 0;
  let prev = q0.clone();
  let last = q0.clone();
  for (let i = 1; i < path.length; i += 1) {
    rc.setFromCamera(path[i], cam);
    last = drag.update(rc).clone();
    worstStep = Math.max(worstStep, prev.angleTo(last) * DEG);
    prev = last.clone();
  }
  gizmo.dispose();
  return { worstStep, total: q0.angleTo(last) * DEG };
}

/** An arc of `n` NDC samples around the gizmo centre, at screen radius `r`.
 *  The 0.62 on x is the viewport aspect, so the path traces a circle on screen
 *  rather than an ellipse. */
function arc(r: number, a0: number, a1: number, n: number): THREE.Vector2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (a0 + ((a1 - a0) * i) / n) / DEG;
    return new THREE.Vector2(Math.cos(a) * r * 0.62, Math.sin(a) * r);
  });
}

/** A straight line of `n` NDC samples from a to b. */
function line(ax: number, ay: number, bx: number, by: number, n: number): THREE.Vector2[] {
  return Array.from({ length: n + 1 }, (_, i) =>
    new THREE.Vector2(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n),
  );
}

describe('a ring drag through the centre does not snap', () => {
  it('grabs the ring at all (the fixture is driving the real picker)', () => {
    // If beginDrag ever stopped returning a drag, every case below would report
    // null and vacuously "pass" a snap threshold.
    expect(stroke(line(0, -0.16, 0, -0.06, 10)), 'a grab on the ring band').not.toBeNull();
  });

  it('the ring under test is grabbable ACROSS its centre — which is why this bites', () => {
    // The X ring is edge-on to this camera, so on screen it is a line through
    // the joint and its grab band covers that whole line, centre included. The
    // user does not have to aim for the middle: grabbing an edge-on ring and
    // dragging along it goes through the centre by construction.
    expect(stroke(line(0, -0.16, 0, 0.16, 10)), 'a grab spanning the centre').not.toBeNull();
  });

  it('never moves the bone more than a few degrees per sample', () => {
    // The defect, as the user meets it: a slow stroke straight down through the
    // joint. Sampled far finer than a real pointer stream, so any per-sample
    // jump here is the math, not the input.
    const s = stroke(line(0, -0.16, 0, 0.16, 250))!;
    expect(s.worstStep, 'one pointer sample must not swing the bone').toBeLessThan(5);
  });

  it('and does not accumulate a rotation from crossing the middle', () => {
    // Sweeping across the centre of a rotate ring is not a request to rotate.
    // Before the dead zone this totalled 180°.
    const s = stroke(line(0, -0.16, 0, 0.16, 250))!;
    expect(s.total, 'crossing the middle is not a rotation').toBeLessThan(20);
  });

  it('still rotates normally on the motion the ring is actually for', () => {
    // The guard must not cost the ordinary drag anything. This sweeps an arc
    // around the FACE-ON ring at the band radius — the gesture the gizmo is
    // designed for — and never enters the dead zone. Measured 140.1° of clean
    // rotation with a 1.4° worst step, identical with the guard on or off.
    const s = stroke(arc(0.16, 20, 160, 250))!;
    expect(s.total, 'an ordinary drag still rotates').toBeGreaterThan(100);
    expect(s.worstStep, 'and does so smoothly').toBeLessThan(5);
  });
});
