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

2. **Clip→clip is a hard cut (no crossfade).** `runMotionImpl` (~3298-3317): `resetRootToRest`
   → `mixer.stopAllAction()` → `action.play()`. No `crossFadeTo`. run→walk jumps. The ready-settle
   (~2880-2893) is composed-path only. FIX LATER: crossfade locomotion clip transitions.

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
1. **motion-time liveliness** overlay (`applyMotionLiveliness`) → fold into an overlay module
   (shares breath — now owned; entangled with `resetLivelinessOnset` + `setMotionOverlays`).
2. **recording tap** (`captureRecordingFrame` + buildFrameNow) → `stageRecordingTap`.
3. **composed player** (`runComposedImpl` trajectory player, ~880 lines) → `stageComposedPlayer` (split).
4. **posing layer** (~1180 lines, isolated via `poseLayer*` hooks) → `stagePosingLayer` (split 2–3).
   NOTE: zero behavioral tests — write a characterization test FIRST, then extract.
5. **root/context** LAST — `rootRestPos`/`rootRestQuat`/`composedRoot*`/`pelvisShiftBakedM` are
   the shared coordinate frame (30+ refs each across every subsystem); extract via a `StageContext`
   after its consumers are modules, or the renames swamp the diff for no line win.

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
