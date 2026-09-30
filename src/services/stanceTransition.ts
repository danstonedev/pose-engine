import type { ComposedMotion, SequenceKeyframe, SequenceTarget, StanceContact } from './motionSequence';

const targetOf = (targets: readonly SequenceTarget[], joint: string, motion: string): number =>
  targets.find(t => t.joint === joint && t.motion === motion)?.targetDegrees ?? 0;

/** A supported, one-foot-at-a-time transition into a standing base. Both the
 * target stance and the contact schedule belong to this function, so a future
 * screen or authored motion cannot move the ankles laterally while they bear
 * weight. Angles come from the motion's actual stance, not a squat constant. */
export function stepIntoStandingStance(standing: SequenceTarget[]): {
  keyframes: SequenceKeyframe[]; contacts: StanceContact[]; readyAtMs: number;
} {
  const left = targetOf(standing, 'L_UpLeg', 'hipAbduction');
  const right = targetOf(standing, 'R_UpLeg', 'hipAbduction');
  const leftInv = targetOf(standing, 'L_Foot', 'ankleInversion');
  const rightInv = targetOf(standing, 'R_Foot', 'ankleInversion');
  // Rig-calibrated standing geometry: ~8 cm neutral half-width and ~1.6 cm
  // lateral ankle shift per degree of hip abduction on the three bodies.
  const leftSupportM = Math.max(.12, Math.min(.19, .06 + .012 * left));
  const firstShiftM = -.06;
  const firstExtra = .06 / .016;
  const secondExtra = leftSupportM / .016;
  const pose = (leftOut: boolean, rightOut: boolean, lifted: 'L' | 'R' | null,
    leftExtra = 0, rightExtra = 0, leftSupport = false): SequenceTarget[] => {
    const targets = standing.map(t => ({ ...t }));
    const put = (joint: string, motion: string, targetDegrees: number) => {
      const old = targets.find(t => t.joint === joint && t.motion === motion);
      if (old) old.targetDegrees = targetDegrees;
      else targets.push({ joint, motion, targetDegrees });
    };
    for (const side of ['L', 'R'] as const) {
      const out = side === 'L' ? leftOut : rightOut;
      const spread = side === 'L' ? left : right;
      const inversion = side === 'L' ? leftInv : rightInv;
      const extra = side === 'L' ? leftExtra : rightExtra;
      put(`${side}_UpLeg`, 'hipAbduction', out ? spread + extra : 0);
      put(`${side}_Foot`, 'ankleInversion', out ? inversion + extra : 0);
      if (lifted === side) {
        put(`${side}_UpLeg`, 'hipFlexion', 12);
        put(`${side}_Leg`, 'kneeFlexion', 28);
        // Clear the toe as well as the ankle: plantarflexion let the forefoot
        // cut through the floor even when the ankle joint visibly lifted.
        put(`${side}_Foot`, 'ankleFlexion', 20);
      }
    }
    if (leftSupport) {
      // Let the standing leg yield while the trunk shifts toward that foot.
      // This lowers the pelvis enough for the reaching leg to land without
      // a long straight-leg span or an excessive sideways root translation.
      put('L_UpLeg', 'hipFlexion', 10);
      put('L_Leg', 'kneeFlexion', 18);
      put('L_Foot', 'ankleFlexion', 6);
      put('Spine_Lower', 'lateralTilt', 10);
      put('Spine_Upper', 'lateralTilt', 5);
    }
    return targets;
  };
  const frame = (durationMs: number, targets: SequenceTarget[], x: number): SequenceKeyframe =>
    ({ durationMs, stance: 'planted', targets, root: { translateM: [x, 0, 0] } });
  const keyframes = [
    frame(900, pose(false, false, null), firstShiftM),
    frame(550, pose(true, false, 'L', firstExtra), firstShiftM),
    frame(350, pose(true, false, null, firstExtra), firstShiftM),
    frame(350, pose(true, false, null, 0, 0, true), leftSupportM),
    frame(550, pose(true, true, 'R', 0, secondExtra, true), leftSupportM),
    frame(350, pose(true, true, null, 0, secondExtra, true), leftSupportM),
    frame(200, pose(true, true, null, 0, secondExtra, true), leftSupportM),
    frame(450, pose(true, true, null), 0),
  ];
  const leftLandsAtMs = 1800, rightLiftsAtMs = 2150, rightLandsAtMs = 3050, readyAtMs = 3700;
  return { keyframes, readyAtMs, contacts: [
    { foot: 'R_Foot', fromMs: 0, toMs: rightLiftsAtMs },
    { foot: 'L_Foot', fromMs: leftLandsAtMs, landOnFloor: true },
    { foot: 'R_Foot', fromMs: rightLandsAtMs, toMs: readyAtMs, landOnFloor: true },
    { foot: 'R_Foot', fromMs: readyAtMs, landOnFloor: true },
  ] };
}

/** Apply the same rule to a neutral entry or a measured neutral current pose
 * when the first phase sets and retains a wider bilateral base. Active
 * abduction exercises, gait, airborne tasks and authored step schedules keep
 * their own placement. */
export function prepareStandingFootPlacement(motion: ComposedMotion, currentAngles?: Record<string, number>): ComposedMotion {
  const neutralEntry = motion.startFrom === 'neutral' ||
    (currentAngles != null &&
      (['L', 'R'] as const).every(side =>
        Math.abs(currentAngles[`${side}_UpLeg.hipAbduction`] ?? Infinity) < 2));
  if (motion.footSupportSetup || !neutralEntry || motion.stance !== 'planted' ||
    (motion.startPosture && motion.startPosture !== 'standing') || motion.footDrivenTravel ||
    motion.loop || motion.keyframes.length < 2 || motion.keyframes.length > 113 ||
    motion.keyframes.some(k => k.stance === 'floating' || k.groundingPosture) ||
    motion.keyframes[0]?.root || motion.keyframes[0]?.travel) return motion;
  const first = motion.keyframes[0]!, last = motion.keyframes.at(-1)!;
  const a = first.targets ?? [], b = last.targets ?? [];
  const lateral = (side: 'L' | 'R') => targetOf(a, `${side}_UpLeg`, 'hipAbduction');
  if (!(['L', 'R'] as const).every(side => {
    const angle = lateral(side);
    return angle >= 4 && angle <= 16 &&
      Math.abs(targetOf(b, `${side}_UpLeg`, 'hipAbduction') - angle) < .01 &&
      Math.abs(targetOf(a, `${side}_UpLeg`, 'hipFlexion')) < 8 &&
      Math.abs(targetOf(a, `${side}_Leg`, 'kneeFlexion')) < 8;
  })) return motion;
  const contacts = motion.contacts ?? [];
  if (contacts.length && (contacts.length !== 2 ||
    new Set(contacts.map(c => c.foot)).size !== 2 ||
    contacts.some(c => c.toMs != null || (c.fromMs != null && c.fromMs !== first.durationMs)))) return motion;
  const setup = stepIntoStandingStance(a);
  return { ...motion, keyframes: [...setup.keyframes, ...motion.keyframes.slice(1)],
    footSupportSetup: true, contacts: setup.contacts };
}
