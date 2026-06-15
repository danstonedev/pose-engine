import * as THREE from 'three';

/**
 * Solid cross-section cap for a clipped model — turns the hollow opening left by
 * a clipping plane into a filled slice whose boundary reads as a bright
 * intersection contour (so you can see exactly where the plane cuts the body).
 *
 * Technique (the classic stencil cap, adapted for skinned meshes):
 *   1. Render each source mesh's BACK faces, incrementing the stencil, and its
 *      FRONT faces, decrementing it — both clipped by the same plane. The
 *      stencil ends non-zero exactly where the plane passes through solid.
 *   2. Draw a plane-aligned quad where stencil != 0 (the cap fill), then clear
 *      the stencil for the next frame.
 *
 * Skinned meshes deform via a *shared skeleton*: `mesh.clone()` copies the
 * skeleton + bind matrices by reference, so the stencil clones bend with the
 * pose. We glue each clone's world matrix to its source every frame.
 *
 * The cap is hollow inside (the models have no internal anatomy) — it fills the
 * silhouette of the body at the cut, not organs. See `anatomicalPlanes`.
 */

export interface SectionCapOptions {
  /** Cap fill colour (hex). Default amber. */
  color?: number;
  /** Render order for the stencil pass; the cap quad uses this + 1. Default 2. */
  renderOrder?: number;
}

export interface SectionCap {
  /** Add to the scene. Holds the stencil clones + the cap quad. */
  readonly group: THREE.Group;
  /** Set the world-space clip plane the cap aligns to (copied in). */
  setPlane(plane: THREE.Plane): void;
  setColor(hex: number): void;
  setVisible(visible: boolean): void;
  /** Per-frame: glue stencil clones to their sources + place the cap quad. */
  update(): void;
  dispose(): void;
}

export function createSectionCap(
  sources: THREE.Mesh[],
  size: number,
  opts: SectionCapOptions = {},
): SectionCap {
  const baseOrder = opts.renderOrder ?? 2;
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  const group = new THREE.Group();
  group.name = 'section-cap';

  function stencilMat(side: THREE.Side, op: THREE.StencilOp): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial();
    m.depthWrite = false;
    m.depthTest = false;
    m.colorWrite = false;
    m.stencilWrite = true;
    m.stencilFunc = THREE.AlwaysStencilFunc;
    m.side = side;
    m.clippingPlanes = [plane];
    m.stencilFail = op;
    m.stencilZFail = op;
    m.stencilZPass = op;
    return m;
  }

  // Two stencil clones per source: back faces increment, front faces decrement.
  const clones: { src: THREE.Object3D; clone: THREE.Object3D }[] = [];
  for (const src of sources) {
    const back = src.clone(false);
    back.material = stencilMat(THREE.BackSide, THREE.IncrementWrapStencilOp);
    const front = src.clone(false);
    front.material = stencilMat(THREE.FrontSide, THREE.DecrementWrapStencilOp);
    for (const c of [back, front]) {
      c.renderOrder = baseOrder;
      c.matrixAutoUpdate = false;
      c.matrixWorldAutoUpdate = false;
      c.frustumCulled = false; // world matrix is set manually; skip cull guesswork
      group.add(c);
      clones.push({ src, clone: c });
    }
  }

  // The visible cap fill: drawn where stencil != 0, then resets the stencil.
  const capMat = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffb020,
    metalness: 0.0,
    roughness: 0.85,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  const capQuad = new THREE.Mesh(new THREE.PlaneGeometry(size, size), capMat);
  capQuad.renderOrder = baseOrder + 1;
  capQuad.frustumCulled = false;
  capQuad.onAfterRender = (renderer) => renderer.clearStencil();
  group.add(capQuad);

  const _z = new THREE.Vector3(0, 0, 1);
  const _q = new THREE.Quaternion();
  const _pt = new THREE.Vector3();

  return {
    group,
    setPlane(p) {
      plane.copy(p);
    },
    setColor(hex) {
      capMat.color.setHex(hex);
    },
    setVisible(visible) {
      group.visible = visible;
    },
    update() {
      for (const { src, clone } of clones) {
        src.updateWorldMatrix(true, false);
        clone.matrixWorld.copy(src.matrixWorld);
      }
      _q.setFromUnitVectors(_z, plane.normal);
      capQuad.quaternion.copy(_q);
      plane.coplanarPoint(_pt);
      capQuad.position.copy(_pt);
      capQuad.updateMatrix();
      capQuad.updateMatrixWorld(true);
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose?.());
      });
      capQuad.geometry.dispose();
      group.parent?.remove(group);
    },
  };
}
