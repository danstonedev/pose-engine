import { Vector3, type Object3D } from 'three';

/** The source mannequins' palm surface is about 30 mm beyond the hand-to-MCP
 * bone line. Add the dowel radius so the cylinder rests against that surface.
 * This is a visual grip calibration, not a force or tissue model. */
const PALM_FROM_BONE_M = 0.032;

export interface OverheadDowelPlacement {
  from: Vector3;
  to: Vector3;
  /** Direction out of both palms, also the safe direction for body clearance. */
  outward: Vector3;
}

/** One straight bar shared by the two palms. A missing or incompatible pair of
 * hands is an invalid grip and must not draw a bar through the patient. */
export function overheadDowelPlacement(
  bone: (key: string) => Object3D | null,
  lengthM: number,
  radiusM: number,
): OverheadDowelPlacement | null {
  if (![lengthM, radiusM].every(Number.isFinite) || !(lengthM > 0 && radiusM > 0)) return null;
  const hands = (['L', 'R'] as const).map(side => {
    const wrist = bone(`${side}_Hand`), middle = bone(`${side}_Mid1`);
    const index = bone(`${side}_Index1`), pinky = bone(`${side}_Pinky1`);
    if (!wrist || !middle || !index || !pinky) return null;
    const at = (item: Object3D) => item.getWorldPosition(new Vector3());
    const w = at(wrist), m = at(middle);
    const along = m.clone().sub(w);
    const across = at(index).sub(at(pinky));
    if (along.lengthSq() < 1e-8 || across.lengthSq() < 1e-8) return null;
    const palm = along.cross(across).normalize().multiplyScalar(side === 'L' ? 1 : -1);
    return { grip: w.lerp(m, 0.85), palm };
  });
  const [left, right] = hands;
  if (!left || !right) return null;
  const span = left.grip.clone().sub(right.grip);
  const distance = span.length();
  // Leave at least one palm width of dowel outside each hand.
  if (distance < 0.15 || distance > lengthM - 0.12 || left.palm.dot(right.palm) < 0.75) return null;
  const axis = span.divideScalar(distance);
  const outward = left.palm.add(right.palm);
  outward.addScaledVector(axis, -outward.dot(axis));
  if (outward.lengthSq() < 1e-8) return null;
  outward.normalize();
  const center = left.grip.add(right.grip).multiplyScalar(0.5).addScaledVector(outward, PALM_FROM_BONE_M + radiusM);
  return {
    from: center.clone().addScaledVector(axis, -lengthM / 2),
    to: center.clone().addScaledVector(axis, lengthM / 2),
    outward,
  };
}
