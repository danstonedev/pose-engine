import type { SequenceTarget } from './motionSequence';

/** Shared overhead squat setup for FMS and the legacy SFMA overhead version.
 * Engineering targets, checked on the loaded bodies; no scoring or force model.
 * The stance and arm direction are measured after the standard contact solver.
 */
export function overheadSquatTargets(source: SequenceTarget[], dowel: boolean, stance = true): SequenceTarget[] {
  const targets = source.filter(t => !/^[LR]_(UpperArm|Shoulder|Forearm|Hand|Thumb1|Index1|Mid1|Ring1|Pinky1)$/.test(t.joint)).map(t => ({ ...t }));
  const put = (joint: string, motion: string, targetDegrees: number) => {
    const old = targets.find(t => t.joint === joint && t.motion === motion);
    if (old) old.targetDegrees = targetDegrees;
    else targets.push({ joint, motion, targetDegrees });
  };
  for (const side of ['L', 'R']) {
    // The contact solver anchors this stance after setup and keeps each foot
    // under its own knee. Positive abduction opens the narrow neutral rig stance.
    if (stance) {
      put(`${side}_UpLeg`, 'hipAbduction', 8);
      put(`${side}_Foot`, 'ankleInversion', 8);
    }
    put(`${side}_UpperArm`, 'shoulderFlexion', 175);
    put(`${side}_UpperArm`, 'shoulderAbduction', 140);
    put(`${side}_UpperArm`, 'shoulderRotation', -25);
    put(`${side}_Shoulder`, 'upRotation', 40);
    put(`${side}_Shoulder`, 'scapularTilt', 10);
    put(`${side}_Shoulder`, 'protraction', 0);
    put(`${side}_Forearm`, 'elbowFlexion', 3);
    put(`${side}_Forearm`, 'forearmRotation', 0);
    put(`${side}_Hand`, 'wristFlexion', 0);
    put(`${side}_Hand`, 'wristDeviation', 0);
    for (const digit of ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1'])
      put(`${side}_${digit}`, 'fingerFlexion', dowel ? (digit === 'Thumb1' ? 55 : 110) : 0);
  }
  return targets;
}
