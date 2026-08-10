/**
 * ROM clamp for the DIGITS — the one group `poseRomClamp` cannot serve.
 *
 * Every strategy in `poseRomClamp.ts` decomposes a SINGLE bone's quaternion.
 * A digit's one clinical quantity, `fingerFlexion`, is the signed sum of the
 * MCP and PIP angles in the curl plane, measured across two bones in world
 * space (`measureFingerFlexion`). No single-bone decomposition can express it,
 * so `clampBoneToRom` returns false for all ten digit keys — correctly, and
 * for years that read as "nothing to do" at every call site: all ten had a ROM
 * row (curl 0–160, thumb 0–85), a live readout, a ring gizmo, and nothing at
 * all bounding them.
 *
 * ── The math ────────────────────────────────────────────────────────────────
 *
 * A curl drag hands `distributeChainCurve` a control target for the MCP. That
 * slerps the control's delta-from-rest by 1/N and writes `rest_i × share` to
 * every phalanx, so the composite is linear in the delta's angle. Rather than
 * restate the constant of proportionality here — it is 2/3, because two of the
 * three segments are the two the readout sums, but that is a fact about two
 * OTHER functions and it would go stale in silence — scale the delta by
 * `bound / measured` and re-distribute. One pass is exact for the pure
 * curl-axis delta the ring produces; the second absorbs whatever a compound
 * delta leaves behind. Either way the truth comes from the readout.
 *
 * ── What a drag can actually reach ──────────────────────────────────────────
 *
 * A ring delta is a quaternion, so it tops out at 180° along the shortest path,
 * and the 1/N slerp plus a two-of-three readout saturates the composite near
 * ±120°. A single drag therefore cannot push a FINGER past its 160 ceiling: the
 * leak on this path is the FLOOR — a fingertip driven to the back of the hand —
 * and the thumb's 85, which sits inside the reachable band. The clamp holds
 * both, and holds a scenario-tightened ceiling too.
 *
 * Lives in its own module rather than in `poseRomClamp.ts` because it needs
 * `distributeChainCurve`, and `poseRig` already imports `poseRomClamp` — the
 * import would close a cycle. `romEnforcementFor` names this file as the other
 * half of ROM enforcement so the split is discoverable from one place.
 */
import * as THREE from 'three';
import { isFingerJointKey, measureFingerFlexion, type JointAngleRestReference } from './jointAngles';
import { getEffectiveRomRange, type RomScenarioConstraints } from './romConstraints';
import { distributeChainCurve } from './poseRig';

/** A digit's MCP→PIP→DIP bones with the rest local of each — the shape both
 *  hosts already build to drive `distributeChainCurve` on a curl drag. */
export interface FingerCurlChain {
  bones: THREE.Object3D[];
  rest: THREE.Quaternion[];
}

export interface FingerCurlClampOptions {
  /** Per-patient ROM overrides, intersected with the normative registry. */
  constraints?: RomScenarioConstraints | null;
  /** Refresh world matrices so the composite can be measured. Required: the
   *  measurement reads world positions and quaternions off the bones, and each
   *  host owns a different root to walk from. */
  updateWorldMatrices: () => void;
}

// Scratch (reused across calls; never recursive).
const _delta = new THREE.Quaternion();
const _share = new THREE.Quaternion();
const _target = new THREE.Quaternion();
const _restInv = new THREE.Quaternion();

/** Passes of measure-and-rescale. One is exact for a pure curl-axis delta; the
 *  second absorbs a compound one. */
const PASSES = 2;

/** Below this the delta has no curl to scale along, and `bound / measured`
 *  blows up. Bail rather than fabricate a direction. */
const MIN_MEASURABLE_DEG = 1e-3;

/** Ceiling on the rescale factor. The normative case only ever REDUCES (< 1);
 *  the headroom keeps the slerp well-conditioned when a scenario constraint
 *  raises the floor above zero (a flexion contracture) and a pass has to
 *  extrapolate up to it. */
const MAX_RESCALE = 4;

/**
 * Clamp a digit's composite curl into its effective ROM, rewriting the chain
 * in place. Call it immediately after `distributeChainCurve` has applied the
 * drag. Returns true if the chain was rewritten.
 *
 * Safe to call for any key — it no-ops for anything that is not a digit.
 */
export function clampFingerCurlToRom(
  canonicalKey: string | null | undefined,
  chain: FingerCurlChain,
  controlTarget: THREE.Quaternion,
  boneByKey: Map<string, THREE.Bone>,
  rest: JointAngleRestReference | null | undefined,
  options: FingerCurlClampOptions,
): boolean {
  if (!canonicalKey || !isFingerJointKey(canonicalKey) || !rest) return false;
  if (!chain.bones.length || chain.bones.length !== chain.rest.length) return false;
  const range = getEffectiveRomRange(options.constraints ?? null, canonicalKey, 'fingerFlexion');
  if (!range) return false;

  _delta.copy(_restInv.copy(chain.rest[0]).invert()).multiply(controlTarget);
  let rewrote = false;
  for (let pass = 0; pass < PASSES; pass += 1) {
    options.updateWorldMatrices();
    const measured = measureFingerFlexion(boneByKey, canonicalKey, rest);
    if (measured == null) return rewrote;
    if (measured >= range.min && measured <= range.max) return rewrote;
    if (Math.abs(measured) < MIN_MEASURABLE_DEG) return rewrote;
    const bound = measured < range.min ? range.min : range.max;
    // Sign disagreement means the bound lies the other way round from where the
    // digit currently is — go to rest, and let the next pass climb toward it.
    const ratio = Math.sign(bound) === Math.sign(measured) ? bound / measured : 0;
    const t = Math.max(0, Math.min(MAX_RESCALE, ratio));
    _share.identity().slerp(_delta, t);
    distributeChainCurve(chain.bones, chain.rest, 0, _target.copy(chain.rest[0]).multiply(_share));
    _delta.copy(_share); // the next pass scales the ALREADY-scaled delta
    rewrote = true;
  }
  options.updateWorldMatrices();
  return rewrote;
}
