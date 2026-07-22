import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  getEffectiveRomRange,
  getRomConstraintView,
  getRomFieldConstraint,
  isInRomPainfulArc,
  normalizeRomConstraints,
  resolveAvailableRange,
  type RomScenarioConstraints,
} from '../services/romConstraints';
import { clampBoneToRom } from '../services/poseRomClamp';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

// Per-scenario ROM constraints are passed EXPLICITLY (no module-global store):
// every lookup takes the constraint set as its first argument, and the clamp
// takes it as a trailing argument. A caller with no per-patient overrides passes
// `null` (normative ROM applies).

describe('normalizeRomConstraints', () => {
  it('collapses an empty set to null (empty === no constraints)', () => {
    expect(normalizeRomConstraints(null)).toBeNull();
    expect(normalizeRomConstraints(undefined)).toBeNull();
    expect(normalizeRomConstraints({})).toBeNull();
  });

  it('passes a non-empty set through unchanged', () => {
    const c: RomScenarioConstraints = { R_Forearm: { elbowFlexion: { availableRange: { max: 95 } } } };
    expect(normalizeRomConstraints(c)).toBe(c);
  });
});

describe('getRomFieldConstraint', () => {
  const constraints: RomScenarioConstraints = {
    R_Forearm: { elbowFlexion: { availableRange: { max: 95 }, endFeel: 'empty' } },
  };

  it('looks up a field constraint by canonical + field key', () => {
    expect(getRomFieldConstraint(constraints, 'R_Forearm', 'elbowFlexion')?.endFeel).toBe('empty');
    expect(getRomFieldConstraint(constraints, 'R_Forearm', 'forearmRotation')).toBeUndefined();
    expect(getRomFieldConstraint(constraints, 'L_Forearm', 'elbowFlexion')).toBeUndefined();
    expect(getRomFieldConstraint(constraints, null, 'elbowFlexion')).toBeUndefined();
  });

  it('is undefined when there are no constraints', () => {
    expect(getRomFieldConstraint(null, 'R_Forearm', 'elbowFlexion')).toBeUndefined();
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
  const restrict: RomScenarioConstraints = {
    R_Forearm: { elbowFlexion: { availableRange: { max: 95 } } },
  };

  it('is the normative range when unconstrained', () => {
    expect(getEffectiveRomRange(null, 'R_Forearm', 'elbowFlexion')).toEqual({ min: 0, max: 150 });
  });

  it('is the intersection when the scenario restricts', () => {
    expect(getEffectiveRomRange(restrict, 'R_Forearm', 'elbowFlexion')).toEqual({ min: 0, max: 95 });
    // Untouched fields keep the normative range.
    expect(getEffectiveRomRange(restrict, 'R_Forearm', 'forearmRotation')).toEqual({ min: -90, max: 90 });
  });

  it('returns null for unknown fields', () => {
    expect(getEffectiveRomRange(null, 'R_Forearm', 'nope')).toBeNull();
    expect(getEffectiveRomRange(null, 'NotAJoint', 'elbowFlexion')).toBeNull();
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

  it('tolerates clamp-readback error at the arc boundary', () => {
    // An arc that ENDS at the available limit (the common pain-limited-ROM
    // authoring) must still register when the clamped bone reads back a hair
    // past the boundary.
    expect(isInRomPainfulArc(120.001, constraint)).toBe(true);
    expect(isInRomPainfulArc(59.999, constraint)).toBe(true);
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
    const view = getRomConstraintView(null, 'R_Forearm', 'elbowFlexion');
    expect(view).not.toBeNull();
    expect(view!.restricted).toBe(false);
    expect(view!.availableRange).toEqual({ min: 0, max: 150 });
    expect(view!.availableMinPercent).toBe(0);
    expect(view!.availableMaxPercent).toBe(100);
    expect(view!.painfulArc).toBeNull();
  });

  it('maps a restriction + painful arc onto the normative track', () => {
    const constraints: RomScenarioConstraints = {
      R_Forearm: {
        elbowFlexion: {
          availableRange: { max: 75 },
          painfulArc: { min: 60, max: 75 },
          endFeel: 'empty',
        },
      },
    };
    const view = getRomConstraintView(constraints, 'R_Forearm', 'elbowFlexion')!;
    expect(view.restricted).toBe(true);
    expect(view.availableRange).toEqual({ min: 0, max: 75 });
    expect(view.availableMaxPercent).toBeCloseTo(50, 5); // 75 of 0–150
    expect(view.painfulArcMinPercent).toBeCloseTo(40, 5); // 60 of 0–150
    expect(view.painfulArcMaxPercent).toBeCloseTo(50, 5);
    expect(view.constraint?.endFeel).toBe('empty');
  });

  it('returns null for unknown fields', () => {
    expect(getRomConstraintView(null, 'R_Forearm', 'nope')).toBeNull();
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
  const ELBOW95: RomScenarioConstraints = {
    L_Forearm: { elbowFlexion: { availableRange: { max: 95 } } },
  };

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
    const { skeleton, forearm, root, rest } = setup();
    flexTo(120, forearm, root);

    const changed = clampBoneToRom(forearm, 'L_Forearm', rest, ELBOW95);
    expect(changed).toBe(true);

    root.updateMatrixWorld(true);
    const report = computeJointAngles(skeleton, variant, 'male', rest);
    expect(Math.abs(report.joints.L_Forearm.elbowFlexion)).toBeCloseTo(95, 0);
  });

  it('leaves movement inside the patient limit untouched', () => {
    const { forearm, root, rest } = setup();
    flexTo(80, forearm, root);

    const before = forearm.quaternion.clone();
    const changed = clampBoneToRom(forearm, 'L_Forearm', rest, ELBOW95);
    expect(changed).toBe(false);
    expect(forearm.quaternion.angleTo(before)).toBeLessThan(1e-6);
  });

  it('reverts to the normative limit when no constraints are passed', () => {
    const { skeleton, forearm, root, rest } = setup();
    flexTo(120, forearm, root);

    const changed = clampBoneToRom(forearm, 'L_Forearm', rest, null);
    expect(changed).toBe(false);

    root.updateMatrixWorld(true);
    const report = computeJointAngles(skeleton, variant, 'male', rest);
    expect(Math.abs(report.joints.L_Forearm.elbowFlexion)).toBeCloseTo(120, 0);
  });
});
