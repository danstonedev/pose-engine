/**
 * THE TUNABLE SURFACE for gait trunk coordination, and the seam that turns a
 * parameter vector into a scored motion.
 *
 * SCOPE IS FOUR NUMBERS, DELIBERATELY. `spinalGaitCoordination` already accepts
 * axial / lateral / pelvis / headStabilize as options, so these four are tunable
 * with no refactor and no new injection machinery. They also carry most of the
 * "reads human vs. reads robotic" signal in the trunk. Everything else in the
 * engine's ~195 shaping constants is deliberately OUT until this loop has earned
 * trust, and much of it must stay out permanently:
 *
 *   • 523 numbers in movementTemplates.data are SME-flagged clinical content —
 *     the file says outright "Do not shrink the authored hip peaks";
 *   • 8 scalars carry a named source (Perry, Winter, Novacheck) and must be
 *     pinned or bounded to their cited band, never treated as free reals;
 *   • ~45 are structural caps, which are BOUNDS on the vector, not members of it —
 *     letting a search move them lets it widen its own constraint set;
 *   • 9 encode rig geometry and are measurements, not preferences;
 *   • liveliness and eyeGaze (42 more) never enter the offline sampler at all, so
 *     a headless objective measures exactly zero gradient on them.
 *
 * BOUNDS ARE NOT TASTE. Each range below is set so the search cannot leave the
 * region where the value still means what its name says. `axial` beyond ~0.30
 * stops being thoracic counter-rotation and becomes a twist the rig gates reject;
 * `lateral` beyond ~0.09 reads as a waddle rather than a sway.
 */

import type { ComposedMotion } from './motionSequence';
import type { Parameter, Vector } from './policySearch';

/**
 * The four trunk-coordination gains, with the SHIPPED values as the identity
 * point. `identity` matters more than it looks: the engine documents byte-identity
 * contracts at the clean settings, so a search must be able to return exactly here
 * and reproduce the current clinical reference rather than something near it.
 */
export const GAIT_TRUNK_PARAMETERS: readonly Parameter[] = [
  // Thoracic counter-rotation against the pelvis — the single largest contributor
  // to a walk reading as human rather than as a marching mannequin.
  { name: 'axial', min: 0.02, max: 0.3, identity: 0.16 },
  // Frontal-plane sway toward the stance limb. Real gait keeps the trunk
  // near-vertical (~2-4°); this is small on purpose.
  { name: 'lateral', min: 0.01, max: 0.09, identity: 0.03 },
  // Pelvic transverse rotation gain.
  { name: 'pelvis', min: 0.02, max: 0.1, identity: 0.05 },
  // Head stabilization — how much the neck counters trunk motion to hold gaze.
  { name: 'headStabilize', min: 0.5, max: 1, identity: 1 },
];

/** A vector's gains in the shape `spinalGaitCoordination` expects. */
export function toSpinalOpts(v: Vector): {
  axial: number;
  lateral: number;
  pelvis: number;
  headStabilize: number;
} {
  return {
    axial: v.axial ?? 0.16,
    lateral: v.lateral ?? 0.03,
    pelvis: v.pelvis ?? 0.05,
    headStabilize: v.headStabilize ?? 1,
  };
}

/**
 * Build the candidate motion for a parameter vector.
 *
 * The caller supplies `base` — the motion being tuned — and this applies the
 * gains. Kept as its own function so the test suite can assert that the identity
 * vector reproduces the shipped motion EXACTLY, which is the contract that stops
 * a tuning run from silently redefining the clinical reference.
 */
export function applyTrunkGains(
  base: ComposedMotion,
  v: Vector,
  spinalGaitCoordination: (m: ComposedMotion, o: ReturnType<typeof toSpinalOpts>) => ComposedMotion,
): ComposedMotion {
  return spinalGaitCoordination(base, toSpinalOpts(v));
}
