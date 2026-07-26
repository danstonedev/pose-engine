/**
 * WebGL lifecycle helpers — context-loss recovery and complete resource disposal.
 *
 * Two gaps these close, both found by audit:
 *
 * 1. CONTEXT LOSS. A browser can take the WebGL context away at any time — GPU reset,
 *    driver update, too many live contexts, tab backgrounded on a memory-pressured
 *    device. The default behaviour is that the canvas goes black permanently and the
 *    render loop keeps burning frames against a dead context. Recovering requires
 *    calling `preventDefault()` on the lost event (without it the browser will not
 *    fire `webglcontextrestored` at all), parking the loop, and restarting on restore.
 *    Before this module, `webglcontextlost` appeared exactly once in the whole
 *    package — inside orbitViewer.ts, which nothing imports.
 *
 * 2. TEXTURE LEAKS. The usual dispose traverse walks geometry and materials, which is
 *    what every component here did. Disposing a material does NOT free the textures it
 *    references; those hold GPU memory until explicitly disposed. On a viewer that
 *    swaps body variants repeatedly, that accumulates.
 *
 * Deliberately three-free at runtime: types come in via `import type` (erased at
 * build) and the traversal is structural. That matters — these are needed during
 * render, so components import them statically, and a runtime `three` import here
 * would re-break the lazy-three contract that ExamStage3D, PoseViewer and
 * ObservationViewer document.
 */

import type { Material, Object3D } from 'three';

/** Anything disposable, without asserting it is a three type. */
interface Disposable {
  dispose?: () => void;
}

/**
 * Wire WebGL context-loss recovery onto a renderer's canvas.
 *
 * `onLost` should park the render loop; `onRestored` should mark the scene dirty and
 * restart it. The caller owns its own loop, so this does not assume one.
 *
 * Returns a detach function — call it from the component's cleanup.
 */
export function attachContextLossRecovery(
  canvas: HTMLCanvasElement,
  handlers: { onLost: () => void; onRestored: () => void },
): () => void {
  const onLost = (event: Event) => {
    // Required: without preventDefault the browser never fires webglcontextrestored,
    // so the canvas is dead for good.
    event.preventDefault();
    handlers.onLost();
  };
  const onRestored = () => handlers.onRestored();

  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  return () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
  };
}

/** True for a three Texture, tested structurally so this module stays three-free. */
function isTexture(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: boolean }).isTexture === true &&
    typeof (value as Disposable).dispose === 'function'
  );
}

/** Dispose every texture a material references (map, normalMap, roughnessMap, …). */
function disposeMaterialTextures(material: Material): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (isTexture(value)) value.dispose?.();
  }
}

/**
 * Dispose an entire Object3D subtree: geometries, materials and — unlike the usual
 * traverse — the textures those materials hold.
 *
 * Pass `{ textures: false }` where a texture is shared with something still on screen
 * and must outlive the subtree.
 */
export function disposeObject3DTree(
  root: Object3D | null | undefined,
  opts: { textures?: boolean } = {},
): void {
  if (!root) return;
  const disposeTextures = opts.textures !== false;

  root.traverse((node: Object3D) => {
    const mesh = node as unknown as {
      geometry?: Disposable;
      material?: Material | Material[];
    };

    mesh.geometry?.dispose?.();

    const material = mesh.material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      if (!m) continue;
      if (disposeTextures) disposeMaterialTextures(m);
      (m as unknown as Disposable).dispose?.();
    }
  });
}
