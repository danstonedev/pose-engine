/** Body-aware clearance for freely swinging locomotor arms. Runs after foot
 * contact solving in both playback and recording. It only moves an upper arm
 * outward when its forearm/hand capsule would enter either thigh or shank.
 * This is a geometric envelope, not contact-force or soft-tissue simulation.
 */
import { Quaternion, Vector3, type Bone } from 'three';
import { segmentDistance, THIGH_RADIUS_M, SHANK_RADIUS_M, FOREARM_RADIUS_M, HAND_RADIUS_M, type Vec3 } from './limbClearance';
import { clampBoneToRom } from './poseRomClamp';
import type { JointAngleRestReference } from './jointAngles';
import type { RomScenarioConstraints } from './romConstraints';

export function clearLocomotorArms(
  bones: ReadonlyMap<string, Bone>, rest: JointAngleRestReference,
  rootRotation: Quaternion | null, constraints?: RomScenarioConstraints | null,
): boolean {
  const position = (key: string): Vec3 | undefined => bones.get(key)?.getWorldPosition(new Vector3()).toArray();
  const legs: { a: Vec3; b: Vec3; radius: number }[] = [];
  for (const side of ['L', 'R']) {
    const hip = position(`${side}_UpLeg`), knee = position(`${side}_Leg`), ankle = position(`${side}_Foot`);
    if (hip && knee) legs.push({ a: hip, b: knee, radius: THIGH_RADIUS_M });
    if (knee && ankle) legs.push({ a: knee, b: ankle, radius: SHANK_RADIUS_M });
  }
  if (legs.length !== 4) return false;
  let changed = false;
  for (const side of ['L', 'R']) {
    const key = `${side}_UpperArm`, arm = bones.get(key);
    if (!arm?.parent || !bones.has(`${side}_Forearm`) || !bones.has(`${side}_Hand`) || !bones.has(`${side}_Mid1`)) continue;
    const clearance = () => {
      const elbow = position(`${side}_Forearm`)!, wrist = position(`${side}_Hand`)!, hand = position(`${side}_Mid1`)!;
      let distance = Infinity;
      for (const leg of legs) {
        distance = Math.min(distance,
          segmentDistance(elbow, wrist, leg.a, leg.b) - FOREARM_RADIUS_M - leg.radius,
          segmentDistance(wrist, hand, leg.a, leg.b) - HAND_RADIUS_M - leg.radius);
      }
      return distance;
    };
    const margin = .01;
    if (clearance() >= margin) continue;
    const original = arm.quaternion.clone();
    const parent = arm.parent.getWorldQuaternion(new Quaternion());
    const axis = new Vector3(0, 0, side === 'L' ? 1 : -1)
      .applyQuaternion(rootRotation ?? new Quaternion()).applyQuaternion(parent.invert());
    const at = (deg: number) => {
      arm.quaternion.copy(new Quaternion().setFromAxisAngle(axis, deg * Math.PI / 180).multiply(original));
      arm.updateMatrixWorld(true);
      const requested = arm.quaternion.clone();
      // Capacity wins over clearance. Reject a candidate that would need ROM
      // projection; do not acquire extra patient range to clear the body.
      clampBoneToRom(arm, key, rest, constraints, true);
      const valid = requested.angleTo(arm.quaternion) < 1e-5;
      return { valid, clear: valid && clearance() >= margin };
    };
    let lo = 0, hi = 0, found = false, capacity = false;
    for (hi = 2; hi <= 30; hi += 2) {
      const result = at(hi);
      if (!result.valid) { capacity = true; break; }
      if (result.clear) { found = true; break; }
      lo = hi;
    }
    if (found || capacity) {
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2, result = at(mid);
        if (capacity ? result.valid : !result.clear) lo = mid;
        else hi = mid;
      }
    }
    const degrees = found ? hi : lo;
    if (degrees > 0) { at(degrees); changed = true; }
    else { arm.quaternion.copy(original); arm.updateMatrixWorld(true); }
  }
  return changed;
}

