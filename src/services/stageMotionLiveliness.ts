/**
 * MOTION-TIME liveliness overlay — extracted from ExamStage3D.
 *
 * LIVE-ONLY realism: exertion-scaled FM breathing at the thorax + micro-sway at
 * the low back while a MOTION drives the skeleton, layered ON TOP of the driven
 * pose. Applied AFTER the recording tap + streamed report (SEAM-9) — the
 * offline sampler never sees liveliness, so a recording/report that carried it
 * would diverge from the grade — and LIFTED again before the next frame's tap
 * ({@link MotionLiveliness.undo}). A driver (mixer/trajectory/tween) overwrites
 * both trunk bones every frame, but nothing does through the stage's
 * ready hold (after the settle tween, before the trajectory, with the composed
 * motion already active): there the premultiplied delta stayed in the bones for
 * the tap to record and the next frame premultiplied onto it. Measured on a
 * simulated 650 ms settle + 300 ms hold at 60 Hz, the trunk had drifted
 * 11.8–17.9° (liveliness 0.5) and 23.5–35.8° (liveliness 1) from the held pose
 * by the end of the hold, depending on where the sway and breath stood — in
 * the frames the tap recorded, which the gait check's 0.05° stillness search
 * reads its ready-settle head from. Feet/legs + every measured driver joint
 * are untouched; only the two trunk bones move. Wall-clock phase
 * (livelinessTime) is incommensurate with the loop, so no cycle repeats.
 *
 * Own state only (the shared breath clock + the `motionLiveliness` modifier are
 * passed in). Eased in over LIVELINESS_ONSET_SEC from each motion start so the
 * trunk is quiet through the commanded motion's zero-velocity ease-in.
 */
import * as THREE from 'three';
import { breathingLeanFM, livelinessSwayDeg } from './liveliness';
import type { BreathState } from './stageBreath';
import { idleSupport } from './idleSupport';

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
  /** Lift the last {@link apply}'s deltas where they still stand: each trunk
   *  bone that still holds exactly what the apply left gets its pre-apply
   *  quaternion back; a bone a driver has written since keeps the driver's.
   *  Call each frame BEFORE the recording tap (the idle overlay's
   *  undo/reapply discipline), so the tap samples the driven pose and the
   *  deltas never accumulate while nothing drives the trunk. Returns whether
   *  it restored anything. */
  undo(bones: BoneMap | null, modelRoot: THREE.Object3D | null): boolean;
  /** Reset the onset ramp + sway phase — call at each movement START. */
  reset(): void;
  /** Seconds since the current motion's onset (drives the ease-in ramp). */
  readonly onsetSec: number;
}

export function createMotionLiveliness(): MotionLiveliness {
  let livelinessTime = 0;
  let livelinessOnsetSec = 0;
  const _liveQ = new THREE.Quaternion();
  /** What the last apply found (pre) and left (post) in each trunk bone. */
  const baked: { key: string; pre: THREE.Quaternion; post: THREE.Quaternion; on: boolean }[] = [
    { key: 'Spine_Upper', pre: new THREE.Quaternion(), post: new THREE.Quaternion(), on: false },
    { key: 'Spine_Lower', pre: new THREE.Quaternion(), post: new THREE.Quaternion(), on: false },
  ];

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
    const lying = idleSupport(bones) === 'lying';
    if (thorax) {
      baked[0]!.pre.copy(thorax.quaternion);
      const breathDeg = onsetRamp * breathingLeanFM(breath.phase, motionLiveliness, breath.exertion) * (lying ? 0.2 : 1);
      _liveQ.setFromAxisAngle(swayAxisAP, (breathDeg * Math.PI) / 180);
      thorax.quaternion.premultiply(_liveQ);
      baked[0]!.post.copy(thorax.quaternion);
    }
    baked[0]!.on = !!thorax;
    const lowBack = bones.get('Spine_Lower');
    if (lowBack && !lying) {
      baked[1]!.pre.copy(lowBack.quaternion);
      const { mlDeg, apDeg } = livelinessSwayDeg(livelinessTime, motionLiveliness);
      _liveQ.setFromAxisAngle(swayAxisML, (onsetRamp * mlDeg * Math.PI) / 180);
      lowBack.quaternion.premultiply(_liveQ);
      _liveQ.setFromAxisAngle(swayAxisAP, (onsetRamp * apDeg * Math.PI) / 180);
      lowBack.quaternion.premultiply(_liveQ);
      baked[1]!.post.copy(lowBack.quaternion);
    }
    baked[1]!.on = !!lowBack && !lying;
    modelRoot.updateMatrixWorld(true);
    return true;
  }

  function undo(bones: BoneMap | null, modelRoot: THREE.Object3D | null): boolean {
    let restored = false;
    for (const b of baked) {
      if (!b.on) continue;
      b.on = false;
      const bone = bones?.get(b.key);
      if (bone && bone.quaternion.equals(b.post)) {
        bone.quaternion.copy(b.pre);
        restored = true;
      }
    }
    if (restored) modelRoot?.updateMatrixWorld(true);
    return restored;
  }

  function reset(): void {
    livelinessOnsetSec = 0;
    livelinessTime = 0; // ML sway restarts at phase 0 (breath.phase stays continuous)
  }

  return {
    apply,
    undo,
    reset,
    get onsetSec() {
      return livelinessOnsetSec;
    },
  };
}
