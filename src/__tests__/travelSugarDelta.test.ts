/**
 * TRAVEL-SUGAR DELTA COMPOSITION (AI-SUGAR-01, pipeline-diagnostics R3).
 *
 * Two root-authoring surfaces, two documented conventions:
 *   - RAW `root.translateM` — an ABSOLUTE position per keyframe ("persists
 *     forward until a later keyframe overrides it"; the chain rebase docs call
 *     authored translates ABSOLUTE in the grounded rest frame);
 *   - SEMANTIC `travel` — "move the body a distance by name": a STEP (delta)
 *     from wherever the previous keyframe left the root.
 *
 * The bug: the sugar resolved to the bare `axis × meters` — an absolute
 * position — so it silently behaved like raw. A travel step AFTER a raw
 * translate re-anchored toward the origin instead of stepping onward (kf1 raw
 * [0,0,0.5] + kf2 'forward' 0.5 ended at 0.5 m, not 1.0 m), and successive
 * steps never accumulated (three 'forward' 0.3 steps ended at 0.3 m). Fixed by
 * `realizeTravelSugar`: sugar composes as a DELTA from the carried root and is
 * realized as raw absolutes before any direction transform; raw stays
 * absolute-per-keyframe and wins on its own keyframe (documented precedence).
 * `rebaseMotionYaw` / `offsetMotionTranslate` realize the sugar the same way
 * before rotating/offsetting, so chains stay consistent.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSequencePoses,
  offsetMotionTranslate,
  realizeTravelSugar,
  rebaseMotionYaw,
  resolveComposedMotion,
  type ComposedMotion,
} from '../services/motionSequence';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
/** Root-directive-only keyframes need no rig — the pose fold is a no-op. */
const emptyPose: CustomPose = { variant: 'male', bones: {} };

const translates = (m: ComposedMotion): ([number, number, number] | undefined)[] => {
  const r = resolveComposedMotion(m, variantCfg);
  expect(r.status).toBe('ok');
  return r.keyframes.map((k) => k.root?.translateM);
};

describe('travel sugar composes as a DELTA from the carried root (AI-SUGAR-01)', () => {
  it('REGRESSION: a travel step after a raw translate steps ONWARD from it (0.5 raw + 0.5 forward = 1.0)', () => {
    // The observed bug: kf2 resolved to the absolute [0,0,0.5] — the sugar
    // re-anchored to the origin frame and the "step" moved the body nowhere.
    const t = translates({
      name: 'raw then sugar',
      keyframes: [
        { durationMs: 600, root: { translateM: [0, 0, 0.5] } },
        { durationMs: 600, travel: { direction: 'forward', meters: 0.5 } },
      ],
    });
    expect(t[0]).toEqual([0, 0, 0.5]);
    expect(t[1]).toEqual([0, 0, 1.0]);
  });

  it('successive travel steps ACCUMULATE (0.3 + 0.3 forward, then 0.2 left)', () => {
    const t = translates({
      keyframes: [
        { durationMs: 600, travel: { direction: 'forward', meters: 0.3 } },
        { durationMs: 600, travel: { direction: 'forward', meters: 0.3 } },
        { durationMs: 600, travel: { direction: 'left', meters: 0.2 } },
      ],
    });
    expect(t[0]).toEqual([0, 0, 0.3]);
    expect(t[1]).toEqual([0, 0, 0.6]);
    // subject-left = +X, composed on top of the carried forward travel.
    expect(t[2]![0]).toBeCloseTo(0.2, 12);
    expect(t[2]![2]).toBeCloseTo(0.6, 12);
  });

  it('a single travel step from rest is byte-identical to before (delta from the origin)', () => {
    const t = translates({
      keyframes: [{ durationMs: 800, travel: { direction: 'backward', meters: 0.4 } }],
    });
    expect(t[0]).toEqual([0, 0, -0.4]);
  });

  it('raw stays ABSOLUTE per keyframe — a later raw translate resets the carried position', () => {
    const t = translates({
      keyframes: [
        { durationMs: 600, travel: { direction: 'forward', meters: 0.5 } },
        { durationMs: 600, root: { translateM: [0, 0, 0.2] } }, // absolute, not composed
        { durationMs: 600, travel: { direction: 'forward', meters: 0.1 } }, // steps from the raw
      ],
    });
    expect(t[0]).toEqual([0, 0, 0.5]);
    expect(t[1]).toEqual([0, 0, 0.2]);
    expect(t[2]![2]).toBeCloseTo(0.3, 12);
  });

  it('raw WINS over sugar on the same keyframe, and the ignored sugar does not advance the carry', () => {
    const t = translates({
      keyframes: [
        {
          durationMs: 600,
          travel: { direction: 'forward', meters: 0.4 },
          root: { translateM: [0, 0, -0.5] }, // documented precedence: raw wins
        },
        { durationMs: 600, travel: { direction: 'forward', meters: 0.1 } },
      ],
    });
    expect(t[0]).toEqual([0, 0, -0.5]);
    expect(t[1]![2]).toBeCloseTo(-0.4, 12); // −0.5 + 0.1, not 0.4 + 0.1
  });

  it("a zero step means STAY ('up' 0 after 'up' 0.4 holds the height — deltas, not positions)", () => {
    const t = translates({
      keyframes: [
        { durationMs: 600, travel: { direction: 'up', meters: 0.4 } },
        { durationMs: 600, travel: { direction: 'up', meters: 0 } },
      ],
    });
    expect(t[0]).toEqual([0, 0.4, 0]);
    expect(t[1]).toEqual([0, 0.4, 0]);
  });

  it('the built pose plan carries the composed roots (buildSequencePoses lockstep)', () => {
    const r = resolveComposedMotion(
      {
        keyframes: [
          { durationMs: 600, root: { translateM: [0, 0, 0.5] } },
          { durationMs: 600, travel: { direction: 'forward', meters: 0.5 } },
        ],
      },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    const built = buildSequencePoses(emptyPose, r, variantCfg, null);
    expect(built.roots[0]!.translateM).toEqual([0, 0, 0.5]);
    expect(built.roots[1]!.translateM).toEqual([0, 0, 1.0]);
  });

  it('malformed sugar still refuses through the shape-error path', () => {
    const r = resolveComposedMotion(
      {
        keyframes: [
          { durationMs: 600, travel: { direction: 'forward', meters: 0.3 } },
          { durationMs: 600, travel: { direction: 'sideways' as never, meters: 0.3 } },
        ],
      },
      variantCfg,
    );
    expect(r.status).toBe('refused');
    expect(r.reason).toContain('keyframe 1');
  });

  it('realizeTravelSugar is pure, identity without sugar, and idempotent', () => {
    const noSugar: ComposedMotion = {
      keyframes: [{ durationMs: 600, root: { translateM: [0, 0, 0.5] } }],
    };
    expect(realizeTravelSugar(noSugar)).toBe(noSugar); // identity — same reference
    const withSugar: ComposedMotion = {
      keyframes: [
        { durationMs: 600, root: { translateM: [0, 0, 0.5] } },
        { durationMs: 600, travel: { direction: 'forward', meters: 0.5 } },
      ],
    };
    const once = realizeTravelSugar(withSugar);
    expect(withSugar.keyframes[1]!.travel, 'input not mutated').toBeDefined();
    expect(once.keyframes[1]!.travel).toBeUndefined();
    expect(once.keyframes[1]!.root?.translateM).toEqual([0, 0, 1.0]);
    expect(realizeTravelSugar(once)).toBe(once); // idempotent — nothing left to realize
  });
});

describe('direction transforms realize the sugar with the same delta composition', () => {
  it('rebaseMotionYaw rotates the COMPOSED positions of a mixed raw+sugar plan', () => {
    const m: ComposedMotion = {
      keyframes: [
        { durationMs: 600, root: { translateM: [0, 0, 0.5] } },
        { durationMs: 600, travel: { direction: 'forward', meters: 0.5 } },
      ],
    };
    // +90° yaw turns +Z travel into +X (toward subject-left).
    const rebased = rebaseMotionYaw(m, 90);
    const t0 = rebased.keyframes[0]!.root!.translateM!;
    const t1 = rebased.keyframes[1]!.root!.translateM!;
    expect(t0[0]).toBeCloseTo(0.5, 12);
    expect(t0[2]).toBeCloseTo(0, 12);
    // The sugar step composed to 1.0 m BEFORE rotating — rotating the bare
    // 0.5 m delta as if absolute would have landed at 0.5 m.
    expect(t1[0]).toBeCloseTo(1.0, 12);
    expect(t1[2]).toBeCloseTo(0, 12);
    expect(rebased.keyframes[1]!.travel).toBeUndefined(); // realized as raw
  });

  it('offsetMotionTranslate re-anchors the COMPOSED positions of a mixed raw+sugar plan', () => {
    const m: ComposedMotion = {
      keyframes: [
        { durationMs: 600, root: { translateM: [0, 0, 0.5] } },
        { durationMs: 600, travel: { direction: 'forward', meters: 0.5 } },
      ],
    };
    const offset = offsetMotionTranslate(m, 1, 2);
    expect(offset.keyframes[0]!.root!.translateM).toEqual([1, 0, 2.5]);
    expect(offset.keyframes[1]!.root!.translateM).toEqual([1, 0, 3.0]);
    expect(offset.keyframes[1]!.travel).toBeUndefined();
  });
});
