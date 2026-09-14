import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clampBoneToRom, inspectClinicalAngles } from '../services/poseRomClamp';
import type { JointAngleRestReference } from '../services/jointAngles';

function fixture(key: string, rotationDeg: number, rawFlexionDeg = 0, rawAbductionDeg = 0) {
  const bone = new THREE.Bone();
  const restQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.1, 0.05));
  const rest: JointAngleRestReference = {
    pelvisWorldQuat: [0, 0, 0, 1],
    localQuats: { [key]: restQuaternion.toArray() },
    worldQuats: { [key]: restQuaternion.toArray() },
  };
  // The decomposition reads (-Euler X, Euler Z, -Euler Y) in YXZ order.
  bone.quaternion.setFromEuler(new THREE.Euler(
    -rawFlexionDeg * Math.PI / 180, -rotationDeg * Math.PI / 180,
    rawAbductionDeg * Math.PI / 180, 'YXZ',
  ))
    .multiply(restQuaternion);
  return { bone, rest };
}

describe.each(['L_Hand', 'R_Hand'])('%s rotation diagnostics', key => {
  it('reports the explicit pro/sup share range and preserves a valid 9.58-degree share', () => {
    const { bone, rest } = fixture(key, 9.58);
    const before = bone.quaternion.toArray();
    const report = inspectClinicalAngles(bone, key, rest)!;
    expect(report.ranges.rotation).toEqual({ min: -45, max: 45 });
    expect(report.raw.rotation).toBeCloseTo(9.58, 8);
    expect(bone.quaternion.toArray()).toEqual(before); // Inspection is read-only.
    expect(clampBoneToRom(bone, key, rest)).toBe(false);
    expect(bone.quaternion.toArray()).toEqual(before);
  });

  it.each([-70, 70])('agrees with the actual clamp for an out-of-range %s-degree share', rotationDeg => {
    const { bone, rest } = fixture(key, rotationDeg);
    const before = inspectClinicalAngles(bone, key, rest)!;
    const expectedBound = rotationDeg < 0 ? before.ranges.rotation!.min : before.ranges.rotation!.max;
    expect(clampBoneToRom(bone, key, rest)).toBe(true);
    const after = inspectClinicalAngles(bone, key, rest)!;
    expect(after.raw.rotation).toBeCloseTo(expectedBound, 8);
    expect(Math.abs(after.raw.rotation)).toBeCloseTo(45, 8);
  });

  it('maps local Z to wrist flexion and local X to deviation with the correct side sign', () => {
    const flexionSign = key === 'L_Hand' ? -1 : 1;
    const { bone, rest } = fixture(key, 9.58, -15, 40 * flexionSign);
    const report = inspectClinicalAngles(bone, key, rest)!;
    expect(report.raw.flexion).toBeCloseTo(40 * flexionSign, 8);
    expect(report.anatomicFlexion).toBeCloseTo(40, 8);
    expect(report.raw.abduction).toBeCloseTo(15, 8);
    expect(report.raw.rotation).toBeCloseTo(9.58, 8);
    expect(clampBoneToRom(bone, key, rest)).toBe(false);
  });

  it('detects the small deviation overflow that the old swapped diagnostic missed', () => {
    const { bone, rest } = fixture(key, 9.58, -20.04976, 21.39);
    const before = inspectClinicalAngles(bone, key, rest)!;
    expect(before.raw.abduction).toBeCloseTo(20.04976, 8);
    expect(before.raw.abduction).toBeGreaterThan(before.ranges.abduction!.max);
    expect(clampBoneToRom(bone, key, rest)).toBe(true);
    const after = inspectClinicalAngles(bone, key, rest)!;
    expect(after.raw.abduction).toBeCloseTo(before.ranges.abduction!.max, 8);
    expect(after.anatomicFlexion).toBeCloseTo(before.anatomicFlexion, 8);
    expect(after.raw.rotation).toBeCloseTo(9.58, 8);
  });

  it('identifies wrist flexion overflow independently of an in-range deviation', () => {
    const flexionSign = key === 'L_Hand' ? -1 : 1;
    const { bone, rest } = fixture(key, 9.58, -10, 100 * flexionSign);
    const before = inspectClinicalAngles(bone, key, rest)!;
    expect(before.anatomicFlexion).toBeCloseTo(100, 8);
    expect(before.anatomicFlexion).toBeGreaterThan(before.ranges.flexion!.max);
    expect(clampBoneToRom(bone, key, rest)).toBe(true);
    const after = inspectClinicalAngles(bone, key, rest)!;
    expect(after.anatomicFlexion).toBeCloseTo(before.ranges.flexion!.max, 8);
    expect(after.raw.abduction).toBeCloseTo(10, 8);
    expect(after.raw.rotation).toBeCloseTo(9.58, 8);
  });
});

it.each(['L_Foot', 'R_Foot', 'L_Toes', 'R_Toes'])('%s keeps its existing null diagnostic when no explicit rotation range exists', key => {
  const { bone, rest } = fixture(key, 0);
  expect(inspectClinicalAngles(bone, key, rest)!.ranges.rotation).toBeNull();
});

it.each([
  ['Spine_Lower', -1, -1], ['Spine_Upper', -1, -1], ['Neck', -1, -1],
  ['L_Shoulder', 1, 1], ['R_Shoulder', 1, -1],
  ['L_Foot', -1, -1], ['R_Foot', -1, 1], ['L_Toes', -1, 1], ['R_Toes', -1, -1],
] as const)('%s preserves its existing unswapped axes and signs', (key, flexionSign, abductionSign) => {
  const { bone, rest } = fixture(key, 5, 12, 7);
  const report = inspectClinicalAngles(bone, key, rest)!;
  expect(report.raw.flexion).toBeCloseTo(12, 8);
  expect(report.anatomicFlexion).toBeCloseTo(12 * flexionSign, 8);
  expect(report.raw.abduction).toBeCloseTo(7 * abductionSign, 8);
  expect(report.raw.rotation).toBeCloseTo(5, 8);
});
