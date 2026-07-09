/**
 * Named basic-motion commands (simLAB A2 — "walk", "sit", "stand").
 *
 * This is the CLIP-DRIVEN sibling of the ROM-procedural exam movement layer
 * in `movementCommand.ts`. Where `ExamMovementCommand` drives ONE joint to a
 * ROM-clamped angle with a computed pose tween ("dorsiflex the ankle to 10°"),
 * a {@link MotionCommand} asks the whole avatar to perform a NAMED locomotion
 * or posture motion ("walk", "sit", "stand") by playing an authored animation
 * CLIP on the rig's `AnimationMixer`. The two layers are deliberately parallel
 * so a host (the simLAB mission-shell dispatcher, a viewer, or a voice
 * tool-call) can route either kind of command through one surface.
 *
 * WHY A SEPARATE LAYER (and not more `set-joint` motions): walk/sit/stand are
 * multi-joint, time-varying whole-body motions. They cannot be expressed as a
 * single clamped joint angle — they are pre-authored keyframe clips (the
 * "Human Basic Motions" asset pack) sampled over time. The engine already
 * ships the clip-sampling primitives (`movementClipSampling.ts`) and the lean
 * per-clip speed catalog (`movementClips.ts`); this module adds the COMMAND
 * VOCABULARY + resolution + the asset-ingestion seam that turns those
 * primitives into a "play a named motion" command the same shape as the exam
 * commands.
 *
 * ── ASSET BOUNDARY (matches the README contract) ────────────────────────────
 * The engine owns the motion VOCABULARY and per-motion METADATA (kind, loop
 * mode, playback speed, human label) — the truth every host shares. It does
 * NOT own the clip BYTES or the on-disk asset PATHS: those are an application /
 * asset-repo concern (see `apps/painmap/.../movementTimeline.ts` for the
 * current app-side catalog, and the asset spec in the module TODOs below).
 * A host supplies loaded `THREE.AnimationClip`s through a {@link MotionClipProvider}
 * so this package stays free of the WebGL loader chain and stays node-testable.
 *
 * ── STAGE INTEGRATION (design; wiring gated on the asset — see TODOs) ────────
 * `ExamStage3D.svelte` today animates exam commands with a 600 ms pose tween
 * inside its rAF loop. Named motions plug in at the SAME command seam but are
 * driven by a `THREE.AnimationMixer` instead of `blendCustomPoseWithBaseline`:
 *
 *   applyMotionCommand(cmd)
 *     → resolveMotionCommand(cmd, provider)         // validate + look up meta
 *     → provider.getClips(cmd.motion)               // host-injected clip bytes
 *     → mixer.clipAction(clip); action.setLoop(...) // repeat vs once
 *       action.timeScale = def.speed; action.play()
 *     → on 'once' completion (mixer 'finished') OR stop-motion → resolve outcome
 *
 * A 'once' posture transition (sit / stand-from-sit) resolves 'completed' when
 * the clip ends; a 'repeat' locomotion (walk / jog) resolves 'playing'
 * immediately and runs until a `stop-motion` command. Exam `set-joint`
 * commands and named motions are mutually exclusive on the stage (a motion
 * owns the whole skeleton), so starting a motion cancels any active pose tween
 * and vice-versa — the stage serializes them on its existing command chain.
 */
import type * as THREE from 'three';
import type { MovementClipId } from '../types';
import { MOVEMENT_CLIP_SPEEDS } from './movementClips';

// ── Motion taxonomy ─────────────────────────────────────────────────────────

/**
 * How a named motion behaves, so hosts can group / gate them:
 *  - `locomotion`        — travels the avatar (walk, jog, run, strafe). Loops.
 *  - `posture-transition`— a one-shot change of base posture (sit, long-sit).
 *  - `posture-hold`      — a settled idle posture that loops in place (stand).
 *  - `clinical`          — an authored clinical maneuver clip (knee extension).
 */
export type MotionKind = 'locomotion' | 'posture-transition' | 'posture-hold' | 'clinical';

/** Loop policy for a motion clip. `repeat` runs until stopped; `once` plays
 *  through and settles on its final frame. */
export type MotionLoop = 'repeat' | 'once';

/**
 * Per-motion metadata — the engine-owned truth. Deliberately does NOT carry an
 * asset path or the loaded clip: those come from a {@link MotionClipProvider}
 * (see the ASSET BOUNDARY note in the module header).
 */
export interface MotionClipDefinition {
  id: MovementClipId;
  /** Human label for host UI / voice confirmation ("Walk", "Sit"). */
  label: string;
  kind: MotionKind;
  /** Default loop policy. `play-motion` commands may override per-invocation. */
  loop: MotionLoop;
  /** Default playback speed scalar (mirrors `MOVEMENT_CLIP_SPEEDS`). */
  speed: number;
  /**
   * OPTIONAL hint at the source asset's base name, for host asset resolution
   * and for the asset-ingestion checklist. NOT a load path — the host/asset
   * repo owns the real URL. Left undefined here where the source clip name is
   * not yet confirmed against the delivered "Human Basic Motions FREE" pack.
   *
   * TODO(asset): confirm each hint against the delivered pack's clip inventory
   * (see the asset spec in the module header / README). The current app-side
   * catalog uses e.g. `Walk.glb`, `Sit.glb`, `Stand.glb`, `M_Jog_001.fbx`.
   */
  assetHint?: string;
}

const speedOf = (id: MovementClipId): number => MOVEMENT_CLIP_SPEEDS[id] ?? 1;

/**
 * The engine motion vocabulary. Keyed by every {@link MovementClipId} so the
 * union and the catalog can never drift (enforced in motionCommand.test.ts).
 *
 * `speed` is sourced from the shared `MOVEMENT_CLIP_SPEEDS` catalog so there is
 * ONE speed truth. `assetHint`s are the source clip names TODO-confirmed
 * against the delivered asset pack.
 */
export const MOTION_CLIP_DEFINITIONS: Record<MovementClipId, MotionClipDefinition> = {
  // ── Basic human motions (the focused walk / sit / stand scope) ────────────
  stand: { id: 'stand', label: 'Stand', kind: 'posture-hold', loop: 'repeat', speed: speedOf('stand'), assetHint: 'Stand' },
  sit: { id: 'sit', label: 'Sit', kind: 'posture-transition', loop: 'once', speed: speedOf('sit'), assetHint: 'Sit' },
  walk: { id: 'walk', label: 'Walk', kind: 'locomotion', loop: 'repeat', speed: speedOf('walk'), assetHint: 'Walk' },
  // ── Extended locomotion (already in the union; assets provisioned app-side) ─
  'walk-backward': { id: 'walk-backward', label: 'Walk Backward', kind: 'locomotion', loop: 'repeat', speed: speedOf('walk-backward'), assetHint: 'M_Walk_Backwards_001' },
  'walk-strafe-left': { id: 'walk-strafe-left', label: 'Strafe Left', kind: 'locomotion', loop: 'repeat', speed: speedOf('walk-strafe-left'), assetHint: 'M_Walk_Strafe_Left_002' },
  'walk-strafe-right': { id: 'walk-strafe-right', label: 'Strafe Right', kind: 'locomotion', loop: 'repeat', speed: speedOf('walk-strafe-right'), assetHint: 'M_Walk_Strafe_Right_002' },
  'crouch-walk': { id: 'crouch-walk', label: 'Crouch Walk', kind: 'locomotion', loop: 'repeat', speed: speedOf('crouch-walk'), assetHint: 'M_Crouch_Walk_003' },
  limp: { id: 'limp', label: 'Limp', kind: 'locomotion', loop: 'repeat', speed: speedOf('limp'), assetHint: 'Limp' },
  'long-sit': { id: 'long-sit', label: 'Long Sit', kind: 'posture-transition', loop: 'once', speed: speedOf('long-sit'), assetHint: 'LongSit' },
  jog: { id: 'jog', label: 'Jog', kind: 'locomotion', loop: 'repeat', speed: speedOf('jog'), assetHint: 'M_Jog_001' },
  run: { id: 'run', label: 'Run', kind: 'locomotion', loop: 'repeat', speed: speedOf('run'), assetHint: 'M_Run_001' },
  'walk-relaxed': { id: 'walk-relaxed', label: 'Relaxed Walk', kind: 'locomotion', loop: 'repeat', speed: speedOf('walk-relaxed'), assetHint: 'walk-relaxed-loop' },
  // ── Clinical maneuver clips ────────────────────────────────────────────────
  'left-knee-extension': { id: 'left-knee-extension', label: 'Left Knee Extension', kind: 'clinical', loop: 'once', speed: speedOf('left-knee-extension'), assetHint: 'Sit_Lknee_ex' },
  'right-knee-extension': { id: 'right-knee-extension', label: 'Right Knee Extension', kind: 'clinical', loop: 'once', speed: speedOf('right-knee-extension'), assetHint: 'Sit_Rknee_ex' },
};

/**
 * The focused BASIC-MOTION scope for this workstream: the three motions the
 * platform asks for directly ("walk", "sit", "stand"). Hosts can offer these
 * as the default named-motion chip set.
 */
export const BASIC_MOTIONS: readonly MovementClipId[] = ['stand', 'sit', 'walk'] as const;

/** All locomotion motions (travel the avatar). */
export const LOCOMOTION_MOTIONS: readonly MovementClipId[] = (Object.values(MOTION_CLIP_DEFINITIONS)
  .filter((d) => d.kind === 'locomotion')
  .map((d) => d.id));

/** All posture motions (settle / change the base posture). */
export const POSTURE_MOTIONS: readonly MovementClipId[] = (Object.values(MOTION_CLIP_DEFINITIONS)
  .filter((d) => d.kind === 'posture-transition' || d.kind === 'posture-hold')
  .map((d) => d.id));

// ── Structural command / outcome types ─────────────────────────────────────
// Structural on purpose — hosts mirror these shapes in their transport /
// contract layer without importing this package (same convention as
// ExamMovementCommand in movementCommand.ts).

export type MotionCommand =
  | {
      action: 'play-motion';
      motion: MovementClipId;
      /** Override the definition's default loop policy for this invocation. */
      loop?: MotionLoop;
      /** Override the definition's default speed scalar for this invocation. */
      speed?: number;
    }
  | { action: 'stop-motion' };

export type MotionCommandRefusalReason =
  | 'unknown-motion'
  | 'clip-unavailable'
  | 'stage-unavailable';

export interface MotionCommandOutcome {
  /**
   *  - `playing`   — a looping motion started and is running (walk, stand).
   *  - `completed` — a one-shot motion played through and settled (sit).
   *  - `stopped`   — a `stop-motion` returned the avatar to idle.
   *  - `refused`   — the motion is unknown or its clip is unavailable.
   */
  status: 'playing' | 'completed' | 'stopped' | 'refused';
  motion?: MovementClipId;
  kind?: MotionKind;
  loop?: MotionLoop;
  speed?: number;
  reason?: MotionCommandRefusalReason;
}

// ── Asset-ingestion seam ─────────────────────────────────────────────────────

/**
 * Host-supplied bridge from a motion id to its loaded animation clip(s). This
 * is the SINGLE place the asset pack plugs in — the engine calls it, the host
 * (or asset repo) owns the loading (GLTFLoader / FBXLoader / BVHLoader) and
 * caching.
 *
 * The provider returns RAW clips; the STAGE remaps each clip's track names onto
 * its live skeleton via `normalizeRigBoneName` before binding the mixer (it
 * holds the skeleton). For clips authored on the same CC rig this remap is a
 * no-op, so providers stay a thin byte→clip loader.
 *
 * The reference app-side provider is `createMotionClipProvider` in the
 * mission-shell lib (promoted from `PainBody3D.svelte`'s clipCache + GLB
 * loader); it resolves the committed `Stand/Sit/Walk.glb` assets.
 */
export interface MotionClipProvider {
  /**
   * Return the clip(s) for a motion, or `null`/`[]` when the asset is not (yet)
   * available. May be async (the host lazy-loads + caches). The FIRST clip is
   * the one played; extra clips are reserved for future blend trees.
   */
  getClips(
    motion: MovementClipId,
  ): THREE.AnimationClip[] | null | Promise<THREE.AnimationClip[] | null>;
}

// ── Resolution (pure) ────────────────────────────────────────────────────────

export interface ResolvedMotionCommand {
  status: 'ready' | 'stop' | 'refused';
  motion?: MovementClipId;
  definition?: MotionClipDefinition;
  /** Effective loop policy (command override ?? definition default). */
  loop?: MotionLoop;
  /** Effective speed scalar (command override ?? definition default). */
  speed?: number;
  reason?: MotionCommandRefusalReason;
}

/**
 * Validate a {@link MotionCommand} against the motion catalog and fold in any
 * per-invocation loop/speed overrides. Pure — reads only the static catalog,
 * touches no scene. A stage calls this first, then (for a `ready` result) asks
 * its {@link MotionClipProvider} for the clip and drives the mixer.
 *
 * Clip AVAILABILITY is intentionally NOT checked here (it may be async and is a
 * host concern); the stage maps a missing clip to `reason: 'clip-unavailable'`.
 */
export function resolveMotionCommand(cmd: MotionCommand): ResolvedMotionCommand {
  if (cmd.action === 'stop-motion') {
    return { status: 'stop' };
  }
  const def = MOTION_CLIP_DEFINITIONS[cmd.motion];
  if (!def) {
    return { status: 'refused', motion: cmd.motion, reason: 'unknown-motion' };
  }
  const loop = cmd.loop ?? def.loop;
  const speed =
    typeof cmd.speed === 'number' && Number.isFinite(cmd.speed) && cmd.speed > 0
      ? cmd.speed
      : def.speed;
  return { status: 'ready', motion: cmd.motion, definition: def, loop, speed };
}

/** True when the engine knows this motion (has a catalog definition). */
export function isMotionCommandSupported(motion: string): motion is MovementClipId {
  return Object.prototype.hasOwnProperty.call(MOTION_CLIP_DEFINITIONS, motion);
}

/** The motion vocabulary, for host-side capability discovery. */
export function listSupportedMotionCommands(): MotionClipDefinition[] {
  return Object.values(MOTION_CLIP_DEFINITIONS);
}

/** Look up a motion's metadata, or undefined for an unknown id. */
export function getMotionClipDefinition(
  motion: string,
): MotionClipDefinition | undefined {
  return isMotionCommandSupported(motion) ? MOTION_CLIP_DEFINITIONS[motion] : undefined;
}

/**
 * Terminal status a `ready` motion resolves to once the stage has started it:
 * a looping motion is `playing`, a one-shot is `completed`. Pure helper so the
 * stage and tests agree on the mapping.
 */
export function motionStartStatus(loop: MotionLoop): 'playing' | 'completed' {
  return loop === 'repeat' ? 'playing' : 'completed';
}
