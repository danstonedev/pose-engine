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

describe('finite reps expand at playback (source pin)', () => {
  it('the stage passes resolved.reps to the trajectory builder', () => {
    // reps replay the cycle at trajectory time — the plan is never duplicated,
    // so the stage must forward the count (a refactor dropping it would silently
    // play one rep).
    expect(stageSource).toMatch(/buildComposedTrajectory\(built, \{[\s\S]{0,200}reps: resolved\.reps/);
  });
});

describe('SEAM-4/SEAM-5 — the live stage runs the grounding-switch crossfade in sampler lockstep (source pins)', () => {
  // The root-Y crossfade that closes the grounding pin-swap seams (the 53 cm
  // get-down free-fall, the 9.94 cm stand-from-sit hop) lives in shared
  // rootMotion helpers (deriveGroundingBlendSpans / groundingBlendAt /
  // applyBlendedGroundingY / handReachWeightAt), rig-gated headlessly in
  // groundingSeam.test.ts + standFromSitSeam.test.ts. The stage cannot be
  // mounted here, so these pin the LIVE wiring: the stage must derive the same
  // spans from the same trajectory and apply them at the same pipeline points
  // as the offline sampler, or live playback silently diverges from every
  // recording.
  it('imports the shared crossfade helpers from rootMotion', () => {
    expect(stageSource).toMatch(
      /deriveGroundingBlendSpans,\s*\n\s*groundingBlendAt,\s*\n\s*applyBlendedGroundingY,\s*\n\s*handReachWeightAt,/,
    );
  });

  it('derives the spans from the starting trajectory — and re-derives (to empty) for the loop cycle', () => {
    // One-shot pass: derived BEFORE the weighted-descent pre-pass (whose
    // grounded arc must include the blend).
    expect(stageSource).toContain('setComposedGroundingBlend(trajectory)');
    // Loop cycle: carries no postures — re-derive so stale spans can never
    // misapply to the wrapped loop clock.
    expect(stageSource).toContain('setComposedGroundingBlend(loopTraj)');
    expect(stageSource).toMatch(
      /function setComposedGroundingBlend[\s\S]{0,400}deriveGroundingBlendSpans\(/,
    );
  });

  it('applyTrajectoryRoot blends root-Y inside an override span via the shared applier', () => {
    expect(stageSource).toMatch(
      /function applyTrajectoryRoot[\s\S]{0,4000}groundingBlendAt\(composedGroundingBlendSpans, tMs\)/,
    );
    expect(stageSource).toMatch(
      /function applyTrajectoryRoot[\s\S]{0,4500}applyBlendedGroundingY\(modelRoot, gBlend, applyComposedGroundingPin\)/,
    );
  });

  it('the hand-reach solve is weighted by the shared engagement ramp (no full-on snap at the switch)', () => {
    expect(stageSource).toContain(
      'handReachWeightAt(composedGroundingSwitches, hp.bone, tMs, floorRef)',
    );
  });

  it('the weighted-descent pre-pass grounds through the SAME blend as playback (lockstep arc)', () => {
    expect(stageSource).toMatch(
      /function setComposedWeightedDescent[\s\S]{0,2500}groundingBlendAt\(composedGroundingBlendSpans, tMs\)/,
    );
    expect(stageSource).toMatch(
      /function setComposedWeightedDescent[\s\S]{0,2800}applyBlendedGroundingY\(modelRoot!, gBlend, applyComposedGroundingPin\)/,
    );
  });
});
