import type { ComposedMotion } from './motionSequence';
import { analyzeGaitPlan } from './gaitEnrichment';

export interface FaultTarget {
  joint: string;
  motion: string;
  deg: number;
}

export function gaitFaultWindows(motion: ComposedMotion): NonNullable<ComposedMotion['gaitStanceWindowsMs']> {
  if (motion.gaitStanceWindowsMs?.length) return motion.gaitStanceWindowsMs;
  const analysis = analyzeGaitPlan(motion);
  if (!analysis.isGait) return [];
  const windows: NonNullable<ComposedMotion['gaitStanceWindowsMs']> = [];
  let fromMs = 0;
  for (let i = 0; i < motion.keyframes.length; i++) {
    const kf = motion.keyframes[i]!;
    const foot = `${analysis.stanceByKf[i]}_Foot`;
    const toMs = fromMs + (kf.durationMs ?? 0) + (kf.holdMs ?? 0);
    const last = windows.at(-1);
    if (last?.foot === foot) last.toMs = toMs;
    else windows.push({ foot, fromMs, toMs });
    fromMs = toMs;
  }
  return windows;
}

/** Author a deviation during weight bearing or swing, on the gait's own clock.
 * Non-gait tasks retain a sustained offset (e.g. valgus during a squat).
 * Explicit zeros release a deviation instead of carrying it into the next step.
 */
export function addGaitPhaseTargets(
  motion: ComposedMotion,
  side: 'left' | 'right',
  phase: 'stance' | 'swing',
  additions: readonly FaultTarget[],
): ComposedMotion {
  const stanceSide = phase === 'stance' ? side : side === 'left' ? 'right' : 'left';
  const foot = stanceSide === 'left' ? 'L_Foot' : 'R_Foot';
  const arrivals: number[] = [];
  let cursor = 0;
  for (const kf of motion.keyframes) {
    cursor += kf.durationMs ?? 0;
    arrivals.push(cursor);
    cursor += kf.holdMs ?? 0;
  }
  const windows = gaitFaultWindows(motion);
  const weights = arrivals.map(t => {
    if (!windows?.length) return 1;
    const w = windows.find(w => w.foot === foot && t > w.fromMs && t < w.toMs);
    if (!w) return 0;
    // A braking window can start before the incoming foot actually lands.
    // Deforming that incoming leg would capture a crossed footprint and keep
    // it pinned after the authored angles have returned to neutral.
    const contact = phase === 'stance' ? motion.contacts?.find(c => c.foot === foot
      && (c.fromMs ?? 0) < w.toMs && (c.toMs ?? Infinity) > w.fromMs) : undefined;
    const from = Math.max(w.fromMs, contact?.fromMs ?? w.fromMs);
    return t > from && t < w.toMs ? Math.sin(Math.PI * (t - from) / (w.toMs - from)) : 0;
  });
  // The slider describes the peak authored deviation, irrespective of how the
  // builder partitions its stance keyframes. Interpolation supplies the ramp.
  const peak = Math.max(...weights, 0);
  const carried = new Map<string, number>();
  return {
    ...motion,
    ...(windows.length ? { gaitLegClearance: true } : {}),
    keyframes: motion.keyframes.map((kf, index) => {
      const targets = (kf.targets ?? []).map(t => ({ ...t }));
      for (const t of kf.targets ?? []) carried.set(`${t.joint}/${t.motion}`, t.targetDegrees);
      for (const a of additions) {
        const key = `${a.joint}/${a.motion}`;
        const value = (carried.get(key) ?? 0) + a.deg * (peak > 0 ? weights[index]! / peak : 0);
        const i = targets.findIndex(t => t.joint === a.joint && t.motion === a.motion);
        const target = { joint: a.joint, motion: a.motion, targetDegrees: value };
        if (i >= 0) targets[i] = target;
        else targets.push(target);
      }
      return { ...kf, targets };
    }),
  };
}
