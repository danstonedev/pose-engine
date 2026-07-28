/**
 * CLINICAL GAIT-DEVIATION TAXONOMY — the five faults added beyond the original
 * four (knee valgus, forward head, circumduction, genu recurvatum).
 *
 * These are the deviations a PT student is taught to NAME and DISCRIMINATE, so
 * the tests are written around the discriminations rather than around the
 * numbers: an uncompensated Trendelenburg must look different from a compensated
 * one; a hip hike must be the mirror of a pelvic drop, not a second drop;
 * steppage must carry its cause with it; vaulting must happen on the STANCE side
 * while circumduction happens on the SWING side.
 *
 * Every fault is authored as sustained targets on live-commandable DOF, so each
 * one resolves through the real ROM-clamp path and reads back on the goniometry
 * chart — which is what makes it a teachable finding rather than a visual effect.
 */
import { describe, expect, it } from 'vitest';
import {
  trendelenburg,
  hipHike,
  steppage,
  vaulting,
  footDrop,
  scissoring,
  festinating,
  crouchGait,
  circumduction,
  applyFault,
  antalgicLean,
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  type CompensatoryFault,
} from '../services/movementTemplates';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';

const walk = (): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);

/** Peak signed value authored on a joint.motion across the whole motion. */
function peak(m: ComposedMotion, joint: string, motion: string): number {
  let best = 0;
  for (const kf of m.keyframes) {
    for (const t of kf.targets ?? []) {
      if (t.joint === joint && t.motion === motion && Math.abs(t.targetDegrees) > Math.abs(best)) {
        best = t.targetDegrees;
      }
    }
  }
  return best;
}

/** The value authored on a joint.motion in the FIRST keyframe that commands it —
 *  the handle for measuring what a fault ADDED, as opposed to what the underlying
 *  template already did. */
function firstTarget(m: ComposedMotion, joint: string, motion: string): number {
  for (const kf of m.keyframes) {
    for (const t of kf.targets ?? []) {
      if (t.joint === joint && t.motion === motion) return t.targetDegrees;
    }
  }
  return 0;
}

const has = (m: ComposedMotion, joint: string, motion: string): boolean =>
  m.keyframes.some((kf) => (kf.targets ?? []).some((t) => t.joint === joint && t.motion === motion));

describe('every new fault survives the real resolve path', () => {
  const cases: [CompensatoryFault, string][] = [
    ['trendelenburg', 'pelvic drop'],
    ['hip-hike', 'pelvic hitch'],
    ['steppage', 'high-stepping'],
    ['vaulting', 'stance-side vault'],
    ['foot-drop', 'dropped foot'],
    ['scissoring', 'adducted crossing legs'],
    ['festinating', 'stooped, damped swing'],
    ['crouch-gait', 'flexed-knee crouch'],
  ];

  it.each(cases)('%s resolves cleanly on a walk', (fault) => {
    const r = resolveComposedMotion(applyFault(walk(), fault, 'right'));
    expect(r.status).toBe('ok');
  });

  it.each(cases)('%s is reachable through applyFault (not just its function)', (fault) => {
    // A fault in the union but missing from applyFault's switch would silently
    // return the motion unchanged — present in the type, absent from the product.
    const before = JSON.stringify(walk());
    const after = JSON.stringify(applyFault(walk(), fault, 'right'));
    expect(after, `${fault} must change the motion`).not.toBe(before);
  });

  it('a zero magnitude is a no-op for every fault', () => {
    for (const [fault] of cases) {
      expect(JSON.stringify(applyFault(walk(), fault, 'right', 0))).toBe(JSON.stringify(walk()));
    }
  });
});

describe('Trendelenburg — compensated vs uncompensated are distinguishable', () => {
  it('the UNcompensated sign drops the pelvis; the compensated one does not', () => {
    const uncomp = trendelenburg(walk(), 'right', 12);
    const comp = applyFault(walk(), 'compensated-trendelenburg', 'right', 12);
    // The whole clinical discrimination: a pelvic drop vs a trunk lurch.
    expect(has(uncomp, 'Hips', 'lateralTilt'), 'uncompensated tilts the pelvis').toBe(true);
    expect(has(comp, 'Hips', 'lateralTilt'), 'compensated does NOT tilt the pelvis').toBe(false);
    expect(JSON.stringify(comp)).toBe(JSON.stringify(antalgicLean(walk(), 'right', 12)));
  });

  it('the pelvis falls on the side OPPOSITE the weak hip, and flips with it', () => {
    // Weak RIGHT stance hip → LEFT pelvis drops. Positive lateralTilt = left up,
    // so a left-side DROP is negative.
    expect(peak(trendelenburg(walk(), 'right', 12), 'Hips', 'lateralTilt')).toBeLessThan(0);
    expect(peak(trendelenburg(walk(), 'left', 12), 'Hips', 'lateralTilt')).toBeGreaterThan(0);
  });
});

describe('hip hike is the MIRROR of the Trendelenburg drop, not another drop', () => {
  it('hiking a side and dropping the same side tilt the pelvis opposite ways', () => {
    const hiked = peak(hipHike(walk(), 'right', 12), 'Hips', 'lateralTilt');
    // trendelenburg('left') drops the RIGHT side — the same side hipHike raises.
    const dropped = peak(trendelenburg(walk(), 'left', 12), 'Hips', 'lateralTilt');
    expect(Math.sign(hiked)).toBe(-Math.sign(dropped));
  });

  it('raises the named side on both sides of the body', () => {
    expect(peak(hipHike(walk(), 'left', 12), 'Hips', 'lateralTilt')).toBeGreaterThan(0);
    expect(peak(hipHike(walk(), 'right', 12), 'Hips', 'lateralTilt')).toBeLessThan(0);
  });
});

describe('steppage carries its cause', () => {
  it('authors the dropped foot as well as the exaggerated flexion', () => {
    const m = steppage(walk(), 'right', 15);
    // Excess hip + knee flexion is the compensation…
    expect(peak(m, 'R_UpLeg', 'hipFlexion')).toBeGreaterThan(peak(walk(), 'R_UpLeg', 'hipFlexion'));
    expect(peak(m, 'R_Leg', 'kneeFlexion')).toBeGreaterThan(peak(walk(), 'R_Leg', 'kneeFlexion'));
    // …and the plantarflexed ankle is WHY. Steppage without it is just a high step.
    expect(peak(m, 'R_Foot', 'ankleFlexion')).toBeLessThan(peak(walk(), 'R_Foot', 'ankleFlexion'));
  });

  it('foot-drop on its own does NOT add the compensation', () => {
    // So a scenario can present the deficit and let the compensation be the finding.
    const fd = footDrop(walk(), 'right', 15);
    expect(peak(fd, 'R_Foot', 'ankleFlexion')).toBeLessThan(0);
    expect(peak(fd, 'R_UpLeg', 'hipFlexion')).toBe(peak(walk(), 'R_UpLeg', 'hipFlexion'));
  });
});

describe('vaulting and circumduction are opposite-side compensations for the same deficit', () => {
  it('vaulting plantarflexes the STANCE ankle, circumduction abducts the SWING hip', () => {
    const v = vaulting(walk(), 'right', 12); // right = the involved SWING limb
    const c = circumduction(walk(), 'right', 12);
    // Vault happens on the contralateral (left) stance foot…
    expect(peak(v, 'L_Foot', 'ankleFlexion')).toBeLessThan(peak(walk(), 'L_Foot', 'ankleFlexion'));
    // …and circumduction arcs the involved (right) swing leg out.
    expect(peak(c, 'R_UpLeg', 'hipAbduction')).toBeGreaterThan(0);
  });

  it('both use the SAME side convention (the involved limb), so a scenario can swap them', () => {
    // If these disagreed, swapping one compensation for the other would silently
    // switch which leg the finding is on.
    const v = vaulting(walk(), 'left', 12);
    const c = circumduction(walk(), 'left', 12);
    expect(peak(v, 'R_Foot', 'ankleFlexion')).toBeLessThan(0); // vault on the RIGHT stance
    expect(peak(c, 'L_UpLeg', 'hipAbduction')).toBeGreaterThan(0); // arc the LEFT swing
  });
});

describe('faults compose without erasing each other', () => {
  it('a dropped foot plus a hip hike keeps both findings', () => {
    const m = hipHike(footDrop(walk(), 'right', 15), 'right', 10);
    expect(peak(m, 'R_Foot', 'ankleFlexion')).toBeLessThan(0);
    expect(peak(m, 'Hips', 'lateralTilt')).not.toBe(0);
    expect(resolveComposedMotion(m).status).toBe('ok');
  });
});

describe('the bilateral tone / posture patterns', () => {
  it('scissoring ADDUCTS both hips toward the midline', () => {
    const m = scissoring(walk(), 12);
    expect(peak(m, 'L_UpLeg', 'hipAbduction')).toBeLessThan(0);
    expect(peak(m, 'R_UpLeg', 'hipAbduction')).toBeLessThan(0);
    expect(resolveComposedMotion(m).status).toBe('ok');
  });

  it('scissoring takes no side — it is a tone pattern, not a compensation', () => {
    // applyFault must not let a stray side argument make it unilateral.
    expect(JSON.stringify(applyFault(walk(), 'scissoring', 'left', 12))).toBe(
      JSON.stringify(applyFault(walk(), 'scissoring', 'right', 12)),
    );
  });

  it('crouch gait is the MIRROR of genu recurvatum at the knee', () => {
    // One knee never extends; the other extends past neutral. The mirror is in
    // the DELTA each fault applies, not in the composed peak — the walk already
    // flexes the knee to 60 degrees, so both composed peaks are positive and
    // comparing them would compare the template, not the faults.
    const base = firstTarget(walk(), 'R_Leg', 'kneeFlexion');
    const crouch = firstTarget(crouchGait(walk(), 'right', 20), 'R_Leg', 'kneeFlexion') - base;
    const recurv =
      firstTarget(applyFault(walk(), 'genu-recurvatum', 'right', 10), 'R_Leg', 'kneeFlexion') - base;
    expect(crouch).toBeGreaterThan(0); // held in flexion
    expect(recurv).toBeLessThan(0); // driven past neutral into extension
    expect(Math.sign(crouch)).toBe(-Math.sign(recurv));
  });

  it('crouch gait holds hip AND knee flexion with compensatory dorsiflexion', () => {
    const m = crouchGait(walk(), undefined, 20);
    for (const p of ['L_', 'R_']) {
      expect(peak(m, `${p}UpLeg`, 'hipFlexion')).toBeGreaterThan(0);
      expect(peak(m, `${p}Leg`, 'kneeFlexion')).toBeGreaterThan(0);
      // The shin stays inclined — excess DF is what stops a crouch toppling back.
      expect(peak(m, `${p}Foot`, 'ankleFlexion')).toBeGreaterThan(0);
    }
    expect(resolveComposedMotion(m).status).toBe('ok');
  });

  it('festinating stoops the trunk and DAMPS arm swing without abolishing it', () => {
    const m = festinating(walk(), 15);
    expect(peak(m, 'Spine_Upper', 'flexion')).toBeGreaterThan(peak(walk(), 'Spine_Upper', 'flexion'));
    const before = Math.abs(peak(walk(), 'R_UpperArm', 'shoulderFlexion'));
    const after = Math.abs(peak(m, 'R_UpperArm', 'shoulderFlexion'));
    expect(after).toBeLessThan(before); // reduced…
    expect(after).toBeGreaterThan(0); // …but not a frozen mannequin
  });

  it('the deepest festination still leaves some swing', () => {
    const m = festinating(walk(), 30);
    expect(Math.abs(peak(m, 'R_UpperArm', 'shoulderFlexion'))).toBeGreaterThan(0);
  });
});
