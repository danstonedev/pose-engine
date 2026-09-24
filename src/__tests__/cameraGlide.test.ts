/**
 * The host-requested camera glide (services/cameraGlide): a spring on the
 * orbit coordinates that arrives exactly, never overshoots, swings round the
 * target rather than through it, and bends toward a new goal without a jolt.
 */
import { describe, expect, it } from 'vitest';
import { createViewGlide, smoothDamp, type GlideView } from '../services/cameraGlide';

const FRAME_MS = 1000 / 60;
const distanceTo = (view: GlideView) =>
  Math.hypot(view.position[0] - view.target[0], view.position[1] - view.target[1], view.position[2] - view.target[2]);

function run(glide: ReturnType<typeof createViewGlide>, limitMs = 10000): GlideView[] {
  const views: GlideView[] = [];
  for (let t = 0; glide.active && t < limitMs; t += FRAME_MS) views.push(glide.step(FRAME_MS));
  return views;
}

describe('smoothDamp', () => {
  it('approaches the goal without passing it, and starts from rest smoothly', () => {
    let value = 0;
    let velocity = 0;
    const seen: number[] = [];
    for (let i = 0; i < 240; i++) {
      [value, velocity] = smoothDamp(value, 1, velocity, 0.4, 1 / 60);
      seen.push(value);
    }
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(seen.at(-1)).toBeGreaterThan(0.999);
    // Eases in: the first step is small next to the fastest one.
    const steps = seen.map((v, i) => v - (seen[i - 1] ?? 0));
    expect(steps[0]!).toBeLessThan(Math.max(...steps) * 0.5);
  });
});

describe('createViewGlide', () => {
  const home: GlideView = { target: [0, 1, 0], position: [0, 1.4, 3] };

  it('lands exactly on its goal and then ends', () => {
    const glide = createViewGlide();
    const goal: GlideView = { target: [0.2, 0.7, 0.1], position: [2, 1.5, 0.4] };
    glide.setGoal(goal, home);
    const views = run(glide);
    expect(glide.active).toBe(false);
    expect(views.length).toBeGreaterThan(20); // a glide, not a cut
    expect(views.length * FRAME_MS).toBeLessThan(4000);
    const last = views.at(-1)!;
    for (let axis = 0; axis < 3; axis++) {
      expect(last.target[axis]).toBeCloseTo(goal.target[axis]!, 9);
      expect(last.position[axis]).toBeCloseTo(goal.position[axis]!, 6);
    }
  });

  it('swings round the target: the camera never cuts in close on a half-turn', () => {
    const glide = createViewGlide();
    glide.setGoal({ target: [0, 1, 0], position: [0, 1.4, -3] }, home);
    const start = distanceTo(home);
    for (const view of run(glide)) expect(distanceTo(view)).toBeGreaterThan(start * 0.99);
  });

  it('takes the short way round', () => {
    const glide = createViewGlide();
    // From just left of behind to just right of behind: 20 degrees, not 340.
    const at = (degrees: number): GlideView => {
      const a = (degrees * Math.PI) / 180;
      return { target: [0, 0, 0], position: [Math.sin(a) * 2, 0, Math.cos(a) * 2] };
    };
    glide.setGoal(at(190), at(170));
    const views = run(glide);
    // Every frame stays behind the target (negative z); the long way round would pass the front.
    for (const view of views) expect(view.position[2]).toBeLessThan(-1.9);
  });

  it('bends toward a new goal without a jolt', () => {
    const glide = createViewGlide();
    glide.setGoal({ target: [0, 1, 0], position: [3, 1.4, 0] }, home);
    const views = [...Array(20)].map(() => glide.step(FRAME_MS));
    glide.setGoal({ target: [0, 1, 0], position: [-3, 1.4, 0] }, { target: [9, 9, 9], position: [9, 9, 9] });
    const next = glide.step(FRAME_MS);
    // It carries on from where it was (the `from` of a live glide is ignored), moving as fast as a frame ago.
    const before = views.at(-1)!;
    const lastStep = Math.hypot(...before.position.map((v, i) => v - views.at(-2)!.position[i]!));
    const thisStep = Math.hypot(...next.position.map((v, i) => v - before.position[i]!));
    expect(thisStep).toBeLessThan(lastStep * 1.5);
    expect(thisStep).toBeGreaterThan(0);
  });

  it('stops where it is when cancelled, and steps a long gap as a short one', () => {
    const glide = createViewGlide();
    glide.setGoal({ target: [0, 1, 0], position: [3, 1.4, 0] }, home);
    const first = glide.step(5000);
    expect(distanceTo(first)).toBeGreaterThan(0);
    expect(first.position[0]).toBeLessThan(1.5); // a hidden tab's 5 s is stepped as 0.1 s
    glide.cancel();
    expect(glide.active).toBe(false);
    expect(() => glide.step(FRAME_MS)).toThrow();
  });
});
