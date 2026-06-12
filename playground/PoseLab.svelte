<script lang="ts">
  /**
   * Interactive pose-editor showcase — exercises the pose-engine toolset on the
   * shared mannequin: click a joint to select it, rotate it with the gizmo (FK),
   * ROM clamping keeps it within clinical limits, live joint angles read out, and
   * a limb-axis overlay + pose serialize round it out. Playground-only (it imports
   * the raw pose-engine APIs); the shipped PoseViewer stays lightweight.
   */
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
  import {
    getBodyVariant,
    loadVariantModel,
    applyAnatomicPose,
    buildBoneByPoseKey,
    serializeCustomPose,
    applyCustomPose,
    captureJointAngleRestReference,
    computeJointAngles,
    clampBoneToRom,
    hasClampStrategy,
    gizmoSpaceForJoint,
    getRomJointDefinition,
    buildLimbAxisModel,
    ALL_LIMB_IDS,
    buildIKChainContext,
    solveIKChain,
    disposeIKChainContext,
    createMannequinRenderer,
    addMannequinLights,
  } from '../src/index';
  import type {
    BodyVariantConfig,
    CustomPose,
    JointAngleRestReference,
    IKChainContext,
  } from '../src/index';

  let { base = '' }: { base?: string } = $props();

  type AngleSet = Record<string, number>;

  let container: HTMLDivElement;
  let variant = $state<'male' | 'female'>('female');
  let loading = $state(true);
  let selectedKey = $state<string | null>(null);
  let selectedAngles = $state<AngleSet | null>(null);
  let showAxes = $state(false);
  let romOn = $state(true);
  let copied = $state(false);

  /** Clinician-facing joint name from pose-engine's ROM labels (single source of
   *  truth), with the L/R prefix spelled out; falls back to a prettified key. */
  function friendlyJoint(key: string): string {
    const def = getRomJointDefinition(key);
    const src = def?.label ?? key.replace(/_/g, ' ');
    return src.replace(/^L /, 'Left ').replace(/^R /, 'Right ');
  }
  const selectedLabel = $derived(selectedKey ? friendlyJoint(selectedKey) : null);

  // Imperative handles wired after boot.
  let api: {
    reset: () => void;
    copyPose: () => void;
    setAxes: (on: boolean) => void;
    setRom: (on: boolean) => void;
    load: (v: string) => void;
  } | null = null;

  const LIMB_COLORS: Record<string, number> = {
    'left-upper-extremity': 0x60a5fa,
    'right-upper-extremity': 0x34d399,
    'left-lower-extremity': 0xfb923c,
    'right-lower-extremity': 0xf472b6,
    'axial-spine': 0xa78bfa,
  };

  onMount(() => {
    let disposed = false;

    // ROM clamp is off by default in browsers (calibration mode); enable it.
    (window as unknown as { __enableRomClamp?: boolean }).__enableRomClamp = true;

    const scene = new THREE.Scene();
    scene.background = null;
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    const renderer = createMannequinRenderer({ container, alpha: true });
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 1;
    controls.maxDistance = 7;
    controls.maxPolarAngle = Math.PI * 0.92;

    addMannequinLights(scene, 'clinical');

    // FK rotate gizmo (visibility via the helper; `tc.visible` is untyped in r0.183).
    const tc = new TransformControls(camera, renderer.domElement);
    tc.setMode('rotate');
    tc.size = 0.7;
    tc.enabled = false;
    const tcHelper = tc.getHelper();
    tcHelper.visible = false;
    tcHelper.traverse((o) => (o.renderOrder = 1000));
    scene.add(tcHelper);

    let renderNeeded = true;
    const requestRender = () => (renderNeeded = true);
    controls.addEventListener('change', requestRender);

    let modelRoot: THREE.Object3D | null = null;
    let skinned: THREE.SkinnedMesh | null = null;
    let variantCfg: BodyVariantConfig | null = null;
    let boneMap: Map<string, THREE.Bone> | null = null;
    let restRef: JointAngleRestReference | null = null;
    let baselinePose: CustomPose | null = null;

    type Handle = {
      key: string;
      bone: THREE.Bone;
      mesh: THREE.Mesh;
      hit: THREE.Mesh;
      type: 'fk' | 'ik-effector';
      chain: number;
    };
    let handles: Handle[] = [];
    let handleGroup: THREE.Group | null = null;
    let selected: Handle | null = null;
    let axesGroup: THREE.Group | null = null;
    let reverseBoneMap: Map<THREE.Object3D, string> | null = null;
    let press: { handle: Handle; startX: number; startY: number; dragging: boolean } | null = null;
    let ikCtx: IKChainContext | null = null;
    const _dragPlane = new THREE.Plane();
    const _dragTarget = new THREE.Vector3();
    const _camDir = new THREE.Vector3();

    const raycaster = new THREE.Raycaster();
    const _ndc = new THREE.Vector2();
    const _v = new THREE.Vector3();
    const _box = new THREE.Box3();
    const _sphere = new THREE.Sphere();
    const handleGeo = new THREE.SphereGeometry(0.022, 14, 10);
    const hitGeo = new THREE.SphereGeometry(0.06, 10, 8);
    let loadToken = 0;

    function refreshAngles() {
      if (!skinned || !variantCfg || !restRef) return;
      const report = computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, restRef);
      selectedAngles = selectedKey ? (report.joints[selectedKey] ?? null) : null;
    }

    function clearHandles() {
      if (!handleGroup) return;
      scene.remove(handleGroup);
      handleGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.material) (m.material as THREE.Material).dispose?.();
      });
      handles = [];
      handleGroup = null;
    }

    function buildHandles(cfg: BodyVariantConfig) {
      clearHandles();
      if (!boneMap) return;
      handleGroup = new THREE.Group();
      for (const h of cfg.poseRig.handles) {
        const bone = boneMap.get(h.canonicalKey);
        if (!bone) continue;
        const mesh = new THREE.Mesh(
          handleGeo,
          new THREE.MeshBasicMaterial({ color: 0x57d46a, depthTest: false, transparent: true, opacity: 0.85 }),
        );
        mesh.renderOrder = 999;
        const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
        mesh.add(hit);
        handleGroup.add(mesh);
        handles.push({
          key: h.canonicalKey,
          bone,
          mesh,
          hit,
          type: h.type,
          chain: h.chainParentCount ?? 1,
        });
      }
      scene.add(handleGroup);
    }

    function updateHandles() {
      if (!handleGroup) return;
      const d = camera.position.distanceTo(controls.target);
      const s = Math.max(0.6, Math.min(2, d / 4));
      for (const h of handles) {
        h.bone.getWorldPosition(_v);
        h.mesh.position.copy(_v);
        h.mesh.scale.setScalar(s);
        const mat = h.mesh.material as THREE.MeshBasicMaterial;
        const sel = h === selected;
        mat.color.setHex(sel ? 0x4dd5ff : 0x57d46a);
        mat.opacity = sel ? 1 : 0.85;
      }
    }

    function clearAxes() {
      if (!axesGroup) return;
      scene.remove(axesGroup);
      axesGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        if (m.material) (m.material as THREE.Material).dispose?.();
      });
      axesGroup = null;
    }

    function buildAxes() {
      clearAxes();
      if (!skinned || !variantCfg) return;
      const model = buildLimbAxisModel(skinned.skeleton, variantCfg, 0, 1);
      axesGroup = new THREE.Group();
      for (const limbId of ALL_LIMB_IDS) {
        const axis = model.axes[limbId];
        if (!axis || axis.points.length < 2) continue;
        const pts = axis.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
        const color = LIMB_COLORS[limbId] ?? 0xffffff;
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
        );
        line.renderOrder = 998;
        axesGroup.add(line);
        for (const p of pts) {
          const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.012, 8, 6),
            new THREE.MeshBasicMaterial({ color, depthTest: false }),
          );
          dot.position.copy(p);
          dot.renderOrder = 999;
          axesGroup.add(dot);
        }
      }
      scene.add(axesGroup);
    }

    function frame() {
      // Fit the camera to the model, front view.
      const dir = new THREE.Vector3(0, 0.04, 1).normalize();
      const fov = (camera.fov * Math.PI) / 180;
      const dist = (_sphere.radius / Math.sin(fov / 2)) * 1.05;
      controls.target.copy(_sphere.center);
      camera.position.copy(_sphere.center).addScaledVector(dir, dist);
      controls.update();
      requestRender();
    }

    async function load(variantId: string) {
      const cfg = getBodyVariant(variantId);
      const token = ++loadToken;
      loading = true;
      deselect();
      try {
        const { root, skinned: sk } = await loadVariantModel(cfg, base);
        if (disposed || token !== loadToken) return;
        if (modelRoot) {
          scene.remove(modelRoot);
          modelRoot.traverse((o) => {
            const m = o as THREE.Mesh;
            m.geometry?.dispose?.();
            const mm = m.material as THREE.Material | THREE.Material[] | undefined;
            if (mm) (Array.isArray(mm) ? mm : [mm]).forEach((x) => x.dispose?.());
          });
        }
        scene.add(root);
        root.updateMatrixWorld(true);
        applyAnatomicPose(root, cfg); // 0° clinical baseline
        root.updateMatrixWorld(true);
        _box.setFromObject(root);
        root.position.y -= _box.min.y; // ground feet
        root.updateMatrixWorld(true);
        _box.setFromObject(root);
        _box.getBoundingSphere(_sphere);

        modelRoot = root;
        skinned = sk;
        variantCfg = cfg;
        boneMap = sk ? buildBoneByPoseKey(sk.skeleton, cfg) : null;
        reverseBoneMap = new Map();
        if (boneMap) for (const [k, b] of boneMap) reverseBoneMap.set(b, k);
        // Capture rest reference AFTER anatomic pose so angles read 0 at rest.
        restRef = sk ? captureJointAngleRestReference(sk.skeleton, cfg) : null;
        baselinePose = sk ? serializeCustomPose(sk.skeleton, cfg, cfg.id) : null;

        buildHandles(cfg);
        if (showAxes) buildAxes();
        frame();
        loading = false;
        requestRender();
      } catch (err) {
        if (disposed) return;
        console.error('PoseLab: load failed', err);
        loading = false;
      }
    }

    function selectHandle(h: Handle) {
      selected = h;
      selectedKey = h.key;
      const space = gizmoSpaceForJoint(h.key);
      tc.setSpace(space);
      tc.attach(h.bone);
      tc.enabled = true;
      tcHelper.visible = true;
      updateHandles();
      refreshAngles();
      requestRender();
    }

    function deselect() {
      selected = null;
      selectedKey = null;
      selectedAngles = null;
      tc.detach();
      tc.enabled = false;
      tcHelper.visible = false;
      controls.enabled = true;
      updateHandles();
      requestRender();
    }

    // ── gizmo events ──
    let tcDragging = false;
    tc.addEventListener('dragging-changed', (e) => {
      tcDragging = (e as unknown as { value: boolean }).value;
      controls.enabled = !tcDragging;
      if (!tcDragging) refreshAngles();
    });
    tc.addEventListener('change', () => {
      if (!selected || !tcDragging || !modelRoot) return;
      modelRoot.updateMatrixWorld(true);
      if (restRef && romOn && hasClampStrategy(selected.key)) {
        clampBoneToRom(selected.bone, selected.key, restRef);
        modelRoot.updateMatrixWorld(true);
      }
      updateHandles();
      refreshAngles();
      requestRender();
    });

    // ── selection raycast ──
    function setNdc(e: PointerEvent) {
      const r = renderer.domElement.getBoundingClientRect();
      _ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      _ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    }
    function onPointerDown(e: PointerEvent) {
      if (tcDragging || !handleGroup) return;
      setNdc(e);
      raycaster.setFromCamera(_ndc, camera);
      const hit = raycaster.intersectObjects(
        handles.flatMap((h) => [h.mesh, h.hit]),
        false,
      )[0];
      if (!hit) return;
      const h = handles.find((x) => x.mesh === hit.object || x.hit === hit.object);
      if (!h) return;
      selectHandle(h);
      // Arm an IK drag for effector joints — grab the dot and drag it to move it.
      if (h.type === 'ik-effector') {
        h.bone.getWorldPosition(_v);
        camera.getWorldDirection(_camDir);
        _dragPlane.setFromNormalAndCoplanarPoint(_camDir, _v);
        press = { handle: h, startX: e.clientX, startY: e.clientY, dragging: false };
        controls.enabled = false;
      }
    }
    function onPointerMove(e: PointerEvent) {
      if (!press || tcDragging || !modelRoot) return;
      if (!press.dragging) {
        if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < 5) return;
        press.dragging = true;
      }
      setNdc(e);
      raycaster.setFromCamera(_ndc, camera);
      if (!raycaster.ray.intersectPlane(_dragPlane, _dragTarget)) return;
      if (!ikCtx && skinned && variantCfg) {
        ikCtx = buildIKChainContext(skinned, press.handle.bone, press.handle.chain, variantCfg);
      }
      if (!ikCtx) return;
      solveIKChain(ikCtx, _dragTarget);
      // ROM-clamp the solved chain (effector bone up through its parents).
      if (restRef && romOn && reverseBoneMap) {
        let b: THREE.Object3D | null = press.handle.bone;
        for (let i = 0; i <= press.handle.chain && b; i++) {
          const key = reverseBoneMap.get(b);
          if (key && hasClampStrategy(key)) clampBoneToRom(b as THREE.Bone, key, restRef);
          const parent: THREE.Object3D | null = b.parent;
          if (!parent || !(parent as THREE.Bone).isBone) break;
          b = parent;
        }
      }
      modelRoot.updateMatrixWorld(true);
      updateHandles();
      refreshAngles();
      requestRender();
    }
    function onPointerUp() {
      if (ikCtx) {
        disposeIKChainContext(ikCtx);
        ikCtx = null;
      }
      if (press) {
        press = null;
        controls.enabled = true;
      }
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') deselect();
    }
    window.addEventListener('keydown', onKey);

    // ── loop + resize ──
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      updateHandles();
      if (!renderNeeded) return;
      renderer.render(scene, camera);
      renderNeeded = false;
    };
    loop();
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      requestRender();
    });
    ro.observe(container);

    void load(variant);

    api = {
      reset: () => {
        if (skinned && variantCfg && baselinePose) {
          applyCustomPose(skinned.skeleton, variantCfg, baselinePose);
          modelRoot?.updateMatrixWorld(true);
          updateHandles();
          refreshAngles();
          requestRender();
        }
      },
      copyPose: () => {
        if (!skinned || !variantCfg) return;
        const pose = serializeCustomPose(skinned.skeleton, variantCfg, variantCfg.id);
        void navigator.clipboard?.writeText(JSON.stringify(pose, null, 2));
        copied = true;
        setTimeout(() => (copied = false), 1500);
      },
      setAxes: (on) => {
        if (on) buildAxes();
        else clearAxes();
        requestRender();
      },
      setRom: () => {},
      load: (v) => void load(v),
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.removeEventListener('change', requestRender);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKey);
      if (ikCtx) disposeIKChainContext(ikCtx);
      clearHandles();
      clearAxes();
      tc.detach();
      tc.dispose();
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  });

  // Prop/UI → engine reactions.
  $effect(() => {
    api?.load(variant);
  });
  $effect(() => {
    api?.setAxes(showAxes);
  });
</script>

<div class="lab">
  <div class="lab__stage">
    <div class="lab__canvas" bind:this={container}></div>
    {#if loading}<div class="lab__loading">Loading…</div>{/if}
    <div class="lab__hint">
      Click a joint dot · drag it to pose (IK) · rotate with the gizmo · Esc to deselect
    </div>
  </div>

  <aside class="lab__panel">
    <div class="lab__row">
      <span class="lab__label">Variant</span>
      <div class="seg">
        <button class:active={variant === 'female'} onclick={() => (variant = 'female')}>Female</button>
        <button class:active={variant === 'male'} onclick={() => (variant = 'male')}>Male</button>
      </div>
    </div>

    <div class="lab__row">
      <label class="lab__check"><input type="checkbox" bind:checked={showAxes} /> Limb-axis overlay</label>
      <label class="lab__check"><input type="checkbox" bind:checked={romOn} /> ROM clamp</label>
    </div>

    <div class="lab__row lab__btns">
      <button onclick={() => api?.reset()}>Reset to anatomic</button>
      <button onclick={() => api?.copyPose()}>{copied ? 'Copied ✓' : 'Copy pose JSON'}</button>
    </div>

    <div class="lab__sel">
      <span class="lab__label">Selected joint</span>
      <strong>{selectedLabel ?? '— click a dot —'}</strong>
      {#if selectedKey}<code class="lab__key">{selectedKey}</code>{/if}
    </div>

    {#if selectedAngles}
      <div class="lab__angles">
        <span class="lab__label">Joint angles (live)</span>
        <table>
          <tbody>
            {#each Object.entries(selectedAngles) as [name, deg] (name)}
              <tr><td>{name}</td><td>{deg.toFixed(1)}°</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <details class="lab__caps">
      <summary>Tools exercised here</summary>
      <ul>
        <li>Joint selection + FK rotate gizmo (TransformControls)</li>
        <li>ROM clamping (clampBoneToRom)</li>
        <li>Clinical joint angles (computeJointAngles)</li>
        <li>Limb-axis model overlay (buildLimbAxisModel)</li>
        <li>IK drag-to-pose (buildIKChainContext + solveIKChain)</li>
        <li>Pose serialize (serializeCustomPose) + reset</li>
      </ul>
      <p class="lab__note">
        Also in pose-engine, not yet wired here: the rotate-ring gizmo, movement clips, twist rig.
      </p>
    </details>
  </aside>
</div>

<style>
  .lab {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18rem;
    gap: 1rem;
  }
  .lab__stage {
    position: relative;
    height: 32rem;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: radial-gradient(circle at 50% 40%, #323a3e 0%, #1d2326 58%, #11161a 100%);
  }
  .lab__canvas {
    position: absolute;
    inset: 0;
  }
  .lab__loading {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.82rem;
  }
  .lab__hint {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 0.4rem;
    text-align: center;
    font-size: 0.68rem;
    color: rgba(255, 255, 255, 0.45);
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.3));
  }
  .lab__panel {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.85);
  }
  .lab__row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .lab__label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.5);
  }
  .seg {
    display: inline-flex;
    gap: 0.3rem;
    padding: 0.25rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.03);
  }
  .seg button {
    border: 0;
    border-radius: 6px;
    padding: 0.3rem 0.7rem;
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.74rem;
    cursor: pointer;
  }
  .seg button.active {
    background: #6fcdb8;
    color: #06231d;
    font-weight: 700;
  }
  .lab__check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.76rem;
    color: rgba(255, 255, 255, 0.78);
  }
  .lab__btns {
    flex-direction: row;
    gap: 0.4rem;
  }
  .lab__btns button {
    flex: 1;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px;
    padding: 0.4rem;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.72rem;
    cursor: pointer;
  }
  .lab__sel strong {
    display: block;
    margin-top: 0.2rem;
    color: #fff;
    font-size: 0.95rem;
  }
  .lab__key {
    font-family: ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
    font-size: 0.7rem;
    color: #9fe3d6;
  }
  .lab__angles table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .lab__angles td {
    padding: 0.15rem 0.2rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .lab__angles td:last-child {
    text-align: right;
    color: #fff;
  }
  .lab__caps {
    font-size: 0.72rem;
    color: rgba(255, 255, 255, 0.6);
  }
  .lab__caps summary {
    cursor: pointer;
    color: rgba(255, 255, 255, 0.8);
  }
  .lab__caps ul {
    margin: 0.4rem 0;
    padding-left: 1rem;
  }
  .lab__note {
    margin: 0.3rem 0 0;
    color: rgba(255, 255, 255, 0.45);
  }
</style>
