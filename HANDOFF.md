# Handoff — simMOVE "walk" thin-plan regression

**Purpose.** Diagnose and fix why simMOVE (move.devpt.app, repo `danstonedev/simmove`)
generates unnatural movement: typing "walk" → Perform interprets to a plan with only
**2 keyframes**, far too thin for a believable gait cycle.

**How to use this file.** Open a fresh Claude Code workspace scoped to **both**
`danstonedev/simmove` and `danstonedev/pose-engine`, then paste the prompt below.
(simMOVE consumes the shared movement library `@vspx/pose-engine`; the fix likely
spans both repos. If simMOVE pulls pose-engine as a **git submodule**, initialize it
before building.)

---

## Prompt to paste

```
simMOVE (move.devpt.app, repo danstonedev/simmove) generates unnatural movement.
Typing "walk" and pressing Perform interprets to a plan with only **2 keyframes**,
which is far too thin for a believable gait cycle. Diagnose the root cause and fix
it so movements match natural progression. simMOVE consumes the shared movement
library @vspx/pose-engine (danstonedev/pose-engine) — please have BOTH repos in
scope.

## Context already established (don't re-derive)

- The recording readout "1.2s · 37 frames · composed" vs "Interpreted as: walk · 2
  keyframes · loops" is NOT a bug. Keyframes = authored plan waypoints; frames =
  playback sampled at 30 Hz (pose-engine motionRecording: sampleHz default 30,
  dtMs = 1000/30, one frame per step → 30×1.21s+1 ≈ 37). They are SUPPOSED to
  differ. Do not chase this.

- The REAL problem is that "walk" resolves to only 2 keyframes. In pose-engine
  there is NO composed "walk" template — "walk" exists there only as an authored
  catalog clip (services/motionCommand.ts: id 'walk', loop 'repeat', assetHint
  'Walk', an FBX animation with many frames). So the 2-keyframe "composed" walk is
  being authored by simMOVE itself — either its AI prompt path or its OFFLINE
  fallback ("instructions resolve offline to a base motion + clinical modifiers" —
  see pose-engine services/motionPrescription.ts, modes play/modify/generate). On
  a static move.devpt.app the AI is likely unavailable, so the offline fallback may
  always run.

## Investigate (report findings BEFORE changing code)

1. In danstonedev/simmove, find the "DESCRIBE A MOTION" / "Perform" /
   "Interpreted as …" UI and its handler. Trace how the typed instruction becomes
   a ComposedMotion.
2. Identify the interpreter: is there an AI call, an offline composer, or both?
   Which one ran for "walk"? Why does it emit only 2 keyframes?
3. Check git history for a change that REMOVED authored movement/clip files (the
   user recalls "we removed all the movement files to commit to fully AI generated
   movements"). Confirm whether that removal left a thin 2-keyframe composer as the
   only path — that is the suspected regression.

## Fix

Make "walk" (and other locomotion) produce a natural multi-keyframe cycle. Options
to weigh: (a) author a proper multi-phase gait in the composed vocabulary
(heel-strike → mid-stance → toe-off → swing per stride, reciprocal arm swing), or
(b) reinstate the authored clip as the base that the AI/offline path modifies with
clinical modifiers. Reuse pose-engine's Phase 0–4 movement-quality tooling rather
than eyeballing — see pose-engine/docs/movement-quality-plan.md:
  - resolveComposedMotion + sampleComposedMotion (headless, deterministic sampling)
  - movementSignature.scoreAgainstSignature (direction/shape validation)
  - movementCoordination.checkCoordination (cross-joint ratios/ordering)
  - footContact (IK stance-foot plant, measureContactSlide — prevents moonwalk)
  - movementChain (sequence validated primitives), and SequenceTarget.peakAt for
    intra-phase joint leads
Gate the fix with a headless vitest that samples the generated walk and asserts
it's non-degenerate (keyframe count, per-joint amplitude/ordering, no foot slide,
correct +Z travel). Keep the interpreter a lightweight deterministic path — the
intelligence lives in the signatures/validator, not a heavier model.

## Deliverable

First: a written diagnosis (which path ran, why 2 keyframes, what was removed).
Then: the fix with passing headless tests, and a short before/after (keyframe count
+ a sampled-signature comparison). Follow the repo's branch/commit conventions.
```

---

## Notes

- **Include `pose-engine` too**, not just simMOVE — the fix likely needs a real
  composed gait vocabulary in the engine plus the interpreter change in simMOVE.
- **Submodule:** if simMOVE consumes pose-engine as a git submodule (as 3DPainMap
  does, via the `@vspx/pose-engine → pose-engine/src/index.ts` alias), the new
  session must `git submodule update --init` before it can build or run tests.
- **Not a bug — don't chase it:** the "37 frames vs 2 keyframes" mismatch is
  expected (frames are the 30 Hz sampled playback of a 2-keyframe plan).
- **Two frames of facing** (already fixed in the engine, keep in mind): the mesh
  physically faces +Z (forward travel is +Z); the clinical joint-angle readout
  labels anterior −Z. Travel/gait direction must use physical facing (+Z).
