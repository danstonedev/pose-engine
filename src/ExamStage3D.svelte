<script lang="ts">
  /**
   * Interactive exam stage — the imperative, ROM-clamped movement-command
   * surface for simLAB encounters (voice-3D A0). Additive sibling of
   * {@link ObservationViewer}: the same boot order (anatomic pose FIRST,
   * then rest-reference capture, then the authored/antalgic pose), the same
   * authored-pose load gate, the same hidden-loop parking — PLUS an exported
   * imperative method `applyMovementCommand(cmd)` that tweens the patient
   * to a ROM-clamped target and answers with what the simulated patient
   * actually did (measured, not assumed).
   *
   * Command flow per `applyMovementCommand`:
   *   resolveCommandTarget (registry ∩ scenario constraints; may refuse) →
   *   buildCommandPose (target CustomPose from the anatomic-rest locals) →
   *   ~600 ms tween via blendCustomPoseWithBaseline INSIDE the existing rAF
   *   loop (no second loop; requestRender-driven) → on settle,
   *   computeJointAngles re-MEASURES the achieved angle and the promise
   *   resolves with the outcome. Commands are serialized (a second command
   *   awaits the first settle) so outcomes always describe a settled pose.
   *
   * ROM enforcement happens at the RESOLVE step (normative range ∩ scenario
   * `availableRange`), not via `clampBoneToRom` on the settled bone: the
   * bone-level clamp's per-joint canonical-frame calibration is not yet
   * verified against the real rig (it ships browser-default-OFF for exactly
   * that reason), and on the current rig it would fight a correct knee
   * flexion. The command targets are constructed pre-clamped, so nothing
   * out-of-range is ever applied.
   *
   * Scenario constraints (`romConstraints` prop) are installed via
   * setRomScenarioConstraints on every load + prop change and cleared on
   * destroy — display-side data the host already holds; nothing is fetched.
   *
   * Framework notes (same contract as {@link PoseViewer}): three + the
   * three-using services are dynamically imported inside onMount so
   * importing this component never pulls WebGL into a host's SSR/prerender;
   * bare 'three' specifiers keep the host on a single three instance.
   * Interaction is read-only (orbit + zoom). Theme via `--pv-bg`.
   */
  import { onMount } from 'svelte';
  import { POSE_SCHEMA_VERSION, type CustomPose } from './types';
  import type { JointAngleReport } from './services/jointAngles';
  // romConstraints is three-free (pure registry math) — static import stays
  // SSR-safe and lets the constraint store install/clear synchronously.
  import {
    clearRomScenarioConstraints,
    setRomScenarioConstraints,
    type RomScenarioConstraints,
  } from './services/romConstraints';
  import type { ExamMovementCommand, ExamMovementOutcome } from './services/movementCommand';

  let {
    variant = 'male',
    base = '',
    modelUrl = '',
    authoredPose = null,
    romConstraints = null,
    height = '26rem',
    onReport,
    onPoseDropped,
  }: {
    variant?: string;
    /** Host asset base — models load from `${base}/models/painmap3D_*.runtime.glb`. */
    base?: string;
    /** Direct GLB URL. When non-empty it takes precedence over `base`. */
    modelUrl?: string;
    /** Authored patient pose (the starting/antalgic rest); `null` = anatomic
     *  baseline. `relax` commands return the patient to this pose. */
    authoredPose?: CustomPose | null;
    /** Scenario ROM constraints for the active case (available range /
     *  painful arc / end-feel). Installed on load, cleared on destroy. */
    romConstraints?: RomScenarioConstraints | null;
    height?: string;
    /** Fires with the engine-computed clinical joint angles after the
     *  initial load and after each command settles (the truth the host
     *  grades against). */
    onReport?: (report: JointAngleReport) => void;
    /** Fires when the authored pose is rejected at load time ('variant',
     *  'schema', 'empty', 'no-skeleton'); the stage continues anatomic. */
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

  // ── Imperative command surface ─────────────────────────────────────────
  // `applyMovementCommand` is exported on the component instance (Svelte 5:
  // grab it via `bind:this`). Commands are chained so each one starts from
  // the previous settled pose; callers may fire-and-forget or await.
  let runCommandImpl: ((cmd: ExamMovementCommand) => Promise<ExamMovementOutcome>) | null = null;
  let resolveBoot: () => void = () => {};
  const bootDone = new Promise<void>((r) => (resolveBoot = r));
  let commandChain: Promise<unknown> = Promise.resolve();

  export function applyMovementCommand(cmd: ExamMovementCommand): Promise<ExamMovementOutcome> {
    const run = commandChain.then(async () => {
      await bootDone;
      if (!runCommandImpl) {
        return { status: 'refused', reason: 'stage-unavailable' } as ExamMovementOutcome;
      }
      return runCommandImpl(cmd);
    });
    commandChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  onMount(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // Bare 'three' specifiers only — a second three instance would break
      // the instanceof checks inside the pose services.
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
      // Services via relative paths (not the barrel) — the barrel re-exports
      // this component, so importing it here would be circular.
      const { getBodyVariant } = await import('./anatomy/bodyVariants');
      const { createMannequinRenderer, addMannequinLights, loadVariantModel } = await import(
        './services/sceneBoot'
      );
      const { applyAnatomicPose } = await import('./services/anatomicPose');
      const { resolveCameraViewSetpoint } = await import('./services/cameraTween');
      const { applyCustomPose, blendCustomPoseWithBaseline, isCustomPoseEmpty, serializeCustomPose } =
        await import('./services/poseRig');
      const { captureJointAngleRestReference, computeJointAngles } = await import(
        './services/jointAngles'
      );
      const { buildCommandPose, finalizeOutcome, measureCommandMotion, resolveCommandTarget } =
        await import('./services/movementCommand');

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
      controls.enablePan = false; // read-only stage: orbit + zoom only
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

      // Live pose state for the command surface (reassigned per load).
      let variantCfgRef: ReturnType<typeof getBodyVariant> | null = null;
      let skinnedRef: import('three').SkinnedMesh | null = null;
      let restRef: ReturnType<typeof captureJointAngleRestReference> | null = null;
      /** Full-skeleton anatomic-rest pose every command builds from. */
      let baselinePoseRef: CustomPose | null = null;
      /** The gated authored/antalgic pose — the `relax` target. */
      let restingPoseRef: CustomPose | null = null;
      /** The pose currently on the skeleton (null = anatomic baseline). */
      let currentPose: CustomPose | null = null;

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
       *  rest reference, the poses, and the angle reports. */
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
          // 1) Load the GLB (direct URL wins; else the `${base}/models/…`
          //    convention). Runtime GLBs are meshopt-compressed.
          let root: import('three').Object3D;
          let skinned: import('three').SkinnedMesh | null;
          if (url) {
            const gltfLoader = new GLTFLoader();
            gltfLoader.setMeshoptDecoder(MeshoptDecoder);
            const gltf = await gltfLoader.loadAsync(url);
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

          // 2) Anatomic baseline — the shared clinical 0° reference.
          applyAnatomicPose(root, variantCfg);
          root.updateMatrixWorld(true);

          // 3) Capture the rest reference AFTER anatomic and BEFORE any
          //    authored pose, so anatomic reads 0° and reports measure only
          //    deviation from it. Then serialize the anatomic baseline —
          //    the rest-local quaternions every command pose builds from.
          const rest = skinned ? captureJointAngleRestReference(skinned.skeleton, variantCfg) : null;
          const baseline = skinned
            ? serializeCustomPose(skinned.skeleton, variantCfg, variantCfg.id)
            : null;

          // 4) Install the scenario's ROM constraints before any command
          //    can resolve against them (display-side data from the host).
          setRomScenarioConstraints(romConstraints ?? null);

          // 5) Gate + apply the authored/antalgic pose (the production
          //    load gate). On drop, surface the reason and stay anatomic.
          let resting: CustomPose | null = null;
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
              resting = pose;
            }
          }

          // 6) Ground the feet AFTER posing (a plantar-flexed ankle shifts
          //    the bounds), then frame the camera on the grounded bounds.
          _box.setFromObject(root);
          root.position.y -= _box.min.y;
          root.updateMatrixWorld(true);
          _box.setFromObject(root);
          _box.getBoundingSphere(_sphere);
          modelCenter.copy(_sphere.center);
          modelRadius = _sphere.radius;
          modelRoot = root;
          frameCamera();

          // 7) Wire the command surface to the fresh skeleton.
          variantCfgRef = variantCfg;
          skinnedRef = skinned;
          restRef = rest;
          baselinePoseRef = baseline;
          restingPoseRef = resting;
          currentPose = resting;

          // 8) Measure the presented pose and hand the report to the host.
          if (skinned && rest) {
            onReport?.(computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, rest));
          }
          loading = false;
          requestRender();
        } catch (err) {
          if (disposed) return;
          console.error('ExamStage3D: failed to load model', err);
          loadError = 'Failed to load the 3D model.';
          loading = false;
        }
      }

      function frameCamera() {
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

      // ── Command tween (runs INSIDE the existing rAF loop) ──────────────
      const TWEEN_MS = 600;
      const easeInOutCubic = (t: number) =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      interface ActiveTween {
        from: CustomPose | null;
        to: CustomPose | null;
        start: number;
        resolve: () => void;
      }
      let activeTween: ActiveTween | null = null;

      function applyPoseNow(pose: CustomPose | null) {
        if (!skinnedRef || !variantCfgRef) return;
        const effective = pose ?? baselinePoseRef;
        if (effective) applyCustomPose(skinnedRef.skeleton, variantCfgRef, effective);
      }

      /** Complete the active tween immediately (settle at the target). */
      function finishTween() {
        const tw = activeTween;
        if (!tw) return;
        activeTween = null;
        applyPoseNow(tw.to);
        currentPose = tw.to;
        requestRender();
        tw.resolve();
      }

      function stepTween(now: number) {
        const tw = activeTween;
        if (!tw) return;
        const t = Math.min(1, (now - tw.start) / TWEEN_MS);
        if (t >= 1) {
          finishTween();
          return;
        }
        if (skinnedRef && variantCfgRef) {
          const blended = blendCustomPoseWithBaseline(tw.from, tw.to, baselinePoseRef, easeInOutCubic(t));
          if (blended) applyCustomPose(skinnedRef.skeleton, variantCfgRef, blended);
        }
        requestRender();
      }

      function tweenTo(to: CustomPose | null): Promise<void> {
        return new Promise((resolve) => {
          if (activeTween) finishTween(); // safety — commands are serialized
          activeTween = { from: currentPose, to, start: performance.now(), resolve };
          startLoop();
          requestRender();
          // Hidden stage: the loop is parked, so settle instantly rather
          // than stranding the command promise until the stage is shown.
          if (!container || container.offsetParent === null) finishTween();
        });
      }

      function measureNow(): JointAngleReport | null {
        if (!skinnedRef || !variantCfgRef || !restRef || !modelRoot) return null;
        modelRoot.updateMatrixWorld(true);
        return computeJointAngles(skinnedRef.skeleton, variantCfgRef, variantCfgRef.id, restRef);
      }

      runCommandImpl = async (cmd: ExamMovementCommand): Promise<ExamMovementOutcome> => {
        if (disposed || !skinnedRef || !variantCfgRef || !restRef || !baselinePoseRef) {
          return { status: 'refused', reason: 'stage-unavailable' };
        }
        if (cmd.action === 'relax') {
          await tweenTo(restingPoseRef);
          const report = measureNow();
          if (report) onReport?.(report);
          return { status: 'complied' };
        }
        const resolved = resolveCommandTarget(cmd, variantCfgRef);
        if (resolved.status === 'refused' || resolved.clampedDegrees == null) {
          // The patient does not move; answer with where the joint IS.
          const report = measureNow();
          const achieved = report ? measureCommandMotion(report, cmd.joint, cmd.motion) : undefined;
          return finalizeOutcome(resolved, achieved);
        }
        const target = buildCommandPose(
          baselinePoseRef,
          cmd,
          resolved.clampedDegrees,
          variantCfgRef,
          currentPose,
        );
        if (!target) {
          return finalizeOutcome({ ...resolved, status: 'refused', reason: 'unsupported-motion' });
        }
        await tweenTo(target);
        // Settle: re-measure the skeleton — the outcome carries what the
        // patient actually did, not what was planned.
        const report = measureNow();
        if (report) onReport?.(report);
        const achieved = report ? measureCommandMotion(report, cmd.joint, cmd.motion) : undefined;
        return finalizeOutcome(resolved, achieved);
      };

      // Hosts display:none this stage during overlays, and rAF keeps firing
      // for display:none elements — park the loop (no reschedule) when the
      // container is hidden; the ResizeObserver restarts it when shown. A
      // hidden stage settles any in-flight tween immediately so command
      // promises never strand.
      let raf = 0;
      let loopRunning = false;
      const loop = () => {
        if (container.offsetParent === null) {
          loopRunning = false;
          if (activeTween) finishTween();
          return; // parked — startLoop() (via the ResizeObserver) resumes
        }
        raf = requestAnimationFrame(loop);
        controls.update();
        if (activeTween) stepTween(performance.now());
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

      // Wire the teardown BEFORE the first (awaited) model load — an unmount
      // mid-load must still stop the rAF loop and dispose everything.
      cleanup = () => {
        if (activeTween) finishTween();
        runCommandImpl = null;
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.removeEventListener('change', requestRender);
        disposeModel();
        controls.dispose();
        renderer.dispose();
        if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
        clearRomScenarioConstraints();
      };

      await loadModel(variant, modelUrl, authoredPose);
      if (disposed) return;

      reloadFn = (variantId, url, pose) => void loadModel(variantId, url, pose);
      appliedVariant = variant;
      appliedModelUrl = modelUrl;
      appliedPose = authoredPose;
      ready = true;
      resolveBoot();
    })();

    return () => {
      disposed = true;
      cleanup();
      resolveBoot(); // release queued commands → they resolve 'stage-unavailable'
    };
  });

  // React to prop changes after the initial boot: model identity changes
  // trigger a full reload (the rest reference must be recaptured).
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

  // Scenario constraints are hot-swappable without a reload — the resolve
  // step reads the store live.
  $effect(() => {
    if (!ready) return;
    setRomScenarioConstraints(romConstraints ?? null);
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
