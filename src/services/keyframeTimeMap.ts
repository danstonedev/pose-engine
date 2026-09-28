/**
 * KEYFRAME TIME MAP — re-timing ms-declared times from one keyframe clock onto another.
 *
 * A motion declares its foot-contact windows, stance windows and heading profile in ms on the clock of its keyframes.
 * When the keyframes are re-timed, those times must move with the keyframe instants they were written for: the
 * resolver re-times the authored keyframes (the realistic-velocity floor stretches a move, `MAX_KEYFRAME_MS` caps a
 * move or a hold), and the trajectory paces the resolved ones and caps a paced hold again.
 *
 * The map is piecewise linear, KEYFRAME BY KEYFRAME and span by span: each keyframe's move maps onto its move, and
 * its hold onto its hold. A time at a keyframe's arrival (the end of its move, where its hold begins) or at the end of
 * its hold therefore maps exactly onto the same instant on the other clock, however differently the two spans were
 * re-timed. A time after a shortened keyframe shifts by the time removed rather than being scaled. Stretching a whole
 * keyframe evenly (its move and hold together), as the resolver did, moved a window written for a keyframe's arrival
 * whenever only its hold was capped or only its move was floored.
 *
 * Pure: no three.js, no rig.
 */

/** A keyframe's two spans on one clock: its move (`durationMs`), then its hold (`holdMs`). */
export interface KeyframeSpans {
  durationMs: number;
  holdMs: number;
}

/** A time on the first clock → the same keyframe instant on the second. */
export type KeyframeTimeMap = (tMs: number) => number;

/**
 * The map from the keyframe clock `from` onto `to` (parallel lists, keyframe for keyframe), or `null` when no span
 * boundary moved, so a caller skips the re-timing and stays byte-identical. Within a span, time is interpolated
 * linearly; past the last keyframe, the tail keeps its distance from the end. Zero, negative and non-finite times
 * (whole-motion windows are ±Infinity) pass through unchanged.
 */
export function buildKeyframeTimeMap(from: readonly KeyframeSpans[], to: readonly KeyframeSpans[]): KeyframeTimeMap | null {
  const n = Math.min(from.length, to.length);
  const fromBounds: number[] = [];
  const toBounds: number[] = [];
  let a = 0;
  let b = 0;
  let moved = false;
  for (let i = 0; i < n; i += 1) {
    const spans: [number, number][] = [
      [from[i]!.durationMs, to[i]!.durationMs],
      [from[i]!.holdMs, to[i]!.holdMs],
    ];
    for (const [fromMs, toMs] of spans) {
      a += fromMs;
      b += toMs;
      fromBounds.push(a);
      toBounds.push(b);
      if (a !== b) moved = true;
    }
  }
  if (!moved) return null;
  return (tMs: number): number => {
    if (!Number.isFinite(tMs) || tMs <= 0) return tMs;
    let prevA = 0;
    let prevB = 0;
    for (let j = 0; j < fromBounds.length; j += 1) {
      if (tMs <= fromBounds[j]! + 1e-9) {
        const span = fromBounds[j]! - prevA;
        const frac = span > 0 ? (tMs - prevA) / span : 0;
        return prevB + frac * (toBounds[j]! - prevB);
      }
      prevA = fromBounds[j]!;
      prevB = toBounds[j]!;
    }
    return tMs + (prevB - prevA);
  };
}
