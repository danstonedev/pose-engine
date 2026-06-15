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
    readAxialTwist,
    setAxialTwist,
    pinBonesToRestWorld,
    blendCustomPoseWithBaseline,
    buildOrbitTweenForWorldTarget,
    evaluateOrbitTween,
    createAnatomicalPlanes,
    createSectionCap,
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
    AnatomicalPlanes,
    SectionCap,
  } from '../src/index';

  /** Region curve handles distribute their bend across a 2-bone chain (smooth
   *  arc, not a kink at one joint) — Thoracic (Spine) + Cervical (Neck). */
  const POSE_CURVE_CHAINS: Record<string, { keys: string[]; control: number }> = {
    Spine_Upper: { keys: ['Spine_Mid', 'Spine_Upper'], control: 1 },
    Neck: { keys: ['Neck_Lower', 'Neck'], control: 1 },
  };
  /** Knees stay hinge-locked while the feet are pinned during a pelvis tilt. */
  const POSE_PLANT_HINGES = new Set(['L_Leg', 'R_Leg']);

  /** Pronation/supination is one shared forearm rotation, distributed 1:1 across
   *  the elbow (proximal radioulnar) and the wrist (distal) — total ±90°, ±45°
   *  per segment. Driven by the twist (Y) ring on either the forearm or hand. */
  const PROSUP_KEYS = new Set(['L_Forearm', 'R_Forearm', 'L_Hand', 'R_Hand']);
  const PROSUP_SEG_LIMIT_RAD = (45 * Math.PI) / 180; // half of the ±90 registry total

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
  let showSagittal = $state(false);
  let showFrontal = $state(false);
  let showTransverse = $state(false);
  let showOblique = $state(false);
  let showJoints = $state(true);
  let slice = $state<'off' | 'sagittal' | 'frontal' | 'transverse' | 'oblique'>('off');
  let sliceFlip = $state(false);
  let sliceDepth = $state(0); // -1..1, scaled by the model radius
  let sliceCap = $state(true); // solid stencil cap (bright cross-section + contour)
  const obliqueActive = $derived(showOblique || slice === 'oblique');

  /** Bright cross-section colour per plane (matches the plane visuals). */
  const PLANE_COLOR: Record<string, number> = {
    sagittal: 0xff3653,
    frontal: 0x2c8fff,
    transverse: 0x8adb00,
    oblique: 0xffb020,
  };
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
    focus: () => void;
    setPlanes: () => void;
    setSlice: () => void;
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
    renderer.localClippingEnabled = true; // cross-section slicing (clipping planes)

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
    let planes: AnatomicalPlanes | null = null;
    // The oblique plane reuses the joint ring gizmo (rotate) + a centre dot
    // (translate) so its manipulation matches the joint gizmos exactly.
    let obliqueDot: THREE.Mesh | null = null;
    let obliqueHit: THREE.Mesh | null = null;
    let obliqueRingDrag: PoseRingDrag | null = null;
    let obliquePress: { startX: number; startY: number; dragging: boolean } | null = null;
    // Cross-section slicing: one live clip plane shared by the model materials.
    const sliceClipPlane = new THREE.Plane();
    let clipTargets: THREE.Material[] = [];
    let clipMeshes: THREE.Mesh[] = [];
    let sectionCap: SectionCap | null = null;
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
        ringGizmo.setHiddenRings([]);
        return;
      }
      const colors: { x?: number; y?: number; z?: number } = {};
      for (const f of def.fields) {
        const ring = dr[f.plane]?.ring;
        if (ring) colors[ring] = POSE_PLANE_RING_HEX[f.plane];
      }
      ringGizmo.setRingColors(colors);
      // Hide the wrist's pro/sup (transverse) ring: pro/sup is driven from the
      // elbow now (most natural there) and stays coupled 1:1 to the wrist, so
      // the wrist's own twist ring is redundant visual clutter.
      const proSupRing = dr.transverse?.ring;
      ringGizmo.setHiddenRings(
        (key === 'L_Hand' || key === 'R_Hand') && proSupRing ? [proSupRing] : [],
      );
    }

    /** Position the plane rings at the selected joint. frameQuat = identity for
     *  world-space joints (UpperArm) else the bone's world quat — this is what
     *  keeps the rotation direction correct regardless of camera facing. */
    function updateRingGizmo() {
      // Oblique-plane editing owns the ring gizmo (positioned/oriented on the
      // plane node) — the same rings used to rotate joints.
      if (obliqueEditing() && planes) {
        planes.oblique.getWorldPosition(_ringPos);
        planes.oblique.getWorldQuaternion(_ringQuat);
        ringGizmo.update(camera, _ringPos, _ringQuat, true);
        return;
      }
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
      // ROM-clamp the REGIONAL total before distributing: the target is the
      // control bone's intended end orientation (= the whole region's bend),
      // and the registry row for the control key (Spine_Upper = Thoracic,
      // Neck = Cervical) holds the regional ROM. Body-euler clamp is local-only,
      // so we clamp the control bone in place, then distribute the clamped arc.
      let clamped = target;
      if (romOn && hasClampStrategy(key)) {
        const ctrl = boneMap.get(key);
        if (ctrl) {
          ctrl.quaternion.copy(target);
          clampBoneToRom(ctrl as THREE.Bone, key, restRef);
          clamped = ctrl.quaternion.clone();
        }
      }
      distributeChainCurve(segs, rests, chain.control, clamped);
      return true;
    }

    /** Coupled pronation/supination: a twist (Y-ring) drag on the forearm OR the
     *  hand drives ONE shared rotation split 1:1 between the two segments. The
     *  selected bone takes the drag's swing (so flexion / flex-dev still track
     *  the cursor) but its twist — and the sibling's — is set to the same
     *  per-segment angle (±45°), summing to the ±90° registry total. Only fires
     *  on the twist ring; flexion/deviation drags fall through so they never
     *  disturb existing pro/sup. */
    function applyProSup(key: string, target: THREE.Quaternion): boolean {
      if (!PROSUP_KEYS.has(key) || !boneMap || !restRef) return false;
      const side = key.startsWith('L_') ? 'L_' : 'R_';
      const forearm = boneMap.get(`${side}Forearm`);
      const hand = boneMap.get(`${side}Hand`);
      const rfArr = restRef.localQuats[`${side}Forearm`];
      const rhArr = restRef.localQuats[`${side}Hand`];
      if (!forearm || !hand || !rfArr || !rhArr) return false;
      const restF = new THREE.Quaternion(rfArr[0], rfArr[1], rfArr[2], rfArr[3]);
      const restH = new THREE.Quaternion(rhArr[0], rhArr[1], rhArr[2], rhArr[3]);
      const selIsForearm = key.endsWith('Forearm');
      const sel = selIsForearm ? forearm : hand;
      const restSel = selIsForearm ? restF : restH;

      // Per-segment twist = the drag's intended twist, capped at ±45° (read from
      // the raw target, before the hand's body-euler clamp zeroes the Y axis).
      const twist = Math.max(
        -PROSUP_SEG_LIMIT_RAD,
        Math.min(PROSUP_SEG_LIMIT_RAD, readAxialTwist(target, restSel)),
      );

      // Selected bone follows the cursor for its swing; clamp its swing via the
      // normal strategy (forearm hinge = flexion; hand body-euler = flex/dev),
      // then override the twist with our capped, distributed value.
      sel.quaternion.copy(target);
      if (romOn && hasClampStrategy(key)) clampBoneToRom(sel as THREE.Bone, key, restRef);
      setAxialTwist(sel, restSel, twist);

      // Sibling mirrors the SAME per-segment twist, preserving its own swing.
      const sib = selIsForearm ? hand : forearm;
      const restSib = selIsForearm ? restH : restF;
      setAxialTwist(sib, restSib, twist);
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

    // ── Orbit-to-mark: smoothly swing the camera to face the selected joint ──
    let orbitRaf = 0;
    function focusSelected() {
      if (!selected) return;
      selected.bone.getWorldPosition(_v);
      const tween = buildOrbitTweenForWorldTarget({
        cameraPosition: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        controlsTarget: controls.target,
        worldTarget: { x: _v.x, y: _v.y, z: _v.z },
        startedAt: performance.now(),
      });
      if (!tween) return;
      cancelAnimationFrame(orbitRaf);
      const ease = (t: number) => t * t * (3 - 2 * t);
      const tick = () => {
        const step = evaluateOrbitTween(tween, performance.now(), ease);
        camera.position.copy(step.position);
        controls.target.copy(step.target);
        controls.update();
        requestRender();
        if (!step.done) orbitRaf = requestAnimationFrame(tick);
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
      const d = camera.position.distanceTo(controls.target);
      const s = Math.max(0.6, Math.min(2, d / 4));
      if (obliqueDot && obliqueDot.visible && planes) {
        planes.oblique.getWorldPosition(_v);
        obliqueDot.position.copy(_v);
        obliqueDot.scale.setScalar(s);
      }
      if (!handleGroup) return;
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

    /** The oblique plane is being edited when its checkbox is on OR it's the
     *  active slicing plane (slicing implies you want to position it). */
    function obliqueEditing() {
      return showOblique || slice === 'oblique';
    }
    /** A plane's quad is shown if its checkbox is on, or it's the active slice in
     *  hollow mode (to mark the cut). When the solid cap is on, the cap replaces
     *  the active slice's quad (avoids z-fighting; the cap shows the contour). */
    function planeShown(name: 'sagittal' | 'frontal' | 'transverse' | 'oblique') {
      const checked =
        name === 'sagittal'
          ? showSagittal
          : name === 'frontal'
            ? showFrontal
            : name === 'transverse'
              ? showTransverse
              : showOblique;
      if (slice === name) return sliceCap ? checked : true;
      return checked;
    }

    /** Joint dots hide (and stop responding) while editing the oblique plane, or
     *  when the user turns markers off — so the plane can be positioned without
     *  nudging a joint. */
    function jointsActive() {
      return showJoints && !obliqueEditing();
    }
    function applyJointVisibility() {
      if (handleGroup) handleGroup.visible = jointsActive();
      if (!jointsActive() && selected) deselect();
    }

    /** Sync the plane toggles + oblique gizmo to the current UI state. */
    function applyPlaneState() {
      if (!planes) return;
      planes.setCardinalVisible('sagittal', planeShown('sagittal'));
      planes.setCardinalVisible('frontal', planeShown('frontal'));
      planes.setCardinalVisible('transverse', planeShown('transverse'));
      planes.setObliqueVisible(planeShown('oblique'));
      if (obliqueDot) obliqueDot.visible = obliqueEditing();
      if (obliqueEditing()) {
        // The ring gizmo now serves the plane; clear any joint selection + show
        // all three rotation rings in their default colours.
        if (selected) deselect();
        ringGizmo.setRingColors({});
        ringGizmo.setHiddenRings([]);
      } else {
        obliqueRingDrag = null;
        ringGizmo.hide();
      }
      applyJointVisibility();
      requestRender();
    }

    /** Collect model materials (for clipping) + meshes (for the cap), and
     *  (re)build the section cap for the current model. */
    function collectClipTargets() {
      clipTargets = [];
      clipMeshes = [];
      if (!modelRoot) return;
      modelRoot.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        clipMeshes.push(mesh);
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) if (m) clipTargets.push(m);
      });
      sectionCap?.dispose();
      sectionCap = createSectionCap(clipMeshes, (_sphere.radius || 1) * 2.5);
      sectionCap.setVisible(false);
      scene.add(sectionCap.group);
    }

    /** Recompute the live clip plane from the active plane's current transform
     *  (so gizmo moves + the depth scrubber update the cut). Called each frame. */
    function refreshSlicePlane() {
      if (!planes || slice === 'off') return;
      planes.getClipPlane(slice, sliceClipPlane);
      if (sliceFlip) sliceClipPlane.negate();
      sectionCap?.setPlane(sliceClipPlane);
    }

    /** Attach/detach the clip plane to the model materials + scrub cardinal depth. */
    function applySlice() {
      if (planes) {
        const r = _sphere.radius || 1;
        for (const c of ['sagittal', 'frontal', 'transverse'] as const) {
          planes.setCardinalOffset(c, slice === c ? sliceDepth * r : 0);
        }
      }
      const on = slice !== 'off';
      if (on) refreshSlicePlane();
      for (const m of clipTargets) {
        m.clippingPlanes = on ? [sliceClipPlane] : [];
        m.clipShadows = on;
      }
      if (sectionCap) {
        sectionCap.setVisible(on && sliceCap);
        if (on) sectionCap.setColor(PLANE_COLOR[slice] ?? 0xffb020);
      }
      applyPlaneState();
      requestRender();
    }

    /** Build the planes + oblique centre-dot handle once, on first model load. */
    function ensurePlanes() {
      if (planes) return;
      planes = createAnatomicalPlanes();
      scene.add(planes.group);
      obliqueDot = new THREE.Mesh(
        handleGeo,
        new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      obliqueDot.renderOrder = 999;
      obliqueHit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      obliqueDot.add(obliqueHit);
      obliqueDot.visible = false;
      scene.add(obliqueDot);
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
        ensurePlanes();
        planes?.setExtents(_sphere.center, _sphere.radius);
        collectClipTargets();
        applySlice();
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
      // Oblique-plane editing: rotate via the ring gizmo, translate via the
      // centre dot — the same controls as joints. While active, joints are
      // ignored entirely so they can't be moved by accident.
      if (obliqueEditing() && planes && obliqueHit) {
        const node = planes.oblique;
        node.getWorldPosition(_ringPos);
        node.getWorldQuaternion(_ringQuat);
        const drag = ringGizmo.beginDrag(raycaster, {
          centerWorld: _ringPos,
          frameQuat: _ringQuat,
          boneLocalQuat: node.quaternion,
          parentWorldQuat: (node.parent ?? node).getWorldQuaternion(_ringQuat2),
        });
        if (drag) {
          obliqueRingDrag = drag;
          controls.enabled = false;
          e.preventDefault();
          return;
        }
        if (raycaster.intersectObject(obliqueHit, false)[0]) {
          node.getWorldPosition(_v);
          camera.getWorldDirection(_camDir);
          _dragPlane.setFromNormalAndCoplanarPoint(_camDir, _v);
          obliquePress = { startX: e.clientX, startY: e.clientY, dragging: false };
          controls.enabled = false;
          e.preventDefault();
          return;
        }
        return;
      }
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
      // Oblique plane: rotate (ring) or translate (centre dot on a camera-facing
      // plane, like the joint IK drag).
      if (obliqueRingDrag && planes) {
        setNdc(e);
        raycaster.setFromCamera(_ndc, camera);
        planes.oblique.quaternion.copy(obliqueRingDrag.update(raycaster));
        requestRender();
        e.preventDefault();
        return;
      }
      if (obliquePress && planes) {
        if (!obliquePress.dragging) {
          if (Math.hypot(e.clientX - obliquePress.startX, e.clientY - obliquePress.startY) < 5) return;
          obliquePress.dragging = true;
        }
        setNdc(e);
        raycaster.setFromCamera(_ndc, camera);
        if (raycaster.ray.intersectPlane(_dragPlane, _dragTarget)) {
          planes.oblique.position.copy(_dragTarget);
          requestRender();
        }
        e.preventDefault();
        return;
      }
      // Ring rotate drag: spin the joint to follow the cursor sweep.
      if (ringDrag && selected && modelRoot) {
        setNdc(e);
        raycaster.setFromCamera(_ndc, camera);
        const target = ringDrag.update(raycaster);
        const fc = fingerCurls?.get(selected.key);
        if (applyPoseCurveChain(selected.key, target)) {
          // region curve (spine/neck) distributed the bend across its chain
        } else if (ringDrag.axis === 'Y' && applyProSup(selected.key, target)) {
          // coupled forearm↔hand pronation/supination (1:1, twist ring only)
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
      if (obliqueRingDrag || obliquePress) {
        obliqueRingDrag = null;
        obliquePress = null;
        controls.enabled = true;
        return;
      }
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
      if (slice !== 'off') {
        refreshSlicePlane(); // live-track gizmo moves + depth
        if (sliceCap && sectionCap) sectionCap.update();
      }
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
      focus: () => focusSelected(),
      setPlanes: () => applyPlaneState(),
      setSlice: () => applySlice(),
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(playRaf);
      cancelAnimationFrame(orbitRaf);
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
      if (obliqueDot) {
        scene.remove(obliqueDot);
        (obliqueDot.material as THREE.Material).dispose?.();
        (obliqueHit?.material as THREE.Material | undefined)?.dispose?.();
      }
      planes?.dispose();
      sectionCap?.dispose();
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
  $effect(() => {
    void showSagittal;
    void showFrontal;
    void showTransverse;
    void showOblique;
    void showJoints;
    api?.setPlanes();
  });
  $effect(() => {
    void slice;
    void sliceFlip;
    void sliceDepth;
    void sliceCap;
    api?.setSlice();
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

    <div class="lab__row">
      <span class="lab__label">Anatomical planes</span>
    </div>
    <div class="lab__row">
      <label class="lab__check lab__check--sagittal"><input type="checkbox" bind:checked={showSagittal} /> Sagittal</label>
      <label class="lab__check lab__check--frontal"><input type="checkbox" bind:checked={showFrontal} /> Frontal</label>
      <label class="lab__check lab__check--transverse"><input type="checkbox" bind:checked={showTransverse} /> Transverse</label>
      <label class="lab__check lab__check--oblique"><input type="checkbox" bind:checked={showOblique} /> Oblique</label>
    </div>
    <div class="lab__row">
      <label class="lab__check"><input type="checkbox" bind:checked={showJoints} /> Joint markers</label>
      {#if obliqueActive}<span class="lab__hint-inline">Oblique: drag the dot to move · grab a ring to tilt · joints hidden</span>{/if}
    </div>

    <div class="lab__row">
      <span class="lab__label">Cross-section slice</span>
    </div>
    <div class="lab__row lab__slice">
      <select bind:value={slice}>
        <option value="off">Off</option>
        <option value="sagittal">Sagittal</option>
        <option value="frontal">Frontal</option>
        <option value="transverse">Transverse</option>
        <option value="oblique">Oblique</option>
      </select>
      {#if slice !== 'off'}
        <label class="lab__check"><input type="checkbox" bind:checked={sliceFlip} /> Flip side</label>
        <label class="lab__check"><input type="checkbox" bind:checked={sliceCap} /> Solid cap</label>
      {/if}
    </div>
    {#if slice !== 'off' && slice !== 'oblique'}
      <div class="lab__row lab__slice">
        <span class="lab__label">Depth</span>
        <input type="range" min="-1" max="1" step="0.01" bind:value={sliceDepth} />
      </div>
    {/if}

    <div class="lab__row lab__btns">
      <button onclick={() => api?.reset()}>Reset to anatomic</button>
      <button onclick={() => api?.playPose()}>{playing ? 'Stop ■' : 'Play pose ▶'}</button>
      <button onclick={() => api?.copyPose()}>{copied ? 'Copied ✓' : 'Copy pose JSON'}</button>
    </div>

    <div class="lab__sel">
      <span class="lab__label">Selected joint</span>
      <strong>{selectedLabel ?? '— click a dot —'}</strong>
      {#if selectedKey}
        <code class="lab__key">{selectedKey}</code>
        <button class="lab__focus" onclick={() => api?.focus()}>Focus camera</button>
      {/if}
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
  /* Colour chip per plane, matching the 3D plane colours. */
  .lab__check--sagittal,
  .lab__check--frontal,
  .lab__check--transverse,
  .lab__check--oblique {
    position: relative;
    padding-left: 0.1rem;
  }
  .lab__check--sagittal::after,
  .lab__check--frontal::after,
  .lab__check--transverse::after,
  .lab__check--oblique::after {
    content: '';
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 2px;
    margin-left: 0.05rem;
  }
  .lab__check--sagittal::after { background: #ff3653; }
  .lab__check--frontal::after { background: #2c8fff; }
  .lab__check--transverse::after { background: #8adb00; }
  .lab__check--oblique::after { background: #ffb020; }
  .lab__hint-inline {
    font-size: 0.66rem;
    color: rgba(255, 255, 255, 0.45);
    line-height: 1.3;
  }
  .lab__slice {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }
  .lab__slice select {
    flex: 1;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px;
    padding: 0.3rem;
  }
  .lab__slice input[type='range'] {
    flex: 1;
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
  .lab__focus {
    display: inline-block;
    margin-top: 0.4rem;
    padding: 0.28rem 0.6rem;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.7rem;
    cursor: pointer;
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
