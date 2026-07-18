/**
 * Compensatory-fault taxonomy — knee-valgus (hip adduction/IR proxy), forward-head
 * (cervical + thoracic flexion), circumduction+vault (swing-hip abduction +
 * contralateral plantarflexion), compensated-Trendelenburg (trunk lean, via
 * antalgicLean), and genu-recurvatum (knee hyperextension). Each writes SUSTAINED,
 * ROM-clamped targets on live-commandable DOF, so the deviation reads back on the
 * goniometry chart — a real authored angle, not a cosmetic overlay.
 */
import { describe, expect, it } from 'vitest';
import {
  kneeValgus,
  forwardHead,
  circumduction,
  genuRecurvatum,
  applyFault,
  templateToComposedMotion,
  MOVEMENT_TEMPLATES,
} from '../services/movementTemplates';
import { resolveComposedMotion } from '../services/motionSequence';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { ComposedMotion } from '../services/motionSequence';

const walk = (): ComposedMotion => templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);
const squat = (): ComposedMotion => templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'squat')!);
const singleLegStance = (): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'single-leg-stance')!);

/** Every targetDegrees for a joint.motion across the motion. */
const targetOf = (m: ComposedMotion, joint: string, motion: string): number[] =>
  m.keyframes.flatMap((kf) =>
    (kf.targets ?? []).filter((t) => t.joint === joint && t.motion === motion).map((t) => t.targetDegrees),
  );

const resolvesOk = (m: ComposedMotion) => expect(resolveComposedMotion(m, BODY_VARIANTS.male).status).toBe('ok');

describe('kneeValgus (hip adduction + internal rotation proxy)', () => {
  it('drives BOTH femurs into adduction + IR when no side is given', () => {
    const base = squat();
    const v = kneeValgus(base); // bilateral
    for (const p of ['L_', 'R_']) {
      expect(targetOf(v, `${p}UpLeg`, 'hipAbduction').every((d) => d === -12)).toBe(true); // − = adduction
      expect(targetOf(v, `${p}UpLeg`, 'hipRotation').every((d) => d === 10)).toBe(true); // + = internal (12*0.8)
    }
    expect(kneeValgus(base, undefined, 0)).toEqual(base); // identity at 0
    resolvesOk(v);
  });

  it('is unilateral when a side is named', () => {
    const v = kneeValgus(squat(), 'right', 12);
    expect(targetOf(v, 'R_UpLeg', 'hipAbduction').length).toBeGreaterThan(0);
    expect(targetOf(v, 'L_UpLeg', 'hipAbduction')).toHaveLength(0); // uninvolved side untouched
  });
});

describe('forwardHead (cervical + thoracic flexion)', () => {
  it('holds sustained neck flexion with thoracic flexion at half', () => {
    const f = forwardHead(walk(), 16);
    expect(targetOf(f, 'Neck', 'flexion').every((d) => d === 16)).toBe(true);
    expect(targetOf(f, 'Spine_Upper', 'flexion').every((d) => d === 8)).toBe(true);
    resolvesOk(f);
  });
});

describe('circumduction (+ contralateral vault)', () => {
  it('abducts the swing hip and plantarflexes the stance ankle', () => {
    const c = circumduction(walk(), 'right', 15);
    expect(targetOf(c, 'R_UpLeg', 'hipAbduction').every((d) => d === 15)).toBe(true); // swing arcs out
    expect(targetOf(c, 'L_Foot', 'ankleFlexion').some((d) => d === -9)).toBe(true); // stance vaults (−=plantar, 15*0.6)
    resolvesOk(c);
  });
});

describe('genuRecurvatum (knee hyperextension, needs widened ROM)', () => {
  it('drives the extended stance knee into hyperextension that survives resolve', () => {
    // The single-leg-stance L (stance) knee has NO authored flexion, so the sustained
    // −10° offset is a clean hyperextension — exactly the standing-knee recurvatum case.
    const g = genuRecurvatum(singleLegStance(), undefined, 10); // bilateral
    expect(targetOf(g, 'L_Leg', 'kneeFlexion').some((d) => d === -10)).toBe(true);
    const resolved = resolveComposedMotion(g, BODY_VARIANTS.male);
    expect(resolved.status).toBe('ok');
    // the hyperextension is NOT clamped to 0 — a negative CLAMPED knee angle survives
    const settledKnee = resolved.keyframes.flatMap((kf) =>
      kf.targets.filter((t) => t.joint === 'L_Leg' && t.motion === 'kneeFlexion').map((t) => t.clampedDegrees),
    );
    expect(Math.min(...settledKnee)).toBeLessThan(0);
  });

  it('is additive on a flexed knee (deepens extension where the gait knee is near 0)', () => {
    const base = walk();
    const g = genuRecurvatum(base, undefined, 10);
    // every existing L_Leg knee target is shifted down by exactly 10 (sustained offset)
    const b = targetOf(base, 'L_Leg', 'kneeFlexion');
    const f = targetOf(g, 'L_Leg', 'kneeFlexion');
    expect(f.length).toBe(b.length);
    for (let i = 0; i < b.length; i += 1) expect(f[i]).toBe(b[i]! - 10);
  });
});

describe('applyFault dispatcher', () => {
  it('routes each fault name to a real, resolvable deviation', () => {
    for (const fault of ['knee-valgus', 'forward-head', 'circumduction', 'compensated-trendelenburg', 'genu-recurvatum'] as const) {
      const m = applyFault(walk(), fault, 'right');
      expect(m).not.toEqual(walk()); // it actually changed the motion
      resolvesOk(m);
    }
  });
});
