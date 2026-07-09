import type { MovementClipId } from '../types';

/**
 * Per-clip playback speed scalars. Extracted from the body-chart movement
 * catalog (movementTimeline.ts) so the engine can expose getMovementClipSpeed
 * without dragging in the app-side timeline (which couples to pain-map
 * rendering / symptom grouping). Apps that own a richer catalog can keep it;
 * this is just the speed lookup the pose sampler needs.
 */
export const MOVEMENT_CLIP_SPEEDS: Record<MovementClipId, number> = {
  stand: 0.6,
  sit: 0.75,
  walk: 0.85,
  'walk-backward': 0.9,
  'walk-strafe-left': 0.9,
  'walk-strafe-right': 0.9,
  'crouch-walk': 0.85,
  limp: 0.75,
  'long-sit': 0.75,
  jog: 1,
  run: 1,
  'walk-relaxed': 1,
  'walk-elder': 1,
  'walk-elderly': 1,
  'walk-elderly-wobble': 1,
  catwalk: 1,
  'aerobic-dance': 1,
  idle: 1,
  'idle-passenger': 1,
  'left-knee-extension': 0.8,
  'right-knee-extension': 0.8,
  sandbox: 1,
};
