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
    configureRingRotateGizmo,
    PoseRotateRingGizmo,
    PoseClickDeselect,
    computeDrivingRingMap,
    buildTwistRig,
    applyTwistRig,
    distributeChainCurve,
    pinBonesToRestWorld,
    blendCustomPoseWithBaseline,
    JointAnglesPanel,
  } from '../src/index';
  import type {
    BodyVariantConfig,
    CustomPose,
    JointAngleRestReference,
    JointAngleReport,
    IKChainContext,
    PoseRingDrag,
    DrivingRingMap,
    RomPlane,
    TwistSegment,
  } from '../src/index';

  /** Region curve handles distribute their bend across a 2-bone chain (smooth
   *  arc, not a kink at one joint) — Thoracic (Spine) + Cervical (Neck). */
  const POSE_CURVE_CHAINS: Record<string, { keys: string[]; control: number }> = {
    Spine_Upper: { keys: ['Spine_Mid', 'Spine_Upper'], control: 1 },
    Neck: { keys: ['Neck_Lower', 'Neck'], control: 1 },
  };
  /** Knees stay hinge-locked while the feet are pinned during a pelvis tilt. */
  const POSE_PLANT_HINGES = new Set(['L_Leg', 'R_Leg']);

  /** Plane → ring colour (matches body-chart's gizmo): sagittal red, frontal
   *  blue, transverse green. */
  const POSE_PLANE_RING_HEX: Record<RomPlane, number> = {
    sagittal: 0xff3653,
    frontal: 0x2c8fff,
    transverse: 0x8adb00,
  };

  let { base = '' }: { base?: string } = $props();

  let container: HTMLDivElement;
  let variant = $state<'male' | 'female'>('female');
  let loading = $state(true);
  let selectedKey = $state<string | null>(null);
  let report = $state<JointAngleReport | null>(null);
  let showAxes = $state(false);
  let romOn = $state(true);
  let twistOn = $state(true);
  let playing = $state(false);
  let copied = $state(false);

  /** Clinician-facing joint name from pose-engine's ROM labels (single source of
   *  truth), with the L/R prefix spelled out; falls back to a prettified key. */
  function friendlyJoint(key: string): string {
    const def = getRomJointDefinition(key);
    const src = def?.label ?? key.replace(/_/g, ' ');
    return src.replace(/^L /, 'Left ').replace(/^R /, 'Right ');
  }
  const selectedLabel = $derived(selectedKey ? friendlyJoint(selectedKey) : null);
  // The shared JointAnglesPanel shows whatever joints are in the report; narrow
  // it to the selected joint so the editor's readout stays focused.
  const selectedReport = $derived<JointAngleReport | null>(
    report && selectedKey && report.joints[selectedKey]
      ? { ...report, joints: { [selectedKey]: report.joints[selectedKey] } }
      : null,
  );

  // Imperative handles wired after boot.
  let api: {
    reset: () => void;
    copyPose: () => void;
    setAxes: (on: boolean) => void;
    load: (v: string) => void;
    render: () => void;
    playPose: () => void;
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
    tc.size = 0.675; // MUST match the ring gizmo size
    tc.enabled = false;
    const tcHelper = tc.getHelper();
    tcHelper.visible = false;
    // Strip TC's X/Y/Z rings — keep only its camera-space 'E' ring; the shared
    // PoseRotateRingGizmo draws + grabs the X/Y/Z plane rings (full tubes,
    // swept-angle grab → correct direction regardless of camera facing).
    configureRingRotateGizmo(tcHelper);
    tcHelper.traverse((o) => (o.renderOrder = 1000));
    scene.add(tcHelper);
    const ringGizmo = new PoseRotateRingGizmo({ size: 0.675 });

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
    let ringDrag: PoseRingDrag | null = null;
    let poseDrivingRings: DrivingRingMap | null = null;
    const _ringPos = new THREE.Vector3();
    const _ringQuat = new THREE.Quaternion();
    const _ringQuat2 = new THREE.Quaternion();
    let twistRig: TwistSegment[] = [];
    let fingerCurls: Map<string, { bones: THREE.Object3D[]; rest: THREE.Quaternion[] }> | null = null;
    let pelvisPlant: { ctx: IKChainContext; pos: THREE.Vector3 }[] | null = null;
    const _plantFootBones: THREE.Object3D[] = [];
    const _plantFootQuats: THREE.Quaternion[] = [];

    const raycaster = new THREE.Raycaster();
    const _ndc = new THREE.Vector2();
    const clickDeselect = new PoseClickDeselect(5); // click-off-to-deselect vs drag/orbit
    const _v = new THREE.Vector3();
    const _box = new THREE.Box3();
    const _sphere = new THREE.Sphere();
    const handleGeo = new THREE.SphereGeometry(0.022, 14, 10);
    const hitGeo = new THREE.SphereGeometry(0.06, 10, 8);
    let loadToken = 0;

    function refreshAngles() {
      if (!skinned || !variantCfg || !restRef) {
        report = null;
        return;
      }
      report = computeJointAngles(skinned.skeleton, variantCfg, variantCfg.id, restRef);
    }

    /** Colour each plane ring by the motion it drives (red sagittal / blue
     *  frontal / green transverse), via the driving-ring map — like body-chart. */
    function applyPoseRingColors(key: string) {
      const def = getRomJointDefinition(key);
      const dr = poseDrivingRings?.[key];
      if (!def || !dr) {
        ringGizmo.setRingColors({});
        return;
      }
      const colors: { x?: number; y?: number; z?: number } = {};
      for (const f of def.fields) {
        const ring = dr[f.plane]?.ring;
        if (ring) colors[ring] = POSE_PLANE_RING_HEX[f.plane];
      }
      ringGizmo.setRingColors(colors);
    }

    /** Position the plane rings at the selected joint. frameQuat = identity for
     *  world-space joints (UpperArm) else the bone's world quat — this is what
     *  keeps the rotation direction correct regardless of camera facing. */
    function updateRingGizmo() {
      if (!selected) {
        ringGizmo.update(camera, _ringPos, _ringQuat, false);
        return;
      }
      selected.bone.getWorldPosition(_ringPos);
      if (gizmoSpaceForJoint(selected.key) === 'world') _ringQuat.identity();
      else selected.bone.getWorldQuaternion(_ringQuat);
      ringGizmo.update(camera, _ringPos, _ringQuat, true);
    }

    /** Capture each finger's MCP→PIP→DIP chain + rest rotations (post-anatomic). */
    function buildFingerCurls() {
      fingerCurls = new Map();
      for (const h of handles) {
        if (!/(Thumb1|Index1|Mid1|Ring1|Pinky1)$/.test(h.key)) continue;
        const bones: THREE.Object3D[] = [h.bone];
        let node: THREE.Object3D = h.bone;
        for (let i = 0; i < 2; i++) {
          const next = node.children.find((c) => (c as THREE.Bone).isBone);
          if (!next) break;
          bones.push(next);
          node = next;
        }
        fingerCurls.set(h.key, {
          bones,
          rest: bones.map((b) => (b as THREE.Bone).quaternion.clone()),
        });
      }
    }

    /** Region curve handles (spine/neck): spread the bend across a 2-bone chain. */
    function applyPoseCurveChain(key: string, target: THREE.Quaternion): boolean {
      const chain = POSE_CURVE_CHAINS[key];
      if (!chain || !boneMap || !restRef) return false;
      const segs: THREE.Object3D[] = [];
      const rests: THREE.Quaternion[] = [];
      for (const k of chain.keys) {
        const b = boneMap.get(k);
        const rl = restRef.localQuats[k];
        if (!b || !rl) return false;
        segs.push(b);
        rests.push(new THREE.Quaternion(rl[0], rl[1], rl[2], rl[3]));
      }
      distributeChainCurve(segs, rests, chain.control, target);
      return true;
    }

    /** On a Hips grab: snapshot each foot's world transform + an IK chain. */
    function capturePelvisPlant() {
      releasePelvisPlant();
      if (!skinned || !variantCfg || !boneMap) return;
      const plant: { ctx: IKChainContext; pos: THREE.Vector3 }[] = [];
      for (const k of ['L_Foot', 'R_Foot']) {
        const foot = boneMap.get(k);
        if (!foot) continue;
        const ctx = buildIKChainContext(skinned, foot, 2, variantCfg);
        if (!ctx) continue;
        const pos = new THREE.Vector3();
        foot.getWorldPosition(pos);
        const quat = new THREE.Quaternion();
        foot.getWorldQuaternion(quat);
        plant.push({ ctx, pos });
        _plantFootBones.push(foot);
        _plantFootQuats.push(quat);
      }
      pelvisPlant = plant.length ? plant : null;
    }

    /** Per-frame during a Hips tilt: re-solve the legs to keep feet planted. */
    function applyPelvisPlant() {
      if (!pelvisPlant) return;
      for (const leg of pelvisPlant) {
        solveIKChain(leg.ctx, leg.pos, { rest: restRef, hinges: POSE_PLANT_HINGES });
      }
      pinBonesToRestWorld(_plantFootBones, _plantFootQuats);
    }

    function releasePelvisPlant() {
      if (pelvisPlant) {
        for (const leg of pelvisPlant) disposeIKChainContext(leg.ctx);
        pelvisPlant = null;
      }
      _plantFootBones.length = 0;
      _plantFootQuats.length = 0;
    }

    // ── Pose-motion preview (baseline ↔ current pose, smoothstep triangle) ──
    let playRaf = 0;
    let playPosed: CustomPose | null = null;
    const PLAY_DUR = 700;
    function stopPlay() {
      cancelAnimationFrame(playRaf);
      playing = false;
      if (playPosed && skinned && variantCfg) {
        applyCustomPose(skinned.skeleton, variantCfg, playPosed);
        modelRoot?.updateMatrixWorld(true);
        requestRender();
      }
      playPosed = null;
    }
    function playPose() {
      if (playing) {
        stopPlay();
        return;
      }
      if (!skinned || !variantCfg || !baselinePose) return;
      playPosed = serializeCustomPose(skinned.skeleton, variantCfg, variantCfg.id);
      playing = true;
      const start = performance.now();
      const tick = () => {
        const phase = ((performance.now() - start) % (2 * PLAY_DUR)) / PLAY_DUR; // 0..2
        const tri = phase <= 1 ? phase : 2 - phase; // 0..1..0
        const eased = tri * tri * (3 - 2 * tri); // smoothstep
        const blended = blendCustomPoseWithBaseline(baselinePose, playPosed, baselinePose, eased);
        if (blended && skinned && variantCfg) {
          applyCustomPose(skinned.skeleton, variantCfg, blended);
          modelRoot?.updateMatrixWorld(true);
          requestRender();
        }
        playRaf = requestAnimationFrame(tick);
      };
      tick();
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
        poseDrivingRings = restRef ? computeDrivingRingMap(restRef) : null;
        twistRig = sk ? buildTwistRig(sk.skeleton, cfg) : [];
        baselinePose = sk ? serializeCustomPose(sk.skeleton, cfg, cfg.id) : null;

        buildHandles(cfg);
        buildFingerCurls();
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
      clickDeselect.cancel();
      selected = h;
      selectedKey = h.key;
      const space = gizmoSpaceForJoint(h.key);
      tc.setSpace(space);
      tc.attach(h.bone);
      tc.enabled = true;
      tcHelper.visible = true;
      applyPoseRingColors(h.key);
      updateHandles();
      refreshAngles();
      requestRender();
    }

    function deselect() {
      selected = null;
      selectedKey = null;
      tc.detach();
      tc.enabled = false;
      tcHelper.visible = false;
      ringGizmo.hide();
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
      // Ring rotate grab has PRIORITY: grab anywhere on a plane ring → swept-angle
      // rotate that axis (correct direction regardless of front/back facing).
      if (ringGizmo.visible && selected) {
        selected.bone.getWorldPosition(_ringPos);
        if (gizmoSpaceForJoint(selected.key) === 'world') _ringQuat.identity();
        else selected.bone.getWorldQuaternion(_ringQuat);
        const drag = ringGizmo.beginDrag(raycaster, {
          centerWorld: _ringPos,
          frameQuat: _ringQuat,
          boneLocalQuat: selected.bone.quaternion,
          parentWorldQuat: (selected.bone.parent ?? selected.bone).getWorldQuaternion(_ringQuat2),
        });
        if (drag) {
          ringDrag = drag;
          if (selected.key === 'Hips') capturePelvisPlant();
          controls.enabled = false;
          e.preventDefault();
          return;
        }
      }
      const hit = raycaster.intersectObjects(
        handles.flatMap((h) => [h.mesh, h.hit]),
        false,
      )[0];
      if (!hit) {
        // Empty click: arm a deselect (a drag/orbit past threshold cancels it).
        if (selected) clickDeselect.arm(e.pointerId, e.clientX, e.clientY);
        return;
      }
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
      clickDeselect.handleMove(e.pointerId, e.clientX, e.clientY);
      // Ring rotate drag: spin the joint to follow the cursor sweep.
      if (ringDrag && selected && modelRoot) {
        setNdc(e);
        raycaster.setFromCamera(_ndc, camera);
        const target = ringDrag.update(raycaster);
        const fc = fingerCurls?.get(selected.key);
        if (applyPoseCurveChain(selected.key, target)) {
          // region curve (spine/neck) distributed the bend across its chain
        } else if (fc) {
          distributeChainCurve(fc.bones, fc.rest, 0, target); // finger curl
        } else if (selected.key === 'Hips') {
          selected.bone.quaternion.copy(target);
          modelRoot.updateMatrixWorld(true);
          applyPelvisPlant(); // keep feet planted while tilting the pelvis
        } else {
          selected.bone.quaternion.copy(target);
          if (restRef && romOn && hasClampStrategy(selected.key)) {
            clampBoneToRom(selected.bone, selected.key, restRef);
          }
        }
        modelRoot.updateMatrixWorld(true);
        updateHandles();
        refreshAngles();
        requestRender();
        e.preventDefault();
        return;
      }
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
    function onPointerUp(e: PointerEvent) {
      if (ringDrag) {
        ringDrag = null;
        releasePelvisPlant();
        controls.enabled = true;
        refreshAngles();
        return;
      }
      if (ikCtx) {
        disposeIKChainContext(ikCtx);
        ikCtx = null;
      }
      if (press) {
        press = null;
        controls.enabled = true;
      }
      // Clean click-off (no drag past threshold) → deselect.
      if (clickDeselect.shouldDeselect(e.pointerId)) deselect();
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
      if (twistOn && twistRig.length) {
        applyTwistRig(twistRig); // smooth forearm/shin twist distribution
        modelRoot?.updateMatrixWorld(true);
      }
      updateRingGizmo();
      renderer.render(scene, camera);
      ringGizmo.render(renderer, camera);
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
      load: (v) => void load(v),
      render: () => requestRender(),
      playPose: () => playPose(),
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(playRaf);
      ro.disconnect();
      controls.removeEventListener('change', requestRender);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKey);
      if (ikCtx) disposeIKChainContext(ikCtx);
      releasePelvisPlant();
      clearHandles();
      clearAxes();
      ringGizmo.dispose();
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
  $effect(() => {
    void twistOn;
    api?.render();
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
      <label class="lab__check"><input type="checkbox" bind:checked={twistOn} /> Twist rig</label>
    </div>

    <div class="lab__row lab__btns">
      <button onclick={() => api?.reset()}>Reset to anatomic</button>
      <button onclick={() => api?.playPose()}>{playing ? 'Stop ■' : 'Play pose ▶'}</button>
      <button onclick={() => api?.copyPose()}>{copied ? 'Copied ✓' : 'Copy pose JSON'}</button>
    </div>

    <div class="lab__sel">
      <span class="lab__label">Selected joint</span>
      <strong>{selectedLabel ?? '— click a dot —'}</strong>
      {#if selectedKey}<code class="lab__key">{selectedKey}</code>{/if}
    </div>

    {#if selectedReport}
      <JointAnglesPanel report={selectedReport} title="Joint angles (live)" />
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
