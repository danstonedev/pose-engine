/**
 * CLINICIAN-AUTHORED MOVEMENT TEMPLATES — reference material for the *content*
 * of core clinical movements.
 *
 * WHY. The composer's ROM limits are sourced (AAOS / Norkin & White) and every
 * frame is measured, but the SHAPE of a movement — which joints participate, to
 * what peak angles, in what timing and coordination — was previously left to the
 * language model's own knowledge. These templates encode that shape explicitly,
 * as a small library of the core movements, so the model has an authored anchor
 * to fill the blanks around instead of guessing from scratch.
 *
 * Each template captures the three things that make a movement recognizable:
 *   • PEAK ANGLES     — the magnitude each joint reaches (per phase).
 *   • TIMING          — phase durations + which phases hold (the tempo).
 *   • COORDINATION    — which joints move together and in what ratio.
 *
 * Two uses, from ONE source of truth:
 *   1. {@link describeMovementTemplates} renders the library into the compose
 *      tool's prompt, so the planner anchors on real coordination.
 *   2. {@link templateToComposedMotion} turns a template into a playable,
 *      measurable ComposedMotion — which lets the test-suite RESOLVE each
 *      template through the real ROM path (proving every peak is within
 *      normative range) and SAMPLE it on the rig (proving the authored
 *      coordination is achievable and measures back to the authored peaks).
 *
 * These values are clinician-authored from standard kinesiology (e.g. Neumann,
 * *Kinesiology of the Musculoskeletal System*; scapulohumeral rhythm ~2:1) and
 * are flagged for SME verification, exactly like the ROM registry — they are a
 * reviewed reference, not mocap.
 */

// This module is the template LIBRARY's front door: the free-text template
// lookup and the planner-prompt rendering live here, and every other piece of
// the movement-template system is re-exported through it so the public surface
// (src/index.ts does `export * from './services/movementTemplates'`) — and every
// existing importer — is unchanged. The pieces:
//
//   movementTemplates.data   the template vocabulary + the authored library
//   movementTemplateMotion   template → playable/measurable ComposedMotion
//   movementLocomotion       the walk / turn / jump / run / hop factories
//   movementPostures         the transfer + floor-posture + roll factories
//   gaitConstants            gait tuning shared by builders AND modifiers
//   gaitModifiers            the pure transforms that reshape a built gait
//   movementFaults           the compensatory-fault taxonomy

export { NORMAL_GAIT_VERTICAL_CM } from './gaitConstants';
export {
  calibrateGaitVertical,
  gaitBounce,
  paceGait,
  scaleArmSwing,
  applyAsymmetry,
  widenStep,
  antalgicLean,
  spinalGaitCoordination,
} from './gaitModifiers';
export type { CompensatoryFault } from './movementFaults';
export {
  kneeValgus,
  forwardHead,
  circumduction,
  genuRecurvatum,
  trendelenburg,
  hipHike,
  steppage,
  vaulting,
  footDrop,
  scissoring,
  festinating,
  crouchGait,
  applyFault,
} from './movementFaults';

// The posture motion factories — the standing ↔ sitting ↔ kneeling ↔ quadruped ↔
// plank ↔ lying transfers, the floor postures held there, and the log rolls —
// live in movementPostures.ts. Re-exported here unchanged.
export {
  buildLieDown,
  buildGetUp,
  buildSupineLegRaise,
  buildSitDown,
  buildStandFromSit,
  buildSeatedKneeExtension,
  buildSquat,
  SQUAT_DF_CAP_MIN_DEG,
  SQUAT_DF_CAP_MAX_DEG,
  clampSquatDorsiflexionCap,
  buildGetDownToPlank,
  buildPushUp,
  buildStandFromPlank,
  buildGetDownToQuadruped,
  buildStandFromQuadruped,
  buildBirdDog,
  buildKneelDown,
  buildStandFromKneel,
  buildLowerToProne,
  buildPressUpToQuadruped,
  buildPlankFromQuadruped,
  buildQuadrupedFromPlank,
  buildRollSupineToLeft,
  buildRollLeftToSupine,
  buildRollSupineToRight,
  buildRollRightToSupine,
  buildRollLeftToProne,
  buildRollProneToLeft,
  buildRollRightToProne,
  buildRollProneToRight,
} from './movementPostures';

// The locomotor motion factories — the travelling/arc/figure-eight walk, the step
// turn, the ballistic jump/hop and the in-place + travelling run — live in
// movementLocomotion.ts. Re-exported here unchanged.
export type { FigureEightWalk } from './movementLocomotion';
export {
  gaitFootContacts,
  buildTravelWalk,
  buildFigureEightWalk,
  buildTurnInPlace,
  GRAVITY_M_S2,
  ballisticFlightMs,
  buildJump,
  buildRun,
  buildTravelRun,
  buildSingleLegHop,
  RUN_SPEED_MIN,
  RUN_SPEED_MAX,
  clampRunSpeed,
} from './movementLocomotion';

// The template vocabulary and the authored library live in movementTemplates.data.ts;
// the template → ComposedMotion adapter in movementTemplateMotion.ts.
// Re-exported here so every existing importer — and `export *` from src/index.ts —
// keeps working unchanged.
export type {
  TemplateTarget,
  TemplatePhase,
  TemplateContactWindow,
  MovementTemplate,
} from './movementTemplates.data';
export { MOVEMENT_TEMPLATES } from './movementTemplates.data';
export { templateToComposedMotion } from './movementTemplateMotion';

import type { MovementTemplate } from './movementTemplates.data';
import { MOVEMENT_TEMPLATES } from './movementTemplates.data';


/** Select the template whose aliases best match a free-text instruction, or null. */
export function findMovementTemplate(instruction: string): MovementTemplate | null {
  const text = instruction.toLowerCase();
  let best: MovementTemplate | null = null;
  let bestLen = 0;
  for (const t of MOVEMENT_TEMPLATES) {
    for (const a of t.aliases) {
      if (text.includes(a) && a.length > bestLen) {
        best = t;
        bestLen = a.length;
      }
    }
  }
  return best;
}

/** Render the whole library as a compact reference block for the planner prompt:
 *  each movement's phases (timing), peak angles, and coordination. */
export function describeMovementTemplates(): string {
  const lines: string[] = [];
  for (const t of MOVEMENT_TEMPLATES) {
    const phases = t.phases
      .map((p) => {
        const peaks = p.targets
          .map((x) => `${x.joint}.${x.motion} ${x.peakDeg}°`)
          .join(', ');
        const hold = p.holdMs ? ` hold ${p.holdMs}ms` : '';
        return `${p.name} (${p.durationMs}ms${hold}): ${peaks}`;
      })
      .join(' | ');
    lines.push(
      `• ${t.label} [${t.stance}${t.loop ? ', loops' : ''}] — ${t.coordination} PHASES: ${phases}`,
    );
  }
  return lines.join('\n');
}
