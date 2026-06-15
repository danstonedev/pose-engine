import * as THREE from 'three';

/**
 * Solid cross-section cap for a clipped model — turns the hollow opening left by
 * a clipping plane into a filled slice whose boundary reads as a bright
 * intersection contour, so you can see where the plane cuts the body.
 *
 * Caps are built PER SOURCE MESH, each coloured from its own material. On a
 * single hollow shell (the pose mannequin) that's one silhouette fill; on a
 * layered anatomy model (bone / muscle / vessel / nerve meshes) every tissue
 * caps in its own colour — a true colour cross-section. The models are still
 * hollow per-mesh, so a cap fills each structure's outline at the cut, not
 * sub-structure. See `anatomicalPlanes`.
 *
 * Technique (the classic stencil cap, adapted for skinned meshes + per mesh):
 *   For each source, render BACK faces incrementing the stencil and FRONT faces
 *   decrementing it (both clipped by the plane); the stencil is non-zero where
 *   the plane passes through that solid. Draw a plane-aligned quad where stencil
 *   != 0 (coloured as the source), then clear the stencil before the next mesh.
 *   Strictly increasing renderOrder sequences each mesh's stencil→cap→clear.
 *
 * Skinned meshes deform via a shared skeleton (`mesh.clone()` copies the
 * skeleton + bind matrices by reference); we glue each clone's world matrix to
 * its source every frame.
 */

export interface SectionCapOptions {
  /** Render order for the first mesh's stencil pass; each mesh uses +2. Default 2. */
  renderOrder?: number;
  /** Cap colour when a source material exposes no usable colour. Default amber. */
  defaultColor?: number;
}

export interface SectionCap {
  /** Add to the scene. Holds every mesh's stencil clones + cap quad. */
  readonly group: THREE.Group;
  /** Set the world-space clip plane the caps align to (copied in). */
  setPlane(plane: THREE.Plane): void;
  /** Force a single colour on every cap (e.g. a demo on a hollow shell). Pass
   *  null to restore each cap to its source material's colour. */
  setColor(hex: number | null): void;
  setVisible(visible: boolean): void;
  /** Per-frame: glue stencil clones to their sources + place the cap quads. */
  update(): void;
  dispose(): void;
}

function readColor(mesh: THREE.Mesh, fallback: number): number {
  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | (THREE.Material & { color?: THREE.Color })
    | undefined;
  return mat?.color ? mat.color.getHex() : fallback;
}

export function createSectionCap(
  sources: THREE.Mesh[],
  size: number,
  opts: SectionCapOptions = {},
): SectionCap {
  const baseOrder = opts.renderOrder ?? 2;
  const fallback = opts.defaultColor ?? 0xffb020;
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  const group = new THREE.Group();
  group.name = 'section-cap';
  const capGeo = new THREE.PlaneGeometry(size, size);

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

  interface Entry {
    clones: THREE.Object3D[];
    sources: THREE.Object3D[];
    capQuad: THREE.Mesh;
    capMat: THREE.MeshStandardMaterial;
    srcColor: number;
  }
  const entries: Entry[] = [];
  let order = baseOrder;
  for (const src of sources) {
    const back = src.clone(false);
    back.material = stencilMat(THREE.BackSide, THREE.IncrementWrapStencilOp);
    const front = src.clone(false);
    front.material = stencilMat(THREE.FrontSide, THREE.DecrementWrapStencilOp);
    for (const c of [back, front]) {
      c.renderOrder = order;
      c.matrixAutoUpdate = false;
      c.matrixWorldAutoUpdate = false;
      c.frustumCulled = false;
      group.add(c);
    }

    const srcColor = readColor(src, fallback);
    const capMat = new THREE.MeshStandardMaterial({
      color: srcColor,
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
    const capQuad = new THREE.Mesh(capGeo, capMat);
    capQuad.renderOrder = order + 1;
    capQuad.frustumCulled = false;
    capQuad.onAfterRender = (renderer) => renderer.clearStencil();
    group.add(capQuad);

    entries.push({ clones: [back, front], sources: [src, src], capQuad, capMat, srcColor });
    order += 2;
  }

  const _z = new THREE.Vector3(0, 0, 1);
  const _q = new THREE.Quaternion();
  const _pt = new THREE.Vector3();

  return {
    group,
    setPlane(p) {
      plane.copy(p);
    },
    setColor(hex) {
      for (const e of entries) e.capMat.color.setHex(hex ?? e.srcColor);
    },
    setVisible(visible) {
      group.visible = visible;
    },
    update() {
      _q.setFromUnitVectors(_z, plane.normal);
      plane.coplanarPoint(_pt);
      for (const e of entries) {
        for (let i = 0; i < e.clones.length; i++) {
          e.sources[i].updateWorldMatrix(true, false);
          e.clones[i].matrixWorld.copy(e.sources[i].matrixWorld);
        }
        e.capQuad.quaternion.copy(_q);
        e.capQuad.position.copy(_pt);
        e.capQuad.updateMatrix();
        e.capQuad.updateMatrixWorld(true);
      }
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose?.());
      });
      capGeo.dispose();
      group.parent?.remove(group);
    },
  };
}
