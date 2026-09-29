/** Whole-body ownership for reaching and hand-supported exercises.
 * Girdle values are bounded engineering seeds on the existing shoulder proxy,
 * not independent SC/AC articulation or measured scapular kinematics. */
import { functionalControl, functionalTargets, type FunctionalShape } from './functionalRecipes';
import { defineBodyControl, type BodyControlPhase, type MajorBodyJoint } from './movementControl';
import type { SequenceTarget } from './motionSequence';

export type BodySide = 'L' | 'R';
const sides = ['L', 'R'] as const;
export const bodyTarget = (joint: string, motion: string, targetDegrees: number): SequenceTarget =>
  ({ joint, motion, targetDegrees });

/** Explicit task values replace quiet defaults once, by joint and channel.
 * This prevents a later baseline target from undoing the intended movement. */
export function completeBodyTargets(overrides: SequenceTarget[], shape: FunctionalShape = { hip: 0, knee: 0, ankle: 0 }): SequenceTarget[] {
  const targets = new Map<string, SequenceTarget>();
  for (const t of [...functionalTargets(shape), ...overrides]) targets.set(`${t.joint}/${t.motion}`, t);
  return [...targets.values()];
}

export function upperScreenControl(id: string): BodyControlPhase {
  const phase = functionalControl(id, 'reach');
  for (const key of ['Hips', 'Spine_Lower', 'Spine_Upper', 'L_UpLeg', 'R_UpLeg', 'L_Leg', 'R_Leg', 'L_Foot', 'R_Foot'] as const) {
    phase.joints[key] = { role: 'held', purpose: 'Hold the neutral standing base and trunk for an isolated upper-body screen' };
  }
  for (const side of sides) phase.joints[`${side}_Shoulder`] = {
    role: 'driven', purpose: 'Author task-specific protraction while shared rhythm supplies elevation and tilt',
  };
  for (const side of sides) phase.joints[`${side}_Hand`] = {
    role: 'held', purpose: 'Hold the prescribed wrist posture; shared relaxation owns the hand only when the screen leaves it unspecified',
  };
  phase.joints.Neck.purpose = 'Hold neutral gaze for arm screens or perform the isolated cervical screen';
  return phase;
}

/** Flat digits are part of the floor-palm setup. A prior fist must not persist
 * merely because relaxedHands correctly yields ownership to a loaded hand. */
export function supportedBodyTargets(overrides: SequenceTarget[], posture: 'plank' | 'quadruped', protraction: number): SequenceTarget[] {
  const shape = posture === 'plank'
    ? { hip: 0, knee: 0, ankle: 20, arm: 90, elbow: 5, wrist: -45 }
    : { hip: 95, knee: 100, ankle: -45, arm: 90, elbow: 5, wrist: -45 };
  return completeBodyTargets([
    ...sides.flatMap(side => [
      bodyTarget(`${side}_Shoulder`, 'protraction', protraction),
      ...['Thumb', 'Index', 'Mid', 'Ring', 'Pinky'].map(digit => bodyTarget(`${side}_${digit}1`, 'fingerFlexion', 0)),
    ]), ...overrides,
  ], shape);
}

export function supportedBodyControl(id: string, posture: 'plank' | 'quadruped', raisedArm?: BodySide): BodyControlPhase {
  const raisedLeg = raisedArm === 'L' ? 'R' : raisedArm === 'R' ? 'L' : undefined;
  const groups: Parameters<typeof defineBodyControl>[0]['groups'] = [
    { joints: ['Hips'], role: 'held', purpose: 'Stabilize pelvic articulation separately from support-driven root placement' },
    { joints: ['Spine_Lower', 'Spine_Upper', 'Neck'], role: 'held', purpose: 'Maintain a neutral trunk and neck while the limbs and root perform the task' },
    { joints: ['Spine_Mid'], role: 'derived', source: 'Spine_Upper', purpose: 'Share thoracic stabilization' },
    { joints: ['Neck_Lower'], role: 'derived', source: 'Neck', purpose: 'Share cervical stabilization' },
    { joints: ['Head'], role: 'held', purpose: 'Hold the entry Head orientation relative to the controlled cervical region' },
  ];
  for (const side of sides) {
    const key = (part: string) => `${side}_${part}` as MajorBodyJoint;
    const freeHand = side === raisedArm, freeLeg = side === raisedLeg;
    groups.push(
      { joints: [key('Shoulder')], role: 'driven', purpose: 'Coordinate girdle protraction with the loaded or reaching phase; automatic rhythm supplies other proxy axes' },
      { joints: [key('UpperArm'), key('Forearm')], role: freeHand ? 'driven' : 'derived',
        ...(!freeHand ? { source: key('Hand') } : {}),
        purpose: freeHand ? 'Reach forward with explicit humeral and forearm rotation' : 'Seed the arm, then follow the hand contact through reach IK' },
      { joints: [key('Hand')], role: freeHand ? 'driven' : 'contact',
        ...(!freeHand ? { support: 'floor' } : {}),
        purpose: freeHand ? 'Release the floor wrist extension for the lifted reach' : 'Hold the solved hand position with authored wrist orientation and open digits' },
      { joints: [key('UpLeg')], role: freeLeg ? 'driven' : 'held', purpose: freeLeg ? 'Extend the opposite hip without rolling the pelvis' : 'Hold the supporting hip alignment' },
      { joints: [key('Leg')], role: freeLeg ? 'driven' : posture === 'quadruped' ? 'contact' : 'held',
        ...(!freeLeg && posture === 'quadruped' ? { support: 'floor' } : {}),
        purpose: freeLeg ? 'Extend the raised knee' : posture === 'quadruped' ? 'Provide the knee-height support pin' : 'Keep the supporting knee extended' },
      { joints: [key('Foot')], role: 'held', purpose: 'Control ankle posture and prevent inherited inversion or rotation' },
      { joints: [key('Toes')], role: posture === 'plank' ? 'contact' : 'held',
        ...(posture === 'plank' ? { support: 'floor' } : {}),
        purpose: posture === 'plank' ? 'Provide the toe-height support pin; root pitch lowers and raises the body' : 'Keep the forefoot shape stable' },
    );
  }
  return defineBodyControl({ id, groups, supports: ['floor'], root: { translation: 'support', orientation: 'placement' } });
}
