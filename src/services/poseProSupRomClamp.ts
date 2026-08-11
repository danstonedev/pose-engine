/**
 * COUPLED PRONATION / SUPINATION for the interactive pose path.
 *
 * Forearm rotation is not a joint rotation — it is the radius crossing over the
 * ulna along the whole forearm, and the hand goes with it. So the ROM registry
 * publishes ±90 in two places (`L_/R_Forearm.forearmRotation` and the wrists'
 * `proSup`) and `computeJointAngles` reports ONE quantity into both rows,
 * summing the forearm's axial twist and the hand's.
 *
 * A gizmo that writes only the bone the user grabbed therefore cannot reach the
 * published range. Worse, it cannot even get halfway honestly: the forearm's
 * clamp strategy is a HINGE, whose `rotationRange` is ±45 of long-axis PLAY
 * around elbow flexion — not a pro/sup range at all. Writing pro/sup onto the
 * forearm alone runs it straight into that play limit and stops at 45 against a
 * panel quoting −90..90.
 *
 * Splitting the twist 1:1 across both segments is what reaches ±90, and it is
 * also what the motion actually looks like: half the rotation at the elbow, half
 * carried on to the wrist, rather than one segment wringing against the other.
 *
 * Extracted from `stagePosingLayer`, where it had lived since the feature was
 * written, because the other host's copy of that layer never had it — a Y-ring
 * drag there fell through to the generic single-bone branch, and four ROM rows
 * were capped at half their published range on every model.
 */
import * as THREE from 'three';
import { readAxialTwist, setAxialTwist } from './poseRig';
import { clampBoneToRom } from './poseRomClamp';
import type { JointAngleRestReference } from './jointAngles';
import type { RomScenarioConstraints } from './romConstraints';

/** The four keys a coupled pro/sup drag can be initiated from. */
export const PROSUP_KEYS: ReadonlySet<string> = new Set([
  'L_Forearm',
  'R_Forearm',
  'L_Hand',
  'R_Hand',
]);

/**
 * Per-segment twist limit, radians. Half of the registry's ±90 pro/sup range,
 * because the two segments each carry half and the readout sums them.
 */
export const PROSUP_SEG_LIMIT_RAD = (45 * Math.PI) / 180;

export interface CoupledProSupOptions {
  constraints?: RomScenarioConstraints | null;
}

const _restSel = new THREE.Quaternion();
const _restSib = new THREE.Quaternion();

/**
 * Apply a pro/sup ring drag to BOTH forearm and hand.
 *
 * `target` is the local quaternion the gizmo produced for the grabbed bone;
 * only its axial component is used. Returns false — writing nothing — for any
 * key that is not a forearm or hand, so a caller can use it as the guard in a
 * drag branch chain.
 *
 * Call this ONLY for a twist-axis (Y-ring) drag. On the other two rings the
 * grabbed bone's own swing is what the user asked for, and this would discard
 * it.
 */
export function applyCoupledProSup(
  canonicalKey: string | null | undefined,
  target: THREE.Quaternion,
  boneByKey: Map<string, THREE.Bone> | null | undefined,
  rest: JointAngleRestReference | null | undefined,
  options: CoupledProSupOptions = {},
): boolean {
  if (!canonicalKey || !PROSUP_KEYS.has(canonicalKey) || !boneByKey || !rest) return false;
  const side = canonicalKey.startsWith('L_') ? 'L_' : 'R_';
  const forearm = boneByKey.get(`${side}Forearm`);
  const hand = boneByKey.get(`${side}Hand`);
  const rfArr = rest.localQuats[`${side}Forearm`];
  const rhArr = rest.localQuats[`${side}Hand`];
  if (!forearm || !hand || !rfArr || !rhArr) return false;

  const selIsForearm = canonicalKey.endsWith('Forearm');
  const sel = selIsForearm ? forearm : hand;
  const sib = selIsForearm ? hand : forearm;
  const selArr = selIsForearm ? rfArr : rhArr;
  const sibArr = selIsForearm ? rhArr : rfArr;
  _restSel.set(selArr[0], selArr[1], selArr[2], selArr[3]);
  _restSib.set(sibArr[0], sibArr[1], sibArr[2], sibArr[3]);

  const twist = Math.max(
    -PROSUP_SEG_LIMIT_RAD,
    Math.min(PROSUP_SEG_LIMIT_RAD, readAxialTwist(target, _restSel)),
  );

  // The grabbed bone takes the full target first and is ROM-clamped, so the
  // drag's SWING (elbow flexion, wrist flex/dev) is bounded normally. Only then
  // is its twist overwritten with the shared half — clamping after would let the
  // hinge's ±45 long-axis play fight the split it is not meant to govern.
  sel.quaternion.copy(target);
  clampBoneToRom(sel, canonicalKey, rest, options.constraints ?? null);
  setAxialTwist(sel, _restSel, twist);
  setAxialTwist(sib, _restSib, twist);
  return true;
}
