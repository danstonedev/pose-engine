import { describe, expect, it } from 'vitest';
import { applyFault, type CompensatoryFault } from '../services/movementFaults';
import { buildTravelWalk } from '../services/movementLocomotion';
import { addGaitPhaseTargets } from '../services/gaitFaultPhases';
import { resolveComposedMotion } from '../services/motionSequence';
import type { ComposedMotion } from '../services/motionSequence';

const value = (m: ComposedMotion, i: number, joint: string, motion: string) => {
  let value = 0;
  for (const kf of m.keyframes.slice(0, i + 1))
    value = kf.targets?.find(t => t.joint === joint && t.motion === motion)?.targetDegrees ?? value;
  return value;
};
const faults: [CompensatoryFault, 'stance' | 'swing', string, string][] = [
  ['trendelenburg', 'stance', 'Hips', 'lateralTilt'],
  ['compensated-trendelenburg', 'stance', 'Spine_Lower', 'lateralTilt'],
  ['knee-valgus', 'stance', 'L_UpLeg', 'hipAbduction'],
  ['genu-recurvatum', 'stance', 'L_Leg', 'kneeFlexion'],
  ['hip-hike', 'swing', 'Hips', 'lateralTilt'],
  ['circumduction', 'swing', 'L_UpLeg', 'hipAbduction'],
  ['steppage', 'swing', 'L_Leg', 'kneeFlexion'],
  ['foot-drop', 'swing', 'L_Foot', 'ankleFlexion'],
  ['vaulting', 'swing', 'R_Foot', 'ankleFlexion'],
];
describe('gait deviations follow support ownership', () => {
  it.each(faults)('%s releases outside its %s phase without changing timing or travel', (fault, phase, joint, field) => {
    const base = buildTravelWalk({ asymmetry: false }), before = structuredClone(base);
    const changed = applyFault(base, fault, 'left', 10);
    let t = 0, active = 0, inactive = 0;
    for (let i = 0; i < base.keyframes.length; i++) {
      t += base.keyframes[i]!.durationMs ?? 0;
      const delta = value(changed, i, joint, field) - value(base, i, joint, field);
      const foot = phase === 'stance' ? 'L_Foot' : 'R_Foot';
      const window = base.gaitStanceWindowsMs!.find(w => w.foot === foot && t > w.fromMs && t < w.toMs);
      if (!window) { expect(delta).toBe(0); inactive++; }
      else if (Math.abs(delta) > .1) active++;
      expect(changed.keyframes[i]!.root).toEqual(base.keyframes[i]!.root);
      expect(changed.keyframes[i]!.durationMs).toBe(base.keyframes[i]!.durationMs);
      t += base.keyframes[i]!.holdMs ?? 0;
    }
    expect(active).toBeGreaterThan(0); expect(inactive).toBeGreaterThan(0);
    expect(base).toEqual(before);
    expect(changed.contacts).toEqual(base.contacts);
    expect(changed.gaitStanceWindowsMs).toEqual(base.gaitStanceWindowsMs);
  });
  it('does not deform a braking foot before its landing is captured', () => {
    const base = buildTravelWalk(), changed = applyFault(base, 'knee-valgus', 'right', 12);
    const contact = base.contacts!.filter(c => c.foot === 'R_Foot').at(-1)!;
    let t = 0;
    for (let i = 0; i < base.keyframes.length; i++) {
      t += base.keyframes[i]!.durationMs ?? 0;
      if (t === contact.fromMs) expect(value(changed, i, 'R_UpLeg', 'hipAbduction')).toBe(value(base, i, 'R_UpLeg', 'hipAbduction'));
      t += base.keyframes[i]!.holdMs ?? 0;
    }
  });
  it('preserves sparse baseline targets and explicitly releases an offset', () => {
    const base: ComposedMotion = { gaitStanceWindowsMs: [{foot:'L_Foot',fromMs:0,toMs:400}], keyframes: [
      {durationMs:200,targets:[{joint:'Hips',motion:'lateralTilt',targetDegrees:3}]},
      {durationMs:200,targets:[{joint:'Neck',motion:'flexion',targetDegrees:0}]},
    ] };
    const changed = addGaitPhaseTargets(base,'left','stance',[{joint:'Hips',motion:'lateralTilt',deg:10}]);
    expect(value(changed,0,'Hips','lateralTilt')).toBe(13);
    expect(value(changed,1,'Hips','lateralTilt')).toBe(3);
  });
  it('does not suppress gait enrichment by attaching an inferred stance schedule early', () => {
    const base = buildTravelWalk();
    delete base.gaitStanceWindowsMs; delete base.contacts; delete base.footDrivenTravel;
    delete base.verticalCalibrationCm; delete base.lateralShuttleCm; delete base.settleEnds;
    delete base.gaitRegime; delete base.gaitCycleMs;
    delete base.inheritHeading;
    base.keyframes.at(-1)!.root = {translateM:[0,0,1]};
    const changed = applyFault(base,'trendelenburg','left');
    expect(changed.gaitStanceWindowsMs).toBeUndefined();
    expect(resolveComposedMotion(changed).footDrivenTravel).toBe(true);
  });
});
