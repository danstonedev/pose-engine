<script lang="ts">
  /**
   * Reusable clinical mannequin viewer — the shared "body-chart look" 3D model.
   * Boots a pose-engine scene (createMannequinRenderer + clinical lights +
   * loadVariantModel + applyAnatomicPose) into a container and adds orbit
   * controls.
   *
   * Framework-agnostic: pass `base` (the host's asset base URL — models load from
   * `${base}/models/painmap3D_*.runtime.glb`). three + the three-using scene
   * helpers are dynamically imported inside onMount, so importing this component
   * never pulls WebGL into a host's SSR/prerender.
   *
   * Theme the backdrop via the `--pv-bg` CSS custom property (default: a dark
   * neutral studio vignette tuned for the light clinical model).
   */
  import { onMount } from 'svelte';

  type ViewName = 'front' | 'back' | 'left' | 'right';

  let {
    variant = 'male',
    view = 'front',
    base = '',
    height = '26rem',
  }: { variant?: string; view?: ViewName; base?: string; height?: string } = $props();

  let container: HTMLDivElement;
  let loading = $state(true);
  let loadError = $state('');

  // Imperative handles, wired after the client-only boot completes.
  let ready = $state(false);
  let appliedVariant = $state('');
  let appliedView = $state('');
  let setViewFn: (v: ViewName) => void = () => {};
  let loadVariantFn: (id: string) => void = () => {};

  onMount(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      const { getBodyVariant } = await import('./anatomy/bodyVariants');
      const { createMannequinRenderer, addMannequinLights, loadVariantModel } = await import(
        './services/sceneBoot'
      );
      const { applyAnatomicPose } = await import('./services/anatomicPose');
      const { resolveCameraViewSetpoint } = await import('./services/cameraTween');

      if (disposed || !container) return;

      const scene = new THREE.Scene();
      scene.background = null; // transparent → the CSS backdrop shows through
      const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
      const renderer = createMannequinRenderer({ container, alpha: true });
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.minDistance = 1.2;
      controls.maxDistance = 6;
      controls.maxPolarAngle = Math.PI * 0.92;

      addMannequinLights(scene, 'clinical');

      let renderNeeded = true;
      const requestRender = () => {
        renderNeeded = true;
      };
      controls.addEventListener('change', requestRender);

      const _box = new THREE.Box3();
      const _sphere = new THREE.Sphere();
      const modelCenter = new THREE.Vector3();
      let modelRadius = 1;
      let modelRoot: import('three').Object3D | null = null;
      let loadToken = 0;

      function disposeModel() {
        if (!modelRoot) return;
        scene.remove(modelRoot);
        modelRoot.traverse((o) => {
          const mesh = o as import('three').Mesh;
          mesh.geometry?.dispose?.();
          const mat = mesh.material as
            | import('three').Material
            | import('three').Material[]
            | undefined;
          if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose?.());
        });
        modelRoot = null;
      }

      async function loadVariant(id: string) {
        const variantCfg = getBodyVariant(id);
        const token = ++loadToken;
        loading = true;
        loadError = '';
        try {
          const { root } = await loadVariantModel(variantCfg, base);
          if (disposed || token !== loadToken) return;
          disposeModel();
          scene.add(root);
          root.updateMatrixWorld(true);
          applyAnatomicPose(root, variantCfg); // shared clinical standing baseline
          root.updateMatrixWorld(true);
          _box.setFromObject(root);
          root.position.y -= _box.min.y; // ground the feet at y = 0
          root.updateMatrixWorld(true);
          // Capture the grounded bounds so the camera can frame head-to-toe.
          _box.setFromObject(root);
          _box.getBoundingSphere(_sphere);
          modelCenter.copy(_sphere.center);
          modelRadius = _sphere.radius;
          modelRoot = root;
          loading = false;
          setView(view); // frame the freshly-loaded model
          requestRender();
        } catch (err) {
          if (disposed) return;
          console.error('PoseViewer: failed to load model', err);
          loadError = 'Failed to load the 3D model.';
          loading = false;
        }
      }

      function setView(v: ViewName) {
        // Use the preset only for the viewing DIRECTION; compute the distance +
        // target from the model's bounds so the whole body fits, head to toe,
        // regardless of variant, view, or container aspect.
        const sp = resolveCameraViewSetpoint(v, false);
        const dir = new THREE.Vector3(
          sp.position[0] - sp.target[0],
          sp.position[1] - sp.target[1],
          sp.position[2] - sp.target[2],
        ).normalize();
        const fov = (camera.fov * Math.PI) / 180;
        const dist = (modelRadius / Math.sin(fov / 2)) * 1.1; // +10% padding
        controls.target.copy(modelCenter);
        camera.position.copy(modelCenter).addScaledVector(dir, dist);
        controls.update();
        requestRender();
      }

      // Hosts display:none this viewer during overlays, and rAF keeps firing
      // for display:none elements — a hidden stage used to burn a 60Hz loop +
      // controls.update() forever. Park the loop (no reschedule) when the
      // container is hidden (offsetParent === null); the ResizeObserver fires
      // with real dimensions when it is shown again and restarts the loop.
      let raf = 0;
      let loopRunning = false;
      const loop = () => {
        if (container.offsetParent === null) {
          loopRunning = false;
          return; // parked — startLoop() (via the ResizeObserver) resumes
        }
        raf = requestAnimationFrame(loop);
        controls.update();
        if (!renderNeeded) return;
        renderer.render(scene, camera);
        renderNeeded = false;
      };
      const startLoop = () => {
        if (loopRunning) return;
        loopRunning = true;
        raf = requestAnimationFrame(loop);
      };
      startLoop();

      const resize = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        requestRender();
        startLoop(); // restart the parked loop when the stage becomes visible
      };
      const ro = new ResizeObserver(resize);
      ro.observe(container);
      resize();

      await loadVariant(variant);

      setViewFn = setView;
      loadVariantFn = (id) => void loadVariant(id);
      appliedVariant = variant;
      appliedView = view;
      ready = true;

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.removeEventListener('change', requestRender);
        disposeModel();
        controls.dispose();
        renderer.dispose();
        if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  });

  // React to prop changes after the initial boot.
  $effect(() => {
    if (!ready) return;
    if (variant !== appliedVariant) {
      appliedVariant = variant;
      loadVariantFn(variant);
    }
    if (view !== appliedView) {
      appliedView = view;
      setViewFn(view);
    }
  });
</script>

<div class="pose-viewer" style="height: {height};">
  <div class="pose-viewer__canvas" bind:this={container}></div>
  {#if loading}<div class="pose-viewer__status">Loading 3D model…</div>{/if}
  {#if loadError}<div class="pose-viewer__status pose-viewer__status--err">{loadError}</div>{/if}
</div>

<style>
  .pose-viewer {
    position: relative;
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: var(
      --pv-bg,
      radial-gradient(circle at 50% 40%, #323a3e 0%, #1d2326 58%, #11161a 100%)
    );
  }
  .pose-viewer__canvas {
    position: absolute;
    inset: 0;
  }
  .pose-viewer__status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.82rem;
    pointer-events: none;
  }
  .pose-viewer__status--err {
    color: #ff9a9a;
  }
</style>
