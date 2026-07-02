import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  clearRomScenarioConstraints,
  getEffectiveRomRange,
  getRomConstraintView,
  getRomFieldConstraint,
  getRomScenarioConstraints,
  isInRomPainfulArc,
  resolveAvailableRange,
  setRomScenarioConstraints,
} from '../services/romConstraints';
import { clampBoneToRom } from '../services/poseRomClamp';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

afterEach(() => {
  clearRomScenarioConstraints();
});

describe('scenario constraint store', () => {
  it('starts empty and clears back to empty', () => {
    expect(getRomScenarioConstraints()).toBeNull();
    setRomScenarioConstraints({ R_Forearm: { elbowFlexion: { availableRange: { max: 95 } } } });
    expect(getRomScenarioConstraints()).not.toBeNull();
    clearRomScenarioConstraints();
    expect(getRomScenarioConstraints()).toBeNull();
  });

  it('treats an empty object as no constraints', () => {
    setRomScenarioConstraints({});
    expect(getRomScenarioConstraints()).toBeNull();
  });

  it('looks up a field constraint by canonical + field key', () => {
    setRomScenarioConstraints({
      R_Forearm: { elbowFlexion: { availableRange: { max: 95 }, endFeel: 'empty' } },
    });
    expect(getRomFieldConstraint('R_Forearm', 'elbowFlexion')?.endFeel).toBe('empty');
    expect(getRomFieldConstraint('R_Forearm', 'forearmRotation')).toBeUndefined();
    expect(getRomFieldConstraint('L_Forearm', 'elbowFlexion')).toBeUndefined();
    expect(getRomFieldConstraint(null, 'elbowFlexion')).toBeUndefined();
  });
});

describe('resolveAvailableRange', () => {
  const normative = { min: 0, max: 150 };

  it('returns the normative range with no constraint', () => {
    expect(resolveAvailableRange(normative, undefined)).toEqual(normative);
  });

  it('narrows only the bound the scenario authored', () => {
    expect(resolveAvailableRange(normative, { availableRange: { max: 95 } })).toEqual({
      min: 0,
      max: 95,
    });
    expect(resolveAvailableRange(normative, { availableRange: { min: 20 } })).toEqual({
      min: 20,
      max: 150,
    });
  });

  it('cannot EXTEND past the normative range', () => {
    expect(
      resolveAvailableRange(normative, { availableRange: { min: -40, max: 200 } }),
    ).toEqual(normative);
  });

  it('collapses a degenerate (min > max) authoring error to the min', () => {
    expect(
      resolveAvailableRange(normative, { availableRange: { min: 100, max: 40 } }),
    ).toEqual({ min: 100, max: 100 });
  });

  it('ignores non-finite bounds', () => {
    expect(
      resolveAvailableRange(normative, { availableRange: { min: NaN, max: Infinity } }),
    ).toEqual(normative);
  });
});

describe('getEffectiveRomRange', () => {
  it('is the normative range when unconstrained', () => {
    expect(getEffectiveRomRange('R_Forearm', 'elbowFlexion')).toEqual({ min: 0, max: 150 });
  });

  it('is the intersection when the scenario restricts', () => {
    setRomScenarioConstraints({
      R_Forearm: { elbowFlexion: { availableRange: { max: 95 } } },
    });
    expect(getEffectiveRomRange('R_Forearm', 'elbowFlexion')).toEqual({ min: 0, max: 95 });
    // Untouched fields keep the normative range.
    expect(getEffectiveRomRange('R_Forearm', 'forearmRotation')).toEqual({ min: -90, max: 90 });
  });

  it('returns null for unknown fields', () => {
    expect(getEffectiveRomRange('R_Forearm', 'nope')).toBeNull();
    expect(getEffectiveRomRange('NotAJoint', 'elbowFlexion')).toBeNull();
  });
});

describe('isInRomPainfulArc', () => {
  const constraint = { painfulArc: { min: 60, max: 120 } };

  it('is true inside the arc (inclusive) and false outside', () => {
    expect(isInRomPainfulArc(60, constraint)).toBe(true);
    expect(isInRomPainfulArc(90, constraint)).toBe(true);
    expect(isInRomPainfulArc(120, constraint)).toBe(true);
    expect(isInRomPainfulArc(59, constraint)).toBe(false);
    expect(isInRomPainfulArc(121, constraint)).toBe(false);
  });

  it('is false without an arc or with a non-finite value', () => {
    expect(isInRomPainfulArc(90, undefined)).toBe(false);
    expect(isInRomPainfulArc(90, {})).toBe(false);
    expect(isInRomPainfulArc(NaN, constraint)).toBe(false);
  });

  it('tolerates a reversed authored arc', () => {
    expect(isInRomPainfulArc(90, { painfulArc: { min: 120, max: 60 } })).toBe(true);
  });
});

describe('getRomConstraintView', () => {
  it('reports an unrestricted field with the full track available', () => {
    const view = getRomConstraintView('R_Forearm', 'elbowFlexion');
    expect(view).not.toBeNull();
    expect(view!.restricted).toBe(false);
    expect(view!.availableRange).toEqual({ min: 0, max: 150 });
    expect(view!.availableMinPercent).toBe(0);
    expect(view!.availableMaxPercent).toBe(100);
    expect(view!.painfulArc).toBeNull();
  });

  it('maps a restriction + painful arc onto the normative track', () => {
    setRomScenarioConstraints({
      R_Forearm: {
        elbowFlexion: {
          availableRange: { max: 75 },
          painfulArc: { min: 60, max: 75 },
          endFeel: 'empty',
        },
      },
    });
    const view = getRomConstraintView('R_Forearm', 'elbowFlexion')!;
    expect(view.restricted).toBe(true);
    expect(view.availableRange).toEqual({ min: 0, max: 75 });
    expect(view.availableMaxPercent).toBeCloseTo(50, 5); // 75 of 0–150
    expect(view.painfulArcMinPercent).toBeCloseTo(40, 5); // 60 of 0–150
    expect(view.painfulArcMaxPercent).toBeCloseTo(50, 5);
    expect(view.constraint?.endFeel).toBe('empty');
  });

  it('returns null for unknown fields', () => {
    expect(getRomConstraintView('R_Forearm', 'nope')).toBeNull();
  });
});

// ── Integration: the clamp enforces the CONSTRAINED range ─────────────────────

/** Minimal CC-named elbow chain (mirrors the builder in poseRomClamp.test.ts). */
function buildElbowSkeleton(): { skeleton: THREE.Skeleton; forearm: THREE.Bone; root: THREE.Bone } {
  const make = (name: string, parent: THREE.Bone | null, offset: [number, number, number]) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...offset);
    if (parent) parent.add(b);
    return b;
  };
  const hips = make('CC_Base_Hip', null, [0, 0, 0]);
  const spine = make('CC_Base_Waist', hips, [0, 0.2, 0]);
  const spine1 = make('CC_Base_Spine01', spine, [0, 0.3, 0]);
  const spine2 = make('CC_Base_Spine02', spine1, [0, 0.3, 0]);
  const lShoulder = make('CC_Base_L_Clavicle', spine2, [0.15, 0.1, 0]);
  const lUpperArm = make('CC_Base_L_Upperarm', lShoulder, [0.15, 0, 0]);
  const lForearm = make('CC_Base_L_Forearm', lUpperArm, [0, -1, 0]);
  const lHand = make('CC_Base_L_Hand', lForearm, [0, -1, 0]);
  make('CC_Base_L_Index1', lHand, [0, -0.3, 0]);

  const collected: THREE.Bone[] = [];
  const walk = (node: THREE.Object3D) => {
    if ((node as THREE.Bone).isBone) collected.push(node as THREE.Bone);
    for (const child of node.children) walk(child);
  };
  walk(hips);
  hips.updateMatrixWorld(true);
  return { skeleton: new THREE.Skeleton(collected), forearm: lForearm, root: hips };
}

describe('clampBoneToRom with scenario constraints', () => {
  const variant = BODY_VARIANTS.male;

  function setup(): {
    skeleton: THREE.Skeleton;
    forearm: THREE.Bone;
    root: THREE.Bone;
    rest: JointAngleRestReference;
  } {
    const { skeleton, forearm, root } = buildElbowSkeleton();
    const rest = captureJointAngleRestReference(skeleton, variant);
    return { skeleton, forearm, root, rest };
  }

  function flexTo(deg: number, forearm: THREE.Bone, root: THREE.Bone) {
    forearm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (deg * Math.PI) / 180);
    root.updateMatrixWorld(true);
  }

  it('stops the elbow at the PATIENT limit (95°), not the normative 150°', () => {
    setRomScenarioConstraints({
      L_Forearm: { elbowFlexion: { availableRange: { max: 95 } } },
    });
    const { skeleton, forearm, root, rest } = setup();
    flexTo(120, forearm, root);

    const changed = clampBoneToRom(forearm, 'L_Forearm', rest);
    expect(changed).toBe(true);

    root.updateMatrixWorld(true);
    const report = computeJointAngles(skeleton, variant, 'male', rest);
    expect(Math.abs(report.joints.L_Forearm.elbowFlexion)).toBeCloseTo(95, 0);
  });

  it('leaves movement inside the patient limit untouched', () => {
    setRomScenarioConstraints({
      L_Forearm: { elbowFlexion: { availableRange: { max: 95 } } },
    });
    const { forearm, root, rest } = setup();
    flexTo(80, forearm, root);

    const before = forearm.quaternion.clone();
    const changed = clampBoneToRom(forearm, 'L_Forearm', rest);
    expect(changed).toBe(false);
    expect(forearm.quaternion.angleTo(before)).toBeLessThan(1e-6);
  });

  it('reverts to the normative limit once constraints are cleared', () => {
    setRomScenarioConstraints({
      L_Forearm: { elbowFlexion: { availableRange: { max: 95 } } },
    });
    clearRomScenarioConstraints();
    const { skeleton, forearm, root, rest } = setup();
    flexTo(120, forearm, root);

    const changed = clampBoneToRom(forearm, 'L_Forearm', rest);
    expect(changed).toBe(false);

    root.updateMatrixWorld(true);
    const report = computeJointAngles(skeleton, variant, 'male', rest);
    expect(Math.abs(report.joints.L_Forearm.elbowFlexion)).toBeCloseTo(120, 0);
  });
});
