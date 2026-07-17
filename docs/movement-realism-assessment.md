# Movement Realism — Critical Assessment (2026-07)

**Scope.** How simMOVE movements are being **created** and how they **loop**, after the
walk-gait work landed. Every claim below is **measured on the real male rig**
(headless sampling via `sampleComposedMotion` / the trajectory builder), not
eyeballed. Owner: simMOVE. Companion to `movement-quality-plan.md` (Phases 0–4)
and `movement-templates-reference.md` (the SME sheet).

---

## TL;DR

The per-pose layer is genuinely good (ROM-clamped, sub-degree measured, SQUAD
fly-through between interior keyframes, reciprocal coordination). The realism
gaps are concentrated in **two places**: the **loop seam** (now FIXED) and
**unused engine capability** — the intra-phase timing (`peakAt`) and IK foot
contact both exist and are validated in tests but are wired into nothing on the
live path.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Looping snapped back through the standing pose every cycle (~30° hip jump) | High | **Fixed** |
| 2 | Looping stalled to ~0 velocity at the wrap (stop-and-go each cycle) | High | **Fixed** |
| 3 | Intra-phase lockstep — joints in a phase arrive together (no ankle→knee→hip lead) | Medium | **Fixed** (squat, hip-hinge; see note) |
| 4 | Feet not ground-true on the live stage (IK contact unused) | Medium | **Fixed** (windowed contacts + live wiring) |
| 5 | AI free-form locomotion has no runtime gate (2-keyframe sketch still possible off-template) | Medium | **Fixed** (structural gate → retry → fallback) |
| 6 | Fixed cadence/amplitude — no stride-length ↔ speed coupling | Low | **Fixed** (paceGait) |
| 7 | Saved recordings capture one pass from standing, not a clean cycle | Low | **Fixed** (loopCycle + rail trim) |

**All seven findings are now addressed.** Details below; the remaining open work
is the follow-on noted under Finding 4 (a travel-gait consumer for the live IK)
and SME sign-off on the authored values.

---

## How animations LOOP

### The mechanism
A composed motion resolves to keyframes → `buildComposedTrajectory` makes ONE
continuous SQUAD trajectory through them → the stage plays a first pass for
measurement, then (if `loop`) re-runs the trajectory with `elapsed = rawMs %
total`.

### What was wrong (measured, walk template)
The looping playback reused the **open** trajectory, which:
- **prepends the start/neutral pose as knot 0**, and
- **marks both ends `stop`** (zero velocity).

So `rawMs % total` wrapped `pose(total⁻) → pose(0)`, and `pose(0)` was the
**standing** start knot. Measured on the rig:

- **Seam pose jump: 30.0° on `R_UpLeg`** every cycle (`pose(1600ms)` = mid-stride
  left-terminal-stance → `pose(0)` = standing). Start knot was **<2°** from the
  neutral baseline — i.e. the avatar bobbed toward standing once per stride.
- **Seam velocity: ~1°/s** at the wrap vs **270°/s** mid-phase — a full
  stop-and-go each cycle.
- Interior seams were fine (**0.2°**, velocity-continuous), so the SQUAD
  machinery was never the problem — only the wrap.

### The fix (shipped — `buildLoopTrajectory`)
A dedicated **periodic ring** over the keyframe poses only:
- the intro/standing pose is **excluded** from the cycle (no snap);
- the wrap `last → first` is a **velocity-continuous fly-through** — the authored
  cycle transition (gait terminal-stance → next initial-contact);
- realized by **padding one wrapped keyframe on each side** so the existing SQUAD
  + PCHIP time-warp compute correct *periodic* tangents at the seam;
- a keyframe that **holds** stays a genuine per-cycle pause (a held rep top);
- the stage plays the first pass unchanged (ease-in + measurement), then enters
  the loop at the last keyframe's phase (`enterAtMs`) so the first wrap is smooth
  too.

Gated by `motionTrajectoryLoop.test.ts`: the old open+wrap seam is >20°
discontinuous (documents the bug); the new loop is continuous in **pose and
velocity** across the wrap (per-frame steps stay within a band of the interior
median — neither spike nor stall), never comes within 15° of standing, and scales
with `timeScale`. One-shot, sampler, and measurement paths are untouched.

---

## How animations get CREATED

Two paths, one engine:

1. **Deterministic template path (simMOVE `templateInterpreter.ts`).** A reference
   movement (+ slider modifiers) plays the clinician-authored, ROM-validated
   template directly — no model. This is where "walk" now resolves.
2. **AI compose path (`/api/motion-compose` → `compose_motion`).** Everything
   else. The model authors keyframes anchored on the templates in its prompt; the
   engine clamps + measures every target.

### Residual realism gaps in creation

**3 — Intra-phase lockstep (Medium) — FIXED for the coarse planted movements.**
Every target in a keyframe used to arrive **together** (lockstep), so a
within-phase relay like "the ankle dorsiflexes ahead of the knee in a squat
descent" (which the templates *describe* in prose) was not realized. The engine
shipped the mechanism — `SequenceTarget.peakAt` + `expandPeakTiming` (Phase 2b) —
but nothing called it at runtime.

*Fixed:* `expandPeakTiming` now runs inside `resolveComposedMotion` (one point;
idempotent — its output carries no `peakAt`; a plan with no lead is
byte-identical), so both template and any future AI `peakAt` are realized on the
live path. Leads are authored where the template's own prose specifies a
sequence and the lead fits the velocity floor: the **squat** descent (ankle
dorsiflexion leads at ~80%, Kim 2020) and the **forward-hip-hinge** (hips
initiate at ~80%, spine rounds to end-range). Gated by `peakTiming.test.ts`: the
squat template's ankle now leads the knee, and the hinge's hip leads the thoracic
spine — measured on the rig, through `resolveComposedMotion` with no explicit
expand call.

*Note — the walk was intentionally left lockstep-per-phase.* Its 8 fine phases
(200 ms each) already encode the distal→proximal relay **inter-phase**
(heel-strike → loading → push-off → swing), so an intra-phase sub-lead within a
200 ms slice is below the visual threshold. It also would not fit: expanding an
8-phase cycle into sub-keyframes exceeds `MAX_KEYFRAMES` (12), so the budget
guard would drop leads asymmetrically. Raising the cap for gait is a separate
decision (it also widens the AI's authoring budget) — deferred.

**4 — Feet not ground-true (Medium) — FIXED.** The live stage planted only
*vertically* (`pinRootToFloor`); the closed-chain IK stance-plant was used only
in `footContact.test.ts`. Now: `contacts` gained a per-foot stance **window**
(`fromMs`/`toMs`), re-capturing the plant target on window entry so an
**alternating** gait pins each foot only while it bears weight (gated:
a 2-step travel walk keeps each stance foot < 8 cm slide while the body advances
+Z, vs the un-pinned moonwalk). `contacts` thread through `ComposedMotion` →
`resolveComposedMotion` → the **live stage**, which IK-plants declared feet per
frame mirroring the sampler (source-pinned in `stageReliability.test.ts`).
*Remaining follow-on:* the in-place looping walk declares no contacts (no travel
= no moonwalk), so the live IK is inert until a **travel-gait** instruction
(root moves forward, alternating stance windows) is added to consume it — that
new movement is the concrete next feature, and the plumbing + gated IK are ready
for it.

**5 — No runtime gate on AI locomotion (Medium) — FIXED.** For any off-template
locomotion ("walk with a limp", "shuffling gait") the compose planner's output
shipped unvalidated. Now simMOVE's `locomotionGate` runs a fast **structural**
plausibility check on the planned `ComposedMotion` (no rig sampling needed):
keyframe floor (≥ 6), bilateral hip+knee involvement, and reciprocal
stance/swing alternation. On a degenerate plan it retries the planner **once**
with a targeted hint, then falls back to the deterministic **paced walk**
template — so a locomotion request can never again ship a 2-keyframe sketch
(gated in `locomotionGate.test.ts`; wiring source-pinned in
`motionStage.test.ts`). A structural gate (vs. rig-sampling the browser can't
do off-stage) is the right tool: the regression is a *shape* defect.

**6 — Fixed cadence/amplitude (Low) — FIXED.** A "fast walk" used to be the same
stride played faster (`timeScale` only). `paceGait` now splits the requested
speed evenly between **stride** (sagittal leg + arm amplitude) and **cadence**
(`timeScale`), each ∝ √speed so stride × cadence = speed exactly: a fast walk
takes longer, quicker steps; a slow walk shuffles (gated: faster ⇒ bigger
hip/knee excursion AND shorter period). simMOVE's interpreter applies it for the
walk when a speed is detected; other movements (no stride) keep a plain
`timeScale`.

**7 — Recordings capture one pass from standing (Low) — FIXED.**
`sampleComposedMotion` gained an opt-in `loopCycle` that samples exactly one
seamless period of `buildLoopTrajectory` (no intro pose, velocity-continuous
wrap) — a clean, replayable cycle for offline/GLB export (gated in
`loopCycleRecording.test.ts`). On the live rail, simMOVE **trims the standing
intro** off a looping motion's captured recording, so the saved clip starts at
the gait cycle and loops without the standing snap.

---

## What's solid (don't regress)
- Per-pose ROM clamping + sub-degree goniometric measurement.
- SQUAD continuous trajectory through **interior** waypoints (velocity-continuous,
  eases only at real stops).
- Reciprocal cross-body coordination + knee:hip ratio + push-off-before-swing
  ordering, all gated on the rig.
- The deterministic template path (instant, offline-safe, model-free for the
  core movements).
- **The loop seam** (this pass).

## Status & remaining follow-ons
All seven findings are addressed and gated, and the travel-gait consumer that
makes the live foot IK visible is now built too:

- **Travel gait — DONE.** `buildTravelWalk` is a forward-traveling gait (root
  advances +Z over one stride, alternating stance-foot contacts) that consumes
  the Finding-4 live IK: each stance foot stays world-planted while the body
  passes over it (gated in `gaitTravel.test.ts`). simMOVE routes "walk forward /
  ahead / across" to it; plain "walk" stays the in-place looping cycle.

What's left is genuinely optional / needs a clinician, not fixes:

1. **SME sign-off** on the authored values — the walk template, the squat/hinge
   `peakAt` leads, the `paceGait` stride/cadence split, and the travel-walk
   step length — all clinician-authored, flagged for verification
   (`movement-templates-reference.md`).
2. **Paced travel gait** — the travel walk is fixed-cadence (its contact windows
   are authored in phase time); coupling it to speed needs the contact windows
   scaled by `timeScale`.
3. **Optional `peakAt` leads on sit-to-stand / lunge** if SME confirms an
   intra-phase order (their current relay is inter-phase only).
4. **Velocity-continuous rail recordings** — the live rail currently *trims* the
   intro (pose-continuous); routing it through the engine's `loopCycle` sampler
   would make it velocity-continuous too (needs offline sampling on the stage
   skeleton with save/restore).
