/** Shared locomotor arm coordination for walking, running, marching and turns.
 * Authored secondary motion, not a torque simulation or a normative data set.
 * All targets use the production combined clavicle/girdle shoulder strategy.
 */
import { RELAXED_FINGER_CURL_DEG, type ComposedMotion, type SequenceTarget } from './motionSequence';
import { clampTimeScale } from './motionConstants';

const cap = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
const at = (ts: SequenceTarget[], joint: string, motion: string) => ts.find(t => t.joint === joint && t.motion === motion)?.targetDegrees;
const ARM_CARRIAGE_DEG = -7.4;
const FOREARM_CARRY_DEG = -8;
const WRIST_DEVIATION_CARRY_DEG = -8;

/** Central differences on the authored clock, including pace and loop wrap.
 * Open clips arrive and leave quietly; a hold has no continuing inertial drag.
 * Missing arm commands are not interpreted as new swing commands.
 */
function swingVelocity(motion: ComposedMotion, side: string): number[] {
  const kfs = motion.keyframes, n = kfs.length, loop = !!motion.loop && n > 1;
  const pace = clampTimeScale(motion.modifiers?.timeScale);
  const angle = kfs.map(k => at(k.targets ?? [], `${side}_UpperArm`, 'shoulderFlexion'));
  const span = (i: number) => ((kfs[i]!.durationMs ?? 0) + (kfs[(i - 1 + n) % n]!.holdMs ?? 0)) / pace;
  return kfs.map((k, i) => {
    if (n < 2 || k.holdMs || (!loop && (i === 0 || i === n - 1))) return 0;
    const prev = (i - 1 + n) % n, next = (i + 1) % n;
    const a = angle[prev], b = angle[next], dt = span(i) + span(next);
    return a == null || b == null || dt <= 0 ? 0 : (b - a) * 1000 / dt;
  });
}

/** Adds secondary arm channels only where a shoulder swing is authored. The
 * caller opts in for locomotion; reaches, folded arms and hand supports retain
 * their own task recipes. A zero is an explicit target, not a missing command.
 */
export function coordinateLocomotorArms(motion: ComposedMotion, energy = 1): ComposedMotion {
  const dE = Math.max(0, Math.min(3.2, Number.isFinite(energy) ? energy : 1) - 1);
  const velocities = { L: swingVelocity(motion, 'L'), R: swingVelocity(motion, 'R') };
  const keyframes = motion.keyframes.map((kf, i) => {
    const targets = (kf.targets ?? []).map(t => ({ ...t }));
    const add = (joint: string, field: string, degrees: number) => {
      const old = targets.find(t => t.joint === joint && t.motion === field);
      if (old) old.targetDegrees += degrees;
      else targets.push({ joint, motion: field, targetDegrees: degrees });
    };
    for (const side of ['L', 'R'] as const) {
      const sh = at(kf.targets ?? [], `${side}_UpperArm`, 'shoulderFlexion');
      if (sh == null) continue;
      const velocity = velocities[side][i] ?? 0;
      // Relax the wide rest carriage. The shared post-contact clearance pass
      // opens this only as far as each body's actual limb geometry requires.
      add(`${side}_UpperArm`, 'shoulderAbduction', ARM_CARRIAGE_DEG - cap(.1 * sh, 4));
      // Small humeral rotation with the swing; this is separate from forearm
      // pronation, so the elbow plane and palm no longer move as one rigid unit.
      add(`${side}_UpperArm`, 'shoulderRotation', cap(.16 * sh, 6));
      const elbow = at(kf.targets ?? [], `${side}_Forearm`, 'elbowFlexion');
      if (elbow != null) {
        // Delayed forearm response around the authored walking/running carry.
        // Bounded velocity term separates the elbow reversal from the shoulder
        // reversal. The existing speed-related pump remains about that carry.
        add(`${side}_Forearm`, 'elbowFlexion', cap(cap(-.04 * velocity, 3.5 + dE) - .22 * dE * sh, 14));
      }
      add(`${side}_Forearm`, 'forearmRotation', cap(FOREARM_CARRY_DEG + .35 * sh, 28));
      add(`${side}_Shoulder`, 'protraction', cap(.35 * sh, 10));
      add(`${side}_Shoulder`, 'upRotation', cap(.22 * sh, 7));
      add(`${side}_Shoulder`, 'scapularTilt', cap(.16 * sh, 5));
      const wrist = cap(-.072 * velocity, 22);
      add(`${side}_Hand`, 'wristFlexion', wrist);
      add(`${side}_Hand`, 'wristDeviation', cap(WRIST_DEVIATION_CARRY_DEG + .3 * sh, 16));
      for (const digit of ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1']) {
        const carry = Math.max(14, (RELAXED_FINGER_CURL_DEG[digit] ?? 32) - 10 * dE);
        add(`${side}_${digit}`, 'fingerFlexion', Math.max(12, Math.min(60, carry - (digit === 'Thumb1' ? 0 : wrist))));
      }
    }
    return kf.targets ? { ...kf, targets } : kf;
  });
  return { ...motion, locomotorArmClearance: true, keyframes };
}

const oscillationAboutZero = new Set(['shoulderFlexion', 'shoulderRotation', 'protraction', 'upRotation', 'scapularTilt', 'wristFlexion']);
const carriageChannels = new Set(['shoulderAbduction', 'elbowFlexion', 'forearmRotation', 'wristDeviation', 'fingerFlexion']);
const armJoint = /^[LR]_(Shoulder|UpperArm|Forearm|Hand|Thumb1|Index1|Mid1|Ring1|Pinky1)$/;

/** Quiet the entire arm chain about its existing carry. Median carries retain
 * the bent elbow of running and relaxed wrist/fingers of walking. This works
 * before or after coordination; scaling a shoulder must not leave a full elbow
 * pump or a full scapular oscillation on an otherwise still arm.
 */
export function scaleLocomotorArmSwing(motion: ComposedMotion, amount: number, side?: 'L' | 'R'): ComposedMotion {
  const a = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 1));
  if (a === 1) return motion;
  const centres = new Map<string, number>();
  const values = new Map<string, number[]>();
  for (const kf of motion.keyframes) for (const t of kf.targets ?? []) {
    if (!armJoint.test(t.joint) || (side && !t.joint.startsWith(`${side}_`)) || !carriageChannels.has(t.motion)) continue;
    const key = `${t.joint}.${t.motion}`, samples = values.get(key) ?? [];
    samples.push(t.targetDegrees); values.set(key, samples);
  }
  for (const [key, samples] of values) {
    samples.sort((x, y) => x - y); const mid = Math.floor(samples.length / 2);
    centres.set(key, samples.length % 2 ? samples[mid]! : (samples[mid - 1]! + samples[mid]!) / 2);
  }
  return { ...motion, keyframes: motion.keyframes.map((kf, i) => ({ ...kf,
    ...(kf.targets ? { targets: kf.targets.map(t => {
      if (!armJoint.test(t.joint) || (side && !t.joint.startsWith(`${side}_`))) return t;
      // Keep quiet opening/closing postures (including a transfer into running
      // carry) rather than replacing the final 8-degree elbow with stride carry.
      const quietEnd = !motion.loop && (i === 0 || i === motion.keyframes.length - 1)
        && (at(kf.targets!, `${t.joint[0]}_UpperArm`, 'shoulderFlexion') ?? 0) === 0;
      if (quietEnd) return t;
      const centre = oscillationAboutZero.has(t.motion) ? 0 : centres.get(`${t.joint}.${t.motion}`);
      return centre == null ? t : { ...t, targetDegrees: centre + (t.targetDegrees - centre) * a };
    }) } : {}),
  })) };
}
