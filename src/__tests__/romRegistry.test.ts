import { describe, expect, it } from 'vitest';
import {
  ROM_JOINT_ROWS,
  classifyRomValue,
  formatRomValue,
  getRomFieldDefinition,
  getRomFieldState,
  getRomJointDefinition,
  getRomPercent,
} from '../services/romRegistry';

describe('romRegistry', () => {
  it('exposes expected clinical ranges and visual planes for major motions', () => {
    const shoulderAbduction = getRomFieldDefinition('L_UpperArm', 'shoulderAbduction');
    expect(shoulderAbduction?.range).toEqual({ min: -40, max: 180 });
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
