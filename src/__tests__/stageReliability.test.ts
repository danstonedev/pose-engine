/**
 * ExamStage3D reliability guards (red-team M3/M4).
 *
 * The stage component is WebGL + Svelte, which this suite cannot mount (no
 * DOM/GL harness) — so these pin the two reliability contracts at the layers
 * that ARE testable here:
 *
 * M3 — an interrupted composed playback must be reportable as its own status:
 *   the ComposedMotionPlaybackResult union carries 'interrupted' (type-level
 *   pin) and the stage's supersession branch returns it with a reason
 *   (source-level pin, so a refactor can't silently regress to 'completed').
 *
 * M4 — a background tab (visibilityState 'hidden', element still laid out)
 *   freezes rAF without tripping the offsetParent park branch; the stage must
 *   finish tweens via a document visibilitychange listener that is added on
 *   boot and removed on destroy (source-level pin).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ComposedMotionPlaybackResult } from '../services/motionSequence';

const stageSource = readFileSync(
  fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)),
  'utf8',
);

describe('M3 — interrupted composed playback is a distinct, honest status', () => {
  it("ComposedMotionPlaybackResult admits status 'interrupted' with partial measurements + reason", () => {
    const partial: ComposedMotionPlaybackResult = {
      status: 'interrupted',
      reason: 'superseded',
      measurements: [
        {
          keyframe: 0,
          joint: 'R_UpperArm',
          motion: 'shoulderFlexion',
          clampedDegrees: 45,
          measuredDegrees: 44.6,
        },
      ],
      finalAngles: { 'R_UpperArm.shoulderFlexion': 44.6 },
      loop: false,
      timingAdjusted: false,
    };
    expect(partial.status).toBe('interrupted');
    expect(partial.reason).toBe('superseded');
    expect(partial.measurements).toHaveLength(1);
  });

  it("the stage's supersession branch returns 'interrupted' (never 'completed' for a cancelled run)", () => {
    // The token-superseded branch must return the distinct status + a reason.
    expect(stageSource).toMatch(/token !== composedSeq[\s\S]{0,400}status: 'interrupted'/);
    expect(stageSource).toMatch(/status: 'interrupted',\s*\n\s*reason:/);
  });
});

describe('M4 — background tab (visibilitychange) finishes tweens instead of stranding promises', () => {
  it('registers a document visibilitychange listener on boot and removes it on destroy', () => {
    expect(stageSource).toContain("document.addEventListener('visibilitychange', onVisibilityChange)");
    expect(stageSource).toContain(
      "document.removeEventListener('visibilitychange', onVisibilityChange)",
    );
  });

  it('the hidden branch finishes the active tween instantly (same as the offsetParent park)', () => {
    expect(stageSource).toMatch(
      /const onVisibilityChange[\s\S]{0,600}if \(activeTween\) finishTween\(\);/,
    );
  });

  it('hold-skips and instant-settles consult visibilityState, not only offsetParent', () => {
    // stageHidden() is the single hidden predicate for tweens + holds.
    expect(stageSource).toMatch(
      /const stageHidden = \(\) =>[\s\S]{0,300}document\.visibilityState === 'hidden'/,
    );
    expect(stageSource).toContain('if (stageHidden()) finishTween();');
    expect(stageSource).toContain('const hidden = stageHidden;');
  });
});
