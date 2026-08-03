/**
 * Scapulohumeral rhythm for the INTERACTIVE pose path.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The registry's shoulder range is HUMEROTHORACIC — one clinical value across
 * two joints — and the humerus readout genuinely measures it, because it is
 * world-anchored and the humerus is a child of the clavicle. So the range is
 * the right clinical number and `clampBoneToRom` bounds the right quantity.
 *
 * What was missing is the SPLIT. `movementCommand` divides a commanded
 * elevation across the two joints that produce it (`girdleSplit` / `writeGirdle`),
 * capping the glenohumeral share and spilling the surplus to the girdle. The
 * pose path had one bound, on the composite, and nothing watching the share —
 * so pinning the scapula at rest and rotating the humerus alone reached 166
 * degrees of PURE glenohumeral flexion, unclamped, at a joint with about 120.
 *
 * ── How this works, and why it cannot re-introduce the axial-twist bug ──────
 *
 * The authored path had to solve a subtle problem: the humerus is a CHILD of
 * the clavicle, so rotating the clavicle carries the humerus's axial frame with
 * it. Handing the humerus the reduced glenohumeral share and letting the
 * clavicle add the rest reads back correct flexion and abduction while wringing
 * the arm — rig-measured, apparent axial rotation went 0 degrees to 104 degrees
 * at 180 flexion. `unparentGirdle` fixes it algebraically:
 *
 *     delta = W-inverse . C-inverse . W . full
 *
 * i.e. the humerus must land on the SAME WORLD ORIENTATION it would have
 * reached without the split.
 *
 * The pose path gets that for free, because it runs in the opposite direction.
 * The user has already dragged the humerus to a world orientation; this holds
 * that orientation FIXED, rotates the clavicle underneath it, and re-derives
 * the humerus's local quaternion from the new parent world. The humerothoracic
 * readout is therefore unchanged by construction — the same identity, obtained
 * by never letting the world orientation move rather than by correcting for it
 * afterwards. What changes is the glenohumeral share, which drops by exactly
 * the girdle's contribution. That is the whole point.
 *
 * ── Deliberately NOT applied to the IK path ─────────────────────────────────
 *
 * `solveIKChain` already includes the clavicle in the hand's chain, and CCD
 * distributes rotation across it on its own. Imposing a fixed ratio inside the
 * solver's loop would fight it, so a hand drag is left to the solver. See
 * `poseScapulohumeral.test.ts` for what a hand drag actually produces.
 */
import * as THREE from 'three';
import { girdleLocalQuat, girdleKeyForJoint, girdleSplit } from './movementCommand';
import { inspectClinicalAngles } from './poseRomClamp';
import type { JointAngleRestReference } from './jointAngles';

/** Below this the split contributes nothing worth writing — keeps small poses,
 *  and every pose inside the setting phase, byte-identical to before. */
const MIN_GIRDLE_DEG = 0.05;

const _humerusWorld = new THREE.Quaternion();
const _parentWorld = new THREE.Quaternion();

export interface ScapulohumeralResult {
  /** Degrees of scapular posterior tilt written (the sagittal share). */
  scapularTilt: number;
  /** Degrees of scapular upward rotation written (the frontal share). */
  upRotation: number;
}

/**
 * Split the humerothoracic elevation a posed humerus is currently showing
 * across the glenohumeral joint and the shoulder girdle, writing the scapular
 * share onto the clavicle and re-anchoring the humerus so the composite angle
 * is unchanged.
 *
 * Returns null when nothing was written — the joint is not an upper arm, the
 * clavicle is unmapped on this rig, the rest reference is missing, or the
 * elevation is inside the setting phase where the scapula genuinely does not
 * contribute. Returning null rather than throwing keeps this safe to call
 * unconditionally from a drag handler.
 *
 * IDEMPOTENT. The scapular value is composed absolutely from the clavicle's
 * anatomic rest, not accumulated, and the humerus is re-anchored to a world
 * orientation this function never moves — so calling it twice on the same pose
 * writes the same two quaternions. A drag handler firing it per pointer event
 * is therefore stable rather than compounding.
 */
export function applyScapulohumeralRhythm(
  humerus: THREE.Bone,
  clavicle: THREE.Bone | null | undefined,
  canonicalKey: string | null | undefined,
  rest: JointAngleRestReference | null | undefined,
): ScapulohumeralResult | null {
  if (!humerus || !clavicle || !canonicalKey || !rest) return null;
  const girdleKey = girdleKeyForJoint(canonicalKey);
  if (!girdleKey) return null;
  const restLocalArr = rest.localQuats[girdleKey];
  if (!restLocalArr) return null;

  // The re-anchor below only cancels the girdle rotation if the clavicle is
  // actually ABOVE the humerus in the hierarchy. On a rig where it is not,
  // writing the scapular share would rotate the girdle without reducing the
  // glenohumeral angle at all — visible motion, no correction, and nothing to
  // say so. Checked before anything is written so the refusal is clean.
  if (!humerus.parent || !isAncestorOf(clavicle, humerus)) return null;

  // Read the composite the user has posed. This is humerothoracic: the readout
  // is world-anchored, so it already includes whatever the clavicle currently
  // contributes, which is what makes repeated calls converge instead of drift.
  const report = inspectClinicalAngles(humerus, canonicalKey, rest);
  if (!report) return null;

  const scapularTilt = girdleSplit(report.anatomicFlexion, 'flexion').girdle;
  const upRotation = girdleSplit(report.raw.abduction, 'abduction').girdle;
  if (Math.abs(scapularTilt) < MIN_GIRDLE_DEG && Math.abs(upRotation) < MIN_GIRDLE_DEG) {
    return null;
  }

  // Hold the humerus's WORLD orientation across the whole operation.
  humerus.updateWorldMatrix(true, false);
  humerus.getWorldQuaternion(_humerusWorld);

  const restLocal = new THREE.Quaternion(
    restLocalArr[0],
    restLocalArr[1],
    restLocalArr[2],
    restLocalArr[3],
  );
  const nextClavicle = girdleLocalQuat(
    girdleKey,
    [
      { motion: 'scapularTilt', degrees: scapularTilt },
      { motion: 'upRotation', degrees: upRotation },
    ],
    restLocal,
    clavicle.quaternion.clone(),
  );
  if (!nextClavicle) return null;

  clavicle.quaternion.copy(nextClavicle);
  clavicle.updateWorldMatrix(true, false);

  // Re-derive the humerus local from the clavicle's NEW world orientation, so
  // the arm stays exactly where the user put it and only the share moves.
  const parent = humerus.parent!;
  parent.updateWorldMatrix(true, false);
  parent.getWorldQuaternion(_parentWorld);
  humerus.quaternion.copy(_parentWorld.invert().multiply(_humerusWorld));

  // Descendants (forearm, hand) are NOT refreshed here — `updateWorldMatrix`
  // walks up, not down. Callers that read world positions below the humerus
  // afterwards must update the subtree themselves, which the drag paths
  // already do.
  humerus.updateWorldMatrix(true, false);

  return { scapularTilt, upRotation };
}

/** Whether `maybeAncestor` sits above `node` in the scene graph. */
function isAncestorOf(maybeAncestor: THREE.Object3D, node: THREE.Object3D): boolean {
  let cursor: THREE.Object3D | null = node.parent;
  while (cursor) {
    if (cursor === maybeAncestor) return true;
    cursor = cursor.parent;
  }
  return false;
}
