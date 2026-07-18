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
200 ms slice is below the visual threshold. (An earlier note here also cited the
`MAX_KEYFRAMES` budget as a reason not to expand the gait leads — that cap is now
**48**, so the budget no longer binds; the visual-threshold argument is the one
that stands.)

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
- **Jump physics — DONE.** `buildJump` replaces the old quick-squat "jump" (2
  keyframes that rose and never landed) with a real countermovement jump: load →
  explosive propulsion → **floating airborne apex** (root travels up to a peak
  with hang time — the whole body incl. feet leaves the floor) → descent →
  **planted landing absorption** → recovery (gated in `jump.test.ts`: COM peaks
  >30 cm above standing MID-motion, feet clear the ground, a distinct landing
  knee-flex follows the apex, NOT a squat). simMOVE routes "jump / hop / leap"
  (height cues scale the apex); a directional/obstacle jump goes to the AI.
- **Gait spring-vs-glide + calibrated vertical — DONE (calibrated).** `gaitBounce`
  now sets a **centimetre target** for the walk's COM vertical excursion
  (0 = a calm ~3 cm glide, 1 = the normal ~5 cm, 2 = a springy ~8 cm bounce),
  realized by `calibrateGaitVertical` as a **mean-preserving reshape** of the
  emergent floor-pin arc (see the calibrated-vertical section below). Stride,
  cadence, **and every clinical joint angle are untouched** — it is a root-only
  reshape. simMOVE routes "bouncy / springy" and "gliding / smooth" walk, and
  calibrates a *plain* walk to the normal ~5 cm too. Gated in `gaitBounce.test.ts`
  (excursion lands on target, joints identical to the uncalibrated walk, feet stay
  grounded). Supersedes the old knee-scaling knob, which flung the swing foot to
  ~30 cm and clipped the stance foot ~5 cm *through* the floor while barely moving
  the COM.
- **Arm follow-through (overlapping action) — DONE.** The walk's arms no longer
  swing dead-straight (the "marching robot" read). The elbows now carry ~20°
  flexion and PUMP through the cycle (more flexion on the backswing, unwinding as
  the arm comes forward, ~11-30°), so the forearm/hand trail the upper arm —
  the top-tier cheap realism cue. Root-only to the arm chain: every leg and
  shoulder angle is untouched (gated in `armFollowThrough.test.ts`; the gait
  signature now counts 10 primary movers, not 8).
- **Jump takeoff hitch — DONE.** The countermovement jump's launch had a ~2 cm COM
  DIP at the planted-propulsion → floating-apex pin toggle (the toe push-off
  heel-raises the pinned pelvis ~6 cm, but the floating apex's `travel.up` lerp
  started from 0, so the pelvis dropped at takeoff). Seeding the propulsion knot
  with a ~6 cm `travel.up` makes the floating rise start where the pin left the
  body — a continuous launch (gated in `jump.test.ts`: the COM rises monotonically
  from load-bottom to apex). The planted propulsion frames are unaffected (the pin
  cancels the seed there; it only seeds the interpolation INTO the apex).

What's left is genuinely optional / needs a clinician, not fixes:

1. **SME sign-off** on the authored values — the walk template, the squat/hinge
   `peakAt` leads, the `paceGait` stride/cadence split, and the travel-walk
   step length — all clinician-authored, flagged for verification
   (`movement-templates-reference.md`).
2. ~~**Paced travel gait**~~ — **done.** `buildTravelWalk({ speed })` couples
   stride + cadence (each ∝ √speed) and scales the stance-contact windows by
   1/cadence so the feet stay planted at speed (gated in `gaitTravel.test.ts`).

### Calibrated gait vertical — DONE (was mis-scoped as "needs a rig project")
Targeting a true ~4-5 cm pelvis excursion (and a cm-accurate `gaitBounce`) is now
**shipped and gated**. An earlier pass declared this blocked and prescribed a rig
project — **add a transverse pelvic-rotation DOF + pelvic list + a two-constraint
foot IK** — on the classic *determinants of gait* reasoning. A red-team against
the biomechanics literature found that prescription **points at the wrong lever**:
Gard & Childress (2001) and Kuo (2007, the inverted-pendulum analysis) show
**pelvic rotation and pelvic list contribute little to vertical COM** at any
walking speed — the excursion is essentially the inverted-pendulum vault, so
faking a pelvic DOF would have burned a project chasing a few millimetres.

**What was actually true (measured on the rig):**
- The floor-pin makes the pelvis a geometric slave of the lowest foot — a
  **compass-gait vault**, and its ~9 cm emergent excursion is close to the classic
  rigid-compass number (~9.5 cm). The **phase is already correct**: pelvis peaks
  at mid-stance / single support and troughs at double support (a proper
  double-bump), so only the **amplitude** (≈2× real) was wrong.
- Direct pelvis-Y authoring **with a foot-lock IK** does calibrate the pelvis
  exactly, but on the *in-place* walk the foot-lock is invalid (a world-locked
  foot only makes sense when the body travels over it) and it corrupts the stance
  **hip** (30° → 54°). That — not a missing pelvic joint — was the real blocker.

**The fix (shipped):** a **mean-preserving, root-only reshape.** The sampler and
the live stage (via one shared `deriveVerticalCalibration` / `applyVerticalCalibration`
in `rootMotion`, so they cannot diverge) do a cheap pre-pass to measure the
emergent grounded arc over one cycle, then scale its deviation **about its mean**
to the requested `verticalCalibrationCm`. Because it only touches `root.y` (never a
joint), **every clinical angle is left exactly as authored** — the opposite of the
foot-lock approach. Measured on the rig: target 5 cm → **5.00 cm**, hip/knee peaks
**identical** to the uncalibrated walk, feet stay within ~2 cm of the floor at the
arc extremes (vs the old knee-scaling knob's ~5 cm floor-clipping). `gaitBounce`
sets the target (3 / 5 / 8 cm); simMOVE calibrates every in-place walk to ~5 cm.
Gated in `gaitBounce.test.ts`.

### Travel walk — DONE (root motion from foot placement)
The forward `buildTravelWalk` had a real defect the horizontal-only `gaitTravel`
gate didn't catch: the stance foot slid ~30 cm HORIZONTALLY and ~7-18 cm
VERTICALLY. Measured root cause — a **two sources of truth** problem (the
red-team's #3.3): the gait FK swept a foot ~**97 cm** fore-aft while the authored
root travelled only ~35 cm/step, so the planted foot was dragged; and the FK pose
doesn't bring the swing foot to the floor at heel-strike, so the foot-lock captured
each foot **airborne** (y ≈ 24 cm) and the "slide" was the foot descending. Raising
the stride to match made it *worse*.

**The fix (shipped): one source of truth — `footDrivenTravel`.** The stride is no
longer authored and the feet are no longer IK-locked. Instead the sampler and stage
(one shared `deriveFootDrivenTravel` in `rootMotion`, so they can't diverge) do a
PRE-PASS over the in-place FK + floor-pin, read the feet, and derive the forward
(+Z) root motion that cancels the **planted (lower) foot's** backward body-space
sweep each frame — so the stance foot is world-fixed BY CONSTRUCTION and the swing
foot rides the body forward. A handoff (the lower foot changes → the new foot has
landed) makes no advance that frame. Vertical grounding stays with the floor-pin.
Measured on the rig: stance-foot horizontal slide **0.2-0.4 cm** (was ~30 cm), body
travels ~1.1 m/stride, joints pristine (hip 32°, knee 61°), and speed couples — a
`paceGait` fast walk has a bigger swing → a longer *emergent* stride AND a shorter
cycle (1.29 m in 1.35 s). No capture timing to get wrong, no IK to corrupt the hip.
Gated in `gaitTravel.test.ts`.
3. **Optional `peakAt` leads on sit-to-stand / lunge** if SME confirms an
   intra-phase order (their current relay is inter-phase only).
4. **Velocity-continuous rail recordings** — the live rail currently *trims* the
   intro (pose-continuous); routing it through the engine's `loopCycle` sampler
   would make it velocity-continuous too (needs offline sampling on the stage
   skeleton with save/restore).
