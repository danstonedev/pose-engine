import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createAnatomicalPlanes } from '../services/anatomicalPlanes';

describe('anatomicalPlanes', () => {
  const CENTRE = new THREE.Vector3(0, 1, 0);

  it('gives each cardinal plane the correct world normal through the centre', () => {
    const planes = createAnatomicalPlanes();
    planes.setExtents(CENTRE, 1);
    const p = new THREE.Plane();

    // sagittal divides L/R → normal along X
    expect(Math.abs(planes.getClipPlane('sagittal', p).normal.x)).toBeCloseTo(1, 5);
    expect(planes.getClipPlane('sagittal', p).distanceToPoint(CENTRE)).toBeCloseTo(0, 5);
    // frontal divides A/P → normal along Z
    expect(Math.abs(planes.getClipPlane('frontal', p).normal.z)).toBeCloseTo(1, 5);
    // transverse divides S/I → normal along Y
    expect(Math.abs(planes.getClipPlane('transverse', p).normal.y)).toBeCloseTo(1, 5);
    // transverse plane through y=1: a point at y=2 is one unit off the plane
    planes.getClipPlane('transverse', p);
    expect(Math.abs(p.distanceToPoint(new THREE.Vector3(0, 2, 0)))).toBeCloseTo(1, 5);

    planes.dispose();
  });

  it('toggles visibility independently per plane', () => {
    const planes = createAnatomicalPlanes();
    expect(planes.oblique.visible).toBe(false);
    planes.setObliqueVisible(true);
    expect(planes.oblique.visible).toBe(true);
    planes.setObliqueVisible(false);
    expect(planes.oblique.visible).toBe(false);
    planes.dispose();
  });

  it('tracks the oblique plane as its gizmo node moves', () => {
    const planes = createAnatomicalPlanes();
    planes.setExtents(CENTRE, 1);
    const before = planes.getClipPlane('oblique', new THREE.Plane()).clone();
    planes.oblique.position.set(0, 2, 0); // simulate a gizmo drag
    const after = planes.getClipPlane('oblique', new THREE.Plane());
    expect(after.constant).not.toBeCloseTo(before.constant, 3);
    planes.dispose();
  });

  it('keeps the oblique placement across a model reload, but re-centres cardinals', () => {
    const planes = createAnatomicalPlanes();
    planes.setExtents(CENTRE, 1);
    planes.oblique.position.set(0.5, 1.5, 0);
    // A reload calls setExtents again with a new centre.
    planes.setExtents(new THREE.Vector3(0, 2, 0), 1);
    expect(planes.oblique.position.y).toBeCloseTo(1.5, 5); // oblique untouched
    const p = planes.getClipPlane('transverse', new THREE.Plane());
    expect(p.distanceToPoint(new THREE.Vector3(0, 2, 0))).toBeCloseTo(0, 5); // recentred
    planes.dispose();
  });
});
