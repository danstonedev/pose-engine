// Standard scene-boot helpers shared by every VSP 3D app (body-chart's
// PainBody3D, aquatic-therapy's AquaticPoolScene, and any future viewer).
//
// These exist to lock the renderer flags, light rig geometry, and GLTF
// traverse pattern that drifted between apps before extraction. Visual feel
// (light palette, FOV, alpha compositing) stays caller-controlled via the
// option flags.
//
// Pure THREE — no Svelte, no DOM beyond `container.appendChild(canvas)`.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

import type { BodyVariantConfig } from '../anatomy/bodyVariants';

/** Options for {@link createMannequinRenderer}. */
export interface MannequinRendererOptions {
  /** Element the canvas will be appended to. `touchAction` (default
   *  `'none'`) is set on it. */
  container: HTMLElement;
  /**
   * Transparent canvas (pain-map mannequin composites over page background).
   * Defaults to `false` (opaque scenes like the aquatic pool that own their own background).
   */
  alpha?: boolean;
  /** className applied to the created canvas. */
  className?: string;
  /**
   * DPR ceiling. Default `2` — higher values OOM on integrated GPUs at 4K and only marginally
   * improve perceived sharpness on a 1× DPI clinical monitor.
   */
  maxPixelRatio?: number;
  /**
   * CSS `touch-action` applied to the canvas AND its container. Default
   * `'none'` (every touch is a 3D/paint gesture — the historical behavior).
   * Cooperative-gesture embedders pass `'pan-y'` so one-finger vertical
   * swipes scroll the page; viewers that use createClinicalCameraControls
   * with `allowPageScrollOnMiss` get this override applied for them on
   * coarse pointers and can leave the default here.
   */
  touchAction?: string;
}

/**
 * WebGLRenderer with the renderer flags every VSP 3D scene uses:
 * antialias on, `powerPreference: 'high-performance'`, sRGB output color
 * space, DPR capped at 2, and `touch-action` (default `none`, so browser
 * gesture preemption never eats a stroke; configurable for cooperative
 * touch hosts) on both the canvas and its container.
 */
export function createMannequinRenderer(opts: MannequinRendererOptions): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: opts.alpha ?? false,
    powerPreference: 'high-performance',
  });
  const cap = opts.maxPixelRatio ?? 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (opts.className) renderer.domElement.className = opts.className;
  const touchAction = opts.touchAction ?? 'none';
  renderer.domElement.style.touchAction = touchAction;
  opts.container.style.touchAction = touchAction;
  opts.container.appendChild(renderer.domElement);
  return renderer;
}

/**
 * Built-in palettes for the standard 4-light mannequin rig. Both keep the
 * same light *positions* — only color/intensity differ — so a model looks
 * proportionally lit in either context.
 */
export type LightPalette = 'clinical' | 'underwater';

interface LightPaletteConfig {
  ambient: { color: string; intensity: number };
  hemisphere: { sky: string; ground: string; intensity: number };
  key: { color: string; intensity: number };
  fill: { color: string; intensity: number };
}

const LIGHT_PALETTES: Record<LightPalette, LightPaletteConfig> = {
  clinical: {
    ambient: { color: '#ffffff', intensity: 1.32 },
    hemisphere: { sky: '#f7fbfb', ground: '#60716a', intensity: 1.05 },
    key: { color: '#ffffff', intensity: 1.7 },
    fill: { color: '#d8e4de', intensity: 0.82 },
  },
  underwater: {
    ambient: { color: '#ffffff', intensity: 1.1 },
    hemisphere: { sky: '#cfe9ff', ground: '#24506a', intensity: 0.9 },
    key: { color: '#ffffff', intensity: 1.5 },
    fill: { color: '#bcd8ec', intensity: 0.7 },
  },
};

/**
 * Adds the standard 4-light rig (ambient + hemisphere + key + fill) used by
 * every VSP 3D scene. Key at `(2.4, 4.2, 3.1)`, fill at `(-2.2, 2.1, -2)`.
 *
 * Returns the four lights for callers that need to dispose them on teardown
 * or animate intensity (e.g. day/night cycling).
 */
export interface MannequinLightRig {
  ambient: THREE.AmbientLight;
  hemisphere: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
}

export function addMannequinLights(
  scene: THREE.Scene,
  palette: LightPalette = 'clinical',
): MannequinLightRig {
  const cfg = LIGHT_PALETTES[palette];
  const ambient = new THREE.AmbientLight(cfg.ambient.color, cfg.ambient.intensity);
  const hemisphere = new THREE.HemisphereLight(
    cfg.hemisphere.sky,
    cfg.hemisphere.ground,
    cfg.hemisphere.intensity,
  );
  const key = new THREE.DirectionalLight(cfg.key.color, cfg.key.intensity);
  key.position.set(2.4, 4.2, 3.1);
  const fill = new THREE.DirectionalLight(cfg.fill.color, cfg.fill.intensity);
  fill.position.set(-2.2, 2.1, -2);
  scene.add(ambient, hemisphere, key, fill);
  return { ambient, hemisphere, key, fill };
}

/** Result of {@link loadVariantModel}. */
export interface LoadedVariantModel {
  /** Raw GLTF result for callers that need animations or other top-level fields. */
  gltf: GLTF;
  /** `gltf.scene`, already scaled by `variant.pose.rootScale`. */
  root: THREE.Object3D;
  /** First SkinnedMesh found (drives skeleton/IK/pose); `null` for non-skinned variants. */
  skinned: THREE.SkinnedMesh | null;
  /** All SkinnedMeshes (multi-primitive variants — split skin tiles + accessory meshes). */
  allSkinned: THREE.SkinnedMesh[];
  /**
   * Subset of `allSkinned` whose primary material name matches `/skin/i`
   * (the CC body-skin primitives). Used by callers that need to compute
   * displacement volumes or apply only to body skin.
   */
  skinTiles: THREE.SkinnedMesh[];
}

/**
 * Loads a body-variant GLB and locates its primary SkinnedMesh.
 *
 * Centralises the GLTFLoader + traverse pattern duplicated across apps.
 * Callers are responsible for app-specific post-processing — material
 * replacement, paint atlas UV remap, anatomic-pose application, scene
 * insertion, and `serializeCustomPose(...)` capture — because those vary
 * between consumers.
 */
export async function loadVariantModel(
  variant: BodyVariantConfig,
  base: string,
): Promise<LoadedVariantModel> {
  const url = variant.modelUrl(base);
  // Runtime mannequin GLBs are EXT_meshopt_compression-encoded; the decoder is
  // backward-compatible (uncompressed GLBs still load with it registered).
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = (await loader.loadAsync(url)) as GLTF;
  const root = gltf.scene;
  root.scale.setScalar(variant.pose.rootScale);

  let skinned: THREE.SkinnedMesh | null = null;
  const allSkinned: THREE.SkinnedMesh[] = [];
  const skinTiles: THREE.SkinnedMesh[] = [];
  root.traverse((child) => {
    const sm = child as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) return;
    allSkinned.push(sm);
    if (!skinned) skinned = sm;
    const mat = sm.material as THREE.Material | THREE.Material[];
    const matName = (Array.isArray(mat) ? mat[0]?.name : mat?.name) ?? '';
    if (/skin/i.test(matName)) skinTiles.push(sm);
  });

  return { gltf, root, skinned, allSkinned, skinTiles };
}
