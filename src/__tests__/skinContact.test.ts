import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SkinContact, MAX_SKIN_COMPRESSION_M, SKIN_CONTACT_CLEARANCE_M } from '../services/skinContact';

function fixture(boneName = '') {
  // Deliberately large triangles: the small prop hits face interiors, not vertices.
  const geometry = new THREE.PlaneGeometry(2, 2);
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(16), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 16 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
  const bone = new THREE.Bone();
  bone.name = boneName;
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  const root = new THREE.Group(); root.add(mesh); root.updateMatrixWorld(true);
  const contact = new SkinContact(root); contact.update();
  const prop = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.01), new THREE.MeshBasicMaterial());
  prop.position.set(0.2, 0.2, -0.04);
  return { root, mesh, bone, geometry, contact, prop };
}

describe('posed skin contact', () => {
  it('supports triangle interiors at an opening rim without supporting skin inside the void', () => {
    const { root, mesh, contact } = fixture();
    // A V-shaped face: its centre vertex hangs through a square face opening.
    const geometry = new THREE.PlaneGeometry(2, 2, 2, 2);
    geometry.rotateX(-Math.PI / 2);
    geometry.getAttribute('position').setY(4, -0.1);
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(36), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 36 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
    contact.dispose(); mesh.geometry = geometry;
    const skin = new SkinContact(root); skin.update();
    const square = (r: number) => [{ x: -r, y: -r }, { x: r, y: -r }, { x: r, y: r }, { x: -r, y: r }];
    expect(skin.lowest(square(1))).toBeCloseTo(-0.1, 7);
    expect(skin.lowest(square(1), undefined, [square(0.25)])).toBeCloseTo(-0.075, 7);
    expect(skin.support(0, square(1), true, 0, undefined, [square(0.25)])).toBeCloseTo(0.075, 7);
    expect(skin.lowest(square(1), undefined, [square(0.25)])).toBeCloseTo(0, 7);
    expect(skin.lowest()).toBeCloseTo(-0.025, 7);
    expect(skin.lowest(square(1), undefined, [square(2)])).toBe(Infinity);
    expect(skin.support(0, square(1), true, 0, undefined, [square(2)])).toBe(0);
    skin.dispose();
  });

  it('expands the free rib surface, keeps the loaded surface planted, and still allows pressure compression', () => {
    const { root, mesh, bone, geometry, contact, prop } = fixture('Spine02');
    geometry.scale(0.1, 0.1, 0.1); geometry.translate(0, 0, 0.1);
    contact.update();
    const rotation = bone.quaternion.clone(), position = root.position.clone();
    contact.breathe(new THREE.Vector3(), new THREE.Vector3(0, 0, 0.2), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), 0.004, -0.1);
    contact.finish();
    expect(contact.lowest()).toBeCloseTo(-0.1, 7);
    expect(mesh.getVertexPosition(0, new THREE.Vector3()).y).toBeGreaterThan(0.102);
    expect(bone.quaternion.equals(rotation)).toBe(true);
    expect(root.position.equals(position)).toBe(true);
    prop.position.set(0, 0, 0);
    contact.resolve(prop, new THREE.Vector3(0, 0, 1), 0.002);
    contact.finish();
    expect(mesh.getVertexPosition(0, new THREE.Vector3()).z).toBeCloseTo(0.098, 7);
    contact.restore();
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.getVertexPosition(0, new THREE.Vector3()).y).toBeCloseTo(0.1, 7);
    contact.dispose();
  });

  it('clears the whole rigid prop, including triangle interiors, with no change to its orientation', () => {
    const { contact, prop } = fixture();
    prop.rotation.z = 0.7;
    const rotation = prop.quaternion.clone();
    expect(contact.resolve(prop, new THREE.Vector3(0, 0, 1))).toBeGreaterThan(0.04);
    expect(prop.position.z - 0.005).toBeCloseTo(SKIN_CONTACT_CLEARANCE_M, 7);
    expect(prop.quaternion.equals(rotation)).toBe(true);
    expect(contact.resolve(prop, new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-8);
  });

  it('compresses the drawn skin by a bounded amount and restores its original shared geometry', () => {
    const { contact, prop, mesh, geometry } = fixture();
    contact.resolve(prop, new THREE.Vector3(0, 0, 1), 1);
    contact.finish();
    expect(mesh.geometry).not.toBe(geometry);
    for (let i = 0; i < 4; i++) {
      const skinZ = mesh.getVertexPosition(i, new THREE.Vector3()).z;
      expect(skinZ).toBeCloseTo(-MAX_SKIN_COMPRESSION_M, 7);
      expect(prop.position.z - 0.005 - skinZ).toBeCloseTo(SKIN_CONTACT_CLEARANCE_M, 7);
    }
    contact.restore();
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.getVertexPosition(0, new THREE.Vector3()).z).toBe(0);
    contact.dispose();
  });

  it('uses the posed skin and inverts skinning when compressing a rotated/scaled model', () => {
    const { root, mesh, bone, contact, prop } = fixture();
    root.scale.setScalar(0.6); root.rotation.y = 0.5; root.position.set(0.1, 0.2, 0.3);
    bone.rotation.x = 0.2;
    root.updateMatrixWorld(true);
    const q = bone.getWorldQuaternion(new THREE.Quaternion());
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    prop.quaternion.copy(q); prop.position.copy(root.position).addScaledVector(normal, -0.03);
    const before = mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    contact.update(); contact.resolve(prop, normal, 0.002); contact.finish();
    const after = mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    expect(before.clone().sub(after).dot(normal)).toBeCloseTo(0.002, 6);
    expect(after.clone().sub(before).cross(normal).length()).toBeLessThan(1e-6);
  });

  it('ignores hidden props and releases the floor for airborne frames', () => {
    const { root, contact, prop } = fixture();
    prop.visible = false;
    expect(contact.resolve(prop, new THREE.Vector3(0, 0, 1))).toBe(0);
    root.position.y = 3; contact.update();
    expect(contact.support(0, undefined, false)).toBe(0);
    expect(root.position.y).toBe(3);
  });
});
