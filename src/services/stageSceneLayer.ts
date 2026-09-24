// OPT-IN host scene layer for ExamStage3D: the one seam through which a host
// adds its own objects to the stage's scene (simLAB's examination props: the
// plinth, the examiner's hands, a goniometer) and keeps them attached to the
// live skeleton. Three-free at module scope — `three` is only type-imported —
// so the stage can import it statically and stay SSR-safe.
//
// The contract mirrors the posing layer's hooks (services/stagePosingLayer):
// the stage builds the context once its scene exists, calls the factory once,
// then drives the returned hooks — `onModelLoaded` after every model (re)load,
// `beforeRender` on every drawn frame once the pose AND every live overlay
// (breathing, sway, eye gaze) are final, `wantsFrame` every loop tick so a
// layer animating on its own clock keeps the dirty-flag loop drawing, and
// `dispose` on teardown. A stage given no layer never calls any of this.
//
// The layer may also steer the camera (`glideView`), smoothly and only until
// the student moves it themselves (`onUserView` says when).
//
// A host layer must never be able to take the patient down with it: every hook
// runs guarded, and the first one to throw retires the whole layer (logged
// once) while the stage keeps rendering the body.

import type * as THREE from 'three';

export interface StageSceneContext {
  /** The stage's own three instance. Build objects with it so they share the scene's class identities. */
  readonly THREE: typeof import('three');
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Draw the next frame (the stage otherwise skips frames in which nothing changed). */
  requestRender(): void;
  /** The loaded model's root; null while a model is loading. */
  readonly modelRoot: THREE.Object3D | null;
  /** The body's skinned mesh (its skeleton drives every pose); null while loading. */
  readonly skinnedMesh: THREE.SkinnedMesh | null;
  /** A bone by canonical pose key ('Hips', 'L_UpLeg', 'R_Foot', …); null while loading or when the rig has none. */
  bone(key: string): THREE.Object3D | null;
  /** World height (m) of the floor the standing body is grounded to; null while loading. */
  readonly floorY: number | null;
  /** Current commanded/recorded support; retained when a recorded frame is paused. */
  readonly groundingPosture?: string | null;
  /** Current rib excursion in metres, driven by the stage's continuous breath clock. */
  readonly breathExpansionM?: number;
  /**
   * Glide the camera to a view of the layer's choosing: the orbit target and
   * the camera position, reached round the target on a damped spring
   * (services/cameraGlide; `smoothTimeS` sets its pace). The student's own
   * camera gestures stop it and keep working as before.
   */
  glideView(target: THREE.Vector3, position: THREE.Vector3, smoothTimeS?: number): void;
  /** Called whenever the student moves the camera themselves; returns an unsubscribe. */
  onUserView(listener: () => void): () => void;
}

export interface StageSceneLayer {
  /** A model finished (re)loading: bones, skinned mesh and floor are available. */
  onModelLoaded?(): void;
  /** Every drawn frame, after the pose and all live overlays are final and before the draw. */
  beforeRender?(): void;
  /** Restore temporary contact/deformation changes after all render passes. */
  afterRender?(): void;
  /** Every loop tick: return true to have the next frame drawn (the layer is animating on its own). */
  wantsFrame?(): boolean;
  /** The stage is being torn down: release everything the layer added to the scene. */
  dispose?(): void;
}

export type StageSceneLayerFactory = (context: StageSceneContext) => StageSceneLayer | void | null;

/** The hooks as the stage drives them: always safe to call, no-ops once the layer has failed or been disposed. */
export interface MountedSceneLayer {
  onModelLoaded(): void;
  beforeRender(): void;
  afterRender(): void;
  wantsFrame(): boolean;
  dispose(): void;
  /** False once a hook has thrown (the layer is retired) or after dispose. */
  readonly active: boolean;
}

/**
 * Call the host's factory and wrap what it returns. A factory or hook that
 * throws retires the layer: its error is logged once, `dispose` is still
 * attempted so whatever it added can be removed, and every later call is a
 * no-op. Returns null when there is no factory (the default stage).
 */
export function mountSceneLayer(
  factory: StageSceneLayerFactory | null | undefined,
  context: StageSceneContext,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): MountedSceneLayer | null {
  if (!factory) return null;
  let layer: StageSceneLayer | null = null;
  let active = true;
  const retire = (where: string, error: unknown) => {
    if (!active) return;
    active = false;
    log(`ExamStage3D: the host scene layer failed in ${where} and was removed; the stage carries on without it.`, error);
    try {
      layer?.dispose?.();
    } catch {
      // Already failing; nothing more to report.
    }
    layer = null;
  };
  try {
    layer = factory(context) ?? null;
  } catch (error) {
    retire('its factory', error);
    return null;
  }
  if (!layer) return null;
  const run = <T>(name: keyof StageSceneLayer, fallback: T, call: (target: StageSceneLayer) => T): T => {
    if (!active || !layer) return fallback;
    try {
      return call(layer);
    } catch (error) {
      retire(name, error);
      return fallback;
    }
  };
  return {
    onModelLoaded: () => run('onModelLoaded', undefined, (target) => target.onModelLoaded?.()),
    beforeRender: () => run('beforeRender', undefined, (target) => target.beforeRender?.()),
    afterRender: () => run('afterRender', undefined, (target) => target.afterRender?.()),
    wantsFrame: () => run('wantsFrame', false, (target) => target.wantsFrame?.() === true),
    dispose: () => {
      if (!active || !layer) return;
      const target = layer;
      active = false;
      layer = null;
      try {
        target.dispose?.();
      } catch (error) {
        log('ExamStage3D: the host scene layer failed while being disposed.', error);
      }
    },
    get active() {
      return active;
    },
  };
}
