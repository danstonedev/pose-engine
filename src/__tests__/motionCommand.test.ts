/**
 * Named basic-motion command seam (simLAB A2 — "walk" / "sit" / "stand").
 *
 * Pure tests: the motion catalog, command resolution, override folding, and
 * catalog↔union integrity. No three / no GLB — the clip-driven stage wiring is
 * gated on the asset pack (see motionCommand.ts TODOs) and is exercised
 * separately once real clips land.
 */
import { describe, expect, it } from 'vitest';
import {
  BASIC_MOTIONS,
  LOCOMOTION_MOTIONS,
  MOTION_CLIP_DEFINITIONS,
  POSTURE_MOTIONS,
  getMotionClipDefinition,
  isMotionCommandSupported,
  listSupportedMotionCommands,
  motionStartStatus,
  resolveMotionCommand,
  type MotionCommand,
} from '../services/motionCommand';
import { MOVEMENT_CLIP_SPEEDS } from '../services/movementClips';

const ALL_IDS = Object.keys(MOVEMENT_CLIP_SPEEDS);

describe('MOTION_CLIP_DEFINITIONS integrity', () => {
  it('defines every MovementClipId (catalog ↔ union never drift)', () => {
    for (const id of ALL_IDS) {
      expect(MOTION_CLIP_DEFINITIONS[id as keyof typeof MOTION_CLIP_DEFINITIONS]).toBeDefined();
    }
    expect(Object.keys(MOTION_CLIP_DEFINITIONS).sort()).toEqual([...ALL_IDS].sort());
  });

  it('sources speed from the shared MOVEMENT_CLIP_SPEEDS catalog (one truth)', () => {
    for (const def of Object.values(MOTION_CLIP_DEFINITIONS)) {
      expect(def.speed).toBe(MOVEMENT_CLIP_SPEEDS[def.id]);
    }
  });

  it('keys match their definition id', () => {
    for (const [key, def] of Object.entries(MOTION_CLIP_DEFINITIONS)) {
      expect(def.id).toBe(key);
    }
  });

  it('classifies the basic motions correctly', () => {
    expect(MOTION_CLIP_DEFINITIONS.walk.kind).toBe('locomotion');
    expect(MOTION_CLIP_DEFINITIONS.walk.loop).toBe('repeat');
    expect(MOTION_CLIP_DEFINITIONS.sit.kind).toBe('posture-transition');
    expect(MOTION_CLIP_DEFINITIONS.sit.loop).toBe('once');
    expect(MOTION_CLIP_DEFINITIONS.stand.kind).toBe('posture-hold');
    expect(MOTION_CLIP_DEFINITIONS.stand.loop).toBe('repeat');
  });
});

describe('motion groupings', () => {
  it('BASIC_MOTIONS is exactly stand / sit / walk', () => {
    expect([...BASIC_MOTIONS].sort()).toEqual(['sit', 'stand', 'walk']);
  });

  it('locomotion + posture partitions cover their kinds', () => {
    expect(LOCOMOTION_MOTIONS).toContain('walk');
    expect(LOCOMOTION_MOTIONS).toContain('jog');
    expect(LOCOMOTION_MOTIONS).not.toContain('sit');
    expect(POSTURE_MOTIONS).toContain('sit');
    expect(POSTURE_MOTIONS).toContain('stand');
    expect(POSTURE_MOTIONS).not.toContain('walk');
  });
});

describe('isMotionCommandSupported / getMotionClipDefinition', () => {
  it('accepts known motions and narrows the type', () => {
    expect(isMotionCommandSupported('walk')).toBe(true);
    expect(getMotionClipDefinition('walk')?.label).toBe('Walk');
  });
  it('rejects unknown motions', () => {
    expect(isMotionCommandSupported('backflip')).toBe(false);
    expect(getMotionClipDefinition('backflip')).toBeUndefined();
  });
});

describe('listSupportedMotionCommands', () => {
  it('lists one entry per catalog motion', () => {
    expect(listSupportedMotionCommands()).toHaveLength(ALL_IDS.length);
  });
});

describe('resolveMotionCommand', () => {
  it('resolves a known play-motion with definition defaults', () => {
    const r = resolveMotionCommand({ action: 'play-motion', motion: 'walk' });
    expect(r.status).toBe('ready');
    expect(r.motion).toBe('walk');
    expect(r.loop).toBe('repeat');
    expect(r.speed).toBe(MOVEMENT_CLIP_SPEEDS.walk);
    expect(r.definition?.kind).toBe('locomotion');
  });

  it('folds in per-invocation loop + speed overrides', () => {
    const r = resolveMotionCommand({ action: 'play-motion', motion: 'walk', loop: 'once', speed: 1.5 });
    expect(r.status).toBe('ready');
    expect(r.loop).toBe('once');
    expect(r.speed).toBe(1.5);
  });

  it('ignores a non-finite / non-positive speed override, keeping the default', () => {
    const bad = resolveMotionCommand({ action: 'play-motion', motion: 'sit', speed: 0 });
    expect(bad.speed).toBe(MOVEMENT_CLIP_SPEEDS.sit);
    const nan = resolveMotionCommand({ action: 'play-motion', motion: 'sit', speed: Number.NaN });
    expect(nan.speed).toBe(MOVEMENT_CLIP_SPEEDS.sit);
  });

  it('refuses an unknown motion', () => {
    const r = resolveMotionCommand({ action: 'play-motion', motion: 'backflip' as never });
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('unknown-motion');
  });

  it('resolves stop-motion to a stop with no motion payload', () => {
    const r = resolveMotionCommand({ action: 'stop-motion' });
    expect(r.status).toBe('stop');
    expect(r.motion).toBeUndefined();
  });
});

describe('motionStartStatus', () => {
  it('maps loop policy to the terminal start status', () => {
    expect(motionStartStatus('repeat')).toBe('playing');
    expect(motionStartStatus('once')).toBe('completed');
  });
});

// A stop-motion command is structurally valid without a motion field — a
// compile-time sanity anchor for the union shape hosts mirror.
const _stop: MotionCommand = { action: 'stop-motion' };
void _stop;
