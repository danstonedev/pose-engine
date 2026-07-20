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
import { GAIT_VERTICAL_MAX_RISE_M } from '../services/motionRecording';
import { applyVerticalCalibration, deriveVerticalCalibration } from '../services/rootMotion';

const stageSource = readFileSync(
  fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)),
  'utf8',
);
const samplerSource = readFileSync(
  fileURLToPath(new URL('../services/motionRecording.ts', import.meta.url)),
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

describe('Finding 4 — the live stage applies closed-chain foot contacts (source pins)', () => {
  // The per-frame IK plant is the SAME code the offline sampler runs (buildFootPlant
  // / solveFootPlant), which footContact.test.ts gates headlessly (windowed
  // alternating-stance stays planted while the body travels). Here we pin the LIVE
  // wiring so a refactor can't silently drop it.
  it('imports the foot-plant IK helpers the sampler uses', () => {
    expect(stageSource).toContain("await import('./services/footContact')");
    expect(stageSource).toMatch(/buildFootPlant\s*,\s*solveFootPlant/);
  });

  it('rebuilds the plants from the starting motion’s contacts', () => {
    // Since the travel-heading work (roadmap 4.1) the call also forwards the
    // motion's headingDeg so a rotated walk derives its heading-rotated
    // plant-clamp rest frame (composedPlantRest); the curved-walk work
    // (roadmap 6.2) adds the heading profile so each contact window gets a
    // rest frame rotated by the heading at ITS OWN start.
    expect(stageSource).toContain(
      'setComposedContacts(resolved.contacts, resolved.headingDeg ?? 0, resolved.headingProfileMs)',
    );
    // setComposedContacts builds one solver per declared contact.
    // (Window widened 700→1600: the curved-walk per-window rest lookup now
    // sits between the reset and the per-contact solver build.)
    expect(stageSource).toMatch(/function setComposedContacts[\s\S]{0,1600}buildFootPlant\(skinnedRef, c\.foot, variantCfgRef\)/);
  });

  it('solves the plants per frame, only within each foot’s stance window', () => {
    // applyFootPlants honours the [fromMs,toMs] window and re-captures on entry.
    // (Window widened 600→700→900: the wave-4.6 heel-strike capture compensation
    // AND the wave-4.1 heading-rotated clamp frame both live in this block now:
    // a target captured mid-accent subtracts the applied root dip before the
    // solve, so the landing foot pins at its natural floor contact.)
    expect(stageSource).toMatch(/function applyFootPlants[\s\S]{0,900}tMs >= fp\.fromMs/);
    expect(stageSource).toMatch(/function applyFootPlants[\s\S]{0,900}fp\.target\.y -= composedHeelStrikeY/);
    // Since the travel-heading work the solve clamps against the (possibly
    // heading-rotated) rest frame, falling back to restRef — with the ORIGINAL
    // restRef always naming the knee hinge axis. The curved-walk work (6.2)
    // prefers a PER-WINDOW rest (fp.rest — rotated by the heading at the
    // window's start) over the shared composedPlantRest. Heading 0 keeps the
    // legacy behaviour exactly (both stay unset/null).
    expect(stageSource).toMatch(
      /function applyFootPlants[\s\S]{0,1100}solveFootPlant\(fp\.solver, fp\.target, fp\.rest \?\? composedPlantRest \?\? restRef, restRef\)/,
    );
    // …and it is called from the live frame step AND the parked path.
    expect(stageSource).toContain('applyFootPlants(elapsed)');
    expect(stageSource).toContain('applyFootPlants(trajectory.totalMs)');
  });

  it('drops the plants when the motion ends (no stale IK on the next motion)', () => {
    expect(stageSource).toMatch(/function cancelComposed[\s\S]{0,200}composedPlants = \[\]/);
  });
});

describe('DET-LOCK-01 — the live vcal passes the gait vertical rise clamp (lockstep)', () => {
  // The smoothed gait vertical rounds the double-support valley by RAISING the
  // pelvis; unclamped, a foot-plant-IK'd stance leg over-reaches and the foot
  // skates — live-only, since the offline sampler always clamped. Both call
  // sites must pass the SAME exported constant under the SAME plants-active
  // condition, or live playback silently diverges from every recording/test.
  it('the sampler clamps the smoothed rise when foot plants are active', () => {
    expect(samplerSource).toContain(
      'footPlants.length > 0 ? GAIT_VERTICAL_MAX_RISE_M : undefined',
    );
  });

  it('the stage imports the sampler’s clamp constant (one shared value, not a copy)', () => {
    expect(stageSource).toMatch(
      /GAIT_VERTICAL_MAX_RISE_M,\s*\n\s*\} = await import\('\.\/services\/motionRecording'\)/,
    );
  });

  it('the stage’s deriveVerticalCalibration mirrors the sampler’s clamp argument', () => {
    // The exact 5th argument: clamp iff this motion built foot plants (the
    // travelling walk), mirroring the sampler's footPlants gate.
    expect(stageSource).toContain(
      "}, targetCm / 100, 48, true, composedPlants.length > 0 ? GAIT_VERTICAL_MAX_RISE_M : undefined);",
    );
    // …and that tail belongs to setComposedVerticalCalibration's derive call.
    // (Window 2100: the derive closure body + the lockstep comment block sit
    // between the function head and the argument tail.)
    expect(stageSource).toMatch(
      /function setComposedVerticalCalibration[\s\S]{0,2100}composedPlants\.length > 0 \? GAIT_VERTICAL_MAX_RISE_M : undefined/,
    );
  });

  it('numerically: the clamped calibration never lifts the pelvis more than the rise limit above the pin', () => {
    // A gait-like floor-pin arc: flat single-stance plateaus with two sharp
    // V-valleys (double support) per cycle — the sawtooth shape the smoothing
    // was built to round. Depth 6 cm, width 5% of the cycle.
    const valley = (u: number, c: number, w: number) => Math.max(0, 1 - Math.abs(u - c) / w);
    const pinY = (u01: number) => 0.95 - 0.06 * (valley(u01, 0.25, 0.05) + valley(u01, 0.75, 0.05));
    const targetM = 0.03; // a typical requested vertical excursion (3 cm)

    const unclamped = deriveVerticalCalibration(pinY, targetM, 48, true);
    const clamped = deriveVerticalCalibration(pinY, targetM, 48, true, GAIT_VERTICAL_MAX_RISE_M);

    let worstUnclamped = -Infinity;
    let worstClamped = -Infinity;
    for (let i = 0; i < 480; i += 1) {
      const u = i / 480;
      const pin = pinY(u);
      worstUnclamped = Math.max(worstUnclamped, applyVerticalCalibration(pin, unclamped, u) - pin);
      worstClamped = Math.max(worstClamped, applyVerticalCalibration(pin, clamped, u) - pin);
    }
    // Without the clamp the smoothed valley rides well above the pin — the exact
    // live-only over-reach DET-LOCK-01 measured (stage omitted the 5th argument).
    expect(worstUnclamped).toBeGreaterThan(GAIT_VERTICAL_MAX_RISE_M + 0.005);
    // With it, the calibrated vertical never exceeds pin + 2.5 cm (+ float eps).
    expect(worstClamped).toBeLessThanOrEqual(GAIT_VERTICAL_MAX_RISE_M + 1e-9);
    expect(GAIT_VERTICAL_MAX_RISE_M).toBeCloseTo(0.025, 10);
  });
});

describe('finite reps expand at playback (source pin)', () => {
  it('the stage passes resolved.reps to the trajectory builder', () => {
    // reps replay the cycle at trajectory time — the plan is never duplicated,
    // so the stage must forward the count (a refactor dropping it would silently
    // play one rep).
    expect(stageSource).toMatch(/buildComposedTrajectory\(built, \{[\s\S]{0,200}reps: resolved\.reps/);
  });
});
