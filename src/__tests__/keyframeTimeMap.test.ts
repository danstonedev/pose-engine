/**
 * CONTACT WINDOWS THROUGH A CLAMPED KEYFRAME.
 *
 * A motion's foot-contact windows, stance windows and heading profile are
 * declared in ms on the clock of its authored keyframes. Two re-timings move
 * them onto the clock the body plays on:
 *
 * - the resolver re-times the keyframes themselves (the realistic-velocity
 *   floor stretches a move; `MAX_KEYFRAME_MS` caps a move or a hold at 10 s),
 *   and remaps the windows onto the resolved keyframes (SEAM-7, part 2);
 * - the trajectory paces the resolved keyframes by `modifiers.timeScale`, and
 *   caps a paced hold at 10 s again, and the sampler and the stage re-time the
 *   windows onto it (SEAM-2).
 *
 * Both used to stretch a whole keyframe span evenly: the resolver across a
 * keyframe's move and hold together, and the sampler and stage across the whole
 * motion. When a keyframe's move and hold were re-timed by different amounts, or
 * a paced hold hit the cap, a window at a keyframe's arrival (the end of its
 * move) came early or late. Each move now maps onto its move and each hold
 * onto its hold (`buildKeyframeTimeMap`), and every motion whose keyframes keep
 * their proportions is re-timed exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { buildKeyframeTimeMap } from '../services/keyframeTimeMap';
import { MAX_KEYFRAME_MS, resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { authoredToTrajectoryTimeMap, authoredToTrajectoryTimeScale } from '../services/motionRecording';
import { buildComposedTrajectory, TRAJECTORY_HOLD_CAP_MS } from '../services/motionTrajectory';
import { MOVEMENT_SCREEN, movementScreenMotion, movementScreenPattern } from '../services/movementScreen';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const cfg = BODY_VARIANTS.male;
const SLS_ID = 'sfma-repo-legacy-v1/single-leg-stance/top-tier';

describe('buildKeyframeTimeMap: each move onto its move, each hold onto its hold', () => {
  it('is null when no keyframe changed, so callers skip the remap', () => {
    const spans = [{ durationMs: 400, holdMs: 100 }, { durationMs: 500, holdMs: 0 }];
    expect(buildKeyframeTimeMap(spans, spans.map((s) => ({ ...s })))).toBeNull();
  });

  it('keeps a keyframe arrival at its arrival when only the hold is shortened', () => {
    const map = buildKeyframeTimeMap(
      [{ durationMs: 800, holdMs: 0 }, { durationMs: 3000, holdMs: 20000 }, { durationMs: 3000, holdMs: 0 }],
      [{ durationMs: 800, holdMs: 0 }, { durationMs: 3000, holdMs: 10000 }, { durationMs: 3000, holdMs: 0 }],
    )!;
    expect(map(800)).toBe(800);
    expect(map(2300)).toBe(2300); // mid-move: the move is untouched
    expect(map(3800)).toBe(3800); // the arrival, before the hold
    expect(map(13800)).toBe(8800); // halfway through the hold
    expect(map(23800)).toBe(13800); // the hold's end
    expect(map(25300)).toBe(15300); // after the clamped keyframe: shifted by the time removed
    expect(map(26800)).toBe(16800);
    expect(map(30000)).toBe(20000); // past the end: the tail keeps its distance
  });

  it('keeps a hold starting at its arrival when only the move is stretched', () => {
    const map = buildKeyframeTimeMap([{ durationMs: 250, holdMs: 1000 }], [{ durationMs: 682, holdMs: 1000 }])!;
    expect(map(250)).toBe(682);
    expect(map(750)).toBe(1182);
  });

  it('passes the start, negative times and whole-motion pins through', () => {
    const map = buildKeyframeTimeMap([{ durationMs: 100, holdMs: 0 }], [{ durationMs: 200, holdMs: 0 }])!;
    expect(map(0)).toBe(0);
    expect(map(-5)).toBe(-5);
    expect(map(Infinity)).toBe(Infinity);
    expect(map(-Infinity)).toBe(-Infinity);
  });
});

describe('the resolver keeps a window at the keyframe instant it was authored for', () => {
  it('a contact authored at a clamped keyframe’s arrival engages at its resolved arrival', () => {
    const motion: ComposedMotion = {
      name: 'raise and hold', startFrom: 'neutral',
      keyframes: [
        { durationMs: 800, stance: 'planted', targets: [] },
        { durationMs: 3000, holdMs: 20000, stance: 'planted', targets: [{ joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 45 }] },
        { durationMs: 3000, stance: 'planted', targets: [{ joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 }] },
      ],
      contacts: [{ foot: 'L_Foot' }, { foot: 'R_Foot', fromMs: 3800 }],
    } as ComposedMotion;
    const resolved = resolveComposedMotion(motion, cfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.keyframes.map((kf) => kf.holdMs)).toEqual([0, MAX_KEYFRAME_MS, 0]);
    const arrival = resolved.keyframes[0]!.durationMs + resolved.keyframes[0]!.holdMs + resolved.keyframes[1]!.durationMs;
    expect(resolved.contacts?.find((c) => c.foot === 'R_Foot')?.fromMs).toBe(arrival);
  });

  it('the single-leg stance held 20 s and played whole still re-plants its foot after the lowering', () => {
    const pattern = movementScreenPattern(SLS_ID)!;
    const whole = movementScreenMotion(pattern, 'R')!;
    // The hold lengthened by 10 s, and every contact time after it moved with it, as an author would write it.
    const extra = 10000;
    const peak = whole.keyframes.findIndex((kf) => (kf.holdMs ?? 0) === 10000);
    const holdEnd = whole.keyframes.slice(0, peak + 1).reduce((sum, kf) => sum + kf.durationMs + (kf.holdMs ?? 0), 0);
    const motion: ComposedMotion = {
      ...whole,
      keyframes: whole.keyframes.map((kf, i) => (i === peak ? { ...kf, holdMs: 20000 } : kf)),
      contacts: whole.contacts!.map((c) => ({
        ...c,
        ...(c.fromMs != null && c.fromMs >= holdEnd ? { fromMs: c.fromMs + extra } : {}),
        ...(c.toMs != null && c.toMs >= holdEnd ? { toMs: c.toMs + extra } : {}),
      })),
    };
    const resolved = resolveComposedMotion(motion, cfg);
    expect(resolved.status).toBe('ok');
    const ends = resolved.keyframes.reduce<number[]>((acc, kf) => [...acc, (acc.at(-1) ?? 0) + kf.durationMs + kf.holdMs], []);
    const lowered = ends[peak + 1]!;
    const replant = resolved.contacts!.find((c) => c.foot === 'R_Foot' && c.fromMs != null)!;
    expect(replant.fromMs).toBe(lowered);
    expect(replant.fromMs!).toBeGreaterThan(ends[peak]!);
  });
});

describe('the sampler and the stage re-time windows onto the trajectory the body plays', () => {
  const pose = { variant: 'male', bones: {} };
  const root = { quat: [0, 0, 0, 1] as [number, number, number, number], translateM: [0, 0, 0] as [number, number, number], stance: 'planted' };
  /** The trajectory's own arrival instant for each keyframe of a resolved motion, at a pace. */
  const arrivals = (keyframes: { durationMs: number; holdMs: number }[], timeScale: number) =>
    buildComposedTrajectory(
      { poses: keyframes.map(() => pose), roots: keyframes.map(() => root), durationsMs: keyframes.map((kf) => kf.durationMs), holdsMs: keyframes.map((kf) => kf.holdMs) },
      { startPose: pose, startQuat: [0, 0, 0, 1], startTranslate: [0, 0, 0], timeScale },
    );
  const keyframeArrivals = (keyframes: { durationMs: number; holdMs: number }[]) =>
    keyframes.map((_, i) => keyframes.slice(0, i).reduce((sum, kf) => sum + kf.durationMs + kf.holdMs, 0) + keyframes[i]!.durationMs);

  it('maps each keyframe’s arrival onto the trajectory’s, where a slowed hold is capped', () => {
    const keyframes = [{ durationMs: 800, holdMs: 0 }, { durationMs: 1000, holdMs: 8000 }, { durationMs: 1000, holdMs: 0 }];
    const timeScale = 0.5; // the 8 s hold paces to 16 s, and the trajectory holds it for 10 s
    const { trajectory, settleAtMs } = arrivals(keyframes, timeScale);
    const motion = { keyframes, loop: false, reps: 1, modifiers: { timeScale } };
    const map = authoredToTrajectoryTimeMap(motion, trajectory.totalMs);
    expect(map.identity).toBe(false);
    keyframeArrivals(keyframes).forEach((t, i) => expect(map.toTrajectory(t)).toBeCloseTo(settleAtMs[i]!, 6));
    expect(map.toTrajectory(keyframeArrivals(keyframes)[2]! + 0)).toBeCloseTo(1600 + 2000 + TRAJECTORY_HOLD_CAP_MS + 2000, 6);
    // One even stretch over the whole motion brought the arrival into the capped hold a second early.
    const uniform = keyframeArrivals(keyframes)[1]! * authoredToTrajectoryTimeScale(motion, trajectory.totalMs);
    expect(settleAtMs[1]! - uniform).toBeGreaterThan(900);
    // Back again: the heading profile is read at the authored time of a trajectory instant.
    settleAtMs.forEach((t, i) => expect(map.toAuthored(t)).toBeCloseTo(keyframeArrivals(keyframes)[i]!, 6));
  });

  it('re-times a motion no hold cap touches exactly as the one even factor did', () => {
    const keyframes = [{ durationMs: 400, holdMs: 100 }, { durationMs: 500, holdMs: 0 }];
    const map = authoredToTrajectoryTimeMap({ keyframes, loop: false, reps: 1, modifiers: { timeScale: 1.25 } }, 800);
    const factor = authoredToTrajectoryTimeScale({ keyframes }, 800);
    for (const t of [0, 123, 400, 500, 777, 1000]) expect(map.toTrajectory(t)).toBe(t * factor);
    for (const t of [0, 99, 400, 800]) expect(map.toAuthored(t)).toBe(t / factor);
    expect(authoredToTrajectoryTimeMap({ keyframes, loop: false, reps: 1 }, 1000).identity).toBe(true);
  });

  it('every movement-screen pattern, held or whole, re-times its windows as before', () => {
    for (const p of MOVEMENT_SCREEN) for (const mode of ['movement', 'hold'] as const) {
      const resolved = resolveComposedMotion(movementScreenMotion(p, 'R', mode)!, cfg);
      const total = resolved.keyframes.reduce((sum, kf) => sum + kf.durationMs + kf.holdMs, 0);
      expect(authoredToTrajectoryTimeMap(resolved, total).identity, `${p.testId} ${mode}`).toBe(true);
    }
  });
});

describe('a held pattern keeps only the contact windows of the keyframes it plays', () => {
  it('drops the single-leg stance’s re-plant, which belongs to the lowering the held motion cuts', () => {
    const held = movementScreenMotion(movementScreenPattern(SLS_ID)!, 'R', 'hold')!;
    const end = held.keyframes.reduce((sum, kf) => sum + kf.durationMs + (kf.holdMs ?? 0), 0);
    expect(held.contacts?.some((c) => c.fromMs != null && c.fromMs >= end)).toBe(false);
    // The standing foot still bears weight throughout, and the lifted foot is held until it lifts.
    expect(held.contacts).toEqual(movementScreenMotion(movementScreenPattern(SLS_ID)!, 'R')!.contacts!.filter((c) => c.fromMs == null || c.fromMs < end));
  });
});
