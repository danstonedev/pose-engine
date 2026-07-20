/**
 * PERRY PHASE-TIMING GATE (wave 4.2) — the walk's 8 phase durations follow
 * physiologic gait-cycle fractions instead of the old metronomic 8×200 ms.
 *
 * Phase semantics: each phase's `durationMs` is the interval ENDING at its
 * named pose. Authored fractions of the 1.6 s cycle (per half-cycle, sum
 * unchanged at 800 ms so cadence/pace/travel gates hold):
 *   • initial-contact interval 168 ms ≈ 10.5% — the QUICK contralateral
 *     pre-swing push-off into contact;
 *   • loading response 160 ms ≈ 10% — BRISK weight acceptance;
 *   • mid-stance / terminal stance 236 ms ≈ 14.75% each — the LONG slow
 *     rollover of single support.
 * Best 8-keyframe fit to Perry's ~12/19/19/12% stance splits under the
 * half-cycle-sum + velocity-governor constraints (the contact keyframe carries
 * a 40° knee delta from neutral, so its interval must stay ≥167 ms at the
 * 240°/s deliberate cap) [Perry & Burnfield].
 *
 * The gate asserts the RATIOS are non-uniform and match the authored
 * fractions, that both invariant sums hold, that the resolver keeps the
 * authored cadence untouched, and that the travel builder's duration-derived
 * stance schedule adapts (windows/contacts recomputed from the new durations).
 */
import { describe, expect, it } from 'vitest';
import { resolveComposedMotion } from '../services/motionSequence';
import {
  buildTravelWalk,
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const walkTemplate = () => MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!;

const PHASE_ORDER = [
  'right-initial-contact',
  'right-loading-response',
  'right-mid-stance',
  'right-terminal-stance',
  'left-initial-contact',
  'left-loading-response',
  'left-mid-stance',
  'left-terminal-stance',
] as const;

describe('walk template — Perry phase re-timing (4.2)', () => {
  it('keeps the cycle invariants: 8 phases, 800 ms per half-cycle, 1.6 s per cycle', () => {
    const t = walkTemplate();
    expect(t.phases.map((p) => p.name)).toEqual([...PHASE_ORDER]);
    const dur = t.phases.map((p) => p.durationMs + (p.holdMs ?? 0));
    const firstHalf = dur.slice(0, 4).reduce((a, b) => a + b, 0);
    const secondHalf = dur.slice(4).reduce((a, b) => a + b, 0);
    expect(firstHalf, 'R half-cycle sum unchanged (cadence/pace gates)').toBe(800);
    expect(secondHalf, 'L half-cycle sum unchanged').toBe(800);
    expect(firstHalf + secondHalf, 'full cycle stays ~1.6 s').toBe(1600);
  });

  it('the phase durations are NON-UNIFORM and mirror-symmetric between the halves', () => {
    const dur = walkTemplate().phases.map((p) => p.durationMs);
    expect(new Set(dur).size, 'no metronome — more than one distinct duration').toBeGreaterThan(1);
    expect(Math.max(...dur) / Math.min(...dur), 'a real rhythm, not a tweak').toBeGreaterThan(1.3);
    // Bilateral symmetry: the L half repeats the R half's rhythm exactly.
    expect(dur.slice(4)).toEqual(dur.slice(0, 4));
  });

  it('matches the authored physiologic fractions: brisk loading, long mid/terminal stance, quick pre-swing', () => {
    const t = walkTemplate();
    const cycleMs = t.phases.reduce((s, p) => s + p.durationMs + (p.holdMs ?? 0), 0);
    const frac = (name: string): number =>
      t.phases.find((p) => p.name === name)!.durationMs / cycleMs;
    for (const side of ['right', 'left'] as const) {
      // Loading response is BRISK: ~10-12% of the cycle [Perry: LR ends ~12%].
      expect(frac(`${side}-loading-response`), `${side} LR brisk`).toBeGreaterThanOrEqual(0.09);
      expect(frac(`${side}-loading-response`), `${side} LR brisk`).toBeLessThanOrEqual(0.13);
      // Mid + terminal stance are the LONG single-support phases (~15-19% each in
      // Perry; ~14.75% here — the closest 8-keyframe fit under the invariants).
      for (const ph of ['mid-stance', 'terminal-stance'] as const) {
        expect(frac(`${side}-${ph}`), `${side} ${ph} long`).toBeGreaterThanOrEqual(0.14);
        expect(frac(`${side}-${ph}`), `${side} ${ph} long`).toBeLessThanOrEqual(0.2);
        expect(
          frac(`${side}-${ph}`) / frac(`${side}-loading-response`),
          `${side} ${ph} clearly longer than loading response`,
        ).toBeGreaterThan(1.4);
      }
      // The arrival at initial contact (the contralateral pre-swing push-off)
      // is QUICK — the same order as the loading response, far under mid-stance.
      expect(frac(`${side}-initial-contact`), `${side} pre-swing quick`).toBeGreaterThanOrEqual(0.09);
      expect(frac(`${side}-initial-contact`), `${side} pre-swing quick`).toBeLessThanOrEqual(0.13);
    }
  });

  it('the resolver keeps the authored non-uniform cadence — no velocity-governor adjustment', () => {
    const resolved = resolveComposedMotion(templateToComposedMotion(walkTemplate()), variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.keyframes.map((k) => k.durationMs)).toEqual(
      walkTemplate().phases.map((p) => p.durationMs),
    );
    for (const kf of resolved.keyframes) {
      expect(kf.timingAdjusted ?? false, 'authored Perry cadence survives the governor').toBe(false);
    }
  });

  it('the travel builder’s stance schedule + contacts are DERIVED from the new durations', () => {
    const m = buildTravelWalk();
    const dur = (k: (typeof m.keyframes)[number]): number => (k.durationMs ?? 0) + (k.holdMs ?? 0);
    const endOf = (i: number): number => m.keyframes.slice(0, i + 1).reduce((s, k) => s + dur(k), 0);
    // The R→L handoff sits at the (re-timed) half-cycle keyframe boundary, the
    // L→terminal handoff a full cycle after it — recomputed from durations, not
    // stale 200 ms multiples.
    const rStanceEnd = endOf(4);
    const lStanceEnd = endOf(8);
    expect(m.gaitStanceWindowsMs?.[0]).toMatchObject({ foot: 'R_Foot', fromMs: 0, toMs: rStanceEnd });
    expect(m.gaitStanceWindowsMs?.[1]).toMatchObject({ foot: 'L_Foot', fromMs: rStanceEnd, toMs: lStanceEnd });
    expect(m.gaitStanceWindowsMs?.[2]?.fromMs).toBe(lStanceEnd);
    // The foot-plant contact windows share the same duration-derived boundaries.
    expect(m.contacts?.[0]).toMatchObject({ foot: 'R_Foot', fromMs: 0, toMs: rStanceEnd });
    expect(m.contacts?.[1]).toMatchObject({ foot: 'L_Foot', fromMs: rStanceEnd, toMs: lStanceEnd });
    // And the re-timed half-cycles still sum to the invariant 800 ms each (the
    // step-off entry replaces the first phase's duration by design).
    expect(lStanceEnd - rStanceEnd, 'the second half-cycle keeps the 800 ms sum').toBe(800);
  });
});
