import * as THREE from 'three';
import type { FootPlantSolver } from './footContact';
import type { JointAngleRestReference } from './jointAngles';
import type { RomScenarioConstraints } from './romConstraints';
import { clampBoneToRom } from './poseRomClamp';

/** Refine an explicitly planted palm as a pose constraint. A wrist point alone
 * leaves the palm free to roll and slide. All changes remain joint rotations;
 * the target never moves and the clinical bounds still apply. */
export function solveHandContactPose(
  solver: FootPlantSolver,
  position: THREE.Vector3,
  orientation: THREE.Quaternion,
  rest: JointAngleRestReference | null | undefined,
  constraints?: RomScenarioConstraints | null,
  elbowDirection?: THREE.Vector3,
  minimumElbowY?: number,
): void {
  if (!rest || !solver.distalCtx) return;
  const { bones, canonicalKeys } = solver.ctx;
  const hand = bones[0]!;
  const root = bones.at(-1)!;
  for (let joint = bones.length - 1; joint >= 0; joint -= 1) clampBoneToRom(bones[joint]!, canonicalKeys[joint], rest, constraints, true);
  root.updateWorldMatrix(true, true);
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const point = new THREE.Vector3(), rotation = new THREE.Quaternion();
  // The finite-difference solve evaluates this residual many times. Reuse its
  // geometric scratch values; no pose state or previous-frame result is cached.
  const shoulderPoint = new THREE.Vector3(), elbowPoint = new THREE.Vector3(), wristPoint = new THREE.Vector3();
  const direction = new THREE.Vector3(), radial = new THREE.Vector3(), elbowError = new THREE.Vector3();
  const handRotation = new THREE.Quaternion(), deltaRotation = new THREE.Quaternion();
  const angularScale = .12;
  const preferredElbow = () => {
    const shoulder = bones[2]!.getWorldPosition(shoulderPoint);
    const elbow = bones[1]!.getWorldPosition(elbowPoint);
    const wrist = hand.getWorldPosition(wristPoint);
    const a = shoulder.distanceTo(elbow), b = elbow.distanceTo(wrist);
    direction.copy(position).sub(shoulder);
    const distance = Math.max(1e-8, direction.length());
    direction.divideScalar(distance);
    const along = Math.min(a, Math.max(-a, (a * a - b * b + distance * distance) / (2 * distance)));
    radial.copy(elbowDirection!).addScaledVector(direction, -elbowDirection!.dot(direction)).normalize();
    return shoulder.addScaledVector(direction, along).addScaledVector(radial, Math.sqrt(Math.max(0, a * a - along * along)));
  };
  const residual = (): number[] => {
    root.updateWorldMatrix(true, true);
    hand.getWorldPosition(point).sub(position);
    rotation.copy(orientation).multiply(hand.getWorldQuaternion(handRotation).invert());
    if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
    const length = Math.hypot(rotation.x, rotation.y, rotation.z);
    const scale = length > 1e-10 ? -angularScale * 2 * Math.atan2(length, rotation.w) / length : -2 * angularScale;
    const result = [point.x, point.y, point.z, rotation.x * scale, rotation.y * scale, rotation.z * scale];
    // A planted palm cannot be solved by folding the forearm through its
    // support plane. Keep this inequality in the final palm refinement too.
    if (minimumElbowY != null) result.push(Math.min(0, bones[1]!.getWorldPosition(elbowError).y - minimumElbowY));
    // A bend guide follows the shoulder. Freezing its initial world-space
    // point also constrains girdle translation and distorts shoulder motion.
    if (elbowDirection) result.push(...bones[1]!.getWorldPosition(elbowError).sub(preferredElbow()).multiplyScalar(.25).toArray());
    return result;
  };
  const clamp = (index: number) => clampBoneToRom(bones[index]!, canonicalKeys[index], rest, constraints, true);
  const norm = (values: number[]) => values.reduce((sum, value) => sum + value * value, 0);
  let error = residual();
  let damping = 1e-5;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    if (norm(error) < 1e-8) break;
    const before = bones.map(bone => bone.quaternion.clone());
    const restore = () => bones.forEach((bone, index) => bone.quaternion.copy(before[index]!));
    const epsilon = .001;
    const columns: number[][] = [];
    for (let joint = 0; joint < bones.length; joint += 1) for (const axis of axes) {
      bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(axis, epsilon));
      clamp(joint);
      const plus = residual();
      restore();
      bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(axis, -epsilon));
      clamp(joint);
      const minus = residual();
      restore();
      columns.push(plus.map((value, index) => (value - minus[index]!) / (2 * epsilon)));
    }
    // Damped least squares in the six task coordinates, J' (J J' + lambda I)^-1 e.
    const size = error.length;
    const matrix = Array.from({ length: size }, (_, row) => [
      ...Array.from({ length: size }, (_, col) => columns.reduce((sum, column) => sum + column[row]! * column[col]!, row === col ? damping : 0)),
      -error[row]!,
    ]);
    for (let pivot = 0; pivot < size; pivot += 1) {
      let best = pivot;
      for (let row = pivot + 1; row < size; row += 1) if (Math.abs(matrix[row]![pivot]!) > Math.abs(matrix[best]![pivot]!)) best = row;
      [matrix[pivot], matrix[best]] = [matrix[best]!, matrix[pivot]!];
      const divisor = matrix[pivot]![pivot]!;
      for (let col = pivot; col <= size; col += 1) matrix[pivot]![col] /= divisor;
      for (let row = 0; row < size; row += 1) if (row !== pivot) {
        const factor = matrix[row]![pivot]!;
        for (let col = pivot; col <= size; col += 1) matrix[row]![col] -= factor * matrix[pivot]![col]!;
      }
    }
    const delta = columns.map(column => column.reduce((sum, value, row) => sum + value * matrix[row]![size]!, 0));
    const step = Math.min(1, .2 / Math.max(...delta.map(Math.abs), 1e-9));
    let accepted = false;
    for (const fraction of [1, .5, .25, .125]) {
      restore();
      for (let joint = bones.length - 1; joint >= 0; joint -= 1) {
        for (let axis = 0; axis < 3; axis += 1) bones[joint]!.quaternion.multiply(deltaRotation.setFromAxisAngle(axes[axis]!, delta[joint * 3 + axis]! * step * fraction));
        clamp(joint);
      }
      const next = residual();
      if (norm(next) < norm(error) - 1e-14) {
        error = next;
        damping = Math.max(1e-7, damping / 2);
        accepted = true;
        break;
      }
    }
    if (!accepted) {
      restore();
      damping *= 10;
      if (damping > .1) break;
    }
  }
  root.updateWorldMatrix(true, true);
  // The pole chooses the elbow branch. Finish on the fixed palm constraint so
  // a small disagreement with the guide cannot drag the hand along the floor.
  if (elbowDirection) solveHandContactPose(solver, position, orientation, rest, constraints, undefined, minimumElbowY);
}
