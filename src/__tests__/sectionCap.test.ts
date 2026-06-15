import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSectionCap } from '../services/sectionCap';

function srcMesh(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
}

describe('sectionCap', () => {
  it('builds a per-mesh cap: 2 stencil clones + 1 cap quad each', () => {
    const cap = createSectionCap([srcMesh(), srcMesh()], 4);
    // 2 sources × (2 clones + 1 cap quad) = 6 children
    expect(cap.group.children.length).toBe(6);
    cap.dispose();
  });

  it('colours each cap from its source material (overridable)', () => {
    const a = srcMesh();
    (a.material as THREE.MeshBasicMaterial).color.setHex(0xff0000);
    const b = srcMesh();
    (b.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
    const cap = createSectionCap([a, b], 4);
    const capMats = cap.group.children
      .filter((c) => (c as THREE.Mesh).material instanceof THREE.MeshStandardMaterial)
      .map((c) => (c as THREE.Mesh).material as THREE.MeshStandardMaterial);
    expect(capMats.map((m) => m.color.getHex())).toEqual([0xff0000, 0x00ff00]);
    // Force one colour, then restore per-source.
    cap.setColor(0x0000ff);
    expect(capMats.every((m) => m.color.getHex() === 0x0000ff)).toBe(true);
    cap.setColor(null);
    expect(capMats.map((m) => m.color.getHex())).toEqual([0xff0000, 0x00ff00]);
    cap.dispose();
  });

  it('aligns the cap quads to the clip plane on update', () => {
    const cap = createSectionCap([srcMesh()], 4);
    const scene = new THREE.Scene();
    scene.add(cap.group);

    // A transverse plane through y = 1.5 (normal +Y).
    cap.setPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.5));
    cap.update();
    const quad = cap.group.children.find(
      (c) => (c as THREE.Mesh).material instanceof THREE.MeshStandardMaterial,
    )!;
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
