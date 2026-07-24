/**
 * Shared breath / exertion clock for the live stage — extracted from
 * ExamStage3D. One owner for the state that BOTH breathing overlays (idle +
 * motion-time) and the exertion feed read, so the breath never restarts or
 * rate-jumps when a motion begins or ends.
 *
 *  - `phase`         the INTEGRATED FM breath phase (advanceBreathPhase — never
 *                    t×rate, so a rate change mid-breath is phase-continuous).
 *  - `exertion`      the 0..1 accumulator stepped each frame (rises while a
 *                    composed motion plays at its measured work intensity,
 *                    decays over ~45 s at rest).
 *  - `workIntensity` the playing motion's intensity (0 when idle).
 *
 * Pure state holder over the services/liveliness math; deterministic.
 */
import { advanceBreathPhase, stepExertion as stepExertionFn } from './liveliness';

export interface BreathState {
  /** Integrated FM breath phase (phase-continuous). */
  readonly phase: number;
  /** 0..1 exertion accumulator. */
  readonly exertion: number;
  /** The playing motion's measured work intensity (0 when idle). */
  readonly workIntensity: number;
  /** Advance the breath phase one frame at the current exertion. */
  advancePhase(dtSec: number): void;
  /** Step the exertion accumulator toward `activeIntensity` (framerate-indep). */
  stepExertion(activeIntensity: number, dtSec: number): void;
  /** Set the playing motion's work intensity (0 stops the exertion feed). */
  setWorkIntensity(v: number): void;
}

export function createBreathState(): BreathState {
  let phase = 0;
  let exertion = 0;
  let workIntensity = 0;
  return {
    get phase() {
      return phase;
    },
    get exertion() {
      return exertion;
    },
    get workIntensity() {
      return workIntensity;
    },
    advancePhase(dtSec: number) {
      phase = advanceBreathPhase(phase, dtSec, exertion);
    },
    stepExertion(activeIntensity: number, dtSec: number) {
      exertion = stepExertionFn(exertion, activeIntensity, dtSec);
    },
    setWorkIntensity(v: number) {
      workIntensity = v;
    },
  };
}
