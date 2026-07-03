<script lang="ts">
  /**
   * Read-only clinical observation viewer — presents an AUTHORED patient pose
   * (the mission-shell `move.observe` capability, ADR-0018) on the shared
   * mannequin so a learner can observe and record resting joint positions.
   *
   * Boot ORDER is the correctness trap (mirrors PainBody3D's production path):
   * load GLB → scene.add → applyAnatomicPose → captureJointAngleRestReference
   * → gate + applyCustomPose → ground feet → frame camera → computeJointAngles.
   * Capturing the rest reference AFTER anatomic and BEFORE the authored pose is
   * what makes the anatomic position read 0° everywhere (so the report measures
   * only the authored deviation); grounding AFTER posing keeps a posed foot
   * from clipping the floor plane.
   *
   * Authored poses are gated exactly like PainBody3D's customPose load: wrong
   * `variant`, stale `schemaVersion`, or an empty pose is dropped — the viewer
   * calls `onPoseDropped(reason)` and continues with the anatomic baseline, so
   * a bad pose degrades the observation rather than blocking it.
   *
   * Framework notes (same contract as {@link PoseViewer}): three + the
   * three-using services are dynamically imported inside onMount, so importing
   * this component never pulls WebGL into a host's SSR/prerender — and bare
   * 'three' specifiers keep the host on a single three instance. Interaction is
   * read-only: orbit + zoom only (no pan, no pose handles). Theme the backdrop
   * via the `--pv-bg` CSS custom property.
   */
  import { onMount } from 'svelte';
  import { POSE_SCHEMA_VERSION, type CustomPose } from './types';
  import type { JointAngleReport } from './services/jointAngles';

  let {
    variant = 'male',
    base = '',
    modelUrl = '',
    authoredPose = null,
    height = '26rem',
    onReport,
    onPoseDropped,
  }: {
    variant?: string;
    /** Host asset base — models load from `${base}/models/painmap3D_*.runtime.glb`. */
    base?: string;
    /** Direct GLB URL. When non-empty it takes precedence over `base` (hosts
     *  whose bundler resolves model assets itself, e.g. Vite `?url` imports). */
    modelUrl?: string;
    /** Authored patient pose to present; `null` shows the anatomic baseline. */
    authoredPose?: CustomPose | null;
    height?: string;
    /** Fires once per successful load with the engine-computed clinical joint
     *  angles for the presented pose (the truth the host grades against). */
    onReport?: (report: JointAngleReport) => void;
    /** Fires when the authored pose is rejected at load time — 'variant'
     *  (saved against a different rig), 'schema' (stale anatomic baseline),
     *  'empty' (no bone overrides), or 'no-skeleton' (model has no skinned
     *  mesh to pose). The viewer continues with the anatomic baseline. */
    onPoseDropped?: (reason: string) => void;
  } = $props();

  let container: HTMLDivElement;
  let loading = $state(true);
  let loadError = $state('');

  // Imperative handles, wired after the client-only boot completes.
  let ready = $state(false);
  let appliedVariant = $state('');
  let appliedModelUrl = $state('');
  let appliedPose: CustomPose | null = null;
  let reloadFn: (variantId: string, url: string, pose: CustomPose | null) => void = () => {};

  onMount(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // Bare 'three' specifiers only — a second three instance would break the
      // instanceof checks inside the pose services.
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      // Services via relative paths (not the barrel) — the barrel re-exports
      // this component, so importing it here would be circular.
      const { getBodyVariant } = await import('./anatomy/bodyVariants');
      const { createMannequinRenderer, addMannequinLights, loadVariantModel } = await import(
        './services/sceneBoot'
      );
      const { applyAnatomicPose } = await import('./services/anatomicPose');
      const { resolveCameraViewSetpoint } = await import('./services/cameraTween');
      const { applyCustomPose, isCustomPoseEmpty } = await import('./services/poseRig');
      const { captureJointAngleRestReference, computeJointAngles } = await import(
        './services/jointAngles'
      );

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
      controls.enablePan = false; // read-only viewer: orbit + zoom only
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

      /** First SkinnedMesh under `root` — the mesh whose skeleton drives the
       *  rest reference, the authored pose, and the angle report. */
      function findFirstSkinnedMesh(
        root: import('three').Object3D,
      ): import('three').SkinnedMesh | null {
        let found: import('three').SkinnedMesh | null = null;
        root.traverse((child) => {
          const sm = child as import('three').SkinnedMesh;
          if (sm.isSkinnedMesh && !found) found = sm;
        });
        return found;
      }

      async function loadModel(variantId: string, url: string, pose: CustomPose | null) {
        const variantCfg = getBodyVariant(variantId);
        const token = ++loadToken;
        loading = true;
        loadError = '';
        try {
          // 1) Load the GLB. A direct URL takes precedence (host-resolved
          //    asset); otherwise the variant's `${base}/models/…` convention.
          let root: import('three').Object3D;
          let skinned: import('three').SkinnedMesh | null;
          if (url) {
            const gltf = await new GLTFLoader().loadAsync(url);
            root = gltf.scene;
            root.scale.setScalar(variantCfg.pose.rootScale);
            skinned = findFirstSkinnedMesh(root);
          } else {
            const loaded = await loadVariantModel(variantCfg, base);
            root = loaded.root;
            skinned = loaded.skinned;
          }
          if (disposed || token !== loadToken) return;
          disposeModel();
          scene.add(root);
          root.updateMatrixWorld(true);

          // 2) Anatomic baseline — the shared clinical 0° reference every
          //    authored pose is measured against.
          applyAnatomicPose(root, variantCfg);
          root.updateMatrixWorld(true);

          // 3) Capture the rest reference AFTER anatomic and BEFORE the
          //    authored pose, so anatomic reads 0° and the report measures
          //    only the authored deviation.
          const rest = skinned ? captureJointAngleRestReference(skinned.skeleton, variantCfg) : null;

          // 4) Gate + apply the authored pose (PainBody3D's production-proven
          //    load gate). On drop, surface the reason and stay anatomic.
          if (pose) {
            const reason =
              pose.variant !== variantCfg.id
                ? 'variant'
                : pose.schemaVersion !== POSE_SCHEMA_VERSION
                  ? 'schema'
                  : isCustomPoseEmpty(pose)
                    ? 'empty'
                    : !skinned
                      ? 'no-skeleton'
                      : '';
            if (reason) {
              onPoseDropped?.(reason);
            } else if (skinned) {
              applyCustomPose(skinned.skeleton, variantCfg, pose);
              root.updateMatrixWorld(true);
            }
          }

          // 5) Ground the feet AFTER posing — an authored pose (e.g. a
          //    plantar-flexed ankle) shifts the mesh bounds, so grounding
          //    before it could leave the model floating or clipping the floor.
          _box.setFromObject(root);
          root.position.y -= _box.min.y;
          root.updateMatrixWorld(true);

          // 6) Frame the camera head-to-toe on the grounded, posed bounds.
          _box.setFromObject(root);
          _box.getBoundingSphere(_sphere);
          modelCenter.copy(_sphere.center);
          modelRadius = _sphere.radius;
          modelRoot = root;
          frameCamera();

          // 7) Measure the presented pose and hand the report to the host.
          if (skinned && rest) {
            onReport?.(computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, rest));
          }
          loading = false;
          requestRender();
        } catch (err) {
          if (disposed) return;
          console.error('ObservationViewer: failed to load model', err);
          loadError = 'Failed to load the 3D model.';
          loading = false;
        }
      }

      function frameCamera() {
        // Use the front preset only for the viewing DIRECTION; compute the
        // distance + target from the model's bounds so the whole body fits,
        // head to toe, regardless of variant, pose, or container aspect.
        const sp = resolveCameraViewSetpoint('front', false);
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

      let raf = 0;
      const loop = () => {
        raf = requestAnimationFrame(loop);
        controls.update();
        if (!renderNeeded) return;
        renderer.render(scene, camera);
        renderNeeded = false;
      };
      loop();

      const resize = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        requestRender();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(container);
      resize();

      // Wire the teardown BEFORE the first (awaited) model load — an unmount
      // mid-load must still stop the rAF loop and dispose the renderer/controls,
      // not hit the placeholder no-op cleanup.
      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.removeEventListener('change', requestRender);
        disposeModel();
        controls.dispose();
        renderer.dispose();
        if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      };

      await loadModel(variant, modelUrl, authoredPose);
      if (disposed) return;

      reloadFn = (variantId, url, pose) => void loadModel(variantId, url, pose);
      appliedVariant = variant;
      appliedModelUrl = modelUrl;
      appliedPose = authoredPose;
      ready = true;
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  });

  // React to prop changes after the initial boot. Any of the three inputs
  // changes the presented truth, so all trigger a full reload (the rest
  // reference must be recaptured against the fresh anatomic baseline).
  $effect(() => {
    if (!ready) return;
    if (
      variant !== appliedVariant ||
      modelUrl !== appliedModelUrl ||
      authoredPose !== appliedPose
    ) {
      appliedVariant = variant;
      appliedModelUrl = modelUrl;
      appliedPose = authoredPose;
      reloadFn(variant, modelUrl, authoredPose);
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
