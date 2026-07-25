/**
 * DRIVER OWNERSHIP — one authority for "what is driving the skeleton?".
 *
 * The live stage has four mechanisms that can move the mannequin: a mixer CLIP,
 * a COMPOSED keyframe motion, an exam pose TWEEN, and the composed motion's
 * TRAJECTORY player. Before this module those were four independent booleans
 * scattered through the component, and every consumer had to remember all four:
 * the idle-liveliness gate asked `!activeMotionId && !composedActive &&
 * !activeTween && !activeTrajectory`, and a fifth condition (the posing layer)
 * had to be remembered separately. Adding a mechanism meant finding every such
 * site. That is the structural defect this module removes: **`idle` is now one
 * question**, and a mechanism registers itself in exactly one place.
 *
 * It also owns the COMMAND GENERATION — the supersession counter that makes a
 * stale async command unable to win a race. Any takeover (a new command, or an
 * out-of-band Stop) calls {@link StageDriver.supersede}; any command that
 * awaits something re-checks its {@link DriverClaim} afterwards and bails if a
 * newer command arrived while it was suspended. The composed path always had
 * this discipline; the clip path did not, which is the bug it fixes:
 *
 *   Stop during an UNCACHED clip load used to be a complete no-op — the Stop
 *   handler only bumped the counter when a COMPOSED motion was active, and the
 *   clip had not started yet, so there was nothing for it to stop. When the
 *   load resolved, the superseded clip played anyway.
 *
 * Pure state with no scene access, so the whole ownership model is unit
 * testable — which the stage component itself is not.
 */

/** A mechanism that can drive the skeleton. */
export type DriverMechanism = 'clip' | 'composed' | 'tween' | 'trajectory';

/**
 * A snapshot of the command generation, taken before an await and re-checked
 * after it. Opaque on purpose: callers compare it through
 * {@link StageDriver.holds}, never by reading the number.
 */
export interface DriverClaim {
  readonly seq: number;
}

export interface StageDriver {
  /** Snapshot the current generation. Re-check with {@link holds} after any await. */
  snapshot(): DriverClaim;
  /** True while NO newer command has taken the skeleton since `claim` was taken. */
  holds(claim: DriverClaim): boolean;
  /**
   * A new command — or an out-of-band Stop — takes the skeleton. Every existing
   * claim is superseded from here on. Returns the new generation.
   */
  supersede(): number;
  /**
   * Mark a generation as explicitly USER-CANCELLED (Stop), so a command awaiting
   * that generation can report 'cancelled' rather than the weaker 'interrupted'.
   */
  markCancelled(seq: number): void;
  /** True when `seq` was explicitly cancelled rather than merely superseded. */
  wasCancelled(seq: number): boolean;
  /** Forget any cancellation mark (the awaiting command consumed it). */
  clearCancelled(): void;
  /** Register or clear a running mechanism. */
  setRunning(mechanism: DriverMechanism, on: boolean): void;
  /** True while `mechanism` is running. */
  isRunning(mechanism: DriverMechanism): boolean;
  /**
   * THE idle question: nothing is driving the skeleton. Replaces the four-way
   * boolean test the render loop used to spell out. (The posing layer is a
   * separate, host-owned suspension — the stage still ANDs it in.)
   */
  readonly idle: boolean;
  /** The running mechanisms, for diagnostics — stable order, never mutated. */
  readonly running: readonly DriverMechanism[];
  /** The current command generation. */
  readonly seq: number;
}

const ORDER: readonly DriverMechanism[] = ['clip', 'composed', 'tween', 'trajectory'];

export function createStageDriver(): StageDriver {
  let seq = 0;
  let cancelledSeq: number | null = null;
  const running = new Set<DriverMechanism>();

  return {
    snapshot() {
      return { seq };
    },
    holds(claim) {
      return claim.seq === seq;
    },
    supersede() {
      seq += 1;
      return seq;
    },
    markCancelled(s) {
      cancelledSeq = s;
    },
    wasCancelled(s) {
      return cancelledSeq === s;
    },
    clearCancelled() {
      cancelledSeq = null;
    },
    setRunning(mechanism, on) {
      if (on) running.add(mechanism);
      else running.delete(mechanism);
    },
    isRunning(mechanism) {
      return running.has(mechanism);
    },
    get idle() {
      return running.size === 0;
    },
    get running() {
      return ORDER.filter((m) => running.has(m));
    },
    get seq() {
      return seq;
    },
  };
}
