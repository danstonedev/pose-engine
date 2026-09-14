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
 * ── The IK path needs it too, and that was got wrong once ───────────────────
 *
 * The first version of this reasoned that `solveIKChain` already includes the
 * clavicle in the hand's chain, so CCD would distribute across it and imposing
 * a ratio would fight the solver. MEASURED, that is false. CCD walks from the
 * effector upward and greedily zeroes the error at each joint, so by the time
 * it reaches the clavicle — the last and most proximal link — there is nothing
 * left to correct. A hand dragged to head height moved the elbow 110 degrees
 * and the clavicle 3.7. The chain change made the girdle REACHABLE; it did not
 * make the solver use it.
 *
 * `solveArmChainWithRhythm` alternates the two: solve, split, then re-solve on
 * a DISTAL-ONLY chain that excludes the clavicle. Measured against the plain
 * solve, at head height the girdle goes 3.7 to 9.3 degrees and the hand lands
 * an order of magnitude closer to the target (0.035 to 0.003).
 *
 * The distal-only corrective pass is the load-bearing detail. Re-solving the
 * FULL chain lets CCD drive the clavicle again and undo what the split just
 * set: at a high reach that leaves the scapula pinned at -10 degrees of
 * ANTERIOR tilt — backwards for elevation, where posterior tilt belongs —
 * while the distal-only pass lands it at 0. So the original instinct was half
 * right: CCD does fight the rhythm. The answer is to keep it out of the pass
 * that corrects the target, not to skip the rhythm.
 */
import * as THREE from 'three';
import { girdleLocalQuat, girdleKeyForJoint, girdleSplit } from './movementCommand';
import { clampBoneToRom, inspectClinicalAngles, isRomClampActive } from './poseRomClamp';
import { solveIKChain, type IKChainContext } from './poseRig';
import type { JointAngleRestReference } from './jointAngles';

/** Below this the split contributes nothing worth writing — keeps small poses,
 *  and every pose inside the setting phase, byte-identical to before. */
const MIN_GIRDLE_DEG = 0.05;

/** Passes per CCD solve for an arm reach. Four passes leave the handoff's
 *  lower-back target ~20 cm short on the male rig; forty reduce that to ~2 cm
 *  without widening ROM. This budget is arm-only: gait/leg solvers keep their
 *  existing defaults. Callers can still set `clampOpts.iterations` explicitly. */
export const ARM_REACH_IK_ITERATIONS = 40;

/** Same options as the underlying CCD solver, including its iteration budget,
 *  patient constraints, and optional hinge restrictions. */
export type ArmReachSolveOptions = NonNullable<Parameters<typeof solveIKChain>[2]> & {
  /** Experimental retry from at most two nearby arm orientations. Opt-in until
   *  whole-arm contact/path checks accompany endpoint and joint-limit checks. */
  recoverStalledReach?: boolean;
};

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

/**
 * Solve an arm IK chain so the girdle carries its share of the elevation.
 *
 * `fullCtx` is the chain as configured (effector up to and including the
 * clavicle); `distalCtx` is the same effector one link shorter, stopping at the
 * humerus. Both are passed in rather than built here because callers cache them
 * per handle and building a chain per pointer event would be wasteful.
 *
 * Falls back to a plain solve — never a no-op — when the chain does not reach a
 * clavicle, so non-arm effectors and unexpected rigs behave exactly as before.
 *
 * `rest` comes from `clampOpts`, deliberately, rather than as its own argument.
 * The first version took both and a caller passed `rest` for the rhythm while
 * leaving `clampOpts` undefined — so the solve ran UNCLAMPED against a
 * different pose than the split was reading, and the girdle recruited 5.7
 * degrees instead of 9.3. One source for it makes that desync unrepresentable.
 */
export function solveArmChainWithRhythm(
  fullCtx: IKChainContext,
  distalCtx: IKChainContext | null,
  target: THREE.Vector3,
  clampOpts?: ArmReachSolveOptions,
  iterations = 3,
): void {
  const rest = clampOpts?.rest;

  const humerusIdx = fullCtx.canonicalKeys.findIndex((k) => !!k && !!girdleKeyForJoint(k));
  const humerus = humerusIdx >= 0 ? fullCtx.bones[humerusIdx] : null;
  const humerusKey = humerusIdx >= 0 ? fullCtx.canonicalKeys[humerusIdx] : null;
  const girdleKey = humerusKey ? girdleKeyForJoint(humerusKey) : null;
  const clavicleIdx = girdleKey ? fullCtx.canonicalKeys.indexOf(girdleKey) : -1;
  const clavicle = clavicleIdx >= 0 ? fullCtx.bones[clavicleIdx] : null;
  if (!humerus || !clavicle || !distalCtx || !rest) {
    solveIKChain(fullCtx, target, clampOpts);
    return;
  }

  // Raise only the budget for a supported, ROM-clamped arm chain. Keep the
  // caller's constraints/hinge settings and honor an explicit budget (including
  // the historic four passes used for comparisons).
  const reachOpts: ArmReachSolveOptions = {
    ...clampOpts,
    rest,
    iterations: clampOpts?.iterations ?? ARM_REACH_IK_ITERATIONS,
  };
  const recover = clampOpts?.recoverStalledReach === true && isRomClampActive();
  const original = recover ? fullCtx.bones.map(bone => bone.quaternion.clone()) : null;
  const solve = () => {
    solveIKChain(fullCtx, target, reachOpts);

    for (let i = 0; i < iterations; i += 1) {
      if (!applyScapulohumeralRhythm(humerus, clavicle, humerusKey, rest)) break;
      // Refresh descendants after the rhythm's upward-only world update.
      humerus.updateMatrixWorld(true);
      // Keep the corrective solve below the girdle so CCD cannot undo its share.
      solveIKChain(distalCtx, target, reachOpts);
    }
  };
  solve();
  if (!recover || !original) return;

  const effector = fullCtx.bones[0];
  const position = new THREE.Vector3();
  const error = () => effector.getWorldPosition(position).distanceTo(target);
  let bestError = error();
  // Warm starts already close to their target retain the original path. This
  // also avoids paying for retries on ordinary small pointer movements.
  if (!Number.isFinite(bestError) || bestError < 0.02) return;
  const best = fullCtx.bones.map(bone => bone.quaternion.clone());
  const restore = (quats: THREE.Quaternion[]) => {
    fullCtx.bones.forEach((bone, i) => bone.quaternion.copy(quats[i]));
    clavicle.updateMatrixWorld(true);
  };

  // CCD can settle on the wrong side of a constrained configuration. Starting
  // from arms-down, the female cross-body probe stalls ~50 cm short forever;
  // a modest upper-arm bend lets the SAME solver settle within 1 mm. Local-X
  // perturbations follow the rig when the body turns. These are search seeds,
  // never directly accepted poses: clamp and re-solve each one first.
  for (const degrees of [30, 60]) {
    restore(original);
    humerus.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), degrees * Math.PI / 180,
    ));
    clampBoneToRom(humerus, humerusKey, rest, reachOpts.constraints);
    humerus.updateMatrixWorld(true);
    solve();
    // Settle the coupled girdle/arm solution before comparing candidates.
    // A small endpoint residual alone can hide a large next-call rotation.
    for (let settle = 0; settle < 3; settle += 1) solve();
    const candidateError = error();
    // Require a meaningful improvement so numerical noise cannot switch the
    // selected branch. Reject a closer wrist if any moved joint exceeds ROM.
    if (candidateError < bestError - 0.001 && armChainInRange(fullCtx, reachOpts)) {
      bestError = candidateError;
      fullCtx.bones.forEach((bone, i) => best[i].copy(bone.quaternion));
      if (bestError < 0.001) break;
    }
  }
  restore(best);
}

function armChainInRange(ctx: IKChainContext, options: ArmReachSolveOptions): boolean {
  for (let i = 1; i < ctx.bones.length; i += 1) {
    const report = inspectClinicalAngles(ctx.bones[i], ctx.canonicalKeys[i], options.rest, options.constraints);
    if (!report) return false;
    for (const axis of ['flexion', 'abduction', 'rotation'] as const) {
      const value = axis === 'flexion' ? report.anatomicFlexion : report.raw[axis];
      const range = report.ranges[axis];
      if (!Number.isFinite(value) || (range && (value < range.min - 0.5 || value > range.max + 0.5))) return false;
    }
  }
  return true;
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
