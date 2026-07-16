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

---

## Implementation log (as built)

### Key discovery — the reversal was a two-frame conflation
Direct measurement on the male rig (toes; forward arm-raise; hip flexion; trunk flexion — all move
**+Z**) proves the mesh **physically faces world +Z**. The clinical joint-angle readout in
`jointAngles.ts` labels anterior `−Z`, but that is a *measurement-frame naming choice*, not the
physical facing. The reversal was the composer using the readout label (`−Z`) to decide **travel**;
travel must use physical facing (`+Z` = forward). Only the **sagittal (Z)** axis was ever wrong —
left/right (+X), up/down (+Y), supine/prone (pitch), side-lying (roll) were always correct — which
is exactly why it read as "forward/backward reversed." The engine's `−Z`-facing docs (`rootMotion`,
`motionRecording` export schema, `bodyVariants`, the mislabeled `FORWARD STEP` test) were reconciled
to `+Z` so nothing re-introduces it. `jointAngles.ts` carries a **TWO FRAMES** note as the source of
truth.

### Phase 0 — DONE (2 commits, red-team + direct-measurement verified)
Semantic `travel`/`posture` vocabulary (`motionSequence`), deterministic direction validator +
auto-flip (`movementDirection`), the two-frame reconciliation, and a rig-sampled gate test that
asserts **facing-relative** travel. The first pass mapped `forward → −Z` (trusting the readout
label); the red-team + measurement caught it before it shipped.

### Phase 1 — DONE (red-team hardened)
`movementSignature.ts`: distill a recording's kinematic export into a direction+shape fingerprint
and `scoreAgainstSignature` — rejects per-joint sign-flips (one-way via dominant sign;
symmetric-bidirectional via peak↔trough **order**), gross amplitude misses, coordination scrambles,
and reversed travel; tolerates jitter. A **driver allowlist** (`driverKeysOf`) fingerprints only the
joints the plan commands, so the world-frame shoulder readout's coupling (a pure flexion also reads
as abduction; trunk flexion induces phantom arm motion) can't pollute a signature. Hardened after
review: a vacuity guard (an empty/allowlist-matched-nothing reference can never become accept-all).

### Phase 2 — coordination checker
`movementCoordination.ts`: declarative cross-joint relations (excursion **ratios**, peak/velocity
**ordering**, **together**/**apart** phase timing) measured off the export. Gates the natural
coordination the engine genuinely produces: squat hip:knee ≈ 100:120, march reciprocal (stepping leg
peaks WITH the contralateral arm, APART from the ipsilateral), sit-to-stand flexion-momentum-before-
extension.

### Phase 3 — travel + contact via IK (`footContact` + sampler `contacts`)
Closed-chain ground contact so a stance foot stays put while the body travels. `buildFootPlant` builds
the leg CCD IK chain (foot → knee → hip, knee kept a hinge, ROM-clamped, best-effort when
unreachable); `sampleComposedMotion` gained an **opt-in** `contacts` that pins each declared foot to
its true first-frame world position each frame. `measureContactSlide` scores drift. Gate (real rig): a
forward step drops the stance foot's horizontal slide from ~0.30 m (moonwalk) to **<0.08 m** while the
body still travels +Z and the swing foot advances. Red-team hardened: the plant target is captured
**lazily at the first frame** (correct for `startFrom:'current'` continuity, not just neutral — a
baseline capture teleported the foot ~0.4 m); the vertical float is now gated; and the harness-root
reset gotcha (each sample captures the current root as its rest) is handled.

### Phase 4 — compound chains (`movementChain`)
`sampleMotionChain` sequences validated primitives with cross-motion continuity — each segment after
the first continues from the previous end pose + root (`startFrom:'current'`), the harness reset per
segment so travel never double-counts. `measureSeamContinuity` gates "no teleport between segments."
Gate: a chain of validated primitives is continuous (seams <3°) AND each sub-movement independently
passes its own Phase-1 signature; a reset-to-neutral counter-example (arm snaps 90°→0°) is caught.

**Measured finding (drove the intra-phase generation improvement):** INTER-phase coordination is real
(authored as distinct keyframes — the march's reciprocal timing, the STS lean-before-rise), but
INTRA-phase timing was **lockstep** — every joint in one keyframe peaked at the keyframe boundary, so a
within-phase lead like "the ankle dorsiflexes ahead of the knee in a squat descent" (which the
templates *describe* in prose) was not realized.

### Phase 2b — intra-phase `peakAt` timing (generation)
`SequenceTarget.peakAt` (0..1) declares the fraction of a keyframe's travel at which a joint reaches
its target and holds; `expandPeakTiming(motion)` realizes it as ordered **sub-keyframes on the
existing SQUAD trajectory** — no trajectory/timing-governor change. The final sub-keyframe holds every
joint at full target, so **settled poses/holds/measurements are unchanged**; a plan with no `peakAt`
is byte-identical (opt-in, back-compat). Gate: with `peakAt` the ankle peaks **before** the knee (the
Phase-2 coordination critic confirms the lead); without it, lockstep. This is the mechanism the AI (or
the SME templates, with sign-off) uses to author natural within-phase leads.
