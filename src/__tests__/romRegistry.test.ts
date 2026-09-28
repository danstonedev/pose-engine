import { describe, expect, it } from 'vitest';
import {
  ROM_JOINT_ROWS,
  classifyRomValue,
  effectiveRomRange,
  formatRomValue,
  getRomFieldDefinition,
  getRomFieldState,
  getRomJointDefinition,
  getRomPercent,
  thighCodmanTwistDeg,
  thighRotationRange,
} from '../services/romRegistry';

describe('romRegistry', () => {
  it('exposes expected clinical ranges and visual planes for major motions', () => {
    const shoulderAbduction = getRomFieldDefinition('L_UpperArm', 'shoulderAbduction');
    expect(shoulderAbduction?.range).toEqual({ min: -50, max: 180 });
    expect(shoulderAbduction?.plane).toBe('frontal');

    const elbowFlexion = getRomFieldDefinition('R_Forearm', 'elbowFlexion');
    expect(elbowFlexion?.range).toEqual({ min: 0, max: 150 });
    expect(elbowFlexion?.plane).toBe('sagittal');

    const hipRotation = getRomFieldDefinition('R_UpLeg', 'hipRotation');
    expect(hipRotation?.range).toEqual({ min: -45, max: 45 });
    expect(hipRotation?.plane).toBe('transverse');
  });

  it('classifies neutral, within-range, near-limit, and outside values', () => {
    const elbow = getRomFieldDefinition('L_Forearm', 'elbowFlexion');
    expect(elbow).toBeDefined();
    if (!elbow) return;

    expect(classifyRomValue(0, elbow).status).toBe('neutral');
    expect(classifyRomValue(90, elbow).status).toBe('within');
    expect(classifyRomValue(145, elbow)).toMatchObject({
      status: 'near-limit',
      limitSide: 'max',
    });
    expect(classifyRomValue(160, elbow)).toMatchObject({
      status: 'outside',
      limitSide: 'max',
      outOfRangeByDeg: 10,
    });
  });

  it('computes stable marker positions for asymmetric ranges', () => {
    const ankle = getRomFieldDefinition('R_Foot', 'ankleFlexion');
    expect(ankle).toBeDefined();
    if (!ankle) return;

    expect(getRomPercent(ankle.range.min, ankle.range)).toBe(0);
    expect(getRomPercent(ankle.range.max, ankle.range)).toBe(100);

    const state = getRomFieldState(0, ankle);
    expect(state.zeroPercent).toBeCloseTo(71.43, 2);
    expect(state.valuePercent).toBeCloseTo(state.zeroPercent, 2);
  });

  it('formats signed values with clinical direction labels', () => {
    const wrist = getRomFieldDefinition('L_Hand', 'wristDeviation');
    expect(wrist).toBeDefined();
    if (!wrist) return;

    expect(formatRomValue(15, wrist)).toBe('Radial 15 deg');
    expect(formatRomValue(-20, wrist)).toBe('Ulnar 20 deg');
    expect(formatRomValue(0.2, wrist)).toBe('0 deg');
  });

  it('keeps every registry row internally valid', () => {
    for (const row of ROM_JOINT_ROWS) {
      expect(getRomJointDefinition(row.canonicalKey)).toBe(row);
      expect(row.fields.length).toBeGreaterThan(0);
      for (const field of row.fields) {
        expect(field.range.min).toBeLessThan(field.range.max);
        expect(getRomFieldDefinition(row.canonicalKey, field.key)).toBe(field);
      }
    }
  });
});

describe('the hip rotation band follows the thigh', () => {
  const hip = getRomFieldDefinition('R_UpLeg', 'hipRotation')!;
  const band = (flexionDeg: number, abductionDeg: number) => effectiveRomRange(hip, { thigh: { flexionDeg, abductionDeg } });

  it('is the plain ±45° band with the thigh hanging, straight ahead, or behind', () => {
    expect(band(0, 0)).toEqual({ min: -45, max: 45 });
    // Seated, and supine 90/90: where hip rotation is measured.
    expect(band(90, 0)).toEqual({ min: -45, max: 45 });
    expect(band(30, 0)).toEqual({ min: -45, max: 45 });
    // Extended, the thigh is not flexed: no seated frame.
    const extended = band(-20, 0);
    expect(extended.min).toBeCloseTo(-45, 6);
    expect(extended.max).toBeCloseTo(45, 6);
    // Without the thigh, the band a caller always had.
    expect(effectiveRomRange(hip)).toEqual({ min: -45, max: 45 });
  });

  it('turns out further by as far as a flexed thigh is opened out, and in further as it is carried across', () => {
    // Flexed 90°, the hip's abduction is the opening itself: sitting cross-legged opens it about 45°.
    expect(thighCodmanTwistDeg({ flexionDeg: 90, abductionDeg: 45 })).toBeCloseTo(45, 6);
    expect(band(90, 45).min).toBeCloseTo(-90, 6);
    expect(band(90, 45).max).toBe(45);
    // FADIR: flexed 90° and carried 20° across the body.
    expect(band(90, -20).min).toBe(-45);
    expect(band(90, -20).max).toBeCloseTo(65, 6);
    // Neither side ever narrows.
    for (const [f, a] of [[45, 40], [10, 39], [120, -30], [-30, 45], [0, -30]] as const) {
      expect(band(f, a).min).toBeLessThanOrEqual(-45);
      expect(band(f, a).max).toBeGreaterThanOrEqual(45);
    }
  });

  it('holds the figure-4 as the runtime models reach it: the knee 8 cm to 30 cm above the table', () => {
    // [flexion, abduction, rotation] the male and female models need with the ankle on the other knee (rig-solved).
    for (const [f, a, r] of [[7.2, 39.1, -105.4], [11.9, 39.7, -102.7], [26.4, 40, -94], [42.7, 36.9, -83.3], [8.7, 39.4, -105], [46, 36.1, -81.5]]) {
      const { min } = band(f, a);
      expect(r, `flexion ${f}, abduction ${a}`).toBeGreaterThanOrEqual(min);
      // ...which, from the seated frame, is an ordinary external rotation (20° to 36°).
      expect(r + thighCodmanTwistDeg({ flexionDeg: f, abductionDeg: a })).toBeGreaterThan(-45);
    }
    // Held to the plain band, the same figure-4 is out of range.
    expect(-83.3).toBeLessThan(hip.range.min);
  });

  it('keeps the plain band standing and walking, within 25° of hanging straight', () => {
    // Among them a turning walk's planted hip, where the foot-plant IK clamps its rotation.
    for (const [f, a] of [[0.5, 0.5], [0, 1], [13, 1], [16, -3], [21, -6], [-10, 20], [0, 24]] as const) {
      expect(band(f, a), `flexion ${f}, abduction ${a}`).toEqual({ min: -45, max: 45 });
    }
  });

  it('takes the seated frame over continuously, between 25° and 40° of swing', () => {
    // Straight out to the side (the whole opening, 90°), the thigh swings as far as it is abducted.
    expect(band(0, 25).min).toBeCloseTo(-45, 6);
    expect(band(0, 40).min).toBeCloseTo(-135, 6);
    for (let abduction = 25; abduction < 40; abduction += 0.5) {
      const step = band(0, abduction).min - band(0, abduction + 0.5).min;
      expect(step, `abducted ${abduction}°`).toBeGreaterThanOrEqual(0);
      expect(step, `abducted ${abduction}°`).toBeLessThanOrEqual(3 + 1e-9);
    }
    expect(thighRotationRange({ min: -45, max: 45 }, { flexionDeg: 0, abductionDeg: 0 })).toEqual({ min: -45, max: 45 });
  });

  it('applies only to the hip rotation', () => {
    const thigh = { flexionDeg: 90, abductionDeg: 45 };
    for (const [joint, motion] of [['R_UpLeg', 'hipFlexion'], ['R_UpLeg', 'hipAbduction'], ['R_UpperArm', 'shoulderRotation'], ['R_Leg', 'kneeRotation']] as const) {
      const def = getRomFieldDefinition(joint, motion)!;
      expect(effectiveRomRange(def, { thigh }), `${joint}.${motion}`).toEqual(def.range);
    }
    expect(effectiveRomRange(getRomFieldDefinition('L_UpLeg', 'hipRotation')!, { thigh }).min).toBeCloseTo(-90, 6);
  });
});
