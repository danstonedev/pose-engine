import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import {
  ALL_LIMB_IDS,
  HAND_PROXY_RATIO,
  REGION_TO_LIMB,
  buildLimbAxisModel,
  createLimbAxisAccumulator,
  createProjection,
  projectOntoAxis,
  resolveLimbIdForRegion,
  type LimbAxis,
} from '../services/limbAxisModel';

// ── Test rig helpers ──────────────────────────────────────────────────────

interface BoneSpec {
  name: string;
  /** Local position relative to parent. */
  pos: [number, number, number];
  /** Index of the parent in the same spec array; root has no parent. */
  parentIdx?: number;
}

function buildTestSkeleton(specs: BoneSpec[]): THREE.Skeleton {
  const bones = specs.map((s) => {
    const b = new THREE.Bone();
    b.name = s.name;
    b.position.set(s.pos[0], s.pos[1], s.pos[2]);
    return b;
  });
  // Wire parent/child relationships.
  for (let i = 0; i < specs.length; i += 1) {
    const parentIdx = specs[i].parentIdx;
    if (parentIdx !== undefined) bones[parentIdx].add(bones[i]);
  }
  // Cascade world-matrix updates from the root.
  const root = bones.find((b) => b.parent === null) ?? bones[0];
  root.updateMatrixWorld(true);
  return new THREE.Skeleton(bones);
}

/** A straight-down left arm anchored at a Spine_Upper proxy.
 *  World y values (with metersPerWorldUnit=0.01, world units == cm):
 *    Spine_Upper (Spine02):  y =   5
 *    L_Clavicle (Shoulder):  y =   0
 *    L_Upperarm:             y = -30
 *    L_Forearm:              y = -60
 *    L_Hand:                 y = -85
 *  Hand tip is extrapolated: y = -85 + (-85 - -60)*0.85 = -106.25
 *  Segment lengths: 5, 30, 30, 25, 21.25. Total = 111.25 cm. */
function buildStraightLeftArmSkeleton(): THREE.Skeleton {
  return buildTestSkeleton([
    { name: 'CC_Base_Spine02', pos: [0, 5, 0] }, // root
    { name: 'CC_Base_L_Clavicle', pos: [0, -5, 0], parentIdx: 0 },
    { name: 'CC_Base_L_Upperarm', pos: [0, -30, 0], parentIdx: 1 },
    { name: 'CC_Base_L_Forearm', pos: [0, -30, 0], parentIdx: 2 },
    { name: 'CC_Base_L_Hand', pos: [0, -25, 0], parentIdx: 3 },
  ]);
}

/** Same skeleton with the forearm bent forward 90° at the elbow:
 *    UpperArm  y = -30
 *    Forearm   y = -30, z = -30
 *    Hand      y = -30, z = -55  */
function buildBentLeftArmSkeleton(): THREE.Skeleton {
  return buildTestSkeleton([
    { name: 'CC_Base_Spine02', pos: [0, 5, 0] },
    { name: 'CC_Base_L_Clavicle', pos: [0, -5, 0], parentIdx: 0 },
    { name: 'CC_Base_L_Upperarm', pos: [0, -30, 0], parentIdx: 1 },
    { name: 'CC_Base_L_Forearm', pos: [0, 0, -30], parentIdx: 2 },
    { name: 'CC_Base_L_Hand', pos: [0, 0, -25], parentIdx: 3 },
  ]);
}

/** L and R upperarm at +X and -X so we can verify side handling. */
function buildBilateralArmSkeleton(): THREE.Skeleton {
  return buildTestSkeleton([
    { name: 'CC_Base_Spine02', pos: [0, 0, 0] },
    { name: 'CC_Base_L_Clavicle', pos: [5, 0, 0], parentIdx: 0 },
    { name: 'CC_Base_L_Upperarm', pos: [5, -30, 0], parentIdx: 1 },
    { name: 'CC_Base_L_Forearm', pos: [0, -30, 0], parentIdx: 2 },
    { name: 'CC_Base_L_Hand', pos: [0, -25, 0], parentIdx: 3 },
    { name: 'CC_Base_R_Clavicle', pos: [-5, 0, 0], parentIdx: 0 },
    { name: 'CC_Base_R_Upperarm', pos: [-5, -30, 0], parentIdx: 5 },
    { name: 'CC_Base_R_Forearm', pos: [0, -30, 0], parentIdx: 6 },
    { name: 'CC_Base_R_Hand', pos: [0, -25, 0], parentIdx: 7 },
  ]);
}

const MALE = BODY_VARIANTS.male;
const METERS_PER_WORLD = 0.01; // tests treat world units as cm

// ── buildLimbAxisModel ────────────────────────────────────────────────────

describe('buildLimbAxisModel — straight arm geometry', () => {
  const sk = buildStraightLeftArmSkeleton();
  const model = buildLimbAxisModel(sk, MALE, 1, METERS_PER_WORLD);
  const arm = model.axes['left-upper-extremity'];

  it('builds a left-upper-extremity polyline with all expected joints', () => {
    expect(arm).not.toBeNull();
    expect(arm!.side).toBe('left');
    expect(arm!.jointStations).toMatchObject({
      Spine_Upper: 0,
      L_Shoulder: 5,
      L_UpperArm: 35,
      L_Forearm: 65,
      L_Hand: 90,
    });
  });

  it('extrapolates a hand tip when no finger bones exist', () => {
    expect(arm!.jointStations['L_HandTip']).toBeCloseTo(90 + 25 * HAND_PROXY_RATIO, 5);
    expect(arm!.degradedAnchor).toBe(true); // tip was extrapolated
    expect(arm!.totalLengthCm).toBeCloseTo(111.25, 5);
  });

  it('has no other limbs available with this minimal rig', () => {
    expect(model.axes['right-upper-extremity']).toBeNull();
    expect(model.axes['left-lower-extremity']).toBeNull();
    expect(model.axes['right-lower-extremity']).toBeNull();
  });

  it('carries the engineRevision through', () => {
    expect(model.engineRevision).toBe(1);
    expect(model.variantId).toBe('male');
    expect(model.metersPerWorldUnit).toBe(METERS_PER_WORLD);
  });
});

describe('buildLimbAxisModel — bent elbow geometry', () => {
  const sk = buildBentLeftArmSkeleton();
  const model = buildLimbAxisModel(sk, MALE, 2, METERS_PER_WORLD);
  const arm = model.axes['left-upper-extremity']!;

  it('preserves cumulative arc length through a 90° elbow bend', () => {
    expect(arm.jointStations['L_UpperArm']).toBeCloseTo(35, 5);
    expect(arm.jointStations['L_Forearm']).toBeCloseTo(65, 5);
    expect(arm.jointStations['L_Hand']).toBeCloseTo(90, 5);
  });
});

// ── projectOntoAxis ───────────────────────────────────────────────────────

describe('projectOntoAxis — straight arm', () => {
  const sk = buildStraightLeftArmSkeleton();
  const model = buildLimbAxisModel(sk, MALE, 1, METERS_PER_WORLD);
  const arm = model.axes['left-upper-extremity']! as LimbAxis;
  const out = createProjection();

  it('hits known s values at the bone positions', () => {
    projectOntoAxis(0, 0, 0, arm, METERS_PER_WORLD, out);
    expect(out.sCm).toBeCloseTo(5, 4); // at the shoulder
    expect(out.perpDistWorld).toBeCloseTo(0, 6);

    projectOntoAxis(0, -30, 0, arm, METERS_PER_WORLD, out);
    expect(out.sCm).toBeCloseTo(35, 4);
    expect(out.perpDistWorld).toBeCloseTo(0, 6);

    projectOntoAxis(0, -60, 0, arm, METERS_PER_WORLD, out);
    expect(out.sCm).toBeCloseTo(65, 4);

    projectOntoAxis(0, -85, 0, arm, METERS_PER_WORLD, out);
    expect(out.sCm).toBeCloseTo(90, 4);
  });

  it('reports perpendicular distance for off-axis points', () => {
    projectOntoAxis(5, -15, 0, arm, METERS_PER_WORLD, out);
    expect(out.sCm).toBeCloseTo(20, 4);
    expect(out.perpDistWorld).toBeCloseTo(5, 4);
  });

  it('clamps past-the-end points to the segment endpoint', () => {
    projectOntoAxis(0, -200, 0, arm, METERS_PER_WORLD, out);
    expect(out.sCm).toBeCloseTo(arm.totalLengthCm, 4);
  });

  it('stays continuous across a joint (ambiguity test)', () => {
    projectOntoAxis(0, -30, 0, arm, METERS_PER_WORLD, out);
    const sAt = out.sCm;
    projectOntoAxis(0, -29.999, 0, arm, METERS_PER_WORLD, out);
    const sAbove = out.sCm;
    projectOntoAxis(0, -30.001, 0, arm, METERS_PER_WORLD, out);
    const sBelow = out.sCm;
    expect(Math.abs(sAbove - sAt)).toBeLessThan(0.01);
    expect(Math.abs(sBelow - sAt)).toBeLessThan(0.01);
  });
});

describe('projectOntoAxis — bent arm', () => {
  const sk = buildBentLeftArmSkeleton();
  const model = buildLimbAxisModel(sk, MALE, 1, METERS_PER_WORLD);
  const arm = model.axes['left-upper-extremity']! as LimbAxis;
  const out = createProjection();

  it('projects a point near the bent forearm to the right cumulative s', () => {
    // Forearm runs from (0,-30,0) → (0,-30,-30). Point at (0,-30,-15) is the midpoint.
    projectOntoAxis(0, -30, -15, arm, METERS_PER_WORLD, out);
    expect(out.sCm).toBeCloseTo(50, 4); // 35 (UpperArm joint) + 15
    expect(out.perpDistWorld).toBeCloseTo(0, 6);
  });
});

// ── Side correctness (highest-value test per past bone-side bugs) ─────────

describe('buildLimbAxisModel — L/R side isolation', () => {
  const sk = buildBilateralArmSkeleton();
  const model = buildLimbAxisModel(sk, MALE, 1, METERS_PER_WORLD);
  const left = model.axes['left-upper-extremity']!;
  const right = model.axes['right-upper-extremity']!;

  it('left polyline visits only +X-side bones; right visits only -X-side bones', () => {
    expect(left.side).toBe('left');
    expect(right.side).toBe('right');
    // L_Clavicle at +5; R_Clavicle at -5.
    expect(left.points.find((p) => Math.abs(p.x - 5) < 0.001)).toBeTruthy();
    expect(left.points.find((p) => Math.abs(p.x + 5) < 0.001)).toBeFalsy();
    expect(right.points.find((p) => Math.abs(p.x + 5) < 0.001)).toBeTruthy();
    expect(right.points.find((p) => Math.abs(p.x - 5) < 0.001)).toBeFalsy();
  });
});

// ── REGION_TO_LIMB + resolveLimbIdForRegion ───────────────────────────────

describe('resolveLimbIdForRegion', () => {
  it('routes upper-extremity regions per side', () => {
    expect(resolveLimbIdForRegion('upper-arm', 'left')).toBe('left-upper-extremity');
    expect(resolveLimbIdForRegion('forearm', 'right')).toBe('right-upper-extremity');
    expect(resolveLimbIdForRegion('shoulder', 'left')).toBe('left-upper-extremity');
    expect(resolveLimbIdForRegion('hand-fingers', 'right')).toBe('right-upper-extremity');
  });

  it('routes lower-extremity regions per side', () => {
    expect(resolveLimbIdForRegion('thigh', 'left')).toBe('left-lower-extremity');
    expect(resolveLimbIdForRegion('foot-toes', 'right')).toBe('right-lower-extremity');
    expect(resolveLimbIdForRegion('hip', 'left')).toBe('left-lower-extremity');
  });

  it('routes axial regions to axial-spine regardless of side', () => {
    expect(resolveLimbIdForRegion('mid-back', 'midline')).toBe('axial-spine');
    expect(resolveLimbIdForRegion('abdomen', '')).toBe('axial-spine');
    expect(resolveLimbIdForRegion('upper-chest', 'left')).toBe('axial-spine');
  });

  it('returns null for unmapped regions and for sideless limb regions', () => {
    expect(resolveLimbIdForRegion('upper-arm', 'midline')).toBeNull();
    expect(resolveLimbIdForRegion('upper-arm', '')).toBeNull();
    expect(resolveLimbIdForRegion('upper-arm', 'bilateral')).toBeNull();
    expect(resolveLimbIdForRegion('not-a-real-region', 'left')).toBeNull();
  });

  it('covers all 20 anatomy region keys in REGION_TO_LIMB', () => {
    const expected = [
      'head-face',
      'neck',
      'shoulder',
      'upper-arm',
      'elbow',
      'forearm',
      'wrist',
      'hand-fingers',
      'upper-chest',
      'upper-back-scapular',
      'abdomen',
      'mid-back',
      'pelvis',
      'sacral-gluteal',
      'hip',
      'thigh',
      'knee',
      'lower-leg',
      'ankle',
      'foot-toes',
    ];
    for (const k of expected) expect(REGION_TO_LIMB[k]).toBeDefined();
  });
});

// ── Accumulator — round-trip with mocked texels ───────────────────────────

describe('LimbAxisAccumulator — single-finding moments', () => {
  const sk = buildStraightLeftArmSkeleton();
  const model = buildLimbAxisModel(sk, MALE, 1, METERS_PER_WORLD);
  const arm = model.axes['left-upper-extremity']!;

  it('returns burden-weighted mean equal to the seeded mean', () => {
    const acc = createLimbAxisAccumulator(model);
    // Seed 1000 unit-weight texels uniformly across 30..60 cm (the upper-arm
    // segment in cm coords). Expected mean = 45 cm.
    for (let i = 0; i < 1000; i += 1) {
      const s = 30 + (i / 999) * 30;
      acc.accumulate('left-upper-extremity', s, 1);
    }
    const profile = acc.finalize(1)['left-upper-extremity']!;
    expect(profile).toBeDefined();
    expect(profile.meanDistalCm).toBeCloseTo(45, 1);
    expect(profile.burdenCm2).toBeCloseTo(1000, 6);
    expect(profile.totalLengthCm).toBeCloseTo(arm.totalLengthCm, 5);
  });

  it('computes p50 and p95 correctly on a uniform distribution', () => {
    const acc = createLimbAxisAccumulator(model);
    // Uniform over [10, 90] cm.
    for (let i = 0; i < 1000; i += 1) {
      const s = 10 + (i / 999) * 80;
      acc.accumulate('left-upper-extremity', s, 1);
    }
    const p = acc.finalize(1)['left-upper-extremity']!;
    expect(p.p50DistalCm).toBeGreaterThan(48);
    expect(p.p50DistalCm).toBeLessThan(52);
    expect(p.p95DistalCm).toBeGreaterThan(83);
    expect(p.p95DistalCm).toBeLessThan(89);
  });

  it('splits into proximal/middle/distal thirds by limb length', () => {
    const acc = createLimbAxisAccumulator(model);
    const L = arm.totalLengthCm; // 111.25
    // Put 100 units in each third.
    for (let i = 0; i < 100; i += 1) acc.accumulate('left-upper-extremity', L * 0.1, 1);
    for (let i = 0; i < 100; i += 1) acc.accumulate('left-upper-extremity', L * 0.5, 1);
    for (let i = 0; i < 100; i += 1) acc.accumulate('left-upper-extremity', L * 0.85, 1);
    const p = acc.finalize(1)['left-upper-extremity']!;
    expect(p.proximalShareCm2).toBeCloseTo(100, 1);
    expect(p.middleShareCm2).toBeCloseTo(100, 1);
    expect(p.distalShareCm2).toBeCloseTo(100, 1);
  });

  it('records outliers separately from the main burden', () => {
    const acc = createLimbAxisAccumulator(model);
    acc.accumulate('left-upper-extremity', 45, 10);
    acc.recordOutlier('left-upper-extremity', 3);
    const p = acc.finalize(1)['left-upper-extremity']!;
    expect(p.burdenCm2).toBeCloseTo(10, 6);
    expect(p.outlierBurdenCm2).toBeCloseTo(3, 6);
  });

  it('omits limbs that received no data', () => {
    const acc = createLimbAxisAccumulator(model);
    acc.accumulate('left-upper-extremity', 45, 10);
    const out = acc.finalize(1);
    expect(out['left-upper-extremity']).toBeDefined();
    for (const limbId of ALL_LIMB_IDS) {
      if (limbId !== 'left-upper-extremity') expect(out[limbId]).toBeUndefined();
    }
  });

  it('scales by areaScale uniformly', () => {
    const acc = createLimbAxisAccumulator(model);
    for (let i = 0; i < 10; i += 1) acc.accumulate('left-upper-extremity', 45, 1);
    const p = acc.finalize(2.5)['left-upper-extremity']!;
    expect(p.burdenCm2).toBeCloseTo(25, 6);
    expect(p.proximalShareCm2 + p.middleShareCm2 + p.distalShareCm2).toBeCloseTo(25, 6);
  });
});

// ── Stddev: focal vs diffuse ──────────────────────────────────────────────

describe('LimbAxisAccumulator.classifyAndAccumulate', () => {
  const sk = buildStraightLeftArmSkeleton();
  const model = buildLimbAxisModel(sk, MALE, 1, METERS_PER_WORLD);
  const arm = model.axes['left-upper-extremity']!;

  it('returns "accumulated" and contributes to mean for on-axis points', () => {
    const acc = createLimbAxisAccumulator(model);
    // Point at upper-arm bone location → s = 35.
    const r = acc.classifyAndAccumulate('left-upper-extremity', 0, -30, 0, 10);
    expect(r).toBe('accumulated');
    const p = acc.finalize(1)['left-upper-extremity']!;
    expect(p.meanDistalCm).toBeCloseTo(35, 4);
    expect(p.burdenCm2).toBeCloseTo(10, 6);
    expect(p.outlierBurdenCm2).toBe(0);
  });

  it('returns "outlier" and routes burden to outlier bucket for far-off-axis points', () => {
    const acc = createLimbAxisAccumulator(model);
    // arm.totalLengthWorld is 111.25 (world units == cm here); threshold = 55.625.
    const farX = arm.totalLengthWorld * 0.51 + 1; // beyond OUTLIER_PERP_FRACTION
    const r = acc.classifyAndAccumulate('left-upper-extremity', farX, -30, 0, 5);
    expect(r).toBe('outlier');
    const p = acc.finalize(1)['left-upper-extremity'];
    // An outlier-only limb has zero burden — the limb gets dropped from
    // the profile map by finalize (sumW <= 0).
    expect(p).toBeUndefined();
  });

  it('keeps outlier burden visible when the limb also has accumulated paint', () => {
    const acc = createLimbAxisAccumulator(model);
    acc.classifyAndAccumulate('left-upper-extremity', 0, -30, 0, 10);
    const farX = arm.totalLengthWorld * 0.6;
    acc.classifyAndAccumulate('left-upper-extremity', farX, -30, 0, 3);
    const p = acc.finalize(1)['left-upper-extremity']!;
    expect(p.burdenCm2).toBeCloseTo(10, 6);
    expect(p.outlierBurdenCm2).toBeCloseTo(3, 6);
  });

  it('returns "no-axis" when the model has no axis for the requested limb', () => {
    const acc = createLimbAxisAccumulator(model);
    // Right side isn't present in the straight-left-arm rig.
    const r = acc.classifyAndAccumulate('right-upper-extremity', 0, -30, 0, 10);
    expect(r).toBe('no-axis');
    expect(acc.hasData()).toBe(false);
  });

  it('rejects zero or negative weights without error', () => {
    const acc = createLimbAxisAccumulator(model);
    expect(acc.classifyAndAccumulate('left-upper-extremity', 0, -30, 0, 0)).toBe('no-axis');
    expect(acc.classifyAndAccumulate('left-upper-extremity', 0, -30, 0, -1)).toBe('no-axis');
    expect(acc.hasData()).toBe(false);
  });
});

describe('LimbAxisAccumulator — diffuse vs focal', () => {
  const sk = buildStraightLeftArmSkeleton();
  const model = buildLimbAxisModel(sk, MALE, 1, METERS_PER_WORLD);

  it('reports near-zero stdDev for tightly clustered paint', () => {
    const acc = createLimbAxisAccumulator(model);
    for (let i = 0; i < 200; i += 1) acc.accumulate('left-upper-extremity', 50, 1);
    const p = acc.finalize(1)['left-upper-extremity']!;
    expect(p.stdDevDistalCm).toBeLessThan(0.6); // single bin → ~binWidth/√12
  });

  it('reports a larger stdDev for spread-out paint', () => {
    const acc = createLimbAxisAccumulator(model);
    for (let i = 0; i < 200; i += 1) {
      const s = 20 + (i / 199) * 60;
      acc.accumulate('left-upper-extremity', s, 1);
    }
    const p = acc.finalize(1)['left-upper-extremity']!;
    // Uniform on [20, 80] → stddev ≈ 60/√12 ≈ 17.3
    expect(p.stdDevDistalCm).toBeGreaterThan(15);
    expect(p.stdDevDistalCm).toBeLessThan(20);
  });
});
