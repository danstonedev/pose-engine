/**
 * EYES · micro-gaze overlay — extracted from ExamStage3D.
 *
 * LIVE-ONLY, ALWAYS-ON while the model is visible (idle AND during motion): the
 * eye bones are leaves no motion machinery writes, so this rides on top of any
 * driver. Each frame both eyes get the SAME small conjugate rotation (no
 * vergence): a gaze-absorb counter of the head's residual yaw/pitch measured in
 * the MODEL-ROOT frame (travel heading + root reorientation cancel out — only
 * the stabilizeGaze leftover registers) plus seeded saccades/drift (pure math in
 * services/eyeGaze). The exact pre-overlay eye locals are stored on apply and
 * restored before the recording tap and at every takeover/serialize/export
 * point, so recordings, goniometry, pose serialization and GLB export always see
 * the eyes at rest. Clean mode (idleLiveliness = 0) applies NOTHING.
 *
 * Own state only (no shared stage state): the caller passes the current bones /
 * root / rest reference each frame, so this survives model reload untouched
 * (call reset() when the skeleton is replaced). Deterministic given the seed.
 */
import * as THREE from 'three';
import { eyeGazeAngles } from './eyeGaze';

type BoneMap = Map<string, THREE.Bone>;

export interface EyeGazeOverlay {
  /** Bake the micro-gaze deltas for the CURRENT phase onto both eye bones.
   *  Stores the exact pre-overlay eye quats so undo() is an exact restore.
   *  Returns whether anything was applied (clean mode applies NOTHING). */
  apply(
    dtSec: number,
    idleLiveliness: number,
    bones: BoneMap | null,
    modelRoot: THREE.Object3D | null,
    headRestWorldQuat: ArrayLike<number> | undefined,
    rootRestQuat: THREE.Quaternion,
  ): boolean;
  /** Exact-restore the baked eye locals. No-op unless deltas are baked. */
  undo(bones: BoneMap | null): boolean;
  /** Snapshot the CURRENTLY-APPLIED eye locals so a capture sandwich can restore
   *  them exactly (re-arms the bake flag). Null when no eye deltas are baked. */
  captureApplied(bones: BoneMap | null): (() => void) | null;
  /** Discard the bake flag — call when the skeleton is replaced. */
  reset(): void;
}

/** Create the micro-gaze overlay. `seed` is randomized per stage boot by the
 *  caller (deterministic per seed → unit-testable). */
export function createEyeGazeOverlay(seed: number): EyeGazeOverlay {
  let eyeGazeTime = 0;
  let eyeGazeOn = false;
  const _eyeBaseLQ = new THREE.Quaternion();
  const _eyeBaseRQ = new THREE.Quaternion();
  const _eyeQa = new THREE.Quaternion();
  const _eyeQb = new THREE.Quaternion();
  const _eyeQc = new THREE.Quaternion();
  const _eyeW = new THREE.Quaternion();
  const _eyeFwd = new THREE.Vector3();
  const _eyeAxisYaw = new THREE.Vector3(0, 1, 0);
  const _eyeAxisPitch = new THREE.Vector3(1, 0, 0);

  function apply(
    dtSec: number,
    idleLiveliness: number,
    bones: BoneMap | null,
    modelRoot: THREE.Object3D | null,
    headRestWorldQuat: ArrayLike<number> | undefined,
    rootRestQuat: THREE.Quaternion,
  ): boolean {
    const amount = Number.isFinite(idleLiveliness)
      ? Math.max(0, Math.min(1, idleLiveliness))
      : 0;
    if (amount <= 0 || !bones || !modelRoot || !headRestWorldQuat) return false;
    const eyeL = bones.get('L_Eye');
    const eyeR = bones.get('R_Eye');
    const head = bones.get('Head');
    if (!eyeL || !eyeR || !head || !eyeL.parent) return false;
    eyeGazeTime += dtSec;
    // Head residual in the MODEL-ROOT frame: relNow vs the rest relation
    // (restRef world quats were captured at the rootRestQuat orientation).
    modelRoot.getWorldQuaternion(_eyeQc); // root now (also reused below)
    head.getWorldQuaternion(_eyeQb);
    _eyeQa.copy(_eyeQc).invert().multiply(_eyeQb); // relNow
    _eyeQb
      .copy(rootRestQuat)
      .invert()
      .multiply(
        _eyeW.set(headRestWorldQuat[0], headRestWorldQuat[1], headRestWorldQuat[2], headRestWorldQuat[3]),
      )
      .invert(); // inv(relRest)
    _eyeQa.multiply(_eyeQb); // residual = relNow · inv(relRest)
    _eyeFwd.set(0, 0, 1).applyQuaternion(_eyeQa); // rest-forward, deviated
    const residualYawDeg = (Math.atan2(_eyeFwd.x, _eyeFwd.z) * 180) / Math.PI;
    const residualPitchDeg = (Math.asin(Math.max(-1, Math.min(1, _eyeFwd.y))) * 180) / Math.PI;
    const { yawDeg, pitchDeg } = eyeGazeAngles(
      eyeGazeTime,
      amount,
      seed,
      residualYawDeg,
      residualPitchDeg,
    );
    // Gaze rotation in the ROOT frame (+yaw = patient's left, +pitch = up),
    // converted into the shared eye-parent local frame:
    //   Wlocal = inv(parentW) · rootW · Wroot · inv(rootW) · parentW
    _eyeQa.setFromAxisAngle(_eyeAxisYaw, (yawDeg * Math.PI) / 180);
    _eyeQb.setFromAxisAngle(_eyeAxisPitch, (-pitchDeg * Math.PI) / 180);
    _eyeQa.multiply(_eyeQb); // Wroot
    eyeL.parent.getWorldQuaternion(_eyeQb); // parentW (shared: FacialBone)
    _eyeW
      .copy(_eyeQb)
      .invert()
      .multiply(_eyeQc)
      .multiply(_eyeQa)
      .multiply(_eyeQc.invert())
      .multiply(_eyeQb);
    _eyeBaseLQ.copy(eyeL.quaternion);
    _eyeBaseRQ.copy(eyeR.quaternion);
    eyeL.quaternion.premultiply(_eyeW);
    eyeR.quaternion.premultiply(_eyeW);
    eyeGazeOn = true;
    return true;
  }

  function undo(bones: BoneMap | null): boolean {
    if (!eyeGazeOn) return false;
    eyeGazeOn = false;
    const eyeL = bones?.get('L_Eye');
    if (eyeL) eyeL.quaternion.copy(_eyeBaseLQ);
    const eyeR = bones?.get('R_Eye');
    if (eyeR) eyeR.quaternion.copy(_eyeBaseRQ);
    return true;
  }

  function captureApplied(bones: BoneMap | null): (() => void) | null {
    if (!eyeGazeOn) return null;
    const eyeL = bones?.get('L_Eye');
    const eyeR = bones?.get('R_Eye');
    const qL = eyeL ? eyeL.quaternion.clone() : null;
    const qR = eyeR ? eyeR.quaternion.clone() : null;
    return () => {
      if (eyeL && qL) eyeL.quaternion.copy(qL);
      if (eyeR && qR) eyeR.quaternion.copy(qR);
      eyeGazeOn = true;
    };
  }

  function reset(): void {
    eyeGazeOn = false;
  }

  return { apply, undo, captureApplied, reset };
}
