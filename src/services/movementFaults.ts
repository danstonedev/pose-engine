/**
 * COMPENSATORY-FAULT TAXONOMY — the buildable movement FAULTS a clinician can
 * request as a deviation overlaid on any movement.
 *
 * Split out of services/movementTemplates so the authored movement library and
 * the deviations layered on top of it are separable. Each fault is a pure
 * transform built on the gait modifiers' `addSustainedTargets`, so every fault
 * angle goes through the normal ROM-clamp + measurement path and reads back on
 * the goniometry chart. Re-exported from services/movementTemplates so the
 * public surface (and every existing importer) is unchanged.
 */

import type { ComposedMotion } from './motionSequence';
import { addSustainedTargets, antalgicLean } from './gaitModifiers';

// ─── Compensatory-fault taxonomy ────────────────────────────────────────────
// A buildable set of movement FAULTS a clinician can request as a deviation to
// overlay on any movement. Each writes SUSTAINED, ROM-clamped targets on
// live-commandable DOF (via addSustainedTargets), so the fault reads back on the
// goniometry chart — it is a real authored angle, not a cosmetic overlay. Faults
// on DOF without a large commandable frontal/rotary axis (e.g. knee valgus) are
// authored at their true PROXIMAL driver (the hip). Pure; compose freely.

/** A named compensatory fault the interpreter maps to one of the transforms below. */
export type CompensatoryFault =
  | 'knee-valgus'
  | 'forward-head'
  | 'circumduction'
  | 'compensated-trendelenburg'
  | 'genu-recurvatum';

const sidePrefix = (side: 'left' | 'right') => (side === 'left' ? 'L_' : 'R_');

/**
 * DYNAMIC KNEE VALGUS via the hip (medial knee collapse). The knee has no large
 * commandable frontal DOF (`kneeDeviation` is a ±5° readout), so valgus is authored
 * at its true proximal driver: the femur ADDUCTS and INTERNALLY ROTATES, carrying
 * the knee medially. Sustained on the given side, or BOTH legs when omitted (the
 * classic bilateral squat/landing collapse). `hipAbduction` − = adduction;
 * `hipRotation` + = internal. Pure; ROM-clamped on resolve.
 */
export function kneeValgus(motion: ComposedMotion, side?: 'left' | 'right', deg = 12): ComposedMotion {
  const d = Math.max(0, Math.min(25, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const legs = side ? [sidePrefix(side)] : ['L_', 'R_'];
  const add = legs.flatMap((p) => [
    { joint: `${p}UpLeg`, motion: 'hipAbduction', deg: -d }, // adduction
    { joint: `${p}UpLeg`, motion: 'hipRotation', deg: Math.round(d * 0.8) }, // internal
  ]);
  return addSustainedTargets(motion, add);
}

/**
 * FORWARD-HEAD posture — sustained cervical flexion with a rounded upper back, so
 * the head juts anteriorly. Neck flexion `deg`, thoracic flexion at half. Pure;
 * ROM-clamped on resolve. A postural fault to overlay on any movement.
 */
export function forwardHead(motion: ComposedMotion, deg = 15): ComposedMotion {
  const d = Math.max(0, Math.min(35, Number.isFinite(deg) ? deg : 0));
  return addSustainedTargets(motion, [
    { joint: 'Neck', motion: 'flexion', deg: d },
    { joint: 'Spine_Upper', motion: 'flexion', deg: Math.round(d * 0.5) },
  ]);
}

/**
 * CIRCUMDUCTION + contralateral VAULT — a swing-phase gait deviation compensating
 * for a functionally long / stiff swing leg (reduced knee flexion): the swing hip
 * ABDUCTS to arc the foot around and clear the floor, while the STANCE side vaults
 * (plantarflexes to lift the body over the planted foot). `side` = the swinging /
 * involved leg. Sustained hip abduction on `side` + plantarflexion (negative
 * ankleFlexion) on the contralateral ankle. Pure; ROM-clamped on resolve. Best over
 * a gait (needs a swing leg).
 */
export function circumduction(motion: ComposedMotion, side: 'left' | 'right' = 'right', deg = 15): ComposedMotion {
  const d = Math.max(0, Math.min(30, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const swing = sidePrefix(side);
  const stance = side === 'left' ? 'R_' : 'L_';
  return addSustainedTargets(motion, [
    { joint: `${swing}UpLeg`, motion: 'hipAbduction', deg: d }, // arc the swing leg out
    { joint: `${stance}Foot`, motion: 'ankleFlexion', deg: -Math.round(d * 0.6) }, // vault (plantarflex)
  ]);
}

/**
 * GENU RECURVATUM — sustained knee HYPEREXTENSION (the knee bows backward past 0).
 * Adds a negative `kneeFlexion` on the given knee, or BOTH when omitted. Relies on
 * the widened `kneeFlexion` ROM min (romRegistry) so the hyperextension isn't
 * clamped away. Pure; ROM-clamped on resolve. A stance / gait posture fault.
 */
export function genuRecurvatum(motion: ComposedMotion, side?: 'left' | 'right', deg = 10): ComposedMotion {
  const d = Math.max(0, Math.min(15, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const legs = side ? [sidePrefix(side)] : ['L_', 'R_'];
  return addSustainedTargets(
    motion,
    legs.map((p) => ({ joint: `${p}Leg`, motion: 'kneeFlexion', deg: -d })),
  );
}

/**
 * Apply a named compensatory fault to a motion. `compensated-trendelenburg` reuses
 * {@link antalgicLean} (the trunk lean over the involved stance limb). `side` steers
 * the unilateral faults (circumduction, compensated-trendelenburg); knee-valgus and
 * genu-recurvatum go BILATERAL when `side` is omitted. Pure; ROM-clamped on resolve.
 */
export function applyFault(
  motion: ComposedMotion,
  fault: CompensatoryFault,
  side?: 'left' | 'right',
  deg?: number,
): ComposedMotion {
  switch (fault) {
    case 'knee-valgus':
      return kneeValgus(motion, side, deg);
    case 'forward-head':
      return forwardHead(motion, deg);
    case 'circumduction':
      return circumduction(motion, side ?? 'right', deg);
    case 'compensated-trendelenburg':
      return antalgicLean(motion, side ?? 'right', deg ?? 12);
    case 'genu-recurvatum':
      return genuRecurvatum(motion, side, deg);
    default:
      return motion;
  }
}
