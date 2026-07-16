# simMOVE Movement-Quality Plan — root cause + phased validation

**Status:** in progress (Phase 0 landing). **Owner:** simMOVE. **Scope:** `@vspx/pose-engine`
composed-motion path (`motionSequence`, `movementCommand`, `movementTemplates`,
`motionTrajectory`, `motionStagger`, `motionRecording`, `jointAngles`, `rootMotion`,
`poseRig`).

This document records why AI-authored ("agentic") movements were reversing forward/backward
and reading as robotic, and the phased, test-gated plan to fix it with a **lightweight
deterministic interpreter** rather than a heavier model.

---

## Root cause of the forward/backward reversal

The reversal is **not** in the joint math. The full headless suite passes (342 tests),
including `fullBodyMotion.test.ts` and the `movementTemplates` round-trips that play each
template on the real GLB and measure the peaks back within ±6°. Single-joint commands and
template playback are direction-correct.

The reversal lives in the **open-authoring path**, where the model itself chooses a direction:

1. **`forward` is `−Z`, which is counterintuitive.** Proven by `fullBodyMotion.test.ts:238`
   (a forward step uses `translateM:[0,0,-0.4]` and asserts `Hips.z` *decreases*). A model
   asked to "step forward" tends to emit `+Z` → the avatar travels **backward**. The same trap
   applies to `root.orient` pitch (`−90 = supine, +90 = prone`).

2. **The codebase contradicted itself about facing.** `jointAngles.ts` (`anterior = -Z`),
   `rootMotion.ts` (`z posterior+`), and `motionRecording.ts` (`z = posterior+`) all agree,
   but `movementCommand.ts` said the opposite in two comments ("the toes point +Z"). Anyone —
   or any model — reading the code to learn the convention got a poisoned signal.
   (Phase 0 corrects those comments; **no math changed**.)

3. **Extension is encoded as negative flexion.** Hip/shoulder/trunk have no separate
   "extension" field, so moving a limb *backward* means emitting a negative number — a second,
   independent place to flip sagittal sign.

4. **No closed loop.** `motionRecording.exportKinematics()` already produces the ground truth
   (per-joint angle + angular-velocity series, world trajectories, and the *intended* plan via
   `provenance`), but nothing compared intent vs. outcome, so a reversal shipped straight to
   the user.

## Why it still read as robotic

The playback stack is good (SQUAD fly-through in `motionTrajectory`, proximal→distal onset in
`motionStagger`, a velocity governor). The gaps are in the **representation**:

- **Intra-phase coordination is discarded.** Templates *describe* real timing in prose
  (squat: ankle/pelvis peak ~86–90%, knee/hip ~98–99%) but every target in a keyframe lands
  **simultaneously**; the generic chain-rank stagger can't express movement-specific per-joint
  peak offsets. → Phase 2 adds an optional normalized `peakAt`.
- **No amplitude/ratio coupling** (squat hip:knee ≈ 1:1.2 is two independent peaks). → Phase 2
  signature terms.
- **No weight/balance model** beyond the crude `pinRootToFloor`. → Phase 3 uses IK for contact.

## The fix: close the loop, don't grow the model

- **Raise the abstraction** so the model states *intent*, never an axis sign: a semantic
  `travel: forward|backward|left|right|up|down` / `posture: upright|supine|prone|sidelying-*`
  vocabulary that the engine maps to the correct signed `translateM`/`orient` (Phase 0).
- **Reference kinematic signatures + a deterministic validator** built on the existing
  `exportKinematics()` output: after each generation, sample headlessly with
  `sampleComposedMotion()` (deterministic, no rendering) and compare measured-vs-signature —
  auto-repair sign reversals with **zero LLM calls**, and only on real drift send **one**
  targeted correction (Phases 1–2).
- **IK/FK for contact truth, sparingly**: `solveIKChain` (CCD) to plant a swing foot / keep
  hands on armrests; FK stays the default authoring path (Phase 3).

Net loop: **model proposes (small, fast) → engine samples & scores (deterministic) →
auto-correct or one targeted retry → ship.** The intelligence is in the signatures + validator
(cheap, testable), not in a bigger prompt.

---

## Phased plan (each phase gated by a headless vitest assertion)

- **Phase 0 — Kill the reversal.** Semantic `travel`/`posture` vocabulary in
  `resolveComposedMotion`; deterministic direction validator + auto-flip; fix the contradictory
  comments; new `movementDirection.test.ts` gate that **samples on the rig** and asserts world
  travel/orientation sign (fails if the mapping is flipped). Raw `root` stays back-compat.
- **Phase 1 — Signatures for simple/single-DOF templates** (cervical rotation, shoulder
  flexion/abduction, lumbar flex/ext, single-leg stance). Freeze a signature per template from
  `exportKinematics`; build the scoring validator. *Gate:* each template round-trips against its
  own signature; a sign-flipped variant is rejected.
- **Phase 2 — Coordinated planted movements** (squat, sit-to-stand, hip-hinge, lunge, march).
  Add `peakAt`; encode ankle-leads/knee-trails offsets; add ratio + peak-ordering signature
  terms. *Gate:* measured hip:knee ratio and peak-time ordering within tolerance; STS shows
  flexion-momentum-before-extension in the velocity series.
- **Phase 3 — Travel + contact (IK)** (forward step, side-step, gait cycle). Semantic travel +
  swing-foot IK plant. *Gate:* no foot-slide during stance (world-position variance under
  threshold), correct travel direction, COM over base of support for balance holds.
- **Phase 4 — Compound sequences** (stand→squat→stand→step) via cross-motion continuity
  (`startFrom:'current'`). *Gate:* each sub-movement independently passes its signature; no
  teleport between segments.

The harness is headless and deterministic, so "test/retest" is re-running vitest — no visual
inspection required.
