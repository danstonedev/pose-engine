/**
 * IDLE liveliness overlay — extracted from ExamStage3D.
 *
 * While NOTHING drives the skeleton (between commands — the most-watched
 * moment), layer exertion-scaled FM breathing at the thorax, the residual lumbar
 * micro-sway + an in-phase weight-shift lean at the low back, the slow
 * weight-shift travel on the root X (via the caller's pelvis-shift bake, so it
 * composes with the antalgic shift), and the ANKLE-PIVOT sway share — a
 * whole-body roll/pitch about the ankle line (root rotation at floor level, feet
 * counter-rotated so the soles stay flat), the inverted-pendulum shape of real
 * quiet-stance sway.
 *
 * Applied as an undo/reapply sandwich: the EXACT pre-overlay bone/root quats are
 * stored on apply and restored on undo, so the deltas never accumulate, the
 * recording tap samples the clean pose, and any takeover starts untouched. Own
 * state only; the caller passes the current bones/root/breath + a pelvis-shift
 * bake callback each frame (the pelvis-shift state stays with the root owner).
 * Deterministic per seed.
 */
import * as THREE from 'three';
import { breathingLeanFM, idleSwaySplit, idleWeightShift } from './liveliness';
import type { BreathState } from './stageBreath';

type BoneMap = Map<string, THREE.Bone>;

export interface IdleOverlay {
  /** Bake the idle deltas for the current phase. Returns whether applied
   *  (amount 0 / clean mode applies NOTHING). Sets the idle weight-shift and
   *  invokes `bakePelvisShift` so the root X composes with the antalgic shift. */
  apply(
    dtSec: number,
    idleLiveliness: number,
    bones: BoneMap | null,
    modelRoot: THREE.Object3D | null,
    breath: BreathState,
    swayAxisAP: THREE.Vector3,
    swayAxisML: THREE.Vector3,
    bakePelvisShift: () => void,
  ): boolean;
  /** Exact-restore the baked trunk/root/feet quats + un-bake the idle shift. */
  undo(bones: BoneMap | null, modelRoot: THREE.Object3D | null, bakePelvisShift: () => void): boolean;
  /** Idle weight-shift root X offset currently requested, metres (read by the
   *  pelvis-shift bake so it composes with the antalgic shift). */
  readonly shiftM: number;
  /** True while the idle deltas are baked into the trunk bones / root. */
  readonly overlayOn: boolean;
  /** True while the ankle-pivot part is baked. */
  readonly pivotOn: boolean;
  /** Discard the bake flags + shift (call when the skeleton is replaced). */
  reset(): void;
}

export function createIdleOverlay(seed: number): IdleOverlay {
  let idleTime = 0;
  let idleShiftM = 0;
  let idleOverlayOn = false;
  let idlePivotOn = false;
  const _idleBaseThoraxQ = new THREE.Quaternion();
  const _idleBaseLumbarQ = new THREE.Quaternion();
  const _idleQ = new THREE.Quaternion();
  const _idleBaseRootQ = new THREE.Quaternion();
  const _idleBaseLFootQ = new THREE.Quaternion();
  const _idleBaseRFootQ = new THREE.Quaternion();
  const _idlePivotQ = new THREE.Quaternion();
  const _idlePivotInvQ = new THREE.Quaternion();
  const _idleParentQ = new THREE.Quaternion();

  function apply(
    dtSec: number,
    idleLiveliness: number,
    bones: BoneMap | null,
    modelRoot: THREE.Object3D | null,
    breath: BreathState,
    swayAxisAP: THREE.Vector3,
    swayAxisML: THREE.Vector3,
    bakePelvisShift: () => void,
  ): boolean {
    const amount = Number.isFinite(idleLiveliness) ? Math.max(0, Math.min(1, idleLiveliness)) : 0;
    if (amount <= 0 || !bones || !modelRoot) return false;
    const thorax = bones.get('Spine_Upper');
    const lowBack = bones.get('Spine_Lower');
    if (!thorax && !lowBack) return false;
    idleTime += dtSec;
    // Exertion-scaled breathing: integrate the SHARED phase accumulator
    // (phase-continuous with the motion-time overlay), rate/depth following
    // the decaying exertion level.
    breath.advancePhase(dtSec);
    const sway = idleSwaySplit(idleTime, amount);
    if (thorax) {
      _idleBaseThoraxQ.copy(thorax.quaternion);
      _idleQ.setFromAxisAngle(
        swayAxisAP,
        (breathingLeanFM(breath.phase, amount, breath.exertion) * Math.PI) / 180,
      );
      thorax.quaternion.premultiply(_idleQ);
    }
    if (lowBack) {
      _idleBaseLumbarQ.copy(lowBack.quaternion);
      const { shiftM, leanDeg } = idleWeightShift(idleTime, amount, seed);
      // Rig convention (pinned by the idleLiveliness rig gate): a POSITIVE
      // premultiplied Z-roll at Spine_Lower moves the head toward −X, so the
      // weight-shift lean (+ = the patient's left/+X) applies NEGATED to land
      // IN PHASE with the root travel.
      _idleQ.setFromAxisAngle(swayAxisML, ((sway.lumbarMlDeg - leanDeg) * Math.PI) / 180);
      lowBack.quaternion.premultiply(_idleQ);
      _idleQ.setFromAxisAngle(swayAxisAP, (sway.lumbarApDeg * Math.PI) / 180);
      lowBack.quaternion.premultiply(_idleQ);
      idleShiftM = shiftM;
      bakePelvisShift();
    }
    // ANKLE-PIVOT sway: rotate the WHOLE body about the ankle line by the pivot
    // share of the sway (root roll about the same world axes the trunk terms
    // use), so the pelvis and head genuinely translate; then counter-rotate each
    // foot by the conjugated inverse so its world ORIENTATION — the flat sole —
    // is untouched. The ankle joint angle therefore changes by the pivot angle.
    const lFoot = bones.get('L_Foot');
    const rFoot = bones.get('R_Foot');
    if (Math.abs(sway.ankleRollDeg) + Math.abs(sway.anklePitchDeg) > 1e-9) {
      _idleBaseRootQ.copy(modelRoot.quaternion);
      _idleQ.setFromAxisAngle(swayAxisML, (sway.ankleRollDeg * Math.PI) / 180);
      _idlePivotQ.copy(_idleQ);
      _idleQ.setFromAxisAngle(swayAxisAP, (sway.anklePitchDeg * Math.PI) / 180);
      _idlePivotQ.premultiply(_idleQ);
      modelRoot.quaternion.premultiply(_idlePivotQ);
      modelRoot.updateMatrixWorld(true);
      // Foot counter-rotation: to keep a foot's world orientation W fixed under
      // the root delta D, premultiply its LOCAL quat by P⁻¹·D⁻¹·P (P = its
      // parent's world quat — invariant to read order, since P′ = D·P conjugates
      // to the same result).
      _idlePivotInvQ.copy(_idlePivotQ).invert();
      for (const foot of [lFoot, rFoot]) {
        if (!foot?.parent) continue;
        (foot === lFoot ? _idleBaseLFootQ : _idleBaseRFootQ).copy(foot.quaternion);
        foot.parent.getWorldQuaternion(_idleParentQ);
        _idleQ.copy(_idleParentQ).invert();
        _idleQ.multiply(_idlePivotInvQ).multiply(_idleParentQ);
        foot.quaternion.premultiply(_idleQ);
      }
      idlePivotOn = true;
    }
    idleOverlayOn = true;
    modelRoot.updateMatrixWorld(true);
    return true;
  }

  function undo(
    bones: BoneMap | null,
    modelRoot: THREE.Object3D | null,
    bakePelvisShift: () => void,
  ): boolean {
    if (!idleOverlayOn) return false;
    idleOverlayOn = false;
    const thorax = bones?.get('Spine_Upper');
    if (thorax) thorax.quaternion.copy(_idleBaseThoraxQ);
    const lowBack = bones?.get('Spine_Lower');
    if (lowBack) lowBack.quaternion.copy(_idleBaseLumbarQ);
    // Ankle-pivot restore (exact): the root quat + both counter-rotated feet.
    if (idlePivotOn) {
      idlePivotOn = false;
      if (modelRoot) modelRoot.quaternion.copy(_idleBaseRootQ);
      const lFoot = bones?.get('L_Foot');
      if (lFoot?.parent) lFoot.quaternion.copy(_idleBaseLFootQ);
      const rFoot = bones?.get('R_Foot');
      if (rFoot?.parent) rFoot.quaternion.copy(_idleBaseRFootQ);
    }
    idleShiftM = 0;
    bakePelvisShift();
    modelRoot?.updateMatrixWorld(true);
    return true;
  }

  function reset(): void {
    idleOverlayOn = false;
    idlePivotOn = false;
    idleShiftM = 0;
  }

  return {
    apply,
    undo,
    reset,
    get shiftM() {
      return idleShiftM;
    },
    get overlayOn() {
      return idleOverlayOn;
    },
    get pivotOn() {
      return idlePivotOn;
    },
  };
}
