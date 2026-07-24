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
   * Scenario constraints (`romConstraints` prop) are passed EXPLICITLY into
   * each resolve/clamp/balance call (no module-global "active scenario" store —
   * that broke concurrent/preflight resolves). The prop is read live, so a
   * host swap takes effect on the next command with no reload — display-side
   * data the host already holds; nothing is fetched.
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
  import { computeStageDiagnostics, type StageDiagnostics } from './services/stageDiagnostics';
  import { POSE_SCHEMA_VERSION, type CustomPose, type MovementClipId } from './types';
  import type { DrivingRingMap, JointAngleReport } from './services/jointAngles';
  import type { PoseRingDrag } from './services/poseRotateRings';
  import type { TwistSegment } from './services/twistRig';
  import type { AnatomicalPlanes } from './services/anatomicalPlanes';
  import type { SectionCap } from './services/sectionCap';
  import type { IKChainContext } from './services/poseRig';
  import type { PoseTrajectory } from './services/motionTrajectory';
  // romRegistry is three-free (pure definitions) — static import stays SSR-safe.
  import { getRomJointDefinition, type RomPlane } from './services/romRegistry';
  // romConstraints is three-free (pure registry math) — static import stays
  // SSR-safe. Constraints are passed explicitly to each resolve/clamp call
  // (no module-global store); `getEffectiveRomRange` reads the value we hand it.
  import {
    getEffectiveRomRange,
    type RomScenarioConstraints,
  } from './services/romConstraints';
  // liveliness is three-free (pure angle math) — static import stays SSR-safe;
  // it feeds the live rAF overlay only, never the offline sampler.
  import {
    livelinessSwayDeg,
    cadenceRate,
    // Wave 5 life-signals: exertion-scaled FM breathing.
    breathingLeanFM,
    motionWorkIntensity,
  } from './services/liveliness';
  import { createBreathState } from './services/stageBreath';
  import { createClipBlend } from './services/stageClipBlend';
  import { createEyeGazeOverlay } from './services/stageEyeGaze';
  import { createIdleOverlay } from './services/stageIdleOverlay';
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
  import type {
    MotionRecording,
    MotionRecordingSourceKind,
    RecordedFrame,
  } from './services/motionRecording';
  import {
    READY_SETTLE_MS,
    READY_HOLD_MS,
    maxPoseAngleDiffDeg,
    readyTransitionNeeded,
    readyResetRootTarget,
  } from './services/readyTransition';
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
    idleLiveliness = 0.4,
    posable = false,
    diagnostics = false,
    onReport,
    onPoseDropped,
    onSelectJoint,
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
    /** IDLE liveliness dial (0..1, default 0.4 — unforced natural life).
     *  While NO motion drives the skeleton (between commands — the most-
     *  watched moment), the stage layers the same naturalistic prior motion
     *  playback carries — breathing at the thorax, postural micro-sway at the
     *  low back — plus a slow 4–8 s idle weight shift (a subtle side-to-side
     *  settle over the feet), so the patient never reads as a statue. Purely
     *  additive live-only deltas: they are lifted before every recording /
     *  captureFrame sample and before any command takes the skeleton, so
     *  recordings, goniometry and motion playback stay byte-clean. 0 = clean
     *  mode — a perfectly still, repeatable idle (and the idle-render
     *  optimization keeps skipping frames). */
    idleLiveliness?: number;
    /** Fires with the engine-computed clinical joint angles after the
     *  initial load and after each command settles (the truth the host
     *  grades against). With `motionReportHz > 0` it additionally fires
     *  throttled during motion playback. */
    onReport?: (report: JointAngleReport) => void;
    /** OPT-IN hand-posing layer (simMOVE's unified studio). Default OFF —
     *  existing consumers (simLAB / 3DPainMap) are byte-identically untouched.
     *  When true, the stage mounts the same modular posing services the
     *  PoseLab editor uses: clickable joint markers, IK drag-to-pose, the
     *  full-ring FK rotate gizmo (+ camera-space E ring), Esc/click-off
     *  deselect, coupled pronation/supination, spine/neck curve chains,
     *  finger curls, pelvis plant — plus the studio extras (limb-axis
     *  overlay, anatomical planes, cross-section slicing) behind the
     *  exported setPosingOptions/setPlanes/setSlice methods. Posing is
     *  automatically SUSPENDED while any motion drives the skeleton (clip,
     *  composed, exam tween, pose-play preview); a paused recording frame
     *  (showRecordedFrame) is idle time, so it CAN be hand-posed and then
     *  baked via captureFrame. */
    posable?: boolean;
    /** MEASURE-ONLY live diagnostic HUD (default OFF — other consumers are
     *  byte-identically untouched). When true, a small on-canvas readout
     *  reports the ACTUAL post-overlay trunk lateral lean, low-back segment
     *  lean and pelvis lateral shift, plus which live overlays/modifiers are
     *  active and the current frame source (idle / transition / composed /
     *  clip / held). Reads the rendered bones — so an onset/transition tilt
     *  self-identifies on screen. Never repositions the body. */
    diagnostics?: boolean;
    /** Fires when the authored pose is rejected at load time ('variant',
     *  'schema', 'empty', 'no-skeleton'); the stage continues anatomic. */
    onPoseDropped?: (reason: string) => void;
    /** Posing layer only: fires when the user selects (canonical key) or
     *  deselects (null) a joint marker. */
    onSelectJoint?: (key: string | null) => void;
  } = $props();

  let container: HTMLDivElement;
  let loading = $state(true);
  let loadError = $state('');

  // ── Live diagnostic readout (opt-in via `diagnostics`) ───────────────────
  // Measure-only. The pure computation lives in services/stageDiagnostics; the
  // component keeps only the per-frame throttle + the reactive value the HUD
  // renders. Sampled from the ACTUAL rendered bones (after overlays bake).
  let diag = $state<StageDiagnostics | null>(null);
  let lastDiagMs = 0;

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
  // Out-of-band immediate cancel (PR 1) — Stop bypasses the serialized command
  // chain: it tears down the active composed motion / clip synchronously so the
  // motion's promise resolves 'cancelled' within a frame, not after the queue drains.
  let cancelActiveMovementImpl: (() => void) | null = null;
  // Clinical ROM caps enforced per frame during motion (L2 modifier). The host
  // installs the constraint set (setRomScenarioConstraints); this list is the
  // joints to clamp each frame while a capped motion plays.
  let setMotionRomCapsImpl: ((keys: string[]) => void) | null = null;
  let setMotionOverlaysImpl:
    | ((
        overlays: {
          guarding?: number;
          balanceSway?: number;
          pelvisShiftCm?: number;
          liveliness?: number;
        } | null,
      ) => void)
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
   * STOP the active movement immediately, OUT OF BAND (PR 1 runtime foundation).
   * Unlike the queued stop-motion command, this does NOT wait for the serialized
   * command chain to drain — it tears down the active composed motion (its
   * `applyComposedMotion` promise resolves 'cancelled') and/or clip synchronously,
   * so a Stop lands within one frame. Idempotent when nothing is playing.
   */
  export function cancelActiveMovement(): void {
    cancelActiveMovementImpl?.();
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

  // ── Motion recording tap ─────────────────────────────────────────────────
  // Samples the LIVE stage into a MotionRecording while active — works across
  // composed playback, clip playback, exam commands, and idle manual time.
  // Negligible overhead when not recording (one null check per rAF frame).
  let startRecordingImpl:
    | ((opts?: {
        sampleHz?: number;
        name?: string;
        sourceKind?: MotionRecordingSourceKind;
        sourceName?: string;
      }) => void)
    | null = null;
  let stopRecordingImpl: (() => MotionRecording | null) | null = null;
  let showRecordedFrameImpl: ((frame: RecordedFrame) => void) | null = null;
  let captureFrameImpl: (() => RecordedFrame | null) | null = null;

  /**
   * Start sampling the live stage into a recording at `sampleHz` (default 30):
   * per sample it serializes the current pose, MEASURES computeJointAngles,
   * captures the model-root transform, and tracks the default bone set's world
   * positions. Reuses the motionReportHz throttling pattern inside the
   * existing rAF loop — no second loop. A second call restarts the recording.
   */
  export function startRecording(opts?: {
    sampleHz?: number;
    name?: string;
    sourceKind?: MotionRecordingSourceKind;
    sourceName?: string;
  }): void {
    startRecordingImpl?.(opts);
  }

  /** Stop sampling and return the captured recording (null when the stage
   *  never booted / nothing was recording). */
  export function stopRecording(): MotionRecording | null {
    return stopRecordingImpl?.() ?? null;
  }

  /**
   * Show one recorded frame on the stage (timeline scrubbing): cancels any
   * active motion, applies the frame's pose + root transform verbatim, updates
   * pose/root continuity state, and reports the measured angles. Subsequent
   * exam commands fine-tune FROM this frame (ROM-clamped as always).
   */
  export function showRecordedFrame(frame: RecordedFrame): void {
    showRecordedFrameImpl?.(frame);
  }

  /** One-off capture of the CURRENT stage state as a RecordedFrame (pose +
   *  measured angles + root + tracked-bone world positions) at tMs 0 — the
   *  hosts' "bake this hand-tuned pose into the timeline" source. */
  export function captureFrame(): RecordedFrame | null {
    return captureFrameImpl?.() ?? null;
  }

  /**
   * Set additive clinical overlays applied per frame during motion (L2, Build D).
   * `guarding` (0..1) stiffens the trunk and arms toward neutral — reduced
   * excursion, the guarded/protective movement pattern. `balanceSway` (0..1) adds
   * a slow postural wobble (lateral + AP lean at the low back) over the planted
   * base — the unsteady/reduced-balance pattern. `pelvisShiftCm` offsets the
   * model root laterally by a constant amount (+ = the patient's LEFT, +X;
   * clamped to ±15 cm) — the antalgic weight-shift off a painful limb; it
   * composes with any root travel/pin and fully resets on clear. `liveliness`
   * (0..1) adds an always-on naturalistic prior — breathing at the thorax +
   * micro-sway at the low back — so a looped motion never reads as frozen;
   * 0 = clean/repeatable, ~0.4 = natural. Pass `null`/0 to clear.
   */
  export function setMotionOverlays(
    overlays: {
      guarding?: number;
      balanceSway?: number;
      pelvisShiftCm?: number;
      liveliness?: number;
    } | null,
  ): void {
    setMotionOverlaysImpl?.(overlays);
  }

  // ── Posing layer surface (posable hosts only; no-ops otherwise) ──────────
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

  interface PoseApi {
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
  let poseApiImpl: PoseApi | null = null;
  // Setter calls that arrive BEFORE the async boot wires the posing layer
  // (hosts push their persisted toggles from $effects at mount) are buffered
  // and flushed when the layer comes up, so no host state is ever dropped.
  let pendingPosingOptions: StagePosingOptions | null = null;
  let pendingPlanes: StagePlaneVisibility | null = null;
  let pendingSlice: StageSliceOptions | null = null;

  /** Serialize the CURRENT on-stage pose (posable only; else null). */
  export function getPose(): CustomPose | null {
    return poseApiImpl?.getPose() ?? null;
  }
  /** Apply a serialized pose to the rig (cancels any active motion first). */
  export function loadPose(pose: CustomPose): void {
    poseApiImpl?.loadPose(pose);
  }
  /** Return the rig to the anatomic baseline pose. */
  export function resetPose(): void {
    poseApiImpl?.resetPose();
  }
  /** Toggle the baseline↔current pose-motion preview. Returns whether the
   *  preview is now playing. */
  export function togglePosePlay(): boolean {
    return poseApiImpl?.togglePosePlay() ?? false;
  }
  /** Smoothly swing the camera focus to the selected joint. */
  export function focusSelectedJoint(): void {
    poseApiImpl?.focusSelectedJoint();
  }
  /** Clear the joint selection (same as Esc / click-off). */
  export function deselectJoint(): void {
    poseApiImpl?.deselectJoint();
  }
  /** Posing behaviour + overlay toggles (ROM clamp / twist rig / markers /
   *  limb axes). Partial — omitted keys keep their current value. */
  export function setPosingOptions(opts: StagePosingOptions): void {
    if (poseApiImpl) poseApiImpl.setPosingOptions(opts);
    else pendingPosingOptions = { ...pendingPosingOptions, ...opts };
  }
  /** Anatomical reference plane visibility. Partial, like setPosingOptions. */
  export function setPlanes(planes: StagePlaneVisibility): void {
    if (poseApiImpl) poseApiImpl.setPlanes(planes);
    else pendingPlanes = { ...pendingPlanes, ...planes };
  }
  /** Cross-section slicing state (plane / flip / solid cap / depth). */
  export function setSlice(slice: StageSliceOptions): void {
    if (poseApiImpl) poseApiImpl.setSlice(slice);
    else pendingSlice = { ...pendingSlice, ...slice };
  }
  /** Export an authored keyframe timeline as a rotation-only GLB clip (the
   *  same slim bones-only export PoseLab shipped). Posable only. */
  export function exportAnimationGlb(
    frames: { t: number; pose: CustomPose }[],
    name: string,
    rootMotion = false,
  ): Promise<void> {
    return poseApiImpl?.exportAnimationGlb(frames, name, rootMotion) ?? Promise.resolve();
  }

  onMount(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // Bare 'three' specifiers only — a second three instance would break
      // the instanceof checks inside the pose services.
      const THREE = await import('three');
      // Services via relative paths (not the barrel) — the barrel re-exports
      // this component, so importing it here would be circular.
      const { getBodyVariant } = await import('./anatomy/bodyVariants');
      const { createMannequinRenderer, addMannequinLights, loadVariantModel, loadGltfWithRetry } =
        await import('./services/sceneBoot');
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
      const {
        composedTweenEase,
        stagedBlendWithBaseline,
        buildComposedTrajectory,
        buildLoopTrajectory,
        DEFAULT_TRACKED_BONES,
        GAIT_VERTICAL_MAX_RISE_M,
        authoredToTrajectoryTimeScale,
        scaleStanceWindowsMs,
      } = await import('./services/motionRecording');
      const {
        captureFloorReference,
        captureFootFrames,
        pinRootToFloor,
        pinContactsToFloor,
        groundingContactsFor,
        plantStanceFoot,
        stanceFootDrift,
        rotateRestReferenceByRoot,
        deriveVerticalCalibration,
        applyVerticalCalibration,
        NO_VERTICAL_CALIBRATION,
        VCAL_HANDOFF_BLEND_MS,
        deriveFootDrivenTravel,
        deriveGaitLateralShuttle,
        deriveHeelStrikeAccents,
        headingProfileLookup,
        heelStrikeOffsetAt,
        deriveWeightedDescent,
        applyWeightedDescent,
        weightedDescentApplies,
        deriveGroundingBlendSpans,
        groundingBlendAt,
        applyBlendedGroundingY,
        handReachWeightAt,
        FOOT_ROOT_DRIFT_M,
      } = await import('./services/rootMotion');
      const { buildFootPlant, solveFootPlant, solveFootPlantWeighted, PLANT_RELEASE_BLEND_MS, buildHandPlant, solveHandReach } =
        await import('./services/footContact');
      const { balanceCoordination } = await import('./services/balanceCoordination');
      const { computeBodyCoMFromBones } = await import('./services/centerOfMass');
      const { resolveMotionCommand } = await import('./services/motionCommand');
      const { normalizeRigBoneName } = await import('./services/movementClipSampling');
      const { createClinicalCameraControls } = await import('./services/clinicalCameraControls');

      if (disposed || !container) return;

      const scene = new THREE.Scene();
      scene.background = null; // transparent → the CSS backdrop shows through

      // SEAT PROP: a simple bench under the pelvis while the body is grounded
      // 'sitting', so the seated model rests on something instead of floating at
      // seat height. Positioned at the model's horizontal location each sitting
      // frame; hidden otherwise. Cosmetic — grounding/measurement are unaffected.
      const SEAT_SURFACE_M = 0.45; // seat-top world Y (above the ~0 floor)
      const seatProp = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, SEAT_SURFACE_M, 0.42),
        new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.9, metalness: 0 }),
      );
      seatProp.visible = false;
      scene.add(seatProp);
      /** Show/place the bench under the seated pelvis, or hide it. */
      function updateSeatProp(sitting: boolean): void {
        if (!sitting || !modelRoot) {
          if (seatProp.visible) {
            seatProp.visible = false;
            requestRender();
          }
          return;
        }
        const floorY = floorRef?.floorY ?? 0;
        const top = floorY + SEAT_SURFACE_M;
        // Centre the bench box between floor and seat-top, at the model's x,z
        // (a touch forward so the pelvis sits toward its back edge).
        seatProp.scale.set(1, Math.max(0.05, top - floorY) / SEAT_SURFACE_M, 1);
        seatProp.position.set(modelRoot.position.x, (floorY + top) / 2, modelRoot.position.z + 0.05);
        seatProp.visible = true;
      }
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
      // Rest WORLD frame of each ankle — the target closed-chain foot-rooted
      // planting restores the stance foot to (services/rootMotion). Captured with
      // floorRef at grounding; used for the quasi-static planted set below.
      let footFrames: ReturnType<typeof captureFootFrames> | null = null;
      const rootRestPos = new THREE.Vector3();
      const rootRestQuat = new THREE.Quaternion();
      // Foot-rooted planting re-roots via applyMatrix4, which re-decomposes the
      // root matrix a hair off scale-neutral; scale is reset per frame (in
      // applyTrajectoryRoot) from this rest so the drift can never accumulate.
      const rootRestScale = new THREE.Vector3(1, 1, 1);
      // FOOT_ROOT_DRIFT_M: stance-foot drift (m) above which a planted, in-place
      // composed frame is re-rooted at the foot; below it (a single-leg stance)
      // the vertical pin is enough and a re-root would only perturb the
      // measurement frame. ONE constant imported from services/rootMotion,
      // shared with the offline sampler + the balanceCoordination pre-pass.
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
        pelvisShiftBakedM = 0; // absolute write — any baked pelvis shift is gone
        modelRoot.updateMatrixWorld(true);
      }

      /** Restore the model root to its grounded rest transform (upright, origin).
       *  Called when a clip or exam command takes over from a composed posture. */
      function resetRootToRest(): void {
        composedRootQuat = [0, 0, 0, 1];
        composedRootTranslate = [0, 0, 0];
        updateSeatProp(false); // upright at origin ⇒ no seat
        if (!modelRoot) return;
        modelRoot.quaternion.copy(rootRestQuat);
        modelRoot.position.copy(rootRestPos);
        pelvisShiftBakedM = 0; // absolute write — any baked pelvis shift is gone
        modelRoot.updateMatrixWorld(true);
      }

      /** Is the body off its neutral ready stance (in pose, travel, or orientation)
       *  enough to warrant a visible return-to-ready before the next command? */
      function needsReadySettle(): boolean {
        if (!currentPose || !baselinePoseRef) return false;
        return readyTransitionNeeded({
          poseAngleDiffDeg: maxPoseAngleDiffDeg(currentPose, baselinePoseRef),
          rootHorizontalM: Math.hypot(composedRootTranslate[0], composedRootTranslate[2]),
          // SEAM-10: a body left off the grounded standing Y tweens back down
          // rather than snapping via the resetRootToRest else-branch below.
          rootVerticalM: Math.abs(composedRootTranslate[1]),
          rootUprightW: Math.abs(composedRootQuat[3]),
        });
      }

      /** The "pause at a ready stance" beat between two directed commands. */
      async function holdReadyBeat(token: number): Promise<void> {
        if (READY_HOLD_MS <= 0 || token !== composedSeq || stageHidden()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, READY_HOLD_MS));
      }

      /** NATURAL RETURN-TO-READY between two directed movements: ease the current
       *  pose back to the anatomic neutral stance and settle the root UPRIGHT + IN
       *  PLACE (keep the horizontal position — the person stands up where they are,
       *  they do not teleport/slide back to the origin), then hold a brief beat.
       *  Reuses the proven staged pose tween; guarded by the command token so a new
       *  command mid-settle supersedes it. */
      async function playReadySettle(token: number): Promise<void> {
        if (!baselinePoseRef) return;
        // SEAM-10: the grounded-standing target is the ONE pure truth — upright,
        // horizontal position preserved (stand up in place), vertical eased down
        // to the grounded standing Y. TWEENED over READY_SETTLE_MS (never snapped),
        // so the pelvis lands on the floor with no per-frame jump and no rootY drift.
        const { toQuat, toTranslateM } = readyResetRootTarget(composedRootTranslate);
        await tweenTo(baselinePoseRef, READY_SETTLE_MS, {
          fromQuat: [...composedRootQuat],
          toQuat,
          fromTranslate: [...composedRootTranslate],
          toTranslate: toTranslateM,
          planted: true,
        });
        // The body now stands ready in place; carry that grounded root state forward
        // so the next motion continues from here rather than snapping to the origin.
        composedRootQuat = toQuat;
        composedRootTranslate = toTranslateM;
        await holdReadyBeat(token);
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
      // Clip transition ease-in (services/stageClipBlend): captures the current
      // pose (a live outgoing clip frame OR a Stop-frozen mid-stride pose) when a
      // clip starts and slerps it into the new clip over CLIP_BLEND_SEC, so a
      // run→walk swap (or a start from a frozen pose) eases in instead of
      // hard-cutting to the clip's frame 0. Does NOT change Stop-freeze itself.
      const clipBlend = createClipBlend();
      const CLIP_BLEND_SEC = 0.3;
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
      // Liveliness overlay: an always-on naturalistic prior (breathing at the
      // thorax + a small postural micro-sway at the low back) so a looped motion
      // never reads as frozen or robotic. Wall-clock phase (advanced by
      // motionDelta, exactly like swayTime) is incommensurate with the motion
      // loop, so cycle K ≠ K+1 for free. Angle math lives in the pure, testable
      // ./services/liveliness module; here we only accumulate time + apply it as
      // additive premultiplied trunk rotations. Reuses the sway axes below.
      let motionLiveliness = 0;
      let livelinessTime = 0;
      // ONSET RAMP (kills the pre-movement side/back bend): the motion-time trunk
      // sway/breathing must ease IN over the first ~0.4 s of a movement, not apply
      // full-strength from frame 0. A commanded motion is a zero-velocity ease-in
      // (~stationary the first ~150-200 ms), so a full-strength free-running sway at
      // t=0 was the ONLY thing moving then — reading as a spurious side/backward
      // lean BEFORE the movement. `livelinessOnsetSec` accumulates from motion onset
      // (reset by resetLivelinessOnset at each start); the applied sway is scaled by
      // min(1, onset/LIVELINESS_ONSET_SEC).
      const LIVELINESS_ONSET_SEC = 0.4;
      let livelinessOnsetSec = 0;
      const _liveQ = new THREE.Quaternion();
      // ── EXERTION-SCALED BREATHING (Wave 5 life-signals) — state shared by
      // BOTH breathing paths (motion-time overlay + idle overlay), so the
      // breath never restarts or rate-jumps when a motion begins or ends:
      // Shared phase/exertion/workIntensity clock — see services/stageBreath.
      const breath = createBreathState();
      // ── IDLE liveliness (un-gated naturalism): breathing + micro-sway + a
      // slow weight shift while NOTHING drives the skeleton, so the patient
      // never freezes into a statue between commands. Same pure phase math as
      // the motion-time overlay (services/liveliness) + the same trunk axes,
      // PLUS idleWeightShift riding the pelvis-shift root actuator. Applied as
      // an undo/reapply sandwich each idle frame: the EXACT pre-overlay bone
      // quats + root offset are stored on apply and restored first thing next
      // frame — so the deltas can never accumulate, the recording tap always
      // samples the clean underlying pose, and any takeover (command / clip /
      // composed / scrub / hand-posing) starts from untouched state.
      // Idle-liveliness overlay (breathing + micro-sway + weight-shift +
      // ankle-pivot) — services/stageIdleOverlay. Own state; the pelvis-shift
      // bake stays here (root owner) and reads idleOverlay.shiftM.
      const idleOverlay = createIdleOverlay(Math.random() * 1000);
      // Pelvis-shift overlay: a CONSTANT lateral offset on the MODEL ROOT X — the
      // antalgic weight-shift off a painful limb. + = the patient's left (+X, the
      // TRAVEL_DIRECTION_AXIS lateral sign). It must COMPOSE with the per-frame
      // root writes (trajectory travel, floor-pin, foot-rooting) rather than fight
      // them: `pelvisShiftBakedM` tracks what is currently baked into the root X;
      // every ABSOLUTE root write zeroes the tracker, and bakePelvisShift() re-adds
      // the delta — so the offset lands exactly once per frame and un-bakes on clear.
      let motionPelvisShiftM = 0; // requested shift, meters (clamped ±0.15)
      let pelvisShiftBakedM = 0; // shift currently baked into modelRoot.position.x
      const PELVIS_SHIFT_MAX_M = 0.15;
      function bakePelvisShift(): void {
        // The bake target composes the antalgic overlay shift with the idle
        // weight shift (idle-only; zeroed before any motion takes the root).
        const targetM = motionPelvisShiftM + idleOverlay.shiftM;
        if (!modelRoot || pelvisShiftBakedM === targetM) return;
        modelRoot.position.x += targetM - pelvisShiftBakedM;
        pelvisShiftBakedM = targetM;
        modelRoot.updateMatrixWorld(true);
      }
      setMotionOverlaysImpl = (
        overlays: {
          guarding?: number;
          balanceSway?: number;
          pelvisShiftCm?: number;
          liveliness?: number;
        } | null,
      ) => {
        motionGuarding = Math.max(0, Math.min(1, overlays?.guarding ?? 0));
        motionSway = Math.max(0, Math.min(1, overlays?.balanceSway ?? 0));
        motionLiveliness = Math.max(0, Math.min(1, overlays?.liveliness ?? 0));
        motionPelvisShiftM = Math.max(
          -PELVIS_SHIFT_MAX_M,
          Math.min(PELVIS_SHIFT_MAX_M, (overlays?.pelvisShiftCm ?? 0) / 100),
        );
        // Re-bake immediately: a cleared overlay must never leave a shifted root
        // (mid-clip changes land here too; per-frame paths keep it composed).
        bakePelvisShift();
      };

      /** Bake the idle-liveliness deltas (breathing + micro-sway + weight-shift
       *  + ankle-pivot). Thin wrapper over services/stageIdleOverlay bound to the
       *  live bones/root/breath + the pelvis-shift bake. */
      function applyIdleOverlays(dtSec: number): boolean {
        return idleOverlay.apply(
          dtSec,
          idleLiveliness,
          motionCapBones,
          modelRoot,
          breath,
          _swayAxisAP,
          _swayAxisML,
          bakePelvisShift,
        );
      }

      /** Lift the baked idle deltas (exact restore + un-bake the idle shift).
       *  Wrapper over stageIdleOverlay. */
      function undoIdleOverlays(): boolean {
        return idleOverlay.undo(motionCapBones, modelRoot, bakePelvisShift);
      }
      // ── EYES · micro-gaze overlay (services/stageEyeGaze) ─────────────────
      // LIVE-ONLY, always-on gaze-absorb + seeded saccades, applied via an
      // undo/reapply sandwich so recordings/goniometry/export see the eyes at
      // rest. Thin wrappers below bind it to the live bones/root/rest per frame.
      const eyeGaze = createEyeGazeOverlay(Math.random() * 1000);

      /** Bake the micro-gaze onto the eye bones (live-only). Thin wrapper over
       *  services/stageEyeGaze bound to the current bones/root/rest. */
      function applyEyeGaze(dtSec: number): boolean {
        return eyeGaze.apply(
          dtSec,
          idleLiveliness,
          motionCapBones,
          modelRoot,
          restRef?.worldQuats.Head,
          rootRestQuat,
        );
      }

      /** Lift the baked eye deltas (exact restore). Wrapper over stageEyeGaze. */
      function undoEyeGaze(): boolean {
        return eyeGaze.undo(motionCapBones);
      }

      /** Snapshot the applied eye locals for the capture sandwich (or null).
       *  Wrapper over stageEyeGaze (SEAM-9). */
      function captureAppliedEyeGaze(): (() => void) | null {
        return eyeGaze.captureApplied(motionCapBones);
      }

      /**
       * MOTION-TIME liveliness (LIVE-ONLY realism): breathing at the thorax +
       * micro-sway at the low back while a MOTION drives the skeleton, layered ON
       * TOP of the driven pose. The animation driver (mixer/trajectory) overwrites
       * both trunk bones every frame, so the premultiplied delta never
       * accumulates. Applied AFTER the recording tap + streamed report (SEAM-9) —
       * the offline sampler never sees liveliness, so a recording/report that
       * carried it would diverge from the grade. Feet/legs + every measured driver
       * joint are untouched; only the two trunk bones move. Wall-clock phase
       * (livelinessTime) is incommensurate with the loop, so no cycle repeats.
       * Returns whether anything was applied (clean mode / no bones ⇒ false, so
       * the dirty flag stays honest).
       */
      /** Reset the motion-time liveliness onset ramp + sway phase — call at each
       *  movement START so the trunk eases into the sway from quiet, instead of
       *  a full-strength free-running sway snapping on during the ease-in. */
      function resetLivelinessOnset(): void {
        livelinessOnsetSec = 0;
        livelinessTime = 0; // ML sway restarts at phase 0 (breath.phase stays continuous)
      }
      function applyMotionLiveliness(dtSec: number): boolean {
        if (!(motionLiveliness > 0) || !motionCapBones || !modelRoot) return false;
        livelinessTime += dtSec;
        livelinessOnsetSec += dtSec;
        // Ease the sway/breathing IN over the first ~0.4 s of the movement so the
        // trunk is quiet through the commanded motion's zero-velocity ease-in (this
        // is the fix for the "little side/back bend before the movement"). Also
        // smooths the idle->motion lumbar handoff (no full-strength step at onset).
        const onsetRamp = Math.min(1, livelinessOnsetSec / LIVELINESS_ONSET_SEC);
        // EXERTION-SCALED FM breathing (Wave 5): integrate the shared phase at the
        // exertion-driven rate (phase-continuous — never t×rate, so a rate change
        // can never jump mid-breath).
        breath.advancePhase(dtSec);
        const thorax = motionCapBones.get('Spine_Upper');
        if (thorax) {
          const breathDeg = onsetRamp * breathingLeanFM(breath.phase, motionLiveliness, breath.exertion);
          _liveQ.setFromAxisAngle(_swayAxisAP, (breathDeg * Math.PI) / 180);
          thorax.quaternion.premultiply(_liveQ);
        }
        const lowBack = motionCapBones.get('Spine_Lower');
        if (lowBack) {
          const { mlDeg, apDeg } = livelinessSwayDeg(livelinessTime, motionLiveliness);
          _liveQ.setFromAxisAngle(_swayAxisML, (onsetRamp * mlDeg * Math.PI) / 180);
          lowBack.quaternion.premultiply(_liveQ);
          _liveQ.setFromAxisAngle(_swayAxisAP, (onsetRamp * apDeg * Math.PI) / 180);
          lowBack.quaternion.premultiply(_liveQ);
        }
        modelRoot.updateMatrixWorld(true);
        return true;
      }
      // ── Composed-motion (generative keyframe sequence) playback state ─────
      // Pose-tween driven (NOT the mixer). `composedActive` gates the same
      // guarding/sway overlays clip playback applies; `composedSeq` is a
      // cancellation token — any newer command bumps it and the composed
      // playback (including a detached loop cycle) stops at its next check.
      let composedActive = false;
      // The grounding posture applied to the CURRENT composed frame (PR 1 runtime
      // foundation) — set each frame by applyTrajectoryRoot from the trajectory
      // sample, so a live recording frame can carry it (posture recoverable by
      // scrub), exactly as the offline sampler stamps sample.groundingPosture.
      // Reset to null when composed playback ends / is taken over (cancelComposed),
      // so a subsequent clip/idle recording can never inherit a stale posture.
      let composedCurrentGrounding: string | null = null;
      let composedSeq = 0;
      // Cancellation tokens (PR 1 runtime foundation). composedActiveToken is the
      // composedSeq of the CURRENTLY playing composed motion; composedCancelledToken
      // marks the token a caller explicitly stopped via cancelActiveMovement, so the
      // awaiting runComposedImpl can tell an out-of-band USER CANCEL ('cancelled')
      // apart from being SUPERSEDED by a newer command ('interrupted').
      let composedActiveToken = 0;
      let composedCancelledToken: number | null = null;
      // True once at least one composed movement has played this session — gates the
      // between-command "pause at a ready stance" beat (the first command starts
      // promptly; subsequent ones get the directed pause).
      let composedHasPlayed = false;
      function cancelComposed() {
        composedSeq += 1;
        composedActive = false;
        updateSeatProp(false); // hide the seat when a motion ends / is taken over
        composedPlants = []; // drop any foot-contact IK for the ended motion
        composedPlantRest = null; // drop any heading-rotated plant-clamp frame
        composedHandPlants = []; // drop any hand-contact IK for the ended motion
        composedUseFootRoot = false; // drop foot-rooted planting for the ended motion
        composedVcal = NO_VERTICAL_CALIBRATION; // drop any gait-vertical calibration
        composedVcalPhaseOffsetMs = 0; // drop the loop-form phase alignment
        composedVcalRampMs = 0; // drop the loop-form entry ramp
        composedVcalHandoff = null; // drop any in-flight vcal handoff blend
        composedFootDriven = null; // drop any foot-driven travel
        composedLateralShuttle = null; // drop any medio-lateral shuttle
        composedHeelStrike = null; // drop any footfall accents
        composedHeelStrikeY = 0;
        breath.setWorkIntensity(0); // exertion feed stops; the accumulator decays
        composedCurrentGrounding = null; // drop the frame grounding so a clip/idle recording can't inherit it
        // Abort an in-flight continuous trajectory so any awaiter unblocks.
        if (activeTrajectory) {
          const resolve = activeTrajectory.resolve;
          activeTrajectory = null;
          resolve();
        }
      }

      // Out-of-band Stop (PR 1): mark the active composed token as user-cancelled
      // (so its awaiting runComposedImpl resolves 'cancelled', not 'interrupted')
      // and tear the motion down NOW; also stop an active clip. Not queued on the
      // command chain, so Stop lands within a frame.
      //
      // FREEZE-FRAME: Stop HOLDS the mannequin at its current on-screen pose
      // rather than reverting to anatomic rest. Snapshot the live pose + root
      // BEFORE teardown (buildFrameNow lifts only the live-only idle/eye overlays,
      // so the freeze is the clean driven pose), tear the motion down, then
      // re-assert the snapshot — overriding BOTH revert paths: the composed path's
      // idle fallback AND the clip path's stopMotion()→applyPoseNow(currentPose)
      // (which would otherwise snap back to the pre-clip pose). Idle liveliness
      // (breathing) then resumes on top of the frozen pose.
      cancelActiveMovementImpl = () => {
        const frozen = buildFrameNow(0);
        if (composedActive) {
          composedCancelledToken = composedActiveToken;
          cancelComposed();
        }
        if (activeMotionId) stopMotion();
        if (frozen && skinnedRef && variantCfgRef) {
          applyCustomPose(skinnedRef.skeleton, variantCfgRef, frozen.pose);
          currentPose = frozen.pose;
          composedRootQuat = [...frozen.root.orientQuat];
          composedRootTranslate = [...frozen.root.translateM];
          applyRootState(frozen.root.orientQuat, frozen.root.translateM);
          requestRender();
        }
      };

      // ── Posing-layer hooks (assigned by the posable init block below; all
      //    null when `posable` is false, so the default stage pays only a
      //    null check) ─────────────────────────────────────────────────────
      /** Rebuild markers/rigs/planes for a freshly loaded model. */
      let poseLayerOnModelLoaded: (() => void) | null = null;
      /** A motion command is taking the skeleton: cancel drags + selection. */
      let poseLayerOnTakeover: (() => void) | null = null;
      /** Per rendered frame, before renderer.render. */
      let poseLayerBeforeRender: (() => void) | null = null;
      /** Per rendered frame, after renderer.render (gizmo overlay pass). */
      let poseLayerAfterRender: (() => void) | null = null;
      /** True while the posing layer is ENGAGED (selection / drag / preview):
       *  idle liveliness suspends so hand-posing is never perturbed. */
      let poseLayerBusy: (() => boolean) | null = null;
      let poseLayerDispose: (() => void) | null = null;

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
        clipBlend.cancel(); // abandon any in-progress clip ease-in
        motionAction = null;
        activeMotionId = null;
        // Lift any ROM caps (the host clears its constraint set separately).
        motionCapKeys = [];
        motionCapLegs = [];
        motionGuarding = 0;
        motionSway = 0;
        swayTime = 0;
        motionPelvisShiftM = 0;
        bakePelvisShift(); // un-bake any lateral pelvis-shift residue from the root
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
        // Lift any idle-liveliness bake first (keeps the shift tracker exact),
        // then tear down any active motion + mixer bound to the outgoing model.
        undoIdleOverlays();
        undoEyeGaze(); // eye deltas too — the stored bases die with the model
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
            const gltf = await loadGltfWithRetry(url);
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

          // 4) Scenario ROM constraints are the `romConstraints` prop, read
          //    live and passed explicitly into each resolve/clamp/balance call
          //    (no module-global store) — display-side data from the host.

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
          rootRestScale.copy(root.scale);
          composedRootQuat = [0, 0, 0, 1];
          composedRootTranslate = [0, 0, 0];
          floorRef = skinned ? captureFloorReference(skinned.skeleton, variantCfg) : null;
          footFrames = skinned ? captureFootFrames(skinned.skeleton, variantCfg) : null;
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
          // Fresh skeleton: any idle-liveliness bake from the previous model is
          // void (the stored base quats belong to the discarded bones).
          idleOverlay.reset();
          eyeGaze.reset(); // same for the eye micro-gaze bake

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
          // 9) Rebuild the posing layer (markers / twist rig / planes) for
          //    the fresh skeleton (posable hosts only).
          poseLayerOnModelLoaded?.();
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
      // THE shared composed-tween easing (services/motionRecording) — the
      // offline sampler replays this exact curve, so stage playback and
      // headless sampling cannot diverge.
      const easeInOutCubic = composedTweenEase;

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
        pelvisShiftBakedM = 0; // absolute write — any baked pelvis shift is gone
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
          // Pose bones sequence proximal→distal (naturalism); the root (most
          // proximal) leads on the plain eased scalar. Both settle exactly on
          // target at t=1 — see services/motionStagger.
          const blended = stagedBlendWithBaseline(tw.from, tw.to, baselinePoseRef, t);
          if (blended) applyCustomPose(skinnedRef.skeleton, variantCfgRef, blended);
        }
        if (tw.root) applyRootTween(tw.root, eased);
        requestRender();
      }

      // ── Continuous composed-motion player (services/motionTrajectory) ──────
      // Replaces the old per-keyframe stop-start await-loop: ONE velocity-
      // continuous spline flows through every keyframe, easing to rest only at
      // holds and the end. Built by the SAME function the offline sampler uses,
      // so the recording is frame-for-frame what plays here.
      interface ActiveTrajectory {
        traj: PoseTrajectory;
        start: number;
        settleAtMs: number[];
        nextSettle: number;
        onSettle: (i: number) => void;
        loop: boolean;
        resolve: () => void;
        finished: boolean;
        /** WARPED loop clock (ms) — the phase clock a looping motion is sampled at,
         *  advanced per frame at `cadenceRate` so the cadence drifts naturally cycle
         *  to cycle. Lazily seeded to the entry phase on the first frame (undefined
         *  until then); a fresh trajectory object resets it. Live-only. */
        warpClock?: number;
        warpPrevNow?: number;
      }
      let activeTrajectory: ActiveTrajectory | null = null;

      /** CLOSED-CHAIN FOOT CONTACT (Finding 4): the IK plants for the ACTIVE
       *  composed motion's `contacts`, mirroring the offline sampler. Each foot
       *  is pinned to the world position it holds as it ENTERS its stance window,
       *  so it stays put while the body travels over it (no moonwalk) — and an
       *  alternating gait re-pins per stance phase. Rebuilt per playback. */
      interface StageFootPlant {
        solver: ReturnType<typeof buildFootPlant>;
        fromMs: number;
        toMs: number;
        target: import('three').Vector3 | null;
        /** PER-WINDOW plant-clamp rest frame (CURVED heading only): restRef
         *  rotated by the heading at THIS window's start. Absent ⇒ the shared
         *  composedPlantRest / restRef path (mirrors the sampler's per-plant
         *  rest). */
        rest?: ReturnType<typeof captureJointAngleRestReference>;
      }
      let composedPlants: StageFootPlant[] = [];

      /** PLANT-CLAMP REST FRAME for the active composed motion: the leg-IK ROM
       *  clamps decompose bone WORLD quats against the rest reference, so a walk
       *  on a ROTATED heading clamps against the heading-rotated reference (the
       *  un-rotated one reads the yaw as spurious hip angles and drags the
       *  planted foot). Null — the legacy `restRef` path — unless the motion
       *  carries a non-zero heading. The knee hinge axis always keeps the
       *  ORIGINAL restRef (solveFootPlant's hingeAxisRest). Mirrors the offline
       *  sampler's plantRest. */
      let composedPlantRest: ReturnType<typeof captureJointAngleRestReference> | null = null;

      /** HAND PLANTS (Phase 3 Tier B): for a grounding posture that declares a hand
       *  as a 'reach' contact (plank/push-up), an arm IK chain that pins the hand to
       *  a FIXED floor point so it stays planted as the chest lowers (the arm folds).
       *  Mirror of {@link composedPlants} on the arm chain. Rebuilt per playback. */
      interface StageHandPlant {
        solver: ReturnType<typeof buildFootPlant>;
        bone: string;
        target: import('three').Vector3 | null;
      }
      let composedHandPlants: StageHandPlant[] = [];

      /** CLOSED-CHAIN FOOT-ROOTED PLANTING for the ACTIVE composed motion — true
       *  for the quasi-static planted set (squat/hinge/sit-to-stand): each planted
       *  frame is re-rooted at the stance foot so the body folds/drops over PLANTED
       *  feet (COM over the base — balance for free), instead of the feet swinging
       *  forward. Same gate as the offline sampler so live and recordings match. */
      let composedUseFootRoot = false;

      /** CALIBRATED GAIT VERTICAL for the ACTIVE composed motion — the
       *  mean-preserving reshape of the emergent grounded pelvis arc to a cm
       *  target (root-only; joints untouched), mirroring the offline sampler via
       *  the SAME shared helper. Identity unless a planted motion requests it. */
      let composedVcal = NO_VERTICAL_CALIBRATION;
      /** Cycle length (ms) of the trajectory `composedVcal` was derived from — the
       *  phase base for the smoothed vertical lookup (may be the loop trajectory,
       *  whose period differs from the one-shot `trajectory`). 0 ⇒ no phase base. */
      let composedVcalCycleMs = 0;
      /** Phase OFFSET (ms) subtracted from playback time before indexing the
       *  smoothed vcal table (DET-LOCK-02): non-zero only while a LOOPING
       *  motion's ONE-SHOT first pass rides its LOOP-derived table — the
       *  one-shot reaches keyframe i at τᵢ + dur₀ while the loop indexes it at
       *  phase τᵢ, so subtracting the first keyframe's arrival keeps the table
       *  phase CONTINUOUS across the loop-engage boundary (was a ~3.4 cm pelvis
       *  step). Reset to 0 when the loop clock (whose time IS cycle phase)
       *  engages. Mirrors the offline sampler's vcalPhaseOffsetMs exactly. */
      let composedVcalPhaseOffsetMs = 0;
      /** Entry RAMP (ms): the loop-form table blends in from the live floor-pin
       *  over the one-shot intro (phase 0⁻ of the loop table is the wrap
       *  segment, not the standing start). 0 ⇒ table fully engaged — every
       *  non-loop motion, and the loop clock. Mirrors the sampler's vcalRampMs. */
      let composedVcalRampMs = 0;
      /** VCAL HANDOFF BLEND (DET-LOCK-02): any residual applied-vertical
       *  difference measured at the first-pass → loop handoff decays over
       *  VCAL_HANDOFF_BLEND_MS instead of stepping discretely. ~0 by
       *  construction with the shared loop-form derivation + phase alignment;
       *  the blend guards the seam against any drift. Live-only (wall-clock) —
       *  the offline sampler records single passes and never hands off. */
      let composedVcalHandoff: { deltaYM: number; startedAtMs: number } | null = null;

      /** Measure the emergent grounded pelvis arc of a starting composed motion's
       *  trajectory and set `composedVcal` to hit its requested excursion. Called
       *  once when a calibrated planted motion begins; resets to identity
       *  otherwise. Poses the rig transiently (the player re-poses every frame). */
      function setComposedVerticalCalibration(
        traj: PoseTrajectory,
        targetCm: number | undefined,
        hasPlanted: boolean,
      ): void {
        composedVcal = NO_VERTICAL_CALIBRATION;
        composedVcalCycleMs = 0;
        composedVcalPhaseOffsetMs = 0;
        composedVcalRampMs = 0;
        composedVcalHandoff = null;
        if (targetCm == null || !hasPlanted || !skinnedRef || !variantCfgRef || !floorRef || !modelRoot) return;
        composedVcalCycleMs = traj.totalMs;
        composedVcal = deriveVerticalCalibration((u01) => {
          const s = traj.sampleAt(u01 * traj.totalMs);
          applyCustomPose(skinnedRef!.skeleton, variantCfgRef!, s.pose);
          _rootQA.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
          modelRoot!.quaternion.copy(rootRestQuat).multiply(_rootQA);
          modelRoot!.position.set(
            rootRestPos.x + s.rootTranslate[0],
            rootRestPos.y + s.rootTranslate[1],
            rootRestPos.z + s.rootTranslate[2],
          );
          pelvisShiftBakedM = 0; // transient absolute write — keep the tracker honest
          modelRoot!.updateMatrixWorld(true);
          if (s.planted) pinRootToFloor(modelRoot!, skinnedRef!.skeleton, variantCfgRef!, floorRef!);
          return modelRoot!.position.y;
          // smooth: round the sharp double-support valley. When feet are foot-plant IK'd
          // (the travelling walk), clamp how far the smoothed pelvis may rise above the pin
          // so a planted stance leg doesn't over-reach and slide the foot — the SAME
          // maxRiseM the offline sampler passes, under the SAME plants-active condition
          // (DET-LOCK-01 lockstep); the contact-free in-place walk (treadmill) has no such
          // foot to over-reach, so no clamp.
        }, targetCm / 100, 48, true, composedPlants.length > 0 ? GAIT_VERTICAL_MAX_RISE_M : undefined);
      }

      /** FOOT-DRIVEN forward travel for the ACTIVE composed motion — the derived
       *  +Z offset that keeps the planted foot world-fixed, mirroring the sampler
       *  via the SAME shared helper. Null unless the motion requests it. */
      let composedFootDriven: ReturnType<typeof deriveFootDrivenTravel> | null = null;

      /** The planned stance schedule of a resolved motion (gaitStanceWindowsMs),
       *  scaled from authored ms to trajectory time by the same uniform factor
       *  the trajectory applies — so the derivations stay phase-locked to the
       *  knots at any pace (mirrors the offline sampler). */
      function scaledStanceWindows(
        traj: PoseTrajectory,
        resolvedMotion: {
          gaitStanceWindowsMs?: { foot: string; fromMs: number; toMs: number; travelLock?: boolean }[];
          keyframes: { durationMs: number; holdMs: number }[];
          loop: boolean;
          reps: number;
        },
      ): { foot: string; fromMs: number; toMs: number; travelLock?: boolean }[] | undefined {
        // SEAM-2: the SAME shared authored→trajectory factor the offline sampler
        // (and the plant contacts) use — one source of truth for the time base.
        return scaleStanceWindowsMs(
          resolvedMotion.gaitStanceWindowsMs,
          authoredToTrajectoryTimeScale(resolvedMotion, traj.totalMs),
        );
      }

      /** The per-time heading lookup of a CURVED motion (headingProfileMs),
       *  scaled from authored ms to trajectory time by the SAME uniform factor
       *  as {@link scaledStanceWindows} — so heading and stance phase can never
       *  drift apart at a non-1 pace. Undefined for a constant heading (the
       *  byte-identical legacy path). Mirrors the offline sampler. */
      function scaledHeadingAt(
        traj: PoseTrajectory,
        resolvedMotion: {
          headingProfileMs?: { tMs: number; headingDeg: number }[];
          keyframes: { durationMs: number; holdMs: number }[];
          loop: boolean;
          reps: number;
        },
      ): ((tMs: number) => number) | undefined {
        const prof = resolvedMotion.headingProfileMs;
        if (!prof || prof.length < 2) return undefined;
        // SEAM-2: the SAME shared factor as the stance windows + plant contacts.
        const scale = authoredToTrajectoryTimeScale(resolvedMotion, traj.totalMs);
        const lookup = headingProfileLookup(prof);
        return scale > 0 ? (tMs: number): number => lookup(tMs / scale) : lookup;
      }

      /** Pre-pass the starting motion's trajectory (FK + floor-pin, no travel),
       *  read the feet, and derive the travel curve that keeps the planted foot
       *  fixed — along the motion's heading (0 = straight ahead, the
       *  byte-identical legacy +Z ride). Resets to null otherwise. */
      function setComposedFootDriven(
        traj: PoseTrajectory,
        enabled: boolean,
        hasPlanted: boolean,
        stanceWindows?: { foot: string; fromMs: number; toMs: number; travelLock?: boolean }[],
        headingDeg = 0,
        headingAt?: (tMs: number) => number,
      ): void {
        composedFootDriven = null;
        if (!enabled || !hasPlanted || !skinnedRef || !variantCfgRef || !floorRef || !modelRoot) return;
        const bones = buildBoneByPoseKey(skinnedRef.skeleton, variantCfgRef);
        const rBone = bones.get('R_Foot');
        const lBone = bones.get('L_Foot');
        if (!rBone || !lBone) return;
        composedFootDriven = deriveFootDrivenTravel((tMs) => {
          const s = traj.sampleAt(tMs);
          applyCustomPose(skinnedRef!.skeleton, variantCfgRef!, s.pose);
          _rootQA.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
          modelRoot!.quaternion.copy(rootRestQuat).multiply(_rootQA);
          modelRoot!.position.set(
            rootRestPos.x + s.rootTranslate[0],
            rootRestPos.y + s.rootTranslate[1],
            rootRestPos.z + s.rootTranslate[2],
          );
          pelvisShiftBakedM = 0; // transient absolute write — keep the tracker honest
          modelRoot!.updateMatrixWorld(true);
          if (s.planted) pinRootToFloor(modelRoot!, skinnedRef!.skeleton, variantCfgRef!, floorRef!);
          const rp = rBone.getWorldPosition(new THREE.Vector3());
          const lp = lBone.getWorldPosition(new THREE.Vector3());
          // An un-pinned sample is a run's ballistic FLIGHT gap (both feet
          // airborne): the travel derivation holds its advance through it
          // (mirrors the offline sampler's closure exactly).
          return { rz: rp.z, ry: rp.y, rx: rp.x, lz: lp.z, ly: lp.y, lx: lp.x, bothAirborne: !s.planted };
        }, traj.totalMs, stanceWindows, 120, headingDeg, headingAt);
      }

      /** MEDIO-LATERAL SHUTTLE for the ACTIVE composed motion — the derived ±X
       *  pelvis ride toward the planted foot (per-step weight transfer),
       *  mirroring the sampler via the SAME shared helper. Null unless the
       *  motion requests it (`lateralShuttleCm`). */
      let composedLateralShuttle: ReturnType<typeof deriveGaitLateralShuttle> | null = null;

      /** Pre-pass the starting motion's trajectory (FK + floor-pin, no travel),
       *  read the feet, and derive the stance-phase-locked lateral shuttle —
       *  perpendicular to the motion's heading (0 = the byte-identical legacy
       *  world-X ride). Resets to null otherwise. Mirrors setComposedFootDriven. */
      function setComposedLateralShuttle(
        traj: PoseTrajectory,
        shuttleCm: number | undefined,
        hasPlanted: boolean,
        stanceWindows?: { foot: string; fromMs: number; toMs: number; travelLock?: boolean }[],
        headingDeg = 0,
        headingAt?: (tMs: number) => number,
      ): void {
        composedLateralShuttle = null;
        if (!shuttleCm || shuttleCm <= 0 || !hasPlanted || !skinnedRef || !variantCfgRef || !floorRef || !modelRoot) return;
        const bones = buildBoneByPoseKey(skinnedRef.skeleton, variantCfgRef);
        const rBone = bones.get('R_Foot');
        const lBone = bones.get('L_Foot');
        if (!rBone || !lBone) return;
        composedLateralShuttle = deriveGaitLateralShuttle((tMs) => {
          const s = traj.sampleAt(tMs);
          applyCustomPose(skinnedRef!.skeleton, variantCfgRef!, s.pose);
          _rootQA.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
          modelRoot!.quaternion.copy(rootRestQuat).multiply(_rootQA);
          modelRoot!.position.set(
            rootRestPos.x + s.rootTranslate[0],
            rootRestPos.y + s.rootTranslate[1],
            rootRestPos.z + s.rootTranslate[2],
          );
          pelvisShiftBakedM = 0; // transient absolute write — keep the tracker honest
          modelRoot!.updateMatrixWorld(true);
          if (s.planted) pinRootToFloor(modelRoot!, skinnedRef!.skeleton, variantCfgRef!, floorRef!);
          const rp = rBone.getWorldPosition(new THREE.Vector3());
          const lp = lBone.getWorldPosition(new THREE.Vector3());
          return { rx: rp.x, ry: rp.y, rz: rp.z, lx: lp.x, ly: lp.y, lz: lp.z };
        }, traj.totalMs, shuttleCm / 100, stanceWindows, 120, headingDeg, headingAt);
      }

      /** HEEL-STRIKE TRANSIENT for the ACTIVE composed motion — the brief
       *  footfall dip-and-recover on the calibrated root-Y at each stance-window
       *  contact instant, mirroring the offline sampler via the SAME shared
       *  derivation (services/rootMotion). Null — the strict identity — unless
       *  the motion is a foot-driven gait with a planned stance schedule. */
      let composedHeelStrike: ReturnType<typeof deriveHeelStrikeAccents> = null;
      /** The accent's root-Y offset applied on the CURRENT frame (≤ 0, m) — read
       *  by the foot-plant capture so a target captured mid-accent pins at the
       *  natural (un-dipped) contact point and the dip is absorbed by the leg IK. */
      let composedHeelStrikeY = 0;

      /** Pre-pass the starting gait's trajectory through the SAME pin + vertical
       *  calibration applyTrajectoryRoot uses (the smoothed arc the accent rides
       *  on) and derive the footfall accents from the stance-window starts. Must
       *  run AFTER setComposedVerticalCalibration for the motion. Resets to null
       *  otherwise. Poses the rig transiently (the player re-poses every frame). */
      function setComposedHeelStrike(
        traj: PoseTrajectory,
        enabled: boolean,
        stanceWindows?: { foot: string; fromMs: number; toMs: number; travelLock?: boolean }[],
      ): void {
        composedHeelStrike = null;
        composedHeelStrikeY = 0;
        if (!enabled || !stanceWindows?.length || !skinnedRef || !variantCfgRef || !floorRef || !modelRoot) return;
        composedHeelStrike = deriveHeelStrikeAccents(
          (tMs) => {
            const s = traj.sampleAt(tMs);
            applyCustomPose(skinnedRef!.skeleton, variantCfgRef!, s.pose);
            _rootQA.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
            modelRoot!.quaternion.copy(rootRestQuat).multiply(_rootQA);
            modelRoot!.position.set(
              rootRestPos.x + s.rootTranslate[0],
              rootRestPos.y + s.rootTranslate[1],
              rootRestPos.z + s.rootTranslate[2],
            );
            pelvisShiftBakedM = 0; // transient absolute write — keep the tracker honest
            modelRoot!.updateMatrixWorld(true);
            if (s.planted) pinRootToFloor(modelRoot!, skinnedRef!.skeleton, variantCfgRef!, floorRef!);
            let y = modelRoot!.position.y;
            if (s.planted && (composedVcal.gain !== 1 || composedVcal.smoothed)) {
              // Same phase mapping + entry ramp as applyTrajectoryRoot (loop-form
              // table alignment, DET-LOCK-02) — identity for non-loop gaits.
              const u01 =
                composedVcalCycleMs > 0
                  ? (tMs - composedVcalPhaseOffsetMs) / composedVcalCycleMs
                  : 0;
              let yc = applyVerticalCalibration(y, composedVcal, u01);
              if (composedVcalRampMs > 0 && tMs < composedVcalRampMs)
                yc = y + (yc - y) * (tMs / composedVcalRampMs);
              y = yc;
            }
            return y;
          },
          stanceWindows.map((w) => w.fromMs),
          traj.totalMs,
        );
      }

      /** GRAVITY-SHAPED GROUNDED DESCENT for the ACTIVE composed motion — the
       *  per-span root-Y re-timing of a flagged weighted lower (sit-down /
       *  get-down), mirroring the offline sampler via the SAME shared
       *  derivation (services/rootMotion). Null — the strict identity — unless
       *  the motion opts in AND clears the exclusion gate. */
      let composedDescent: ReturnType<typeof deriveWeightedDescent> = null;

      /** GROUNDING-SWITCH ROOT-Y CROSSFADE (SEAM-4/SEAM-5) for the ACTIVE
       *  composed motion: the trajectory's grounding-posture switches and the
       *  eased override spans derived from them — the named posture's pin owns
       *  exactly its authored span and each pin handoff blends over ~200 ms
       *  instead of stepping (53 cm/frame on the quadruped get-down, 9.94 cm on
       *  stand-from-sit). Derived by the SAME shared helpers the offline
       *  sampler uses (lockstep); both empty — the strict byte-identical
       *  identity — for every motion that never changes grounding. The raw
       *  switches also drive the hand-reach engagement ramp
       *  ({@link handReachWeightAt}). */
      let composedGroundingSwitches: NonNullable<PoseTrajectory['groundingSwitches']> = [];
      let composedGroundingBlendSpans: ReturnType<typeof deriveGroundingBlendSpans> = [];

      /** Derive the grounding crossfade spans for a starting trajectory (empty
       *  for a trajectory with no grounding switches — e.g. the periodic loop
       *  cycle, which carries no postures). */
      function setComposedGroundingBlend(traj: PoseTrajectory): void {
        composedGroundingSwitches = traj.groundingSwitches ?? [];
        composedGroundingBlendSpans = deriveGroundingBlendSpans(
          composedGroundingSwitches,
          traj.totalMs,
        );
      }

      /** Pre-pass the starting motion's trajectory through the SAME grounding
       *  applyTrajectoryRoot uses (posture pin / foot-root / floor-pin) and
       *  derive the gravity-descent reshape. Must run AFTER composedUseFootRoot
       *  is set for the motion (its grounding branch is part of the arc).
       *  Resets to null otherwise. Poses the rig transiently. */
      function setComposedWeightedDescent(traj: PoseTrajectory, applies: boolean): void {
        composedDescent = null;
        if (!applies || !skinnedRef || !variantCfgRef || !floorRef || !modelRoot) return;
        composedDescent = deriveWeightedDescent((tMs) => {
          const s = traj.sampleAt(tMs);
          applyCustomPose(skinnedRef!.skeleton, variantCfgRef!, s.pose);
          _rootQA.set(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]);
          modelRoot!.quaternion.copy(rootRestQuat).multiply(_rootQA);
          modelRoot!.position.set(
            rootRestPos.x + s.rootTranslate[0],
            rootRestPos.y + s.rootTranslate[1],
            rootRestPos.z + s.rootTranslate[2],
          );
          pelvisShiftBakedM = 0; // transient absolute write — keep the tracker honest
          modelRoot!.scale.copy(rootRestScale);
          modelRoot!.updateMatrixWorld(true);
          // The grounded arc this pre-pass reads must be the arc PLAYBACK
          // grounds — so an active grounding-switch crossfade applies here
          // exactly as in applyTrajectoryRoot (mirrors the offline sampler).
          const gBlend = composedGroundingBlendSpans.length
            ? groundingBlendAt(composedGroundingBlendSpans, tMs)
            : null;
          if (gBlend) {
            applyBlendedGroundingY(modelRoot!, gBlend, applyComposedGroundingPin);
          } else if (s.planted && s.groundingPosture) {
            pinContactsToFloor(
              modelRoot!,
              skinnedRef!.skeleton,
              variantCfgRef!,
              groundingContactsFor(s.groundingPosture, floorRef!),
            );
          } else if (
            s.planted &&
            composedUseFootRoot &&
            footFrames &&
            (stanceFootDrift(modelRoot!, skinnedRef!.skeleton, variantCfgRef!, footFrames) ?? 0) >
              FOOT_ROOT_DRIFT_M
          ) {
            plantStanceFoot(modelRoot!, skinnedRef!.skeleton, variantCfgRef!, footFrames);
          } else if (s.planted) {
            pinRootToFloor(modelRoot!, skinnedRef!.skeleton, variantCfgRef!, floorRef!);
          }
          return modelRoot!.position.y;
        }, traj.totalMs);
      }

      /** Apply ONE grounding's vertical pin from the current (pre-pin) root
       *  state — the closure {@link applyBlendedGroundingY} evaluates both
       *  sides of a grounding-switch crossfade with. Foot-rooting never
       *  co-occurs (a motion with grounding postures is excluded from
       *  `composedUseFootRoot`). Mirrors the offline sampler's closure. */
      function applyComposedGroundingPin(posture: string | undefined, planted: boolean): void {
        if (!modelRoot || !skinnedRef || !variantCfgRef || !floorRef) return;
        if (planted && posture) {
          pinContactsToFloor(
            modelRoot,
            skinnedRef.skeleton,
            variantCfgRef,
            groundingContactsFor(posture, floorRef),
          );
        } else if (planted) {
          pinRootToFloor(modelRoot, skinnedRef.skeleton, variantCfgRef, floorRef);
        }
      }

      /** Rebuild the foot-plant contexts for a starting composed motion. A
       *  non-zero travel heading also derives the heading-rotated plant-clamp
       *  rest frame (see composedPlantRest; mirrors the sampler's plantRest).
       *  A CURVED heading (`headingProfileMs`, authored ms — the contacts'
       *  time base) instead rotates a rest frame PER WINDOW, at the heading
       *  the profile holds at that window's start (a single constant rotation
       *  can't serve an arc — by the last stance the body has yawed the full
       *  turn away from it; mirrors the sampler's per-plant rest). */
      function setComposedContacts(
        contacts: { foot: string; fromMs?: number; toMs?: number }[] | undefined,
        headingDeg = 0,
        headingProfileMs?: { tMs: number; headingDeg: number }[],
      ): void {
        composedPlants = [];
        composedPlantRest = null;
        if (!contacts?.length || !skinnedRef || !variantCfgRef) return;
        if (headingDeg !== 0 && restRef) {
          composedPlantRest = rotateRestReferenceByRoot(
            restRef,
            new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              (headingDeg * Math.PI) / 180,
            ),
          );
        }
        const headingAtAuthoredMs =
          headingProfileMs && headingProfileMs.length >= 2 && restRef
            ? headingProfileLookup(headingProfileMs)
            : null;
        for (const c of contacts) {
          const solver = buildFootPlant(skinnedRef, c.foot, variantCfgRef);
          if (solver) {
            const fromMs = typeof c.fromMs === 'number' ? c.fromMs : -Infinity;
            let rest: ReturnType<typeof captureJointAngleRestReference> | undefined;
            if (headingAtAuthoredMs && restRef) {
              const h = headingAtAuthoredMs(Number.isFinite(fromMs) ? fromMs : 0);
              rest =
                h !== 0
                  ? rotateRestReferenceByRoot(
                      restRef,
                      new THREE.Quaternion().setFromAxisAngle(
                        new THREE.Vector3(0, 1, 0),
                        (h * Math.PI) / 180,
                      ),
                    )
                  : restRef;
            }
            composedPlants.push({
              solver,
              fromMs,
              toMs: typeof c.toMs === 'number' ? c.toMs : Infinity,
              target: null,
              ...(rest ? { rest } : {}),
            });
          }
        }
      }

      /** SEAM-2: re-time the plant windows from AUTHORED ms into TRAJECTORY ms.
       *  setComposedContacts must run before the trajectory exists (its
       *  per-window heading rests are looked up on the authored clock), so the
       *  windows are captured authored and scaled HERE, once the trajectory's
       *  total is known — by the SAME shared factor the stance windows use
       *  (authoredToTrajectoryTimeScale; mirrors the offline sampler). Without
       *  this a paced (timeScale ≠ 1) walk's contacts ran 1/timeScale out of
       *  sync: the planted foot slid tens of cm and popped at release.
       *  ±Infinity (whole-motion pins) scale to themselves; identity at pace 1. */
      function scaleComposedPlantsToTrajectory(
        traj: PoseTrajectory,
        resolvedMotion: {
          keyframes: { durationMs: number; holdMs: number }[];
          loop: boolean;
          reps: number;
        },
      ): void {
        const scale = authoredToTrajectoryTimeScale(resolvedMotion, traj.totalMs);
        if (scale === 1) return;
        for (const fp of composedPlants) {
          fp.fromMs *= scale;
          fp.toMs *= scale;
        }
      }

      /** Rebuild the hand-plant contexts for a starting composed motion — one per
       *  hand any grounding keyframe declares as a 'reach' contact. Mirrors the
       *  offline sampler's handPlants setup. */
      function setComposedHandPlants(
        roots: { groundingPosture?: string | null }[],
      ): void {
        composedHandPlants = [];
        if (!skinnedRef || !variantCfgRef || !floorRef) return;
        const reachBones = new Set<string>();
        for (const r of roots) {
          if (!r.groundingPosture) continue;
          for (const c of groundingContactsFor(r.groundingPosture, floorRef)) {
            if (c.mode === 'reach') reachBones.add(c.bone);
          }
        }
        for (const bone of reachBones) {
          const solver = buildHandPlant(skinnedRef, bone, variantCfgRef);
          if (solver) composedHandPlants.push({ solver, bone, target: null });
        }
      }

      /** Apply the active foot plants at composed-motion time `tMs` — called
       *  AFTER the FK pose + root transform each frame (mirrors the sampler).
       *  A target captured while a heel-strike accent is dipping the root is
       *  compensated by the applied offset (`composedHeelStrikeY`), so the
       *  landing foot pins at its NATURAL floor contact and the transient dip
       *  is absorbed by the leg IK instead of burying the foot for the stance. */
      function applyFootPlants(tMs: number): void {
        if (!composedPlants.length || !restRef || !modelRoot) return;
        let solved = false;
        for (const fp of composedPlants) {
          if (!fp.solver) continue;
          const inWindow = tMs >= fp.fromMs - 1e-6 && tMs <= fp.toMs + 1e-6;
          if (!inWindow) {
            // PLANT RELEASE BLEND (SEAM-3): when a stance window ends, ramp the
            // leg-IK correction 1→0 over PLANT_RELEASE_BLEND_MS instead of
            // dropping it in one frame (the toe-off pop: ~20 cm + ~17°/frame at
            // release). The captured target survives ONLY through the ramp; the
            // hold is NOT extended — the FK swing takes over continuously.
            // Skipped when a later window has already re-pinned the same foot
            // (its full solve owns the leg). Mirrors the offline sampler.
            const w = fp.target ? 1 - (tMs - fp.toMs) / PLANT_RELEASE_BLEND_MS : 0;
            const footRepinned =
              w > 0 &&
              w < 1 &&
              composedPlants.some(
                (o) =>
                  o !== fp &&
                  o.solver != null &&
                  o.solver.footKey === fp.solver!.footKey &&
                  tMs >= o.fromMs - 1e-6 &&
                  tMs <= o.toMs + 1e-6,
              );
            if (!fp.target || w <= 0 || w >= 1 || footRepinned) {
              fp.target = null; // released (or superseded) — next stance re-captures
              continue;
            }
            solveFootPlantWeighted(fp.solver, fp.target, fp.rest ?? composedPlantRest ?? restRef, restRef, w);
            solved = true;
            continue;
          }
          if (!fp.target) {
            fp.target = fp.solver.ctx.bones[0]!.getWorldPosition(new THREE.Vector3());
            fp.target.y -= composedHeelStrikeY; // un-dip → natural contact (see doc)
          }
          // Heading-rotated clamp frame when the motion travels a rotated
          // heading — the PER-WINDOW rest for a curved heading, the shared
          // composedPlantRest for a constant one; the ORIGINAL restRef always
          // names the knee hinge axis.
          solveFootPlant(fp.solver, fp.target, fp.rest ?? composedPlantRest ?? restRef, restRef);
          solved = true;
        }
        if (solved) modelRoot.updateMatrixWorld(true);
      }

      /** Set the whole-body root from an absolute trajectory sample, then (planted)
       *  pin the lower foot to the floor. */
      function applyTrajectoryRoot(
        rootQuat: [number, number, number, number],
        rootTranslate: [number, number, number],
        planted: boolean,
        tMs = 0,
        groundingPosture?: string,
      ): void {
        if (!modelRoot) return;
        composedCurrentGrounding = groundingPosture ?? null; // stamp the frame's grounding for recording
        _rootQA.set(rootQuat[0], rootQuat[1], rootQuat[2], rootQuat[3]);
        modelRoot.quaternion.copy(rootRestQuat).multiply(_rootQA);
        modelRoot.position.set(
          rootRestPos.x + rootTranslate[0],
          rootRestPos.y + rootTranslate[1],
          rootRestPos.z + rootTranslate[2],
        );
        pelvisShiftBakedM = 0; // absolute write — the shift re-bakes at the end
        modelRoot.scale.copy(rootRestScale); // clear any prior-frame plant scale drift
        modelRoot.updateMatrixWorld(true);
        // REACH CONTACTS of the active posture: bring each planted hand to the
        // floor and LATCH it there, so it stays put as the body lowers over it —
        // the arm folds (the push-up). Mirrors the sampler's latch-on-contact
        // reach solve, incl. the SEAM-4 engagement ramp (handReachWeightAt).
        const solveComposedReachContacts = (posture: string): void => {
          if (!composedHandPlants.length || !restRef || !skinnedRef || !variantCfgRef || !floorRef)
            return;
          const reach = new Set(
            groundingContactsFor(posture, floorRef)
              .filter((c) => c.mode === 'reach')
              .map((c) => c.bone),
          );
          let solved = false;
          for (const hp of composedHandPlants) {
            if (!hp.solver || !reach.has(hp.bone)) {
              hp.target = null;
              continue;
            }
            solveHandReach(
              hp.solver,
              hp,
              floorRef.floorY,
              restRef,
              handReachWeightAt(composedGroundingSwitches, hp.bone, tMs, floorRef),
            );
            solved = true;
          }
          if (solved) modelRoot!.updateMatrixWorld(true);
        };
        // GROUNDING-SWITCH CROSSFADE (SEAM-4/SEAM-5): inside an override span
        // the grounded root-Y is the eased blend of the OUTGOING and INCOMING
        // pin solutions (shared applier — lockstep with the offline sampler);
        // outside every span the legacy branches below run untouched. The
        // reach set still follows the frame's own grounding state.
        const gBlend = composedGroundingBlendSpans.length
          ? groundingBlendAt(composedGroundingBlendSpans, tMs)
          : null;
        if (gBlend && skinnedRef && variantCfgRef && floorRef) {
          applyBlendedGroundingY(modelRoot, gBlend, applyComposedGroundingPin);
          if (planted && groundingPosture) solveComposedReachContacts(groundingPosture);
        } else if (planted && groundingPosture && skinnedRef && variantCfgRef && floorRef) {
          // POSTURE-SCOPED GROUNDING: rest on the posture's contact set (the pelvis on
          // a seat for 'sitting', the toes+hands on the floor for a plank) via the
          // explicit-target vertical pin — not the feet.
          pinContactsToFloor(
            modelRoot,
            skinnedRef.skeleton,
            variantCfgRef,
            groundingContactsFor(groundingPosture, floorRef),
          );
          solveComposedReachContacts(groundingPosture);
        } else if (
          planted &&
          composedUseFootRoot &&
          skinnedRef &&
          variantCfgRef &&
          footFrames &&
          (stanceFootDrift(modelRoot, skinnedRef.skeleton, variantCfgRef, footFrames) ?? 0) >
            FOOT_ROOT_DRIFT_M
        ) {
          // Re-root the rigid body at the stance foot: the SAME authored angles read
          // as the real closed-chain movement — feet planted, pelvis placed by the
          // chain, COM over the base. The rotation is picked up by rootOrientDelta()
          // (measurement) and the recording tap, which read the live modelRoot.
          plantStanceFoot(modelRoot, skinnedRef.skeleton, variantCfgRef, footFrames);
        } else if (planted && skinnedRef && variantCfgRef && floorRef) {
          pinRootToFloor(modelRoot, skinnedRef.skeleton, variantCfgRef, floorRef);
          // Calibrated gait vertical: scale the grounded pelvis arc about its
          // cycle mean to the requested excursion (root-only; joints untouched).
          // Identity unless the active motion requested calibration. The phase
          // indexes the cycle the table was DERIVED from — for a LOOPING motion
          // the loop-form period, offset by the first keyframe's arrival during
          // the one-shot first pass (DET-LOCK-02) — with the loop table ramped
          // in from the live pin over the intro, and any residual root-Y
          // mismatch at the first-pass → loop handoff decaying over
          // VCAL_HANDOFF_BLEND_MS instead of stepping discretely. Mirrors the
          // offline sampler's sampleAt exactly (handoff aside, which only a
          // live loop reaches).
          if (composedVcal.gain !== 1 || composedVcal.smoothed) {
            const u01 =
              composedVcalCycleMs > 0
                ? (tMs - composedVcalPhaseOffsetMs) / composedVcalCycleMs
                : 0;
            let y = applyVerticalCalibration(modelRoot.position.y, composedVcal, u01);
            if (composedVcalRampMs > 0 && tMs < composedVcalRampMs) {
              y = modelRoot.position.y + (y - modelRoot.position.y) * (tMs / composedVcalRampMs);
            }
            if (composedVcalHandoff) {
              const k =
                1 -
                Math.min(
                  1,
                  (performance.now() - composedVcalHandoff.startedAtMs) / VCAL_HANDOFF_BLEND_MS,
                );
              if (k <= 0) composedVcalHandoff = null;
              else y += composedVcalHandoff.deltaYM * k;
            }
            modelRoot.position.y = y;
            modelRoot.updateMatrixWorld(true);
          }
        }
        // Gravity-shaped descent (weighted lowers): inside a derived descent
        // span, re-time the grounded root-Y toward the gravity profile, clamped
        // to the live pin's hover/dip band — root-Y only, mirroring the offline
        // sampler at the same pipeline point. Identity (null) unless the active
        // motion opted in via `weightedDescent` and cleared the exclusions.
        if (planted && composedDescent) {
          const yShaped = applyWeightedDescent(modelRoot.position.y, composedDescent, tMs);
          if (yShaped !== modelRoot.position.y) {
            modelRoot.position.y = yShaped;
            modelRoot.updateMatrixWorld(true);
          }
        }
        // Heel-strike transient (gait only): the brief footfall dip-and-recover
        // ON TOP of the smoothed vertical at each stance-window contact instant
        // — root-Y only, exactly 0 outside every accent span (and null for every
        // non-gait motion), mirroring the offline sampler at the same pipeline
        // point. The applied offset is tracked so applyFootPlants can capture a
        // mid-accent plant target at the natural (un-dipped) contact point.
        composedHeelStrikeY = 0;
        if (planted && composedHeelStrike) {
          composedHeelStrikeY = heelStrikeOffsetAt(composedHeelStrike, tMs);
          if (composedHeelStrikeY !== 0) {
            modelRoot.position.y += composedHeelStrikeY;
            modelRoot.updateMatrixWorld(true);
          }
        }
        // Foot-driven travel: advance the root ALONG THE HEADING (offset·(sinH,
        // cosH); heading 0 is the byte-identical legacy +Z ride) so the planted
        // foot stays world-fixed (horizontal only — independent of the vertical
        // pin). The medio-lateral shuttle rides the root along the heading's
        // PERPENDICULAR toward the stance foot the same way; both precede the
        // foot plants below, which hold each stance foot fixed while the pelvis
        // travels over it. Mirrors the offline sampler exactly.
        if (composedFootDriven || composedLateralShuttle) {
          if (composedFootDriven) {
            // CURVED heading: the derivation pre-accumulated the (x, z) arc —
            // each advance already rode the heading at its own time. Constant
            // heading keeps the offset·heading ride (byte-identical at 0).
            if (composedFootDriven.at) {
              const [ox, oz] = composedFootDriven.at(tMs);
              modelRoot.position.x += ox;
              modelRoot.position.z += oz;
            } else {
              const off = composedFootDriven.zAt(tMs);
              modelRoot.position.z += off * composedFootDriven.heading[1];
              if (composedFootDriven.heading[0] !== 0)
                modelRoot.position.x += off * composedFootDriven.heading[0];
            }
          }
          if (composedLateralShuttle) {
            // CURVED heading: the shuttle rides the INSTANTANEOUS perpendicular.
            if (composedLateralShuttle.at) {
              const [ox, oz] = composedLateralShuttle.at(tMs);
              modelRoot.position.x += ox;
              modelRoot.position.z += oz;
            } else {
              const lat = composedLateralShuttle.xAt(tMs);
              modelRoot.position.x += lat * composedLateralShuttle.lateral[0];
              if (composedLateralShuttle.lateral[1] !== 0)
                modelRoot.position.z += lat * composedLateralShuttle.lateral[1];
            }
          }
          modelRoot.updateMatrixWorld(true);
        }
        // Pelvis-shift overlay LAST, so it composes over the travel/pin/foot-root
        // writes above instead of being overwritten by them.
        bakePelvisShift();
        // Seat prop: show the bench under the pelvis while grounded 'sitting'.
        updateSeatProp(groundingPosture === 'sitting');
      }

      function stepTrajectory(now: number): void {
        const at = activeTrajectory;
        if (!at) return;
        const total = at.traj.totalMs;
        const raw = now - at.start;
        // Fire each keyframe's settle measurement ONCE, off the EXACT settle pose
        // (frame-timing-independent), before the visual frame pose is applied.
        while (at.nextSettle < at.settleAtMs.length && raw >= at.settleAtMs[at.nextSettle]!) {
          const st = at.traj.sampleAt(at.settleAtMs[at.nextSettle]!);
          if (skinnedRef && variantCfgRef)
            applyCustomPose(skinnedRef.skeleton, variantCfgRef, st.pose);
          applyTrajectoryRoot(st.rootQuat, st.rootTranslate, st.planted, at.settleAtMs[at.nextSettle]!, st.groundingPosture);
          applyFootPlants(at.settleAtMs[at.nextSettle]!);
          at.onSettle(at.nextSettle);
          at.nextSettle += 1;
        }
        const done = !at.loop && raw >= total;
        // Loop phase clock. A LOOPING motion advances a WARPED clock at `cadenceRate`
        // so its cadence drifts gently cycle to cycle (natural stride-time
        // variability) instead of metronomic repetition. The rate is exactly 1 when
        // liveliness is 0, so a clean loop is byte-identical to the plain `raw % total`;
        // it's continuous, so the wrap stays seamless; and it's timing-only, so poses,
        // foot placement and every measured angle are unchanged. Seeded to the entry
        // phase on the first frame. (One-shot playback — incl. the recorded first pass —
        // is not looped, so it and grading are untouched.)
        let elapsed: number;
        if (at.loop && total > 0) {
          if (at.warpClock == null) {
            at.warpClock = raw;
            at.warpPrevNow = now;
          }
          const dt = Math.max(0, Math.min(200, now - (at.warpPrevNow ?? now)));
          at.warpPrevNow = now;
          at.warpClock += dt * cadenceRate(raw / 1000, motionLiveliness);
          elapsed = at.warpClock % total;
        } else {
          elapsed = Math.min(total, raw);
        }
        const s = at.traj.sampleAt(elapsed);
        if (skinnedRef && variantCfgRef) applyCustomPose(skinnedRef.skeleton, variantCfgRef, s.pose);
        currentPose = s.pose;
        applyTrajectoryRoot(s.rootQuat, s.rootTranslate, s.planted, elapsed, s.groundingPosture);
        // Closed-chain foot contact for this frame (pins declared stance feet).
        applyFootPlants(elapsed);
        requestRender();
        if (done && !at.finished) {
          at.finished = true;
          const resolve = at.resolve;
          activeTrajectory = null;
          resolve();
        }
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

      // ── Motion recording tap (samples inside the existing rAF loop) ────
      interface ActiveRecording {
        sampleHz: number;
        name: string;
        sourceKind: MotionRecordingSourceKind;
        sourceName?: string;
        startT: number;
        lastSample: number;
        frames: RecordedFrame[];
      }
      let recording: ActiveRecording | null = null;
      const _recPos = new THREE.Vector3();
      const _recQ = new THREE.Quaternion();

      /** Build one frame from the live stage (pose + measured angles + root +
       *  tracked-bone world positions). Forces a matrix refresh so idle-time
       *  sampling (no motion playing) still measures fresh. */
      function buildFrameNow(tMs: number): RecordedFrame | null {
        if (!skinnedRef || !variantCfgRef || !restRef || !modelRoot) return null;
        // Capture the CLEAN pose: lift any baked idle-liveliness + eye deltas
        // around the serialize/measure and restore them at the same phase, so
        // captureFrame/recordings never carry the live-only perturbation while
        // the rendered frame is unchanged. No-op unless deltas are baked (inside
        // the rAF loop they were already lifted before the tap).
        //
        // SEAM-9 — the EYE deltas are restored by an EXACT snapshot, not by a
        // re-derive (applyEyeGaze(0)). Re-deriving would recompute the gaze-absorb
        // against the head/root as they sit AFTER the idle re-bake below — a STALE
        // BASE if that pose differs at all from the one the deltas were first
        // applied against. An eye local is frame-invariant, so copying the
        // snapshotted locals back is exact under ANY intervening move.
        const eyeRestore = captureAppliedEyeGaze(); // null when no eye deltas baked
        undoEyeGaze(); // eyes at rest around the capture too
        const hadIdleOverlay = undoIdleOverlays();
        try {
          return buildFrameNowClean(tMs);
        } finally {
          if (hadIdleOverlay) applyIdleOverlays(0);
          if (eyeRestore) eyeRestore();
        }
      }

      function buildFrameNowClean(tMs: number): RecordedFrame | null {
        if (!skinnedRef || !variantCfgRef || !restRef || !modelRoot) return null;
        modelRoot.updateMatrixWorld(true);
        const report = measureNowFresh();
        if (!report) return null;
        const angles: Record<string, Record<string, number>> = {};
        for (const [j, set] of Object.entries(report.joints)) angles[j] = { ...set };
        // Composed root state relative to the grounded rest transform (the
        // inverse of applyRootState); translate INCLUDES any planted pin.
        _recQ.copy(rootRestQuat).invert().multiply(modelRoot.quaternion);
        const worldTracks: Record<string, [number, number, number]> = {};
        if (motionCapBones) {
          for (const key of DEFAULT_TRACKED_BONES) {
            const bone = motionCapBones.get(key);
            if (!bone) continue;
            bone.getWorldPosition(_recPos);
            worldTracks[key] = [_recPos.x, _recPos.y, _recPos.z];
          }
          // Whole-body centre of mass — mirrors the offline sampler, so a LIVE rail
          // recording carries the same CoM track the balance timeline reads (the
          // measure-only balance readout; never repositions the body).
          worldTracks.CoM = computeBodyCoMFromBones(motionCapBones).world;
        }
        return {
          tMs: Math.max(0, tMs),
          pose: serializeCustomPose(skinnedRef.skeleton, variantCfgRef, variantCfgRef.id),
          angles,
          root: {
            orientQuat: [_recQ.x, _recQ.y, _recQ.z, _recQ.w],
            translateM: [
              modelRoot.position.x - rootRestPos.x,
              modelRoot.position.y - rootRestPos.y,
              modelRoot.position.z - rootRestPos.z,
            ],
          },
          worldTracks,
          // Per-frame grounding posture (PR 1) — present during a composed motion
          // that declares grounding, so scrubbing a live recording recovers the
          // posture (lockstep with the offline sampler's sample.groundingPosture).
          ...(composedCurrentGrounding ? { groundingPosture: composedCurrentGrounding } : {}),
        };
      }

      function captureRecordingFrame(rec: ActiveRecording, nowMs: number): void {
        const frame = buildFrameNow(nowMs - rec.startT);
        if (frame) rec.frames.push(frame);
      }

      captureFrameImpl = () => buildFrameNow(0);

      startRecordingImpl = (opts) => {
        const now = performance.now();
        recording = {
          sampleHz: Math.max(1, Math.min(120, opts?.sampleHz ?? 30)),
          name: opts?.name ?? 'recording',
          sourceKind: opts?.sourceKind ?? 'manual',
          ...(opts?.sourceName ? { sourceName: opts.sourceName } : {}),
          startT: now,
          lastSample: now,
          frames: [],
        };
        captureRecordingFrame(recording, now); // frame 0 — the starting pose
        startLoop();
      };

      stopRecordingImpl = () => {
        const rec = recording;
        recording = null;
        if (!rec) return null;
        // Final frame at stop time so the settle pose is always captured.
        captureRecordingFrame(rec, performance.now());
        return {
          id: `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: rec.name,
          variant: variantCfgRef?.id ?? '',
          sourceKind: rec.sourceKind,
          ...(rec.sourceName ? { sourceName: rec.sourceName } : {}),
          sampleHz: rec.sampleHz,
          frames: rec.frames,
          createdAtIso: new Date().toISOString(),
        };
      };

      showRecordedFrameImpl = (frame: RecordedFrame) => {
        if (!skinnedRef || !variantCfgRef) return;
        // Scrubbing owns the skeleton: cancel any motion / composed / tween,
        // and lift any idle deltas BEFORE the absolute pose/root writes below
        // (a stale idle bake would otherwise corrupt the shift tracker).
        undoIdleOverlays();
        undoEyeGaze(); // eye deltas lift before the absolute pose writes too
        cancelComposed();
        if (activeMotionId) stopMotion();
        if (activeTween) finishTween();
        applyCustomPose(skinnedRef.skeleton, variantCfgRef, frame.pose);
        currentPose = frame.pose;
        composedRootQuat = [...frame.root.orientQuat];
        composedRootTranslate = [...frame.root.translateM];
        applyRootState(frame.root.orientQuat, frame.root.translateM);
        requestRender();
        startLoop();
        const report = measureNow();
        if (report) onReport?.(report);
      };

      runCommandImpl = async (cmd: ExamMovementCommand): Promise<ExamMovementOutcome> => {
        if (disposed || !skinnedRef || !variantCfgRef || !restRef || !baselinePoseRef) {
          return { status: 'refused', reason: 'stage-unavailable' };
        }
        // Mode switch: an exam ROM command owns the skeleton — cancel any active
        // named motion or composed playback first, then proceed. Exam ROM is
        // upright/open-chain, so drop any composed full-body root posture.
        undoIdleOverlays(); // the command starts from the clean idle pose
        undoEyeGaze(); // eye deltas lift with it (re-baked live next frame)
        poseLayerOnTakeover?.();
        cancelComposed();
        if (activeMotionId) stopMotion();
        resetRootToRest();
        if (cmd.action === 'relax') {
          await tweenTo(restingPoseRef);
          const report = measureNow();
          if (report) onReport?.(report);
          return { status: 'complied' };
        }
        const resolved = resolveCommandTarget(cmd, variantCfgRef, {
          constraints: romConstraints ?? null,
        });
        if (resolved.status === 'refused' || resolved.clampedDegrees == null) {
          // The patient does not move; answer with where the joint IS.
          const report = measureNow();
          const achieved = report ? measureCommandMotion(report, cmd.joint, cmd.motion) : undefined;
          return finalizeOutcome(resolved, achieved, romConstraints ?? null);
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
          return finalizeOutcome(
            { ...resolved, status: 'refused', reason: 'unsupported-motion' },
            undefined,
            romConstraints ?? null,
          );
        }
        await tweenTo(target);
        // Settle: re-measure the skeleton — the outcome carries what the
        // patient actually did, not what was planned.
        const report = measureNow();
        if (report) onReport?.(report);
        const achieved = report ? measureCommandMotion(report, cmd.joint, cmd.motion) : undefined;
        return finalizeOutcome(resolved, achieved, romConstraints ?? null);
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
        undoIdleOverlays(); // playback starts from the clean idle pose
        undoEyeGaze(); // eye deltas lift with it (re-baked live next frame)
        poseLayerOnTakeover?.();
        if (activeMotionId) stopMotion();
        if (activeTween) finishTween();
        cancelComposed();
        const token = composedSeq;
        composedActiveToken = token; // this motion now owns the skeleton (for cancelActiveMovement)
        const mods = resolved.modifiers ?? {};
        // Same qualitative-overlay semantics as prescribe_motion: timeScale
        // scales the (already velocity-floored) durations; guarding/sway run
        // through the identical per-frame overlay machinery clips use.
        const timeScale = Math.min(1.5, Math.max(0.4, mods.timeScale ?? 1));
        // GUARDING / SWAY are now BAKED into the resolved keyframes at resolve
        // time (motionSequence.bakeGuardingSway — DET-LOCK-03), so the recording,
        // the grade and this screen play the SAME motion. This path therefore
        // does NOT re-apply them as a live overlay (that would double them and
        // re-open the three-way disagreement). It sets ONLY liveliness, and must
        // PRESERVE the host-set value (the setter defaults an omitted key to 0, so
        // an explicit key is required) or AI-composed gait would never breathe or
        // vary. `motionLiveliness` currently holds what the host set.
        setMotionOverlaysImpl?.({ liveliness: motionLiveliness });
        composedActive = true;
        resetLivelinessOnset();
        // Closed-chain foot contacts declared by this motion (Finding 4): rebuild
        // the IK plants so declared stance feet stay world-fixed as the body
        // travels. No-op when the motion declares none (open-chain default).
        setComposedContacts(resolved.contacts, resolved.headingDeg ?? 0, resolved.headingProfileMs);
        startLoop();

        // NATURAL RETURN-TO-READY between two directed movements. A template/neutral
        // movement used to reset INSTANTLY to anatomic standing at the origin — a
        // robotic teleport. Instead: if the last move left the body off its ready
        // stance, ease it back IN PLACE and pause a beat (the person returns to
        // ready, then does the next move); if it's already at ready, just hold the
        // between-command beat. After the settle the movement CONTINUES from that
        // ready pose (startFrom 'current'), so it plays where the person is standing
        // and never snaps to the origin. AI motions already start 'current'.
        let effectiveResolved = resolved;
        if (resolved.startFrom === 'neutral') {
          if (needsReadySettle()) {
            await playReadySettle(token);
            if (token !== composedSeq) return refusedResult('superseded');
            effectiveResolved = { ...resolved, startFrom: 'current' as const };
          } else {
            resetRootToRest();
            if (composedHasPlayed) {
              await holdReadyBeat(token);
              if (token !== composedSeq) return refusedResult('superseded');
            }
          }
        }

        composedHasPlayed = true; // a movement is playing → future commands get the ready beat

        // BALANCE COORDINATION (COM-driven postural control): for a motion flagged
        // `balanceAssist`, measure each keyframe's COM-vs-base offset on the live
        // rig and fold ROM-clamped re-centering targets into the resolved
        // keyframes — the SAME pure transform the offline sampler applies at the
        // same pipeline point (before the trajectory is built), so recordings and
        // live playback stay in lockstep. Identity for unflagged/excluded motions.
        // Poses the rig transiently (the player re-poses every frame).
        if (effectiveResolved.balanceAssist && modelRoot && skinnedRef && floorRef && variantCfgRef && baselinePoseRef && restRef) {
          effectiveResolved = balanceCoordination(effectiveResolved, {
            root: modelRoot,
            skinned: skinnedRef,
            variantCfg: variantCfgRef,
            baselinePose: baselinePoseRef,
            rest: restRef,
            currentPose,
            currentRoot: { quat: composedRootQuat, translateM: composedRootTranslate },
            rootRest: { position: rootRestPos, quaternion: rootRestQuat, scale: rootRestScale },
            constraints: romConstraints ?? null,
          });
          pelvisShiftBakedM = 0; // transient absolute root writes — keep the tracker honest
        }

        // EXERTION FEED (Wave 5): the playing motion's 0..1 work intensity —
        // mean joint speed + ballistic share over its resolved keyframes —
        // which the render loop feeds the exertion accumulator each frame
        // while this motion drives the skeleton (breathing rate/depth follow).
        breath.setWorkIntensity(motionWorkIntensity(effectiveResolved.keyframes));

        // CROSS-MOTION CONTINUITY: fold onto the CURRENT on-stage pose + root (after
        // any ready settle above), so the motion continues from the live posture.
        const built = buildSequencePoses(baselinePoseRef, effectiveResolved, variantCfgRef, restRef, {
          currentPose,
          currentRoot: { quat: composedRootQuat, translateM: composedRootTranslate },
        });
        const measurements: ComposedMotionPlaybackResult['measurements'] = [];
        const finalAngles: Record<string, number> = {};
        const hidden = stageHidden;
        let lastReport: JointAngleReport | null = null;

        // ONE continuous trajectory through every keyframe — the SAME builder the
        // offline sampler uses, so the recording matches the stage exactly. The
        // start knot is the live on-stage pose/root (cross-motion continuity);
        // interior keyframes are fly-throughs, holds + the end are stops.
        const startPose = currentPose ?? baselinePoseRef ?? built.poses[0]!;
        const { trajectory, settleAtMs } = buildComposedTrajectory(built, {
          startPose,
          startQuat: [...composedRootQuat],
          startTranslate: [...composedRootTranslate],
          timeScale,
          reps: resolved.reps,
          // A travelling gait keeps a steady cadence — no ease-in whip / halt at the ends
          // (mirrors the offline sampler so live playback and recordings match) — UNLESS
          // it authors its own initiation/termination ramps (`settleEnds`): then the ends
          // are genuine stops (ease from standstill, brake to quiet standing).
          cyclicEnds: resolved.footDrivenTravel === true && resolved.settleEnds !== true,
          // MOMENTUM-PRESERVING SEAM (opt-in): the first knot is a fly-through so a
          // chained motion enters with velocity; the final settle still stops.
          flowIn: resolved.flowIn === true,
        });
        // The persistent root commit for the NEXT motion moved BELOW, after the
        // foot-driven travel is derived (PR 2) — so it folds in the real traveled
        // distance instead of the authored ≈origin. See the commit after
        // setComposedFootDriven.

        // GROUNDING-SWITCH CROSSFADE (SEAM-4/SEAM-5): derive the root-Y
        // override spans for this trajectory's grounding-posture switches —
        // BEFORE the weighted-descent pre-pass below, whose grounded arc must
        // include the blend (sampler lockstep). Empty for every motion that
        // never changes grounding.
        setComposedGroundingBlend(trajectory);

        // CALIBRATED GAIT VERTICAL: measure the emergent grounded pelvis arc of
        // the CYCLE that actually sustains on stage — the periodic loop trajectory
        // for a looping gait (its arc; the one-shot's standing intro would inflate
        // the range), else the one-shot — and reshape it to the requested cm
        // excursion. Root-only, so every measured joint angle stays as authored.
        // The LOOP-FORM trajectory is built ONCE here (DET-LOCK-02): the vcal
        // table derives from it and the loop player below re-uses the same
        // object, so table and playback can never come from diverging builds.
        const composedHasPlanted = built.roots.some((r) => r.stance === 'planted');
        const loopForm = resolved.loop ? buildLoopTrajectory(built, { timeScale }) : null;
        setComposedVerticalCalibration(
          loopForm ? loopForm.trajectory : trajectory,
          resolved.verticalCalibrationCm,
          composedHasPlanted,
        );
        // PHASE ALIGNMENT + ENTRY RAMP (DET-LOCK-02): during the one-shot first
        // pass the loop-derived table is indexed at (t − first keyframe arrival)
        // so its phase is CONTINUOUS across the loop-engage boundary, and the
        // table ramps in from the live pin over ≤VCAL_HANDOFF_BLEND_MS at the
        // standing entry. Mirrors the offline sampler (vcalPhaseOffsetMs /
        // vcalRampMs in motionRecording) so recordings match the stage.
        if (loopForm && (composedVcal.gain !== 1 || composedVcal.smoothed)) {
          composedVcalPhaseOffsetMs = settleAtMs[0] ?? 0;
          composedVcalRampMs = Math.max(
            1,
            Math.min(VCAL_HANDOFF_BLEND_MS, composedVcalPhaseOffsetMs),
          );
        }
        // FOOT-DRIVEN travel: derive the curve that keeps the planted foot
        // world-fixed from the same one-shot trajectory the stage plays,
        // following the motion's planned stance schedule when it authors one —
        // along the motion's heading (0 = the legacy straight-ahead +Z).
        // SEAM-2: the plants were built in authored ms (setComposedContacts,
        // above) — re-time their windows into trajectory ms by the same shared
        // factor as the stance windows below, so contacts and windows can never
        // desync at a non-1 pace (mirrors the offline sampler).
        scaleComposedPlantsToTrajectory(trajectory, effectiveResolved);
        const stanceWindows = scaledStanceWindows(trajectory, effectiveResolved);
        const travelHeadingDeg = resolved.headingDeg ?? 0;
        // CURVED heading (roadmap 6.2): the per-time heading lookup of a motion
        // with a heading profile — undefined for every constant-heading motion.
        const travelHeadingAt = scaledHeadingAt(trajectory, effectiveResolved);
        setComposedFootDriven(trajectory, resolved.footDrivenTravel === true, composedHasPlanted, stanceWindows, travelHeadingDeg, travelHeadingAt);
        // PERSISTENT ROOT COMMIT (PR 2): advance the continuity/root state to the
        // ACTUAL end-of-motion world root for the NEXT segment — the authored last
        // keyframe PLUS the DERIVED foot-driven travel just computed. This is the
        // general fix that lets any chained program start at the traveled position,
        // retiring the TUG-specific offsetMotionTranslate resync. Only NET travel
        // persists: the transient overlays (lateral shuttle, heel-strike, gait
        // vertical, pelvis shift) return to ~0 at a settled end and are NOT folded —
        // matching the offline chain runner's settled-end root (movementChain.ts).
        const lastRoot = built.roots[built.roots.length - 1];
        if (lastRoot) {
          composedRootQuat = [...lastRoot.quat];
          composedRootTranslate = [...lastRoot.translateM];
          if (composedFootDriven) {
            let dx = 0;
            let dz = 0;
            if (composedFootDriven.at) {
              const o = composedFootDriven.at(trajectory.totalMs);
              dx = o[0];
              dz = o[1];
            } else {
              const off = composedFootDriven.zAt(trajectory.totalMs);
              dx = off * composedFootDriven.heading[0];
              dz = off * composedFootDriven.heading[1];
            }
            composedRootTranslate[0] += dx;
            composedRootTranslate[2] += dz;
          }
        }
        // MEDIO-LATERAL SHUTTLE: derive the stance-phase-locked pelvis ride
        // toward the planted foot (per-step weight transfer) from the same
        // trajectory — the lateral sibling of the foot-driven travel, kept
        // perpendicular to the same heading.
        setComposedLateralShuttle(trajectory, resolved.lateralShuttleCm, composedHasPlanted, stanceWindows, travelHeadingDeg, travelHeadingAt);
        // HEEL-STRIKE TRANSIENT: derive the footfall accents (a brief root-Y
        // dip-and-recover at each stance-window contact instant, amplitude from
        // the pre-contact descent of the smoothed vertical) for a foot-driven
        // gait with a planned stance schedule — AFTER the vertical calibration
        // above, whose smoothed arc the accent reads and rides on. Null (the
        // strict identity) for every other motion and on explicit opt-out.
        setComposedHeelStrike(
          trajectory,
          resolved.footDrivenTravel === true &&
            composedHasPlanted &&
            effectiveResolved.heelStrikeAccent !== false,
          stanceWindows,
        );
        // HAND PLANTS: build the arm IK chains for any grounding-posture reach
        // contacts (a plank's hands), so they stay planted as the chest lowers.
        setComposedHandPlants(built.roots);
        // CLOSED-CHAIN FOOT-ROOTED PLANTING: for a PLANTED, in-place, non-looping
        // motion with no declared contacts, re-root each planted frame at the stance
        // foot (the quasi-static planted set). Same gate as the offline sampler —
        // in-place ONLY (a travel motion places its feet anew, so restoring the
        // original foot frame would fight the step).
        const composedTravels = built.roots.some(
          (r) => Math.hypot(r.translateM[0], r.translateM[2]) > 0.02,
        );
        // A motion with ANY floating span is a dynamic airborne movement (jump/hop):
        // re-rooting a planted crouch phase to its rest foot frame fights the ballistic
        // arc and snaps the body tens of cm at the flight↔plant transition. Those use
        // the plain floor-pin (planted) + free arc (floating) — never foot-rooting.
        // Mirrors the offline sampler's `!hasFloating` gate so stage and export agree.
        const composedHasFloating = built.roots.some((r) => r.stance === 'floating');
        // Likewise a REORIENTED (lying) posture: foot-rooting restores the stance foot
        // to its upright rest frame and rotates the body back toward standing, clobbering
        // the supine/prone/side-lying orientation. Lying grounds on the plain vertical
        // pin (feet co-planar with the back). Mirrors the sampler's `!reorients` gate.
        const composedReorients = built.roots.some((r) => Math.abs(r.quat[3]) < 0.999);
        // A grounding posture (sitting/quadruped/…) grounds on its own contact set
        // via pinContactsToFloor — never the foot-root. Mirrors the sampler gate.
        const composedHasGrounding = built.roots.some((r) => r.groundingPosture != null);
        composedUseFootRoot =
          !resolved.footDrivenTravel &&
          !resolved.loop &&
          !composedTravels &&
          !composedHasFloating &&
          !composedReorients &&
          !composedHasGrounding &&
          !(resolved.contacts?.length ?? 0) &&
          composedHasPlanted &&
          !!footFrames;
        // GRAVITY-SHAPED GROUNDED DESCENT: derive the root-Y descent re-timing
        // for a flagged weighted lower from the same one-shot trajectory the
        // stage plays — AFTER composedUseFootRoot so the pre-pass grounds each
        // sample exactly as playback will (sampler lockstep). Identity (null)
        // for every unflagged/excluded motion.
        setComposedWeightedDescent(trajectory, weightedDescentApplies(effectiveResolved));

        // Per-keyframe settle: MEASURE what the patient actually did (off the exact
        // settle pose the player applies for us, frame-timing-independent). Reads
        // the EFFECTIVE keyframes (incl. any balanceCoordination re-centering
        // targets), so reported plans match what actually plays.
        const measureSettle = (i: number): void => {
          const report = measureNow();
          if (!report) return;
          lastReport = report;
          onReport?.(report);
          for (const t of effectiveResolved.keyframes[i]!.targets) {
            const measured = measureCommandMotion(report, t.joint, t.motion);
            measurements.push({
              keyframe: i,
              joint: t.joint,
              motion: t.motion,
              clampedDegrees: t.clampedDegrees,
              ...(measured != null ? { measuredDegrees: measured } : {}),
            });
          }
        };

        // Play the first pass to completion — or settle instantly when parked so a
        // background stage never strands the command promise.
        await new Promise<void>((resolve) => {
          if (hidden()) {
            for (let i = 0; i < settleAtMs.length; i += 1) {
              const st = trajectory.sampleAt(settleAtMs[i]!);
              if (skinnedRef && variantCfgRef)
                applyCustomPose(skinnedRef.skeleton, variantCfgRef, st.pose);
              applyTrajectoryRoot(st.rootQuat, st.rootTranslate, st.planted, settleAtMs[i]!, st.groundingPosture);
              applyFootPlants(settleAtMs[i]!);
              measureSettle(i);
            }
            const end = trajectory.sampleAt(trajectory.totalMs);
            if (skinnedRef && variantCfgRef)
              applyCustomPose(skinnedRef.skeleton, variantCfgRef, end.pose);
            currentPose = end.pose;
            applyTrajectoryRoot(end.rootQuat, end.rootTranslate, end.planted, trajectory.totalMs, end.groundingPosture);
            applyFootPlants(trajectory.totalMs);
            resolve();
            return;
          }
          activeTrajectory = {
            traj: trajectory,
            start: performance.now(),
            settleAtMs,
            nextSettle: 0,
            onSettle: measureSettle,
            loop: false,
            resolve,
            finished: false,
          };
        });

        // Final measured angles at the last keyframe for every touched field
        // (effective keyframes — incl. any balanceCoordination targets).
        if (lastReport) {
          const touched = new Set<string>();
          for (const kfr of effectiveResolved.keyframes) {
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
          // Detached continuous cycle OUTSIDE the command chain: keep flowing
          // through the keyframes until a newer command bumps the token. The
          // first pass above eased from the start pose through the cycle once
          // (and measured it); the LOOP now runs a SEAMLESS periodic trajectory
          // that excludes the start/intro pose and makes the last→first wrap a
          // velocity-continuous fly-through — no snap back through standing, no
          // per-cycle stall (the loop-seam fix). We enter the loop clock at the
          // last keyframe's phase (`enterAtMs`), where the first pass left the
          // body, so the very first wrap is the smooth cycle transition.
          // Re-uses the loopForm built above (same input ⇒ same trajectory) —
          // the SAME object the vcal table was derived from (DET-LOCK-02).
          const { trajectory: loopTraj, enterAtMs } = loopForm ?? buildLoopTrajectory(built, { timeScale });
          // VCAL HANDOFF (DET-LOCK-02): the loop clock's elapsed time IS cycle
          // phase — drop the first-pass phase offset + entry ramp, and BLEND any
          // residual applied-vertical difference (measured at the boundary pose)
          // over VCAL_HANDOFF_BLEND_MS instead of switching discretely. With the
          // shared loop-form table + phase alignment the residual is ~0 by
          // construction; the blend guards the seam against any drift.
          if (composedVcal.gain !== 1 || composedVcal.smoothed) {
            const liveY = modelRoot ? modelRoot.position.y : 0;
            composedVcalPhaseOffsetMs = 0;
            composedVcalRampMs = 0;
            composedVcalHandoff = null;
            const s0 = loopTraj.sampleAt(enterAtMs);
            if (skinnedRef && variantCfgRef)
              applyCustomPose(skinnedRef.skeleton, variantCfgRef, s0.pose);
            applyTrajectoryRoot(s0.rootQuat, s0.rootTranslate, s0.planted, enterAtMs, s0.groundingPosture);
            const deltaYM = modelRoot ? liveY - modelRoot.position.y : 0;
            if (Math.abs(deltaYM) > 1e-4)
              composedVcalHandoff = { deltaYM, startedAtMs: performance.now() };
          } else {
            composedVcalPhaseOffsetMs = 0;
            composedVcalRampMs = 0;
          }
          // The loop cycle carries no grounding postures — re-derive (to empty)
          // so the one-shot pass's crossfade spans can never misapply to the
          // wrapped loop clock.
          setComposedGroundingBlend(loopTraj);
          activeTrajectory = {
            traj: loopTraj,
            start: performance.now() - enterAtMs,
            settleAtMs: [],
            nextSettle: 0,
            onSettle: () => {},
            loop: true,
            resolve: () => {},
            finished: false,
          };
          composedActive = true;
          resetLivelinessOnset();
          return { status: 'playing', ...base };
        }
        if (token !== composedSeq) {
          // Ended before the last keyframe. A USER CANCEL (cancelActiveMovement
          // marked this token) resolves 'cancelled'; a newer command / variant
          // switch / unmount that superseded it resolves 'interrupted'. Either way
          // only the settled keyframes are reported (never a partial as complete).
          const cancelled = token === composedCancelledToken;
          if (cancelled) composedCancelledToken = null;
          return {
            status: cancelled ? 'cancelled' : 'interrupted',
            reason: cancelled ? 'user-cancel' : disposed ? 'stage-disposed' : 'superseded',
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
        undoIdleOverlays(); // the clip starts from the clean idle pose
        undoEyeGaze(); // eye deltas lift with it (re-baked live next frame)
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
        poseLayerOnTakeover?.();
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
        // Ease into the clip from the CURRENT pose (still intact — the mixer only
        // writes on update): capture it now, blend toward the clip each frame.
        if (skinnedRef) clipBlend.begin(skinnedRef.skeleton.bones, CLIP_BLEND_SEC);
        resetLivelinessOnset();
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
        // EXERTION accumulator (Wave 5): rises toward the playing composed
        // motion's measured work intensity, decays toward 0 over ~45 s at
        // rest. Stepped every frame so the breathing overlays (motion + idle)
        // read one continuous level. Pure, framerate-independent step.
        breath.stepExertion(
          composedActive || activeTrajectory ? breath.workIntensity : 0,
          motionDelta,
        );
        if (mixer && activeMotionId) {
          mixer.update(motionDelta); // step the named-motion clip (bones-only)
          // Clip ease-in: slerp the captured start pose toward the clip pose for
          // the first CLIP_BLEND_SEC (no-op once complete). AFTER mixer.update so
          // the bones already hold the clip pose to blend toward.
          clipBlend.apply(motionDelta);
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
              const cap = getEffectiveRomRange(romConstraints ?? null, leg.kneeKey, 'kneeFlexion')?.max ?? Infinity;
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
                clampBoneToRom(leg.hipBone, leg.hipKey, restRef, romConstraints ?? null);
                modelRoot.updateMatrixWorld();
              }
              changed = true;
            }
            // Non-leg caps (e.g. trunk flexion): direct clamp.
            for (const key of motionCapKeys) {
              if (KNEE_TO_FOOT[key]) continue;
              const bone = motionCapBones.get(key);
              if (bone && clampBoneToRom(bone, key, restRef, romConstraints ?? null)) changed = true;
            }
            if (changed) modelRoot.updateMatrixWorld();
          }
          renderNeeded = true; // keep rendering while a motion plays
        }
        if (activeTween) stepTween(performance.now()); // pose tween (bones-only)
        if (activeTrajectory) stepTrajectory(performance.now()); // composed motion
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
          // Liveliness (breathing + micro-sway) is a LIVE-ONLY realism prior — it
          // must NOT leak into recordings/streamed reports (SEAM-9: the offline
          // sampler never sees it, so a recording that carried it would diverge).
          // It is therefore applied via applyMotionLiveliness() AFTER the recording
          // tap + report below, in the same undo/reapply discipline as the idle
          // overlay — NOT here. (Guarding/sway are baked into the resolved
          // keyframes now, so they ARE in the driven pose the tap/report sample.)
          // Pelvis-shift overlay: re-bake the constant lateral root offset.
          // Composed playback already re-baked inside applyTrajectoryRoot (a
          // no-op here); the clip (mixer) path is bones-only and never rewrites
          // the root per frame, so this is where the shift lands for clips —
          // and where a mid-clip setMotionOverlays change takes effect.
          bakePelvisShift();
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
        // Idle liveliness, part 1: lift last frame's idle deltas FIRST (an
        // exact base restore — no-op unless baked), so the recording tap below
        // always samples the clean underlying pose and the deltas can never
        // accumulate. An undone frame still draws once (dirty flag honest).
        if (undoIdleOverlays()) renderNeeded = true;
        // EYES: lift last frame's micro-gaze deltas the same way (exact base
        // restore) so the tap below samples the eyes at rest too.
        if (undoEyeGaze()) renderNeeded = true;
        // Motion-recording tap: while active, sample at the requested rate
        // regardless of what drives the skeleton (clip, exam tween, composed
        // playback, or idle manual time). Same throttle pattern as the
        // motionReportHz streaming above; a single null check when inactive.
        if (recording) {
          const nowMs = performance.now();
          if (nowMs - recording.lastSample >= 1000 / recording.sampleHz - 4) {
            recording.lastSample = nowMs;
            captureRecordingFrame(recording, nowMs);
          }
        }
        // Idle liveliness, part 2: while the stage is truly IDLE — no clip, no
        // composed playback, no exam tween, no trajectory, posing layer not
        // engaged — re-bake the overlay at the advanced phase so the patient
        // keeps breathing between commands (the most-watched moment). Applied
        // AFTER the recording tap: recordings stay clean. Waking the render
        // only when deltas actually applied keeps the idle-render optimization
        // honest — clean mode (idleLiveliness 0) never forces a draw.
        if (
          !activeMotionId &&
          !composedActive &&
          !activeTween &&
          !activeTrajectory &&
          !poseLayerBusy?.() &&
          applyIdleOverlays(motionDelta)
        ) {
          renderNeeded = true;
        } else if (((mixer && activeMotionId) || composedActive) && applyMotionLiveliness(motionDelta)) {
          // Motion-time liveliness (SEAM-9): the realism breathing/micro-sway is
          // re-applied HERE — after the tap — for the SAME reason the idle overlay
          // is (recordings/reports stay clean). It is mutually exclusive with the
          // idle path above (a motion is driving), and the driver overwrites the
          // trunk next frame so it never accumulates.
          renderNeeded = true;
        }
        // EYES: re-bake the micro-gaze at the advanced phase — deliberately
        // NOT gated on idle (the eyes live during motion too; they are
        // overlay-only leaves outside the pose pipeline). Applied AFTER the
        // recording tap so recordings stay clean; clean mode applies nothing
        // and never forces a draw.
        if (applyEyeGaze(motionDelta)) renderNeeded = true;
        // MEASURE-ONLY diagnostic sample (opt-in): read the ACTUAL post-overlay
        // trunk/pelvis + active-overlay flags at ~15 Hz. Runs before the render
        // early-return so a held/idle frame still updates the readout.
        if (diagnostics && modelRoot && motionCapBones) {
          const diagNow = performance.now();
          if (diagNow - lastDiagMs >= 66) {
            lastDiagMs = diagNow;
            // matrixWorld is current here (overlays ran updateMatrixWorld this
            // frame); computeStageDiagnostics reads it — no THREE allocations.
            const lower = motionCapBones.get('Spine_Lower');
            diag = computeStageDiagnostics({
              lower,
              upper: motionCapBones.get('Spine_Upper'),
              head: motionCapBones.get('Head'),
              hips: motionCapBones.get('Hips') ?? lower,
              rootX: modelRoot.position.x,
              rootRestX: rootRestPos.x,
              driver: {
                activeTween: !!activeTween,
                composedActive,
                activeMotion: !!activeMotionId,
                activeTrajectory: !!activeTrajectory,
                idleOverlayOn: idleOverlay.overlayOn,
                idlePivotOn: idleOverlay.pivotOn,
              },
              livelinessOnsetSec,
              livelinessOnsetTotalSec: LIVELINESS_ONSET_SEC,
              swayMod: motionSway,
              shiftModM: motionPelvisShiftM,
            });
          }
        }
        if (!renderNeeded) return;
        poseLayerBeforeRender?.(); // markers / gizmo / twist / slice tracking
        renderer.render(scene, camera);
        poseLayerAfterRender?.(); // rotate-ring depth-cleared overlay pass
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
        poseLayerDispose?.();
        if (activeTween) finishTween();
        stopMotion(); // resolves any awaiting one-shot motion promise
        runCommandImpl = null;
        runMotionImpl = null;
        runComposedImpl = null;
        cancelActiveMovementImpl = null;
        startRecordingImpl = null;
        stopRecordingImpl = null;
        showRecordedFrameImpl = null;
        captureFrameImpl = null;
        cancelAnimationFrame(raf);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        ro.disconnect();
        controls.removeEventListener('change', requestRender);
        disposeModel();
        cam.dispose(); // removes dblclick/key listeners + disposes controls
        renderer.dispose();
        if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      };

      // ── OPT-IN posing layer (simMOVE unified studio) ────────────────────
      // Mounts the same modular posing services PoseLab uses on THIS stage's
      // skeleton, so hand posing, motion playback, recordings, and the AI
      // command surface all share one mannequin + one continuity state
      // (`currentPose`). Never initialised unless `posable` — default
      // consumers keep the exact pre-existing behaviour.
      if (posable) {
        const { TransformControls } = await import(
          'three/examples/jsm/controls/TransformControls.js'
        );
        const {
          buildIKChainContext,
          solveIKChain,
          disposeIKChainContext,
          distributeChainCurve,
          readAxialTwist,
          setAxialTwist,
          pinBonesToRestWorld,
        } = await import('./services/poseRig');
        const { gizmoSpaceForJoint, computeDrivingRingMap } = await import(
          './services/jointAngles'
        );
        const { configureRingRotateGizmo } = await import('./services/poseGizmoHelpers');
        const { PoseRotateRingGizmo } = await import('./services/poseRotateRings');
        const { PoseClickDeselect } = await import('./services/poseClickDeselect');
        const { buildTwistRig, applyTwistRig } = await import('./services/twistRig');
        const { buildLimbAxisModel, ALL_LIMB_IDS } = await import('./services/limbAxisModel');
        const { createAnatomicalPlanes } = await import('./services/anatomicalPlanes');
        const { createSectionCap } = await import('./services/sectionCap');
        if (disposed) return;

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
          !!activeMotionId || composedActive || !!activeTween || posePlayActive;

        /** ROM-clamp a bone for HAND POSING without disturbing the motion-cap
         *  clamp override machinery (which stopMotion/setMotionRomCaps own). */
        function poseClamp(bone: import('three').Bone, key: string): boolean {
          if (!poseRomClampOn || !restRef || !hasClampStrategy(key)) return false;
          setRomClampEnabled(true);
          const changed = clampBoneToRom(bone, key, restRef, romConstraints ?? null);
          setRomClampEnabled(motionCapKeys.length ? true : null);
          return changed;
        }

        /** Fold the hand-posed skeleton into the stage's continuity state so
         *  the next motion/command starts from — and captureFrame bakes —
         *  exactly what was posed. */
        function commitPosedState(): void {
          if (!skinnedRef || !variantCfgRef) return;
          // Belt-and-braces: idle liveliness suspends while the layer is
          // engaged, but a same-frame press→release could still commit with
          // deltas baked — lift them so the committed pose is always clean.
          undoIdleOverlays();
          undoEyeGaze(); // committed poses carry the eyes at rest
          modelRoot?.updateMatrixWorld(true);
          currentPose = serializeCustomPose(skinnedRef.skeleton, variantCfgRef, variantCfgRef.id);
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

        /** Colour each plane ring by the motion it drives (via the driving-
         *  ring map); hide the wrist's redundant pro/sup ring. */
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
          const proSupRing = dr.transverse?.ring;
          ringGizmo.setHiddenRings(
            (key === 'L_Hand' || key === 'R_Hand') && proSupRing ? [proSupRing] : [],
          );
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
          if (!chain || !motionCapBones || !restRef) return false;
          const segs: import('three').Object3D[] = [];
          const rests: import('three').Quaternion[] = [];
          for (const k of chain.keys) {
            const b = motionCapBones.get(k);
            const rl = restRef.localQuats[k];
            if (!b || !rl) return false;
            segs.push(b);
            rests.push(new THREE.Quaternion(rl[0], rl[1], rl[2], rl[3]));
          }
          let clamped = target;
          const ctrl = motionCapBones.get(key);
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
          if (!PROSUP_KEYS.has(key) || !motionCapBones || !restRef) return false;
          const side = key.startsWith('L_') ? 'L_' : 'R_';
          const forearm = motionCapBones.get(`${side}Forearm`);
          const hand = motionCapBones.get(`${side}Hand`);
          const rfArr = restRef.localQuats[`${side}Forearm`];
          const rhArr = restRef.localQuats[`${side}Hand`];
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
          if (!skinnedRef || !variantCfgRef || !motionCapBones) return;
          const plant: { ctx: IKChainContext; pos: import('three').Vector3 }[] = [];
          for (const k of ['L_Foot', 'R_Foot']) {
            const foot = motionCapBones.get(k);
            if (!foot) continue;
            const ctx = buildIKChainContext(skinnedRef, foot, 2, variantCfgRef);
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
            solveIKChain(leg.ctx, leg.pos, { rest: restRef, hinges: POSE_PLANT_HINGES });
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
          if (!motionCapBones || !variantCfgRef) return;
          handleGroup = new THREE.Group();
          for (const h of variantCfgRef.poseRig.handles) {
            const bone = motionCapBones.get(h.canonicalKey);
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
          if (!skinnedRef || !variantCfgRef) return;
          const model = buildLimbAxisModel(skinnedRef.skeleton, variantCfgRef, 0, 1);
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
          if (!modelRoot) return;
          modelRoot.traverse((o) => {
            const mesh = o as import('three').Mesh;
            if (!mesh.isMesh) return;
            clipMeshes.push(mesh);
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) if (m) clipTargets.push(m);
          });
          sectionCap?.dispose();
          sectionCap = createSectionCap(clipMeshes, (modelRadius || 1) * 2.5);
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
            const r = modelRadius || 1;
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
          if (!selected || !tcDragging || !modelRoot) return;
          modelRoot.updateMatrixWorld(true);
          if (poseClamp(selected.bone, selected.key)) modelRoot.updateMatrixWorld(true);
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
          if (ringDrag && selected && modelRoot) {
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
            } else if (selected.key === 'Hips') {
              selected.bone.quaternion.copy(target);
              modelRoot.updateMatrixWorld(true);
              applyPelvisPlant(); // keep feet planted while tilting the pelvis
            } else {
              selected.bone.quaternion.copy(target);
              poseClamp(selected.bone, selected.key);
            }
            modelRoot.updateMatrixWorld(true);
            updatePoseHandles();
            reportPosing();
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
          if (!ikCtx && skinnedRef && variantCfgRef) {
            ikCtx = buildIKChainContext(skinnedRef, press.handle.bone, press.handle.chain, variantCfgRef);
          }
          if (!ikCtx) return;
          solveIKChain(ikCtx, _dragTarget);
          // ROM-clamp the solved chain (effector up through its parents).
          if (restRef && poseRomClampOn && reverseBoneMap) {
            let b: import('three').Object3D | null = press.handle.bone;
            for (let i = 0; i <= press.handle.chain && b; i++) {
              const key = reverseBoneMap.get(b);
              if (key) poseClamp(b as import('three').Bone, key);
              const parent: import('three').Object3D | null = b.parent;
              if (!parent || !(parent as import('three').Bone).isBone) break;
              b = parent;
            }
          }
          modelRoot.updateMatrixWorld(true);
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
            currentPose = posePlayPosed;
            if (restore) {
              applyPoseNow(posePlayPosed);
              modelRoot?.updateMatrixWorld(true);
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
          if (!skinnedRef || !variantCfgRef || !baselinePoseRef || posingSuspended()) return false;
          deselectImpl();
          // The preview snapshot must be the CLEAN pose, never an idle delta.
          undoEyeGaze(); // nor a baked eye delta
          undoIdleOverlays();
          posePlayPosed = serializeCustomPose(skinnedRef.skeleton, variantCfgRef, variantCfgRef.id);
          posePlayActive = true;
          const start = performance.now();
          const tick = () => {
            if (!posePlayActive) return;
            const phase = ((performance.now() - start) % (2 * POSE_PLAY_DUR)) / POSE_PLAY_DUR;
            const tri = phase <= 1 ? phase : 2 - phase; // 0..1..0
            const eased = tri * tri * (3 - 2 * tri); // smoothstep
            const blended = blendCustomPoseWithBaseline(
              baselinePoseRef,
              posePlayPosed,
              baselinePoseRef,
              eased,
            );
            if (blended && skinnedRef && variantCfgRef) {
              applyCustomPose(skinnedRef.skeleton, variantCfgRef, blended);
              modelRoot?.updateMatrixWorld(true);
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
        poseLayerOnTakeover = () => {
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

        poseLayerOnModelLoaded = () => {
          poseLayerOnTakeover?.();
          reverseBoneMap = new Map();
          if (motionCapBones) for (const [k, b] of motionCapBones) reverseBoneMap.set(b, k);
          drivingRings = restRef ? computeDrivingRingMap(restRef) : null;
          twistRig =
            skinnedRef && variantCfgRef ? buildTwistRig(skinnedRef.skeleton, variantCfgRef) : [];
          buildPoseHandles();
          buildFingerCurls();
          if (poseShowAxes) buildAxes();
          else clearAxes();
          ensurePlanes();
          planes?.setExtents(modelCenter, modelRadius);
          collectClipTargets();
          applySlice();
        };

        poseLayerBeforeRender = () => {
          const suspended = posingSuspended();
          if (suspended && selected) deselectImpl();
          if (handleGroup) handleGroup.visible = jointsActive();
          if (obliqueDot) obliqueDot.visible = obliqueEditing() && !suspended;
          // Twist distribution only while posing owns the skeleton — a mixer
          // clip / tween must never be post-processed by the pose twist rig.
          if (poseTwistOn && twistRig.length && !suspended) {
            applyTwistRig(twistRig);
            modelRoot?.updateMatrixWorld(true);
          }
          updatePoseHandles();
          updateRingGizmo();
          if (sliceState.plane !== 'off') {
            refreshSlicePlane(); // live-track gizmo moves + motion + depth
            if (sliceState.cap && sectionCap) sectionCap.update();
          }
        };
        poseLayerAfterRender = () => {
          ringGizmo.render(renderer, camera);
        };
        // Idle liveliness suspends while the layer is ENGAGED — a selected
        // joint (rings up), an in-flight marker/ring/oblique drag, or the
        // pose-motion preview — so hand-posing is never perturbed. Merely
        // being posable does NOT suspend it: an untouched studio still breathes.
        poseLayerBusy = () =>
          !!selected || !!press || !!ringDrag || !!obliqueRingDrag || !!obliquePress ||
          tcDragging || posePlayActive;

        poseLayerDispose = () => {
          poseLayerBusy = null;
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
          poseApiImpl = null;
        };

        // ── Host-facing pose API ───────────────────────────────────────────
        poseApiImpl = {
          getPose: () => {
            if (!skinnedRef || !variantCfgRef) return null;
            // Serialize the CLEAN pose — never a baked idle-liveliness delta
            // (the rAF loop re-bakes it next frame; phase is continuous).
            undoIdleOverlays();
            undoEyeGaze(); // eyes at rest in the serialized pose
            return serializeCustomPose(skinnedRef.skeleton, variantCfgRef, variantCfgRef.id);
          },
          loadPose: (pose: CustomPose) => {
            if (!skinnedRef || !variantCfgRef) return;
            // A loaded pose owns the skeleton — same cancels as scrubbing
            // (idle deltas lift BEFORE the absolute pose/root writes).
            undoIdleOverlays();
            undoEyeGaze(); // eye deltas lift before the absolute pose writes
            poseLayerOnTakeover?.();
            cancelComposed();
            if (activeMotionId) stopMotion();
            if (activeTween) finishTween();
            resetRootToRest(); // authored poses are upright, rotation-only
            applyCustomPose(skinnedRef.skeleton, variantCfgRef, pose);
            currentPose = pose;
            modelRoot?.updateMatrixWorld(true);
            updatePoseHandles();
            reportPosing(true);
            requestRender();
            startLoop();
          },
          resetPose: () => {
            if (!skinnedRef || !variantCfgRef) return;
            undoIdleOverlays();
            undoEyeGaze(); // eye deltas lift with it (re-baked live next frame)
            poseLayerOnTakeover?.();
            cancelComposed();
            if (activeMotionId) stopMotion();
            if (activeTween) finishTween();
            resetRootToRest();
            applyPoseNow(null);
            currentPose = null;
            modelRoot?.updateMatrixWorld(true);
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
            if (!skinnedRef || !variantCfgRef || !modelRoot || frames.length < 2) return;
            const [{ GLTFExporter }, { clone: cloneSkeleton }] = await Promise.all([
              import('three/examples/jsm/exporters/GLTFExporter.js'),
              import('three/examples/jsm/utils/SkeletonUtils.js'),
            ]);
            const skel = skinnedRef.skeleton;
            const variantCfg = variantCfgRef;
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
            modelRoot.updateMatrixWorld(true);
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
            const cloneRoot = cloneSkeleton(modelRoot);
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

        // Flush host state pushed before the layer was wired.
        if (pendingPosingOptions) {
          poseApiImpl.setPosingOptions(pendingPosingOptions);
          pendingPosingOptions = null;
        }
        if (pendingPlanes) {
          poseApiImpl.setPlanes(pendingPlanes);
          pendingPlanes = null;
        }
        if (pendingSlice) {
          poseApiImpl.setSlice(pendingSlice);
          pendingSlice = null;
        }
      }

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
  {#if diagnostics && diag}
    <div class="pose-viewer__diag" aria-hidden="true">
      <span class="pose-viewer__diag-state">{diag.state}</span>
      <span class:pose-viewer__diag-hot={Math.abs(diag.trunkTiltDeg) > 5}
        >trunk {diag.trunkTiltDeg >= 0 ? '+' : ''}{diag.trunkTiltDeg.toFixed(1)}°</span
      >
      <span class:pose-viewer__diag-hot={Math.abs(diag.lumbarTiltDeg) > 5}
        >lumbar {diag.lumbarTiltDeg >= 0 ? '+' : ''}{diag.lumbarTiltDeg.toFixed(1)}°</span
      >
      <span class:pose-viewer__diag-hot={Math.abs(diag.pelvisShiftCm) > 3}
        >pelvis {diag.pelvisShiftCm >= 0 ? '+' : ''}{diag.pelvisShiftCm.toFixed(1)}cm</span
      >
      {#if diag.livelinessPct > 0}<span>live {diag.livelinessPct.toFixed(0)}%</span>{/if}
      {#if diag.swayMod > 0}<span>sway {diag.swayMod.toFixed(2)}</span>{/if}
      {#if Math.abs(diag.shiftModCm) > 0.05}<span>shiftMod {diag.shiftModCm.toFixed(1)}cm</span>{/if}
      {#if diag.idle}<span>idle</span>{/if}
      {#if diag.pivot}<span>pivot</span>{/if}
      <span class="pose-viewer__diag-key">+L / −R</span>
    </div>
  {/if}
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
  .pose-viewer__diag {
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 3px 8px;
    max-width: calc(100% - 16px);
    padding: 5px 8px;
    font: 600 11px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #cfe8ff;
    background: rgba(10, 16, 20, 0.72);
    border: 1px solid rgba(120, 190, 255, 0.35);
    border-radius: 7px;
    pointer-events: none;
    z-index: 3;
  }
  .pose-viewer__diag-state {
    color: #7fd8a0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .pose-viewer__diag-hot {
    color: #ffb454;
    font-weight: 700;
  }
  .pose-viewer__diag-key {
    color: rgba(255, 255, 255, 0.4);
    font-weight: 500;
  }
</style>
