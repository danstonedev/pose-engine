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
import { addSustainedTargets, antalgicLean, scaleArmSwing } from './gaitModifiers';

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
  | 'genu-recurvatum'
  | 'trendelenburg'
  | 'hip-hike'
  | 'steppage'
  | 'vaulting'
  | 'foot-drop'
  | 'scissoring'
  | 'festinating'
  | 'crouch-gait';

const sidePrefix = (side: 'left' | 'right') => (side === 'left' ? 'L_' : 'R_');

/** Pelvic `Hips.lateralTilt` degrees that raise the NAMED side. The field reads
 *  positive = "Left up" (romRegistry), so the right side rises on the negative
 *  half — one place that knows the sign, rather than each fault guessing it. */
const pelvisRaise = (side: 'left' | 'right', deg: number) => (side === 'left' ? deg : -deg);

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
 * TRENDELENBURG (uncompensated) — the pelvis DROPS on the swing side because the
 * STANCE hip abductors cannot hold it level. `side` is the INVOLVED (weak, stance)
 * limb, so the CONTRALATERAL pelvis falls.
 *
 * The clinical pair to {@link antalgicLean}, which this module already exposes as
 * `compensated-trendelenburg`: there the patient leans the trunk OVER the weak hip
 * to move the CoM and keep the pelvis level, so the giveaway is the lurch, not the
 * drop. Both are Trendelenburg's sign; a student has to tell them apart, so the
 * engine now authors both rather than only the compensated one.
 */
export function trendelenburg(motion: ComposedMotion, side: 'left' | 'right' = 'right', deg = 10): ComposedMotion {
  const d = Math.max(0, Math.min(20, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const swing = side === 'left' ? 'right' : 'left';
  return addSustainedTargets(motion, [
    // Raising the involved (stance) side IS the contralateral drop — one tilt,
    // named from the weak hip because that is the side the clinician is testing.
    { joint: 'Hips', motion: 'lateralTilt', deg: pelvisRaise(side, d) },
    // The dropped swing hip adducts relative to the tilted pelvis.
    { joint: `${sidePrefix(swing)}UpLeg`, motion: 'hipAbduction', deg: -Math.round(d * 0.4) },
  ]);
}

/**
 * HIP HIKE (quadratus lumborum hitch) — the pelvis is ELEVATED on the swing side
 * to clear a limb that cannot shorten (a stiff knee, a foot drop, a long leg).
 * `side` is the SWINGING limb being hoisted. The mirror image of
 * {@link trendelenburg}'s drop, and the compensation {@link circumduction} is an
 * alternative to — a patient uses one or the other, which is the discrimination.
 */
export function hipHike(motion: ComposedMotion, side: 'left' | 'right' = 'right', deg = 10): ComposedMotion {
  const d = Math.max(0, Math.min(20, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  return addSustainedTargets(motion, [
    { joint: 'Hips', motion: 'lateralTilt', deg: pelvisRaise(side, d) },
    { joint: `${sidePrefix(side)}UpLeg`, motion: 'hipAbduction', deg: Math.round(d * 0.3) },
  ]);
}

/**
 * FOOT DROP — the ankle hangs in PLANTARFLEXION because the dorsiflexors cannot
 * hold it. The primary impairment behind steppage, vaulting, circumduction and hip
 * hike, authored on its own so a scenario can present the deficit and let the
 * compensation be the finding rather than baking one in.
 */
export function footDrop(motion: ComposedMotion, side: 'left' | 'right' = 'right', deg = 15): ComposedMotion {
  const d = Math.max(0, Math.min(30, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  return addSustainedTargets(motion, [
    { joint: `${sidePrefix(side)}Foot`, motion: 'ankleFlexion', deg: -d },
  ]);
}

/**
 * STEPPAGE — exaggerated HIP and KNEE flexion to lift a dropped foot over the
 * floor. `side` is the involved limb. Authored WITH its cause ({@link footDrop}),
 * because steppage without a dropped foot is just a high-stepping gait: the point
 * for a student is that the excess flexion is a consequence.
 */
export function steppage(motion: ComposedMotion, side: 'left' | 'right' = 'right', deg = 15): ComposedMotion {
  const d = Math.max(0, Math.min(30, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const p = sidePrefix(side);
  return addSustainedTargets(footDrop(motion, side, d), [
    { joint: `${p}UpLeg`, motion: 'hipFlexion', deg: Math.round(d * 0.8) },
    { joint: `${p}Leg`, motion: 'kneeFlexion', deg: d },
  ]);
}

/**
 * VAULTING — the STANCE ankle plantarflexes (rises onto the forefoot) to lift the
 * body over a swing limb that cannot clear the floor. `side` is the INVOLVED
 * (swinging) limb, so the vault happens on the contralateral stance foot — the
 * same convention {@link circumduction} uses, since they are alternative
 * compensations for the same deficit and a scenario may swap between them.
 */
export function vaulting(motion: ComposedMotion, side: 'left' | 'right' = 'right', deg = 12): ComposedMotion {
  const d = Math.max(0, Math.min(25, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const stance = side === 'left' ? 'R_' : 'L_';
  return addSustainedTargets(motion, [
    { joint: `${stance}Foot`, motion: 'ankleFlexion', deg: -d },
    { joint: `${stance}Toes`, motion: 'toeFlexion', deg: Math.round(d * 1.5) },
  ]);
}

/**
 * SCISSORING — the thighs ADDUCT past the midline so the knees cross, the
 * hallmark of spastic diplegia. Always BILATERAL: it is a tone pattern, not a
 * one-sided compensation, so unlike the other deviations it takes no `side`.
 *
 * Adduction is paired with internal rotation because the two travel together in
 * the spastic pattern — adduction alone reads as a narrow base rather than a
 * scissor.
 */
export function scissoring(motion: ComposedMotion, deg = 12): ComposedMotion {
  const d = Math.max(0, Math.min(25, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  return addSustainedTargets(
    motion,
    ['L_', 'R_'].flatMap((p) => [
      { joint: `${p}UpLeg`, motion: 'hipAbduction', deg: -d }, // − = adduction, toward the midline
      { joint: `${p}UpLeg`, motion: 'hipRotation', deg: Math.round(d * 0.6) }, // + = internal
    ]),
  );
}

/**
 * FESTINATING / PARKINSONIAN gait — a stooped trunk with damped arm swing.
 *
 * Only the POSTURAL half is authored here. The other half of the clinical
 * picture — short shuffling steps whose cadence accelerates — is a change to
 * stride length and TIMING, which belongs to the gait modifiers that reshape a
 * built gait (paceGait / the step-length machinery), not to a sustained-target
 * fault. Authoring a fake stoop and calling it festination would misrepresent
 * what the mannequin is actually doing, so the shuffle is left to be composed
 * on top rather than implied.
 *
 * Bilateral by nature, so no `side`.
 */
export function festinating(motion: ComposedMotion, deg = 15): ComposedMotion {
  const d = Math.max(0, Math.min(30, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  // Arm swing damps toward (but not to) zero as the stoop deepens — a rigid
  // 0 reads as a mannequin, and real Parkinsonian swing is reduced, not absent.
  const swing = Math.max(0.15, 1 - d / 30);
  return scaleArmSwing(
    addSustainedTargets(motion, [
      { joint: 'Spine_Upper', motion: 'flexion', deg: d },
      { joint: 'Spine_Lower', motion: 'flexion', deg: Math.round(d * 0.4) },
      { joint: 'Neck', motion: 'flexion', deg: Math.round(d * 0.5) },
    ]),
    swing,
  );
}

/**
 * CROUCH GAIT — sustained hip and knee FLEXION held through stance instead of
 * extending, with the ankle in compensatory dorsiflexion. The classic CP
 * presentation, and the mirror of {@link genuRecurvatum}: one knee never
 * extends, the other extends past neutral.
 *
 * Bilateral when `side` is omitted, which is the usual presentation.
 */
export function crouchGait(motion: ComposedMotion, side?: 'left' | 'right', deg = 20): ComposedMotion {
  const d = Math.max(0, Math.min(40, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const legs = side ? [sidePrefix(side)] : ['L_', 'R_'];
  return addSustainedTargets(
    motion,
    legs.flatMap((p) => [
      { joint: `${p}UpLeg`, motion: 'hipFlexion', deg: d },
      { joint: `${p}Leg`, motion: 'kneeFlexion', deg: d },
      // The shin stays inclined over the foot — excess DF is what keeps a
      // crouched body from toppling backward.
      { joint: `${p}Foot`, motion: 'ankleFlexion', deg: Math.round(d * 0.5) },
    ]),
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
    case 'trendelenburg':
      return trendelenburg(motion, side ?? 'right', deg);
    case 'hip-hike':
      return hipHike(motion, side ?? 'right', deg);
    case 'steppage':
      return steppage(motion, side ?? 'right', deg);
    case 'vaulting':
      return vaulting(motion, side ?? 'right', deg);
    case 'foot-drop':
      return footDrop(motion, side ?? 'right', deg);
    case 'scissoring':
      return scissoring(motion, deg);
    case 'festinating':
      return festinating(motion, deg);
    case 'crouch-gait':
      return crouchGait(motion, side, deg);
    default:
      return motion;
  }
}
