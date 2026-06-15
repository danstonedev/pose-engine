import * as THREE from 'three';

/**
 * Shared pose rotate-ring gizmo (gold standard, used by every app).
 *
 * three.js TransformControls draws each X/Y/Z rotate ring as a camera-facing
 * 180° half-arc and grabs it with a flaky near/far picker. This replaces those
 * with a self-managed overlay:
 *
 *  - Full **tube rings** (real 3D tori) in the TRUE rotation planes, with baked
 *    rim shading (bright outer rim, near-black inner rim) so each reads as a
 *    rounded tube; white nodes at the 6 ring crossings; a centre dot at the joint.
 *  - **Grab anywhere** on a ring → rotate that axis by the angle the cursor
 *    sweeps around the joint centre (the "E-ring" control model): grab-anywhere,
 *    consistent direction, no near/far inversion. The grab band coincides with
 *    the drawn ring.
 *  - Rendered in a depth-cleared overlay pass so the rings, nodes and centre dot
 *    depth-test against EACH OTHER (the nearer segment wins) yet always draw over
 *    the body/water.
 *
 * Pair this with `removeGizmoHandles(helper, ['XYZE','X','Y','Z'])` on the
 * TransformControls helper so three keeps only its 'E' camera-space ring and we
 * own the X/Y/Z rings here. The gizmo `size` MUST match `tc.size` so the rings
 * line up with three's kept E ring.
 */

export interface PoseRotateRingsOptions {
  /** Screen-constant size; MUST match the TransformControls gizmo size. Default 0.675. */
  size?: number;
  /** Visible ring tube radius (unit-ring space). Default 0.042. */
  tube?: number;
  /** Invisible grab-band tube radius (unit-ring space). Default 0.09. */
  grabTube?: number;
  /** Crossing-node sphere radius (unit-ring space). Default 0.075. */
  nodeRadius?: number;
  /** Selected-joint centre dot radius (unit-ring space). Default 0.12. */
  centerDotRadius?: number;
  /** X/Y/Z ring colours. Default red / green / blue (matching TC). */
  axisColors?: readonly [number, number, number];
  /** Centre dot colour. Default cyan 0x4dd5ff. */
  centerColor?: number;
  /** Ring inner-rim brightness (0 = black). Default 0.05. */
  innerShade?: number;
  /** Ring outer-rim brightness (>1 brightens, clamped on display). Default 1.4. */
  outerShade?: number;
}

interface ResolvedOptions {
  size: number;
  tube: number;
  grabTube: number;
  nodeRadius: number;
  centerDotRadius: number;
  axisColors: readonly [number, number, number];
  centerColor: number;
  innerShade: number;
  outerShade: number;
}

const DEFAULTS: ResolvedOptions = {
  size: 0.675,
  tube: 0.042,
  grabTube: 0.09,
  nodeRadius: 0.075,
  centerDotRadius: 0.12,
  axisColors: [0xff3653, 0x8adb00, 0x2c8fff],
  centerColor: 0x4dd5ff,
  innerShade: 0.05,
  outerShade: 1.4,
};

type RingAxisName = 'X' | 'Y' | 'Z';
const AXIS_NAMES: readonly RingAxisName[] = ['X', 'Y', 'Z'];

/** Bake per-vertex brightness into a torus so its OUTER rim is bright and its
 *  INNER rim (toward the ring centre) is dark — gives the flat circle a rounded,
 *  3D-tube read. View-independent, so no per-frame cost. */
function shadeTorusOuterRim(geo: THREE.TorusGeometry, tube: number, inner: number, outer: number): void {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // Distance from the ring's central axis (Z): 1+tube outer rim, 1−tube inner.
    const d = Math.hypot(pos.getX(i), pos.getY(i));
    const t = THREE.MathUtils.clamp((d - (1 - tube)) / (2 * tube), 0, 1);
    const b = THREE.MathUtils.lerp(inner, outer, t);
    colors[i * 3] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Shade a pole node (already translated to its unit-sphere position): vertices
 *  farther from the ring centre are bright, nearer ones dark — same read as the
 *  rings. */
function shadeSphereOuter(geo: THREE.SphereGeometry, nodeR: number): void {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const d = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)); // ~1 ± nodeR
    const t = THREE.MathUtils.clamp((d - (1 - nodeR)) / (2 * nodeR), 0, 1);
    const b = THREE.MathUtils.lerp(0.35, 1.6, t); // inner gray → outer white
    colors[i * 3] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * A live swept-angle ring rotation. Feed it the current pointer ray each move; it
 * returns the bone's new LOCAL quaternion. Grab-anywhere, no near/far inversion.
 */
export interface PoseRingDrag {
  readonly axis: RingAxisName;
  /** Returns the bone's new local quaternion for the current pointer ray. */
  update(raycaster: THREE.Raycaster): THREE.Quaternion;
}

class RingDragImpl implements PoseRingDrag {
  private prevAngle: number;
  private total = 0;
  private readonly _plane = new THREE.Plane();
  private readonly _hit = new THREE.Vector3();
  private readonly _qa = new THREE.Quaternion();
  private readonly _result = new THREE.Quaternion();

  constructor(
    readonly axis: RingAxisName,
    private readonly axisW: THREE.Vector3,
    private readonly center: THREE.Vector3,
    private readonly u: THREE.Vector3,
    private readonly v: THREE.Vector3,
    angle0: number,
    private readonly q0: THREE.Quaternion,
    private readonly parentW: THREE.Quaternion,
    private readonly parentWInv: THREE.Quaternion,
  ) {
    this.prevAngle = angle0;
    this._result.copy(q0);
  }

  update(raycaster: THREE.Raycaster): THREE.Quaternion {
    this._plane.setFromNormalAndCoplanarPoint(this.axisW, this.center);
    if (raycaster.ray.intersectPlane(this._plane, this._hit)) {
      this._hit.sub(this.center);
      const angle = Math.atan2(this._hit.dot(this.v), this._hit.dot(this.u));
      let step = angle - this.prevAngle;
      while (step > Math.PI) step -= 2 * Math.PI;
      while (step < -Math.PI) step += 2 * Math.PI;
      this.total += step;
      this.prevAngle = angle;
    }
    // newLocal = parentWInv · axisAngle(axisW, total) · parentW · q0
    this._qa.setFromAxisAngle(this.axisW, this.total);
    this._result.copy(this.parentWInv).multiply(this._qa).multiply(this.parentW).multiply(this.q0);
    return this._result;
  }
}

/** Inputs to begin a swept-angle ring drag (all in world space except the bone
 *  quaternions, which are the bone's current LOCAL quat and its parent's WORLD quat). */
export interface PoseRingDragParams {
  centerWorld: THREE.Vector3;
  frameQuat: THREE.Quaternion;
  boneLocalQuat: THREE.Quaternion;
  parentWorldQuat: THREE.Quaternion;
}

export class PoseRotateRingGizmo {
  /** Separate scene rendered in a depth-cleared overlay pass (see `render`). */
  readonly overlayScene = new THREE.Scene();
  /** The ring/node/dot group (positioned/oriented/scaled each frame by `update`). */
  readonly group = new THREE.Group();
  /** Invisible grab bands, one per axis — raycast targets for `beginDrag`. */
  readonly pickers: { axis: THREE.Vector3; name: RingAxisName; mesh: THREE.Mesh }[] = [];

  private readonly opt: ResolvedOptions;
  /** Visible ring meshes/materials by lowercase axis, with their default colour,
   *  so the host can recolour rings by plane-of-motion per joint (see
   *  `setRingColors`) and hide individual rings (see `setHiddenRings`). */
  private readonly ringMats: {
    axis: 'x' | 'y' | 'z';
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    defaultHex: number;
  }[] = [];
  /** Axes whose ring is currently hidden — both invisible and un-grabbable. */
  private hidden = new Set<'x' | 'y' | 'z'>();

  constructor(options: PoseRotateRingsOptions = {}) {
    const o: ResolvedOptions = { ...DEFAULTS, ...options };
    this.opt = o;
    this.group.visible = false;

    const zUnit = new THREE.Vector3(0, 0, 1);
    const axisVecs: Record<RingAxisName, THREE.Vector3> = {
      X: new THREE.Vector3(1, 0, 0),
      Y: new THREE.Vector3(0, 1, 0),
      Z: new THREE.Vector3(0, 0, 1),
    };

    AXIS_NAMES.forEach((name, i) => {
      const axis = axisVecs[name];
      const q = new THREE.Quaternion().setFromUnitVectors(zUnit, axis); // normal Z → axis
      const geo = new THREE.TorusGeometry(1, o.tube, 12, 120);
      shadeTorusOuterRim(geo, o.tube, o.innerShade, o.outerShade);
      const ring = new THREE.Mesh(
        geo,
        // Opaque + depth-tested so rings occlude EACH OTHER by true depth.
        new THREE.MeshBasicMaterial({ color: o.axisColors[i], vertexColors: true, depthTest: true, depthWrite: true }),
      );
      ring.renderOrder = 1002;
      ring.quaternion.copy(q);
      this.ringMats.push({
        axis: name.toLowerCase() as 'x' | 'y' | 'z',
        mesh: ring,
        mat: ring.material as THREE.MeshBasicMaterial,
        defaultHex: o.axisColors[i],
      });
      // Invisible fat grab band coinciding with the ring.
      const picker = new THREE.Mesh(
        new THREE.TorusGeometry(1, o.grabTube, 6, 64),
        new THREE.MeshBasicMaterial({ visible: false, depthTest: false }),
      );
      picker.quaternion.copy(q);
      picker.userData.ringAxis = name;
      this.group.add(ring, picker);
      this.pickers.push({ axis: axis.clone(), name, mesh: picker });
    });

    // White/gray nodes at the 6 ring crossings (the ±X/±Y/±Z poles), shaded with
    // the same outer-bright / inner-dark pattern so the 3D ball structure reads.
    const poles: readonly (readonly [number, number, number])[] = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (const [px, py, pz] of poles) {
      const sg = new THREE.SphereGeometry(o.nodeRadius, 16, 12);
      sg.translate(px, py, pz);
      shadeSphereOuter(sg, o.nodeRadius);
      const node = new THREE.Mesh(
        sg,
        new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, depthTest: true, depthWrite: true }),
      );
      node.renderOrder = 1003;
      this.group.add(node);
    }

    // Selected-joint centre dot, in the same overlay pass so it depth-tests with
    // the rings (front rings cover it; it covers the rings behind it).
    const centerDot = new THREE.Mesh(
      new THREE.SphereGeometry(o.centerDotRadius, 20, 14),
      new THREE.MeshBasicMaterial({ color: o.centerColor, depthTest: true, depthWrite: true }),
    );
    centerDot.renderOrder = 1004;
    this.group.add(centerDot);

    this.overlayScene.add(this.group);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Recolour the visible rings by axis. Pass a hex per lowercase axis (x/y/z);
   *  any axis omitted resets to its default colour. Used to colour each ring by
   *  the clinical PLANE of motion it drives (red = flex/sagittal, blue = frontal,
   *  green = transverse) so the gizmo speaks the same colour language per joint. */
  setRingColors(colorByAxis: Partial<Record<'x' | 'y' | 'z', number>>): void {
    for (const r of this.ringMats) {
      r.mat.color.setHex(colorByAxis[r.axis] ?? r.defaultHex);
    }
  }

  /** Hide specific rings (by lowercase axis) — they vanish AND stop accepting
   *  grabs, so the joint exposes fewer DOFs visually. Pass the full set each
   *  call; any axis not listed is shown. Used to drop the wrist's pro/sup (Y)
   *  ring once pro/sup is driven from the elbow. The shared ±pole nodes stay
   *  (they belong to the other rings too). */
  setHiddenRings(axes: readonly ('x' | 'y' | 'z')[]): void {
    this.hidden = new Set(axes);
    for (const r of this.ringMats) r.mesh.visible = !this.hidden.has(r.axis);
  }

  /** Position/orient/scale the rings at a joint. `frameQuat` = the bone's world
   *  quaternion for a local-space gizmo, or identity for a world-space gizmo.
   *  Pass `visible=false` to hide. Call once per frame. */
  update(
    camera: THREE.PerspectiveCamera,
    centerWorld: THREE.Vector3,
    frameQuat: THREE.Quaternion,
    visible: boolean,
  ): void {
    if (!visible) {
      this.group.visible = false;
      return;
    }
    this.group.position.copy(centerWorld);
    this.group.quaternion.copy(frameQuat);
    // three's screen-constant gizmo size: handle.scale = factor*size/4, ring radius 0.5.
    const dist = camera.position.distanceTo(centerWorld);
    const factor = dist * Math.min((1.9 * Math.tan((Math.PI * camera.fov) / 360)) / (camera.zoom || 1), 7);
    this.group.scale.setScalar((factor * this.opt.size) / 8);
    this.group.visible = true;
  }

  /** Hide the rings immediately (e.g. on deselect). */
  hide(): void {
    this.group.visible = false;
  }

  /** Render the overlay pass: clears depth so the rings draw over the body/water,
   *  but lets them depth-test against each other. Call AFTER the main render. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (!this.group.visible) return;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.overlayScene, camera);
    renderer.autoClear = prevAutoClear;
  }

  /** Hit-test the ring grab bands with the given (already camera-set) raycaster.
   *  If a ring is grabbed, returns a live drag; otherwise null. */
  beginDrag(raycaster: THREE.Raycaster, params: PoseRingDragParams): PoseRingDrag | null {
    this.group.updateMatrixWorld(true);
    const grabbable = this.pickers.filter(
      (p) => !this.hidden.has(p.name.toLowerCase() as 'x' | 'y' | 'z'),
    );
    const hit = raycaster.intersectObjects(grabbable.map((p) => p.mesh), false)[0];
    if (!hit) return null;
    const picker = this.pickers.find((p) => p.mesh === hit.object);
    if (!picker) return null;

    const { centerWorld, frameQuat, boneLocalQuat, parentWorldQuat } = params;
    const axisW = picker.axis.clone().applyQuaternion(frameQuat).normalize();
    // In-plane basis perpendicular to the axis (cyclic: X→Y, Y→Z, Z→X).
    const uW = new THREE.Vector3(picker.axis.z, picker.axis.x, picker.axis.y)
      .applyQuaternion(frameQuat)
      .normalize();
    const vW = axisW.clone().cross(uW).normalize();
    const center = centerWorld.clone();

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axisW, center);
    const hitPt = new THREE.Vector3();
    let angle0 = 0;
    if (raycaster.ray.intersectPlane(plane, hitPt)) {
      hitPt.sub(center);
      angle0 = Math.atan2(hitPt.dot(vW), hitPt.dot(uW));
    }
    const parentW = parentWorldQuat.clone();
    return new RingDragImpl(
      picker.name,
      axisW,
      center,
      uW,
      vW,
      angle0,
      boneLocalQuat.clone(),
      parentW,
      parentW.clone().invert(),
    );
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.overlayScene.remove(this.group);
  }
}
