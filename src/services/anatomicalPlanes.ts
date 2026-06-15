import * as THREE from 'three';

/**
 * Anatomical reference planes + (future) cross-section slicing for the shared
 * mannequin.
 *
 * Phase 1 (this module): the three cardinal reference planes — sagittal,
 * frontal, transverse — plus one freely-movable oblique plane, drawn as
 * translucent bordered quads sized to the model. `getClipPlane` already returns
 * the world-space math plane for each, so Phase 2 can feed those straight to
 * `material.clippingPlanes` (with stencil capping) without reworking this file.
 *
 * Axis convention (the mannequin is Y-up, faces +Z, feet grounded at y = 0):
 *   - sagittal   divides L/R          → face normal +X (mediolateral)
 *   - frontal    divides anterior/post → face normal +Z (anteroposterior)
 *   - transverse divides superior/inf  → face normal +Y (vertical)
 *
 * Colours follow the same plane-of-motion language as the rotate-ring gizmo
 * (sagittal red, frontal blue, transverse green) with amber for the oblique.
 */

export type CardinalPlaneName = 'sagittal' | 'frontal' | 'transverse';
export type PlaneName = CardinalPlaneName | 'oblique';

export interface AnatomicalPlanesOptions {
  /** Override the per-plane colours (hex). */
  colors?: Partial<Record<PlaneName, number>>;
  /** Translucent fill opacity, 0..1. Default 0.1. */
  fillOpacity?: number;
  /** Quad side as a multiple of the model's bounding radius. Default 2.2, so a
   *  square plane fully covers the model at any orientation. */
  sizeFactor?: number;
}

const DEFAULT_COLORS: Record<PlaneName, number> = {
  sagittal: 0xff3653,
  frontal: 0x2c8fff,
  transverse: 0x8adb00,
  oblique: 0xffb020,
};

/** A `PlaneGeometry` faces +Z; rotating +Z onto each plane's normal orients it. */
const PLUS_Z = new THREE.Vector3(0, 0, 1);
const CARDINAL_NORMAL: Record<CardinalPlaneName, THREE.Vector3> = {
  sagittal: new THREE.Vector3(1, 0, 0),
  frontal: new THREE.Vector3(0, 0, 1),
  transverse: new THREE.Vector3(0, 1, 0),
};
const ALL_PLANES: readonly PlaneName[] = ['sagittal', 'frontal', 'transverse', 'oblique'];

interface PlaneVisual {
  node: THREE.Group; // transform node — position + orientation; scaled to size
  fill: THREE.Mesh;
  border: THREE.LineSegments;
}

export interface AnatomicalPlanes {
  /** Add to the scene; holds all four plane visuals. */
  readonly group: THREE.Group;
  /** The oblique plane's transform node — attach a TransformControls gizmo here. */
  readonly oblique: THREE.Object3D;
  setCardinalVisible(name: CardinalPlaneName, visible: boolean): void;
  setObliqueVisible(visible: boolean): void;
  /** Size + position the planes from the model's bounding sphere. Cardinals
   *  re-centre every call; the oblique is centred only the first time, so a
   *  user's gizmo edits survive a model reload. */
  setExtents(center: THREE.Vector3, radius: number): void;
  /** World-space math plane (normal + constant) for clipping/capping (Phase 2). */
  getClipPlane(name: PlaneName, out?: THREE.Plane): THREE.Plane;
  dispose(): void;
}

export function createAnatomicalPlanes(opts: AnatomicalPlanesOptions = {}): AnatomicalPlanes {
  const colors = { ...DEFAULT_COLORS, ...opts.colors };
  const fillOpacity = opts.fillOpacity ?? 0.1;
  const sizeFactor = opts.sizeFactor ?? 2.2;

  const group = new THREE.Group();
  group.name = 'anatomical-planes';
  const visuals = {} as Record<PlaneName, PlaneVisual>;

  for (const name of ALL_PLANES) {
    const color = colors[name];
    const node = new THREE.Group();
    node.name = `plane-${name}`;
    node.visible = false;

    const geo = new THREE.PlaneGeometry(1, 1);
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: fillOpacity,
        side: THREE.DoubleSide,
        depthWrite: false, // translucent reference — don't occlude, but depth-test
      }),
    );
    fill.renderOrder = 998;

    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }),
    );
    border.renderOrder = 999;

    node.add(fill, border);
    group.add(node);
    visuals[name] = { node, fill, border };
  }

  // Orient each cardinal quad so its face normal matches the plane normal.
  for (const name of ['sagittal', 'frontal', 'transverse'] as CardinalPlaneName[]) {
    visuals[name].node.quaternion.setFromUnitVectors(PLUS_Z, CARDINAL_NORMAL[name]);
  }
  // The oblique starts as a recognisably tilted plane (horizontal, tipped 35°),
  // then the user manipulates it with a gizmo.
  visuals.oblique.node.quaternion
    .setFromUnitVectors(PLUS_Z, CARDINAL_NORMAL.transverse)
    .multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        THREE.MathUtils.degToRad(35),
      ),
    );

  let obliqueCentred = false;
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _n = new THREE.Vector3();

  return {
    group,
    oblique: visuals.oblique.node,

    setCardinalVisible(name, visible) {
      visuals[name].node.visible = visible;
    },
    setObliqueVisible(visible) {
      visuals.oblique.node.visible = visible;
    },
    setExtents(center, radius) {
      const size = radius * sizeFactor;
      for (const name of ['sagittal', 'frontal', 'transverse'] as CardinalPlaneName[]) {
        visuals[name].node.position.copy(center);
        visuals[name].node.scale.set(size, size, 1);
      }
      const ob = visuals.oblique.node;
      ob.scale.set(size, size, 1);
      if (!obliqueCentred) {
        ob.position.copy(center);
        obliqueCentred = true;
      }
    },
    getClipPlane(name, out = new THREE.Plane()) {
      const node = visuals[name].node;
      node.getWorldPosition(_p);
      node.getWorldQuaternion(_q);
      _n.copy(PLUS_Z).applyQuaternion(_q).normalize();
      return out.setFromNormalAndCoplanarPoint(_n, _p);
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose?.());
      });
      group.parent?.remove(group);
    },
  };
}
