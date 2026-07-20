# Movement Realism — Improvement Roadmap

**Source:** `docs/animation-realism-audit.md` (4-lens, code-verified, 2026-07-20) plus engineering additions.
**Status:** living document — waves are shipped in order; each item lands only with a rig gate.

## Operating principles (unchanged, non-negotiable)

1. **Kinematic charter.** No forces, GRF, torque, or live balance controller. Physics is *mimicked* at
   author/build time; playback stays deterministic. The COM instrument is consulted, never fed back live.
2. **The house pattern.** New naturalism ships as pure, additive, ROM-clamped, per-keyframe transforms in
   the `spinalGaitCoordination` / `stabilizeGaze` family — zeroed in clean mode, invisible to grading.
3. **Rig-gate everything.** Every item lands with a headless-rig regression test measuring world-space
   behaviour (the reason the audit could be specific). No gate, no merge.
4. **Ship pipeline per wave.** Engine PR → squash-merge → simMOVE submodule bump → simMOVE PR →
   squash-merge → Azure deploy confirmed green.
5. **App parity.** Any new movement vocabulary (turns, balance strategies, TUG) also gets: deterministic
   interpreter routing in simMOVE (`templateInterpreter.ts`) and, where appropriate, AI exposure on
   `compose_motion`.

---

## Wave 1 — Life & grounding (P0s + safe P1s) — *in flight*

Highest visual payoff per unit effort; four independent file groups, swarm-parallelizable.

| # | Item | Files | Spec | Gate |
|---|---|---|---|---|
| 1.1 | **Un-gate liveliness at idle** + slow idle weight shift | `ExamStage3D.svelte`, `liveliness.ts` | Breathing + micro-sway run whenever the model is visible (not only during motion); add a randomized 4–8 s idle weight-shift cycle on the existing pelvis-shift actuator; clean mode still zeroes all of it; render loop stays dirty while idling. | Pure phase functions unit-tested; svelte-check; existing liveliness tests green. |
| 1.2 | **Authored counterbalance** in single-leg / kick / reach | `movementTemplates.ts` | Trunk lean + hip shift over the stance foot, contralateral arm counter — the poses stop standing off-balance by the engine's own margin-of-stability measure. | `computeBalanceTimeline` margin improves vs. baseline (the audit-documented negative margin flips); all template signature gates stay green. |
| 1.3 | **Universal `relaxedHands()`** | `motionSequence.ts` | `stabilizeGaze`-pattern transform in `resolveComposedMotion`: any motion not authoring hand/finger targets gets graded per-digit curl (thumb differentiated) + neutral wrist; skipped for planted-hand postures (push-up, quadruped, plank) and any motion that drives those joints. | Presence on squat/reach; absence on push-up; gait byte-identical (its coordination already owns the hands). |
| 1.4 | **Toe rocker + heel-raise MTP fix** | `movementTemplates.ts` | Drive `toeFlexion` (MTP extension = positive): walk terminal-stance/pre-swing push-off ~25–30°, heel-raise ~40° (fixes the en-pointe clinical defect), jump propulsion. | Rig-measured MTP extension at push-off; stance-foot slide budgets still green; heel-raise template gate updated. |

## Wave 2 — The two big levers

The architectural items; each gets focused, single-threaded attention.

| # | Item | Spec | Gate |
|---|---|---|---|
| 2.1 | **`balanceCoordination` (audit Phase A)** | Universal author-time transform: sample each keyframe on the headless rig (`buildSequencePoses` + `computeBalanceState`), compute COM-vs-base-centroid offset, ADD ROM-clamped re-centering targets (hip shift, spine counterlean, arm counter) via the existing additive merge. Pre-pass pattern mirrors vertical-calibration derivation (sampler + stage in lockstep). First consumers: single-leg stance, kick, endpoint-reach (supersedes/refines 1.2's hand-authored values). | `minMarginM` > 0.02 across consumers; determinism gate; coordination-subtlety gates green. |
| 2.2 | **Trajectory follow-through** (proximal→distal stagger in `stepTrajectory`) | Warp each bone's sample time by chain rank (the existing `chainOnsetDelay`), mass-weighted by the Winter segment fractions in `centerOfMass.ts` — distal segments trail proximal through every reversal. Settle contract holds (u(t_k)=k). Sampler + live stage share the path. | New rig gate: wrist reversal lags shoulder reversal by a measurable Δt; final poses byte-exact; foot-plant slide budgets green (feet are distal — verify the lag does not fight IK; exempt planted chains). |
| 2.3 | **Terminal pre-settle overshoot knot** (small, same area) | For ballistic/functional endings, auto-insert a fly-through knot at target +~3 % of inbound travel ~120 ms before the stop. | Final pose byte-exact; overshoot measurable on kick recovery. |

## Wave 3 — Balance frontier (audit Phases B & C)

| # | Item | Spec | Gate |
|---|---|---|---|
| 3.1 | **Anticipatory postural adjustments** | Weight shift *precedes* limb lift by 200–400 ms via `peakAt` leads / a lead sub-keyframe: single-leg lift, kick wind-up, and a **real gait-initiation step** (unweighting shift toward the future swing foot replacing the 400 ms time-stretch). | Temporal-order rig gate: COM-X shift precedes swing-foot lift-off; seam gates green. |
| 3.2 | **ML root shuttle in gait** | Phase-locked ±3–4 cm lateral (X) root motion over the stance foot, derived like `footDrivenTravel` derives Z (the antalgic `pelvisShiftCm` static channel is the plumbing precedent). | Rig: pelvis X oscillates in phase with stance; slide budgets green; head stays steady (lateral gates). |
| 3.3 | **Gravity-shaped grounded descents** | Opt-in reshape for weighted lowers (sit-down, drop-squat, get-downs): g-accelerating quarter-parabola arrested by the floor-pin; slow clinical squats stay controlled (opt-in only). | Monotone-increasing descent speed until settle; grounding/measurement untouched. |
| 3.4 | **Balance-strategy library** (ankle / hip / stepping) | Authored, deterministic, scripted-perturbation templates — core PT teaching content: ankle strategy (COM re-centering via ankle, rigid trunk), hip strategy (rapid trunk counter-flexion), stepping strategy (protective step reusing travel-walk machinery). Interpreter routing: "show an ankle strategy", "balance recovery". | Margin dips negative on the perturbation frame, recovers positive with the correct per-strategy joint signature. |
| 3.5 | **Real gait termination** | Braking final step, feet-together level-out (the walk stops like a person, not mid-stride). | Rig: terminal double-support with feet level + COM settling inside the base. |

## Wave 4 — Locomotion completeness

| # | Item | Spec |
|---|---|---|
| 4.1 | **Turns**: turn-in-place template (2–4 step pivot on the unused `yawDeg` primitive) + heading parameter on `buildTravelWalk`; interpreter routing ("turn around", "turn left"). |
| 4.2 | **Perry phase re-timing** — walk phases to ~60:40 stance:swing fractions (values edit; cadence gate updated). |
| 4.3 | **Run grounding parity** — touchdown absorption sub-phase, foot contacts, `buildTravelRun`; the run gets the walk's polish. |
| 4.4 | **Momentum-preserving seams** — opt-in fly-through first knot so walk→squat/kick chains flow without settling first. |
| 4.5 | **Walk↔run routing threshold** — speed request continuum in the interpreter. |
| 4.6 | **Heel-strike transient** — phase-shaped footfall accent on top of the calibrated vertical (do not reduce the smoothing), amplitude from pre-contact vertical velocity. |

## Wave 5 — Expression & texture

| # | Item | Spec |
|---|---|---|
| 5.1 | Eye-bone mapping (`CC_BONE_NAME_MAP`) + live-only micro-gaze (eye counter-rotation absorbs the head residual; Poisson saccades). |
| 5.2 | Exertion-scaled breathing (rate/amplitude follow recent work intensity) + breath-hold on max effort. |
| 5.3 | `healthySignature()` — default 2–4 % bilateral timing/amplitude asymmetry + per-cycle amplitude drift (breaks the mirror and the spatial metronome). |
| 5.4 | Distal constants scale with speed (finger curl, elbow pump, headStabilize at run). |
| 5.5 | Per-velocity-class ease/settle shapes (weighted stops differ from light ones). |
| 5.6 | Small clinical tells: STS arm strategy (push off thighs), bird-dog wrist release, ankle-pivot idle sway. |

## Wave 6 — Clinical capstones (additions beyond the audit)

| # | Item | Spec |
|---|---|---|
| 6.1 | **Timed Up and Go (TUG)** — the flagship chain: sit → stand → walk 3 m → turn → walk back → sit. Exercises the posture graph, travel, turns (4.1), initiation/termination (3.1/3.5) end-to-end. Interpreter: "run a TUG". |
| 6.2 | **Figure-of-eight / curved walking** — root XZ spline + heading interpolation (needs 4.1). |
| 6.3 | **Perturbation-response demos** — scripted balance-strategy showcases for teaching (needs 3.4). |
| 6.4 | **AI exposure pass** — `compose_motion` gains balance-strategy, turn, and heading vocabulary; docs for AI authors. |
| 6.5 | **Regression armor pass** — double-support duration gate, neck pitch channel decision, per-template preferred camera plane. |

---

## Sequencing rationale

- Wave 1 first: maximum visible payoff, minimum risk, fully parallelizable (disjoint file groups).
- Wave 2 next: `balanceCoordination` and trajectory follow-through are the two levers everything later
  builds on (3.1 needs 2.1; 3.4 reads better with 2.2's mass-weighted settle).
- Waves 3–4 alternate balance and locomotion so the flagship walk and the balance frontier advance together.
- Waves 5–6 are polish and clinical payoff once the structure exists.
