/** Shared, deliberate whole-body targets for the standing functional recipes.
 * Clinical regions remain the command interface: thoracic and cervical region
 * commands recruit their companion bones; shoulder commands own their girdle.
 * Sagittal task channels and quiet limb axes are explicit. The Head keeps its
 * entry orientation relative to the cervical region; relaxed hands remain
 * owned by the shared hand strategy. */
import type { SequenceKeyframe, SequenceTarget } from './motionSequence';
import type { TemplatePhase } from './movementTemplates.data';
import { defineBodyControl, type BodyControlPhase } from './movementControl';

export type FunctionalArmStrategy = 'counterbalance' | 'reach' | 'thigh-assisted' | 'relaxed';

/** Planned responsibilities are distinct from the number of moving joints.
 * A thigh-assisted arm pose is authored, not a solved hand/thigh contact. */
export function functionalControl(
  id: string, arms: FunctionalArmStrategy, support: 'feet' | 'seat' = 'feet',
  feetPlanted = support === 'feet',
): BodyControlPhase {
  const armPurpose = {
    counterbalance: 'Reach forward to counterbalance the lowering pelvis',
    reach: 'Carry the arms toward the floor as the hips and trunk fold',
    'thigh-assisted': 'Author the thigh push-off shape; no hand contact constraint is claimed',
    relaxed: 'Hold the arms clear beside the trunk during the transfer',
  }[arms];
  return defineBodyControl({
    id, root: { translation: 'support', orientation: 'placement' },
    supports: support === 'seat' ? ['floor', 'seat'] : ['floor'],
    groups: [
      { joints: ['Hips'], role: support === 'seat' ? 'contact' : 'driven',
        purpose: support === 'seat' ? 'Hold the pelvis at the seat height' : 'Control pelvic articulation independently of whole-body support placement',
        ...(support === 'seat' ? { support: 'seat' } : {}) },
      { joints: ['L_UpLeg', 'R_UpLeg', 'L_Leg', 'R_Leg'], role: 'driven', purpose: 'Share the load and coordinate leg flexion with the task' },
      { joints: ['L_Foot', 'R_Foot'], role: feetPlanted ? 'contact' : 'driven',
        purpose: feetPlanted ? 'Maintain both foot contacts while the legs fold' : 'Author ankle posture; the seated pelvis pin does not solve both feet',
        ...(feetPlanted ? { support: 'floor' } : {}) },
      { joints: ['L_Toes', 'R_Toes'], role: 'held', purpose: 'Keep the forefoot quiet on the support surface' },
      { joints: ['Spine_Lower', 'Spine_Upper'], role: 'driven', purpose: 'Share trunk inclination through lumbar and thoracic regions' },
      { joints: ['Spine_Mid'], role: 'derived', source: 'Spine_Upper', purpose: 'Share the commanded thoracic curve' },
      { joints: ['Neck'], role: 'driven', purpose: 'Orient gaze with the task while limiting excessive head drop' },
      { joints: ['Neck_Lower'], role: 'derived', source: 'Neck', purpose: 'Share the commanded cervical curve' },
      { joints: ['Head'], role: 'held', purpose: 'Hold the entry Head orientation relative to the controlled cervical region' },
      { joints: ['L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm'], role: 'driven', purpose: armPurpose },
      { joints: ['L_Shoulder'], role: 'derived', source: 'L_UpperArm', purpose: 'Follow humeral elevation through shared shoulder rhythm; reset independent protraction to neutral' },
      { joints: ['R_Shoulder'], role: 'derived', source: 'R_UpperArm', purpose: 'Follow humeral elevation through shared shoulder rhythm; reset independent protraction to neutral' },
      { joints: ['L_Hand', 'R_Hand'], role: arms === 'thigh-assisted' ? 'driven' : 'held',
        purpose: arms === 'thigh-assisted' ? 'Extend the wrist through the authored push-off, then release' : 'Maintain the shared relaxed hand posture' },
    ],
  });
}

export interface FunctionalShape {
  hip: number;
  knee: number;
  ankle: number;
  pelvis?: number;
  lumbar?: number;
  thoracic?: number;
  neck?: number;
  arm?: number;
  armOut?: number;
  elbow?: number;
  wrist?: number;
}

const target = (joint: string, motion: string, targetDegrees: number): SequenceTarget =>
  ({ joint, motion, targetDegrees });

/** Complete sagittal task intent, including stable frontal/transverse channels. */
export function functionalTargets(s: FunctionalShape): SequenceTarget[] {
  return [
    target('Hips', 'anteriorTilt', s.pelvis ?? 0),
    target('Hips', 'lateralTilt', 0), target('Hips', 'rotation', 0),
    ...(['Spine_Lower', 'Spine_Upper'] as const).flatMap((joint, i) => [
      target(joint, 'flexion', (i ? s.thoracic : s.lumbar) ?? 0),
      target(joint, 'lateralTilt', 0), target(joint, 'rotation', 0),
    ]),
    target('Neck', 'flexion', s.neck ?? 0), target('Neck', 'rotation', 0),
    target('Neck', 'lateralTilt', 0), target('Neck', 'protraction', 0),
    ...(['L', 'R'] as const).flatMap(side => [
      target(`${side}_UpLeg`, 'hipFlexion', s.hip),
      target(`${side}_UpLeg`, 'hipAbduction', 0), target(`${side}_UpLeg`, 'hipRotation', 0),
      target(`${side}_Leg`, 'kneeFlexion', s.knee), target(`${side}_Leg`, 'kneeRotation', 0),
      target(`${side}_Foot`, 'ankleFlexion', s.ankle),
      target(`${side}_Foot`, 'ankleInversion', 0), target(`${side}_Foot`, 'ankleAbduction', 0),
      target(`${side}_Toes`, 'toeFlexion', 0),
      target(`${side}_Shoulder`, 'protraction', 0),
      target(`${side}_UpperArm`, 'shoulderFlexion', s.arm ?? 0),
      target(`${side}_UpperArm`, 'shoulderAbduction', s.armOut ?? 0),
      target(`${side}_UpperArm`, 'shoulderRotation', 0),
      target(`${side}_Forearm`, 'elbowFlexion', s.elbow ?? 0),
      target(`${side}_Forearm`, 'forearmRotation', 0),
      // Unspecified wrists belong to relaxedHands, including its graded digits.
      // Authored thigh-support wrists deliberately retain whole-hand ownership.
      ...(s.wrist == null ? [] : [target(`${side}_Hand`, 'wristFlexion', s.wrist),
        target(`${side}_Hand`, 'wristDeviation', 0)]),
    ]),
  ];
}

export interface FunctionalPhase extends SequenceKeyframe { name: string }

export interface SquatShape { hip: number; knee: number; ankle: number; sl: number; su: number; arm: number }
export const FULL_DF_SQUAT: SquatShape = { hip: 100, knee: 120, ankle: 32, sl: 27, su: 10, arm: 60 };

/** One source for the raw template and the dorsiflexion-limited builder. */
export function squatPhases(s: SquatShape = FULL_DF_SQUAT): FunctionalPhase[] {
  const descent = functionalTargets({ hip: s.hip, knee: s.knee, ankle: s.ankle,
    pelvis: 4, lumbar: s.sl - 4, thoracic: s.su, neck: -15, arm: s.arm, elbow: 8 });
  return [
    { name: 'descent-to-bottom', control: functionalControl('squat/descent', 'counterbalance'), durationMs: 1000, holdMs: 350, targets: descent.map(t =>
      t.motion === 'ankleFlexion' ? { ...t, peakAt: 0.75 } : t.motion === 'anteriorTilt' ? { ...t, peakAt: 0.5 } : t) },
    { name: 'ascent-to-stand', control: functionalControl('squat/return', 'counterbalance'), durationMs: 1000, targets: functionalTargets({ hip: 0, knee: 0, ankle: 0 }) },
  ];
}

/** Hip-led reach: pelvis and soft knees lead, the spine completes the bend;
 * the arms reach downward with quiet wrists rather than staying behind the trunk. */
export function hingePhases(): FunctionalPhase[] {
  return [
    { name: 'bend-down', control: functionalControl('hinge/bend', 'reach'), durationMs: 1200, holdMs: 350,
      targets: functionalTargets({ hip: 70, knee: 12, ankle: -3, pelvis: 4,
        lumbar: 36, thoracic: 20, neck: -10, arm: 65, elbow: 5 }).map(t =>
        ['hipFlexion', 'kneeFlexion', 'anteriorTilt'].includes(t.motion) ? { ...t, peakAt: 0.8 } : t) },
    { name: 'return-upright', control: functionalControl('hinge/return', 'reach'), durationMs: 1200, targets: functionalTargets({ hip: 0, knee: 0, ankle: 0 }) },
  ];
}

/** Keep the template's human-readable phase names and the exact same targets. */
export function functionalTemplatePhases(phases: FunctionalPhase[]): TemplatePhase[] {
  return phases.map(({ targets, ...phase }) => ({ ...phase,
    targets: (targets ?? []).map(({ targetDegrees, ...t }) => ({ ...t, peakDeg: targetDegrees })),
  }));
}

/** Shared chair-rise geometry. Pelvis + hip flexion cancel in the leg chain so
 * tipping the pelvis does not lift the thighs. Foot-driven travel derives the
 * forward root advance from the loaded rig while explicit contacts anchor both
 * feet. The seated preparation accommodates the existing deep seated posture. */
export function chairRisePhases(arms: 'relaxed' | 'thigh-assisted', fromSeated = true): FunctionalPhase[] {
  const assisted = arms === 'thigh-assisted';
  const armShapes: Partial<FunctionalShape>[] = assisted ? [
    { arm: 10, armOut: -10, elbow: 18, wrist: -18 },
    { arm: 15, armOut: -10, elbow: 45, wrist: -24 },
    { arm: 5, armOut: -10, elbow: 14, wrist: -14 },
    { arm: 2, armOut: -5, elbow: 8, wrist: -8 },
    { elbow: 8, wrist: 0 },
  ] : Array.from({ length: 5 }, () => ({ elbow: 8 }));
  const body = (i: number, thigh: number, shank: number, pelvis: number, trunk: number) =>
    functionalTargets({ hip: thigh + pelvis, knee: thigh + shank, ankle: shank,
      pelvis, lumbar: trunk * .7, thoracic: trunk * .3, neck: -trunk * .5, ...armShapes[i] });
  const id = assisted ? 'thigh-assisted-rise' : 'stand-up';
  const phases: FunctionalPhase[] = [
    { name: 'seated', durationMs: 400, groundingPosture: 'sitting', ...(!fromSeated ? { holdMs: 300 } : {}),
      control: functionalControl(id + '/prepare', arms, 'seat', true),
      targets: body(0, 79.25, 27, 0, 0) },
    { name: 'lean-forward', durationMs: 450, groundingPosture: 'sitting', velocityClass: 'functional',
      control: functionalControl(id + '/lean', arms, 'seat', true), targets: body(1, 78.25, 29, 10, 28) },
    { name: 'seat-off', durationMs: 200, velocityClass: 'functional',
      control: functionalControl(id + '/seat-off', arms), targets: body(2, 70, 27, 18, 30) },
    { name: 'extension', durationMs: 350, velocityClass: 'functional',
      control: functionalControl(id + '/extend', arms), targets: body(3, 40, 18, 18, 20) },
    { name: 'rise-to-stand', durationMs: 400, holdMs: 100,
      control: functionalControl(id + '/settle', arms), targets: body(4, 0, 0, 0, 0) },
  ];
  if (!fromSeated) phases.unshift({
    name: 'lower-to-seat', durationMs: 700,
    control: functionalControl(id + '/lower-to-seat', arms),
    targets: body(0, 79.25, 27, 0, 40),
  });
  return phases;
}

/** Neutral-to-seat setup followed by the same supported rise, with authored
 * thigh-assistance arms. Hand/thigh contact remains an authored shape. */
export function thighAssistedRisePhases(): FunctionalPhase[] {
  return chairRisePhases('thigh-assisted', false);
}
