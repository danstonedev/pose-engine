import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
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

  describe('the skin round a point, seen along it (fitting a hand)', () => {
    /**
     * Two "legs" lying side by side 5 cm apart, each a 20 × 12 × 20 cm box of skin (top at y = 0, underside at
     * y = -0.12): the left one owned by a bone the hand holds, the right one 2 cm below it (its top at y = -0.02) and not.
     */
    function legs() {
      const root = new THREE.Group();
      const face = (x: number, y: number, name: string, facing: 'up' | 'down') => {
        const geometry = new THREE.PlaneGeometry(0.2, 0.2, 10, 10);
        geometry.rotateX(facing === 'up' ? -Math.PI / 2 : Math.PI / 2);
        geometry.translate(x, y, 0);
        const count = geometry.getAttribute('position').count;
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
        const bone = new THREE.Bone(); bone.name = name;
        const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
        mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
        root.add(mesh);
      };
      face(0, 0, 'CC_Base_L_ThighTwist01', 'up'); face(0, -0.12, 'CC_Base_L_ThighTwist01', 'down');
      face(0.25, -0.02, 'CC_Base_R_ThighTwist01', 'up'); face(0.25, -0.14, 'CC_Base_R_ThighTwist01', 'down');
      root.updateMatrixWorld(true);
      const contact = new SkinContact(root); contact.update();
      return contact.skinAlong(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), { own: /_L_/u, radiusM: 0.35 });
    }
    const at = (x: number, y: number) => new THREE.Vector3(x, y, 0.01);

    it('rests on the top of what is held, not on the other limb beside it', () => {
      const skin = legs();
      expect(skin.height(at(0.05, 0.03))).toBeCloseTo(0, 6);
      // Over the other leg's top (2 cm lower): nothing held there to rest on.
      expect(skin.height(at(0.25, 0.03))).toBe(-Infinity);
    });

    it('says how far a point is into what is held, and into the rest of the body', () => {
      const skin = legs();
      // 1 cm into the held leg: rise 1 cm to leave it; in the held skin, not the rest.
      expect(skin.rise(at(0.05, -0.01))).toBeCloseTo(0.01, 6);
      expect(skin.depth(at(0.05, -0.01), 'own')).toBeCloseTo(0.01, 6);
      expect(skin.depth(at(0.05, -0.01), 'other')).toBe(0);
      // 3 cm into the other leg: in the rest of the body, which rising does not leave.
      expect(skin.rise(at(0.25, -0.05))).toBe(0);
      expect(skin.depth(at(0.25, -0.05), 'other')).toBeCloseTo(0.03, 6);
      expect(skin.depth(at(0.25, -0.05))).toBeCloseTo(0.03, 6);
      // Between the legs, over them, under them: in neither.
      expect(skin.depth(at(0.125, -0.05))).toBe(0);
      expect(skin.depth(at(0.05, 0.02))).toBe(0);
      expect(skin.depth(at(0.05, -0.2))).toBe(0);
    });

    it('does not take skin on one side of a point only for being inside it', () => {
      // A top with no underside in reach (a limb's edge seen side-on, its flank missed): not inside.
      const root = new THREE.Group();
      const geometry = new THREE.PlaneGeometry(0.2, 0.2, 10, 10);
      geometry.rotateX(-Math.PI / 2);
      const count = geometry.getAttribute('position').count;
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
      const bone = new THREE.Bone(); bone.name = 'CC_Base_Pelvis';
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
      mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
      root.add(mesh); root.updateMatrixWorld(true);
      const contact = new SkinContact(root); contact.update();
      const skin = contact.skinAlong(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
      expect(skin.height(at(0.02, 0.01))).toBeCloseTo(0, 6);
      expect(skin.depth(at(0.02, -0.03))).toBe(0);
      expect(skin.rise(at(0.02, -0.03))).toBe(0);
      contact.dispose();
    });
  });
});

/**
 * The contact is asked about the posed skin many times a frame (a limb laid on a plinth one bone at a time asks after
 * every turn), so it poses the skin with each bone's matrices multiplied once, and poses again only what a turned bone
 * carries. On the real bodies, what it poses is what three.js poses.
 */
describe('how far two parts are apart, or pressed together', () => {
  /** Two 10 cm cubes of skin side by side along x, `gap` apart (negative: pressed that far into each other). */
  function cubes(gap: number) {
    const root = new THREE.Group();
    const cube = (x: number, name: string) => {
      const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.1, 10, 10, 10);
      geometry.translate(x, 0, 0);
      const count = geometry.getAttribute('position').count;
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
      const bone = new THREE.Bone(); bone.name = name;
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
      mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
      root.add(mesh);
    };
    cube(0, 'CC_Base_L_ThighTwist01');
    cube(0.1 + gap, 'CC_Base_R_Foot');
    root.updateMatrixWorld(true);
    const contact = new SkinContact(root);
    contact.update();
    return contact;
  }
  const THIGH = /_L_ThighTwist01$/u, FOOT = /_R_Foot$/u;

  it('is the gap between two parts apart, and how deep one is pressed into the other, whichever is named first', () => {
    for (const gap of [0.02, 0.004, 0, -0.004, -0.015]) {
      const contact = cubes(gap);
      expect(contact.separation(FOOT, THIGH).separationM, `${gap}`).toBeCloseTo(gap, 6);
      expect(contact.separation(THIGH, FOOT).separationM, `${gap}`).toBeCloseTo(gap, 6);
      contact.dispose();
    }
  });

  it('counts a part past the rim of what it measures as outside it, not behind it', () => {
    // A 10 cm patch of thigh skin facing up (all of the thigh a caller named), and a 2 cm foot beside it, below its level:
    // the patch's nearest skin is its rim, and past the rim lies skin the caller left out, not the patch's inside.
    const root = new THREE.Group();
    const skinned = (geometry: THREE.BufferGeometry, name: string) => {
      const count = geometry.getAttribute('position').count;
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
      const bone = new THREE.Bone(); bone.name = name;
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
      mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
      root.add(mesh);
    };
    skinned(new THREE.PlaneGeometry(0.1, 0.1, 10, 10).rotateX(-Math.PI / 2), 'CC_Base_L_ThighTwist02');
    skinned(new THREE.BoxGeometry(0.02, 0.02, 0.02, 2, 2, 2).translate(0.08, -0.02, 0), 'CC_Base_R_Foot');
    root.updateMatrixWorld(true);
    const contact = new SkinContact(root);
    contact.update();
    // The foot's nearest corner, (0.07, -0.01, ±0.01), is 2.24 cm from the patch's edge at x = 0.05.
    expect(contact.separation(FOOT, /_L_ThighTwist02$/u).separationM).toBeCloseTo(Math.hypot(0.02, 0.01), 6);
    contact.dispose();
  });

  it('gives where another part presses into it from the side, as far as it gives and no further', () => {
    // A foot pressed 1 cm into the side of a thigh: the thigh's skin gives, pushed out to the foot's, so the foot rests on
    // it; the thigh's far side and its skin away from the foot stay put.
    const pressed = cubes(-0.01);
    pressed.yieldTo(FOOT, THIGH, 0.02);
    expect(pressed.separation(FOOT, THIGH).separationM).toBeGreaterThan(-0.0005);
    expect(pressed.separation(FOOT, THIGH).separationM).toBeLessThan(0.002);
    const skin = (pressed as unknown as { skins: { world: Float64Array; owners: string[] }[] }).skins.find(item => item.owners.some(owner => /ThighTwist01$/u.test(owner)))!;
    const xs = Array.from({ length: skin.world.length / 3 }, (_, i) => skin.world[i * 3]!);
    expect(Math.min(...xs)).toBeCloseTo(-0.05, 6);
    expect(Math.max(...xs.filter(x => x < 0.045))).toBeLessThan(0.045);
    pressed.dispose();
    // Pressed 3 cm, it gives only the 1 cm it is let: the foot is still 2 cm or more into it.
    const deep = cubes(-0.03), before = deep.separation(FOOT, THIGH).separationM;
    deep.yieldTo(FOOT, THIGH, 0.01);
    const after = deep.separation(FOOT, THIGH).separationM;
    expect(before).toBeCloseTo(-0.03, 6);
    expect(after).toBeLessThan(-0.019);
    expect(after).toBeGreaterThan(before);
    deep.dispose();
  });

  it('gives where a part pokes between the vertices of the skin it presses, none of them inside it', () => {
    // A 10 cm patch of thigh skin of two triangles facing up, and a 2 cm foot pressed 5 mm into its middle: no vertex of
    // the patch is in the foot, but the foot's are behind the patch's face, so the patch is pushed in to clear them.
    const root = new THREE.Group();
    const skinned = (geometry: THREE.BufferGeometry, name: string) => {
      const count = geometry.getAttribute('position').count;
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
      const bone = new THREE.Bone(); bone.name = name;
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
      mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
      root.add(mesh);
    };
    skinned(new THREE.PlaneGeometry(0.1, 0.1, 1, 1).rotateX(-Math.PI / 2), 'CC_Base_L_ThighTwist02');
    skinned(new THREE.BoxGeometry(0.02, 0.02, 0.02, 2, 2, 2).translate(0, 0.005, 0), 'CC_Base_R_Foot');
    root.updateMatrixWorld(true);
    const contact = new SkinContact(root);
    contact.update();
    const PATCH = /_L_ThighTwist02$/u;
    expect(contact.separation(FOOT, PATCH).separationM).toBeCloseTo(-0.005, 6);
    contact.yieldTo(FOOT, PATCH, 0.02);
    expect(contact.separation(FOOT, PATCH).separationM).toBeGreaterThan(-0.0005);
    expect(contact.separation(FOOT, PATCH).separationM).toBeLessThan(0.002);
    contact.dispose();
  });

  it('names the bones where they come nearest, and says when they are out of reach or one has no skin', () => {
    const pressed = cubes(-0.01);
    expect(pressed.separation(FOOT, THIGH)).toMatchObject({ regionOwner: 'CC_Base_R_Foot', ontoOwner: 'CC_Base_L_ThighTwist01' });
    expect(pressed.separation(THIGH, FOOT)).toMatchObject({ regionOwner: 'CC_Base_L_ThighTwist01', ontoOwner: 'CC_Base_R_Foot' });
    pressed.dispose();
    const apart = cubes(0.2);
    expect(apart.separation(FOOT, THIGH).separationM).toBe(0.05);
    expect(apart.separation(FOOT, THIGH, 0.3).separationM).toBeCloseTo(0.2, 6);
    expect(apart.separation(FOOT, /Nothing$/u).separationM).toBe(Infinity);
    apart.dispose();
  });
});

describe('the posed skin, on the real bodies', () => {
  const bodies = new Map<string, THREE.Group>();
  beforeAll(async () => {
    for (const variant of ['male', 'female'] as const) {
      const buf = readFileSync(fileURLToPath(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url)));
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve as never, reject);
      });
      gltf.scene.scale.setScalar(BODY_VARIANTS[variant].pose.rootScale);
      applyAnatomicPose(gltf.scene, BODY_VARIANTS[variant]);
      bodies.set(variant, gltf.scene);
    }
  }, 60_000);
  const meshes = (root: THREE.Object3D) => { const out: THREE.SkinnedMesh[] = []; root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh); }); return out; };
  const bone = (root: THREE.Object3D, pattern: RegExp) => { let found: THREE.Bone | undefined; root.traverse(o => { if (!found && (o as THREE.Bone).isBone && pattern.test(o.name)) found = o as THREE.Bone; }); return found!; };
  /** The skin as the contact holds it, vertex by vertex. */
  const world = (contact: SkinContact) => (contact as unknown as { skins: { world: Float64Array }[] }).skins
    .map(skin => Array.from({ length: skin.world.length / 3 }, (_, i) => new THREE.Vector3().fromArray(skin.world, i * 3)));

  it.each(['male', 'female'])('%s: poses the skin where SkinnedMesh.getVertexPosition puts it, turned, lying and moved', variant => {
    const root = bodies.get(variant)!;
    bone(root, /L_Thigh$/u).rotateX(-0.7); bone(root, /R_Forearm$/u).rotateZ(0.5); bone(root, /Spine02$/u).rotateY(0.2);
    root.rotation.set(-Math.PI / 2, 0.3, 0); root.position.set(0.2, 0.6, -0.1); root.updateMatrixWorld(true);
    const contact = new SkinContact(root);
    contact.update();
    let furthest = 0;
    meshes(root).forEach((mesh, s) => {
      const posed = world(contact)[s]!;
      for (let i = 0; i < posed.length; i++) furthest = Math.max(furthest, posed[i]!.distanceTo(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)));
    });
    expect(furthest).toBeLessThan(1e-9);
    contact.dispose();
  });

  it('after one bone turns, poses again only the skin it carries, as a whole update would pose it', () => {
    const root = bodies.get('male')!;
    root.rotation.set(0, 0, 0); root.position.set(0, 0, 0); root.updateMatrixWorld(true);
    const contact = new SkinContact(root);
    contact.update();
    const before = world(contact);
    const knee = bone(root, /L_Calf$/u);
    knee.rotateX(0.6);
    contact.update(knee);
    const partial = world(contact);
    contact.update();
    const whole = world(contact);
    let furthest = 0, moved = 0, total = 0;
    partial.forEach((skin, s) => skin.forEach((p, i) => {
      furthest = Math.max(furthest, p.distanceTo(whole[s]![i]!));
      total++;
      if (p.distanceTo(before[s]![i]!) > 1e-6) moved++;
    }));
    expect(furthest).toBeLessThan(1e-12);
    // The shin and foot moved, and nothing else.
    expect(moved).toBeGreaterThan(200);
    expect(moved).toBeLessThan(total / 5);
    // Laid on a support in between (the whole body moved 5 cm, its skin moved with it, not posed again), then the knee
    // turns back: the skin it carries, the thigh's included where they share it, is posed with every bone where it now
    // is. (To the nanometre: skin moved with the body moves exactly as far, where three.js moves it that far times its
    // weights' sum, which is 1 only to float32 rounding.)
    contact.support(contact.lowest() + 0.05, undefined, true);
    knee.rotateX(-0.9);
    contact.update(knee);
    const turned = world(contact);
    contact.update();
    furthest = 0;
    world(contact).forEach((skin, s) => skin.forEach((p, i) => { furthest = Math.max(furthest, p.distanceTo(turned[s]![i]!)); }));
    expect(furthest).toBeLessThan(1e-8);
    contact.dispose();
  });

  it('gives the skin round what it pressed the normals computeVertexNormals would, and leaves the rest the model’s own', () => {
    const root = bodies.get('female')!;
    root.rotation.set(0, 0, 0); root.position.set(0, 0, 0); root.updateMatrixWorld(true);
    const contact = new SkinContact(root);
    contact.update();
    // A slab under the feet: the soles are flattened onto it.
    contact.support(contact.lowest() + 0.004, [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], true, 0.004);
    contact.finish();
    let checked = 0;
    for (const mesh of meshes(root)) {
      const drawn = mesh.geometry.getAttribute('normal'), original = (contact as unknown as { skins: { mesh: THREE.SkinnedMesh; original: THREE.BufferGeometry; moved: Set<number>; triangles: [number, number, number][] }[] }).skins.find(skin => skin.mesh === mesh)!;
      const expected = mesh.geometry.clone();
      expected.computeVertexNormals();
      const near = new Uint8Array(drawn.count);
      for (const t of original.triangles) if (t.some(i => original.moved.has(i))) for (const i of t) near[i] = 1;
      const own = original.original.getAttribute('normal'), fresh = expected.getAttribute('normal');
      for (let i = 0; i < drawn.count; i++) {
        const want = near[i] ? fresh : own;
        expect([drawn.getX(i), drawn.getY(i), drawn.getZ(i)]).toEqual([want.getX(i), want.getY(i), want.getZ(i)]);
        if (near[i]) checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
    contact.dispose();
  });

  /**
   * The lowest skin a support holds, as clipping every triangle to the support and cutting each opening out of it gives
   * it (the pieces keep the height at their rim), in plain arrays: what the contact's shortcuts must agree with.
   */
  function lowestByClipping(contact: SkinContact, polygon: { x: number; y: number }[], pattern?: RegExp, openings: { x: number; y: number }[][] = [], floor = -Infinity): number {
    type P = { x: number; y: number; z: number };
    const edge = (input: P[], a: { x: number; y: number }, b: { x: number; y: number }) => {
      const side = (p: P) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x), out: P[] = [];
      input.forEach((current, k) => {
        const previous = input[(k + input.length - 1) % input.length]!, d0 = side(previous), d1 = side(current);
        if ((d0 >= 0) !== (d1 >= 0)) { const t = d0 / (d0 - d1); out.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y), z: previous.z + t * (current.z - previous.z) }); }
        if (d1 >= 0) out.push(current);
      });
      return out;
    };
    let lowest = Infinity;
    for (const skin of (contact as unknown as { skins: { world: Float64Array; tri: Uint32Array; owners: string[] }[] }).skins) {
      for (let t = 0; t < skin.tri.length; t += 3) {
        const corners = [skin.tri[t]!, skin.tri[t + 1]!, skin.tri[t + 2]!];
        if (pattern && !corners.every(i => pattern.test(skin.owners[i]!))) continue;
        const points = corners.map(i => ({ x: skin.world[i * 3]!, y: skin.world[i * 3 + 2]!, z: skin.world[i * 3 + 1]! }));
        if (points.every(p => p.z < floor)) continue;
        let parts = [polygon.reduce((part, a, k) => part.length ? edge(part, a, polygon[(k + 1) % polygon.length]!) : part, points)];
        for (const opening of openings) parts = parts.flatMap(part => {
          const pieces: P[][] = [];
          let inside = part;
          opening.forEach((a, k) => {
            const b = opening[(k + 1) % opening.length]!;
            if (!inside.length) return;
            const piece = edge(inside, b, a);
            if (piece.length) pieces.push(piece);
            inside = edge(inside, a, b);
          });
          return pieces;
        });
        for (const part of parts) for (const p of part) lowest = Math.min(lowest, p.z);
      }
    }
    return lowest;
  }

  it('finds the lowest skin a support holds as clipping every triangle to it does, openings cut out', () => {
    const root = bodies.get('male')!;
    applyAnatomicPose(root, BODY_VARIANTS.male);
    bone(root, /L_Thigh$/u).rotateX(-0.5); bone(root, /R_Upperarm$/u).rotateZ(-0.6); bone(root, /Head$/u).rotateY(0.4);
    // Lying face down, turned in the room: the plinth's edges are not along the axes.
    root.rotation.set(Math.PI / 2, 0.35, 0); root.position.set(0.1, 0.8, 0.05); root.updateMatrixWorld(true);
    const contact = new SkinContact(root);
    contact.update();
    const box = new THREE.Box3();
    for (const skin of world(contact)) for (const p of skin) box.expandByPoint(p);
    const middle = box.getCenter(new THREE.Vector3()), low = box.min.y;
    const turned = (s: number, t: number, about = middle, angle = 0.35) => ({ x: about.x + s * Math.cos(angle) - t * Math.sin(angle), y: about.z + s * Math.sin(angle) + t * Math.cos(angle) });
    const plinth = [turned(-0.3, -1.1), turned(0.3, -1.1), turned(0.3, 1.1), turned(-0.3, 1.1)];
    // The head's end: an opening under the face (32 edges), one of 40 edges, and a ring round it.
    const head = bone(root, /Head$/u).getWorldPosition(new THREE.Vector3());
    const ellipse = (edges: number, a: number, b: number) => Array.from({ length: edges }, (_, k) => turned(a * Math.cos(k / edges * Math.PI * 2), b * Math.sin(k / edges * Math.PI * 2), head));
    const face = ellipse(32, 0.06, 0.09), finer = ellipse(40, 0.06, 0.09), ring = ellipse(32, 0.1, 0.13);
    const cases: [string, Parameters<SkinContact['lowest']>][] = [
      ['plinth', [plinth]], ['plinth, the legs', [plinth, /(Thigh|Calf|Foot|Toe)/u]], ['plinth, face opening', [plinth, undefined, [face]]],
      ['plinth, 40-edge opening', [plinth, undefined, [finer]]], ['face ring', [ring, /Head$|Neck/u, [face]]], ['40-edge ring', [finer, /Head$|Neck/u]],
      ['plinth slab, the arms', [plinth, /(Hand|Forearm|Upperarm)/u, [face], low + 0.05]], ['opening alone', [undefined, undefined, [face]]],
    ];
    for (const [name, args] of cases) {
      const [polygon, pattern, openings, floor] = args;
      const reference = lowestByClipping(contact, polygon ?? [turned(-5, -5), turned(5, -5), turned(5, 5), turned(-5, 5)], pattern, openings, floor);
      expect(Number.isFinite(reference), name).toBe(true);
      // To the last bit or so of the clip's rounding (a piece's rim can round a hair below its corners).
      expect(Math.abs(contact.lowest(...args) - reference), name).toBeLessThan(1e-12);
    }
    contact.dispose();
  });

  it('measures a part resting on another as the least gap between their columns', () => {
    const root = bodies.get('female')!;
    const trunk = /(Spine0[12]|Waist|RibsTwist|Breast|Pelvis)$/u;
    const pairs: [RegExp, RegExp][] = [
      [/Head$/u, trunk], [/_L_(ForearmTwist0[12]|Hand|(Thumb|Index|Mid|Ring|Pinky)[123])$/u, trunk], [/_L_(Forearm|Upperarm)/u, trunk], [/_R_(Calf|Foot)/u, /_L_(Calf|Foot)/u],
    ];
    let measured = 0;
    // Standing, and lying on the back with the left hand brought over the body.
    for (const lying of [false, true]) {
      applyAnatomicPose(root, BODY_VARIANTS.female);
      if (lying) { bone(root, /L_Upperarm$/u).rotateX(-0.9); bone(root, /L_Forearm$/u).rotateX(-1.2); }
      root.rotation.set(lying ? -Math.PI / 2 : 0, 0, 0); root.position.set(0, lying ? 0.8 : 0, 0); root.updateMatrixWorld(true);
      const contact = new SkinContact(root);
      contact.update();
      const columns = contact as unknown as { columns: (region: RegExp, onto: RegExp, cell: number, margin: number) => { top: Float32Array; under: Float32Array } | null };
      for (const [region, onto] of pairs) {
        const grid = columns.columns(region, onto, 0.005, 0.005)!;
        let least = Infinity;
        grid.top.forEach((top, k) => { if (top > -Infinity && grid.under[k]! < Infinity) least = Math.min(least, grid.under[k]! - top); });
        expect(contact.gap(region, onto), `${lying ? 'lying' : 'standing'}: ${region}`).toBe(least);
        if (Number.isFinite(least)) measured++;
      }
      contact.dispose();
    }
    // The head over the chest and the arm beside it standing; the hand and the arm over the body lying.
    expect(measured).toBeGreaterThanOrEqual(4);
  });

  it('finds how far two parts are apart side by side, where looking straight down sees nothing, and how far pressed together', async () => {
    for (const variant of ['male', 'female'] as const) {
      // A fresh body: the tests before this one leave bones turned that the anatomic pose does not set.
      const buf = readFileSync(fileURLToPath(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url)));
      const { scene: root } = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve as never, reject);
      });
      root.scale.setScalar(BODY_VARIANTS[variant].pose.rootScale);
      applyAnatomicPose(root, BODY_VARIANTS[variant]);
      root.updateMatrixWorld(true);
      const thigh = (side: string) => new RegExp(`_${side}_(Thigh|ThighTwist0[12])$`, 'u');
      let contact = new SkinContact(root);
      contact.update();
      // Standing, the inner thighs close but clear (the male's by a centimetre, the female's by two); side by side, so
      // nothing of one lies above the other.
      const apart = contact.separation(thigh('L'), thigh('R'));
      expect(apart.separationM, variant).toBeGreaterThan(0.002);
      expect(apart.separationM, variant).toBeLessThan(0.03);
      expect(apart.regionOwner, variant).toMatch(/_L_(Thigh|ThighTwist0[12])$/u);
      expect(apart.ontoOwner, variant).toMatch(/_R_(Thigh|ThighTwist0[12])$/u);
      expect(contact.separation(thigh('R'), thigh('L')).separationM, variant).toBe(apart.separationM);
      expect(contact.gap(thigh('L'), thigh('R')), variant).toBe(Infinity);
      contact.dispose();
      // The left leg slid 3 cm toward the right: the thighs press into each other, by as much of it as their skin follows
      // (near the groin, the pelvis carries some of it).
      const leg = bone(root, /L_Thigh$/u), at = leg.getWorldPosition(new THREE.Vector3());
      const across = bone(root, /R_Thigh$/u).getWorldPosition(new THREE.Vector3()).sub(at).setY(0).normalize();
      leg.position.copy(leg.parent!.worldToLocal(at.addScaledVector(across, 0.03)));
      root.updateMatrixWorld(true);
      contact = new SkinContact(root);
      contact.update();
      const pressed = contact.separation(thigh('L'), thigh('R')).separationM;
      expect(pressed, variant).toBeLessThan(0);
      expect(pressed, variant).toBeLessThan(apart.separationM - 0.015);
      expect(pressed, variant).toBeGreaterThan(apart.separationM - 0.035);
      contact.dispose();
    }
  });
});
