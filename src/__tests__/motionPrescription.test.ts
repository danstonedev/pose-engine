import { describe, expect, it } from 'vitest';
import {
  buildPrescribeMotionTool,
  toolArgsToPrescription,
  mergeAuthoredPrescription,
  resolveMotionPrescription,
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

  it('presentation variant (allowRomCap:false) exposes qualitative modifiers but NOT rom caps', () => {
    const t = buildPrescribeMotionTool({
      motions: MOTIONS,
      allowModifiers: true,
      allowRomCap: false,
      capJoints: CAPS,
      description: 'reason it',
    });
    const props = (t.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(['motion', 'timeScale', 'guarding', 'balanceSway']);
    expect(props.romCapJoint).toBeUndefined();
    expect(t.description).toBe('reason it');
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

  it('PRESENTATION variant keeps qualitative modifiers but drops rom caps (exam)', () => {
    const rx = toolArgsToPrescription(
      { motion: 'walk', guarding: 0.6, timeScale: 0.7, romCapJoint: 'R_Leg', romCapMaxDeg: 30 },
      { motions: MOTIONS, capJoints: CAPS, allowModifiers: true, allowRomCap: false },
    );
    expect(rx!.modifiers?.guarding).toBe(0.6);
    expect(rx!.modifiers?.timeScale).toBe(0.7);
    expect(rx!.modifiers?.romCaps).toBeUndefined(); // ROM stays engine-enforced
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

  it('field-level: authored overrides per field, AI-reasoned base fills the gaps', () => {
    // base = what the patient reasoned; authored = what the scenario pinned.
    const base: MotionPrescription = {
      motion: 'walk',
      mode: 'modify',
      modifiers: { guarding: 0.4, balanceSway: 0.3, timeScale: 0.8 },
    };
    const merged = mergeAuthoredPrescription(base, { guarding: 0.7 });
    expect(merged.modifiers).toEqual({ guarding: 0.7, balanceSway: 0.3, timeScale: 0.8 });
  });
});

describe('resolveMotionPrescription (residual overlays)', () => {
  it('folds timeScale into command.speed and carries guarding/balanceSway as overlays', () => {
    const resolved = resolveMotionPrescription({
      motion: 'walk',
      mode: 'modify',
      modifiers: { timeScale: 0.7, guarding: 0.5, balanceSway: 0.3 },
    });
    expect(resolved.command).toEqual({ action: 'play-motion', motion: 'walk', speed: 0.7 });
    expect(resolved.overlays).toEqual({ guarding: 0.5, balanceSway: 0.3 });
  });

  it('resolves pelvisShiftCm into overlays (the live lateral root offset)', () => {
    const resolved = resolveMotionPrescription({
      motion: 'walk',
      mode: 'modify',
      modifiers: { pelvisShiftCm: 8 },
    });
    expect(resolved.overlays).toEqual({ pelvisShiftCm: 8 });
  });

  it('clamps pelvisShiftCm to ±15 cm on BOTH sides (+ = the patient\'s left)', () => {
    const left = resolveMotionPrescription({
      motion: 'walk',
      mode: 'modify',
      modifiers: { pelvisShiftCm: 40 },
    });
    expect(left.overlays.pelvisShiftCm).toBe(15);
    const right = resolveMotionPrescription({
      motion: 'walk',
      mode: 'modify',
      modifiers: { pelvisShiftCm: -40 },
    });
    expect(right.overlays.pelvisShiftCm).toBe(-15);
  });

  it('resolves liveliness into overlays and clamps it to [0,1]', () => {
    const ok = resolveMotionPrescription({
      motion: 'walk',
      mode: 'modify',
      modifiers: { liveliness: 0.4 },
    });
    expect(ok.overlays).toEqual({ liveliness: 0.4 });
    const over = resolveMotionPrescription({
      motion: 'walk',
      mode: 'modify',
      modifiers: { liveliness: 5 },
    });
    expect(over.overlays.liveliness).toBe(1);
    const under = resolveMotionPrescription({
      motion: 'walk',
      mode: 'modify',
      modifiers: { liveliness: -2 },
    });
    expect(under.overlays.liveliness).toBe(0);
  });

  it('play mode drops modifiers entirely — empty overlays (liveliness too)', () => {
    const resolved = resolveMotionPrescription({
      motion: 'idle',
      mode: 'play',
      modifiers: { guarding: 0.9, pelvisShiftCm: 10, liveliness: 0.4 },
    });
    expect(resolved.overlays).toEqual({});
    expect(resolved.command).toEqual({ action: 'play-motion', motion: 'idle' });
  });

  it('parked fields (weightBearing / assistiveSupport) are NOT carried into overlays', () => {
    // Overlays are the runtime surface — only fields the stage actually consumes
    // may ride it; parked contract fields stay on ClinicalModifiers alone.
    const resolved = resolveMotionPrescription({
      motion: 'walk',
      mode: 'modify',
      modifiers: {
        guarding: 0.4,
        weightBearing: { left: 'reduced' },
        assistiveSupport: ['cane'],
      },
    });
    expect(resolved.overlays).toEqual({ guarding: 0.4 });
    expect(resolved.romCaps).toEqual([]);
  });
});
