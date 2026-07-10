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
   * Camera interaction is the shared clinical model — damped orbit,
   * right-drag pan, zoom-to-cursor, double-click focus-or-reset, keyboard
   * path, opt-in cooperative touch via `allowPageScrollOnMiss` (see
   * services/clinicalCameraControls.ts); poses move ONLY via movement
   * commands. Theme via `--pv-bg`.
   */
  import { onMount } from 'svelte';
  import { POSE_SCHEMA_VERSION, type CustomPose, type MovementClipId } from './types';
  import type { JointAngleReport } from './services/jointAngles';
  // romConstraints is three-free (pure registry math) — static import stays
  // SSR-safe and lets the constraint store install/clear synchronously.
  import {
    clearRomScenarioConstraints,
    setRomScenarioConstraints,
    getEffectiveRomRange,
    type RomScenarioConstraints,
  } from './services/romConstraints';
  import type { ExamMovementCommand, ExamMovementOutcome } from './services/movementCommand';
  import type {
    ComposedMotionPlaybackResult,
    ResolvedComposedMotion,
  } from './services/motionSequence';
  import type {
    MotionClipProvider,
    MotionCommand,
    MotionCommandOutcome,
  } from './services/motionCommand';
  import { isCoarsePointer, resolveClinicalCameraAriaLabel } from './services/clinicalCameraControls';

  let {
    variant = 'male',
    base = '',
    modelUrl = '',
    authoredPose = null,
    romConstraints = null,
    motionClipProvider = null,
    height = '26rem',
    allowPageScrollOnMiss = false,
    motionReportHz = 0,
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
    /** Asset-ingestion seam for NAMED basic motions (walk / sit / stand). When
     *  supplied, `applyMotionCommand` drives the rig with the provider's
     *  animation clips through a THREE.AnimationMixer. Null = named motions
     *  refuse with `clip-unavailable`; exam ROM commands are unaffected. */
    motionClipProvider?: MotionClipProvider | null;
    height?: string;
    /** Cooperative touch gestures for scrollable host pages (the simLAB
     *  mission shell passes true). On coarse-pointer devices: one-finger
     *  swipes scroll the PAGE (the camera ignores them), two-finger drag
     *  rotates, pinch zooms, double-tap focuses/resets. Fine pointers and
     *  the default (false) keep the existing one-finger-orbit model.
     *  Applied when the stage boots. */
    allowPageScrollOnMiss?: boolean;
    /** Live joint-angle reporting DURING named-motion playback, in reports
     *  per second (throttled; 0 = off, the default). When > 0, `onReport`
     *  also fires this many times a second while a motion clip animates, so
     *  hosts can stream angles frame-by-frame instead of only at settle.
     *  Exam ROM commands still report at settle regardless. */
    motionReportHz?: number;
    /** Fires with the engine-computed clinical joint angles after the
     *  initial load and after each command settles (the truth the host
     *  grades against). With `motionReportHz > 0` it additionally fires
     *  throttled during motion playback. */
    onReport?: (report: JointAngleReport) => void;
    /** Fires when the authored pose is rejected at load time ('variant',
     *  'schema', 'empty', 'no-skeleton'); the stage continues anatomic. */
    onPoseDropped?: (reason: string) => void;
  } = $props();

  let container: HTMLDivElement;
  let loading = $state(true);
  let loadError = $state('');

  // Gesture vocabulary matches the ACTIVE interaction model: the touch
  // variant only when cooperative gestures will engage (opt-in ∧ coarse
  // pointer); SSR has no matchMedia → mouse vocabulary, same as before.
  const ariaLabel = $derived(
    resolveClinicalCameraAriaLabel(allowPageScrollOnMiss && isCoarsePointer()),
  );

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
  // Named-motion (walk / sit / stand) executor — clip-driven, shares the same
  // serialized command chain as the exam commands so the two modes never run
  // on the skeleton at once.
  let runMotionImpl: ((cmd: MotionCommand) => Promise<MotionCommandOutcome>) | null = null;
  // Composed-motion (generative keyframe sequence) executor — pose-tween
  // driven, shares the same serialized command chain.
  let runComposedImpl:
    | ((resolved: ResolvedComposedMotion) => Promise<ComposedMotionPlaybackResult>)
    | null = null;
  // Clinical ROM caps enforced per frame during motion (L2 modifier). The host
  // installs the constraint set (setRomScenarioConstraints); this list is the
  // joints to clamp each frame while a capped motion plays.
  let setMotionRomCapsImpl: ((keys: string[]) => void) | null = null;
  let setMotionOverlaysImpl:
    | ((overlays: { guarding?: number; balanceSway?: number } | null) => void)
    | null = null;
  let resolveBoot: () => void = () => {};
  const bootDone = new Promise<void>((r) => (resolveBoot = r));
  let commandChain: Promise<unknown> = Promise.resolve();
  let resetViewFn: () => void = () => {};

  /** Smoothly return the camera to the framed home view (the shared
   *  clinical-camera reset — also reachable via a double-click miss or the
   *  `0`/Home key). The mission shell mounts its Reset chip on this.
   *  Camera-only: poses and any in-flight movement command are untouched. */
  export function resetView(): void {
    resetViewFn();
  }

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

  /**
   * Play a NAMED basic motion ("walk" / "sit" / "stand") on the mannequin, or
   * stop the active motion. Clip-driven (THREE.AnimationMixer), NOT the exam
   * pose tween. Serialized on the SAME command chain as
   * {@link applyMovementCommand} — a motion and an exam command can never drive
   * the skeleton simultaneously. Resolves with what the motion did: `playing`
   * (a looping walk/stand started), `completed` (a one-shot sit settled),
   * `stopped`, or `refused` (unknown motion / no clip provider / missing clip).
   */
  export function applyMotionCommand(cmd: MotionCommand): Promise<MotionCommandOutcome> {
    const run = commandChain.then(async () => {
      await bootDone;
      if (!runMotionImpl) {
        return { status: 'refused', reason: 'stage-unavailable' } as MotionCommandOutcome;
      }
      return runMotionImpl(cmd);
    });
    commandChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Play a COMPOSED motion — a resolved generative keyframe sequence (see
   * `resolveComposedMotion` / `buildSequencePoses` in services/motionSequence)
   * — by tweening through its keyframe poses with the resolved durations and
   * holds. Serialized on the SAME command chain as the exam + clip commands.
   * `modifiers.timeScale` scales the durations; `guarding` / `balanceSway`
   * reuse the per-frame overlay machinery clip playback uses. Resolves with
   * per-keyframe MEASURED angles plus the final measured angles at the last
   * keyframe ('completed'), or 'playing' after the first pass of a looping
   * motion (the loop cycles until the next command or stop).
   */
  export function applyComposedMotion(
    resolved: ResolvedComposedMotion,
  ): Promise<ComposedMotionPlaybackResult> {
    const run = commandChain.then(async () => {
      await bootDone;
      if (!runComposedImpl) {
        return {
          status: 'refused',
          reason: 'stage-unavailable',
          measurements: [],
          finalAngles: {},
          loop: false,
          timingAdjusted: false,
        } as ComposedMotionPlaybackResult;
      }
      return runComposedImpl(resolved);
    });
    commandChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Install the joints to ROM-clamp per frame while a motion plays (an L2
   * clinical modifier — reduced excursion). Pass the canonical keys the active
   * constraint set restricts (the host sets the constraints themselves via
   * `setRomScenarioConstraints`); pass `[]` to lift the caps.
   */
  export function setMotionRomCaps(keys: string[]): void {
    setMotionRomCapsImpl?.(keys);
  }

  /**
   * Set additive clinical overlays applied per frame during motion (L2, Build D).
   * `guarding` (0..1) stiffens the trunk and arms toward neutral — reduced
   * excursion, the guarded/protective movement pattern. `balanceSway` (0..1) adds
   * a slow postural wobble (lateral + AP lean at the low back) over the planted
   * base — the unsteady/reduced-balance pattern. Pass `null`/0 to clear.
   */
  export function setMotionOverlays(
    overlays: { guarding?: number; balanceSway?: number } | null,
  ): void {
    setMotionOverlaysImpl?.(overlays);
  }

  onMount(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // Bare 'three' specifiers only — a second three instance would break
      // the instanceof checks inside the pose services.
      const THREE = await import('three');
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
      const {
        applyCustomPose,
        blendCustomPoseWithBaseline,
        isCustomPoseEmpty,
        serializeCustomPose,
        buildBoneByPoseKey,
      } = await import('./services/poseRig');
      const { clampBoneToRom, hasClampStrategy, setRomClampEnabled } = await import(
        './services/poseRomClamp'
      );
      const { captureJointAngleRestReference, computeJointAngles } = await import(
        './services/jointAngles'
      );
      const { buildCommandPose, finalizeOutcome, measureCommandMotion, resolveCommandTarget } =
        await import('./services/movementCommand');
      const { buildSequencePoses } = await import('./services/motionSequence');
      const { captureFloorReference, pinRootToFloor, rotateRestReferenceByRoot } = await import(
        './services/rootMotion'
      );
      const { resolveMotionCommand } = await import('./services/motionCommand');
      const { normalizeRigBoneName } = await import('./services/movementClipSampling');
      const { createClinicalCameraControls } = await import('./services/clinicalCameraControls');

      if (disposed || !container) return;

      const scene = new THREE.Scene();
      scene.background = null; // transparent → the CSS backdrop shows through
      const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
      const renderer = createMannequinRenderer({ container, alpha: true });
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';

      let renderNeeded = true;
      const requestRender = () => {
        renderNeeded = true;
      };

      // Shared clinical camera: damped orbit, right-drag pan, zoom-to-cursor
      // (0.35–6 m so a student can fill the frame with the ankle), double-
      // click focus-or-reset, arrow/±/0 keyboard path. Camera-only — it
      // never touches poses, so it cannot fight a movement-command tween.
      // allowPageScrollOnMiss (host opt-in) enables cooperative touch on
      // coarse pointers: one finger scrolls the page, two move the camera.
      const cam = createClinicalCameraControls({
        camera,
        domElement: renderer.domElement,
        keyElement: container,
        requestRender,
        getPickRoot: () => modelRoot,
        allowPageScrollOnMiss,
      });
      const controls = cam.controls;
      resetViewFn = cam.resetView;

      addMannequinLights(scene, 'clinical');

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
      // ── Full-body ROOT motion state (simMOVE) ──────────────────────────────
      // The planted-stance floor reference + the boot root transform (position
      // after grounding; quaternion identity). Composed motions ride orient /
      // translate on the MODEL ROOT relative to these; they persist across
      // compositions for continuity and reset when a clip / exam command takes
      // over.
      let floorRef: ReturnType<typeof captureFloorReference> | null = null;
      const rootRestPos = new THREE.Vector3();
      const rootRestQuat = new THREE.Quaternion();
      /** Current composed root state (meters-from-origin translate + orient quat). */
      let composedRootQuat: [number, number, number, number] = [0, 0, 0, 1];
      let composedRootTranslate: [number, number, number] = [0, 0, 0];
      const _rootQA = new THREE.Quaternion();
      const _rootQB = new THREE.Quaternion();
      const _rootInv = new THREE.Quaternion();
      const _rootPosA = new THREE.Vector3();
      const _rootPosB = new THREE.Vector3();

      /** Set the model root to a composed root state (orient quat relative to
       *  rest + translate in meters from the anatomic origin). */
      function applyRootState(
        quat: [number, number, number, number],
        translate: [number, number, number],
      ): void {
        if (!modelRoot) return;
        _rootQA.set(quat[0], quat[1], quat[2], quat[3]);
        modelRoot.quaternion.copy(rootRestQuat).multiply(_rootQA);
        modelRoot.position.set(
          rootRestPos.x + translate[0],
          rootRestPos.y + translate[1],
          rootRestPos.z + translate[2],
        );
        modelRoot.updateMatrixWorld(true);
      }

      /** Restore the model root to its grounded rest transform (upright, origin).
       *  Called when a clip or exam command takes over from a composed posture. */
      function resetRootToRest(): void {
        composedRootQuat = [0, 0, 0, 1];
        composedRootTranslate = [0, 0, 0];
        if (!modelRoot) return;
        modelRoot.quaternion.copy(rootRestQuat);
        modelRoot.position.copy(rootRestPos);
        modelRoot.updateMatrixWorld(true);
      }

      /** The orientation delta the model root currently carries vs its rest —
       *  null when upright (so measurement uses the plain rest reference). */
      function rootOrientDelta(): import('three').Quaternion | null {
        if (!modelRoot) return null;
        _rootQB.copy(modelRoot.quaternion).multiply(_rootInv.copy(rootRestQuat).invert());
        if (Math.abs(_rootQB.x) < 1e-6 && Math.abs(_rootQB.y) < 1e-6 && Math.abs(_rootQB.z) < 1e-6) {
          return null;
        }
        return _rootQB;
      }

      /** Rest reference to measure against right now — rotated to the reoriented
       *  torso when the body is reoriented, else the plain rest. */
      function activeRestRef(): ReturnType<typeof captureJointAngleRestReference> | null {
        if (!restRef) return null;
        const d = rootOrientDelta();
        return d ? rotateRestReferenceByRoot(restRef, d) : restRef;
      }

      // ── Named-motion (clip) playback state ─────────────────────────────────
      // A THREE.AnimationMixer drives walk/sit/stand clips. Motions and exam
      // pose tweens are mutually exclusive — starting either cancels the other.
      let mixer: import('three').AnimationMixer | null = null;
      let motionAction: import('three').AnimationAction | null = null;
      let activeMotionId: MovementClipId | null = null;
      // L2 ROM-cap state: canonical-key → bone, and the keys to clamp each frame.
      let motionCapBones: Map<string, import('three').Bone> | null = null;
      let motionCapKeys: string[] = [];
      // Leg caps get IK whole-chain resolution (Build C): a capped knee reduces
      // its excursion while the hip/ankle re-solve to keep the foot on the clip's
      // trajectory — stiff-knee gait, not a floating foot.
      const KNEE_TO_FOOT: Record<string, string> = { R_Leg: 'R_Foot', L_Leg: 'L_Foot' };
      const KNEE_TO_HIP: Record<string, string> = { R_Leg: 'R_UpLeg', L_Leg: 'L_UpLeg' };
      let motionCapLegs: {
        kneeKey: string;
        hipKey: string;
        hipBone: import('three').Bone;
        kneeBone: import('three').Bone;
        footBone: import('three').Bone;
      }[] = [];
      const _capFootTarget = new THREE.Vector3();
      const _capH = new THREE.Vector3();
      const _capK = new THREE.Vector3();
      const _capF = new THREE.Vector3();
      const _capThighDir = new THREE.Vector3();
      const _capCalfDir = new THREE.Vector3();
      const _capToFoot = new THREE.Vector3();
      const _capToTarget = new THREE.Vector3();
      const _capRestQ = new THREE.Quaternion();
      const _capClipQ = new THREE.Quaternion();
      const _capSwing = new THREE.Quaternion();
      const _capHipW = new THREE.Quaternion();
      const _capParW = new THREE.Quaternion();
      setMotionRomCapsImpl = (keys: string[]) => {
        motionCapKeys = keys.filter((k) => hasClampStrategy(k));
        motionCapLegs = [];
        if (skinnedRef && motionCapBones) {
          for (const key of motionCapKeys) {
            const footKey = KNEE_TO_FOOT[key];
            const hipKey = KNEE_TO_HIP[key];
            const kneeBone = motionCapBones.get(key);
            const footBone = footKey ? motionCapBones.get(footKey) : undefined;
            const hipBone = hipKey ? motionCapBones.get(hipKey) : undefined;
            if (footKey && hipKey && kneeBone && footBone && hipBone) {
              motionCapLegs.push({ kneeKey: key, hipKey, hipBone, kneeBone, footBone });
            }
          }
        }
        // The per-frame clamp/IK needs the global clamp active; lift it when no caps.
        setRomClampEnabled(motionCapKeys.length ? true : null);
      };

      // Guarding overlay: blend the trunk + arms toward neutral each frame,
      // reducing excursion (stiff, protective movement). 0 = off, 1 = ~80% damped.
      const GUARDING_KEYS = ['Spine_Lower', 'Spine_Upper', 'Neck', 'L_UpperArm', 'R_UpperArm'];
      let motionGuarding = 0;
      const _guardRestQ = new THREE.Quaternion();
      // Balance-sway overlay: a slow postural wobble applied additively at the low
      // back (trunk + everything above it leans over the planted feet). Two
      // incommensurate low frequencies keep it from looking like a metronome.
      let motionSway = 0;
      let swayTime = 0;
      const _swayQ = new THREE.Quaternion();
      const _swayAxisAP = new THREE.Vector3(1, 0, 0); // pitch: anterior/posterior lean
      const _swayAxisML = new THREE.Vector3(0, 0, 1); // roll: medial/lateral lean
      const SWAY_ML_HZ = 0.45; // lateral wobble is the slower, larger component
      const SWAY_AP_HZ = 0.7;
      const SWAY_ML_DEG = 8; // max lateral lean at balanceSway = 1
      const SWAY_AP_DEG = 5; // max A/P lean at balanceSway = 1
      setMotionOverlaysImpl = (overlays: { guarding?: number; balanceSway?: number } | null) => {
        motionGuarding = Math.max(0, Math.min(1, overlays?.guarding ?? 0));
        motionSway = Math.max(0, Math.min(1, overlays?.balanceSway ?? 0));
      };
      // ── Composed-motion (generative keyframe sequence) playback state ─────
      // Pose-tween driven (NOT the mixer). `composedActive` gates the same
      // guarding/sway overlays clip playback applies; `composedSeq` is a
      // cancellation token — any newer command bumps it and the composed
      // playback (including a detached loop cycle) stops at its next check.
      let composedActive = false;
      let composedSeq = 0;
      function cancelComposed() {
        composedSeq += 1;
        composedActive = false;
      }

      /** Resolves a one-shot ('once') motion when the mixer fires 'finished'. */
      let motionFinishResolve: (() => void) | null = null;
      const motionClock = new THREE.Clock();
      /** Per-motion clip cache, remapped to THIS load's skeleton. Cleared on
       *  every model (re)load since bone identities change. */
      const motionClipCache = new Map<MovementClipId, import('three').AnimationClip>();

      /** Remap a clip's track bone names onto the live skeleton via the engine
       *  normalizer (no-op for clips authored on the same CC rig). */
      function remapClipToSkeleton(
        clip: import('three').AnimationClip,
        skeleton: import('three').Skeleton,
      ): import('three').AnimationClip {
        const nameByNormalized = new Map<string, string>();
        for (const bone of skeleton.bones) {
          nameByNormalized.set(normalizeRigBoneName(bone.name || ''), bone.name);
        }
        for (const track of clip.tracks) {
          const dot = track.name.indexOf('.');
          if (dot === -1) continue;
          const trackBone = track.name.slice(0, dot);
          const property = track.name.slice(dot);
          const modelBone = nameByNormalized.get(normalizeRigBoneName(trackBone));
          if (modelBone && modelBone !== trackBone) track.name = modelBone + property;
        }
        return clip;
      }

      /** Stop any active motion and return the skeleton to its last known
       *  CustomPose (the pre-motion pose). Idempotent. */
      function stopMotion() {
        cancelComposed();
        if (mixer) mixer.stopAllAction();
        motionAction = null;
        activeMotionId = null;
        // Lift any ROM caps (the host clears its constraint set separately).
        motionCapKeys = [];
        motionCapLegs = [];
        motionGuarding = 0;
        motionSway = 0;
        swayTime = 0;
        setRomClampEnabled(null);
        if (motionFinishResolve) {
          const r = motionFinishResolve;
          motionFinishResolve = null;
          r();
        }
        applyPoseNow(currentPose);
        requestRender();
      }

      function disposeModel() {
        if (!modelRoot) return;
        // Tear down any active motion + mixer bound to the outgoing model.
        stopMotion();
        if (mixer) {
          mixer.uncacheRoot(modelRoot);
          mixer = null;
        }
        motionClipCache.clear();
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
          // Capture the grounded rest root transform + planted-stance floor
          // reference; composed root motion rides relative to these.
          rootRestPos.copy(root.position);
          rootRestQuat.copy(root.quaternion);
          composedRootQuat = [0, 0, 0, 1];
          composedRootTranslate = [0, 0, 0];
          floorRef = skinned ? captureFloorReference(skinned.skeleton, variantCfg) : null;
          frameCamera();

          // 7) Wire the command surface to the fresh skeleton.
          variantCfgRef = variantCfg;
          skinnedRef = skinned;
          restRef = rest;
          baselinePoseRef = baseline;
          restingPoseRef = resting;
          currentPose = resting;
          // Canonical-key → bone lookup for the per-frame motion ROM clamp.
          motionCapBones = skinned ? buildBoneByPoseKey(skinned.skeleton, variantCfg) : null;

          // 7b) Fresh AnimationMixer bound to this model root for named
          //     motions. A one-shot clip that reaches its end fires 'finished',
          //     which resolves the awaiting `applyMotionCommand`.
          mixer = new THREE.AnimationMixer(root);
          mixer.addEventListener('finished', () => {
            const r = motionFinishResolve;
            motionFinishResolve = null;
            activeMotionId = null;
            r?.();
          });

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
        // This framed view is the reset home (double-click miss / `0` key /
        // resetView()) until the next model load.
        cam.captureHomeView();
        requestRender();
      }

      // ── Command tween (runs INSIDE the existing rAF loop) ──────────────
      const TWEEN_MS = 600;
      const easeInOutCubic = (t: number) =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      interface RootTweenTarget {
        fromQuat: [number, number, number, number];
        toQuat: [number, number, number, number];
        fromTranslate: [number, number, number];
        toTranslate: [number, number, number];
        /** Planted stance → pin the lower foot to the floor each frame. */
        planted: boolean;
      }
      interface ActiveTween {
        from: CustomPose | null;
        to: CustomPose | null;
        start: number;
        /** Travel time for THIS tween (composed keyframes pass their own). */
        durationMs: number;
        /** Optional whole-body root transform tween (composed full-body motion). */
        root?: RootTweenTarget;
        resolve: () => void;
      }
      let activeTween: ActiveTween | null = null;

      /** Interpolate + apply the root transform for a tween at parameter t, and
       *  (planted) re-pin the lower foot to the floor. */
      function applyRootTween(rt: RootTweenTarget, t: number): void {
        _rootQA.set(rt.fromQuat[0], rt.fromQuat[1], rt.fromQuat[2], rt.fromQuat[3]);
        _rootQB.set(rt.toQuat[0], rt.toQuat[1], rt.toQuat[2], rt.toQuat[3]);
        _rootQA.slerp(_rootQB, t);
        _rootPosA
          .set(rt.fromTranslate[0], rt.fromTranslate[1], rt.fromTranslate[2])
          .lerp(_rootPosB.set(rt.toTranslate[0], rt.toTranslate[1], rt.toTranslate[2]), t);
        if (!modelRoot) return;
        modelRoot.quaternion.copy(rootRestQuat).multiply(_rootQA);
        modelRoot.position.set(
          rootRestPos.x + _rootPosA.x,
          rootRestPos.y + _rootPosA.y,
          rootRestPos.z + _rootPosA.z,
        );
        modelRoot.updateMatrixWorld(true);
        if (rt.planted && skinnedRef && variantCfgRef && floorRef) {
          pinRootToFloor(modelRoot, skinnedRef.skeleton, variantCfgRef, floorRef);
        }
      }

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
        if (tw.root) applyRootTween(tw.root, 1);
        requestRender();
        tw.resolve();
      }

      function stepTween(now: number) {
        const tw = activeTween;
        if (!tw) return;
        const t = Math.min(1, (now - tw.start) / Math.max(tw.durationMs, 1));
        if (t >= 1) {
          finishTween();
          return;
        }
        const eased = easeInOutCubic(t);
        if (skinnedRef && variantCfgRef) {
          const blended = blendCustomPoseWithBaseline(tw.from, tw.to, baselinePoseRef, eased);
          if (blended) applyCustomPose(skinnedRef.skeleton, variantCfgRef, blended);
        }
        if (tw.root) applyRootTween(tw.root, eased);
        requestRender();
      }

      /** True when the stage cannot animate: parked (display:none host overlay
       *  → offsetParent null) OR the whole tab is background (visibilityState
       *  'hidden' freezes rAF WITHOUT hiding the element). Either way tweens
       *  settle instantly and holds skip so command promises never strand. */
      const stageHidden = () =>
        !container ||
        container.offsetParent === null ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden');

      function tweenTo(
        to: CustomPose | null,
        durationMs: number = TWEEN_MS,
        root?: RootTweenTarget,
      ): Promise<void> {
        return new Promise((resolve) => {
          if (activeTween) finishTween(); // safety — commands are serialized
          activeTween = { from: currentPose, to, start: performance.now(), durationMs, ...(root ? { root } : {}), resolve };
          startLoop();
          requestRender();
          // Hidden stage / background tab: the loop is parked (or rAF frozen),
          // so settle instantly rather than stranding the command promise.
          if (stageHidden()) finishTween();
        });
      }

      function measureNow(): JointAngleReport | null {
        if (!skinnedRef || !variantCfgRef || !restRef || !modelRoot) return null;
        modelRoot.updateMatrixWorld(true);
        return computeJointAngles(
          skinnedRef.skeleton,
          variantCfgRef,
          variantCfgRef.id,
          activeRestRef() ?? restRef,
        );
      }

      // Loop-local measure: the render loop already ran modelRoot.updateMatrixWorld()
      // right after mixer.update(), so the world matrices are fresh — skip the
      // force-recompute measureNow() does and just read the angles. This is the
      // hot path for per-frame motion streaming; the redundant full matrix pass
      // is what made high report rates expensive.
      function measureNowFresh(): JointAngleReport | null {
        if (!skinnedRef || !variantCfgRef || !restRef) return null;
        return computeJointAngles(
          skinnedRef.skeleton,
          variantCfgRef,
          variantCfgRef.id,
          activeRestRef() ?? restRef,
        );
      }

      runCommandImpl = async (cmd: ExamMovementCommand): Promise<ExamMovementOutcome> => {
        if (disposed || !skinnedRef || !variantCfgRef || !restRef || !baselinePoseRef) {
          return { status: 'refused', reason: 'stage-unavailable' };
        }
        // Mode switch: an exam ROM command owns the skeleton — cancel any active
        // named motion or composed playback first, then proceed. Exam ROM is
        // upright/open-chain, so drop any composed full-body root posture.
        cancelComposed();
        if (activeMotionId) stopMotion();
        resetRootToRest();
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
          restRef, // shoulder elevation needs the rest world orientation
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

      runComposedImpl = async (
        resolved: ResolvedComposedMotion,
      ): Promise<ComposedMotionPlaybackResult> => {
        const timingAdjusted = !!resolved?.keyframes?.some((k) => k.timingAdjusted);
        const refusedResult = (reason: string): ComposedMotionPlaybackResult => ({
          status: 'refused',
          ...(resolved?.name ? { name: resolved.name } : {}),
          reason,
          measurements: [],
          finalAngles: {},
          loop: !!resolved?.loop,
          timingAdjusted,
        });
        if (disposed || !skinnedRef || !variantCfgRef || !restRef || !baselinePoseRef) {
          return refusedResult('stage-unavailable');
        }
        if (!resolved || resolved.status !== 'ok' || resolved.keyframes.length === 0) {
          return refusedResult(resolved?.reason ?? 'not-resolved');
        }
        // Composed playback owns the skeleton: cancel any clip / prior
        // composed loop / in-flight tween, THEN capture the cancellation token.
        if (activeMotionId) stopMotion();
        if (activeTween) finishTween();
        cancelComposed();
        const token = composedSeq;
        const mods = resolved.modifiers ?? {};
        // Same qualitative-overlay semantics as prescribe_motion: timeScale
        // scales the (already velocity-floored) durations; guarding/sway run
        // through the identical per-frame overlay machinery clips use.
        const timeScale = Math.min(1.5, Math.max(0.4, mods.timeScale ?? 1));
        setMotionOverlaysImpl?.({ guarding: mods.guarding, balanceSway: mods.balanceSway });
        composedActive = true;
        startLoop();

        // CROSS-MOTION CONTINUITY: fold onto the CURRENT on-stage pose + root, so
        // a second motion holds unmentioned joints and continues from the live
        // posture (unless the motion asked to start from neutral, which the build
        // honors by folding onto the anatomic baseline / upright root instead).
        const built = buildSequencePoses(baselinePoseRef, resolved, variantCfgRef, restRef, {
          currentPose,
          currentRoot: { quat: composedRootQuat, translateM: composedRootTranslate },
        });
        if (resolved.startFrom === 'neutral') resetRootToRest();
        const measurements: ComposedMotionPlaybackResult['measurements'] = [];
        const finalAngles: Record<string, number> = {};
        const hidden = stageHidden;
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        let lastReport: JointAngleReport | null = null;
        // Root tween runs from the current composed root state, advancing per keyframe.
        let prevQuat: [number, number, number, number] = [...composedRootQuat];
        let prevTranslate: [number, number, number] = [...composedRootTranslate];
        const rootTweenFor = (i: number): RootTweenTarget => {
          const rs = built.roots[i]!;
          const rt: RootTweenTarget = {
            fromQuat: prevQuat,
            toQuat: rs.quat,
            fromTranslate: prevTranslate,
            toTranslate: rs.translateM,
            planted: rs.stance === 'planted',
          };
          prevQuat = rs.quat;
          prevTranslate = rs.translateM;
          composedRootQuat = rs.quat;
          composedRootTranslate = rs.translateM;
          return rt;
        };

        for (let i = 0; i < built.poses.length; i += 1) {
          if (token !== composedSeq) break; // superseded by a newer command
          await tweenTo(built.poses[i]!, built.durationsMs[i]! / timeScale, rootTweenFor(i));
          // Settle: MEASURE what the patient actually did at this keyframe.
          const report = measureNow();
          if (report) {
            lastReport = report;
            onReport?.(report);
            for (const t of resolved.keyframes[i]!.targets) {
              const measured = measureCommandMotion(report, t.joint, t.motion);
              measurements.push({
                keyframe: i,
                joint: t.joint,
                motion: t.motion,
                clampedDegrees: t.clampedDegrees,
                ...(measured != null ? { measuredDegrees: measured } : {}),
              });
            }
          }
          // Hold at the keyframe (assessment moment). Skipped when hidden so
          // a parked stage never strands the command chain.
          const hold = (built.holdsMs[i] ?? 0) / timeScale;
          if (hold > 0 && !hidden()) await sleep(Math.min(hold, 10_000));
        }

        // Final measured angles at the last keyframe for every touched field.
        if (lastReport) {
          const touched = new Set<string>();
          for (const kfr of resolved.keyframes) {
            for (const t of kfr.targets) touched.add(`${t.joint}.${t.motion}`);
          }
          for (const key of touched) {
            const dot = key.indexOf('.');
            const measured = measureCommandMotion(lastReport, key.slice(0, dot), key.slice(dot + 1));
            if (measured != null) finalAngles[key] = measured;
          }
        }

        const base = {
          ...(resolved.name ? { name: resolved.name } : {}),
          measurements,
          finalAngles,
          loop: resolved.loop,
          timingAdjusted,
        };
        if (resolved.loop && token === composedSeq) {
          // Detached cycle OUTSIDE the command chain: keep tweening through
          // the keyframes until a newer command bumps the token. The first
          // pass's measurements above are what the caller narrates from.
          void (async () => {
            let idx = 0;
            while (token === composedSeq && !disposed && !hidden()) {
              await tweenTo(built.poses[idx]!, built.durationsMs[idx]! / timeScale, rootTweenFor(idx));
              const hold = (built.holdsMs[idx] ?? 0) / timeScale;
              if (hold > 0 && !hidden()) await sleep(Math.min(hold, 10_000));
              idx = (idx + 1) % built.poses.length;
            }
          })();
          return { status: 'playing', ...base };
        }
        if (token !== composedSeq) {
          // Superseded mid-play (a newer command / variant switch / unmount):
          // answer honestly with only the keyframes that settled, so the host
          // never narrates a partial motion as complete.
          return {
            status: 'interrupted',
            reason: disposed ? 'stage-disposed' : 'superseded',
            ...base,
          };
        }
        // One-shot: settle, lift the overlays.
        composedActive = false;
        setMotionOverlaysImpl?.(null);
        return { status: 'completed', ...base };
      };

      runMotionImpl = async (cmd: MotionCommand): Promise<MotionCommandOutcome> => {
        if (disposed || !mixer || !modelRoot) {
          return { status: 'refused', reason: 'stage-unavailable' };
        }
        const resolved = resolveMotionCommand(cmd);
        if (resolved.status === 'stop') {
          stopMotion();
          return { status: 'stopped' };
        }
        if (resolved.status === 'refused' || !resolved.motion || !resolved.definition) {
          return { status: 'refused', motion: resolved.motion, reason: resolved.reason };
        }
        if (!motionClipProvider) {
          return { status: 'refused', motion: resolved.motion, reason: 'clip-unavailable' };
        }

        const motion = resolved.motion;
        const def = resolved.definition;
        const loop = resolved.loop ?? def.loop;
        const speed = resolved.speed ?? def.speed;

        // Resolve the clip (host-loaded, cached here per skeleton). The
        // `sandbox` slot is host-supplied and swaps between plays (simMOVE's
        // upload-to-test), so it is NEVER cached — always re-fetch it from the
        // provider, or a second upload would replay the first clip.
        const cacheable = motion !== 'sandbox';
        let clip = cacheable ? (motionClipCache.get(motion) ?? null) : null;
        if (!clip) {
          let clips: import('three').AnimationClip[] | null = null;
          try {
            clips = (await motionClipProvider.getClips(motion)) ?? null;
          } catch (err) {
            console.error('ExamStage3D: motion clip load failed', motion, err);
            clips = null;
          }
          if (disposed || !mixer || !modelRoot) {
            return { status: 'refused', motion, reason: 'stage-unavailable' };
          }
          if (!clips || clips.length === 0) {
            return { status: 'refused', motion, reason: 'clip-unavailable' };
          }
          const cloned = clips[0]!.clone();
          const skel = skinnedRef?.skeleton;
          clip = skel ? remapClipToSkeleton(cloned, skel) : cloned;
          if (cacheable) motionClipCache.set(motion, clip);
        }

        // Cancel any in-flight pose tween, composed playback, and prior
        // motion, then start the clip. Clips animate the skeleton from the
        // grounded upright root, so drop any composed full-body root posture.
        cancelComposed();
        if (activeTween) finishTween();
        resetRootToRest();
        mixer.stopAllAction();
        if (motionFinishResolve) {
          const r = motionFinishResolve;
          motionFinishResolve = null;
          r();
        }
        const action = mixer.clipAction(clip, modelRoot);
        action.reset();
        action.setLoop(
          loop === 'repeat' ? THREE.LoopRepeat : THREE.LoopOnce,
          loop === 'repeat' ? Infinity : 1,
        );
        action.clampWhenFinished = loop === 'once';
        action.timeScale = speed;
        action.enabled = true;
        action.play();
        motionAction = action;
        activeMotionId = motion;
        motionClock.getDelta(); // drop the accumulated idle delta
        startLoop();
        requestRender();

        const outcomeBase = { motion, kind: def.kind, loop, speed } as const;

        // Hidden stage: the loop is parked, so a looping motion can't animate —
        // report 'playing' immediately; a one-shot can't reach 'finished', so
        // sample its final frame and settle synchronously.
        const hidden = stageHidden();
        if (loop === 'repeat') {
          return { status: 'playing', ...outcomeBase };
        }
        if (hidden) {
          mixer.setTime(clip.duration / Math.max(speed, 1e-3));
          modelRoot.updateMatrixWorld(true);
          activeMotionId = null;
          return { status: 'completed', ...outcomeBase };
        }
        // Visible one-shot: await the mixer 'finished' event.
        await new Promise<void>((resolve) => {
          motionFinishResolve = resolve;
        });
        return { status: 'completed', ...outcomeBase };
      };

      // Hosts display:none this stage during overlays, and rAF keeps firing
      // for display:none elements — park the loop (no reschedule) when the
      // container is hidden; the ResizeObserver restarts it when shown. A
      // hidden stage settles any in-flight tween immediately so command
      // promises never strand.
      let raf = 0;
      let loopRunning = false;
      let lastMotionReport = 0;
      const loop = () => {
        if (container.offsetParent === null) {
          loopRunning = false;
          if (activeTween) finishTween();
          // A one-shot motion awaiting 'finished' would strand while parked —
          // jump it to its end frame and resolve.
          if (mixer && activeMotionId && motionAction && motionFinishResolve) {
            mixer.setTime(motionAction.getClip().duration / Math.max(motionAction.timeScale, 1e-3));
            modelRoot?.updateMatrixWorld(true);
            const r = motionFinishResolve;
            motionFinishResolve = null;
            activeMotionId = null;
            r();
          }
          return; // parked — startLoop() (via the ResizeObserver) resumes
        }
        raf = requestAnimationFrame(loop);
        cam.update(); // step any camera focus/reset tween (camera-only)
        controls.update();
        const motionDelta = motionClock.getDelta();
        if (mixer && activeMotionId) {
          mixer.update(motionDelta); // step the named-motion clip (bones-only)
          modelRoot?.updateMatrixWorld();
          // L2 ROM cap: enforce the scenario-narrowed range each frame while the
          // clip plays. Leg (knee) caps re-solve the whole leg via IK so the foot
          // stays on the clip's trajectory (Build C); other caps clamp directly.
          if (motionCapKeys.length && restRef && motionCapBones && modelRoot) {
            let changed = false;
            // Leg caps (Build C, calibrated): ease the knee toward extension
            // until its CLINICAL flexion (the chart's own thigh↔calf segment
            // angle) hits the cap, then rotate only the hip to put the foot back
            // on the clip's trajectory — the knee stays fixed, the hip/ankle
            // compensate. This keeps the cap honest in the readout's units,
            // sidestepping the bone clamp's un-calibrated hinge measure.
            for (const leg of motionCapLegs) {
              leg.hipBone.getWorldPosition(_capH);
              leg.kneeBone.getWorldPosition(_capK);
              leg.footBone.getWorldPosition(_capF);
              _capFootTarget.copy(_capF); // the clip's intended foot placement
              _capThighDir.copy(_capK).sub(_capH);
              _capCalfDir.copy(_capF).sub(_capK);
              if (_capThighDir.lengthSq() < 1e-8 || _capCalfDir.lengthSq() < 1e-8) continue;
              _capThighDir.normalize();
              _capCalfDir.normalize();
              const F0 =
                (Math.acos(Math.max(-1, Math.min(1, _capThighDir.dot(_capCalfDir)))) * 180) /
                Math.PI;
              const cap = getEffectiveRomRange(leg.kneeKey, 'kneeFlexion')?.max ?? Infinity;
              if (!(F0 > cap + 0.5)) continue;
              const restArr = restRef.localQuats[leg.kneeKey];
              if (!restArr) continue;
              // slerp(extended, clip, t) ⇒ flexion ≈ t·F0, so t = cap/F0.
              _capRestQ.set(restArr[0], restArr[1], restArr[2], restArr[3]);
              _capClipQ.copy(leg.kneeBone.quaternion);
              leg.kneeBone.quaternion.copy(_capRestQ).slerp(_capClipQ, Math.min(1, cap / F0));
              modelRoot.updateMatrixWorld();
              // Hip-only CCD (a few iters) to restore the foot, knee held fixed.
              for (let it = 0; it < 3; it += 1) {
                leg.hipBone.getWorldPosition(_capH);
                leg.footBone.getWorldPosition(_capF);
                _capToFoot.copy(_capF).sub(_capH);
                _capToTarget.copy(_capFootTarget).sub(_capH);
                if (_capToFoot.lengthSq() < 1e-8 || _capToTarget.lengthSq() < 1e-8) break;
                _capToFoot.normalize();
                _capToTarget.normalize();
                _capSwing.setFromUnitVectors(_capToFoot, _capToTarget);
                leg.hipBone.getWorldQuaternion(_capHipW);
                _capHipW.premultiply(_capSwing);
                if (leg.hipBone.parent) {
                  leg.hipBone.parent.getWorldQuaternion(_capParW);
                  leg.hipBone.quaternion.copy(_capParW.invert()).multiply(_capHipW);
                } else {
                  leg.hipBone.quaternion.copy(_capHipW);
                }
                clampBoneToRom(leg.hipBone, leg.hipKey, restRef);
                modelRoot.updateMatrixWorld();
              }
              changed = true;
            }
            // Non-leg caps (e.g. trunk flexion): direct clamp.
            for (const key of motionCapKeys) {
              if (KNEE_TO_FOOT[key]) continue;
              const bone = motionCapBones.get(key);
              if (bone && clampBoneToRom(bone, key, restRef)) changed = true;
            }
            if (changed) modelRoot.updateMatrixWorld();
          }
          renderNeeded = true; // keep rendering while a motion plays
        }
        if (activeTween) stepTween(performance.now()); // pose tween (bones-only)
        // Overlays + live streaming apply to BOTH animation modes: clip
        // playback (mixer) and composed keyframe playback (pose tweens).
        if ((mixer && activeMotionId) || composedActive) {
          // Guarding overlay: ease the trunk + arms toward neutral, damping
          // excursion into a stiff, protective movement pattern.
          if (motionGuarding > 0 && restRef && motionCapBones && modelRoot) {
            const f = motionGuarding * 0.8;
            for (const key of GUARDING_KEYS) {
              const bone = motionCapBones.get(key);
              const restArr = restRef.localQuats[key];
              if (bone && restArr) {
                _guardRestQ.set(restArr[0], restArr[1], restArr[2], restArr[3]);
                bone.quaternion.slerp(_guardRestQ, f);
              }
            }
            modelRoot.updateMatrixWorld();
          }
          // Balance-sway overlay: an additive low-frequency lean at the low back,
          // pre-multiplied so the whole trunk/head/arms wobble over the planted
          // feet (feet/legs are untouched → they stay on the clip's plant). Two
          // incommensurate sines make it read as unsteady, not periodic.
          if (motionSway > 0 && motionCapBones && modelRoot) {
            swayTime += motionDelta;
            const bone = motionCapBones.get('Spine_Lower');
            if (bone) {
              const mlDeg =
                motionSway * SWAY_ML_DEG * Math.sin(2 * Math.PI * SWAY_ML_HZ * swayTime);
              const apDeg =
                motionSway *
                SWAY_AP_DEG *
                Math.sin(2 * Math.PI * SWAY_AP_HZ * swayTime + 1.3);
              _swayQ.setFromAxisAngle(_swayAxisML, (mlDeg * Math.PI) / 180);
              bone.quaternion.premultiply(_swayQ);
              _swayQ.setFromAxisAngle(_swayAxisAP, (apDeg * Math.PI) / 180);
              bone.quaternion.premultiply(_swayQ);
              modelRoot.updateMatrixWorld();
            }
          }
          // Composed playback refreshes world matrices here (the mixer path
          // already did right after mixer.update) so streaming measures fresh.
          if (composedActive && modelRoot) modelRoot.updateMatrixWorld();
          renderNeeded = true; // keep rendering while a motion plays
          // Live per-frame angle streaming (opt-in): re-measure the achieved
          // pose at up to motionReportHz and report it, so hosts can chart
          // angles as the clip plays instead of only at settle. A ~4ms slack
          // absorbs rAF jitter so e.g. 60 streams every frame at a 60Hz display
          // instead of aliasing down to 30. Matrices are already fresh from the
          // updateMatrixWorld() above, so measureNowFresh() skips a full pass.
          if (motionReportHz > 0 && onReport) {
            const nowMs = performance.now();
            if (nowMs - lastMotionReport >= 1000 / motionReportHz - 4) {
              lastMotionReport = nowMs;
              const report = measureNowFresh();
              if (report) onReport(report);
            }
          }
        }
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

      // Background tab: visibilityState 'hidden' freezes rAF WITHOUT hiding
      // the element (offsetParent stays non-null), so an in-flight tween
      // would strand its command promise until refocus. Mirror the parked-
      // stage branch: finish the active tween instantly and resolve any
      // awaiting one-shot clip; holds skip via stageHidden().
      const onVisibilityChange = () => {
        if (document.visibilityState !== 'hidden') {
          startLoop();
          requestRender();
          return;
        }
        if (activeTween) finishTween();
        if (mixer && activeMotionId && motionAction && motionFinishResolve) {
          mixer.setTime(motionAction.getClip().duration / Math.max(motionAction.timeScale, 1e-3));
          modelRoot?.updateMatrixWorld(true);
          const r = motionFinishResolve;
          motionFinishResolve = null;
          activeMotionId = null;
          r();
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);

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
        stopMotion(); // resolves any awaiting one-shot motion promise
        runCommandImpl = null;
        runMotionImpl = null;
        runComposedImpl = null;
        cancelAnimationFrame(raf);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        ro.disconnect();
        controls.removeEventListener('change', requestRender);
        disposeModel();
        cam.dispose(); // removes dblclick/key listeners + disposes controls
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
  <!-- Focusable so the keyboard path works: arrow keys pan, +/− zoom, 0 resets.
       role="application" hands arrow keys to the 3D controls instead of the
       screen reader's document cursor. The a11y rule can't see the imperative
       key/pointer listeners the camera helper attaches, hence the ignore. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="pose-viewer__canvas"
    bind:this={container}
    tabindex="0"
    role="application"
    aria-label={ariaLabel}
  ></div>
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
    outline: none;
  }
  .pose-viewer__canvas:focus-visible {
    outline: 2px solid rgba(120, 190, 255, 0.9);
    outline-offset: -2px;
    border-radius: 12px;
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
