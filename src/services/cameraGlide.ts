// A camera move a host asks for (simLAB's examination frames each test in
// turn): the orbit target and the camera glide to a new view along a path
// AROUND the target. Azimuth, elevation and distance ease separately, so the
// camera swings round the patient rather than cutting through them, and the
// distance eases in log space, so a close-up and a wide shot change at the same
// pace.
//
// Each coordinate follows a critically damped spring rather than a timed tween:
// it starts and settles with zero velocity (no jolt either end), and a new goal
// mid-glide (a student scrubbing across tests) bends the path without a jolt
// because the velocity carries over. Pure and three-free (plain tuples), so it
// is unit-testable in Node; services/clinicalCameraControls steps it once per
// frame.

export type GlideVec3 = [number, number, number];
/** A camera view: the orbit target and the camera position (world metres). */
export interface GlideView {
  target: GlideVec3;
  position: GlideVec3;
}

/** How quickly a glide arrives (s): about the time to cover most of the way; the last of it eases in over a second more. */
export const CAMERA_GLIDE_SMOOTH_S = 0.42;
/** Elevation is kept inside ±this (rad) so the azimuth stays defined (the camera never passes straight over the pole). */
const MAX_ELEVATION = (84 * Math.PI) / 180;
/** Settled once every coordinate is within these of its goal and nearly still. */
const SETTLE_ANGLE = 1e-4;
const SETTLE_M = 2e-4;
/** A long gap (a hidden tab) is stepped as this much at most, so the camera never leaps. */
const MAX_STEP_S = 0.1;

interface Coords {
  target: GlideVec3;
  azimuth: number;
  elevation: number;
  logDistance: number;
}

function toCoords(view: GlideView): Coords {
  const dx = view.position[0] - view.target[0];
  const dy = view.position[1] - view.target[1];
  const dz = view.position[2] - view.target[2];
  const distance = Math.max(Math.hypot(dx, dy, dz), 1e-4);
  return {
    target: [...view.target],
    azimuth: Math.atan2(dx, dz),
    elevation: Math.max(-MAX_ELEVATION, Math.min(MAX_ELEVATION, Math.asin(Math.max(-1, Math.min(1, dy / distance))))),
    logDistance: Math.log(distance),
  };
}

function toView(coords: Coords): GlideView {
  const distance = Math.exp(coords.logDistance);
  const horizontal = Math.cos(coords.elevation) * distance;
  return {
    target: [...coords.target],
    position: [
      coords.target[0] + Math.sin(coords.azimuth) * horizontal,
      coords.target[1] + Math.sin(coords.elevation) * distance,
      coords.target[2] + Math.cos(coords.azimuth) * horizontal,
    ],
  };
}

/**
 * One step of a critically damped spring toward `goal` (the closed-form
 * approximation from Game Programming Gems 4, §1.10): returns the new value and
 * velocity. Never overshoots the goal.
 */
export function smoothDamp(
  current: number,
  goal: number,
  velocity: number,
  smoothTimeS: number,
  dtS: number,
): [number, number] {
  const omega = 2 / Math.max(smoothTimeS, 1e-4);
  const x = omega * dtS;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - goal;
  const temp = (velocity + omega * change) * dtS;
  let nextVelocity = (velocity - omega * temp) * decay;
  let next = goal + (change + temp) * decay;
  // Arrived past the goal this step: stop on it.
  if (goal - current > 0 === next > goal) {
    next = goal;
    nextVelocity = 0;
  }
  return [next, nextVelocity];
}

export interface ViewGlide {
  /**
   * Glide toward `goal`, starting from `from` (the camera now) unless a glide
   * is already under way, in which case it bends toward the new goal from
   * where it is, velocity and all.
   */
  setGoal(goal: GlideView, from: GlideView, smoothTimeS?: number): void;
  /** Advance by `dtMs`; returns the view to show, and ends the glide (exactly on its goal) once settled. */
  step(dtMs: number): GlideView;
  /** Stop where it is (a user's gesture takes over). */
  cancel(): void;
  readonly active: boolean;
}

export function createViewGlide(): ViewGlide {
  let now: Coords | null = null;
  let goal: Coords | null = null;
  let smooth = CAMERA_GLIDE_SMOOTH_S;
  const velocity = { target: [0, 0, 0] as GlideVec3, azimuth: 0, elevation: 0, logDistance: 0 };
  const still = () => {
    velocity.target = [0, 0, 0];
    velocity.azimuth = velocity.elevation = velocity.logDistance = 0;
  };
  return {
    setGoal(next, from, smoothTimeS = CAMERA_GLIDE_SMOOTH_S) {
      if (!now || !goal) {
        now = toCoords(from);
        still();
      }
      goal = toCoords(next);
      // The short way round.
      goal.azimuth += 2 * Math.PI * Math.round((now.azimuth - goal.azimuth) / (2 * Math.PI));
      smooth = smoothTimeS;
    },
    step(dtMs) {
      if (!now || !goal) throw new Error('cameraGlide: step() without a goal');
      const dt = Math.min(Math.max(dtMs, 0) / 1000, MAX_STEP_S);
      const at = now;
      const to = goal;
      for (let axis = 0; axis < 3; axis++) {
        [at.target[axis], velocity.target[axis]] = smoothDamp(at.target[axis]!, to.target[axis]!, velocity.target[axis]!, smooth, dt);
      }
      [at.azimuth, velocity.azimuth] = smoothDamp(at.azimuth, to.azimuth, velocity.azimuth, smooth, dt);
      [at.elevation, velocity.elevation] = smoothDamp(at.elevation, to.elevation, velocity.elevation, smooth, dt);
      [at.logDistance, velocity.logDistance] = smoothDamp(at.logDistance, to.logDistance, velocity.logDistance, smooth, dt);
      const near =
        Math.abs(at.azimuth - to.azimuth) < SETTLE_ANGLE &&
        Math.abs(at.elevation - to.elevation) < SETTLE_ANGLE &&
        Math.abs(at.logDistance - to.logDistance) < SETTLE_ANGLE &&
        at.target.every((value, axis) => Math.abs(value - to.target[axis]!) < SETTLE_M);
      if (near) {
        const view = toView(to);
        now = goal = null;
        still();
        return view;
      }
      return toView(at);
    },
    cancel() {
      now = goal = null;
      still();
    },
    get active() {
      return goal !== null;
    },
  };
}
