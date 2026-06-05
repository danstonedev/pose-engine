/**
 * Click-vs-drag deselect for pose editing.
 *
 * Clicking empty space while a joint is selected should dismiss the gizmo, but
 * DRAGGING empty space (an orbit) must keep the selection. This is the small
 * state machine that distinguishes the two, factored out so body-chart and the
 * aquatic simulator behave identically.
 *
 * Pure logic — no DOM, no THREE. Wire it from the host's pointer handlers:
 *   - pointerdown over empty space while something is selected → `arm(...)`
 *   - pointermove → `handleMove(...)` (cancels the pending deselect once the
 *     pointer drags past the threshold — i.e. the user is orbiting)
 *   - pointerup → if `shouldDeselect(...)` returns true, clear the selection
 */
export class PoseClickDeselect {
  private armed: { pointerId: number; x: number; y: number } | null = null;

  /** @param thresholdPx drag distance beyond which a press is an orbit, not a click. */
  constructor(private readonly thresholdPx = 5) {}

  /** Arm a pending deselect at the pointerdown location. */
  arm(pointerId: number, x: number, y: number): void {
    this.armed = { pointerId, x, y };
  }

  /** Cancel the pending deselect if the pointer has dragged past the threshold
   *  (an orbit, not a click). No-op for other pointers or when not armed. */
  handleMove(pointerId: number, x: number, y: number): void {
    if (!this.armed || this.armed.pointerId !== pointerId) return;
    const dx = x - this.armed.x;
    const dy = y - this.armed.y;
    if (dx * dx + dy * dy >= this.thresholdPx * this.thresholdPx) this.armed = null;
  }

  /** True if the release is a clean click (the host should deselect). Clears the
   *  armed state. Pass `pointerId` to require it match the armed pointer; omit it
   *  when the pointerup event carries no id. */
  shouldDeselect(pointerId?: number): boolean {
    if (!this.armed) return false;
    if (pointerId !== undefined && this.armed.pointerId !== pointerId) return false;
    this.armed = null;
    return true;
  }

  /** Drop any pending deselect (e.g. on selection change or gizmo detach). */
  cancel(): void {
    this.armed = null;
  }

  get isArmed(): boolean {
    return this.armed !== null;
  }
}
