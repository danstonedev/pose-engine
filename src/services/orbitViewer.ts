// Shared orbit-viewer boot — the Scene + PerspectiveCamera + OrbitControls +
// dirty-flag render loop + ResizeObserver + WebGL-context-loss handling that
// every VSP 3D app (body-chart's PainBody3D, aquatic-therapy's
// AquaticPoolScene, anatomy-viewer's AnatomyViewerApp) currently re-implements
// inline. Composes with createMannequinRenderer/addMannequinLights from
// ./sceneBoot. Pure THREE — no Svelte; the caller owns model loading and the
// per-frame app logic via the onBeforeRender hook.
//
// This module is ADDITIVE: it introduces new helpers and changes nothing in
// the existing exported surface. Apps adopt it incrementally.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

import { createMannequinRenderer, type MannequinRendererOptions } from './sceneBoot';

/** OrbitControls fields the viewer lets callers override. */
type OrbitControlsOverrides = Partial<
  Pick<
    OrbitControls,
    | 'enableDamping'
    | 'dampingFactor'
    | 'minDistance'
    | 'maxDistance'
    | 'minPolarAngle'
    | 'maxPolarAngle'
    | 'enablePan'
    | 'enableZoom'
    | 'enableRotate'
  >
>;

export interface OrbitViewerOptions extends MannequinRendererOptions {
  /** Vertical FOV in degrees. Default 42 (the value the existing scenes use). */
  fov?: number;
  /** Near plane. Default 0.01. */
  near?: number;
  /** Far plane. Default 100. */
  far?: number;
  /** Initial camera position. Default [0, 1.4, 3.2]. */
  cameraPosition?: THREE.Vector3Tuple;
  /** OrbitControls target. Default [0, 1, 0]. */
  target?: THREE.Vector3Tuple;
  /** Bring your own Scene; otherwise a fresh THREE.Scene is created. */
  scene?: THREE.Scene;
  /** OrbitControls overrides, merged over the shared clinical defaults. */
  controls?: OrbitControlsOverrides;
}

export interface OrbitViewer {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Mark the scene dirty so the loop renders one more frame on the next rAF. */
  requestRender: () => void;
  /**
   * Set a per-frame callback run immediately before each render (animation,
   * physics, gizmo sync, …). Pass null to clear. While a callback is set the
   * loop renders every frame; otherwise it renders only when dirty or while
   * OrbitControls damping is still settling.
   */
  setOnBeforeRender: (cb: ((deltaSeconds: number) => void) | null) => void;
  /** Start the rAF loop (called automatically on creation). */
  start: () => void;
  /** Stop the rAF loop (e.g. when the viewer scrolls out of view). */
  stop: () => void;
  /** Recompute aspect + renderer size from the container. Auto-wired to a ResizeObserver. */
  resize: () => void;
  /** Tear everything down: stop the loop, dispose controls/renderer, remove listeners + canvas. */
  dispose: () => void;
}

const DEFAULT_CONTROLS: Required<
  Pick<
    OrbitControls,
    'enableDamping' | 'dampingFactor' | 'minDistance' | 'maxDistance' | 'minPolarAngle' | 'maxPolarAngle' | 'enablePan'
  >
> = {
  enableDamping: true,
  dampingFactor: 0.08,
  minDistance: 0.8,
  maxDistance: 12,
  minPolarAngle: 0.05,
  maxPolarAngle: Math.PI - 0.05,
  enablePan: true,
};

/**
 * Builds a ready-to-use orbit viewer: renderer (via createMannequinRenderer) +
 * scene + perspective camera + OrbitControls + an efficient dirty-flag render
 * loop that also honours OrbitControls damping, plus ResizeObserver and
 * WebGL-context-loss/restore handling. Returns handles the app drives.
 */
export function createOrbitViewer(opts: OrbitViewerOptions): OrbitViewer {
  const container = opts.container;
  const renderer = createMannequinRenderer(opts);
  const scene = opts.scene ?? new THREE.Scene();

  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 42, width / height, opts.near ?? 0.01, opts.far ?? 100);
  const [cx, cy, cz] = opts.cameraPosition ?? [0, 1.4, 3.2];
  camera.position.set(cx, cy, cz);

  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, DEFAULT_CONTROLS, opts.controls ?? {});
  const [tx, ty, tz] = opts.target ?? [0, 1, 0];
  controls.target.set(tx, ty, tz);
  controls.update();

  const clock = new THREE.Clock();
  let dirty = true;
  let running = false;
  let rafId = 0;
  let onBeforeRender: ((deltaSeconds: number) => void) | null = null;

  const requestRender = () => {
    dirty = true;
  };
  controls.addEventListener('change', requestRender);

  const tick = () => {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    // OrbitControls.update() returns true while damping is still settling.
    const moving = controls.update();
    if (dirty || moving || onBeforeRender) {
      dirty = false;
      const dt = clock.getDelta();
      if (onBeforeRender) onBeforeRender(dt);
      renderer.render(scene, camera);
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    clock.getDelta(); // reset delta so the first frame isn't a huge dt
    rafId = requestAnimationFrame(tick);
  };
  const stop = () => {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  };

  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    dirty = true;
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  const onContextLost = (e: Event) => {
    e.preventDefault();
    stop();
  };
  const onContextRestored = () => {
    dirty = true;
    start();
  };
  renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored, false);

  const dispose = () => {
    stop();
    resizeObserver.disconnect();
    controls.removeEventListener('change', requestRender);
    controls.dispose();
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
    renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
    renderer.dispose();
    renderer.domElement.remove();
  };

  resize();
  start();

  return {
    renderer,
    scene,
    camera,
    controls,
    requestRender,
    setOnBeforeRender: (cb) => {
      onBeforeRender = cb;
      dirty = true;
    },
    start,
    stop,
    resize,
    dispose,
  };
}

export interface PoseTransformControlsOptions {
  camera: THREE.Camera;
  domElement: HTMLElement;
  /** Scene the gizmo helper is added to. */
  scene: THREE.Scene;
  /** OrbitControls to suspend while the gizmo is being dragged. */
  orbit?: OrbitControls;
  /** Gizmo mode. Default 'rotate' (the pose-edit ring). */
  mode?: 'translate' | 'rotate' | 'scale';
  /** Fired on each transform change while dragging (serialize / clamp / recompute angles). */
  onObjectChange?: () => void;
  /** Fired when a drag starts (true) or ends (false). */
  onDraggingChanged?: (dragging: boolean) => void;
}

export interface PoseTransformControlsHandle {
  controls: TransformControls;
  /** The gizmo helper object that must live in the scene graph (three r0.169+). */
  helper: THREE.Object3D;
  attach: (object: THREE.Object3D) => void;
  detach: () => void;
  dispose: () => void;
}

/**
 * Creates a TransformControls wired for the shared pose-edit rotate gizmo:
 * adds its helper to the scene, suspends OrbitControls during a drag, and
 * forwards object-change / dragging-changed to the caller. Mirrors the wiring
 * duplicated in PainBody3D and AquaticPoolScene.
 */
export function createPoseTransformControls(opts: PoseTransformControlsOptions): PoseTransformControlsHandle {
  const tc = new TransformControls(opts.camera, opts.domElement);
  tc.setMode(opts.mode ?? 'rotate');

  // three r0.169+: TransformControls is a Controls, not an Object3D — its
  // visible gizmo comes from getHelper() and must be added to the scene.
  const maybeGetHelper = (tc as unknown as { getHelper?: () => THREE.Object3D }).getHelper;
  const helper: THREE.Object3D =
    typeof maybeGetHelper === 'function' ? maybeGetHelper.call(tc) : (tc as unknown as THREE.Object3D);
  opts.scene.add(helper);

  const onDraggingChanged = (event: { value: boolean }) => {
    const dragging = !!event.value;
    if (opts.orbit) opts.orbit.enabled = !dragging;
    opts.onDraggingChanged?.(dragging);
  };
  const onObjectChange = () => opts.onObjectChange?.();
  // three's event typings are loose here; cast the listeners.
  tc.addEventListener('dragging-changed', onDraggingChanged as unknown as (e: unknown) => void);
  tc.addEventListener('objectChange', onObjectChange as unknown as (e: unknown) => void);

  return {
    controls: tc,
    helper,
    attach: (object) => tc.attach(object),
    detach: () => tc.detach(),
    dispose: () => {
      tc.removeEventListener('dragging-changed', onDraggingChanged as unknown as (e: unknown) => void);
      tc.removeEventListener('objectChange', onObjectChange as unknown as (e: unknown) => void);
      tc.detach();
      helper.parent?.remove(helper);
      tc.dispose();
    },
  };
}

export interface LoadGLTFOptions {
  /**
   * Path to the DRACO decoder directory (e.g. '/draco/'). When set, a
   * DRACOLoader is attached so Draco-compressed meshes (anatomy-viewer's
   * atlas GLBs) decode. Omit for uncompressed models.
   */
  dracoDecoderPath?: string;
  /** Uniform scale applied to gltf.scene after load. Default 1 (unchanged). */
  scale?: number;
}

/**
 * Generic GLTF/GLB loader with optional DRACO support and no skinned-mesh
 * assumption — the counterpart to loadVariantModel for non-body-variant
 * models (e.g. the sectional-anatomy atlas). Returns the raw GLTF; the caller
 * owns insertion and post-processing.
 */
export async function loadGLTFModel(url: string, options: LoadGLTFOptions = {}): Promise<GLTF> {
  const loader = new GLTFLoader();
  let draco: DRACOLoader | undefined;
  if (options.dracoDecoderPath) {
    draco = new DRACOLoader();
    draco.setDecoderPath(options.dracoDecoderPath);
    loader.setDRACOLoader(draco);
  }
  try {
    const gltf = (await loader.loadAsync(url)) as GLTF;
    if (options.scale && options.scale !== 1) gltf.scene.scale.setScalar(options.scale);
    return gltf;
  } finally {
    draco?.dispose();
  }
}
