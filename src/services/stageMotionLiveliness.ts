/**
 * MOTION-TIME liveliness overlay — extracted from ExamStage3D.
 *
 * LIVE-ONLY realism: exertion-scaled FM breathing at the thorax + micro-sway at
 * the low back while a MOTION drives the skeleton, layered ON TOP of the driven
 * pose. The animation driver (mixer/trajectory) overwrites both trunk bones
 * every frame, so the premultiplied delta never accumulates. Applied AFTER the
 * recording tap + streamed report (SEAM-9) — the offline sampler never sees
 * liveliness, so a recording/report that carried it would diverge from the
 * grade. Feet/legs + every measured driver joint are untouched; only the two
 * trunk bones move. Wall-clock phase (livelinessTime) is incommensurate with the
 * loop, so no cycle repeats.
 *
 * Own state only (the shared breath clock + the `motionLiveliness` modifier are
 * passed in). Eased in over LIVELINESS_ONSET_SEC from each motion start so the
 * trunk is quiet through the commanded motion's zero-velocity ease-in.
 */
import * as THREE from 'three';
import { breathingLeanFM, livelinessSwayDeg } from './liveliness';
import type { BreathState } from './stageBreath';

type BoneMap = Map<string, THREE.Bone>;

/** Onset ease duration (s): the sway/breathing eases in over this window from
 *  each motion start, instead of a full-strength free-running sway snapping on. */
export const LIVELINESS_ONSET_SEC = 0.4;

export interface MotionLiveliness {
  /** Bake the motion-time breathing + micro-sway onto the trunk (premultiplied
   *  over the driven pose). Returns whether applied (clean mode / no bones ⇒
   *  false). */
  apply(
    dtSec: number,
    motionLiveliness: number,
    bones: BoneMap | null,
    modelRoot: THREE.Object3D | null,
    breath: BreathState,
    swayAxisAP: THREE.Vector3,
    swayAxisML: THREE.Vector3,
  ): boolean;
  /** Reset the onset ramp + sway phase — call at each movement START. */
  reset(): void;
  /** Seconds since the current motion's onset (drives the ease-in ramp). */
  readonly onsetSec: number;
}

export function createMotionLiveliness(): MotionLiveliness {
  let livelinessTime = 0;
  let livelinessOnsetSec = 0;
  const _liveQ = new THREE.Quaternion();

  function apply(
    dtSec: number,
    motionLiveliness: number,
    bones: BoneMap | null,
    modelRoot: THREE.Object3D | null,
    breath: BreathState,
    swayAxisAP: THREE.Vector3,
    swayAxisML: THREE.Vector3,
  ): boolean {
    if (!(motionLiveliness > 0) || !bones || !modelRoot) return false;
    livelinessTime += dtSec;
    livelinessOnsetSec += dtSec;
    // Ease the sway/breathing IN over the first ~0.4 s of the movement so the
    // trunk is quiet through the commanded motion's zero-velocity ease-in. Also
    // smooths the idle→motion lumbar handoff (no full-strength step at onset).
    const onsetRamp = Math.min(1, livelinessOnsetSec / LIVELINESS_ONSET_SEC);
    // Exertion-scaled FM breathing: integrate the SHARED phase at the exertion-
    // driven rate (phase-continuous — never t×rate, so no mid-breath jump).
    breath.advancePhase(dtSec);
    const thorax = bones.get('Spine_Upper');
    if (thorax) {
      const breathDeg = onsetRamp * breathingLeanFM(breath.phase, motionLiveliness, breath.exertion);
      _liveQ.setFromAxisAngle(swayAxisAP, (breathDeg * Math.PI) / 180);
      thorax.quaternion.premultiply(_liveQ);
    }
    const lowBack = bones.get('Spine_Lower');
    if (lowBack) {
      const { mlDeg, apDeg } = livelinessSwayDeg(livelinessTime, motionLiveliness);
      _liveQ.setFromAxisAngle(swayAxisML, (onsetRamp * mlDeg * Math.PI) / 180);
      lowBack.quaternion.premultiply(_liveQ);
      _liveQ.setFromAxisAngle(swayAxisAP, (onsetRamp * apDeg * Math.PI) / 180);
      lowBack.quaternion.premultiply(_liveQ);
    }
    modelRoot.updateMatrixWorld(true);
    return true;
  }

  function reset(): void {
    livelinessOnsetSec = 0;
    livelinessTime = 0; // ML sway restarts at phase 0 (breath.phase stays continuous)
  }

  return {
    apply,
    reset,
    get onsetSec() {
      return livelinessOnsetSec;
    },
  };
}
