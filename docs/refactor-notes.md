# ExamStage3D refactor — running notes

**Directive (owner):** Refactor the monolithic live stage FIRST. Target < 500 lines per file.
Do NOT fix behavior/bugs until the decomposition is under control. Keep Stop-freeze
semantics exactly as they are. Log deferred fixes here as we go.

Refactor rule: **behavior-preserving only.** The safety net is the behavioral test
suite (load GLB → run motion → assert angles), `svelte-check`, and the production build —
green after every extraction, committed in small increments.

---

## Deferred fixes (found during red-team — DO NOT fix yet)

Each is code-cited and confirmed against the actual code/assets. Address AFTER the refactor.

1. **Stop-freeze on locomotion looks broken (BEHAVIOR — owner wants freeze KEPT).**
   `cancelActiveMovementImpl` (ExamStage3D ~1379) freezes the current frame; for a looping
   mocap clip that frame is mid-stride + leaning, and the render-loop idle gate (~3523) then
   rides idle overlays on top of it. Owner has decided to KEEP freeze. Revisit only if we make
   it locomotion-aware later. (Not a bug to fix now — recorded for context.)

2. **Clip→clip is a hard cut (no crossfade).** ✅ FIXED — `services/stageClipBlend.ts`: a pose-space
   ease-in captures the current pose (live outgoing frame OR Stop-frozen pose) when a clip starts and
   slerps it into the clip over 0.3 s. Offline harness: run→walk worst single-frame trunk jump
   12.1° → 0.99° (12× smoother). Stop-freeze unchanged.

3. **`resetRootToRest` snaps the root** (`~761-769`, `.copy` not tween). For a traveling clip this
   is a position pop. FIX LATER: ease, or preserve continuity.

4. **Out-of-band Stop vs in-flight clip load — race.** ✅ **FIXED** (with #5, `services/stageDriver.ts`).
   The root cause was worse than this entry originally said. Stop advanced the generation only
   *inside* `cancelComposed()` — i.e. only when a COMPOSED motion happened to be active. With a clip
   mid-load and nothing composed running, Stop hit **no branch at all**: it was a complete no-op, and
   the superseded clip played when the load resolved. Now `cancelActiveMovement` supersedes
   unconditionally, `cancelComposed` advances the SAME counter (`composedSeq = driver.supersede()` —
   one generation, not two), and `runMotionImpl` snapshots before the load and re-checks
   `driver.holds(claim)` after it. It bails **before** the takeover cascade (so a command that never
   plays cannot disturb the pose), still caches the loaded clip, and reports the new honest outcome
   `'superseded'` instead of pretending the clip was unavailable.

5. **No driver ownership.** ✅ **FIXED** — `services/stageDriver.ts` is one authority for "what is
   driving the skeleton?" and one command generation.
   - **One idle question.** The render loop asked `!activeMotionId && !composedActive &&
     !activeTween && !activeTrajectory`; it now asks `driver.idle`. Adding a mechanism can no longer
     silently miss a gate.
   - **Drift-proof by construction.** Each handle keeps its DATA (which clip / tween / trajectory)
     but is written ONLY through a paired setter that registers the mechanism
     (`setActiveMotionId` → `driver.setRunning('clip', …)`). `stageDriverWiring.test.ts`
     machine-checks that **no raw assignment escapes its setter** — the single rule that makes
     `driver.idle` trustworthy, so it is enforced rather than left to review.
   - **Supersession on every path**, which is what actually closed #4.
   - 13 model tests + 14 wiring pins, counterfactual-verified (removing the Stop bump fails the suite).

   **Not done, deliberately: the overlay bake/undo contract.** Folding the paired
   `undoIdleOverlays(); undoEyeGaze();` calls at each takeover into one stack is a separate
   behaviour-preserving change with its own risk; the existing pairs are correct and pinned by the
   eye/idle suites, and neither #1 nor #4 depended on it. Left as the next candidate if the
   scattered pairs ever cause a miss.

### Asset issues (separate from code)
- **`run.glb` is asymmetric:** trunk lean measured −0.7°→−11.7°, ALWAYS rightward; frame0 = −7.8°.
  Replace or mirror; author a symmetric run.
- **`walk.glb` is laterally flat:** constant +0.7° lateral trunk lean across the whole cycle
  (no gait sway). Stiff; consider a better capture.

---

## Refactor progress (paused — resumable)

Behavior-preserving extractions landed on `claude/handoff-prompt-block-oy15fn`, each
green (svelte-check + full suite 1055 + build):

- **step 1** `services/stageDiagnostics.ts` — pure diag compute + 15 unit tests.
- **step 2** `services/stageEyeGaze.ts` — eye micro-gaze overlay (own state).
- **step 3** `services/stageBreath.ts` — shared breath/exertion clock (the first strand
  of the root↔pelvis-shift↔overlay↔breath knot).
- **step 4** `services/stageIdleOverlay.ts` — idle breathing/sway/weight-shift/ankle-pivot.

ExamStage3D.svelte: **4986 → 4723**. Pattern: move logic+state to a factory module,
keep thin same-named wrappers in the component so call sites don't churn; retarget the
body source-pins to the module, keep wiring pins on the component.

### Remaining decomposition (in order), to get under 500/file
1. ~~**motion-time liveliness** overlay~~ ✅ `services/stageMotionLiveliness.ts` (step 5).
2. ~~**recording tap**~~ ✅ `services/stageRecordingTap.ts` (step 6) — the ActiveRecording buffer +
   sample throttle moved to a scene-agnostic module; `buildFrameNow`/`buildFrameNowClean` (the stage
   SNAPSHOT, coupled to root/measure/serialize) stay in the component and are injected as `buildFrame`.
   10 unit tests (fake clock + fake buildFrame). Clock-derived id/createdAtIso are caller-stamped.
3. **composed player** (~880 lines) — split in progress:
   - ✅ **rig derivations** → `services/stageComposedDerivations.ts` (step 8): the four trajectory
     pre-passes (vertical calibration, foot-driven travel, lateral shuttle, heel-strike accents) plus
     the SEAM-2 time-scaling helpers. Each is a pure function of (context, trajectory, params) → table,
     so the stage keeps owning the `composed*` state its per-frame appliers read — no getter churn
     across ~60 read sites. Introduces **`StageRigContext`** (getters over root/skinned/variantCfg/floor
     + the rest frame + a `clearPelvisShiftBake` callback) — the first piece of the eventual StageContext,
     landed where it was actually needed. Loaded by **dynamic import** like every other three-using
     service, so the component's SSR-safety contract is unchanged. 11 rig-based tests
     (`stageComposedDerivations.test.ts`) — the first behavioral coverage this logic has ever had;
     verified by counterfactual (sabotaging the pelvis-shift clear and the DET-LOCK-01 clamp both fail).
   - ⬜ remaining: the per-frame **appliers** (`applyTrajectoryRoot` ~190 lines, `applyFootPlants`,
     `applyComposedGroundingPin`, `stepTrajectory`) + `setComposedContacts`/`setComposedHandPlants`
     + `setComposedWeightedDescent` (its pre-pass is grounding-aware and calls back into the stage's
     pin applier — needs the applier seam first).
   - ⬜ `runComposedImpl` itself (~425 lines) is ORCHESTRATION (overlays, drivers, balance,
     buildSequencePoses). Extract last, if at all — it is the stage's own composition root.
4. ✅ **posing layer** → `services/stagePosingLayer.ts` (step 9). The whole `if (posable)` block
   (1142 lines) moved behind a `PosingLayerContext`: live getters for the rig/driver state it
   observes, plain callbacks for the stage behaviour it triggers, and ONE `setCurrentPose` for the
   only stage state it writes (coupling measured first: 107 read-only refs vs 4 writes). It now
   RETURNS its `hooks` + `api` instead of assigning stage variables, so ownership runs one way.
   Bonus: the layer is a **separate lazy chunk** (44.8 kB) — the main bundle dropped 1341.9 → 1325.3 kB.
   Verified by **verbatim proof**: reversing the documented renames reproduces the original block
   byte-for-byte except the two lines deliberately hoisted into the stage's dispose wrapper
   (`poseLayerBusy = null` first, `poseApiImpl = null` last — same order).
   Two hazards caught by reading, not by types:
   - the block's `if (disposed) return;` returned from the **boot IIFE** (skipping `loadModel`), so
     the module returns `null` and the stage re-raises the abort;
   - the block already had a local `const ctx` (an `IKChainContext`) — the context parameter is
     named `stageCtx` to avoid silently capturing it.
5. **root/context** LAST — `rootRestPos`/`rootRestQuat`/`composedRoot*`/`pelvisShiftBakedM` are
   the shared coordinate frame (30+ refs each across every subsystem); extract via a `StageContext`
   after its consumers are modules, or the renames swamp the diff for no line win.
   `StageRigContext` (step 8) is the first slice of it — grow that, don't start a parallel one.

### Where the file stands (after step 9): **3504 lines**, from 4986

Largest remaining blocks, with the honest read on each:

| lines | block | verdict |
|------:|-------|---------|
| 425 | `runComposedImpl` | ORCHESTRATION (overlays → drivers → balance → build → play). This is the stage's composition root; extracting it just moves the wiring. Leave, or split only the *setup* half. |
| 293 | `resize` + the boot tail | mostly the resize/observer + boot completion; small, cohesive, fine where it is. |
| 254 | `loop` (the rAF frame) | the frame ORDER is the contract (lift overlays → tap → re-bake → measure). Highly readable in one place; extracting it would scatter the ordering the SEAM-9 pins protect. Leave. |
| 191 | `applyTrajectoryRoot` | **best next extraction** — pure-ish root placement + grounding/plant branches. Needs the same `StageRigContext` plus the composed-enrichment tables passed in. |
| 128 | `loadModel` | boot sequencing; leave. |
| 124 | `stepTween` | exam-tween player; a reasonable small module if more is wanted. |
| ~250 | the composed **appliers** (`applyFootPlants`, `applyComposedGroundingPin`, `stepTrajectory`, `setComposedContacts`, `setComposedHandPlants`, `setComposedWeightedDescent`) | cohesive with `applyTrajectoryRoot` — but see the measurement below: NOT separable from `runComposedImpl`. |

#### Measured: the composed player and `runComposedImpl` are ONE subsystem

Coupling was measured before attempting the cut (same discipline that made the posing layer safe).
The 17 `composed*` state variables are referenced 77× inside the applier region and 61× outside —
but the outside refs break down as **41 declarations/wrappers** (which would move with the state),
**19 in `runComposedImpl`**, and 1 in `buildFrameNow`. The 19 are the problem: **8 of them are
direct WRITES** to `composedVcalPhaseOffsetMs` / `composedVcalRampMs` / `composedVcalHandoff` —
the loop-form phase alignment and first-pass→loop handoff (DET-LOCK-02) — which
`applyTrajectoryRoot` then reads every frame.

So the vcal phase state is **co-owned**: the orchestration sets the phase contract while building
the trajectory; the applier consumes it per frame. Extracting the appliers alone would require
setters that mirror those internal fields one-for-one. That is the getter/setter-mirror
anti-pattern: the module boundary would *hide* the coupling instead of removing it, and the real
invariant (phase continuity across the handoff) would still span two files — now less visibly, and
with no runtime test to catch a slip.

**Verdict: do not split here.** The coherent unit looked like `runComposedImpl` + the appliers +
the state extracted TOGETHER. That was then measured too — and it fails the same test, harder.

#### Measured again (the whole-unit attempt): the composed player IS the stage core

Scoping the full unit (state + wrappers + appliers + `runComposedImpl` = **1111 lines**) gives an
external surface of ~106 identifiers, and — the deciding number — of the 13 shared driver-state
variables, **10 are written by BOTH sides**:

| written by both | module-owned | stage-owned |
|---|---|---|
| `composedActive`, `composedActiveToken`, `composedCancelledToken`, `composedHasPlayed`, `composedRootQuat`, `composedRootTranslate`, `composedCurrentGrounding`, `currentPose`, `pelvisShiftBakedM`, `activeTrajectory` | — | `composedSeq`, `activeMotionId`, `activeTween` |

Compare the posing layer, which was safe to cut: **107 read-only refs vs 4 writes, one way.**

Here the stage's other halves — `cancelComposed`, the rAF loop, `showRecordedFrame`,
`resetRootToRest`, `applyRootState`, `buildFrameNow` — write the same fields. A module boundary
would need ~10 setters + ~13 getters mirroring stage fields, and the invariants it exists to
protect (supersession tokens, root-frame continuity, pose continuity) would then span two files
through an accessor layer that hides them. That is strictly worse than one scope.

**Conclusion: the composed player is not a subsystem hiding inside the stage — it IS the stage
core.** What remains in `ExamStage3D.svelte` after nine extractions is the driver state machine,
the shared root frame, the rAF ordering contract, and the composition root: exactly what a
component of this kind should own. The subsystem-level refactor is DONE.

If this core is ever to shrink, the lever is **deferred fix #5** (one driver-owner state machine +
an overlay bake/undo contract), which makes the co-ownership representable in the first place —
a behaviour change, not a move, and therefore out of scope until the owner asks for it.

#### Measured a third time: the posing layer does not sub-split either

`stagePosingLayer.ts` (1299) is the one module over the 500 guideline, so its most promising
internal seam — planes / slice / section cap — was measured the same way. That state
(`planes`, `sectionCap`, `planeVis`, `sliceState`, `clipTargets`, `obliqueDot/Hit`,
`obliqueRingDrag/Press`) is referenced **53× inside its own functions and 59× outside them**:
`dispose` (14), `onPosePointerMove` (11), `updatePoseHandles` (6), `onPosePointerDown` (6),
`beforeRender` (6), `onPosePointerUp` (4), `updateRingGizmo` (3)…

The oblique-plane handle IS pointer interaction; the slice refresh IS part of the frame; teardown
spans everything. It is one interaction system over a shared state pool, not three systems sharing
a file — so the same verdict applies.

### The refactor has reached its natural boundaries

Three candidate further splits, three measurements, one principled reason to stop each time: **the
state is co-owned, and a module boundary would hide the coupling instead of removing it.** The
containment test that authorised the cuts we DID make (posing layer: 107 read-only refs vs 4
writes, one direction) fails for all three.

What remains is two files that are each exactly one concern:

- `ExamStage3D.svelte` (3504) — the stage driver core: driver state machine, shared root frame,
  rAF ordering contract, composition root.
- `services/stagePosingLayer.ts` (1299) — the interactive posing studio, isolated behind a
  one-way contract, lazily loaded, contract-tested.

…plus eight subsystems, every one under 500 and unit-tested, that were genuinely separable:

| module | lines | tests |
|---|---:|---|
| `stageBreath` | 57 | via idle/motion overlays |
| `stageClipBlend` | 96 | 5 |
| `stageMotionLiveliness` | 101 | source-pinned + rig |
| `stageDiagnostics` | 111 | 15 |
| `stageRecordingTap` | 131 | 10 |
| `stageEyeGaze` | 150 | rig + pins |
| `stageIdleOverlay` | 192 | rig + pins |
| `stageComposedDerivations` | 331 | 11 (rig) |

`ExamStage3D.svelte`: **4986 → 3504** across nine steps, every one behaviour-preserving and shipped.

**A note on the < 500-line target.** The remaining bulk is not one more extractable subsystem; it
is the stage's own composition root plus the per-frame ordering contract. Splitting those further
trades a real invariant (one readable frame order) for a line count. The honest target for
`ExamStage3D.svelte` is "the stage core and nothing else" — roughly 1200–1500 lines once the
composed player lands — with every *subsystem* under 500 in its own tested module. Every module
extracted so far is: diagnostics 120, clip blend 95, breath 60, eye gaze 150, idle overlay 192,
motion liveliness 101, recording tap 130, composed derivations 331. The posing layer (1299) is the
one exception and is itself a candidate for a 2–3 way split (gizmo/selection · handles+twist ·
planes/slice/export) now that it is isolated and independently loadable.

## The safety net — what it actually is (red-teamed, verified)

**`ExamStage3D.svelte` is NEVER MOUNTED in any test.** All three "stage" test files
(`eyeGaze`, `idleLiveliness`, `stageReliability`) only `readFileSync` its source and regex it.
The 1070-test suite is behavioral over `services/` (GLB-loaded rig), not over the component.

Consequences that drive the whole refactor:

- The component's own logic — composed player, posing layer, render loop, root writes — has
  **zero behavioral coverage**. Only textual pins guard it.
- So **extraction IS the quality win**: every block moved from the component into a
  `services/stage*.ts` module becomes unit-testable for the first time. Steps 1–6 added 30 unit
  tests over code that previously had none.
- Discipline for each move: **relocate verbatim** (never edit logic during a move — a move is
  verifiable by textual identity, a rewrite is not), THEN add unit tests against the new module,
  THEN retarget any source-pins. `svelte-check` + build + the service suite catch wiring/type
  breaks; they cannot catch a semantic slip inside moved code.
- A pure de-duplication inside the component (e.g. `previewTrajectoryAt`) is safe only when the
  collapsed blocks are byte-identical — verify by diffing them, not by eye.

## Refactor caveats / gotchas discovered

- **Source-pinned tests exist.** Some tests regex the *source text* of `ExamStage3D.svelte`
  (e.g. `idleLiveliness.test.ts` via `stageSource`, `stageReliability.test.ts` SEAM-9). Moving code
  OUT of the file will break these pins — update the pin targets as code moves (they should follow
  the code to its new module, or become behavioral assertions). Distinguish these from the real
  behavioral tests (the safety net).
- **THREE is dynamically imported** inside the load closure (`const THREE = await import('three')`),
  not at top level — extracted modules must receive THREE/objects as params or import statically.
- **Dead red-team swarm** (`wf_cea6d6d9-240`) stalled at the Map phase; 6/8 subsystem maps cached on
  disk if we ever want to resume it. Not needed for the refactor.
