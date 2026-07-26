/**
 * PACE-SYMMETRIC FLOORING + RESOLVED-TIME WINDOWS (SEAM-7 / DET-RES-01, R4).
 *
 * DET-RES-01 — the paced-walk limp. The velocity floor seeds a looping motion's
 * FIRST keyframe from NEUTRAL, so the walk's right-initial-contact charged a 40°
 * from-rest knee swing (floor 166.7 ms, 1.3 ms under its 168 ms duration) while
 * its mirror, left-initial-contact, charged only the 35° swing from its real
 * predecessor. Under pace the amplitude grows, so kf0 floored one-sidedly and
 * the half-cycles desynced — a built-in ~0.4%-and-growing step-time limp. The
 * resolver now seeds a `loop` motion's kf0 from its loop-WRAP predecessor (the
 * pose the last keyframe flows back into at playback), so both mirror keyframes
 * floor identically — the cycle stays symmetric at every pace.
 *
 * SEAM-7 — windows on the resolved clock. `contacts` / `gaitStanceWindowsMs` are
 * authored at KEYFRAME BOUNDARIES; the resolver now remaps them from the authored
 * boundaries onto the RESOLVED ones, so a floor bump on any keyframe carries the
 * windows straddling it. Byte-identical when nothing floors (pace ≤ the point a
 * keyframe crosses its floor).
 */
import { describe, expect, it } from 'vitest';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  paceGait,
  buildTravelWalk,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const walkTemplate = () => MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!;

/** Resolved per-keyframe total (travel + hold). */
const durs = (m: ComposedMotion): number[] =>
  resolveComposedMotion(m, variantCfg).keyframes.map((k) => k.durationMs + k.holdMs);

/** The walk cycle's L/R step-time asymmetry (%) — the two 4-phase half-cycles. */
function halfCycleAsymmetryPct(d: number[]): number {
  const h1 = d.slice(0, 4).reduce((a, b) => a + b, 0);
  const h2 = d.slice(4, 8).reduce((a, b) => a + b, 0);
  return (Math.abs(h1 - h2) / ((h1 + h2) / 2)) * 100;
}

describe('DET-RES-01 — the paced walk floors symmetrically (loop-wrap seed)', () => {
  for (const speed of [0.9, 1.05, 1.2]) {
    it(`speed ${speed}: left/right step times stay symmetric (0% asymmetry)`, () => {
      const paced = paceGait(templateToComposedMotion(walkTemplate()), speed);
      const d = durs(paced);
      expect(d).toHaveLength(8);
      // The two half-cycles are bit-for-bit equal — no one-sided floor bump.
      expect(d.slice(0, 4)).toEqual(d.slice(4, 8));
      expect(halfCycleAsymmetryPct(d)).toBe(0);
    });
  }

  it('the loop-wrap seed is what stops a floor-bound kf0 from limping', () => {
    // The walk itself no longer reaches its duration floor at any pace: its
    // phases declare the locomotor velocity class, whose 600 °/s cap and 90 ms
    // minimum leave headroom the old deliberate-class floors did not (see
    // gaitPerryTiming). So the limp this seed fixes can no longer be provoked by
    // pacing the walk — and a test that pins the bug to the walk's incidental
    // timing would pass or fail for the wrong reason.
    //
    // Exercise the MECHANISM directly instead: a looping motion whose kf0 carries
    // a large delta FROM NEUTRAL but a small one from its wrap pose. Seeded from
    // the wrap (correct, because a loop re-enters kf0 from its own last
    // keyframe) it does not floor; seeded from neutral it floors one-sidedly —
    // exactly the desync DET-RES-01 describes.
    const cyclic = (): ComposedMotion => ({
      name: 'wrap-seed-probe',
      startFrom: 'neutral',
      stance: 'planted',
      loop: true,
      keyframes: [
        // 60° of knee flexion from neutral needs 250 ms at the 240 °/s deliberate
        // cap; authored at 160 ms it floors — UNLESS it is seeded from the wrap
        // pose (kf3, also 55°), whose 5° delta needs nothing.
        { durationMs: 160, targets: [{ joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 60 }] },
        { durationMs: 160, targets: [{ joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 55 }] },
        { durationMs: 160, targets: [{ joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 60 }] },
        { durationMs: 160, targets: [{ joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 55 }] },
      ],
    });
    const looped = resolveComposedMotion(cyclic(), variantCfg);
    const { loop: _loop, ...noLoop } = cyclic(); // strip loop → from-neutral kf0 seed
    const unlooped = resolveComposedMotion(noLoop as ComposedMotion, variantCfg);

    // AFTER (looping): the wrap seed keeps every keyframe at its authored time.
    expect(looped.keyframes.map((k) => k.durationMs)).toEqual([160, 160, 160, 160]);
    expect(looped.keyframes.some((k) => k.timingAdjusted)).toBe(false);
    // BEFORE (no loop): kf0 alone is bumped — the one-sided floor.
    expect(unlooped.keyframes[0]!.timingAdjusted).toBe(true);
    expect(unlooped.keyframes[0]!.durationMs).toBeGreaterThan(160);
    expect(unlooped.keyframes.slice(1).some((k) => k.timingAdjusted)).toBe(false);
  });

  it('the shipped walk reaches its duration floor at NO pace (the limp is unreachable)', () => {
    for (const speed of [0.4, 0.9, 1.0, 1.2, 1.5]) {
      const paced = paceGait(templateToComposedMotion(walkTemplate()), speed);
      const r = resolveComposedMotion(paced, variantCfg);
      expect(
        r.keyframes.some((k) => k.timingAdjusted),
        `speed ${speed}: no keyframe floors`,
      ).toBe(false);
      const d = durs(paced);
      expect(d.slice(0, 4), `speed ${speed}: half-cycles stay symmetric`).toEqual(d.slice(4, 8));
    }
  });
});

describe('SEAM-7 — ms-authored windows/contacts ride the RESOLVED keyframe boundaries', () => {
  it('pace 1.0 and 1.05: buildTravelWalk floors nothing, so windows pass through byte-identical', () => {
    for (const speed of [1.0, 1.05]) {
      const tw = buildTravelWalk(speed === 1 ? {} : { speed });
      const r = resolveComposedMotion(tw, variantCfg);
      expect(r.keyframes.some((k) => k.timingAdjusted), `speed ${speed} floors nothing`).toBe(false);
      expect(r.gaitStanceWindowsMs).toEqual(tw.gaitStanceWindowsMs);
      expect(r.contacts).toEqual(tw.contacts);
    }
  });

  it('when a keyframe DOES floor, its windows/contacts carry to the RESOLVED boundary', () => {
    // The shipped walk no longer floors at any pace (its phases are 'functional'),
    // so the floor is forced here by demoting the left-initial-contact keyframe to
    // the deliberate class — the seam logic under test is "windows ride resolved
    // boundaries", not "the walk happens to floor".
    const base = buildTravelWalk({ speed: 1.5 });
    const tw: ComposedMotion = {
      ...base,
      keyframes: base.keyframes.map((k, i) =>
        i === 5 ? { ...k, velocityClass: 'deliberate' as const } : k,
      ),
    };
    const r = resolveComposedMotion(tw, variantCfg);
    // The left-initial-contact keyframe (cycle index 4 → resolved kf5) floors.
    expect(r.keyframes[5]!.timingAdjusted).toBe(true);
    expect(r.keyframes[5]!.durationMs).toBeGreaterThan(tw.keyframes[5]!.durationMs!);

    // Resolved keyframe boundaries (cumulative travel + hold).
    const bounds: number[] = [];
    let acc = 0;
    for (const k of r.keyframes) {
      acc += k.durationMs + k.holdMs;
      bounds.push(acc);
    }
    const rStanceEnd = bounds[4]!; // end of R initial-contact … R terminal-stance
    const lStanceEnd = bounds[8]!; // end of L stance — shifted later by the floor

    // The R→L handoff (a boundary BEFORE the floored kf5) is unmoved and EXACT.
    expect(r.gaitStanceWindowsMs![0]).toMatchObject({ foot: 'R_Foot', fromMs: 0, toMs: rStanceEnd });
    // The L window's end rode the floored boundary to the RESOLVED lStanceEnd —
    // NOT the stale authored 2132 ms (which now lands mid-keyframe).
    expect(r.gaitStanceWindowsMs![1]).toMatchObject({ foot: 'L_Foot', fromMs: rStanceEnd, toMs: lStanceEnd });
    expect(lStanceEnd).toBeGreaterThan(tw.gaitStanceWindowsMs![1]!.toMs);
    // The terminal R window opens exactly where the L closes (no gap/overlap).
    expect(r.gaitStanceWindowsMs![2]!.fromMs).toBe(lStanceEnd);
    // Contacts share the same resolved boundaries as the windows.
    expect(r.contacts![0]).toMatchObject({ foot: 'R_Foot', toMs: rStanceEnd });
    expect(r.contacts![1]).toMatchObject({ foot: 'L_Foot', fromMs: rStanceEnd, toMs: lStanceEnd });
  });
});
