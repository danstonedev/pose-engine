/**
 * OPT-IN POSING LAYER (simMOVE unified studio) — extracted from ExamStage3D.
 *
 * Mounts the modular posing services PoseLab uses on the STAGE's skeleton, so
 * hand posing, motion playback, recordings, and the AI command surface all
 * share one mannequin and one continuity state (`currentPose`). Only ever
 * constructed for a `posable` host — default consumers never load this module,
 * which is why the stage reaches it through a dynamic import: the whole
 * TransformControls / gizmo / slicing / plane stack stays out of their bundle.
 *
 * The layer owns a lot of interaction state (selection, drags, gizmos, twist
 * rig, planes, section cap, pose-play preview) but touches the stage through a
 * narrow {@link PosingLayerContext}: live getters for the rig + driver state it
 * must observe, plain callbacks for the stage behaviour it must trigger, and a
 * single `setCurrentPose` for the one piece of stage state it writes. It
 * returns its lifecycle {@link PosingLayerHooks} and the host-facing
 * {@link StagePoseApi} rather than assigning stage variables, so ownership runs
 * one way and the stage stays the composition root.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  applyCustomPose,
  blendCustomPoseWithBaseline,
  buildIKChainContext,
  disposeIKChainContext,
  distributeChainCurve,
  pinBonesToRestWorld,
  readAxialTwist,
  serializeCustomPose,
  setAxialTwist,
  solveIKChain,
} from './poseRig';
import type { IKChainContext } from './poseRig';
import { clampBoneToRom, hasClampStrategy, isHingeJoint, setRomClampEnabled } from './poseRomClamp';
import { computeDrivingRingMap, gizmoSpaceForJoint } from './jointAngles';
import { clampFingerCurlToRom } from './poseFingerRomClamp';
import { configureRingRotateGizmo, hiddenRingsForJoint } from './poseGizmoHelpers';
import { PoseRotateRingGizmo } from './poseRotateRings';
import type { PoseRingDrag } from './poseRotateRings';
import { PoseClickDeselect } from './poseClickDeselect';
import { applyTwistRig, buildTwistRig } from './twistRig';
import type { TwistSegment } from './twistRig';
import { ALL_LIMB_IDS, buildLimbAxisModel } from './limbAxisModel';
import { createAnatomicalPlanes } from './anatomicalPlanes';
import type { AnatomicalPlanes } from './anatomicalPlanes';
import { createSectionCap } from './sectionCap';
import type { SectionCap } from './sectionCap';
import type { DrivingRingMap, JointAngleReport } from './jointAngles';
import { getRomJointDefinition, type RomPlane } from './romRegistry';
import type { RomScenarioConstraints } from './romConstraints';
import type { getBodyVariant } from '../anatomy/bodyVariants';
import type { captureJointAngleRestReference } from './jointAngles';
import type { createClinicalCameraControls } from './clinicalCameraControls';
import type { CustomPose, MovementClipId } from '../types';

// ── Host-facing option shapes (re-exported by ExamStage3D) ──────────────────

export interface StagePosingOptions {
  /** ROM-clamp hand posing to normative range (default true). */
  romClamp?: boolean;
  /** Coupled forearm/hand twist distribution while posing (default true). */
  twistRig?: boolean;
  /** Show the clickable joint markers (default true). */
  showJoints?: boolean;
  /** Show the per-limb axis overlay (default false). */
  showAxes?: boolean;
}
export interface StagePlaneVisibility {
  sagittal?: boolean;
  frontal?: boolean;
  transverse?: boolean;
  oblique?: boolean;
}
export interface StageSliceOptions {
  plane: 'off' | 'sagittal' | 'frontal' | 'transverse' | 'oblique';
  flip?: boolean;
  /** Solid stencil cap on the cut (default true). */
  cap?: boolean;
  /** Cardinal-plane slice depth, −1..1 of the model radius (default 0). */
  depth?: number;
}

/** The posing surface the host drives through the stage's exported functions. */
export interface StagePoseApi {
  getPose: () => CustomPose | null;
  loadPose: (pose: CustomPose) => void;
  resetPose: () => void;
  togglePosePlay: () => boolean;
  focusSelectedJoint: () => void;
  deselectJoint: () => void;
  setPosingOptions: (opts: StagePosingOptions) => void;
  setPlanes: (planes: StagePlaneVisibility) => void;
  setSlice: (slice: StageSliceOptions) => void;
  exportAnimationGlb: (
    frames: { t: number; pose: CustomPose }[],
    name: string,
    rootMotion?: boolean,
  ) => Promise<void>;
}

/** Lifecycle callbacks the stage core drives each frame / at each takeover. */
export interface PosingLayerHooks {
  /** Another driver is taking the skeleton — drop drags, IK, plants, selection. */
  onTakeover(): void;
  /** A new model finished loading — rebuild every rig-derived cache. */
  onModelLoaded(): void;
  /** Before the stage renders: twist distribution, handles, gizmo, slice. */
  beforeRender(): void;
  /** After the stage renders: the depth-cleared rotate-ring overlay pass. */
  afterRender(): void;
  /** True while the layer is ENGAGED (idle liveliness suspends). */
  busy(): boolean;
  /** Tear down listeners, gizmos, overlays. */
  dispose(): void;
}

export interface PosingLayer {
  hooks: PosingLayerHooks;
  api: StagePoseApi;
}

/**
 * The stage as the posing layer sees it. Everything the layer only OBSERVES is
 * a getter (the stage reassigns these on reload / per frame, so a snapshot
 * would go stale); everything it TRIGGERS is a plain callback.
 */
export interface PosingLayerContext {
  // ── live rig + driver state (observed) ──
  readonly skinnedRef: THREE.SkinnedMesh | null;
  readonly variantCfgRef: ReturnType<typeof getBodyVariant> | null;
  readonly restRef: ReturnType<typeof captureJointAngleRestReference> | null;
  readonly baselinePoseRef: CustomPose | null;
  readonly modelRoot: THREE.Object3D | null;
  readonly motionCapBones: Map<string, THREE.Bone> | null;
  readonly motionCapKeys: string[];
  readonly modelCenter: THREE.Vector3;
  readonly modelRadius: number;
  readonly activeMotionId: MovementClipId | null;
  readonly activeTween: object | null;
  readonly composedActive: boolean;
  readonly mixer: THREE.AnimationMixer | null;
  readonly disposed: boolean;
  readonly romConstraints: RomScenarioConstraints | null;
  // ── stable scene handles ──
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  controls: ReturnType<typeof createClinicalCameraControls>['controls'];
  cam: ReturnType<typeof createClinicalCameraControls>;
  // ── stage behaviour the layer triggers ──
  requestRender(): void;
  startLoop(): void;
  measureNow(): JointAngleReport | null;
  applyPoseNow(pose: CustomPose | null): void;
  cancelComposed(): void;
  finishTween(): void;
  stopMotion(): void;
  resetRootToRest(): void;
  undoIdleOverlays(): boolean;
  undoEyeGaze(): boolean;
  /** The ONE piece of stage state the layer writes (pose continuity). */
  setCurrentPose(pose: CustomPose | null): void;
  onReport?: (report: JointAngleReport) => void;
  onSelectJoint?: (key: string | null) => void;
}

/**
 * Build the posing layer on the stage's scene. Returns null when the stage was
 * disposed while this module loaded — the stage treats that exactly as the old
 * inline `if (disposed) return;` did and aborts the rest of its boot.
 */
export function createPosingLayer(stageCtx: PosingLayerContext): PosingLayer | null {
  const {
    renderer,
    camera,
    scene,
    controls,
    cam,
    requestRender,
    startLoop,
    measureNow,
    applyPoseNow,
    cancelComposed,
    finishTween,
    stopMotion,
    resetRootToRest,
    undoIdleOverlays,
    undoEyeGaze,
    onReport,
    onSelectJoint,
  } = stageCtx;

  if (stageCtx.disposed) return null;

  // Cross-section slicing needs local clipping planes.
  renderer.localClippingEnabled = true;

  // ── Posing behaviour / overlay state (host-set via the exports) ──
  let poseRomClampOn = true;
  let poseTwistOn = true;
  let poseShowJoints = true;
  let poseShowAxes = false;
  const planeVis = { sagittal: false, frontal: false, transverse: false, oblique: false };
  const sliceState: {
    plane: 'off' | 'sagittal' | 'frontal' | 'transverse' | 'oblique';
    flip: boolean;
    cap: boolean;
    depth: number;
  } = { plane: 'off', flip: false, cap: true, depth: 0 };

  /** Region curve handles distribute their bend across a 2-bone chain. */
  const POSE_CURVE_CHAINS: Record<string, { keys: string[]; control: number }> = {
    Spine_Upper: { keys: ['Spine_Mid', 'Spine_Upper'], control: 1 },
    Neck: { keys: ['Neck_Lower', 'Neck'], control: 1 },
  };
  /** Knees stay hinge-locked while the feet are pinned during a pelvis tilt. */
  const POSE_PLANT_HINGES = new Set(['L_Leg', 'R_Leg']);
  /** Coupled pronation/supination keys (forearm ↔ hand, ±45° per segment). */
  const PROSUP_KEYS = new Set(['L_Forearm', 'R_Forearm', 'L_Hand', 'R_Hand']);
  const PROSUP_SEG_LIMIT_RAD = (45 * Math.PI) / 180;
  /** Plane → ring colour: sagittal red, frontal blue, transverse green. */
  const POSE_PLANE_RING_HEX: Record<RomPlane, number> = {
    sagittal: 0xff3653,
    frontal: 0x2c8fff,
    transverse: 0x8adb00,
  };
  /** Bright cross-section colour per plane (matches the plane visuals). */
  const PLANE_COLOR: Record<string, number> = {
    sagittal: 0xff3653,
    frontal: 0x2c8fff,
    transverse: 0x8adb00,
    oblique: 0xffb020,
  };
  const LIMB_COLORS: Record<string, number> = {
    'left-upper-extremity': 0x60a5fa,
    'right-upper-extremity': 0x34d399,
    'left-lower-extremity': 0xfb923c,
    'right-lower-extremity': 0xf472b6,
    'axial-spine': 0xa78bfa,
  };

  // FK rotate gizmo: TC keeps only its camera-space 'E' ring; the shared
  // PoseRotateRingGizmo draws + grabs the X/Y/Z plane rings.
  const tc = new TransformControls(camera, renderer.domElement);
  tc.setMode('rotate');
  tc.size = 0.675; // MUST match the ring gizmo size
  tc.enabled = false;
  const tcHelper = tc.getHelper();
  tcHelper.visible = false;
  configureRingRotateGizmo(tcHelper);
  tcHelper.traverse((o) => (o.renderOrder = 1000));
  scene.add(tcHelper);
  const ringGizmo = new PoseRotateRingGizmo({ size: 0.675 });
  const clickDeselect = new PoseClickDeselect(5);

  type PoseHandle = {
    key: string;
    bone: import('three').Bone;
    mesh: import('three').Mesh;
    hit: import('three').Mesh;
    type: 'fk' | 'ik-effector';
    chain: number;
  };
  let poseHandles: PoseHandle[] = [];
  let handleGroup: import('three').Group | null = null;
  let selected: PoseHandle | null = null;
  let axesGroup: import('three').Group | null = null;
  let reverseBoneMap: Map<import('three').Object3D, string> | null = null;
  let press: { handle: PoseHandle; startX: number; startY: number; dragging: boolean } | null =
    null;
  let ikCtx: IKChainContext | null = null;
  let ringDrag: PoseRingDrag | null = null;
  let drivingRings: DrivingRingMap | null = null;
  let twistRig: TwistSegment[] = [];
  let fingerCurls: Map<
    string,
    { bones: import('three').Object3D[]; rest: import('three').Quaternion[] }
  > | null = null;
  let pelvisPlant: { ctx: IKChainContext; pos: import('three').Vector3 }[] | null = null;
  const _plantFootBones: import('three').Object3D[] = [];
  const _plantFootQuats: import('three').Quaternion[] = [];
  let planes: AnatomicalPlanes | null = null;
  let obliqueDot: import('three').Mesh | null = null;
  let obliqueHit: import('three').Mesh | null = null;
  let obliqueRingDrag: PoseRingDrag | null = null;
  let obliquePress: { startX: number; startY: number; dragging: boolean } | null = null;
  const sliceClipPlane = new THREE.Plane();
  let clipTargets: import('three').Material[] = [];
  let clipMeshes: import('three').Mesh[] = [];
  let sectionCap: SectionCap | null = null;
  const handleGeo = new THREE.SphereGeometry(0.022, 14, 10);
  const hitGeo = new THREE.SphereGeometry(0.06, 10, 8);
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _v = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _dragPlane = new THREE.Plane();
  const _dragTarget = new THREE.Vector3();
  const _ringPos = new THREE.Vector3();
  const _ringQuat = new THREE.Quaternion();
  const _ringQuat2 = new THREE.Quaternion();

  // ── Pose-motion preview (baseline ↔ current, smoothstep triangle) ──
  let posePlayActive = false;
  let posePlayRaf = 0;
  let posePlayPosed: CustomPose | null = null;
  const POSE_PLAY_DUR = 700;

  /** Posing is suspended while ANYTHING else drives the skeleton. A
   *  paused recording frame sets none of these → posable idle time. */
  const posingSuspended = () =>
    !!stageCtx.activeMotionId || stageCtx.composedActive || !!stageCtx.activeTween || posePlayActive;

  /** ROM-clamp a bone for HAND POSING without disturbing the motion-cap
   *  clamp override machinery (which stopMotion/setMotionRomCaps own). */
  function poseClamp(bone: import('three').Bone, key: string): boolean {
    if (!poseRomClampOn || !stageCtx.restRef || !hasClampStrategy(key)) return false;
    setRomClampEnabled(true);
    const changed = clampBoneToRom(bone, key, stageCtx.restRef, stageCtx.romConstraints ?? null);
    setRomClampEnabled(stageCtx.motionCapKeys.length ? true : null);
    return changed;
  }

  /** Fold the hand-posed skeleton into the stage's continuity state so
   *  the next motion/command starts from — and captureFrame bakes —
   *  exactly what was posed. */
  function commitPosedState(): void {
    if (!stageCtx.skinnedRef || !stageCtx.variantCfgRef) return;
    // Belt-and-braces: idle liveliness suspends while the layer is
    // engaged, but a same-frame press→release could still commit with
    // deltas baked — lift them so the committed pose is always clean.
    undoIdleOverlays();
    undoEyeGaze(); // committed poses carry the eyes at rest
    stageCtx.modelRoot?.updateMatrixWorld(true);
    stageCtx.setCurrentPose(serializeCustomPose(stageCtx.skinnedRef.skeleton, stageCtx.variantCfgRef, stageCtx.variantCfgRef.id));
  }

  // Live angle streaming while posing (~30Hz + forced at settle) — the
  // same onReport contract motion playback uses.
  let lastPoseReport = 0;
  function reportPosing(force = false): void {
    if (!onReport) return;
    const nowMs = performance.now();
    if (!force && nowMs - lastPoseReport < 33) return;
    lastPoseReport = nowMs;
    const report = measureNow();
    if (report) onReport(report);
  }

  function obliqueEditing(): boolean {
    return planeVis.oblique || sliceState.plane === 'oblique';
  }
  function jointsActive(): boolean {
    return poseShowJoints && !obliqueEditing() && !posingSuspended();
  }

  /** Colour each plane ring by the motion it drives (via the driving-ring
   *  map), and drop the rings this joint must not offer — see
   *  `hiddenRingsForJoint` for which and why. */
  function applyPoseRingColors(key: string): void {
    const def = getRomJointDefinition(key);
    const dr = drivingRings?.[key];
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
    ringGizmo.setHiddenRings(hiddenRingsForJoint(key, dr, isHingeJoint));
  }

  /** Position the plane rings at the selected joint (or the oblique
   *  plane node while it is being edited). */
  function updateRingGizmo(): void {
    if (obliqueEditing() && planes && !posingSuspended()) {
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

  /** ROM-clamp a digit's COMPOSITE curl, after `distributeChainCurve` has
   *  spread the drag along its phalanges. The math, and the reason it cannot be
   *  a `clampBoneToRom` strategy, are in `poseFingerRomClamp.ts`; this host
   *  supplies the bone lookup, the rest reference, and the world-matrix refresh
   *  the measurement needs. */
  function clampFingerCurl(
    key: string,
    fc: { bones: import('three').Object3D[]; rest: import('three').Quaternion[] },
    target: import('three').Quaternion,
  ): void {
    if (!poseRomClampOn || !stageCtx.motionCapBones || !stageCtx.modelRoot) return;
    const modelRoot = stageCtx.modelRoot;
    clampFingerCurlToRom(key, fc, target, stageCtx.motionCapBones, stageCtx.restRef, {
      constraints: stageCtx.romConstraints ?? null,
      updateWorldMatrices: () => modelRoot.updateMatrixWorld(true),
    });
  }

  /** Capture each finger's MCP→PIP→DIP chain + rest rotations. */
  function buildFingerCurls(): void {
    fingerCurls = new Map();
    for (const h of poseHandles) {
      if (!/(Thumb1|Index1|Mid1|Ring1|Pinky1)$/.test(h.key)) continue;
      const bones: import('three').Object3D[] = [h.bone];
      let node: import('three').Object3D = h.bone;
      for (let i = 0; i < 2; i++) {
        const next = node.children.find((c) => (c as import('three').Bone).isBone);
        if (!next) break;
        bones.push(next);
        node = next;
      }
      fingerCurls.set(h.key, {
        bones,
        rest: bones.map((b) => (b as import('three').Bone).quaternion.clone()),
      });
    }
  }

  /** Region curve handles (spine/neck): spread the bend across a chain,
   *  ROM-clamping the REGIONAL total on the control bone first. */
  function applyPoseCurveChain(key: string, target: import('three').Quaternion): boolean {
    const chain = POSE_CURVE_CHAINS[key];
    if (!chain || !stageCtx.motionCapBones || !stageCtx.restRef) return false;
    const segs: import('three').Object3D[] = [];
    const rests: import('three').Quaternion[] = [];
    for (const k of chain.keys) {
      const b = stageCtx.motionCapBones.get(k);
      const rl = stageCtx.restRef.localQuats[k];
      if (!b || !rl) return false;
      segs.push(b);
      rests.push(new THREE.Quaternion(rl[0], rl[1], rl[2], rl[3]));
    }
    let clamped = target;
    const ctrl = stageCtx.motionCapBones.get(key);
    if (ctrl && poseRomClampOn && hasClampStrategy(key)) {
      ctrl.quaternion.copy(target);
      poseClamp(ctrl, key);
      clamped = ctrl.quaternion.clone();
    }
    distributeChainCurve(segs, rests, chain.control, clamped);
    return true;
  }

  /** Coupled pronation/supination: a twist (Y-ring) drag on the forearm
   *  OR hand drives ONE shared rotation split 1:1 across both segments. */
  function applyProSup(key: string, target: import('three').Quaternion): boolean {
    if (!PROSUP_KEYS.has(key) || !stageCtx.motionCapBones || !stageCtx.restRef) return false;
    const side = key.startsWith('L_') ? 'L_' : 'R_';
    const forearm = stageCtx.motionCapBones.get(`${side}Forearm`);
    const hand = stageCtx.motionCapBones.get(`${side}Hand`);
    const rfArr = stageCtx.restRef.localQuats[`${side}Forearm`];
    const rhArr = stageCtx.restRef.localQuats[`${side}Hand`];
    if (!forearm || !hand || !rfArr || !rhArr) return false;
    const restF = new THREE.Quaternion(rfArr[0], rfArr[1], rfArr[2], rfArr[3]);
    const restH = new THREE.Quaternion(rhArr[0], rhArr[1], rhArr[2], rhArr[3]);
    const selIsForearm = key.endsWith('Forearm');
    const sel = selIsForearm ? forearm : hand;
    const restSel = selIsForearm ? restF : restH;
    const twist = Math.max(
      -PROSUP_SEG_LIMIT_RAD,
      Math.min(PROSUP_SEG_LIMIT_RAD, readAxialTwist(target, restSel)),
    );
    sel.quaternion.copy(target);
    poseClamp(sel, key);
    setAxialTwist(sel, restSel, twist);
    const sib = selIsForearm ? hand : forearm;
    const restSib = selIsForearm ? restH : restF;
    setAxialTwist(sib, restSib, twist);
    return true;
  }

  /** On a Hips grab: snapshot each foot's world transform + an IK chain. */
  function capturePelvisPlant(): void {
    releasePelvisPlant();
    if (!stageCtx.skinnedRef || !stageCtx.variantCfgRef || !stageCtx.motionCapBones) return;
    const plant: { ctx: IKChainContext; pos: import('three').Vector3 }[] = [];
    for (const k of ['L_Foot', 'R_Foot']) {
      const foot = stageCtx.motionCapBones.get(k);
      if (!foot) continue;
      const ctx = buildIKChainContext(stageCtx.skinnedRef, foot, 2, stageCtx.variantCfgRef);
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
  function applyPelvisPlant(): void {
    if (!pelvisPlant) return;
    for (const leg of pelvisPlant) {
      solveIKChain(leg.ctx, leg.pos, { rest: stageCtx.restRef, hinges: POSE_PLANT_HINGES });
    }
    pinBonesToRestWorld(_plantFootBones, _plantFootQuats);
  }
  function releasePelvisPlant(): void {
    if (pelvisPlant) {
      for (const leg of pelvisPlant) disposeIKChainContext(leg.ctx);
      pelvisPlant = null;
    }
    _plantFootBones.length = 0;
    _plantFootQuats.length = 0;
  }

  function clearPoseHandles(): void {
    if (!handleGroup) return;
    scene.remove(handleGroup);
    handleGroup.traverse((o) => {
      const m = o as import('three').Mesh;
      if (m.material) (m.material as import('three').Material).dispose?.();
    });
    poseHandles = [];
    handleGroup = null;
  }

  function buildPoseHandles(): void {
    clearPoseHandles();
    if (!stageCtx.motionCapBones || !stageCtx.variantCfgRef) return;
    handleGroup = new THREE.Group();
    for (const h of stageCtx.variantCfgRef.poseRig.handles) {
      const bone = stageCtx.motionCapBones.get(h.canonicalKey);
      if (!bone) continue;
      const mesh = new THREE.Mesh(
        handleGeo,
        new THREE.MeshBasicMaterial({
          color: 0x57d46a,
          depthTest: false,
          transparent: true,
          opacity: 0.85,
        }),
      );
      mesh.renderOrder = 999;
      const hit = new THREE.Mesh(
        hitGeo,
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
      );
      mesh.add(hit);
      handleGroup.add(mesh);
      poseHandles.push({
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

  function updatePoseHandles(): void {
    const d = camera.position.distanceTo(controls.target);
    const s = Math.max(0.6, Math.min(2, d / 4));
    if (obliqueDot && obliqueDot.visible && planes) {
      planes.oblique.getWorldPosition(_v);
      obliqueDot.position.copy(_v);
      obliqueDot.scale.setScalar(s);
    }
    if (!handleGroup) return;
    for (const h of poseHandles) {
      h.bone.getWorldPosition(_v);
      h.mesh.position.copy(_v);
      h.mesh.scale.setScalar(s);
      const mat = h.mesh.material as import('three').MeshBasicMaterial;
      const sel = h === selected;
      mat.color.setHex(sel ? 0x4dd5ff : 0x57d46a);
      mat.opacity = sel ? 1 : 0.85;
    }
  }

  function clearAxes(): void {
    if (!axesGroup) return;
    scene.remove(axesGroup);
    axesGroup.traverse((o) => {
      const m = o as import('three').Mesh;
      m.geometry?.dispose?.();
      if (m.material) (m.material as import('three').Material).dispose?.();
    });
    axesGroup = null;
  }
  function buildAxes(): void {
    clearAxes();
    if (!stageCtx.skinnedRef || !stageCtx.variantCfgRef) return;
    const model = buildLimbAxisModel(stageCtx.skinnedRef.skeleton, stageCtx.variantCfgRef, 0, 1);
    axesGroup = new THREE.Group();
    for (const limbId of ALL_LIMB_IDS) {
      const axis = model.axes[limbId];
      if (!axis || axis.points.length < 2) continue;
      const pts = axis.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const color = LIMB_COLORS[limbId] ?? 0xffffff;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color,
          depthTest: false,
          transparent: true,
          opacity: 0.9,
        }),
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

  /** A plane's quad is shown if its toggle is on, or it's the active
   *  slice in hollow mode (the cap replaces the quad when solid). */
  function planeShown(name: 'sagittal' | 'frontal' | 'transverse' | 'oblique'): boolean {
    const checked = planeVis[name];
    if (sliceState.plane === name) return sliceState.cap ? checked : true;
    return checked;
  }
  function applyJointVisibility(): void {
    if (handleGroup) handleGroup.visible = jointsActive();
    if (!jointsActive() && selected) deselectImpl();
  }
  function applyPlaneState(): void {
    if (!planes) return;
    planes.setCardinalVisible('sagittal', planeShown('sagittal'));
    planes.setCardinalVisible('frontal', planeShown('frontal'));
    planes.setCardinalVisible('transverse', planeShown('transverse'));
    planes.setObliqueVisible(planeShown('oblique'));
    if (obliqueDot) obliqueDot.visible = obliqueEditing();
    if (obliqueEditing()) {
      if (selected) deselectImpl();
      ringGizmo.setRingColors({});
      ringGizmo.setHiddenRings([]);
    } else {
      obliqueRingDrag = null;
      ringGizmo.hide();
    }
    applyJointVisibility();
    requestRender();
  }

  /** Collect model materials (clipping) + meshes (cap) for slicing. */
  function collectClipTargets(): void {
    clipTargets = [];
    clipMeshes = [];
    if (!stageCtx.modelRoot) return;
    stageCtx.modelRoot.traverse((o) => {
      const mesh = o as import('three').Mesh;
      if (!mesh.isMesh) return;
      clipMeshes.push(mesh);
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) if (m) clipTargets.push(m);
    });
    sectionCap?.dispose();
    sectionCap = createSectionCap(clipMeshes, (stageCtx.modelRadius || 1) * 2.5);
    sectionCap.setVisible(false);
    scene.add(sectionCap.group);
  }
  function refreshSlicePlane(): void {
    if (!planes || sliceState.plane === 'off') return;
    planes.getClipPlane(sliceState.plane, sliceClipPlane);
    if (sliceState.flip) sliceClipPlane.negate();
    sectionCap?.setPlane(sliceClipPlane);
  }
  function applySlice(): void {
    if (planes) {
      const r = stageCtx.modelRadius || 1;
      for (const c of ['sagittal', 'frontal', 'transverse'] as const) {
        planes.setCardinalOffset(c, sliceState.plane === c ? sliceState.depth * r : 0);
      }
    }
    const on = sliceState.plane !== 'off';
    if (on) refreshSlicePlane();
    for (const m of clipTargets) {
      m.clippingPlanes = on ? [sliceClipPlane] : [];
      m.clipShadows = on;
    }
    if (sectionCap) {
      sectionCap.setVisible(on && sliceState.cap);
      if (on) sectionCap.setColor(PLANE_COLOR[sliceState.plane] ?? 0xffb020);
    }
    applyPlaneState();
    requestRender();
  }
  function ensurePlanes(): void {
    if (planes) return;
    planes = createAnatomicalPlanes();
    scene.add(planes.group);
    obliqueDot = new THREE.Mesh(
      handleGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffb020,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    obliqueDot.renderOrder = 999;
    obliqueHit = new THREE.Mesh(
      hitGeo,
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    obliqueDot.add(obliqueHit);
    obliqueDot.visible = false;
    scene.add(obliqueDot);
  }

  // ── Selection ──────────────────────────────────────────────────────
  function selectHandle(h: PoseHandle): void {
    clickDeselect.cancel();
    selected = h;
    const space = gizmoSpaceForJoint(h.key);
    tc.setSpace(space);
    tc.attach(h.bone);
    tc.enabled = true;
    tcHelper.visible = true;
    applyPoseRingColors(h.key);
    updatePoseHandles();
    reportPosing(true);
    requestRender();
    onSelectJoint?.(h.key);
  }
  function deselectImpl(): void {
    const had = !!selected;
    selected = null;
    tc.detach();
    tc.enabled = false;
    tcHelper.visible = false;
    ringGizmo.hide();
    controls.enabled = true;
    updatePoseHandles();
    requestRender();
    if (had) onSelectJoint?.(null);
  }

  // ── TC (camera-space E ring) events ────────────────────────────────
  let tcDragging = false;
  tc.addEventListener('dragging-changed', (e) => {
    tcDragging = (e as unknown as { value: boolean }).value;
    controls.enabled = !tcDragging;
    if (!tcDragging) {
      commitPosedState();
      reportPosing(true);
    }
  });
  tc.addEventListener('change', () => {
    if (!selected || !tcDragging || !stageCtx.modelRoot) return;
    stageCtx.modelRoot.updateMatrixWorld(true);
    if (poseClamp(selected.bone, selected.key)) stageCtx.modelRoot.updateMatrixWorld(true);
    updatePoseHandles();
    reportPosing();
    requestRender();
  });

  // ── Pointer interaction (select / IK drag / ring rotate / oblique) ──
  function setNdc(e: PointerEvent): void {
    const r = renderer.domElement.getBoundingClientRect();
    _ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }
  function onPosePointerDown(e: PointerEvent): void {
    if (tcDragging || posingSuspended()) return;
    // A drag may capture chain/bone state synchronously below — lift any
    // idle-liveliness deltas first so posing starts from the clean pose.
    undoIdleOverlays();
    undoEyeGaze(); // eye deltas lift with it (re-baked live next frame)
    setNdc(e);
    raycaster.setFromCamera(_ndc, camera);
    // Oblique-plane editing owns the gizmo + centre dot while active.
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
    if (!handleGroup || !handleGroup.visible) return;
    // Ring rotate grab has PRIORITY over marker picking.
    if (ringGizmo.visible && selected) {
      selected.bone.getWorldPosition(_ringPos);
      if (gizmoSpaceForJoint(selected.key) === 'world') _ringQuat.identity();
      else selected.bone.getWorldQuaternion(_ringQuat);
      const drag = ringGizmo.beginDrag(raycaster, {
        centerWorld: _ringPos,
        frameQuat: _ringQuat,
        boneLocalQuat: selected.bone.quaternion,
        parentWorldQuat: (selected.bone.parent ?? selected.bone).getWorldQuaternion(
          _ringQuat2,
        ),
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
      poseHandles.flatMap((h) => [h.mesh, h.hit]),
      false,
    )[0];
    if (!hit) {
      if (selected) clickDeselect.arm(e.pointerId, e.clientX, e.clientY);
      return;
    }
    const h = poseHandles.find((x) => x.mesh === hit.object || x.hit === hit.object);
    if (!h) return;
    selectHandle(h);
    if (h.type === 'ik-effector') {
      h.bone.getWorldPosition(_v);
      camera.getWorldDirection(_camDir);
      _dragPlane.setFromNormalAndCoplanarPoint(_camDir, _v);
      press = { handle: h, startX: e.clientX, startY: e.clientY, dragging: false };
      controls.enabled = false;
    }
  }
  function onPosePointerMove(e: PointerEvent): void {
    clickDeselect.handleMove(e.pointerId, e.clientX, e.clientY);
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
        if (Math.hypot(e.clientX - obliquePress.startX, e.clientY - obliquePress.startY) < 5)
          return;
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
    if (ringDrag && selected && stageCtx.modelRoot) {
      setNdc(e);
      raycaster.setFromCamera(_ndc, camera);
      const target = ringDrag.update(raycaster);
      const fc = fingerCurls?.get(selected.key);
      if (applyPoseCurveChain(selected.key, target)) {
        // spine/neck region curve distributed across its chain
      } else if (ringDrag.axis === 'Y' && applyProSup(selected.key, target)) {
        // coupled forearm↔hand pronation/supination
      } else if (fc) {
        distributeChainCurve(fc.bones, fc.rest, 0, target); // finger curl
        clampFingerCurl(selected.key, fc, target);
      } else if (selected.key === 'Hips') {
        selected.bone.quaternion.copy(target);
        // Clamp BEFORE planting, so the legs solve against the pelvis the user
        // is actually left with. The pelvis is the one clamped joint whose drag
        // used to skip `poseClamp` outright — it has a `pelvis` strategy and a
        // ROM row (tilt ±30, lateral ±20, rotation ±30), and `applyCustomPose`
        // clamps it on the way back in, so the drag was the only place the two
        // disagreed: you could tilt past the limit and watch it snap on reload.
        poseClamp(selected.bone, selected.key);
        stageCtx.modelRoot.updateMatrixWorld(true);
        applyPelvisPlant(); // keep feet planted while tilting the pelvis
      } else {
        selected.bone.quaternion.copy(target);
        poseClamp(selected.bone, selected.key);
      }
      stageCtx.modelRoot.updateMatrixWorld(true);
      updatePoseHandles();
      reportPosing();
      requestRender();
      e.preventDefault();
      return;
    }
    if (!press || tcDragging || !stageCtx.modelRoot) return;
    if (!press.dragging) {
      if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < 5) return;
      press.dragging = true;
    }
    setNdc(e);
    raycaster.setFromCamera(_ndc, camera);
    if (!raycaster.ray.intersectPlane(_dragPlane, _dragTarget)) return;
    if (!ikCtx && stageCtx.skinnedRef && stageCtx.variantCfgRef) {
      ikCtx = buildIKChainContext(stageCtx.skinnedRef, press.handle.bone, press.handle.chain, stageCtx.variantCfgRef);
    }
    if (!ikCtx) return;
    solveIKChain(ikCtx, _dragTarget);
    // ROM-clamp the solved chain (effector up through its parents).
    if (stageCtx.restRef && poseRomClampOn && reverseBoneMap) {
      let b: import('three').Object3D | null = press.handle.bone;
      for (let i = 0; i <= press.handle.chain && b; i++) {
        const key = reverseBoneMap.get(b);
        if (key) poseClamp(b as import('three').Bone, key);
        const parent: import('three').Object3D | null = b.parent;
        if (!parent || !(parent as import('three').Bone).isBone) break;
        b = parent;
      }
    }
    stageCtx.modelRoot.updateMatrixWorld(true);
    updatePoseHandles();
    reportPosing();
    requestRender();
  }
  function onPosePointerUp(e: PointerEvent): void {
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
      commitPosedState();
      reportPosing(true);
      return;
    }
    if (ikCtx) {
      disposeIKChainContext(ikCtx);
      ikCtx = null;
    }
    if (press) {
      const dragged = press.dragging;
      press = null;
      controls.enabled = true;
      if (dragged) {
        commitPosedState();
        reportPosing(true);
      }
    }
    if (clickDeselect.shouldDeselect(e.pointerId)) deselectImpl();
  }
  function onPoseKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') deselectImpl();
  }
  renderer.domElement.addEventListener('pointerdown', onPosePointerDown);
  window.addEventListener('pointermove', onPosePointerMove);
  window.addEventListener('pointerup', onPosePointerUp);
  window.addEventListener('pointercancel', onPosePointerUp);
  window.addEventListener('keydown', onPoseKey);

  // ── Pose-motion preview (baseline ↔ current) ───────────────────────
  function stopPosePlay(restore = true): void {
    if (!posePlayActive) {
      posePlayPosed = null;
      return;
    }
    cancelAnimationFrame(posePlayRaf);
    posePlayActive = false;
    if (posePlayPosed) {
      stageCtx.setCurrentPose(posePlayPosed);
      if (restore) {
        applyPoseNow(posePlayPosed);
        stageCtx.modelRoot?.updateMatrixWorld(true);
        requestRender();
      }
    }
    posePlayPosed = null;
  }
  function togglePosePlayImpl(): boolean {
    if (posePlayActive) {
      stopPosePlay();
      return false;
    }
    if (!stageCtx.skinnedRef || !stageCtx.variantCfgRef || !stageCtx.baselinePoseRef || posingSuspended()) return false;
    deselectImpl();
    // The preview snapshot must be the CLEAN pose, never an idle delta.
    undoEyeGaze(); // nor a baked eye delta
    undoIdleOverlays();
    posePlayPosed = serializeCustomPose(stageCtx.skinnedRef.skeleton, stageCtx.variantCfgRef, stageCtx.variantCfgRef.id);
    posePlayActive = true;
    const start = performance.now();
    const tick = () => {
      if (!posePlayActive) return;
      const phase = ((performance.now() - start) % (2 * POSE_PLAY_DUR)) / POSE_PLAY_DUR;
      const tri = phase <= 1 ? phase : 2 - phase; // 0..1..0
      const eased = tri * tri * (3 - 2 * tri); // smoothstep
      const blended = blendCustomPoseWithBaseline(
        stageCtx.baselinePoseRef,
        posePlayPosed,
        stageCtx.baselinePoseRef,
        eased,
      );
      if (blended && stageCtx.skinnedRef && stageCtx.variantCfgRef) {
        applyCustomPose(stageCtx.skinnedRef.skeleton, stageCtx.variantCfgRef, blended);
        stageCtx.modelRoot?.updateMatrixWorld(true);
        reportPosing();
        requestRender();
      }
      posePlayRaf = requestAnimationFrame(tick);
    };
    tick();
    return true;
  }

  /** Rotation-track decimation (slerp-reproducible keys dropped) so the
   *  exported clip stays small even when resampled to bake easing. */
  function decimateQuatTrack(
    times: number[],
    values: number[],
    tolDeg = 1,
  ): { times: number[]; values: number[] } {
    const n = times.length;
    if (n <= 2) return { times, values };
    const tol = (tolDeg * Math.PI) / 180;
    const qa = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    const qk = new THREE.Quaternion();
    const qi = new THREE.Quaternion();
    const get = (i: number, o: import('three').Quaternion) =>
      o.set(values[i * 4]!, values[i * 4 + 1]!, values[i * 4 + 2]!, values[i * 4 + 3]!);
    const keep = [0];
    let last = 0;
    for (let i = 1; i < n - 1; i++) {
      get(last, qa);
      get(i + 1, qb);
      const frac = (times[i]! - times[last]!) / (times[i + 1]! - times[last]! || 1);
      qk.copy(qa).slerp(qb, frac);
      get(i, qi);
      if (qk.angleTo(qi) > tol) {
        keep.push(i);
        last = i;
      }
    }
    keep.push(n - 1);
    const nt: number[] = [];
    const nv: number[] = [];
    for (const idx of keep) {
      nt.push(times[idx]!);
      nv.push(values[idx * 4]!, values[idx * 4 + 1]!, values[idx * 4 + 2]!, values[idx * 4 + 3]!);
    }
    return { times: nt, values: nv };
  }

  // ── Lifecycle hooks the stage core calls ──────────────────────────
  const onTakeover = () => {
    ringDrag = null;
    press = null;
    obliqueRingDrag = null;
    obliquePress = null;
    if (ikCtx) {
      disposeIKChainContext(ikCtx);
      ikCtx = null;
    }
    releasePelvisPlant();
    stopPosePlay(false); // the incoming motion owns the skeleton
    if (selected) deselectImpl();
    controls.enabled = true;
  };

  const onModelLoaded = () => {
    onTakeover();
    reverseBoneMap = new Map();
    if (stageCtx.motionCapBones) for (const [k, b] of stageCtx.motionCapBones) reverseBoneMap.set(b, k);
    drivingRings = stageCtx.restRef ? computeDrivingRingMap(stageCtx.restRef) : null;
    twistRig =
      stageCtx.skinnedRef && stageCtx.variantCfgRef ? buildTwistRig(stageCtx.skinnedRef.skeleton, stageCtx.variantCfgRef) : [];
    buildPoseHandles();
    buildFingerCurls();
    if (poseShowAxes) buildAxes();
    else clearAxes();
    ensurePlanes();
    planes?.setExtents(stageCtx.modelCenter, stageCtx.modelRadius);
    collectClipTargets();
    applySlice();
  };

  const beforeRender = () => {
    const suspended = posingSuspended();
    if (suspended && selected) deselectImpl();
    if (handleGroup) handleGroup.visible = jointsActive();
    if (obliqueDot) obliqueDot.visible = obliqueEditing() && !suspended;
    // Twist distribution only while posing owns the skeleton — a stageCtx.mixer
    // clip / tween must never be post-processed by the pose twist rig.
    if (poseTwistOn && twistRig.length && !suspended) {
      applyTwistRig(twistRig);
      stageCtx.modelRoot?.updateMatrixWorld(true);
    }
    updatePoseHandles();
    updateRingGizmo();
    if (sliceState.plane !== 'off') {
      refreshSlicePlane(); // live-track gizmo moves + motion + depth
      if (sliceState.cap && sectionCap) sectionCap.update();
    }
  };
  const afterRender = () => {
    ringGizmo.render(renderer, camera);
  };
  // Idle liveliness suspends while the layer is ENGAGED — a selected
  // joint (rings up), an in-flight marker/ring/oblique drag, or the
  // pose-motion preview — so hand-posing is never perturbed. Merely
  // being posable does NOT suspend it: an untouched studio still breathes.
  const busy = () =>
    !!selected || !!press || !!ringDrag || !!obliqueRingDrag || !!obliquePress ||
    tcDragging || posePlayActive;

  const dispose = () => {
    renderer.domElement.removeEventListener('pointerdown', onPosePointerDown);
    window.removeEventListener('pointermove', onPosePointerMove);
    window.removeEventListener('pointerup', onPosePointerUp);
    window.removeEventListener('pointercancel', onPosePointerUp);
    window.removeEventListener('keydown', onPoseKey);
    cancelAnimationFrame(posePlayRaf);
    if (ikCtx) disposeIKChainContext(ikCtx);
    releasePelvisPlant();
    clearPoseHandles();
    clearAxes();
    ringGizmo.dispose();
    tc.detach();
    tc.dispose();
    if (obliqueDot) {
      scene.remove(obliqueDot);
      (obliqueDot.material as import('three').Material).dispose?.();
      (obliqueHit?.material as import('three').Material | undefined)?.dispose?.();
    }
    planes?.dispose();
    sectionCap?.dispose();
  };

  // ── Host-facing pose API ───────────────────────────────────────────
  const api: StagePoseApi = {
    getPose: () => {
      if (!stageCtx.skinnedRef || !stageCtx.variantCfgRef) return null;
      // Serialize the CLEAN pose — never a baked idle-liveliness delta
      // (the rAF loop re-bakes it next frame; phase is continuous).
      undoIdleOverlays();
      undoEyeGaze(); // eyes at rest in the serialized pose
      return serializeCustomPose(stageCtx.skinnedRef.skeleton, stageCtx.variantCfgRef, stageCtx.variantCfgRef.id);
    },
    loadPose: (pose: CustomPose) => {
      if (!stageCtx.skinnedRef || !stageCtx.variantCfgRef) return;
      // A loaded pose owns the skeleton — same cancels as scrubbing
      // (idle deltas lift BEFORE the absolute pose/root writes).
      undoIdleOverlays();
      undoEyeGaze(); // eye deltas lift before the absolute pose writes
      onTakeover();
      cancelComposed();
      if (stageCtx.activeMotionId) stopMotion();
      if (stageCtx.activeTween) finishTween();
      resetRootToRest(); // authored poses are upright, rotation-only
      applyCustomPose(stageCtx.skinnedRef.skeleton, stageCtx.variantCfgRef, pose);
      stageCtx.setCurrentPose(pose);
      stageCtx.modelRoot?.updateMatrixWorld(true);
      updatePoseHandles();
      reportPosing(true);
      requestRender();
      startLoop();
    },
    resetPose: () => {
      if (!stageCtx.skinnedRef || !stageCtx.variantCfgRef) return;
      undoIdleOverlays();
      undoEyeGaze(); // eye deltas lift with it (re-baked live next frame)
      onTakeover();
      cancelComposed();
      if (stageCtx.activeMotionId) stopMotion();
      if (stageCtx.activeTween) finishTween();
      resetRootToRest();
      applyPoseNow(null);
      stageCtx.setCurrentPose(null);
      stageCtx.modelRoot?.updateMatrixWorld(true);
      updatePoseHandles();
      reportPosing(true);
      requestRender();
      startLoop();
    },
    togglePosePlay: togglePosePlayImpl,
    focusSelectedJoint: () => {
      if (!selected) return;
      selected.bone.getWorldPosition(_v);
      cam.focusOn(_v);
    },
    deselectJoint: deselectImpl,
    setPosingOptions: (opts) => {
      if (opts.romClamp !== undefined) poseRomClampOn = opts.romClamp;
      if (opts.twistRig !== undefined) poseTwistOn = opts.twistRig;
      if (opts.showJoints !== undefined) {
        poseShowJoints = opts.showJoints;
        applyJointVisibility();
      }
      if (opts.showAxes !== undefined && opts.showAxes !== poseShowAxes) {
        poseShowAxes = opts.showAxes;
        if (poseShowAxes) buildAxes();
        else clearAxes();
      }
      requestRender();
    },
    setPlanes: (p) => {
      if (p.sagittal !== undefined) planeVis.sagittal = p.sagittal;
      if (p.frontal !== undefined) planeVis.frontal = p.frontal;
      if (p.transverse !== undefined) planeVis.transverse = p.transverse;
      if (p.oblique !== undefined) planeVis.oblique = p.oblique;
      applyPlaneState();
    },
    setSlice: (s) => {
      sliceState.plane = s.plane;
      if (s.flip !== undefined) sliceState.flip = s.flip;
      if (s.cap !== undefined) sliceState.cap = s.cap;
      if (s.depth !== undefined) sliceState.depth = s.depth;
      applySlice();
    },
    exportAnimationGlb: async (frames, name, rootMotion = false) => {
      if (!stageCtx.skinnedRef || !stageCtx.variantCfgRef || !stageCtx.modelRoot || frames.length < 2) return;
      const [{ GLTFExporter }, { clone: cloneSkeleton }] = await Promise.all([
        import('three/examples/jsm/exporters/GLTFExporter.js'),
        import('three/examples/jsm/utils/SkeletonUtils.js'),
      ]);
      const skel = stageCtx.skinnedRef.skeleton;
      const variantCfg = stageCtx.variantCfgRef;
      // Preserve the working pose; the live skeleton is mutated to sample.
      // Idle deltas lift first so the export + restore are both clean.
      undoIdleOverlays();
      undoEyeGaze(); // exported bone tracks carry the eyes at rest
      const saved = serializeCustomPose(skel, variantCfg, variantCfg.id);
      const times = frames.map((f) => f.t);
      const perBone = new Map<string, number[]>();
      for (const b of skel.bones) perBone.set(b.name, []);
      const rootBone =
        skel.bones.find((b) => !(b.parent as import('three').Bone)?.isBone) ?? skel.bones[0]!;
      const rootPos: number[] = [];
      for (const f of frames) {
        applyCustomPose(skel, variantCfg, f.pose);
        for (const b of skel.bones) {
          const q = b.quaternion;
          perBone.get(b.name)!.push(q.x, q.y, q.z, q.w);
        }
        if (rootMotion)
          rootPos.push(rootBone.position.x, rootBone.position.y, rootBone.position.z);
      }
      applyCustomPose(skel, variantCfg, saved);
      stageCtx.modelRoot.updateMatrixWorld(true);
      updatePoseHandles();
      reportPosing(true);
      requestRender();

      const tracks: import('three').KeyframeTrack[] = [];
      for (const [boneName, vals] of perBone) {
        const thin = decimateQuatTrack(times, vals);
        tracks.push(
          new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, thin.times, thin.values),
        );
      }
      if (rootMotion) {
        tracks.push(
          new THREE.VectorKeyframeTrack(`${rootBone.name}.position`, times.slice(), rootPos),
        );
      }
      const clip = new THREE.AnimationClip(name || 'authored', times[times.length - 1]!, tracks);

      // Export a bones-only clone of the mannequin + the clip → slim GLB.
      const cloneRoot = cloneSkeleton(stageCtx.modelRoot);
      const meshes: import('three').Object3D[] = [];
      cloneRoot.traverse((o) => {
        if ((o as import('three').SkinnedMesh).isSkinnedMesh || (o as import('three').Mesh).isMesh)
          meshes.push(o);
      });
      for (const m of meshes) m.parent?.remove(m);

      const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
        new GLTFExporter().parse(
          cloneRoot,
          (r) => resolve(r as ArrayBuffer),
          reject,
          { binary: true, animations: [clip], onlyVisible: false },
        );
      });
      const blob = new Blob([glb], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name || 'authored'}.glb`;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
  return {
    hooks: { onTakeover, onModelLoaded, beforeRender, afterRender, busy, dispose },
    api,
  };
}
