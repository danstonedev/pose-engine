import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SkinContact, MAX_SKIN_COMPRESSION_M, SKIN_CONTACT_CLEARANCE_M, type Cushion } from '../services/skinContact';

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

  it('counts only skin within a support slab: skin hanging below its underside is beside it, not in it', () => {
    const { root, mesh, contact } = fixture();
    const geometry = new THREE.PlaneGeometry(0.2, 0.2);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, -0.35, 0);
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(16), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 16 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
    contact.dispose(); mesh.geometry = geometry;
    const skin = new SkinContact(root); skin.update();
    const square = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
    expect(skin.lowest(square)).toBeCloseTo(-0.35, 7);
    expect(skin.lowest(square, undefined, [], -0.075)).toBe(Infinity);
    expect(skin.support(0, square, false, 0, undefined, [], -0.075)).toBe(0);
    expect(root.position.y).toBe(0);
    skin.dispose();
  });

  describe('a foam cushion', () => {
    /** A flat 30 × 30 cm patch of skin owned by `bone`, lying `depth` into a cushion whose top is at y = 0. */
    function lying(depth: number, bone = 'CC_Base_Pelvis') {
      const geometry = new THREE.PlaneGeometry(0.3, 0.3, 20, 20);
      geometry.rotateX(Math.PI / 2); // facing down, onto the cushion
      geometry.translate(0, -depth, 0);
      const count = geometry.getAttribute('position').count;
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
      const skeleton = new THREE.Bone(); skeleton.name = bone;
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
      mesh.add(skeleton); mesh.bind(new THREE.Skeleton([skeleton]));
      const root = new THREE.Group(); root.add(mesh); root.updateMatrixWorld(true);
      const contact = new SkinContact(root); contact.update();
      return { root, mesh, geometry, contact };
    }
    const plinth = (overrides: Partial<Cushion> = {}): Cushion => ({
      top: 0, polygon: [{ x: -1, y: -0.35 }, { x: 1, y: -0.35 }, { x: 1, y: 0.35 }, { x: -1, y: 0.35 }], thicknessM: 0.05, stiffness: 400_000, ...overrides,
    });
    const lowest = (mesh: THREE.SkinnedMesh) => {
      let low = Infinity;
      for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) low = Math.min(low, mesh.getVertexPosition(i, new THREE.Vector3()).y);
      return low;
    };

    it('shares the skin’s overlap between the foam and the tissue by their stiffness, and rests the skin on the foam', () => {
      const { mesh, geometry, contact } = lying(0.02);
      // Tissue three times as stiff as the foam: the foam gives three quarters of the 2 cm, the tissue a quarter.
      const field = contact.press(plinth(), { loadN: 500, tissue: () => 1_200_000, spreadM: 0 });
      contact.finish();
      const middle = Math.floor(field.rows / 2) * field.cols + Math.floor(field.cols / 2);
      expect(field.deflection[middle]).toBeCloseTo(0.015, 4);
      expect(lowest(mesh)).toBeCloseTo(-0.015, 4);
      // The foam carries the load: the pressures over the 30 × 30 cm patch add up to it.
      let carried = 0;
      for (const p of field.pressure) carried += p * field.cellM * field.cellM;
      expect(carried).toBeCloseTo(500, 3);
      expect(field.areaM2).toBeGreaterThan(0.08);
      expect(field.areaM2).toBeLessThan(0.1);
      contact.restore();
      expect(mesh.geometry).toBe(geometry);
      expect(lowest(mesh)).toBeCloseTo(-0.02, 7);
      contact.dispose();
    });

    it('says how far the body is from sinking to carry its own weight', () => {
      // 2 cm in, 0.09 m² bearing, foam and tissue together 300 kPa/m: they carry about 540 N.
      const light = lying(0.02).contact.press(plinth(), { loadN: 200, tissue: () => 1_200_000 });
      expect(light.imbalanceM).toBeLessThan(-0.005);
      const heavy = lying(0.02).contact.press(plinth(), { loadN: 1000, tissue: () => 1_200_000 });
      expect(heavy.imbalanceM).toBeGreaterThan(0.005);
      const even = lying(0.02).contact.press(plinth(), { loadN: 540, tissue: () => 1_200_000, spreadM: 0 });
      expect(Math.abs(even.imbalanceM)).toBeLessThan(0.002);
    });

    it('bends its surface down past the skin, never up, and leaves skin under it or over an opening alone', () => {
      const { contact } = lying(0.02);
      const opening = [{ x: 0.5, y: -0.1 }, { x: 0.7, y: -0.1 }, { x: 0.7, y: 0.1 }, { x: 0.5, y: 0.1 }];
      const field = contact.press(plinth({ openings: [opening] }), { loadN: 500 });
      // A cell 3 cm past the patch's edge dips; one 30 cm away does not; the opening is not foam.
      const cellAt = (x: number, z: number) => Math.floor((z - field.origin.y) / field.cellM) * field.cols + Math.floor((x - field.origin.x) / field.cellM);
      expect(field.deflection[cellAt(0.18, 0)]).toBeGreaterThan(0.001);
      expect(field.deflection[cellAt(0.45, 0)]).toBe(0);
      expect(field.foam[cellAt(0.6, 0)]).toBe(0);
      expect(Math.max(...field.deflection)).toBeLessThanOrEqual(0.05);
      // Skin 7 cm down is under a 5 cm foam: it is not pressed, and bears nothing.
      const under = lying(0.07);
      const below = under.contact.press(plinth(), { loadN: 500 });
      expect(below.areaM2).toBe(0);
      under.contact.finish();
      expect(lowest(under.mesh)).toBeCloseTo(-0.07, 7);
    });

    it('keeps the model’s own normals where nothing moved', () => {
      const { geometry, mesh, contact } = lying(0.02);
      const original = geometry.getAttribute('normal').clone();
      // Only a corner of the patch reaches the foam's outline.
      contact.press(plinth({ polygon: [{ x: 0.1, y: 0.1 }, { x: 1, y: 0.1 }, { x: 1, y: 1 }, { x: 0.1, y: 1 }] }), { loadN: 100 });
      contact.finish();
      const normal = mesh.geometry.getAttribute('normal');
      let kept = 0;
      for (let i = 0; i < normal.count; i++) if (normal.getX(i) === original.getX(i) && normal.getY(i) === original.getY(i) && normal.getZ(i) === original.getZ(i)) kept++;
      expect(kept).toBeGreaterThan(normal.count / 2);
      contact.dispose();
    });
  });

  describe('one part resting on another', () => {
    /** A 30 cm square of "trunk" skin facing up at y = 0, and an 8 cm square of "hand" skin `depth` into it. */
    function resting(depth: number) {
      const root = new THREE.Group();
      const patch = (size: number, segments: number, y: number, name: string, facing: 'up' | 'down') => {
        const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
        geometry.rotateX(facing === 'up' ? -Math.PI / 2 : Math.PI / 2);
        geometry.translate(0, y, 0);
        const count = geometry.getAttribute('position').count;
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
        const bone = new THREE.Bone(); bone.name = name;
        const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
        mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
        root.add(mesh);
        return mesh;
      };
      const trunk = patch(0.3, 30, 0, 'CC_Base_Spine02', 'up');
      const hand = patch(0.08, 8, -depth, 'CC_Base_L_Hand', 'down');
      root.updateMatrixWorld(true);
      const contact = new SkinContact(root); contact.update();
      return { root, trunk, hand, contact };
    }
    const HAND = /_L_Hand$/u, TRUNK = /Spine02$/u;
    const height = (mesh: THREE.SkinnedMesh, x: number, z: number) => {
      let best = Infinity, y = NaN;
      for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) {
        const p = mesh.getVertexPosition(i, new THREE.Vector3());
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < best) { best = d; y = p.y; }
      }
      return y;
    };

    it('measures how far a hand has sunk into the skin under it, and nothing where nothing is under it', () => {
      const { contact } = resting(0.01);
      expect(contact.gap(HAND, TRUNK)).toBeCloseTo(-0.01, 4);
      expect(contact.gap(HAND, /Nothing$/u)).toBe(Infinity);
      contact.dispose();
    });

    it('dents the soft tissue under a resting hand, fading around it, and only so far', () => {
      const shallow = resting(0.003);
      shallow.contact.indent(HAND, TRUNK, 0.004);
      shallow.contact.finish();
      // Pressed 4 mm under the hand (its 3 mm and a millimetre's clearance); untouched 10 cm away.
      expect(height(shallow.trunk, 0, 0)).toBeCloseTo(-0.004, 4);
      expect(height(shallow.trunk, 0.1, 0.1)).toBeCloseTo(0, 9);
      // The hand now rests in the dent (the contact tracks the skin it has moved).
      expect(shallow.contact.gap(HAND, TRUNK)).toBeGreaterThan(0.0009);
      // Never deeper than the dent allowed: a hand 1 cm in still leaves 6 mm of it in the skin.
      const deep = resting(0.01);
      deep.contact.indent(HAND, TRUNK, 0.004);
      deep.contact.finish();
      expect(height(deep.trunk, 0, 0)).toBeCloseTo(-0.004, 4);
      deep.contact.restore();
      expect(height(deep.trunk, 0, 0)).toBeCloseTo(0, 9);
    });
  });
});
