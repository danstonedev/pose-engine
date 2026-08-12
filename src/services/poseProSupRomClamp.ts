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
import {
  readAxialTwist,
  readBodyEulerTwist,
  setAxialTwist,
  setBodyEulerTwist,
} from './poseRig';
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

/** The PAIR's limit — the ±90 the registry publishes, which is what the readout
 *  sums the two segments into. */
export const PROSUP_TOTAL_LIMIT_RAD = 2 * PROSUP_SEG_LIMIT_RAD;

/**
 * What a pro/sup ring drag needs to know from the moment it was GRABBED.
 *
 * Without it the writer has to read the desired split out of the grabbed bone
 * alone, which is only correct while the pair is already even. It is not always
 * even: a loaded pose, an IK solve, or a clamp can leave the forearm and hand
 * holding different shares of the same total. Then the first frame of the drag
 * rewrites BOTH segments to the grabbed one's share — so a pair sitting at 10 +
 * 40 = 50 became 10 + 10 = 20 the instant the ring was touched, a 30° jump
 * before the cursor moved.
 *
 * Capturing the pair's total at grab time makes the drag a DELTA on that total
 * instead of an absolute read of one segment, so a grab with no movement is a
 * no-op no matter how the split was distributed.
 */
export interface ProSupDragSession {
  /** The grabbed bone's twist when the ring was grabbed, in that bone's own
   *  readout frame. The drag angle is measured against this. */
  readonly startTwistSelRad: number;
  /** Forearm + hand twist when the ring was grabbed — the quantity the panel
   *  reports as pro/sup, and the one the drag moves. */
  readonly startTotalRad: number;
}

export interface CoupledProSupOptions {
  constraints?: RomScenarioConstraints | null;
  /**
   * The session from {@link beginCoupledProSup}, captured at pointer-down.
   *
   * Omitted, the writer falls back to reading the split out of the grabbed bone
   * — the pre-session behaviour, which is identical whenever the pair is even
   * and jumps when it is not.
   */
  session?: ProSupDragSession | null;
}

const _restSel = new THREE.Quaternion();
const _restSib = new THREE.Quaternion();

/**
 * Read/write a segment's share of the twist in the frame that segment is
 * MEASURED in — because the two are not measured the same way.
 *
 * `computeJointAngles` reads `forearmRotation` off a long-axis swing-twist
 * (`ballJointAngles`) and the wrist off a body-frame YXZ Euler
 * (`decomposeBodyDelta`). Those decompositions disagree whenever the joint
 * carries swing: holding a swing-twist's swing fixed while changing its twist
 * moves the Euler x and z components, and the wrist reports flexion off z and
 * deviation off x.
 *
 * So driving the hand's half with `setAxialTwist` published wrist motion the
 * user never made — up to ~30° of deviation on a flexed, deviated wrist, from a
 * drag on the pro/sup ring alone. Each segment now uses its own frame, and the
 * two agree exactly at zero swing, which is where the 1:1 split is defined.
 */
const readSegTwist = (
  isHand: boolean,
  local: THREE.Quaternion,
  restLocal: THREE.Quaternion,
): number => (isHand ? readBodyEulerTwist(local, restLocal) : readAxialTwist(local, restLocal));

const writeSegTwist = (
  isHand: boolean,
  bone: THREE.Object3D,
  restLocal: THREE.Quaternion,
  angleRad: number,
): void => {
  if (isHand) setBodyEulerTwist(bone, restLocal, angleRad);
  else setAxialTwist(bone, restLocal, angleRad);
};

/**
 * Capture the pair's state at pointer-down, for {@link CoupledProSupOptions}.
 *
 * Call it from the same branch that begins a ring drag, BEFORE anything writes
 * to either bone. Returns null for keys this writer does not handle, so it can
 * be called unconditionally and stored as-is.
 */
export function beginCoupledProSup(
  canonicalKey: string | null | undefined,
  boneByKey: Map<string, THREE.Bone> | null | undefined,
  rest: JointAngleRestReference | null | undefined,
): ProSupDragSession | null {
  if (!canonicalKey || !PROSUP_KEYS.has(canonicalKey) || !boneByKey || !rest) return null;
  const side = canonicalKey.startsWith('L_') ? 'L_' : 'R_';
  const forearm = boneByKey.get(`${side}Forearm`);
  const hand = boneByKey.get(`${side}Hand`);
  const rfArr = rest.localQuats[`${side}Forearm`];
  const rhArr = rest.localQuats[`${side}Hand`];
  if (!forearm || !hand || !rfArr || !rhArr) return null;
  _restSel.set(rfArr[0], rfArr[1], rfArr[2], rfArr[3]);
  _restSib.set(rhArr[0], rhArr[1], rhArr[2], rhArr[3]);
  const fTwist = readSegTwist(false, forearm.quaternion, _restSel);
  const hTwist = readSegTwist(true, hand.quaternion, _restSib);
  return {
    startTwistSelRad: canonicalKey.endsWith('Forearm') ? fTwist : hTwist,
    startTotalRad: fTwist + hTwist,
  };
}

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

  const targetTwist = readSegTwist(!selIsForearm, target, _restSel);
  const session = options.session ?? null;
  let twist: number;
  if (session) {
    // The ring moved by `d`; the PAIR moves by 2d, because both segments take
    // the drag and the readout sums them. That doubling is the existing gain —
    // it is what lets a ±45 ring reach the published ±90 — so seeding from the
    // total preserves it exactly for an even pair and only changes the uneven
    // case, which is the one that jumped.
    const d = targetTwist - session.startTwistSelRad;
    const total = Math.max(
      -PROSUP_TOTAL_LIMIT_RAD,
      Math.min(PROSUP_TOTAL_LIMIT_RAD, session.startTotalRad + 2 * d),
    );
    twist = total / 2;
  } else {
    twist = Math.max(-PROSUP_SEG_LIMIT_RAD, Math.min(PROSUP_SEG_LIMIT_RAD, targetTwist));
  }

  // The grabbed bone takes the full target first and is ROM-clamped, so the
  // drag's SWING (elbow flexion, wrist flex/dev) is bounded normally. Only then
  // is its twist overwritten with the shared half — clamping after would let the
  // hinge's ±45 long-axis play fight the split it is not meant to govern.
  sel.quaternion.copy(target);
  clampBoneToRom(sel, canonicalKey, rest, options.constraints ?? null);
  writeSegTwist(!selIsForearm, sel, _restSel, twist);
  writeSegTwist(selIsForearm, sib, _restSib, twist);
  return true;
}
