/**
 * ROM clamp for the REGION-CURVE spine controls — Spine_Upper (thoracic) and
 * Neck (cervical).
 *
 * These two are not single bones. The registry row and the readout describe a
 * REGION, and the readout reports the regional total as the SUM of the two
 * segments the region spans (`Spine_Mid + Spine_Upper`, `Neck_Lower + Neck`).
 * A drag hands the control bone a target, `distributeChainCurve` spreads it
 * across both, and what the ROM panel then shows is that sum.
 *
 * `clampBoneToRom` bounds the CONTROL BONE's own orientation, before the
 * spread. Those are different quantities, and the difference is not small.
 * Rig-measured, driving each control 120° past its range:
 *
 *     joint         driven   landed   registry range
 *     Spine_Lower   ±120     60.0 / −25.0    −25..60   ← single bone, exact
 *     Spine_Upper   ±120     43.8 / −20.5    −25..40   ← 3.8° over
 *     Neck          ±120     59.7 / −39.9    −60..50   ← 9.7° over
 *
 * So the cervical spine reached 59.7° against a stated 50° limit — the panel
 * quoting a range the joint had just been driven through. `Spine_Lower` is
 * exact precisely because it is a single bone and no distribution happens.
 *
 * The fix is the same shape as the finger-curl clamp: measure what the readout
 * will actually report, and scale the control's delta-from-rest until it lands
 * on the bound. Reading the truth back is the only thing that stays correct
 * when the relationship between the control and the sum is not identity —
 * and it is not, because body-frame Euler angles do not add linearly.
 */
import * as THREE from 'three';
import {
  decomposeBodyDelta,
  deltaFromRest,
  type JointAngleRestReference,
} from './jointAngles';
import { getEffectiveRomRange, type RomScenarioConstraints } from './romConstraints';
import { distributeChainCurve } from './poseRig';

/** The region controls, and the segments each spans — mirroring the readout's
 *  own region table (`addRegion` in jointAngles). */
export const REGION_CURVE_CHAINS: Readonly<
  Record<string, { readonly keys: readonly string[]; readonly control: number }>
> = {
  Spine_Upper: { keys: ['Spine_Mid', 'Spine_Upper'], control: 1 },
  Neck: { keys: ['Neck_Lower', 'Neck'], control: 1 },
};

/** The three planes a region row carries, and how the readout signs each from
 *  the per-segment body-euler decomposition (jointAngles' spine/neck loop). */
const REGION_FIELDS = [
  { field: 'flexion', read: (a: { flexion: number }) => -a.flexion },
  { field: 'lateralTilt', read: (a: { abduction: number }) => -a.abduction },
  { field: 'rotation', read: (a: { rotation: number }) => -a.rotation },
] as const;

const _delta = new THREE.Quaternion();
const _share = new THREE.Quaternion();
const _restInv = new THREE.Quaternion();
const _target = new THREE.Quaternion();
const _seg = new THREE.Quaternion();

/** Passes of measure-and-rescale. One lands a single out-of-range field; the
 *  second settles the interaction when two planes are out at once. */
const PASSES = 2;
/** Below this there is no excursion to scale along and the ratio blows up. */
const MIN_MEASURABLE_DEG = 1e-3;

/** The regional total the READOUT will report for `field`, summed over the
 *  region's segments exactly as `computeJointAngles` does. */
export function measureRegionCurve(
  segments: readonly THREE.Object3D[],
  keys: readonly string[],
  rest: JointAngleRestReference,
  field: 'flexion' | 'lateralTilt' | 'rotation',
): number {
  const spec = REGION_FIELDS.find((f) => f.field === field)!;
  let total = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const restArr = rest.localQuats[keys[i]];
    if (!restArr) continue;
    deltaFromRest((segments[i] as THREE.Bone).quaternion, restArr, _seg);
    total += spec.read(decomposeBodyDelta(_seg));
  }
  return total;
}

export interface RegionCurveClampOptions {
  constraints?: RomScenarioConstraints | null;
}

/**
 * Distribute a region control's target across its chain and bound the REGIONAL
 * TOTAL — the number the ROM panel shows — rather than the control bone.
 *
 * Writes the segments in place. Returns true if the target was scaled back.
 */
export function clampRegionCurveToRom(
  canonicalKey: string,
  segments: THREE.Object3D[],
  restLocals: THREE.Quaternion[],
  controlIndex: number,
  controlTarget: THREE.Quaternion,
  rest: JointAngleRestReference | null | undefined,
  options: RegionCurveClampOptions = {},
): boolean {
  const chain = REGION_CURVE_CHAINS[canonicalKey];
  if (!chain || !rest || segments.length !== chain.keys.length) return false;

  distributeChainCurve(segments, restLocals, controlIndex, controlTarget);

  _delta.copy(_restInv.copy(restLocals[controlIndex]).invert()).multiply(controlTarget);
  let scaled = false;
  for (let pass = 0; pass < PASSES; pass += 1) {
    // The tightest scale any out-of-range plane demands. Scaling the control's
    // delta scales every plane together, so the binding one wins.
    let t = 1;
    for (const { field } of REGION_FIELDS) {
      const range = getEffectiveRomRange(options.constraints ?? null, canonicalKey, field);
      if (!range) continue;
      const measured = measureRegionCurve(segments, chain.keys, rest, field);
      if (measured >= range.min && measured <= range.max) continue;
      if (Math.abs(measured) < MIN_MEASURABLE_DEG) continue;
      const bound = measured < range.min ? range.min : range.max;
      if (Math.sign(bound) !== Math.sign(measured)) {
        t = 0;
        break;
      }
      t = Math.min(t, bound / measured);
    }
    if (t >= 1) break;
    _share.identity().slerp(_delta, Math.max(0, t));
    distributeChainCurve(
      segments,
      restLocals,
      controlIndex,
      _target.copy(restLocals[controlIndex]).multiply(_share),
    );
    _delta.copy(_share);
    scaled = true;
  }
  return scaled;
}
