import type { ComposedMotion, SequenceKeyframe, SequenceTarget, StanceContact } from './motionSequence';

const targetOf = (targets: readonly SequenceTarget[], joint: string, motion: string): number =>
  targets.find(t => t.joint === joint && t.motion === motion)?.targetDegrees ?? 0;

/** Approximate sole-centre layout relative to the pelvis, in centimetres.
 * Forward is the body's +Z direction; left and right can be staggered. */
export interface StandingStance {
  widthCm: number;
  leftForwardCm: number;
  rightForwardCm: number;
}

export const DEFAULT_STANDING_STANCE: Readonly<StandingStance> = {
  widthCm: 42, leftForwardCm: 0, rightForwardCm: 0,
};

const putTarget = (targets: SequenceTarget[], joint: string, motion: string, targetDegrees: number) => {
  const old = targets.find(t => t.joint === joint && t.motion === motion);
  if (old) old.targetDegrees = targetDegrees;
  else targets.push({ joint, motion, targetDegrees });
};

/** Apply a foot layout to a stable standing movement. The same planted-contact
 * entry is used by screens, library squats and any other bilateral standing
 * posture; gait, stepping tasks and exercises with their own contacts opt out.
 * The angles are a rig-calibrated approximation, not a clinical measurement. */
export function withStandingStance(motion: ComposedMotion, requested: StandingStance, variant: 'male' | 'female' | 'neutral' = 'neutral'): ComposedMotion {
  if (![requested.widthCm, requested.leftForwardCm, requested.rightForwardCm].every(Number.isFinite) ||
    requested.widthCm < 20 || requested.widthCm > 55 ||
    Math.abs(requested.leftForwardCm) > 12 || Math.abs(requested.rightForwardCm) > 12) {
    throw new RangeError('Standing stance must be 20–55 cm wide with each foot within 12 cm fore/aft.');
  }
  const simpleContacts = !motion.contacts?.length || (motion.contacts.length === 2 &&
    new Set(motion.contacts.map(c => c.foot)).size === 2 &&
    motion.contacts.every(c => ['L_Foot', 'R_Foot'].includes(c.foot) && c.toMs == null && (c.fromMs == null || c.fromMs === 0)));
  const upperOnly = motion.stance !== 'planted' && motion.keyframes.every(k =>
    (k.targets ?? []).every(t => !/^[LR]_(?:UpLeg|Leg|Foot|Toes)$/u.test(t.joint)));
  if ((!upperOnly && motion.stance !== 'planted') || (motion.startPosture && motion.startPosture !== 'standing') ||
    motion.loop || motion.footDrivenTravel || motion.keyframes.length < 1 || motion.keyframes.length > 112 ||
    motion.keyframes.some(k => k.stance === 'floating' || k.groundingPosture || k.travel) ||
    (!motion.footSupportSetup && (!simpleContacts || motion.keyframes.some(k => k.root)))) return motion;
  const originalSetup = motion.footSupportSetup ? motion.keyframes.slice(0, 8) : [];
  if (motion.footSupportSetup && originalSetup.length !== 8) return motion;
  const body = motion.keyframes.slice(originalSetup.length);
  if (!body.length) return motion;
  // Sole-centre fit of the loaded runtime rigs (cm = intercept + slope ×
  // bilateral hip-abduction degrees), measured with the planted-foot sampler.
  const fit = {
    female: { interceptCm: 17.3, widthCmPerDeg: 3.23, forwardCmPerDeg: 1.63 },
    male: { interceptCm: 18.3, widthCmPerDeg: 3.40, forwardCmPerDeg: 1.69 },
    neutral: { interceptCm: 13.4, widthCmPerDeg: 2.79, forwardCmPerDeg: 1.46 },
  }[variant];
  const widthDeg = (requested.widthCm - fit.interceptCm) / fit.widthCmPerDeg;
  const offsets = { L: requested.leftForwardCm / fit.forwardCmPerDeg, R: requested.rightForwardCm / fit.forwardCmPerDeg };
  const adapt = (targets: SequenceTarget[]): SequenceTarget[] => {
    const result = targets.map(t => ({ ...t }));
    for (const side of ['L', 'R'] as const) {
      putTarget(result, `${side}_UpLeg`, 'hipAbduction', widthDeg);
      putTarget(result, `${side}_Foot`, 'ankleInversion', widthDeg);
      putTarget(result, `${side}_UpLeg`, 'hipFlexion', targetOf(result, `${side}_UpLeg`, 'hipFlexion') - (motion.standingStanceOffsetsDeg?.[side] ?? 0) + offsets[side]);
    }
    return result;
  };
  const standing = adapt(originalSetup.length ? originalSetup[7]!.targets ?? [] : body.at(-1)!.targets ?? []);
  const setup = stepIntoStandingStance(standing);
  return {
    ...motion, stance: 'planted', footSupportSetup: true, standingStanceOffsetsDeg: offsets, contacts: setup.contacts,
    keyframes: [...setup.keyframes, ...body.map(k => ({ ...k, targets: adapt(k.targets ?? []) }))],
  };
}

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
    const put = (joint: string, motion: string, targetDegrees: number) =>
      putTarget(targets, joint, motion, targetDegrees);
    for (const side of ['L', 'R'] as const) {
      const out = side === 'L' ? leftOut : rightOut;
      const spread = side === 'L' ? left : right;
      const inversion = side === 'L' ? leftInv : rightInv;
      const extra = side === 'L' ? leftExtra : rightExtra;
      put(`${side}_UpLeg`, 'hipAbduction', out ? spread + extra : 0);
      put(`${side}_Foot`, 'ankleInversion', out ? inversion + extra : 0);
      put(`${side}_UpLeg`, 'hipFlexion', out ? targetOf(standing, `${side}_UpLeg`, 'hipFlexion') : 0);
      if (lifted === side) {
        put(`${side}_UpLeg`, 'hipFlexion', 12 + targetOf(standing, `${side}_UpLeg`, 'hipFlexion'));
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
      put('L_UpLeg', 'hipFlexion', 10 + targetOf(standing, 'L_UpLeg', 'hipFlexion'));
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
