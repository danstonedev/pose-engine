import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import { buildBoneByPoseKey } from './poseRig';
import { signedAngleAboutAxis } from './jointAngles';

/**
 * Distributes a limb segment's axial twist across the rig's dedicated twist bones
 * (e.g. CC's ForearmTwist01/02) so the mesh twists gradually along the segment
 * instead of "candy-wrappering" at the proximal joint. Purely cosmetic — it only
 * writes the twist bones, never the measured segment/child bones, so clinical
 * readouts are unaffected.
 *
 * Model: the segment carries full twist (θ) at its base; each twist bone is set so
 * its cumulative WORLD twist hits a target fraction of θ, grading 0 → θ from the
 * proximal joint outward. The distal child (Hand/Foot/Forearm) continues at θ.
 */

// Limb segments whose axial twist is spread across twist bones. `distal` names a
// distal child whose own axial twist is part of the SAME functional rotation and
// so adds to the total the segment grades toward — e.g. forearm pro/sup is shared
// between the forearm and the hand, so wrist-driven pro/sup must also distribute
// along the forearm (not pinch at the wrist). Humeral/hip/tibial rotation have no
// such shared distal twist.
const TWIST_SEGMENTS: { key: string; distal?: string }[] = [
  { key: 'UpperArm' },
  { key: 'Forearm', distal: 'Hand' },
  { key: 'UpLeg' },
  { key: 'Leg' },
];
// Cumulative world-twist fraction at each twist bone (Twist01 at the base, Twist02
// mid-segment). The segment base carries full twist; grading from 0 spreads the
// proximal joint; the distal end reaches the total twist.
const TWIST_FRACTIONS = [0, 0.5];
// Bone-local long axis: every child sits at +Y, so the segment twists about +Y.
const LONG_AXIS = new THREE.Vector3(0, 1, 0);

export interface TwistSegment {
  segment: THREE.Object3D;
  restSegmentLocal: THREE.Quaternion;
  chain: THREE.Object3D[];
  restChainLocals: THREE.Quaternion[];
  /** Optional distal child whose axial twist adds to the total (e.g. the hand for
   *  the forearm), so wrist-driven pro/sup spreads along the forearm too. */
  distal?: THREE.Object3D;
  restDistalLocal?: THREE.Quaternion;
}

/** Follow the twist-bone sub-chain under a segment (descendant bones whose name
 *  contains "Twist", ordered base→tip). CC rigs park Twist01 → Twist02 there. */
function findTwistChain(segment: THREE.Object3D): THREE.Object3D[] {
  const chain: THREE.Object3D[] = [];
  let node: THREE.Object3D = segment;
  for (let guard = 0; guard < 8; guard += 1) {
    const next = node.children.find(
      (c) => (c as THREE.Bone).isBone && /twist\d/i.test(c.name),
    );
    if (!next) break;
    chain.push(next);
    node = next;
  }
  return chain;
}

/** Build the twist rig once, AFTER the anatomic rest pose is applied (so the
 *  recorded rest quaternions match the clinical baseline). */
export function buildTwistRig(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
): TwistSegment[] {
  const lookup = buildBoneByPoseKey(skeleton, variantCfg);
  const out: TwistSegment[] = [];
  for (const cfg of TWIST_SEGMENTS) {
    for (const side of ['L_', 'R_'] as const) {
      const segment = lookup.get(`${side}${cfg.key}`);
      if (!segment) continue;
      const chain = findTwistChain(segment);
      if (!chain.length) continue;
      const distal = cfg.distal ? lookup.get(`${side}${cfg.distal}`) : undefined;
      out.push({
        segment,
        restSegmentLocal: segment.quaternion.clone(),
        chain,
        restChainLocals: chain.map((b) => b.quaternion.clone()),
        distal,
        restDistalLocal: distal ? distal.quaternion.clone() : undefined,
      });
    }
  }
  return out;
}

const _twInv = new THREE.Quaternion();
const _twDelta = new THREE.Quaternion();
const _twTwist = new THREE.Quaternion();
const _twInc = new THREE.Quaternion();

/** Swing-twist: the bone's axial twist (about +Y) of its delta-from-rest, in deg-
 *  free radians, discarding swing. */
function twistAngleAboutY(restLocal: THREE.Quaternion, current: THREE.Quaternion): number {
  _twInv.copy(restLocal).invert();
  _twDelta.copy(_twInv).multiply(current);
  _twTwist.set(0, _twDelta.y, 0, _twDelta.w);
  return signedAngleAboutAxis(_twTwist, LONG_AXIS);
}

/** Spread each segment's axial twist across its twist bones, grading the mesh from
 *  0 at the proximal joint to the TOTAL twist (segment + shared distal child, e.g.
 *  forearm + hand) at the distal end. Call after pose edits, before render. Cheap;
 *  safe to call every frame. */
export function applyTwistRig(rig: TwistSegment[]): void {
  for (const ts of rig) {
    const thetaSeg = twistAngleAboutY(ts.restSegmentLocal, ts.segment.quaternion);
    let total = thetaSeg;
    if (ts.distal && ts.restDistalLocal) {
      total += twistAngleAboutY(ts.restDistalLocal, ts.distal.quaternion);
    }
    // Each twist bone's cumulative WORLD twist = fraction × total. The segment base
    // already carries thetaSeg, so the first increment counters it down toward 0.
    let prevWorld = thetaSeg;
    for (let i = 0; i < ts.chain.length; i += 1) {
      const desiredWorld = (TWIST_FRACTIONS[i] ?? 0) * total;
      _twInc.setFromAxisAngle(LONG_AXIS, desiredWorld - prevWorld);
      ts.chain[i].quaternion.copy(ts.restChainLocals[i]).multiply(_twInc);
      prevWorld = desiredWorld;
    }
  }
}
