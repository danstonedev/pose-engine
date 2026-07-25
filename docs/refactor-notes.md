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

4. **Out-of-band Stop vs in-flight clip load — race.** Stop bypasses the serialized `commandChain`
   (~247, 358) and mutates state synchronously; but `runMotionImpl` after `await getClips()` checks
   only `disposed` (~3283), with NO supersession token (the composed path re-checks
   `token !== composedSeq` after every await). A Stop / newer command during an *uncached* clip load
   is silently overridden and the stale clip plays. FIX LATER: add a clip supersession token.

5. **No driver ownership / overlay contract.** "Which of `activeMotionId`/`composedActive`/
   `activeTween`/`activeTrajectory` is set" is four booleans, not one owner; idle re-bakes on
   whatever pose is current (`applyIdleOverlays` ~1019 captures current bones as its base). This is
   the STRUCTURAL cause of #1/#4 — and is what the refactor should make unrepresentable (a single
   driver state machine + an overlay stack with one bake/undo contract).

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
