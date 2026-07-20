# Motion Pipeline Diagnostics & Remediation Plan

**Date:** 2026-07-20 · **Method:** three diagnostic tracers (deterministic path, AI path, cross-cutting seams)
ran empirical probes over both repos — fixture libraries through the real coercion/resolver, headless rig
sampling with the repos' own metrics, and static lockstep audits. Every finding carries measured numbers and
file evidence. Probe artifacts: session scratchpad `pipeline-det/`, `pipeline-ai/`, `pipeline-seams/`.

## Executive summary

The pipeline's *core* is healthy: resolution is pure and deterministic, the stage/sampler pre-pass
pipelines match on 13 of 15 passes, cross-command chains measure 0.00° pose seams, and the loop wrap is
verifiably C1. The user-visible glitches concentrate in four places:

1. **Machinery-to-machinery handoffs** (the seams): turn→walk heading unwind, paced-walk contact desync,
   toe-off release pops, grounding-mode switches, superseded-loop residuals.
2. **Two stage/sampler lockstep breaks** — live playback differs from every recording and test
   (the missing vertical rise clamp; the loop-handoff vcal pop).
3. **The interpreter's decayed honesty contract** — routes recognize modifier words they never apply,
   so "run with knee valgus" and "walk forward guarded" silently play vanilla.
4. **The AI path structurally cannot reach the gait plumbing** — 26× foot slide, double the vertical,
   teleport starts. The walking gait looks good precisely because the deterministic path has this
   machinery; AI plans bypass all of it.

The remediation principle (the walking lesson): **route motion onto the deterministic machinery and make
every handoff blend.** Nothing here needs new physics — it needs the seams closed and the good machinery
made universal.

## Glitch catalog (ranked, measured)

### Severity A — visibly broken today

| ID | Symptom (as seen) | Measured |
|---|---|---|
| SEAM-1 | **turn→walk**: stance hip wrenches on frame one, toe teleports, body whips 180° back and walks off in the pre-turn direction | hip rot 0→+134°, R_Toes +32 cm/frame, yaw 178→0° in <50 ms; walks +Z pre-turn. Cause: walk authors ABSOLUTE root yaw (heading 0 default) + plant rest rotated only by `headingDeg`, which the app never sets. The TUG chain works because it explicitly rebases yaw — generalize that. |
| SEAM-2 | **any paced walk (speed≠1)**: planted foot drags/moonwalks then pops at release | slide 23–58 cm in-window, release pop ~50 cm/frame at speeds 1.2/0.8. Cause: stance WINDOWS are scaled into trajectory time; CONTACTS are applied raw — 1/timeScale desync. Gates only test speed 1.0. |
| DET-LOCK-01 | **live-only stance-leg over-reach/foot skate** in the travel walk — invisible to every recording and test | stage omits the sampler's 2.5 cm vertical rise clamp: live pelvis rides up to 7.3 cm (11 cm fast) above the pin; live-vs-recording divergence up to 4.8/8.5 cm. **One-line fix.** |
| SEAM-4 | **get-down to plank/quadruped**: arms sweep wrong way then snap 168° in <10 ms; body free-falls 53 cm in one frame; feet sweep 0.5 m below floor | ill-conditioned SQUAD tangents on near-180° knot deltas + discrete grounding switch + unblended 4-pass hand-reach solve. |
| AI-PLUMB-01/02/03 | **every AI-composed gait**: ice-skating feet, pot-holed pelvis, no weight shift, teleport start, mid-stride stop | same 8-phase cycle: slide 68 cm vs 2.6 (26×); 100 ms drop 12.4 cm vs 5.2 (fails the engine's own gate); shuttle 0 vs 5.5 cm; entry 1.03 vs 0.15 m/s. The schema **cannot express** contacts/vertical/shuttle/etc. and coercion strips them. |
| SEAM-3 | **toe-off pop even at speed 1**: released foot snaps to FK position | 20–21 cm + 17°/frame at each stance-window end (2–4× the documented Wave-4 class). |
| SEAM-6 | **superseded walk → AI motion**: leg stays raised, arms frozen mid-swing through the whole next motion | carried residuals: hip +30°, elbows +28°, never wash out (ready-settle only guards `startFrom:'neutral'`). |
| SEAM-5 | **stand-from-sit**: 10 cm upward hop at the pelvis→feet pin swap | 9.94 cm/frame (sit-down direction is tuned seam-free; stand-up swaps at a mismatched pose). |
| DET-LOCK-02 | **in-place walk hitch one pass in**: pelvis steps up as the loop engages; recordings don't match the stage | vcal derived from loop vs one-shot trajectories (gain 0.989 vs 0.853); ~3.4 cm seam step; first-pass live-vs-recording 2.0 cm mean / 4.6 max. |
| DET-INT-01/02/03 + AI-GATE-03 | **"I asked for X, it did vanilla"**: run/hop/turn/posture/travel routes consume qualifiers they never apply; the gate fallback drops the qualifier it fired on | "run with knee valgus", "walk forward guarded/wide/leaning", "turn around slowly", "sit down slowly" → plain motions, summaries claim success; "walk a step then lie down" → endless reference walk. |
| SEAM-1-adjacent AI-SEAM-01 | **AI loop with travel**: body glide-snaps backward every cycle | −7.4 m/s, 12.9 cm/frame at the wrap; gate passes it. |
| AI-POSTURE-01 | **AI plan lying down mid-motion**: body pitches through the floor | feet −40 cm below ground; tool cannot express `groundingPosture`. |

### Severity B — latent / conditional

- **AI-GATE-01/02**: floating walks (0 cm vertical), flat-timed gaits pass the gate; a dozen phrasings ("tiptoe across", "take a few steps") never trigger it.
- **AI-TIME-01**: per-keyframe velocity floors flatten Perry proportions on fast AI gaits (should re-time whole-plan).
- **SEAM-7**: floor-margin cliffs — walk kf0 sits 1.3 ms above its governor floor; paced walks are ALREADY over it (speed 1.05 desyncs half-cycle sums by 3 ms); the whole run family sits AT the 150 ms floor. Any retune silently re-times ms-authored contacts/windows.
- **DET-LOCK-03**: guarding/sway exist only as live overlays — grading, recordings, and the screen give three different answers.
- **DET-RES-01**: paced walks acquire a built-in 3.2 % step-time limp from non-uniform floor bumps.
- **DET-GATE-01**: a wrist screen's single authored hand target strips relaxed hands from the whole body.
- **AI-REPAIR-01**: repair-retry grades only joint angles — none of the visible glitches ever trigger a repair.
- **SEAM-9**: motion-time trunk overlays leak into live recordings/streamed reports (±2.2°); eye-restore stale-base hazard.
- **DET-LOCK-04**: rail-clip loop trim ignores the recorded ready-settle (~950 ms of standing at clip head).
- Assorted hygiene: DET-INT-04..10, DET-RES-02 (plank ankle 40° authored vs 20° ROM), SEAM-10/11, DET-APP-01, AI-SUGAR-01, AI-ERR-01, AI-PROMPT-01.

### Verified healthy (keep the gates)

Chain seams 0.00°/≤2 mm on every probed pair; posture auto-bridging correct; loop wrap C1; rep boundaries
clean; ROM/target/velocity honesty for non-gait AI sloppiness; idle/eye overlay undo discipline consistent
at all 13 takeover points.

## Remediation plan

**R0 — hours (ship immediately):**
1. Stage passes `GAIT_VERTICAL_MAX_RISE_M` (DET-LOCK-01, one line) + a lockstep unit test.
2. Coerce non-finite durations to 0 (AI-ERR-01). 3. `\bcautious\w*` + `your|my` possessives (DET-INT-04/05).
4. Author plank ankle 20° (DET-RES-02). 5. "reps ignored (loop)" + hold-keyframe nits (AI-CLAMP-OK).

**R1 — the seam mechanics (days):**
1. Scale contacts with the same authored→trajectory factor as stance windows via ONE shared helper + a paced-slide gate (SEAM-2).
2. Blend IK→FK over ~100 ms at plant release (SEAM-3; also fixes the run's touchdown class).
3. Persistent heading: executor threads current body yaw into the gait builders; plant rest rotated by entry yaw (SEAM-1 — generalize the TUG chain's rebase helpers).
4. Pin-swap blends: stand-from-sit (SEAM-5), grounding ramp + SQUAD tangent clamp + eased hand-reach (SEAM-4).
5. Loop-handoff vcal blend + sampler loop-derived table (DET-LOCK-02).
6. Settle-unmentioned-drivers for `startFrom:'current'` motions (SEAM-6).

**R2 — interpreter honesty (days):**
Honor-or-refuse: every route applies the detectors it consumes (thread modifiers through run/hop/turn/posture/travel builders — the transforms all compose) or the word counts as unaccounted → AI. Clause-scoped side detection. Summary reads back builder-clamped values; veto notes ("shown in place"). Null-detector trigger words are unaccounted (AI-ROUTE-01).

**R3 — AI onto the deterministic machinery (the big one, ~week):**
1. Builder-anchored routing: gate-passed walk-shaped plans re-anchor on `buildTravelWalk`/template + `applyAsymmetry`/fault/lean transforms; "walk with a limp" routes deterministically (AI-ROUTE-02 — every piece already exists).
2. Resolve-time gait plumbing: a plan that LOOKS like gait (loop/planted/reciprocal) auto-receives calibrated vertical, contacts, coordination; loop+net-travel → treadmill or footDriven conversion (AI-SEAM-01).
3. Plan-shaped (not text-shaped) locomotion gate + planted/timing checks + qualifier-honoring fallback (AI-GATE-01/02/03).
4. Whole-plan re-timing for gait (AI-TIME-01); kinematic grading (slide/vertical/seam) drives repair-retry (AI-REPAIR-01); groundingPosture inference for posture keyframes (AI-POSTURE-01); travel-sugar absolute/delta fix (AI-SUGAR-01); prompt rewrite to "parameterize the reference machinery" (AI-PROMPT-01).

**R4 — hardening:**
Pace-aware durations + ≥10 ms floor-margin gate + windows from RESOLVED times (SEAM-7/DET-RES-01); fold guarding/sway into build-time keyframes (DET-LOCK-03, charter-aligned); per-side relaxedHands gate (DET-GATE-01); overlay tap ordering + eye restore guard (SEAM-9); rail-trim from trajectory start (DET-LOCK-04); variantCfg + currentAngles threading (DET-APP-01/SEAM-11); ready-reset tween + rootY check (SEAM-10); spline-velocity-cap gate (SEAM-8).
