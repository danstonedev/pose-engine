import type { MovementStep, ScreenPattern } from '../domain/types';

/**
 * The movement screen (the FMS and the SFMA) on the 3D patient. Each pattern plays as one step from pose-engine's
 * library, the one simMOVE's Screen plays (the motion is built in the lazily loaded sampler, ./screenMotions, so the
 * engine never enters the main bundle): standing, or laid on the floor by its own motion, with the screening kit the
 * protocol uses (../props/equipment).
 */

/** Where the pattern is watched from: square to its front, or with its side toward the camera. */
export type ScreenView = 'front' | 'side';

/**
 * How far a screen step is turned to the camera (./present: 0 faces it, +90 turns the patient's right side to it):
 * facing it, or with the chosen side toward it (the right, for a pattern whose side does not matter). A pattern lying
 * down or on hands and knees runs along the floor, so it is always watched from the side.
 */
export function screenYawDeg(pattern: Pick<ScreenPattern, 'side' | 'posture'>, view: ScreenView): number {
  if (view === 'front' && pattern.posture === 'standing') return 0;
  return pattern.side === 'L' ? -90 : 90;
}

/** A pattern as one step on the 3D patient, watched from `view`. */
export function screenStep(label: string, pattern: ScreenPattern, view: ScreenView = 'front'): MovementStep {
  return {
    label, mode: 'active', posture: 'standing', base: [], frames: [], tested: [],
    screen: { ...pattern, equipment: pattern.equipment.map(item => ({ ...item })) },
    presentYawDeg: screenYawDeg(pattern, view),
  };
}

/**
 * Where a pattern's motion, as authored, takes the hands, the elbows or the toes below the surface the patient is on
 * (the floor, or the board they stand on): the deepest a joint centre of that part goes on either body model, to the
 * nearest centimetre. These are joint landmarks; passing them does not establish skin clearance.
 * The stage never corrects a pattern; it plays as simMOVE authored it.
 * The Exam audit names these so a reviewer does not take them for the stage's doing, and the physics tests measure
 * them and fail when the library's motion changes them. Keyed by the pattern's id.
 */
export const SCREEN_BELOW_SURFACE: Readonly<Record<string, Readonly<Partial<Record<'hands' | 'elbows' | 'toes', number>>>>> = {
  'fms-repo-legacy-v1/in-line-lunge/in-line-lunge': { toes: 6 },
  'fms-repo-legacy-v1/rotary-stability/rotary-stability': { hands: 8, toes: 3 },
  'fms-repo-legacy-v1/rotary-stability/flexion-clearing': { toes: 5 },
};
