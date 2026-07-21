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

  it('BEFORE/AFTER — the fix (loop-wrap seed) is what removes the limp', () => {
    // Reproduce the OLD behaviour by dropping `loop`: with no wrap, kf0 is seeded
    // from NEUTRAL, so the paced right-initial-contact floors one-sidedly and the
    // half-cycles desync — the DET-RES-01 limp. WITH `loop`, the wrap seed keeps
    // it symmetric. Measured at 0.9 / 1.05 / 1.2.
    const measure = (speed: number) => {
      const paced = paceGait(templateToComposedMotion(walkTemplate()), speed);
      const after = halfCycleAsymmetryPct(durs({ ...paced }));
      const { loop: _loop, ...noLoop } = paced; // strip loop → from-neutral kf0 seed
      const before = halfCycleAsymmetryPct(durs(noLoop as ComposedMotion));
      return { before, after };
    };
    const at105 = measure(1.05);
    const at120 = measure(1.2);
    // AFTER: symmetric at every pace.
    expect(at105.after).toBe(0);
    expect(at120.after).toBe(0);
    // BEFORE: the from-neutral seed injected a one-sided bump (grows with pace).
    expect(at105.before).toBeGreaterThan(0);
    expect(at120.before).toBeGreaterThan(at105.before);
    // eslint-disable-next-line no-console
    console.log(
      `DET-RES-01 step-time asymmetry — 1.05: before ${at105.before.toFixed(2)}% → after 0%; ` +
        `1.2: before ${at120.before.toFixed(2)}% → after 0%`,
    );
  });

  it('speed-1 walk template is byte-identical (the loop-wrap seed only relaxes kf0)', () => {
    const t = templateToComposedMotion(walkTemplate());
    const r = resolveComposedMotion(t, variantCfg);
    expect(r.keyframes.map((k) => k.durationMs)).toEqual(t.keyframes.map((k) => k.durationMs));
    expect(r.keyframes.some((k) => k.timingAdjusted)).toBe(false);
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

  it('pace 1.5: the left-initial-contact floors — its windows/contacts carry to the RESOLVED boundary', () => {
    const tw = buildTravelWalk({ speed: 1.5 });
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
