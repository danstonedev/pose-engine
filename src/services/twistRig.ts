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

const TWIST_SEGMENT_KEYS = ['UpperArm', 'Forearm', 'UpLeg', 'Leg'] as const;
// Cumulative world-twist fraction at each twist bone (Twist01 at the base, Twist02
// mid-segment). The segment base is 1.0; grading from 0 spreads the proximal joint.
const TWIST_FRACTIONS = [0, 0.5];
// Bone-local long axis: every child sits at +Y, so the segment twists about +Y.
const LONG_AXIS = new THREE.Vector3(0, 1, 0);

export interface TwistSegment {
  segment: THREE.Object3D;
  restSegmentLocal: THREE.Quaternion;
  chain: THREE.Object3D[];
  restChainLocals: THREE.Quaternion[];
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
  for (const key of TWIST_SEGMENT_KEYS) {
    for (const side of ['L_', 'R_'] as const) {
      const segment = lookup.get(`${side}${key}`);
      if (!segment) continue;
      const chain = findTwistChain(segment);
      if (!chain.length) continue;
      out.push({
        segment,
        restSegmentLocal: segment.quaternion.clone(),
        chain,
        restChainLocals: chain.map((b) => b.quaternion.clone()),
      });
    }
  }
  return out;
}

const _twInv = new THREE.Quaternion();
const _twDelta = new THREE.Quaternion();
const _twTwist = new THREE.Quaternion();
const _twInc = new THREE.Quaternion();

/** Spread each segment's axial twist (about its long axis, vs rest) across its
 *  twist bones. Call after pose edits, before render. Cheap; safe to call every
 *  frame. */
export function applyTwistRig(rig: TwistSegment[]): void {
  for (const ts of rig) {
    _twInv.copy(ts.restSegmentLocal).invert();
    _twDelta.copy(_twInv).multiply(ts.segment.quaternion); // segment delta from rest
    // Swing-twist: isolate the twist ABOUT the long axis (+Y), discarding swing.
    _twTwist.set(0, _twDelta.y, 0, _twDelta.w);
    const theta = signedAngleAboutAxis(_twTwist, LONG_AXIS);
    let prev = 1; // the segment base carries full twist
    for (let i = 0; i < ts.chain.length; i += 1) {
      const f = TWIST_FRACTIONS[i] ?? 0;
      _twInc.setFromAxisAngle(LONG_AXIS, (f - prev) * theta);
      ts.chain[i].quaternion.copy(ts.restChainLocals[i]).multiply(_twInc);
      prev = f;
    }
  }
}
