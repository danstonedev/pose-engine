import { describe, expect, it } from 'vitest';
import { defineBodyControl, inspectBodyControl, MAJOR_BODY_JOINTS } from '../services/movementControl';

const heldPhase = () => defineBodyControl({
  id: 'rest', root: { translation: 'fixed', orientation: 'fixed' }, supports: [],
  groups: [{ joints: MAJOR_BODY_JOINTS, role: 'held', purpose: 'Hold the entry pose relative to the parent.' }],
});

describe('body control authoring contract', () => {
  it('detects an omitted segment and duplicate ownership instead of filling defaults', () => {
    expect(() => defineBodyControl({
      ...heldPhase(), groups: [{ joints: ['Hips'], role: 'driven', purpose: 'Articulate pelvis.' }],
    })).toThrow('Missing control role: Spine_Lower');
    expect(() => defineBodyControl({
      ...heldPhase(), groups: [
        { joints: MAJOR_BODY_JOINTS, role: 'held', purpose: 'Hold.' },
        { joints: ['Hips'], role: 'driven', purpose: 'Tilt.' },
      ],
    })).toThrow('Duplicate control role: Hips');
  });

  it('does not count a role as proof of a target, a companion, or a solved contact', () => {
    const phase = heldPhase();
    phase.joints.Hips = { role: 'driven', purpose: 'Tilt pelvis.' };
    phase.joints.Spine_Mid = { role: 'derived', source: 'Spine_Mid', purpose: 'Follow thorax.' };
    phase.joints.L_Foot = { role: 'contact', support: 'floor', purpose: 'Bear weight.' };
    expect(inspectBodyControl(phase, [])).toEqual([
      'Driver has no authored target: Hips',
      'Invalid controller source: Spine_Mid',
      'Undeclared support: L_Foot',
    ]);
    phase.joints.Spine_Mid.source = 'Spine_Upper';
    phase.supports.push('floor');
    expect(inspectBodyControl(phase, [{ joint: 'Hips' }])).toEqual([]);
  });
});
