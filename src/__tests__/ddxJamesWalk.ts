/**
 * DDx's walk for James (hip-groin-64, task `g-gait-test`) — the product motion
 * DDx plays on this engine, built here the way DDx builds it
 * (ddx_app src/movement/taskMotions.ts: jamesGait, twoCycles, paced, retime,
 * capped), so the engine's release comparisons can play it without DDx: two
 * cycles of the 0.85-speed travelling walk, each stance held by its ankle from
 * landing and by its forefoot from heel rise until the toes lift, both hips 2°
 * abducted, the right hip never extended past 0°, and the stance keyframes
 * around the right push-off slowed to 0.8. DDx samples it at 30 Hz.
 *
 * Only the construction is copied; nothing here tunes it. If DDx's walk changes
 * shape, this copy stays as it was when the release comparisons were measured.
 */
import type { ComposedMotion } from '../services/motionSequence';
import { buildTravelWalk } from '../services/movementLocomotion';
import { widenStep } from '../services/gaitModifiers';

type Target = NonNullable<ComposedMotion['keyframes'][number]['targets']>[number];
type Keyframe = ComposedMotion['keyframes'][number];
const t = (joint: string, motion: string, targetDegrees: number): Target => ({ joint, motion, targetDegrees });

function mapTargets(motion: ComposedMotion, change: (target: Target) => Target): ComposedMotion {
  return {
    ...motion,
    keyframes: motion.keyframes.map((keyframe) =>
      keyframe.targets ? { ...keyframe, targets: keyframe.targets.map(change) } : keyframe,
    ),
  };
}

function withTargets(motion: Pick<ComposedMotion, 'keyframes'>, extra: Target[]): Pick<ComposedMotion, 'keyframes'> {
  return {
    ...motion,
    keyframes: motion.keyframes.map((keyframe) => ({
      ...keyframe,
      targets: [
        ...(keyframe.targets ?? []).filter((item) => !extra.some((add) => add.joint === item.joint && add.motion === item.motion)),
        ...extra,
      ],
    })),
  };
}

const capped = (motion: ComposedMotion, joint: string, name: string, limit: { min?: number; max?: number }) =>
  mapTargets(motion, (target) =>
    target.joint === joint && target.motion === name
      ? { ...target, targetDegrees: Math.min(limit.max ?? Infinity, Math.max(limit.min ?? -Infinity, target.targetDegrees)) }
      : target,
  );

function retime(
  motion: ComposedMotion,
  changes: Record<number, number | { durationMs?: number; holdMs?: number }>,
): ComposedMotion {
  const timed = motion.keyframes.map((keyframe, index) => {
    const change = changes[index];
    if (change === undefined) return keyframe;
    if (typeof change === 'number') {
      return {
        ...keyframe,
        durationMs: Math.round(keyframe.durationMs * change),
        ...(keyframe.holdMs ? { holdMs: Math.round(keyframe.holdMs * change) } : {}),
      };
    }
    return { ...keyframe, ...change };
  });
  const span = (keyframe: Keyframe) => keyframe.durationMs + (keyframe.holdMs ?? 0);
  const before = [0];
  const after = [0];
  motion.keyframes.forEach((keyframe, index) => {
    before.push(before[index]! + span(keyframe));
    after.push(after[index]! + span(timed[index]!));
  });
  const at = (ms: number | undefined) => {
    if (ms === undefined) return undefined;
    const index = Math.max(0, before.findIndex((end, i) => i > 0 && ms <= end) - 1);
    const width = before[index + 1]! - before[index]!;
    return Math.round(after[index]! + (width ? (ms - before[index]!) / width : 0) * (after[index + 1]! - after[index]!));
  };
  const windowed = <W extends { fromMs?: number; toMs?: number }>(item: W): W => ({
    ...item,
    ...(item.fromMs !== undefined ? { fromMs: at(item.fromMs) } : {}),
    ...(item.toMs !== undefined ? { toMs: at(item.toMs) } : {}),
  });
  return {
    ...motion,
    keyframes: timed,
    ...(motion.contacts ? { contacts: motion.contacts.map(windowed) } : {}),
    ...(motion.gaitCycleMs ? { gaitCycleMs: windowed(motion.gaitCycleMs) as ComposedMotion['gaitCycleMs'] } : {}),
    ...(motion.gaitStanceWindowsMs ? { gaitStanceWindowsMs: motion.gaitStanceWindowsMs.map(windowed) } : {}),
    ...(motion.headingProfileMs
      ? { headingProfileMs: motion.headingProfileMs.map((point) => ({ ...point, tMs: at(point.tMs)! })) }
      : {}),
  } as ComposedMotion;
}

function paced(motion: ComposedMotion): ComposedMotion {
  const modifiers = motion.modifiers as { timeScale?: number } | undefined;
  const scale = modifiers?.timeScale;
  if (!scale || scale === 1) return motion;
  const { timeScale: _, ...rest } = modifiers!;
  return {
    ...retime(motion, Object.fromEntries(motion.keyframes.map((_k, index) => [index, 1 / scale]))),
    modifiers: rest,
  } as ComposedMotion;
}

function mirrored(motion: Pick<ComposedMotion, 'keyframes'>): Pick<ComposedMotion, 'keyframes'> {
  const swap = (joint: string) =>
    joint.startsWith('L_') ? `R_${joint.slice(2)}` : joint.startsWith('R_') ? `L_${joint.slice(2)}` : joint;
  const midline = /^(Hips|Spine_Lower|Spine_Upper|Neck)$/u;
  return mapTargets(motion as ComposedMotion, (target) => ({
    ...target,
    joint: swap(target.joint),
    targetDegrees:
      midline.test(target.joint) && (target.motion === 'lateralTilt' || target.motion === 'rotation')
        ? -target.targetDegrees
        : target.targetDegrees,
  }));
}

const keyframeWith = (keyframe: Keyframe, extra: Target[]): Keyframe => withTargets({ keyframes: [keyframe] }, extra).keyframes[0]!;
const legOf = (keyframe: Keyframe, side: 'L' | 'R'): Target[] =>
  (keyframe.targets ?? []).filter(
    (item) => new RegExp(`^${side}_(UpLeg|Leg|Foot|Toes)$`, 'u').test(item.joint) && /Flexion$/u.test(item.motion),
  );

type LegPose = { hip: number; knee: number; ankle: number };
type PushOff = { heelRise: LegPose; initialSwing?: LegPose; midSwing: { hip: number; knee: number }; liftOff: number };
const BRAKING = { reach: 0.8, armSwing: 0.7 };
const STRIDE_DERIVED = /^(Hips\.(anteriorTilt|lateralTilt|rotation)|(Spine_Lower|Spine_Upper|Neck)\.rotation)$/u;
const PUSH_OFF: PushOff = {
  heelRise: { hip: -3.5, knee: 28.5, ankle: -6 },
  initialSwing: { hip: -1, knee: 46.5, ankle: -0.5 },
  midSwing: { hip: 8.5, knee: 13 },
  liftOff: 0.46,
};
const PUSH_OFF_HIP_AT_ZERO: PushOff = { heelRise: { hip: 0, knee: 33, ankle: 4 }, midSwing: { hip: 10, knee: 10 }, liftOff: 0.45 };
const JAMES_PUSH_OFF: Record<'L' | 'R', PushOff> = { L: PUSH_OFF, R: PUSH_OFF_HIP_AT_ZERO };
const TOE_PIVOT = { heelRise: 0.35 };
const SET_DOWN = { hip: 30, ms: 200, landsAt: 0.5 };

const degreesOf = (keyframe: Keyframe, joint: string, motion: string) => {
  const found = keyframe.targets?.find((item) => item.joint === joint && item.motion === motion);
  if (!found) throw new Error(`no ${joint}.${motion}`);
  return found.targetDegrees;
};

function twoCycles(walk: ComposedMotion, pushOff: Record<'L' | 'R', PushOff>): ComposedMotion {
  const k = walk.keyframes;
  if (k.length !== 11) throw new Error('the travel walk changed shape');
  const [braking, settle] = [k[9]!, k[10]!];
  const posed = (keyframe: Keyframe, side: 'L' | 'R', pose: LegPose) =>
    keyframeWith(keyframe, [
      t(`${side}_UpLeg`, 'hipFlexion', pose.hip),
      t(`${side}_Leg`, 'kneeFlexion', pose.knee),
      t(`${side}_Foot`, 'ankleFlexion', pose.ankle),
    ]);
  const midSwing = (keyframe: Keyframe, side: 'L' | 'R') =>
    keyframeWith(keyframe, [
      t(`${side}_UpLeg`, 'hipFlexion', degreesOf(keyframe, `${side}_UpLeg`, 'hipFlexion') + pushOff[side].midSwing.hip),
      t(`${side}_Leg`, 'kneeFlexion', degreesOf(keyframe, `${side}_Leg`, 'kneeFlexion') + pushOff[side].midSwing.knee),
    ]);
  const cycle = k.slice(1, 9).map((keyframe, index) => {
    const side = index < 4 ? 'L' : 'R';
    const phase = index % 4;
    const pose = phase === 0 ? pushOff[side].heelRise : phase === 1 ? pushOff[side].initialSwing : undefined;
    return pose ? posed(keyframe, side, pose) : phase === 2 ? midSwing(keyframe, side) : keyframe;
  });
  const halfCycleBefore = mirrored({ keyframes: [cycle[3]!] }).keyframes[0]!;
  const steady = keyframeWith(cycle[7]!, [
    ...(cycle[7]!.targets ?? []).flatMap((item) =>
      item.joint === 'R_UpLeg' && item.motion === 'hipFlexion'
        ? [{ ...item, targetDegrees: item.targetDegrees / BRAKING.reach }]
        : item.motion === 'shoulderFlexion'
          ? [{ ...item, targetDegrees: item.targetDegrees / BRAKING.armSwing }]
          : [],
    ),
    ...(halfCycleBefore.targets ?? []).filter((item) => STRIDE_DERIVED.test(`${item.joint}.${item.motion}`)),
  ]);
  const functional = { velocityClass: 'functional' as const };
  const toeOff: Keyframe = { ...keyframeWith(braking, legOf(k[1]!, 'L')), ...functional, durationMs: k[5]!.durationMs };
  const swingThrough: Keyframe = {
    ...keyframeWith(braking, legOf(k[2]!, 'L')),
    ...functional,
    durationMs: braking.durationMs - toeOff.durationMs,
  };
  const setDown: Keyframe = {
    ...keyframeWith(braking, [
      ...legOf(settle, 'R'),
      t('L_UpLeg', 'hipFlexion', SET_DOWN.hip),
      t('L_Leg', 'kneeFlexion', 2 * SET_DOWN.hip),
      t('L_Foot', 'ankleFlexion', 0),
      t('L_Toes', 'toeFlexion', 0),
    ]),
    durationMs: SET_DOWN.ms,
  };
  const keyframes = [
    k[0]!,
    ...cycle.slice(0, 7),
    steady,
    { ...cycle[0]!, durationMs: k[5]!.durationMs },
    ...cycle.slice(1),
    toeOff,
    swingThrough,
    setDown,
    settle,
  ];
  const end = (index: number) => keyframes.slice(0, index + 1).reduce((sum, item) => sum + item.durationMs + (item.holdMs ?? 0), 0);
  const total = end(keyframes.length - 1);
  const lLands = end(19) + SET_DOWN.landsAt * settle.durationMs;
  const stance = (foot: 'L' | 'R', landsMs: number, terminal: number) => {
    const heelRise = end(terminal) - TOE_PIVOT.heelRise * keyframes[terminal]!.durationMs;
    return [
      { foot: `${foot}_Foot`, fromMs: landsMs, toMs: heelRise },
      {
        foot: `${foot}_Toes`,
        fromMs: heelRise,
        toMs: end(terminal + 1) + pushOff[foot].liftOff * keyframes[terminal + 2]!.durationMs,
      },
    ];
  };
  return {
    ...walk,
    keyframes,
    contacts: [
      ...stance('R', 0, 4),
      ...stance('L', end(5), 8),
      ...stance('R', end(9), 12),
      ...stance('L', end(13), 16),
      { foot: 'R_Foot', fromMs: end(17), toMs: total },
      { foot: 'L_Foot', fromMs: lLands, toMs: total },
    ],
    gaitStanceWindowsMs: [
      { foot: 'R_Foot', fromMs: 0, toMs: end(4) },
      { foot: 'L_Foot', fromMs: end(4), toMs: end(8) },
      { foot: 'R_Foot', fromMs: end(8), toMs: end(12) },
      { foot: 'L_Foot', fromMs: end(12), toMs: end(16) },
      { foot: 'R_Foot', fromMs: end(16), toMs: lLands, travelLock: true },
    ],
    gaitCycleMs: { ...walk.gaitCycleMs!, fromMs: end(9), toMs: end(16) },
  } as ComposedMotion;
}

/** DDx's James walk (`g-gait-test`, one chapter), as DDx builds it. */
export function ddxJamesWalk(): ComposedMotion {
  let walk = widenStep(twoCycles(paced(buildTravelWalk({ speed: 0.85 })), JAMES_PUSH_OFF), 2);
  walk = capped(walk, 'R_UpLeg', 'hipFlexion', { min: 0 });
  return retime(walk, { 2: 0.8, 3: 0.8, 4: 0.8, 10: 0.8, 11: 0.8, 12: 0.8 });
}
