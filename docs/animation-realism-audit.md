# Animation Realism Audit — pose-engine

**Date:** 2026-07-20 · **Auditors:** four specialist lenses — animation principles, locomotion, physicality, polish — all claims code-verified against the repo (file + line evidence throughout; key citations re-checked at synthesis time).

---

## Executive summary

pose-engine is an unusually disciplined piece of procedural character animation. Its core — SQUAD quaternion splines with a monotone PCHIP time-warp that brakes only at true stops (`src/services/motionTrajectory.ts` 103-177), velocity-class speed caps and duration floors (`src/services/motionSequence.ts` 79-83, 978), and a headless rig-verification culture that gates world-space excursions on a real skeleton (`src/__tests__/gaitTemplate.test.ts`, `spinalCoordination.test.ts`) — solves arcs, slow-in/slow-out, and cartoon-speed in one stroke. The walking gait deserves its reputation: Perry/Neumann-verified sagittal peaks, a layered arm carriage (scapular glide, wrist drag, pronation, counter-phased elbow pump), a calibrated ~5 cm pelvis vertical, rig-gated gaze stabilization (head yaw < 6° while the trunk counter-rotates beneath it), and C1 loop seams (`src/services/movementTemplates.ts` 261-399, 2088+; `src/services/rootMotion.ts` 493-556; `src/__tests__/motionTrajectoryLoop.test.ts`). This is professional-grade work.

The top five gaps, in priority order:

1. **The COM is measured every frame and ignored.** `src/services/centerOfMass.ts` computes Winter-grade COM, base-of-support hull, and margin of stability — and nothing consumes it. Single-leg stance, kick, and reach stand off-balance by the engine's own instrument (`balance.test.ts` 255-263 documents the negative margin), and no weight shift ever precedes a limb lift.
2. **The model freezes between commands.** The liveliness overlay is gated on active motion (`src/ExamStage3D.svelte` 2215), so the most-watched moment in a PT demo — the model at rest — is a statue. Cheapest large win in the audit.
3. **Playback is lockstep.** The trajectory player samples every bone at one shared time (`motionTrajectory.ts` 311-318); the working stagger mechanism (`src/services/motionStagger.ts`) is wired only into the simple tween path. No temporal follow-through anywhere in composed playback.
4. **Gait's residual tells:** no lateral pelvis shuttle over the stance foot, metronomic 200 ms phases, cross-fade initiation/termination instead of real first/last steps, no toe rocker, and the engine cannot turn.
5. **Dead extremities outside gait:** flat supinated paddle hands everywhere but the walk (`movementTemplates.ts` 2182-2188 is gait-gated), and eye bones shipped in the GLB but unmapped.

**The single most important architectural next step** — and it lands exactly on the user's flagged frontier — is `balanceCoordination`: a universal, author-time sibling of `spinalGaitCoordination` that samples each keyframe on the headless rig, reads `computeBalanceState`, and adds ROM-clamped counterlean/hip-shift/arm-counter targets. Every piece it needs already exists on disk; it stays fully inside the kinematic charter; and it is verifiable with the balance timeline machinery already in tests. The detailed phased proposal is below.

---

## Scorecard

| Area | Grade | Status | One-line assessment |
|---|---|---|---|
| **— Principles lens —** | | | |
| Arcs (SQUAD rotation splines) | A- | Strong | Genuine C1 spherical arcs on every bone (`motionTrajectory.ts` 103-132); only horizontal root translation is piecewise-linear. |
| Slow in / slow out | A- | Strong | PCHIP warp eases only at true stops, flies through interior knots (139-177); but one symmetric cubic shape serves every weight and effort. |
| Follow-through & overlapping action | B- | Partial | Trajectory sampler moves all bones at one shared u; the real stagger (`motionStagger.ts` 99-121) is wired only into the simple tween; drag is pose-space, not temporal; no mass-weighted lag. |
| Anticipation | B | Partial | Authored where a clinician wrote it (jump countermovement, kick wind-up, STS lean); reach and step-off start cold; no generic mechanism. |
| Secondary action | B+ | Strong | Rich in gait (scapula, wrist drag, finger curl, hip adduction); off-gait gets only two trunk bones of breathing/sway (`ExamStage3D.svelte` 2260-2277). |
| Timing | B- | Partial | Velocity caps + duration floors genuinely prevent cartoon speed; all 8 walk phases a metronomic 200 ms. |
| Exaggeration | A | Correctly withheld | Clinical fidelity is the right call; the one exaggeration (high-knee march) is scoped and labelled (`movementTemplates.ts` 216-217). |
| Staging & appeal | B | Partial | Competent user-driven camera (`clinicalCameraControls.ts`); nothing auto-stages a movement in its dominant plane. |
| Solid posing | B | Partial | Poses grounded, COM-over-base for planted folds; but mirror-symmetric and diagram-like — no contrapposto, inert contralateral side. |
| **— Locomotion lens —** | | | |
| Gait cycle fidelity | A- | Strong | 8-phase Perry/Neumann knee wave, hip range, ankle rockers, all rig-gated (`gaitTemplate.test.ts` 191-249); double-support timing only implicit. |
| Foot IK & grounding | B | Strong | CCD foot-plant with gated <3 cm slide budgets (`gaitTravel.test.ts` 131-150); best-in-class grounding for a procedural rig. |
| Toe / MTP articulation | D+ | Missing | `toeFlexion` plumbed and ROM-clamped (`romRegistry.ts` 253-261) but never driven by any template — no toe rocker; heel raise is en-pointe (a clinical defect). |
| Lateral COM shuttle (root X) | B- | Partial | Root owns only Z (travel) and Y (pin) — the pelvis never rides over the stance foot; the direct blocker of the balance frontier. |
| Gait initiation & termination | C+ | Partial | Entry is a 400 ms time-stretched cross-fade (`movementTemplates.ts` 933-943); travel walk ends mid-stride — no real first or last step. |
| Turns & steering | F | Missing | The engine cannot turn: no pivot template, no curved path, no heading parameter in `buildTravelWalk`; `RootOrient.yawDeg` exists unused. |
| Speed & pace coupling | B | Partial | stride×cadence = speed via √speed split, well gated; no walk↔run continuum; elbow pump amplitude speed-invariant. |
| Gaze stabilization | A- | Strong | Axial+lateral+roll neck counter, head yaw <6° rig-gated; open-loop, and no pitch channel — no heel-strike head nod. |
| Run & airborne quality | B- | Partial | True flight with gravity parabola, but no landing absorption, no contacts, no travel variant — the run gets less polish than the walk. |
| Cross-command seams & momentum | C+ | Partial | Positional continuity gated (<3° pose, <0.05 m root, `movementChain.test.ts`); every seam brakes to zero — momentum never carries. |
| Loop seams & in-place/travel parity | A | Strong | C1 periodic wrap, rig-gated, never re-enters standing; shared `spinalGaitCoordination` keeps both paths from drifting. |
| **— Physicality lens —** | | | |
| Ballistic flight | A- | Strong | Constant-g parabola, airtime = 2√(2h/g), emergent hang time (`motionTrajectory.ts` 255-305) — director-grade. |
| Grounded weight & descents | C | Partial | Squat/sit/get-down ease symmetrically into stops via floor-pin over a SQUAD pose — hydraulic, not bodyweight; g exists only when airborne. |
| COM / balance instrumentation | A- | Strong (inert) | Winter inertials, BoS hull, signed margin of stability computed every frame (`centerOfMass.ts` 45-393); consumed by nothing that moves the body. |
| Counterbalance in open-chain poses | D | Missing | Single-leg, kick, and reach author no trunk/pelvis shift over the stance foot; reach leans COM *further out*. |
| Anticipatory postural adjustments | D- | Missing | No motion pre-loads the base of support; weight shift never precedes a limb lift anywhere. |
| Impact & contact response | C | Partial | Weight *acceptance* authored (loading-response knee yield, jump absorb); the impact *instant* is silent — no transient, infinitely rigid floor. |
| Effort & exertion cues | F | Missing | A maximal jump and a light reach differ only in amplitude — no bracing, tempo asymmetry, or breath response. |
| Balance-recovery vocabulary | F | Missing | No ankle/hip/stepping strategies — a core PT-education omission. |
| Postural sway plausibility | C+ | Partial | Rest sway is lumbar angle-noise above a dead-still pelvis, not an ankle-pivot inverted pendulum. |
| **— Polish lens —** | | | |
| Idle & moving holds | D | Missing | Overlays lift on completion (`ExamStage3D.svelte` 2010-2013, 2215); the model turns to stone between commands — `liveliness.ts`'s own header promises otherwise. |
| Hands, fingers & wrists | C- | Partial | Relaxed hands exist only inside gait's coordination gate; one flat 32° curl on all five digits; reach/STS/kick perform with paddles; planted-hand wrist work is genuinely good. |
| Eyes & face | D | Missing | Eye/jaw bones shipped in the runtime GLB but absent from `CC_BONE_NAME_MAP` — frozen in-socket; blink morphs stripped at export. |
| Breathing | B- | Partial | Clean overlay that survives gait via premultiply ordering; context-blind — identical 15 bpm at rest and mid-run. |
| Healthy asymmetry | C+ | Partial | Global cadence drift is good; the default gait is a perfect L/R mirror — no 2-4% bilateral signature of a healthy human. |
| Settle & overshoot | B- | Partial | Every motion ends servo-perfect at setpoint; ballistic endings (kick recovery) arrest with zero oscillation — limbs read massless at the stop. |
| Repetition & distal texture | B- | Partial | Timing texture solved (±2.4% cadence drift, wall-clock overlays); spatial amplitude byte-identical every cycle; distal constants don't scale with speed. |

---

## What is working (keep doing this)

- **The trajectory core.** SQUAD splines + monotone PCHIP with stop-only braking (`src/services/motionTrajectory.ts` 103-177) is the single design decision doing the most realism work in the engine: arcs, eased stops, and fly-through continuity all come from it. `cyclicEnds` (392-434) keeping gait entry/exit as fly-throughs so cadence never brakes at the wrap is exactly right.
- **The walk itself.** Rig-verified Perry/Neumann sagittal peaks, the 5→18→8→5→40→60 knee shock-absorption wave, ankle rockers, and an arm carriage (scapular glide, pronation, wrist drag, counter-phased elbow pump, relaxed finger curl, swing-hip adduction) far beyond typical procedural walks (`src/services/movementTemplates.ts` 261-399, 2042-2199).
- **Gaze stabilization.** The neck counter cancels exactly what the head inherits, including roll leaked by the axial counter (`movementTemplates.ts` 2135-2150), gated on the rig at head yaw <6° while pelvis and thorax verifiably counter-rotate (`spinalCoordination.test.ts` 249-289). The bands are bands, not zeros — residual life survives.
- **Grounding.** Foot-plant CCD IK with gated slide budgets (`footContact.ts` 63-114; `gaitTravel.test.ts` 131-150), foot-driven travel with the stance foot world-fixed by construction, and the mean-preserving vertical calibration with an over-reach clamp (`rootMotion.ts` 493-556, 599-634).
- **Ballistic honesty.** Airtime from 2√(2h/g), constant-g flight parabolas, jump countermovement and reach-then-absorb landing (`movementTemplates.ts` 1023-1026, 1056-1071; `motionTrajectory.ts` 255-305).
- **Loop seams.** C1-continuous periodic wraps, regression-gated with step-size bounds and a never-re-enters-standing assertion (`motionTrajectoryLoop.test.ts` 99-165). A solved problem — keep the gate in CI.
- **The verification culture.** Headless rig tests that measure world-space excursions are the reason this audit could be this specific. Every fix below should ship with one.
- **Measurement discipline.** ROM clamping through the same truth path as single commands (`motionSequence.ts` 825-846), exaggeration deliberately withheld, determinism enshrined in `balance.test.ts` 246-264. This is the correct identity for a clinical tool — the fixes below all preserve it.
- **The transform pattern.** `spinalGaitCoordination` — pure, additive, ROM-clamped, per-keyframe, rig-derived — is the house pattern that makes everything else on this list buildable. It is the template for the physics frontier.

---

## Gap analysis

### 1. The COM that measures and never acts (the user's frontier)

**Why it reads unnatural:** the model computes its own imbalance every frame and ignores it. Single-leg stance and kick lift a limb with zero shift over the stance foot; the reach leans the trunk *with* the arm, carrying COM further outside the base (`movementTemplates.ts` 488-513, 776-844) — `balance.test.ts` 255-263 documents the negative margin and leaves it. No weight shift ever precedes a limb lift (real APAs lead by 200-400 ms), gait has no medio-lateral pelvis shuttle (`rootMotion.ts` 562-566 — the travel interface owns only Z), rest sway wobbles the lumbar spine above a dead pelvis instead of pivoting at the ankles (`ExamStage3D.svelte` 2268-2276), and there is no ankle/hip/stepping recovery vocabulary at all (grep-confirmed absent) despite its centrality to PT education.

**Fix direction:** the full phased proposal in the next section. The locomotion arm of the same fix — a phase-locked ±3-4 cm lateral root shuttle derived the same way `footDrivenTravel` derives Z — has strong plumbing precedent (a static root-X channel already exists via the antalgic `pelvisShiftCm` overlay, `motionPrescription.ts` 62-67).

### 2. Lockstep playback: overlap is spatial, never temporal

**Why it reads unnatural:** distal segments arrive at their targets at the same instant as proximal ones, so nothing whips, drags, or settles. The trajectory player evaluates every bone at one shared u (`motionTrajectory.ts` 311-318); the working proximal-to-distal stagger (`motionStagger.ts` 99-121, correct and tested) is wired only into the simple pose tween (`ExamStage3D.svelte` 1212) that gait/jump/squat/reach never use — note `motionStagger.ts` 19-21's doc comment claiming otherwise is stale. The walk's wrist drag and elbow pump are authored pose relationships, not temporal lag; a handful of templates carry authored `peakAt` leads (squat ankle 0.8, hinge 0.8, kick knee-whip 0.75 — craftsmanship standing in for a missing engine feature). Every motion also terminates servo-perfect at setpoint (`motionTrajectory.ts` 224-236), so fast endings read massless.

**Fix direction:** warp each bone's u by chain rank in `stepTrajectory` — delay the *sample time*, not the pose, exactly as `stagedBlendWithBaseline` does; because u(t_k)=k, the settle contract holds. Then mass-weight the delay using the Winter segment fractions already on disk (`centerOfMass.ts` 45-60). For ballistic/functional endings, auto-insert a fly-through pre-settle knot at target +~3% of inbound travel ~120 ms before the stop — one more interior knot, zero trajectory-machinery changes, byte-exact final pose.

### 3. Life stops when the motion stops

**Why it reads unnatural:** in a command-driven app the model spends most wall-clock time idle, and at idle everything is gated off — the overlay block requires an active motion (`ExamStage3D.svelte` 2215), so no breathing, no sway, and the render dirty-flag never fires. The dominant impression is the statue. Compounding it: hands outside gait are flat supinated anatomical-position paddles (the relaxed curl lives inside gait's `has(shoulderFlexion)` gate, `movementTemplates.ts` 2174-2189), the shipped eye bones are unmapped (`bodyVariants.ts` has no Eye entry; verified present in the GLB), liveliness touches only two trunk bones, and resting posing is perfectly mirror-symmetric.

**Fix direction:** un-gate the overlay so breath + micro-sway run whenever the model is visible (the functions are pure; clean mode still zeroes them) and add a randomized 4-8 s idle weight shift using the existing pelvis-shift actuator. Ship a universal `relaxedHands()` transform (graded per-digit curl, thumb differentiated, semi-pronation) applied in `resolveComposedMotion` to any motion that doesn't author the hand — the proven `stabilizeGaze` pattern (`motionSequence.ts` 766+). Map the eye bones (two-line `CC_BONE_NAME_MAP` addition) and let a small live-only controller absorb the <6° head residual as eye counter-rotation plus Poisson saccades.

### 4. Gait's residual tells

**Why it reads unnatural:** four small things keep the flagship from fully selling weight. (a) All 8 phases are exactly 200 ms (`movementTemplates.ts` 272-384) — real gait is ~60:40 stance:swing with a brisk loading response, and the equal slices flatten the rhythm. (b) No toe rocker: `toeFlexion` is never driven (grep: zero hits in templates), so push-off pivots a rigid flat foot about the ankle — and the heel-raise is en-pointe, an actual clinical-content error (`movementTemplates.ts` 515-542). Note the corrected sign: MTP extension is *positive* (+25..40). (c) Initiation/termination are cross-fades, not steps — no unweighting shift in, no plant-and-level out. (d) The engine cannot turn, and the run lacks the walk's grounding (no absorption keyframe, no contacts, no travel variant, `movementTemplates.ts` 1126-1171).

**Fix direction:** re-time the phase durations to Perry fractions (a values edit gated by the existing test); add toe extension at terminal stance/heel-raise/jump propulsion on the already-plumbed DOF; author a real initiation keyframe (APA shift, pelvis leads) and a braking terminal step; add a heading parameter + a 2-4-step pivot template on the existing `yawDeg` primitive; give the run a touchdown absorption sub-phase and a `buildTravelRun` reusing the walk's machinery.

### 5. Weight in grounded motion

**Why it reads unnatural:** gravity exists only when airborne. Grounded descents (squat, sit, get-down) ease symmetrically into a stop — a controlled hydraulic lower, not bodyweight caught (`motionTrajectory.ts` 139-176 forces the symmetric ease; `ballistic()` is airborne-gated at 296-305). Heel-strike carries no impact transient — the emergent double-support dip exists but is deliberately smoothed into a glide (`rootMotion.ts` 489-491, 517-527) — and contact firmness is an infinitely rigid pin. Effort is invisible: no bracing, breath, or tempo asymmetry distinguishes heavy from light (grep-confirmed absent).

**Fix direction:** opt-in gravity-shaped descent reshape for weighted lowers (fast-late quarter-parabola arrested by the existing floor-pin — root/parameter-only, goniometry untouched); a phase-shaped footfall transient added *on top of* the smoothed vertical arc (the smoothing was itself a fix — do not reduce it), amplitude driven by pre-contact vertical velocity; exertion-coupled breathing and a minimal effort scalar as later polish.

### 6. Naturalism is gait-bespoke, not general

**Why it reads unnatural:** the recurring pattern across all four lenses — secondary action, relaxed hands, cadence texture, coordination — was built beautifully *for gait* and never generalized. Off-gait motions get two trunk bones of life and nothing else. The fix direction is always the same and is the engine's own invention: pure, additive, ROM-clamped, per-keyframe transforms in the `spinalGaitCoordination` / `stabilizeGaze` family, rig-gated, zeroed in clean mode.

---

## The physics frontier: COM-driven postural control

The user's flagged next step. The design constraint is the kinematic charter — no forces, no live feedback controller (determinism is enshrined in `balance.test.ts` 246-264 for good reason). The insight that makes this tractable: **balance does not need simulation, it needs the measurement the engine already makes to be consulted at author time.** Every ingredient exists on disk: `buildSequencePoses`, `computeBalanceState` (returns `comGround` and `base.center`), `computeBalanceTimeline`, the additive-target merge (`movementTemplates.ts` 2205-2211), and `expandPeakTiming`.

### Phase A — universal `balanceCoordination` transform

A sibling of `spinalGaitCoordination`. For each keyframe: (1) sample the resolved pose on the headless rig; (2) compute `offset = comGround − base.center` via `computeBalanceState`; (3) **add** ROM-clamped re-centering targets — root `translateM` hip-shift toward the base centroid, `Spine_Lower/Upper` lateralTilt + flexion counterlean, and an arm/contralateral-limb counter — using the exact additive merge the gait coordinator already uses. First consumers: single-leg-stance (lateral pelvis shift + contralateral lean), kick (stance-side lean + arm counter-swing), endpoint-reach (rearward hip shift offsetting the forward lean). The gait ML shuttle (gap 1) is the locomotion expression of the same idea.

*Charter:* runs at build/resolve time; output is ordinary keyframe targets through the same ROM clamp; live playback stays deterministic and the measure-only HUD guarantee is untouched — no hidden state ever comes back.
*Rig verification:* `computeBalanceTimeline` over the transformed motions asserts `minMarginM` crosses from negative to > 0.02; existing determinism and coordination-subtlety gates stay green.

### Phase B — anticipatory postural adjustments

Weight shift *precedes* action. Insert a short lead sub-keyframe (or reuse the `peakAt`/`expandPeakTiming` machinery) so the Phase A hip-shift completes ~200-400 ms before the limb-lift keyframe. Apply to single-leg lift, kick wind-up (pelvis loads the stance leg before the leg cocks), and gait initiation (a real unweighting shift toward the future swing foot replacing the current 400 ms time-stretch, `movementTemplates.ts` 933-943).

*Charter:* still purely authored keyframes on the existing trajectory; nothing reactive.
*Rig verification:* a temporal-order gate — the COM-X shift toward the stance foot measurably precedes the swing foot leaving the floor; seam gates in `movementChain` stay green.

### Phase C — gravity-consistent descents, mass-proportional settle, balance-strategy vocabulary

(1) **Gravity-shaped lowers:** opt-in per-segment descent reshape (g-accelerating profile arrested by the floor-pin) for sit-down, drop-squat, get-downs — gated to explicitly "weighted" motions so slow clinical squats stay controlled. (2) **Mass-proportional settle:** the trajectory-sampler stagger from gap 2, delay-weighted by the Winter mass fractions in `centerOfMass.ts`, so a loaded thigh trails more than a hand. (3) **Balance-strategy library — the PT payoff:** authored ankle strategy (COM re-centering via ankle plantar/dorsiflexion, rigid trunk), hip strategy (rapid trunk/pelvis counter-flexion), and stepping strategy (a quick protective step reusing the travel-walk machinery), parameterized by a *scripted* perturbation keyframe so determinism holds. These are core clinical teaching content, not decoration.

*Charter:* kinematic reshapes, authored templates, deterministic scripted triggers — no dynamics anywhere.
*Rig verification:* monotone-increasing descent speed until the settle (vs. today's symmetric ease); wrist-after-shoulder mass-scaled delay still arriving exactly on-target at local==1; `computeBalanceTimeline` margin dips negative on the perturbation frame and recovers positive with the correct per-strategy joint signature.

---

## Prioritized roadmap

P0 = highest visual payoff per unit effort. Effort: S < 1 day-ish, M = days, L = week+.

| P | Item | Effort | Flagged by | Expected visual payoff |
|---|---|---|---|---|
| P0 | Un-gate liveliness at idle + slow idle weight shift (`ExamStage3D.svelte` 2215) | S | polish, principles | The model never freezes — fixes the dominant impression of the whole app. |
| P0 | Authored counterbalance in single-leg / kick / reach | S | physicality | Model stops standing off-balance by its own measure; gated via `minMarginM`. |
| P0 | Phase A `balanceCoordination` universal transform | M | physicality | COM-over-base everywhere; the architectural unlock for the frontier. |
| P1 | Wire proximal→distal stagger into `stepTrajectory` | M | principles, locomotion, physicality | True follow-through in every composed motion — the single biggest naturalism lever after balance. |
| P1 | Lateral ML root shuttle in gait (`rootMotion` pattern) | M | locomotion, physicality | Visible weight transfer each step; the walk's last big missing cue. |
| P1 | Real gait initiation + termination steps | M | locomotion, physicality | Walks start and stop like a person, not a cross-fade. |
| P1 | Universal `relaxedHands()` transform | S | polish | Kills the paddle hands in every non-gait motion at once. |
| P1 | Toe rocker + heel-raise MTP fix (positive `toeFlexion`) | S | locomotion, polish | Push-off reads; fixes a clinical-content defect in the heel raise. |
| P1 | Phase B anticipatory postural adjustments (peakAt leads) | M | physicality, principles | Movement starts from the pelvis, not the limb — the signature of real postural control. |
| P1 | Balance-recovery strategy library (ankle/hip/stepping) | M | physicality | PT-core teaching content the engine currently cannot show. |
| P1 | Gravity-shaped grounded descents | M | physicality | Sits and drops read as bodyweight caught, not hydraulics. |
| P2 | Re-time walk phases to Perry fractions (values edit) | S | principles, locomotion | Cadence stops sounding metronomic at the sub-stride level. |
| P2 | Heel-strike transient on the calibrated vertical | M | physicality, principles, polish | Footfalls become impacts; adds weight to every step. |
| P2 | Turn-in-place template + travel heading parameter | M | locomotion | Unblocks "walk and turn", pivots, figure-of-eight assessments. |
| P2 | Run grounding parity (absorption sub-phase + travel run) | M | locomotion | Run stops reading as "walk-shaped at higher amplitude". |
| P2 | Momentum-preserving flowing seams (opt-in fly-through first knot) | M | locomotion | Walk-into-squat/kick chains flow instead of settling first. |
| P2 | Eye bone map + micro gaze controller | S | polish | Ends the taxidermy read at tutorial camera distances. |
| P2 | Exertion-scaled breathing + STS arm strategy + bird-dog wrist release | S | polish | Three small physiological tells a PT audience notices. |
| P2 | Per-velocity-class ease/settle shape; anticipation flag for functional moves; generalized off-gait secondary action; ankle-pivot idle sway | S-M | principles, physicality | Weight-differentiated stops; wind-up on reaches; life beyond the trunk. |
| P3 | Terminal overshoot pre-settle knot (ballistic/functional ends) | S | polish, principles | Fast endings sell mass; byte-exact final pose preserved. |
| P3 | `healthySignature()` bilateral asymmetry + per-cycle amplitude drift | S | polish | Breaks the mirror and the spatial metronome on long observation. |
| P3 | Distal constants scale with speed (finger curl, run elbow, headStabilize) | S | polish | Run gains distal energy for free off existing drivers. |
| P3 | Per-template preferred camera plane; double-support duration gate; walk↔run routing threshold; neck pitch counter; root XZ spline (if curved travel arrives) | S each | principles, locomotion | Teaching clarity and regression armor. |

---

## Appendix: per-lens verified findings

### Principles lens

| Principle | Grade | Status | Gap (one line) |
|---|---|---|---|
| Arcs | A- | strong | Horizontal root translation is piecewise-linear; invisible until curved travel exists. |
| Slow in / slow out | A- | strong | One symmetric cubic ease shape for every weight/effort class. |
| Follow-through & overlap | B- | partial | Trajectory sampler is lockstep; stagger unwired from composed playback; authored `peakAt` leads exist in squat/hinge/kick only. |
| Anticipation | B | partial | Present only where hand-authored (jump/kick/STS); no generic mechanism; reach starts cold. |
| Secondary action | B+ | strong | Excellent in gait, bespoke to gait; off-gait gets 2-bone trunk overlay only. |
| Timing | B- | partial | Velocity caps/floors strong; 8×200 ms metronomic walk phases; cadence drift is global, not intra-cycle. |
| Moving holds | B- | partial | Holds inside motions live; between-command idle is a dead freeze (merged with polish idle finding). |
| Exaggeration | A | n/a | Correctly withheld for a clinical product; one scoped exception. |
| Squash & stretch analogs | B- | partial | Jump landing compresses; gait/run heel-strike lacks the impact transient (dip exists but is deliberately smoothed). |
| Straight-ahead texture | B+ | strong | Right architecture + wall-clock compensation, but texture is trunk-only; limbs are glassy under close camera. |
| Staging & appeal | B | partial | No per-movement dominant-plane framing; camera presets live in the PainBody3D viewer, not the exam stage. |
| Solid posing | B | partial | Grounded but mirror-symmetric, diagram-like; inert contralateral side in single-limb screens. |

### Locomotion lens

| Principle | Grade | Status | Gap (one line) |
|---|---|---|---|
| Gait cycle fidelity | A- | strong | Double-support duration implicit, ungated; uniform phase slices. |
| Foot IK & grounding | B | partial | Toe/MTP never driven — no third rocker (extension is *positive* `toeFlexion`). |
| Root motion quality | B- | partial | No lateral (X) COM shuttle; only Z travel + Y pin (static antalgic X shift exists as precedent). |
| Initiation & termination | C+ | partial | Time-stretched cross-fades, not real first/last steps. |
| Turns & steering | F | missing | No turn capability anywhere; `yawDeg` primitive unused for heading. |
| Speed & blending | B | partial | No walk↔run continuum; elbow pump not pace-scaled. |
| Gaze stabilization | A- | strong | Open-loop; no pitch/vertical channel. |
| Arm swing | B+ | partial | Overlap is spatial (authored counter-phase), not temporal lag. |
| Run & airborne | B- | partial | No landing absorption, no contacts, no travel variant. |
| Locomotion↔action seams | C+ | partial | Positional continuity only; momentum never carries across the ready-settle. |
| In-place vs travel parity | A- | strong | Shared coordination + calibrated vertical; deliberate yaw parity. |
| Loop seam quality | A | strong | Solved and regression-gated; keep in CI. |

### Physicality lens

| Principle | Grade | Status | Gap (one line) |
|---|---|---|---|
| Overall sense of weight | C+ | partial | Weight exists only in flight; grounded motion is floaty by construction. |
| COM/balance infrastructure | A- | strong | High quality, strictly inert — no consumer alters the pose. |
| Open-chain counterbalance | D | missing | Single-leg/kick/reach stand off-balance; negative margin documented and uncorrected. |
| Anticipatory postural adjustments | D- | missing | No weight shift precedes any limb action anywhere. |
| Gravity in lowering | C | partial | Descents decelerate into bottoms; the opposite of a gravity-driven lower. |
| Momentum & mass timing | D | missing | No inertia in timing; the one lag model is topological and unwired. |
| Effort & exertion cues | F | missing | Heavy and light indistinguishable except amplitude. |
| Impact & contact response | C | partial | Yield authored, impact instant silent; floor infinitely rigid. |
| Balance-recovery vocabulary | F | missing | No ankle/hip/stepping strategies despite PT centrality. |
| Postural sway at rest | C+ | partial | Lumbar noise, not an ankle-pivot inverted pendulum. |

### Polish lens

| Principle | Grade | Status | Gap (one line) |
|---|---|---|---|
| Hands & fingers | C- | partial | Relaxed hands gait-only; flat 32° curl on all digits incl. thumb; paddles elsewhere. |
| Wrists beyond gait | C+ | partial | Planted-hand work good; reach never orients the hand; STS has no arm strategy; bird-dog carries the floor wrist mid-air. |
| Head & face | D | missing | Eye/jaw bones shipped but unmapped; blink morphs stripped at export (the one true ceiling). |
| Breathing | B- | partial | Survives gait; context-blind 15 bpm at all exertion levels. |
| Idle & moving holds | D | missing | All overlays gated off at idle; a commandable idle clip exists but nothing auto-plays it. |
| Healthy asymmetry | C+ | partial | Perfect L/R mirror by default; only a global clock warp varies. |
| Toes | D+ | missing | Fully plumbed DOF, zero template hits; heel-raise en-pointe is a clinical defect. |
| Settle & overshoot | B- | partial | Deliberate servo-stops; ballistic ends would sell mass with ~3% overshoot. |
| Cloth / soft tissue | C | n/a | Correctly out of scope; only a breath-phase ribcage pulse ever worth adding. |
| Texture of repetition | B- | partial | Timing texture solved; spatial amplitude byte-identical every cycle/rep. |
| Micro gaze band | B+ | strong | Natural residual band, not gimbal-locked; missing heel-strike pitch dip. |
| Distal energy at speed | B- | partial | Derived gains scale free; the constants (finger curl, run elbow, headStabilize) don't. |