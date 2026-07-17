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
| 3 | Intra-phase lockstep — joints in a phase arrive together (no ankle→knee→hip lead) | Medium | Open |
| 4 | Feet not ground-true on the live stage (IK contact unused) | Medium | Open |
| 5 | AI free-form locomotion has no runtime gate (2-keyframe sketch still possible off-template) | Medium | Open |
| 6 | Fixed cadence/amplitude — no stride-length ↔ speed coupling | Low | Open |
| 7 | Saved recordings capture one pass from standing, not a clean cycle | Low | Open |

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

**3 — Intra-phase lockstep (Medium).** Within a 200 ms gait phase, joint
peak-velocity times cluster: hip @200 ms, knee @283 ms, ankle @283 ms — they
essentially arrive **together**. Real gait has a continuous distal→proximal
relay (ankle push-off *leads* knee swing *leads* hip). The engine already ships
the mechanism — `SequenceTarget.peakAt` + `expandPeakTiming` (Phase 2b) — but
**nothing calls `expandPeakTiming` at runtime and no template sets `peakAt`.**
This is the biggest remaining "robotic within a phase" contributor now that the
stop-start-per-keyframe and loop-seam problems are solved. *Fix:* author `peakAt`
leads on the gait (and squat/STS) templates and run `expandPeakTiming` in the
resolve/build path.

**4 — Feet not ground-true (Medium).** The live stage plants only *vertically*
(`pinRootToFloor`); the closed-chain IK stance-plant (`buildFootPlant` /
sampler `contacts`, Phase 3) is used **only in `footContact.test.ts`** — never on
the live stage or by simMOVE's sampler. Consequence: an "in-place" walk is FK
legs over a vertical pin (reads as treadmill stepping, acceptable but not
ground-true), and **actual-travel gait** (stance foot world-fixed while the body
passes over it) is unreachable on the live stage. *Fix:* thread `contacts` into
the stage playback for planted phases; unlocks real forward-travel walks.

**5 — No runtime gate on AI locomotion (Medium).** The signature + coordination
validators (`scoreAgainstSignature`, `checkCoordination`) that *reject* a
2-keyframe walk run **only in tests**. For any off-template locomotion ("walk
with a limp", "shuffling gait") the compose planner's output ships unvalidated —
the original 2-keyframe failure mode is prevented for template *words* but still
structurally possible for variants. *Fix:* after a compose result for a
locomotion-shaped request, sample headlessly and score against the nearest
template signature; auto-reject/retry degenerate plans (the "model proposes →
engine scores → one targeted retry" loop the quality plan describes).

**6 — Fixed cadence/amplitude (Low).** 1.6 s cycle, ±20° arm swing, scaled only
by `timeScale`. No stride-length ↔ cadence ↔ speed coupling, so a "fast walk" is
the same stride played faster rather than longer+quicker. *Fix:* parameterize the
gait template (cadence, step amplitude, arm gain) and derive them from the speed
modifier.

**7 — Recordings capture one pass from standing (Low).** `sampleComposedMotion`
records `standing → cycle → last keyframe`, so a saved/replayed walk on the
Recordings rail still starts from standing and has the old seam when the rail
loops it. *Fix:* when `loop`, sample exactly one period of `buildLoopTrajectory`
so the saved clip is itself a clean, replayable cycle. (Deferred from the
loop-seam fix to keep the existing recording gates stable.)

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

## Recommended next order
1. **`peakAt` intra-phase leads** (Finding 3) — highest realism-per-effort; the
   mechanism already exists and is tested.
2. **IK foot contact on the live stage** (Finding 4) — unlocks ground-true and
   travel gait.
3. **Runtime AI-locomotion gate** (Finding 5) — closes the off-template
   2-keyframe hole.
4. Cadence/amplitude coupling (6) and clean recording cycles (7) — polish.
