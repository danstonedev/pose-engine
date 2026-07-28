/**
 * COORDINATION SPEC LIBRARY — the obligatory inter-joint relations a movement must
 * exhibit, keyed by {@link MOVEMENT_TEMPLATES} id.
 *
 * WHY THIS MODULE EXISTS. `services/movementCoordination` shipped the whole
 * measuring apparatus — excursion ratios, peak/velocity ordering, together/apart
 * phase timing — but every spec that exercised it lived inside a test file. The
 * engine could therefore MEASURE coordination and never did, because nothing in
 * production had anything to measure against. These are those specs, promoted
 * unchanged (they are validated against the real rig in
 * `__tests__/movementCoordination.test.ts`), so a host can ask "does this motion
 * actually coordinate like the movement it claims to be?".
 *
 * WHAT A SPEC IS FOR. Joint-angle grading asks "did each joint reach its target?"
 * A plan can pass that completely and still be wrong: a squat whose knee bends
 * while the hip stays upright reaches every angle and is not a squat; a march
 * whose arms swing with the IPSILATERAL leg is a well-executed wrong movement.
 * Coordination is the "in combination with the other joints" half, and it is the
 * half no other gate in the pipeline currently covers.
 *
 * WHAT BELONGS HERE. Only relations that are OBLIGATORY for the movement to be
 * that movement — anatomically or definitionally required, not stylistic. A
 * relation a healthy person can reasonably violate does not belong; it would
 * flag clinician-authored variation (the deliberate asymmetries and compensations
 * that are the POINT of a PT simulator) as a defect.
 *
 * COVERAGE IS DELIBERATELY PARTIAL. Three of the 25 templates carry a spec: the
 * three whose relations are measured and rig-verified. An unspecced template
 * returns `undefined` from {@link coordinationSpecFor} and is simply not
 * coordination-checked — silence, never a synthesized guess. Adding a template is
 * clinical authoring work: state the relation, then prove it against the real rig
 * in the test suite before it lands here.
 */

import type { CoordinationSpec } from './movementCoordination';

/**
 * SQUAT — hip and knee flex together, in proportion.
 *
 * The authored template peaks at ~100° hip / ~120° knee, so the excursion ratio
 * is the movement's shape: a "squat" that bends the knee while leaving the hip
 * near-upright reaches both target angles and is a different movement. The ratio
 * is amplitude-only and sign-blind, so it is paired with co-timing — the two must
 * also peak together, not sequentially.
 */
const SQUAT: CoordinationSpec = {
  name: 'squat',
  ratios: [
    { a: 'L_UpLeg.hipFlexion', b: 'L_Leg.kneeFlexion', ratio: 100 / 120, tolRel: 0.25 },
    { a: 'R_UpLeg.hipFlexion', b: 'R_Leg.kneeFlexion', ratio: 100 / 120, tolRel: 0.25 },
  ],
  // Ratio is amplitude-only; pair with co-timing so hip+knee also flex together.
  together: [
    { a: 'L_UpLeg.hipFlexion', b: 'L_Leg.kneeFlexion', label: 'L hip+knee flex together' },
    { a: 'R_UpLeg.hipFlexion', b: 'R_Leg.kneeFlexion', label: 'R hip+knee flex together' },
  ],
};

/**
 * HIGH-KNEE MARCH — reciprocal (contralateral) arm swing.
 *
 * The stepping leg peaks WITH the opposite arm and APART from the arm on its own
 * side. Both halves are needed: `together` alone is satisfied by an arm that
 * swings with everything, so the ipsilateral `apart` rule is what actually proves
 * the swing is reciprocal rather than merely present.
 */
const HIGH_KNEE_MARCH: CoordinationSpec = {
  name: 'high-knee-march',
  together: [
    { a: 'R_UpLeg.hipFlexion', b: 'L_UpperArm.shoulderFlexion', label: 'R-step with L-arm' },
    { a: 'L_UpLeg.hipFlexion', b: 'R_UpperArm.shoulderFlexion', label: 'L-step with R-arm' },
  ],
  apart: [
    { a: 'R_UpLeg.hipFlexion', b: 'R_UpperArm.shoulderFlexion', label: 'R-step vs ipsilateral R-arm' },
  ],
};

/**
 * SIT-TO-STAND — flexion momentum precedes extension.
 *
 * Trunk FLEXION momentum (the forward lean that carries the CoM over the feet)
 * leads the hip EXTENSION that rises. Directional velocity landmarks are used
 * rather than peaks so the rule is (a) robust to out-and-back argmax noise and
 * (b) has NO landmark at all when the trunk never leans — which correctly FAILS a
 * lean-less rise instead of silently passing it. That failure mode is the
 * clinically interesting one: rising without the lean is how a patient with poor
 * momentum strategy actually compensates.
 */
const SIT_TO_STAND: CoordinationSpec = {
  name: 'sit-to-stand',
  order: [
    {
      earlier: 'Spine_Lower.flexion',
      earlierAt: 'maxPosVel',
      later: 'L_UpLeg.hipFlexion',
      laterAt: 'maxNegVel',
      minLeadFrac: 0.05,
    },
    {
      earlier: 'Spine_Lower.flexion',
      earlierAt: 'maxPosVel',
      later: 'R_UpLeg.hipFlexion',
      laterAt: 'maxNegVel',
      minLeadFrac: 0.05,
    },
  ],
};

/** Every authored spec, keyed by {@link MOVEMENT_TEMPLATES} id. */
export const COORDINATION_SPECS: Readonly<Record<string, CoordinationSpec>> = {
  squat: SQUAT,
  'high-knee-march': HIGH_KNEE_MARCH,
  'sit-to-stand': SIT_TO_STAND,
};

/**
 * The coordination spec for a movement template id, or `undefined` when that
 * movement has no authored relations.
 *
 * `undefined` means NOT CHECKED, never "passed" — a caller must treat a missing
 * spec as silence. Synthesizing a plausible-looking spec for an unspecced
 * movement would manufacture failures against relations nobody validated.
 */
export function coordinationSpecFor(templateId: string | undefined): CoordinationSpec | undefined {
  if (!templateId) return undefined;
  return COORDINATION_SPECS[templateId];
}

/** Template ids that carry an authored spec — the coordination-checked set. */
export function speccedTemplateIds(): string[] {
  return Object.keys(COORDINATION_SPECS);
}
