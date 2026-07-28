/**
 * SHARED MOTION-PLAYBACK CONSTANTS — the tuning that is read on BOTH sides of the
 * resolve/playback split (services/motionSequence, services/motionRecording,
 * services/motionTrajectory) AND by the gait modifiers that retime a built
 * motion (services/gaitModifiers).
 *
 * Sibling of {@link ./gaitConstants} and the same rule applies: this module is a
 * dependency-free leaf so any layer can read it without an import cycle, and it
 * stays deliberately tiny. Tuning that serves ONE module belongs next to that
 * module, not here — what earns a place here is a value that two layers must
 * agree on, where a silent disagreement would be a bug rather than a preference.
 */

/** Slowest playback the engine will honour (0.4x). Below this a clinical motion
 *  reads as a freeze-frame rather than a slow demonstration. */
export const TIME_SCALE_MIN = 0.4;

/** Fastest playback the engine will honour (1.5x). Above this the velocity-class
 *  caps in motionSequence start refusing keyframes anyway, so the clamp is the
 *  honest ceiling rather than a preference. */
export const TIME_SCALE_MAX = 1.5;

/**
 * Clamp a requested playback time-scale into `[TIME_SCALE_MIN, TIME_SCALE_MAX]`.
 *
 * A missing or non-finite request means "unset" and resolves to 1 (real time);
 * an explicit, finite request is clamped, so a deliberate 0 floors to
 * `TIME_SCALE_MIN` rather than silently snapping back to real time.
 *
 * This ONE function replaces five hand-inlined copies of the same clamp that had
 * drifted into three different null/NaN behaviours (`?? 1` passed NaN straight
 * through `Math.max` and poisoned the result; `|| 1` additionally swallowed an
 * explicit 0). Callers that need the raw bounds import the constants above.
 */
export function clampTimeScale(requested: unknown): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? requested : 1;
  return n < TIME_SCALE_MIN ? TIME_SCALE_MIN : n > TIME_SCALE_MAX ? TIME_SCALE_MAX : n;
}
