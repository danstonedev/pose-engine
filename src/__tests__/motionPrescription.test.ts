import { describe, expect, it } from 'vitest';
import {
  buildPrescribeMotionTool,
  toolArgsToPrescription,
  mergeAuthoredPrescription,
  type MotionCapJoint,
  type MotionPrescription,
} from '../services/motionPrescription';

const MOTIONS = ['idle', 'walk', 'run'] as const;
const CAPS: MotionCapJoint[] = [
  { joint: 'R_Leg', field: 'kneeFlexion', label: 'right knee flexion', maxDeg: 140 },
  { joint: 'Spine_Lower', field: 'flexion', label: 'trunk flexion', maxDeg: 90 },
];

describe('buildPrescribeMotionTool', () => {
  it('full variant exposes modifiers + rom-cap enum and is named prescribe_motion', () => {
    const t = buildPrescribeMotionTool({ motions: MOTIONS, allowModifiers: true, capJoints: CAPS });
    expect(t.name).toBe('prescribe_motion');
    const props = (t.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['motion', 'timeScale', 'romCapJoint', 'romCapMaxDeg', 'guarding', 'balanceSway']),
    );
    expect((props.motion as { enum: string[] }).enum).toEqual(['idle', 'walk', 'run']);
    expect((props.romCapJoint as { enum: string[] }).enum).toEqual(['R_Leg', 'Spine_Lower']);
  });

  it('intent-only variant is motion-only and named attempt_motion (the exam patient)', () => {
    const t = buildPrescribeMotionTool({ motions: MOTIONS, allowModifiers: false });
    expect(t.name).toBe('attempt_motion');
    const props = (t.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(['motion']);
  });

  it('name override wins', () => {
    const t = buildPrescribeMotionTool({ motions: MOTIONS, name: 'move' });
    expect(t.name).toBe('move');
  });
});

describe('toolArgsToPrescription', () => {
  const full = { motions: MOTIONS, capJoints: CAPS, allowModifiers: true } as const;

  it('maps motion + modifiers and clamps out-of-range values', () => {
    const rx = toolArgsToPrescription(
      { motion: 'walk', timeScale: 3, romCapJoint: 'R_Leg', romCapMaxDeg: 400, guarding: 2, balanceSway: 0.5 },
      full,
    );
    expect(rx).not.toBeNull();
    expect(rx!.motion).toBe('walk');
    expect(rx!.mode).toBe('modify');
    expect(rx!.modifiers?.timeScale).toBe(1.5); // clamped to [0.4,1.5]
    expect(rx!.modifiers?.romCaps?.[0]).toEqual({ joint: 'R_Leg', field: 'kneeFlexion', maxDeg: 140 });
    expect(rx!.modifiers?.guarding).toBe(1); // clamped to [0,1]
    expect(rx!.modifiers?.balanceSway).toBe(0.5);
  });

  it('drops a rom cap when the joint is not offered', () => {
    const rx = toolArgsToPrescription({ motion: 'walk', romCapJoint: 'L_Leg', romCapMaxDeg: 30 }, full);
    expect(rx!.modifiers?.romCaps).toBeUndefined();
  });

  it('unmodified request resolves to play mode', () => {
    const rx = toolArgsToPrescription({ motion: 'idle' }, full);
    expect(rx).toEqual({ motion: 'idle', mode: 'play' });
  });

  it('INTENT-ONLY ignores any modifier args — the patient cannot author findings', () => {
    const rx = toolArgsToPrescription(
      { motion: 'walk', guarding: 0.9, timeScale: 0.5, romCapJoint: 'R_Leg', romCapMaxDeg: 30 },
      { motions: MOTIONS, capJoints: CAPS, allowModifiers: false },
    );
    expect(rx).toEqual({ motion: 'walk', mode: 'play' });
  });

  it('returns null on an unknown or missing motion', () => {
    expect(toolArgsToPrescription({ motion: 'moonwalk' }, full)).toBeNull();
    expect(toolArgsToPrescription({}, full)).toBeNull();
  });
});

describe('mergeAuthoredPrescription (the exam merge)', () => {
  it('keeps the patient-chosen motion but takes the scenario-authored findings', () => {
    const patient: MotionPrescription = { motion: 'walk', mode: 'play' };
    const merged = mergeAuthoredPrescription(patient, {
      guarding: 0.6,
      romCaps: [{ joint: 'R_Leg', field: 'kneeFlexion', maxDeg: 40 }],
    });
    expect(merged.motion).toBe('walk');
    expect(merged.mode).toBe('modify');
    expect(merged.modifiers?.guarding).toBe(0.6);
    expect(merged.modifiers?.romCaps?.[0].maxDeg).toBe(40);
  });

  it('no authored modifiers → play mode', () => {
    const merged = mergeAuthoredPrescription({ motion: 'idle', mode: 'play' }, null);
    expect(merged).toEqual({ motion: 'idle', mode: 'play' });
  });
});
