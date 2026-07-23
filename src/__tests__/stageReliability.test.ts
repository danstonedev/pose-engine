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
const motionSequenceSource = readFileSync(
  fileURLToPath(new URL('../services/motionSequence.ts', import.meta.url)),
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

  it("the stage's end-before-last-keyframe branch distinguishes 'cancelled' (user Stop) from 'interrupted' (superseded)", () => {
    // PR 1: the token-ended branch returns 'cancelled' when a caller stopped this
    // token out-of-band (cancelActiveMovement), else 'interrupted' — never
    // 'completed' for a run that didn't reach its last keyframe.
    expect(stageSource).toMatch(
      /token !== composedSeq[\s\S]{0,600}status: cancelled \? 'cancelled' : 'interrupted'/,
    );
    expect(stageSource).toMatch(/status: cancelled \? 'cancelled' : 'interrupted',\s*\n\s*reason:/);
  });

  it('the out-of-band cancelActiveMovement marks the active token so it resolves cancelled (Stop bypasses the queue)', () => {
    // PR 1: cancelActiveMovement is a top-level export (NOT queued on the command
    // chain) that sets composedCancelledToken = the active token before tearing
    // the motion down, so the awaiting runComposedImpl returns 'cancelled'.
    expect(stageSource).toMatch(/export function cancelActiveMovement\(\): void \{/);
    expect(stageSource).toMatch(/composedCancelledToken = composedActiveToken;\s*\n\s*cancelComposed\(\);/);
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
    // (Window widened 600→700→900→2100: the wave-4.6 heel-strike capture
    // compensation AND the wave-4.1 heading-rotated clamp frame both live in
    // this block, and the SEAM-3 release-blend branch (the ramped
    // solveFootPlantWeighted out-of-window path) now sits between the window
    // check and the target capture — deliberately widened to span it.)
    expect(stageSource).toMatch(/function applyFootPlants[\s\S]{0,900}tMs >= fp\.fromMs/);
    expect(stageSource).toMatch(/function applyFootPlants[\s\S]{0,2100}fp\.target\.y -= composedHeelStrikeY/);
    // Since the travel-heading work the solve clamps against the (possibly
    // heading-rotated) rest frame, falling back to restRef — with the ORIGINAL
    // restRef always naming the knee hinge axis. The curved-walk work (6.2)
    // prefers a PER-WINDOW rest (fp.rest — rotated by the heading at the
    // window's start) over the shared composedPlantRest. Heading 0 keeps the
    // legacy behaviour exactly (both stay unset/null).
    // (Window widened 1100→2500 for the SEAM-3 release branch, as above.)
    expect(stageSource).toMatch(
      /function applyFootPlants[\s\S]{0,2500}solveFootPlant\(fp\.solver, fp\.target, fp\.rest \?\? composedPlantRest \?\? restRef, restRef\)/,
    );
    // …and it is called from the live frame step AND the parked path.
    expect(stageSource).toContain('applyFootPlants(elapsed)');
    expect(stageSource).toContain('applyFootPlants(trajectory.totalMs)');
  });

  it('SEAM-2 — contacts are re-timed into trajectory ms by the shared stance-window factor', () => {
    // The plants are built in AUTHORED ms (setComposedContacts runs before the
    // trajectory exists); once the trajectory is built the stage must scale
    // their windows by the SAME shared authored→trajectory factor the stance
    // windows use — one source of truth (services/motionRecording
    // authoredToTrajectoryTimeScale), mirroring the offline sampler. A refactor
    // dropping either call re-opens the paced-walk contact desync.
    expect(stageSource).toContain('scaleComposedPlantsToTrajectory(trajectory, effectiveResolved)');
    expect(stageSource).toMatch(
      /function scaleComposedPlantsToTrajectory[\s\S]{0,700}authoredToTrajectoryTimeScale\(resolvedMotion, traj\.totalMs\)/,
    );
    expect(stageSource).toMatch(
      /function scaledStanceWindows[\s\S]{0,700}authoredToTrajectoryTimeScale\(resolvedMotion, traj\.totalMs\)/,
    );
  });

  it('SEAM-3 — a released plant ramps out through the shared weighted solve', () => {
    // The out-of-window branch must blend the leg IK 1→0 (solveFootPlantWeighted,
    // PLANT_RELEASE_BLEND_MS — both shared with the offline sampler) instead of
    // dropping the pin in one frame (the toe-off release pop).
    expect(stageSource).toMatch(/solveFootPlant\s*,\s*solveFootPlantWeighted\s*,\s*PLANT_RELEASE_BLEND_MS/);
    expect(stageSource).toMatch(
      /function applyFootPlants[\s\S]{0,2100}solveFootPlantWeighted\(fp\.solver, fp\.target, fp\.rest \?\? composedPlantRest \?\? restRef, restRef, w\)/,
    );
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
    // Anywhere in the motionRecording import block (other shared helpers —
    // e.g. the SEAM-2 time-scale pair — may follow it in the destructuring).
    expect(stageSource).toMatch(
      /GAIT_VERTICAL_MAX_RISE_M,[\s\S]{0,200}\} = await import\('\.\/services\/motionRecording'\)/,
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

describe('DET-LOCK-03 — guarding/sway are baked at resolve time; the composed stage path never re-applies them live (source pins)', () => {
  // The numeric behaviour (a guarded recording has reduced excursion; sampler ==
  // stage) is gated headlessly in motionRecording.test.ts through the SAME
  // resolveComposedMotion the stage builds from. These pin the wiring so a
  // refactor can't silently re-open the three-way disagreement: (1) the bake
  // runs inside resolveComposedMotion (the one path sampler + stage share), and
  // (2) the composed stage playback sets ONLY liveliness on the live overlay —
  // it must NOT re-apply the now-baked guarding/sway (that would double them).
  it('resolveComposedMotion folds guarding/sway into the resolved keyframes', () => {
    expect(motionSequenceSource).toContain('bakeGuardingSway(resolvedKeyframes, motion.modifiers)');
    // The bake is clean-mode-zeroed (identity when neither modifier is set).
    expect(motionSequenceSource).toMatch(
      /export function bakeGuardingSway[\s\S]{0,400}if \(guarding <= 0 && sway <= 0\) return;/,
    );
  });

  it('the composed playback sets ONLY liveliness on the live overlay (guarding/sway are baked, not doubled)', () => {
    expect(stageSource).toContain('setMotionOverlaysImpl?.({ liveliness: motionLiveliness });');
    // The composed setMotionOverlays call carries no guarding/balanceSway key.
    const composedOverlayCall = stageSource.match(
      /setMotionOverlaysImpl\?\.\(\{ liveliness: motionLiveliness \}\);/,
    );
    expect(composedOverlayCall, 'composed overlay call present').not.toBeNull();
  });
});

describe('SEAM-9 — motion-time liveliness (realism) is applied AFTER the recording tap, not before (leak fix)', () => {
  // The realism breathing/micro-sway is LIVE-ONLY (the offline sampler never
  // sees it), so a recording/streamed report that carried it would diverge from
  // the grade (the ±2.2° trunk leak). It must be re-applied AFTER the tap, in the
  // same discipline as the idle overlay — and it is mutually exclusive with the
  // idle re-bake (a motion is driving the skeleton).
  it('applyMotionLiveliness runs AFTER the recording tap (else-branch of the idle re-bake)', () => {
    expect(stageSource).toMatch(
      /if \(recording\) \{[\s\S]{0,1500}\} else if \(\(\(mixer && activeMotionId\) \|\| composedActive\) && applyMotionLiveliness\(motionDelta\)\)/,
    );
  });

  it('the motion-time liveliness apply is a real overlay (breathing + micro-sway), NOT inlined before the tap', () => {
    // The function exists and moves the two trunk bones… (window widened to
    // 2000 for the onset-ramp preamble — livelinessOnsetSec + the 0→1 ramp
    // derivation — PLUS the idle→motion FADE-OUT preamble: the captured idle
    // trunk lean applied at (1 − onsetRamp) so it crossfades out as the motion
    // sway eases in, instead of undoIdleOverlays() snapping it off in one frame).
    expect(stageSource).toMatch(
      /function applyMotionLiveliness\(dtSec: number\): boolean \{[\s\S]{0,2000}breathingLeanFM[\s\S]{0,600}livelinessSwayDeg/,
    );
    // …and the pre-tap motion-overlay block no longer applies it (only guarding /
    // sway / pelvis remain there — a comment marks where liveliness moved to).
    expect(stageSource).toContain(
      'It is therefore applied via applyMotionLiveliness() AFTER the recording',
    );
  });

  it('the idle→motion trunk lean CROSSFADES out (no single-frame undoIdleOverlays snap)', () => {
    // A composed takeover SNAPSHOTS the applied idle trunk lean BEFORE undoing it…
    expect(stageSource).toMatch(
      /captureIdleFadeForTakeover\(\);[\s\S]{0,120}undoIdleOverlays\(\);/,
    );
    // …and applyMotionLiveliness fades that snapshot out at (1 − onsetRamp),
    // premultiplied onto BOTH trunk bones, so it decays to zero as the motion
    // sway eases in — the mirror of the ease-IN, not an instantaneous step.
    expect(stageSource).toMatch(/const idleFade = idleFadeActive \? 1 - onsetRamp : 0;/);
    expect(stageSource).toMatch(/thorax\.quaternion\.premultiply\(_idleFadeScaledQ\.identity\(\)\.slerp\(_idleFadeThoraxQ, idleFade\)\)/);
    expect(stageSource).toMatch(/lowBack\.quaternion\.premultiply\(_idleFadeScaledQ\.identity\(\)\.slerp\(_idleFadeLumbarQ, idleFade\)\)/);
    // …and the WHOLE-BODY components fade too: the weight-shift pelvis travel
    // (a decaying term in the bakePelvisShift target) and the ankle-pivot root
    // roll (with the feet), so the entire idle overlay crossfades, not just the trunk.
    expect(stageSource).toMatch(/const targetM = motionPelvisShiftM \+ idleShiftM \+ idleFadeShiftM;/);
    expect(stageSource).toMatch(/idleFadeShiftM = idleFadeShiftCapturedM \* idleFade;/);
    expect(stageSource).toMatch(/modelRoot\.quaternion\.premultiply\(_idleFadeScaledQ\.identity\(\)\.slerp\(_idleFadeRootQ, idleFade\)\)/);
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

describe('DET-LOCK-02 — loop-form vertical calibration in stage/sampler lockstep (source pins)', () => {
  // The numeric behaviour (no pelvis step at loop engage, first pass matching
  // the loop table) is gated headlessly in loopVcalHandoff.test.ts through the
  // SAME sampler code the stage mirrors; these pin the LIVE wiring so a stage
  // refactor can't silently fall back to a one-shot-derived table or a
  // discrete table switch.
  it('derives the vcal table from ONE loop-form trajectory, re-used by the loop player', () => {
    // Built once per looping playback…
    expect(stageSource).toContain(
      'const loopForm = resolved.loop ? buildLoopTrajectory(built, { timeScale }) : null;',
    );
    // …fed to the vcal derivation…
    expect(stageSource).toMatch(
      /setComposedVerticalCalibration\(\s*loopForm \? loopForm\.trajectory : trajectory,/,
    );
    // …and the SAME object engages as the loop clock (no diverging rebuild).
    expect(stageSource).toMatch(
      /const \{ trajectory: loopTraj, enterAtMs \} = loopForm \?\? buildLoopTrajectory\(built, \{ timeScale \}\)/,
    );
  });

  it('indexes the loop table at (t − first keyframe arrival) on the first pass, ramped in at the entry', () => {
    // Phase offset = the one-shot's first settle instant (mirrors the sampler's
    // vcalPhaseOffsetMs = durations[0]/timeScale), cleared when the loop engages.
    expect(stageSource).toContain('composedVcalPhaseOffsetMs = settleAtMs[0] ?? 0;');
    expect(stageSource).toMatch(/\(tMs - composedVcalPhaseOffsetMs\) \/ composedVcalCycleMs/);
    // Entry ramp: the loop table blends in from the live pin over the intro.
    expect(stageSource).toMatch(/composedVcalRampMs > 0 && tMs < composedVcalRampMs/);
  });

  it('blends the first-pass → loop handoff over VCAL_HANDOFF_BLEND_MS instead of stepping', () => {
    expect(stageSource).toMatch(/composedVcalHandoff = \{ deltaYM, startedAtMs: performance\.now\(\) \}/);
    expect(stageSource).toMatch(
      /composedVcalHandoff\.startedAtMs\) \/ VCAL_HANDOFF_BLEND_MS/,
    );
    // The handoff state is dropped with the rest of the vcal state on cancel.
    expect(stageSource).toMatch(/function cancelComposed[\s\S]{0,900}composedVcalHandoff = null/);
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

describe('SEAM-10 — the ready-reset tweens to the grounded standing Y (source pins)', () => {
  // The between-command return-to-ready (startFrom:'neutral') must EASE the root
  // back to the grounded standing Y in place, never snap it. The pure decision +
  // tween target live in services/readyTransition (readyTransitionNeeded's vertical
  // term + readyResetRootTarget), gated headlessly in readyTransition.test.ts. The
  // stage cannot be mounted here, so these pin the LIVE wiring so a refactor can't
  // silently drop the vertical check (falling back to the instant resetRootToRest
  // snap) or hard-code a different tween end.
  it('threads the vertical drift into the settle decision (not just pose/horizontal/orientation)', () => {
    expect(stageSource).toContain('rootVerticalM: Math.abs(composedRootTranslate[1])');
  });

  it('tweens the ready-reset root to the shared grounded-standing target (eased, not snapped)', () => {
    expect(stageSource).toContain('readyResetRootTarget');
    // The pure target drives the tween end (toQuat/toTranslate) inside playReadySettle.
    expect(stageSource).toMatch(
      /function playReadySettle[\s\S]{0,900}readyResetRootTarget\(composedRootTranslate\)/,
    );
    expect(stageSource).toMatch(
      /function playReadySettle[\s\S]{0,1200}await tweenTo\(baselinePoseRef, READY_SETTLE_MS, \{[\s\S]{0,300}toTranslate: toTranslateM/,
    );
  });
});
