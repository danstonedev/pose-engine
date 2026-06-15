import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSectionCap } from '../services/sectionCap';

function srcMesh(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
}

describe('sectionCap', () => {
  it('builds two stencil clones per source plus one cap quad', () => {
    const cap = createSectionCap([srcMesh(), srcMesh()], 4);
    // 2 sources × 2 clones + 1 cap quad = 5 children
    expect(cap.group.children.length).toBe(5);
    cap.dispose();
  });

  it('aligns the cap quad to the clip plane on update', () => {
    const cap = createSectionCap([srcMesh()], 4);
    const scene = new THREE.Scene();
    scene.add(cap.group);

    // A transverse plane through y = 1.5 (normal +Y).
    cap.setPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.5));
    cap.update();
    const quad = cap.group.children[cap.group.children.length - 1];
    // Quad sits on the plane (its local +Z rotated to +Y → world normal +Y).
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(quad.quaternion).normalize();
    expect(Math.abs(n.y)).toBeCloseTo(1, 5);
    expect(quad.position.y).toBeCloseTo(1.5, 5);
    cap.dispose();
  });

  it('toggles group visibility', () => {
    const cap = createSectionCap([srcMesh()], 4);
    cap.setVisible(false);
    expect(cap.group.visible).toBe(false);
    cap.setVisible(true);
    expect(cap.group.visible).toBe(true);
    cap.dispose();
  });
});
