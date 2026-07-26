/**
 * TEMPLATE → PLAYABLE MOTION — the one adapter that turns an authored
 * {@link MovementTemplate} (services/movementTemplates.data) into a ComposedMotion
 * the engine can resolve, clamp, sample and measure.
 *
 * Its own leaf module so the gait/posture motion factories can reach it WITHOUT
 * importing the services/movementTemplates barrel that re-exports them — i.e. so
 * the library layering stays acyclic:
 *
 *   movementTemplates.data → movementTemplateMotion → movementLocomotion
 *                                                   → movementTemplates (barrel)
 *
 * Re-exported from services/movementTemplates so the public surface (and every
 * existing importer) is unchanged.
 */

import type { ComposedMotion, SequenceKeyframe, StanceContact } from './motionSequence';
import type { MovementTemplate } from './movementTemplates.data';

/** Turn a template into a playable, measurable ComposedMotion (starts from
 *  anatomic neutral). The engine then clamps + measures it like any motion. */
export function templateToComposedMotion(t: MovementTemplate): ComposedMotion {
  const keyframes: SequenceKeyframe[] = t.phases.map((p) => ({
    targets: p.targets.map((x) => ({
      joint: x.joint,
      motion: x.motion,
      targetDegrees: x.peakDeg,
      ...(x.peakAt != null ? { peakAt: x.peakAt } : {}),
    })),
    durationMs: p.durationMs,
    ...(p.holdMs ? { holdMs: p.holdMs } : {}),
    ...(p.stance ? { stance: p.stance } : {}),
    ...(p.travel ? { travel: p.travel } : {}),
    ...(p.root ? { root: p.root } : {}),
  }));
  // Phase-indexed contact windows → absolute-ms StanceContact windows (a phase's
  // window covers its travel AND its hold). Phase boundaries are preserved by
  // peakAt expansion, so the ms windows stay exact through resolve.
  let contacts: StanceContact[] | undefined;
  if (t.contacts?.length) {
    const startOf: number[] = [];
    const endOf: number[] = [];
    let acc = 0;
    for (const p of t.phases) {
      startOf.push(acc);
      acc += p.durationMs + (p.holdMs ?? 0);
      endOf.push(acc);
    }
    contacts = t.contacts.map((c) => ({
      foot: c.foot,
      ...(c.fromPhase != null ? { fromMs: startOf[c.fromPhase] ?? 0 } : {}),
      ...(c.toPhase != null ? { toMs: endOf[c.toPhase] ?? acc } : {}),
    }));
  }
  return {
    name: t.id,
    startFrom: 'neutral',
    stance: t.stance,
    ...(t.loop ? { loop: true } : {}),
    ...(t.balanceAssist ? { balanceAssist: true } : {}),
    ...(contacts ? { contacts } : {}),
    keyframes,
  };
}
