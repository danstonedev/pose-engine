# Movement realism — orientation brief

**Audience:** an engineer about to spend real effort making these movements look more real, who
wants all the levers before touching anything.
**Scope:** `/home/user/pose-engine` (consumed by `/home/user/simmove`). Orientation only — no
roadmap, no proposals.
**Verified against:** working tree at `f3fdf82` ("Walk at a normative cadence, and drive the wrist
from arm velocity"). Full suite green at time of writing: **106 files / 1179 tests**.

**Provenance — read before trusting a number.** This brief is the synthesis of a parallel
code-reading sweep (8 subsystem maps, 582 catalogued levers, 145 candidate gaps). Its lever tables
carry `file:line` citations and are reliable as a map. Its *measurements* are a mix: the
spatiotemporal figures in the correction notice below and in §3.1/R1 were re-measured directly and
are now gated in `gaitSpatiotemporal.test.ts`; other numeric claims came from individual sweep
agents and were NOT all independently reproduced. The sweep's own first-draft headline finding was
wrong (see the correction notice), so treat an uncited number here as a lead to verify, not a
fact — and prefer §3.2's explicit verified/unverified split.

---

## READ THIS FIRST — the prior docs are stale, and this brief's own first draft got the
## replacement numbers wrong

`HEAD` retimed the walk and added a per-velocity-class duration floor. Every prior audit in
`docs/` describes a walk at **65.5 steps/min** with a **1600 ms** cycle. That is no longer the code.

**Correction notice.** The first draft of this section reported that the retime had traded an
under-speed problem for a **58% step-length growth** and an out-of-band walk ratio. That was
wrong, and the error is instructive enough to keep on the record: it compared a *newly measured*
step length against a **retracted** baseline (0.545 m) that had itself come from a mis-windowed
probe. Re-measured on the same rig at `HEAD~1` and `HEAD` with one probe, step length is
**unchanged** — 0.9165 m before, 0.9123 m after (peak A-P ankle separation, whole clip). The
authored hip/knee excursion did not change and neither did the emergent step; only cadence moved.

The corrected picture, measured over the **steady cycle** on the male runtime rig
(`buildTravelWalk()`, 120 Hz, gated in `gaitSpatiotemporal.test.ts`):

| Quantity | Prior docs | **Measured now (steady)** | Engine's band | Verdict |
|---|---|---|---|---|
| Steady half-cycle | 800 ms | **572 ms** | — | retimed |
| Cadence | 65.5 spm* | **104.9 spm** | `CADENCE_SPM` [100,120] | **in band** |
| Speed | 0.595 m/s* | **1.352 m/s** | `SPEED_MPS` [1.2,1.4] | in band |
| Step length | 0.545 m* | **0.773 m** | — | unchanged by the retime |
| Stride | 1.091 m* | **1.547 m** | `STRIDE_M` [1.3,1.5] | in band (stature-scaled) |
| Walk ratio | — | **0.00737** | `WALK_RATIO_M_PER_SPM` [.0055,.0075] | **in band** |
| Froude | 0.034* | **0.176** | comfortable walk ≈0.15–0.25 | in band |
| Hips vertical p2p | 9.13 cm | **~9.4 cm** | authored target **5 cm** | **still ~1.9× target** |

\* these prior-doc figures are themselves mis-windowed; true pre-retime cadence was 75 spm (from
the authored 1600 ms cycle) and speed ~1.14 m/s. Treat them as directionally right only.

Three orientation facts follow.

**1. Proportion is now normative; the vertical bob is not.** Cadence, speed, stride, walk ratio and
Froude all sit in band. The outstanding proportion defect is the **pelvis vertical excursion**:
~9.4 cm measured against the 5 cm the builder itself authors as `verticalCalibrationCm`
(`gaitConstants.ts` `NORMAL_GAIT_VERTICAL_CM = 5`). See gap R2 — the suspect is the max-rise clamp
in `motionRecording.ts`, which re-stamps a corner where the smoothing was rounding one.

**2. Two measurement traps, both of which produced wrong conclusions during this sweep.**
*(a) Measure the steady cycle, not the whole clip.* `buildTravelWalk` is initiation → step-off →
one cycle → braking step → settle, and the **step-off is a longer step than the gait it settles
into** (0.893 m vs 0.805 m) whose hip peaks 37.9° against an authored 30°, because the R foot's
contact window opens at t=0 and pins that foot while the authored pose still has it reaching
forward to first contact — the leg IK reconciles the two by over-flexing the hip. That is a
pre-existing ENTRY artifact, identical before the retime, and it inflates any whole-clip
spatiotemporal by ~11%. It is the single largest source of phantom findings in this area.
*(b) Normalize for stature.* The bands are absolute, quoted for hip height ~0.90 m; this rig is
~1.06–1.08 m. Under dynamic similarity step ∝ L, cadence ∝ 1/√L, speed ∝ √L, walk ratio ∝ L^1.5.
Unscaled comparison reads a normal walk as a 7–15% over-stride. Froude is dimensionless and is the
check that does not depend on this argument.

**3. Almost nothing catches any of it.** `SPEED_MPS`, `STEP_WIDTH_M`, `walkRatio` and
`walkRatioInBand` had **zero** runtime or rig callers before `gaitSpatiotemporal.test.ts` — a
repo-wide grep found them only inside `normativeGait.test.ts`, asserted equal to themselves as
literals. That is how a cadence a third below its own band survived a fully green 1179-test suite.
This remains the most dangerous structural fact in this document: the engine ships ground truth it
does not consult.

**Where the sweep and the docs disagree with the code, this brief sides with the code.** Other
stale items found and corrected below: `GAIT_STEP_OFF_MS` is 285 not 400
(`movementLocomotion.ts:95`); foot plants run 8 CCD passes not 4 (`footContact.ts:57`); wrist drag
is velocity-driven not angle-driven (`gaitModifiers.ts:283`); `MIN_KEYFRAME_MS` is no longer a flat
150 (`motionSequence.ts:584`). And `docs/animation-realism-audit.md`'s line citations into
`movementTemplates.ts` (up to line 2150) are all dead — that file is now 168 lines after the
decomposition commits; its content lives in `movementTemplates.data.ts`, `movementLocomotion.ts`,
`movementPostures.ts` and `gaitConstants.ts`. Treat that audit's grades as directionally useful and
its citations and numbers as expired.

---

## 1. The pipeline, end to end

One motion — a walk — from request to pixels. Every hop verified by reading the file.

### 1.1 Authoring: the 8-phase walk template

`movementTemplates.data.ts:326-497` holds the walk as a `MovementTemplate`: 8 Perry phases, each
with `durationMs`, `velocityClass: 'functional'`, and a list of `{joint, motion, peakDeg}` targets.

- Phase durations **120 / 114 / 169 / 169 ms** per half-cycle, mirrored → **1144 ms cycle**
  (`movementTemplates.data.ts:339, 358, 377, 396` and the mirror at `415, 434, 453, 472`).
- Sagittal peaks: hip 30 → 25 → 5 → −10; knee 5 / 18 / 8 / 5 stance, 40 / 60 / 45 / 5 swing;
  ankle rockers; MTP toe rocker (`movementTemplates.data.ts:341-355` onward).
- Arm swing ±20°/±14° with a counter-phased elbow pump 11↔29°.
- **No `Spine` target in any of the 8 phases** — verified by grep over lines 320-500. All trunk
  motion is derived later, at step 1.2.

`movementTemplateMotion.ts` flattens this into a `ComposedMotion`.

### 1.2 Build: `buildTravelWalk` wraps the template in real gait machinery

`movementLocomotion.ts:152` is the entry point. It takes the template's cycle and adds everything
the template cannot express:

| Added | Where |
|---|---|
| APA initiation keyframe (300 ms lead, 6 mm pelvis shift) | `movementLocomotion.ts:247-262` |
| Step-off entry stretch (first cycle kf → ≥285 ms) | `movementLocomotion.ts:218` |
| Braking termination (250 / 450 / 200 ms) | `movementLocomotion.ts:270-292` |
| Stance schedule + foot-plant contacts | `movementLocomotion.ts:351-356` |
| `lateralShuttleCm: 2.5` | `movementLocomotion.ts:461` |
| `verticalCalibrationCm: NORMAL_GAIT_VERTICAL_CM` (= 5) | `movementLocomotion.ts:474`, `gaitConstants.ts:19` |
| `settleEnds: true` | `movementLocomotion.ts:456` |
| Trunk counter-lean absorbing the shuttle (2.4°) | `movementLocomotion.ts:385` |

Then two pure reshapes run **at build time**, before resolve:

- `healthySignature.ts:108-110` — a seeded 2–4% L/R arm-swing amplitude split, applied to
  `L_UpperArm` / `R_UpperArm` `shoulderFlexion` **only**.
- `gaitModifiers.spinalGaitCoordination` — derives ~24 non-sagittal channels per keyframe from the
  drivers the keyframe already carries: thoracic axial counter-rotation from the arm-swing
  difference (`gaitModifiers.ts:458`), lateral sway, pelvic yaw (`:477`), gaze stabilization, and
  all the distal arm/hand/foot texture. **This is the house pattern** — additive, ROM-clamped,
  zeroed at zero gain.

### 1.3 Resolve: `resolveComposedMotion`, 14 ordered phases

`motionSequence.ts:1704-1875`. This is the single truth path — the live stage and the offline
sampler both run a plan through it, so a recording cannot diverge from what plays.

```
 1 shape + limits                    motionSequence.ts:1704
 2 travel sugar → raw root           :1709
 3 resolve-time gait plumbing (1/2)  :1717   → gaitEnrichment.ts
 4 persistent heading rebase         :1735
 5 gaze stabilization                :1743
 6 peakAt intra-phase expansion      :1750
 7 universal relaxed hands           :1774
 8 per-keyframe ROM clamp + velocity floor  :1785  → motionResolvePhases.ts
 9 loop-wrap velocity floor          :1813
10 whole-plan uniform dilation       :1819
11 guarding / sway bake              :1826
12 gait enrichment (2/2): derive stance schedule + contacts  :1835
13 assemble + believability clamps   :1852
14 authored→resolved artifact remap  :1863
```

For the walk, phase 8 is where the new floor matters. The old flat `MIN_KEYFRAME_MS = 150` made a
114 ms loading response impossible; `VELOCITY_CLASS_MIN_KEYFRAME_MS`
(`motionSequence.ts:584-589`) now admits **90 ms for `'functional'`**, **60 ms for `'ballistic'`**,
and keeps **150 ms for `'deliberate'`** — so an unclassed keyframe is byte-identical to before.
Resolved durations for `buildTravelWalk()`, measured: `[300, 285, 114, 169, 169, 120, 114, 169,
169, 250, 450]`, total 2309 ms, `timingAdjusted` false everywhere.

### 1.4 Trajectory: poses → one continuous motion

`motionSequence.buildSequencePoses` folds each resolved keyframe into one `CustomPose`
(carry-forward semantics, trunk↔shoulder readout compensation, SEAM-6 settle of un-targeted
drivers). Then `motionTrajectory.ts`:

- **SQUAD** quaternion spline for the path, with a slerp fallback above
  `SQUAD_SLERP_FALLBACK_DEG = 120` (`motionTrajectory.ts:161`).
- **Monotone PCHIP time-warp** (`motionTrajectory.ts:210-320`), Fritsch–Carlson tangents at
  `:256`; slope forced to zero **only at genuine stops**.
- Per-velocity-class late-brake settle shaping (`SETTLE_BRAKE_LATENESS`, `:223`) and a terminal
  pre-settle overshoot knot (`:532`).
- A constant-*g* parabola over airborne spans (`:407-500`).
- A per-bone proximal→distal parameter warp from `motionStagger.ts`.

`cyclicEnds` (derived: `footDrivenTravel === true && settleEnds !== true`) decides whether the
first and last knots are fly-throughs or real stops. The walk sets `settleEnds`, so it starts and
stops like a person.

### 1.5 Grounding + travel: the derivations

Four pre-passes measure the trajectory **on the live rig** and hand back lookup tables. They live
in `rootMotion.ts` and are called identically by the sampler (`motionRecording.ts`) and the live
stage (`stageComposedDerivations.ts`) — that shared-helper discipline is what keeps them in
lockstep.

| Pre-pass | Function | Sampler call |
|---|---|---|
| Vertical calibration | `rootMotion.ts:718-781` | `motionRecording.ts:664-681` (48 samples, smoothed) |
| Foot-driven travel | `rootMotion.ts:978-1100` | `motionRecording.ts:743` (120 samples) |
| Lateral shuttle | `rootMotion.ts:~1228-1258` | `motionRecording.ts:746` (120 samples) |
| Heel-strike accents | `rootMotion.ts:1560-1650` | `motionRecording.ts:755-756` |

### 1.6 Per-frame apply order (sampler; the stage mirrors it)

Verified in `motionRecording.ts:875-1130`:

```
FK pose from the trajectory
  → grounding pin        pinRootToFloor :879   /  plantStanceFoot :877, :962
  → vertical calibration applyVerticalCalibration :977
  → weighted descent     applyWeightedDescent :990
  → heel-strike accent   heelStrikeOffsetAt :1004  (root.position.y += :1006)
  → foot-driven travel + lateral shuttle
  → foot plant IK        solveFootPlantWeighted :1081 / solveFootPlant :1099
                         (plant target de-dipped by the accent, :1094)
  → MEASURE              computeJointAngles :1130
```

Everything above the measure line is **root-only or IK-only**, which is why every clinical joint
readout survives grounding untouched.

### 1.7 Live playback and the overlay sandwich

`ExamStage3D.svelte` owns one rAF loop, four mutually-exclusive skeleton drivers (clip mixer, exam
tween, composed trajectory player, trajectory root appliers) and four additive **live-only**
overlays. The frame order is load-bearing:

```
… drivers … → guarding → balance sway
  → undo overlays → recordingTap.sample() → re-bake overlays → eyes → render
```

That sandwich is why recordings, goniometry and exports see the clean driven pose while the screen
sees the perturbed one. It is pinned by source regex in `stageReliability.test.ts` and
`idleLiveliness.test.ts` — **reordering it fails tests even with identical numbers.**

### 1.8 Grading

`validityGate.ts` (foot skate, CoM-in-base, penetration, seam jerk, ROM invariant) plus
`gaitBiomechCheck.ts` folded in as `runBiomechChecks` (Froude, vertical CoM, per-joint RMS vs the
Perry curves in `normativeGait.ts`). **Every biomech check is `warn` severity and cannot fail a
report.**

---

## 2. The lever board

Grouped by pipeline stage. Blast radius: **high** = retuning it moves other subsystems or breaks
byte-identity gates; **medium** = moves one subsystem plus its gates; **low** = local.

### 2.1 Authoring — the walk template

| Lever | file:line | Value | Controls | What you'd SEE | Blast |
|---|---|---|---|---|---|
| Walk phase durations | `movementTemplates.data.ts:339,358,377,396` (+mirror `415,434,453,472`) | 120/114/169/169 ms | Cycle rhythm and cadence | Shorter → brisker, faster steps. This is now **in band**; further shortening leaves it | high |
| `velocityClass: 'functional'` on the 8 phases | `movementTemplates.data.ts:340,359,378,397,…` | functional | Which cap (600 °/s) and floor (90 ms) apply | Reverting to deliberate re-imposes the 150 ms floor and forces cadence back to ~80 spm | high |
| Hip sagittal peaks | `movementTemplates.data.ts:341` etc. | 30 → 25 → 5 → −10 | Step length (emergent), swing height | Bigger sweep → longer step. **Currently over-long — see gap R1** | high |
| Knee peaks | `:343, 362, 381, 400` (stance) / swing | 5/18/8/5, 40/60/45/5 | Loading-response absorption, swing clearance | Loading knee 18→8 → each footfall reads as a stiff-legged jolt | high |
| Ankle rockers | `:344` etc. | 0 / −8 / +5 / +10 / −15 | Heel/ankle/forefoot rockers, push-off | −15 → −18 raises the heel further, push looks powered rather than lifted | high |
| Toe (MTP) rocker | `:345, 364,…` | 0 / 12 / 28 / 5 | Forefoot roll at push-off | Zeroed → rigid flat-plate pivot. Raised → *en pointe* | high |
| Arm swing / elbow pump | `:346-350` region | ±20/±14; elbow 11↔29 | Arm amplitude **and** all derived thoracic counter-rotation | Smaller → Parkinsonian damped look **and** a stiffer trunk (coupled, §5) | high |
| `peakAt` intra-phase leads | `movementTemplates.data.ts:138-139` (squat), `:186-191` (hinge) | 0.8 | The only within-phase joint sequencing in the library | 1.0 → lockstep descent, reads robotic. The walk authors **none** | high |
| Squat weight-bearing dorsiflexion | `movementTemplates.data.ts:138-139` | 32° | Shin travel over a planted foot | Lower → pelvis sits back behind the heels, reads like sitting into a chair | high |

### 2.2 Build — `buildTravelWalk` and the locomotion family

| Lever | file:line | Value | Controls | What you'd SEE | Blast |
|---|---|---|---|---|---|
| `GAIT_STEP_OFF_MS` | `movementLocomotion.ts:95` | **285** (was 400) | First cycle keyframe floor | Down → limbs whip into stride 1. Up → tentative step-off, drags cadence | medium |
| `GAIT_INITIATION_MS` | `movementLocomotion.ts:103` | 300 | APA lead keyframe | Longer → deliberate/cautious weight commit. Shorter → launches with no preparation | medium |
| `GAIT_APA_SHIFT_M` | `movementLocomotion.ts:128` | 0.006 m | Authored pre-step weight shift | Currently near-invisible; the derived shuttle does the visible work | medium |
| `GAIT_TERMINATION_STEP/SETTLE/HOLD_MS` | `movementLocomotion.ts:137-139` | 250 / 450 / 200 | Braking step, level-out, dwell | Shorter → snaps to a stop. Moves every terminal contact window | medium |
| `GAIT_SHUTTLE_CM` | `movementLocomotion.ts:147` | 2.5 cm | Medio-lateral pelvis ride toward the stance foot | 0 → glides down the midline like a rail-cart. Higher → visible waddle | high |
| `GAIT_SHUTTLE_ABSORB_DEG` | `movementLocomotion.ts:150` | 2.4° | Trunk counter-lean that keeps the head centred | Too low → the head swings with the pelvis (fails the 2.5 cm head gate) | medium |
| `NORMAL_GAIT_VERTICAL_CM` | `gaitConstants.ts:19` | 5 | Calibrated pelvis/CoM vertical target | The travel walk **does not reach this** (9.45 cm measured — gap R2) | high |
| `settleEnds` | `movementLocomotion.ts:456` | true (walk) | Whether the gait eases from a standstill or fades in mid-stride | Off → the walk starts mid-stride like a looping clip. **The run never sets it** — gap R5 | medium |
| Run absorb deltas | `movementLocomotion.ts` `RUN_ABSORB_EXTRA_KNEE_DEG` etc. | 16° / 10° | Touchdown loading yield | Drop them and the run lands pre-posed and stiff | high |
| `runStepTiming` | `movementLocomotion.ts` (~858-868) | floored at the class minimum | Run cadence and flight:stance | Above f≈1 the ground phases stop shortening | high |

### 2.3 Reshape — `gaitModifiers`

| Lever | file:line | Value | Controls | What you'd SEE | Blast |
|---|---|---|---|---|---|
| `kAx` (thoracic axial gain) | `gaitModifiers.ts:367` | 0.16 | Thoracic counter-rotation, derived from the arm-swing difference | Up → the shoulder girdle visibly winds against the pelvis. Down → rigid torso over moving legs | high |
| `kLat` (lateral sway) | `gaitModifiers.ts:372` | 0.03 | Trunk lean toward the stance hip | Up → waddle/Trendelenburg lurch. The gate requires rotation ≥1.8× lean | high |
| `kPel` (pelvic transverse) | `gaitModifiers.ts:397` | 0.05 (≈±2°) | Root yaw per keyframe | **Half physiologic by necessity** — higher skates the planted foot under a vertical pin. Gap R6 | high |
| `PELVIS_YAW_MAX` | `gaitModifiers.ts:241` | 6 | Cap on pelvic yaw | Never reached at the current gain | high |
| `SPINE_AXIAL_MAX` / `LUMBAR_AXIAL_MAX` / `LATERAL_MAX` | `gaitModifiers.ts:229, 230, 236` | 14 / 8 / 8 | Hard caps on the coordination pass | These are what stop a paced walk looking like a torso-twist exercise. Exact values asserted in tests | high |
| `NECK_AXIAL_ROLL_COMP` | `gaitModifiers.ts:315` | 0.28 | Cancels head roll leaked by the axial neck counter | Wrong sign → the head tips side to side each stride with nothing authoring it | medium |
| `SPINE_NECK_MAX` / `LATERAL_MAX` | `motionSequence.ts:558-559` | 24 / 18 | Cervical counter caps | Lower → the head starts riding the trunk on a big-swing gait | medium |
| `headStabilize` relax | `gaitModifiers.ts:301-302` | 0.08/unit, floor 0.85 | How completely the neck counters inherited rotation | 1 → eyes pinned dead ahead, slightly uncanny at speed | medium |
| `ARM_ADD_BASE` | `gaitModifiers.ts:247` | 5 | How close the arms hang to the body | Zero/flipped → winged-out "gunslinger" carriage. Strong silhouette cue | low |
| `ARM_PRO_BASE` | `gaitModifiers.ts:250` | 12 | Forearm pronation | Zero → forearms read as neutral rods, a classic rigged-mannequin tell | low |
| `SCAP_PROT_GAIN` | `gaitModifiers.ts:253` | 0.35 | Scapular fore-aft glide | Zero → arm swing is purely glenohumeral, shoulders look bolted on | low |
| `WRIST_FLEX_BASE` / `MAX` | `gaitModifiers.ts:259-260` | 10 / 22 | Resting wrist flexion, total band | Zero → the hand is a rigid paddle | low |
| **`WRIST_DRAG_PER_DEG_S`** | `gaitModifiers.ts:283` | **0.072** | Hand lag, now driven by arm angular **velocity** | Peak drag moved from the swing extremes to **mid-swing** (a quarter-cycle phase correction in `f3fdf82`) — and tempo now scales it for free | medium |
| `FINGER_CURL_DEG` | `gaitModifiers.ts:284` | 32 | Resting finger curl | Zero → splayed straight fingers, immediately reads mannequin | low |
| `ELBOW_PUMP_ENERGY_GAIN/MAX` | `gaitModifiers.ts:296-297` | 0.22 / 14 | Extra elbow pump above energy 1 | Zero → a run swings with a walker's stiff arm | low |
| `ENERGY_MAX` | `gaitModifiers.ts:305` | 3.2 | Locomotor intensity ceiling | The one dial separating walker's hands from runner's. Clamped ≥1, so a **shuffle gets no relaxation** | medium |
| `HIP_ADD_GAIN` | `gaitModifiers.ts:306` | 0.18 | Swing-leg adduction toward the midline | Flipped → wide waddling splay. Gated to swing only, or it drags the stance foot | medium |
| `KNEE_ROT_GAIN` | `gaitModifiers.ts:309` | 0.08 | Tibial rotation with knee flexion (screw-home) | Zero → the shank is a pure hinge, leg looks 2-D from behind | low |
| `ANK_INV_GAIN` | `gaitModifiers.ts:311` | 0.22 | Subtalar eversion/inversion | Zero → contact and push-off look flat-footed | low |
| `gaitBounce` map | `gaitModifiers.ts:~68-70` | 0→3, 1→5, 2→8 cm | Host-facing spring-vs-glide dial | Directly the per-step pelvis rise and fall | medium |
| `paceGait` √speed split | `gaitModifiers.ts:93, 99, 104` | `f = √speed`, applied to stride **and** timeScale | Couples stride × cadence = speed exactly | Changing the split decides whether a fast walk is longer strides or quicker steps | high |
| `GAIT_STRIDE_MOTIONS` | `gaitModifiers.ts:76` | hip/knee/ankle/shoulderFlexion | Which channels scale with pace | Removing `shoulderFlexion` → arms keep a fixed swing while legs stride longer (reads disconnected) | medium |
| `scaleArmSwing` | `gaitModifiers.ts:~120-134` | clamp [0,1] | Arm damping without touching cadence | 0 → arms hang still. **Trunk rotation damps automatically** (coupled, §5) | medium |
| `applyAsymmetry` | `gaitModifiers.ts:~152-171` | values <1 only | Unilateral involved-side reshape | This is how a limp is produced. `>1` is silently ignored — an exaggerated side is unauthorable | medium |
| `ASYMMETRY_STRIDE_MOTIONS` | `gaitModifiers.ts:137` | hip/knee/ankle | Which leg channels a one-sided step-length change touches | — | medium |

### 2.4 Timing, easing and follow-through

| Lever | file:line | Value | Controls | What you'd SEE | Blast |
|---|---|---|---|---|---|
| `VELOCITY_CLASS_CAPS` | `motionSequence.ts:100-104` | 240 / 600 / 2000 °/s | Per-keyframe angular cap | The default (`deliberate` 240) is the single biggest speed dial | high |
| **`VELOCITY_CLASS_MIN_KEYFRAME_MS`** | `motionSequence.ts:584-588` | **deliberate 150, functional 90, ballistic 60** | Per-class duration floor | New in `f3fdf82`. This is what unlocked normative cadence — and what lets a run/jump keep authored ballistic timing | high |
| `MIN_KEYFRAME_MS` | `motionSequence.ts:563` | 150 | The `'deliberate'` floor (alias) | Lower → snappier micro-gestures; every unclassed motion re-times | high |
| `MAX_KEYFRAME_MS` | `motionSequence.ts:~596` | 10 000 | Duration and hold ceiling | Long end-range holds get cut | medium |
| `composedTweenEase` | `motionStagger.ts:42-44` | ease-in-out cubic | THE shared curve for the exam tween and the sampler | Symmetric in/out means every gesture starts and stops from rest. Swapping it changes the texture of every motion | high |
| `PROXIMAL_TO_DISTAL_STAGGER` | `motionStagger.ts:55` | 0.18 | Per-bone follow-through delay | Up → the hand visibly whips behind the shoulder. 0 → lockstep, the robot read | high |
| `CHAIN_RANK` / `CHAIN_MAX_RANK` | `motionStagger.ts:69-79` | Hips 0 … digits/toes 8 | Which bone lags which | `Head` is rank 6 — same as `Foot` — so the head lags heavily; bobble-head on fast trunk motion | medium |
| `AXIAL_TRAJECTORY_FRACTION` | `motionStagger.ts:101` | 0.25 | Spine/neck share of the arm delay | Up → the trunk unfurls; perturbs the authored trunk↔neck gaze phase | medium |
| **Leg/toe stagger exemption** | `motionStagger.ts:137` | `→ 0` | Legs and toes get **zero** follow-through | Hip, knee, ankle and toes start and stop on the same frame — gap R7 | high |
| `SETTLE_BRAKE_LATENESS` | `motionTrajectory.ts:223` | functional 0.75, ballistic 1.5; **no `deliberate` key** | Late-brake shape at a stop | At b=0 every arrival is a symmetric servo ease — which is what the whole gait cycle gets | medium |
| `TERMINAL_OVERSHOOT_FRACTION` | `motionTrajectory.ts:532` | 0.03 | Pre-settle overshoot knot | 0 → dead-stop servo endings. Fires only for functional/ballistic finals | medium |
| `TERMINAL_OVERSHOOT_LEAD_MS` / `MIN_TRAVEL_DEG` | `motionTrajectory.ts:535, 538` | 120 ms / 2° | When and whether the overshoot is inserted | Larger lead → visible sail-and-settle | low |
| `SQUAD_SLERP_FALLBACK_DEG` | `motionTrajectory.ts:161` | 120 | Wide-arc degeneration to slerp | Also zeroes the flanking knots' tangents → two artificial pauses around a big reorientation | medium |
| Whole-plan dilation majority rule | `motionResolvePhases.ts:~462` | strict majority | Uniform dilation vs per-keyframe flooring | Uniform preserves Perry proportions; per-keyframe flattens rhythm to a metronome | high |

### 2.5 Grounding, travel and contact

| Lever | file:line | Value | Controls | What you'd SEE | Blast |
|---|---|---|---|---|---|
| **`GAIT_VERTICAL_MAX_RISE_M`** | `motionRecording.ts:352` | 0.025 m | How far the smoothed vertical may sit above the live pin when plants are active | **This is the clamp that holds the walk at 9.45 cm against a 5 cm target** — gap R2. Raising it reaches the target but over-reaches the stance leg | high |
| Vertical calibration sample count / smoothing | `motionRecording.ts:681`; `rootMotion.ts:~721, 744` | 48 samples, ±4 boxcar | Resolution and shape of the pelvis arc | Wider smoothing → glassier sinusoid, less footfall character; narrower → the raw V-valley sawtooth returns | high |
| Vertical gain clamp | `rootMotion.ts:~740` | [0.1, 1.6] | How far the emergent arc may be scaled | 1.6 caps how much a flat arc can be amplified | medium |
| `VCAL_HANDOFF_BLEND_MS` | `rootMotion.ts:701` | 200 ms | Loop-form vertical fade-in | Too short → a visible pelvis step at loop engage | medium |
| `FOOT_HANDOFF_HYSTERESIS_M` | `rootMotion.ts:886` | 0.008 m | Planted-foot decision handoff (travel **and** shuttle) | Too small → near-tie foot heights flutter the choice and freeze derived travel mid-step | high |
| Derived travel/shuttle resolution | `motionRecording.ts:743, 746` | 120 samples each | Root path and shuttle smoothness | Lower → the body advances in visible plateaus; a periodic micro-stall at each handoff | medium |
| Shuttle reach cap + half-sine | `rootMotion.ts:~1256-1258` | `min(amp, 0.6·|stanceX|)`, `sin(π·u)` | Actual shuttle amplitude and its profile | A narrow stance silently gets less shuttle than authored | medium |
| `FOOT_ROOT_DRIFT_M` | `rootMotion.ts:305` | 0.05 m | Threshold to re-root at the foot vs vertical-pin only | Lower → squats/hinges fold over genuinely planted feet, but the torso can twitch between the two branches | high |
| `HORIZ_TRAVEL_EPS` | `motionRecording.ts:~802` | 0.02 m | Above this authored travel, the closed chain is off | Any stepping/reaching motion with real translation and no declared contacts drags both feet | high |
| `useFootRoot` gate set | `motionRecording.ts:~825-833` | 8 clauses | Which motion classes get closed-chain planting | Each excluded class is excluded for a visible reason (a jump snaps at the pin toggle; a lying body rotates toward standing) | high |
| `SEAT_HEIGHT_M` | `rootMotion.ts:185` | 0.59 | Hips pin height when sitting | Up → perching on a bar stool, feet lift. Down → pelvis sinks through the seat | high |
| `GROUNDING_BLEND_MS` | `rootMotion.ts:493` | 200 ms | Crossfade at a grounding-pin swap | Shorter → the measured 53 cm one-frame free-fall returns | high |
| `HAND_REACH_RAMP_MS` | `rootMotion.ts:634` | 150 ms | Hand-reach IK engagement | 0 → the arm snaps to the floor on frame 1 | medium |
| **`FOOT_PLANT_IK_ITERATIONS`** | `footContact.ts:57` | **8** (shared default is 4) | CCD passes per plant | Raised in `f3fdf82` because the faster cadence pushed in-window slide 2.9 → 4.5 cm. Now ~2.5–3.5 cm across the pace range | medium |
| `LEG_CHAIN_PARENTS` | `footContact.ts:40` | 2 (Foot–Leg–UpLeg) | How many joints a plant may recruit | 3 would let the pelvis help — closer to real accommodation, at the cost of a wobbling trunk | high |
| `PLANT_RELEASE_BLEND_MS` | `footContact.ts:120` | 100 ms | Plant correction ramp-out at toe-off | Without it the released foot snapped ~20 cm and ~17°/frame | high |
| `HAND_LATCH_M` / `HAND_REACH_PASSES` / `HAND_RELATCH_M` | `footContact.ts:208, 213, 220` | 0.03 / 4 / 0.08 | Hand floor grab and self-heal | Too few passes → the hand punches through the floor at the bottom of a push-up | medium |
| `HEEL_STRIKE_SPAN_MS` | `rootMotion.ts:1560` | 110 ms | Footfall dip duration | Longer → a soft sag rather than an impact | medium |
| `HEEL_STRIKE_MIN/MAX_DIP_M` | `rootMotion.ts:1562, 1564` | 0.005 / 0.01 | Accent amplitude band | Capped at 1 cm — a heavy and a gentle step look identical. Gap R9 | medium |
| `HEEL_STRIKE_REF_DESCENT_M_S` | `rootMotion.ts:1569` | 0.25 m/s | Arrival rate at which the accent saturates | Lower → every footfall lands at max firmness | low |
| Heel-strike kernel | `rootMotion.ts:1575` | `u²(1−u)³`, norm 3125/108, peak at u=0.4 | The dip-and-recover shape | Non-oscillating by construction; a symmetric bump would add a rebound bounce | medium |
| `WEIGHTED_DESCENT_*` | `rootMotion.ts:1324, 1332, 1341, 1346` | 0.1 m / 1.2 m/s / 0.03 / 0.02 | Gravity-shaped lowers | Higher terminal speed → a heavier drop into the chair. Hover cap stops the pinned feet lifting off | high |
| `verticalCalibrationCm` clamp | `motionResolvePhases.ts:551` | [1, 12] cm | Believability band on the host request | 1 → floating glide, 12 → a hop | medium |
| `lateralShuttleCm` clamp | `motionResolvePhases.ts:560` | ≤ 6 cm | Last line of defence on sway | Raising it permits a visible waddle | medium |

### 2.6 Enrichment — the AI-composed path

| Lever | file:line | Value | Controls | What you'd SEE | Blast |
|---|---|---|---|---|---|
| Structural gait predicate | `gaitEnrichment.ts:67-80` | min 4 kf, reciprocal 10°, antiphase 15°/−5°, trend 6° | Whether an AI plan counts as gait and gets the machinery | Loosen → squats get gait plumbing (fiction on screen). Tighten → real AI walks revert to 68 cm foot slide | high |
| `GAIT_TRAVEL_EPS_M` | `gaitEnrichment.ts:82` | 0.05 m | Below this, treated as in-place | Raise → small-travel AI walks moonwalk on the spot | medium |
| `GAIT_ENRICH_VERTICAL_CM` / `SHUTTLE_CM` | `gaitEnrichment.ts:91, 94` | 5 / 2.5 | Attached to an enriched gait — a **duplicate** of the builder values | Must be retuned in lockstep or AI and deterministic walks visibly differ in bob and sway | medium |
| `GAIT_ENRICH_ENTRY_MS` / `BRAKE_MS` | `gaitEnrichment.ts:104, 110` | 900 / 600 ms | Forced first/last keyframe floors | Down → the walk teleports into stride (1.03 m/s in the first 150 ms before the fix) | medium |
| `hasAuthoredGaitPlumbing` opt-out set | `gaitEnrichment.ts:331-344` | 10 fields | Any plan touching one is never enriched | Adding a field here silently disables all enrichment for plans that use it | high |
| `deriveGaitStanceSchedule` | `gaitEnrichment.ts:534-550` | **partitions** the timeline | Derived windows + contacts | Every instant has exactly one bearing foot → **zero double support**. Gap R8 | high |

### 2.7 Life signals — live-only overlays

| Lever | file:line | Value | Controls | What you'd SEE | Blast |
|---|---|---|---|---|---|
| `idleLiveliness` | `ExamStage3D.svelte:120` | **0.4** | Master idle dial (breath, sway, ankle pivot, weight shift, eyes) | 0 → a statue and the render loop stops waking | high |
| **`motionLiveliness`** | `ExamStage3D.svelte:932` | **0** | Motion-time breath + micro-sway **and** cadence variability | At the shipped default the mannequin **does not breathe while moving** and every loop cycle is metronomic. Gap R3 | high |
| `BREATH_PEAK_DEG` | `liveliness.ts:27` | 2.2° | Thoracic breath amplitude | Past ~3° it reads as a nod, not a breath | medium |
| `BREATH_REST_HZ` / `MAX_HZ` / `AMP_MAX_SCALE` | `liveliness.ts:207, 210, 212` | 0.23 / 0.45 Hz / 1.6× | Exertion-scaled rate and depth | 13.8 → 27 bpm; the only visible consequence of exertion anywhere | medium |
| `EXERTION_RISE/DECAY_TAU_S` | `liveliness.ts:215, 218` | 8 s / 45 s | Work accumulation and recovery | Asymmetric by design — the patient stays visibly winded after a run | medium |
| `INTENSITY_REST/FULL_DEG_S` | `liveliness.ts:~284-286` | 25 / 150 °/s | Joint speed → work intensity | Walk measures 0.159, run 0.989 — so **walking barely registers as work** | medium |
| `SWAY_ML/AP_PEAK_DEG` + Hz | `liveliness.ts:34-43` | 1.3° / 0.9°, 0.23 / 0.31 Hz | Quiet-stance micro-sway | Two pure sines → a smooth repeating Lissajous, no corrective micro-adjustments | medium |
| `IDLE_ANKLE_PIVOT_SHARE` | `liveliness.ts:~374` | 0.6 | Ankle-pivot vs residual lumbar bend | 1 → a rigid rocking statue; 0 → lumbar angle-noise over a dead pelvis | high |
| `IDLE_SHIFT_PEAK_M` / `LEAN_PEAK_DEG` | `liveliness.ts:~95, 99` | 0.012 m / 1.1° | Slow idle weight shift | Up → an obvious lean onto one hip (and it drags both feet, ~1 cm) | high |
| `CADENCE_CV_MAX` | `liveliness.ts:~163` | 0.06 | Stride-time variability | ±6% at amount 1 — but gated behind `motionLiveliness = 0` | medium |
| `LIVELINESS_ONSET_SEC` | `stageMotionLiveliness.ts:26` | 0.4 s | Motion-time overlay ease-in | 0 → the trunk leans **before** the movement starts | high |
| Clinical sway | `ExamStage3D.svelte:921-924` | 0.45/0.7 Hz, 8°/5° | The deficit-signalling wobble | Lumbar-only, 6× life-sway amplitude, on the same bone | medium |
| Eye caps and saccades | `eyeGaze.ts:27-54` | 0.8–3 s, 1–4°, cap 8° | Micro-gaze | No blinks — morphs stripped at export, a hard asset ceiling | medium |
| `HEALTHY_SIGNATURE_SEED` / band | `healthySignature.ts:~54-58` | 17, [0.02, 0.04) | The one seeded variation in shipped gait | Arm amplitude **only** (`:108-110`) — every leg channel is a perfect mirror. Gap R10 | medium |

### 2.8 Grading thresholds

| Lever | file:line | Value | Controls | Blast |
|---|---|---|---|---|
| `footContactHeightM` | `validityGate.ts:163` | 0.05 m | Which frames foot-skate may inspect | medium |
| `footSkateSpeedMs` / `RatioMax` | `validityGate.ts:164-165` | 0.75 m/s / 0.5 | Skate speed and how much of stance may exceed it | high |
| `travelEpsM` | `validityGate.ts:166` | 0.3 m | Travelling ⇒ skate fails; in-place ⇒ warn | high |
| `comBaseToleranceM` / `GrossM` | `validityGate.ts:167-168` | 0.05 / 0.25 m | CoM-outside-base warn / fail | medium |
| `seamJerkMaxMs` | `validityGate.ts:169` | 12 m/s | Teleport detector (sample-rate dependent) | medium |
| `penetrationAnkleEpsM` / `ToeEpsM` | `validityGate.ts:170-171` | 0.02 / 0.06 m | Floor penetration | medium |
| `romEpsDeg` | `validityGate.ts:172` | 0.5° | The only always-on hard check | low |
| `IN_PLACE_TRAVEL_M` | `gaitBiomechCheck.ts:33` | 0.3 m | Below this, Froude is skipped | low |
| `VERTICAL_COM_WARN_CM` | `gaitBiomechCheck.ts:38` | **[2, 9]** | Accepted CoM excursion — **widened from the [4,5] norm** | medium |
| `WITHIN_BAND_WARN_FRACTION` | `gaitBiomechCheck.ts:41` | 0.5 | Fraction of cycle inside ±1 SD | medium |
| `JOINT_SOURCE` | `gaitBiomechCheck.ts:46-50` | `L_UpLeg` / `L_Leg` / `L_Foot` | **Left side only** — a right-sided deviation is ungraded | low |
| Normative curves | `normativeGait.ts:83-166` | 21-point 5% grids | The ground truth everything is graded against | high |
| Spatiotemporal bands | `normativeGait.ts:368-389` | speed/cadence/stride/width/ratio | **Only `CADENCE_SPM` has any caller** | high |

---

## 3. Where realism actually breaks today

Ranked by damage to believability. **All ten below are confirmed by reading current code or by
rig measurement I ran myself.** Doc-only claims are separated at §3.2.

### R1 — RETRACTED: the walk does not over-stride *(no defect)*

This finding originally read "1.72 m stride, walk ratio still out of band". **It was wrong on both
counts** and is kept here rather than deleted because the two errors behind it are the standing
traps of this subsystem (see the correction notice at the top).

*Error 1 — whole-clip windowing.* The 0.859 m step was picked across the full clip, which includes
the step-off entry. That entry is a genuinely longer step than the gait it settles into and its hip
over-flexes to 37.9° against an authored 30°, because the R contact window opens at t=0 and pins
the foot while the authored pose still reaches it forward. Measured over the STEADY cycle the step
is **0.773 m**, stride **1.547 m**.

*Error 2 — unscaled bands on a tall rig.* `STRIDE_M` etc. are absolute, for hip height ~0.90 m;
this rig is ~1.06 m.

Steady-cycle truth, now gated in `gaitSpatiotemporal.test.ts`: cadence **104.9 spm**, speed
**1.352 m/s**, stride **1.547 m**, walk ratio **0.00737**, Froude **0.176** — every one in band,
walk ratio inside even the UNSCALED band. There is no proportion defect in the horizontal plane.
The real proportion defect is vertical: see R2.

**Why nothing catches it:** `gaitTravel.test.ts:144` asserts only `travel > 0.5 m` over an
11-keyframe walk. `SPEED_MPS`, `STRIDE_M` and `walkRatio` have zero runtime callers (grep verified
§0). The new cadence gate (`gaitPerryTiming.test.ts:67-68`) reads *authored durations*, not
measured footfalls, so it cannot see step length at all.

### R2 — The "calibrated 5 cm" pelvis arc renders at 9.45 cm *(breaks immersion)*

`movementLocomotion.ts:474` authors `verticalCalibrationCm: NORMAL_GAIT_VERTICAL_CM` = 5
(`gaitConstants.ts:19`). Measured on the rig: **9.45 cm** Hips peak-to-peak. I disabled the
heel-strike accent and got **9.45 cm unchanged** — so the accent is not the cause. The cause is the
smoothed-arc rise clamp: `rootMotion.ts:778` returns `Math.min(s, y + cal.maxRiseM)` with
`maxRiseM = GAIT_VERTICAL_MAX_RISE_M = 0.025` (`motionRecording.ts:352`), passed only when foot
plants exist (`motionRecording.ts:681`).

The asymmetry is gate-legal by construction: `gaitBounce.test.ts:64` builds the **in-place** walk
template, and `:108` asserts the target is hit within 0.6 cm — so the in-place walk is exact. The
**travelling** walk, which is what a user sees, is only bounded by
`gaitTravel.test.ts:176`, `p2p < 0.10 m`. 9.45 cm passes with 5 mm to spare.

**Symptom:** the pelvis pogos nearly twice as far as a real walker's (the module documents 4–5 cm),
a visible vault through every stance. The knob meant to fix it is silently under-delivering.

### R3 — Nobody breathes while moving, and looped gait is a metronome *(breaks immersion)*

`ExamStage3D.svelte:932` — `let motionLiveliness = 0`. `stageMotionLiveliness.ts` returns before
advancing the breath phase when the amount is zero, and `ExamStage3D.svelte:2195` feeds the same
zero into `cadenceRate`, which returns exactly 1 at amount 0 (`liveliness.ts:173`). Meanwhile
`idleLiveliness` defaults to **0.4** (`ExamStage3D.svelte:120`).

**Symptom:** the mannequin breathes and micro-sways while standing still, then goes completely
rigid the instant any motion plays, and every gait cycle takes exactly the same milliseconds
forever. The dial exists and works; it ships off.

### R4 — The two instruments that should catch R1/R2 are both structurally blind *(breaks immersion)*

Three independent defects in `gaitBiomechCheck.ts`, all measured:

1. **Froude is computed over the whole clip.** `:143-147` uses `netTravelM(frames)` ÷ whole-clip
   duration. For `buildTravelWalk` that clip is 2509 ms containing a 300 ms APA lead and a 700 ms
   braking termination. Measured: the check reports **Froude 0.031** where the steady-state value
   is **0.213** — a 7× under-read. It still returns `pass: true`, because the only failure
   condition is being too *fast*.
2. **The normative-curve grading is phase-blind.** `:109-118` maps phase as
   `((f.tMs - t0) / span) * 100` over the whole clip — 1.65 cycles compressed onto one 0–100%
   axis, starting from a standing pose rather than initial contact. Measured on the shipped walk:
   knee **0.19**, hip **0.19**, ankle **0.43** within ±1 SD, all below
   `WITHIN_BAND_WARN_FRACTION = 0.5` (`:41`) — all three **fail**.
3. **It cannot fail anything.** Every check is `warn` severity, and
   `gaitBiomechCheck.test.ts:99-104` explicitly declines to assert the normative checks pass.

Also: `VERTICAL_COM_WARN_CM` is widened to **[2, 9]** (`:38`) against a [4,5] norm, so the walk's
measured 7.4 cm CoM excursion passes; and `JOINT_SOURCE` (`:46-50`) grades the **left side only**.

**Symptom:** the one instrument that should say "this knee curve is wrong" reports 19% agreement
for a walk everyone considers shipped. A genuinely broken knee and a good one produce the same
verdict. **Retuning against this metric today is flying blind** — fix the instrument before
trusting it.

### R5 — The travelling run stops dead at stride velocity *(breaks immersion)*

`settleEnds` appears once in `movementLocomotion.ts` — line **456**, inside `buildTravelWalk`.
`buildTravelRun` never sets it, and the code says so at `:1004-1007`: "it does NOT author a braking
multi-step deceleration (the travel walk's `settleEnds` machinery; a 2-3 step run-down is future
work)."

**Symptom:** the run ends mid-stride with the body still at full speed — the animation cuts out
with a leg in the air, where a person would take two or three shortening steps to a stop.

### R6 — Pelvic transverse rotation is authored at half physiologic *(noticeable)*

`gaitModifiers.ts:397` sets `kPel = 0.05`, landing ≈ ±2° of pelvic yaw against a physiologic ±4°.
The reason is in the code at `:240`: the grounding model is "a vertical pin, not a horizontal
foot-lock IK", and a higher gain visibly skates the stance foot. `PELVIS_YAW_MAX = 6`
(`gaitModifiers.ts:241`) is never reached.

**Symptom:** the hips look locked to the direction of travel, and the shoulder–pelvis
counter-rotation reads as a torso twist happening *above* a rigid pelvis rather than a whole-body
wind-up. It also caps how long a stride the FK can produce — which interacts with R1.

### R7 — The whole lower limb is exempt from follow-through *(noticeable)*

`motionStagger.ts:137`: `if (/^(UpLeg|Leg$|Thigh|Calf|Foot|Toe)/.test(canonical)) return 0;` — with
the rationale at `:117-121` that a leg delay fights the foot-plant IK and the slide gates. Arms get
the full `chainOnsetDelay × 0.18`; the axial column gets 25%.

**Symptom:** in every step, squat and lunge the thigh, shin and foot start and stop on the same
frame. The arms above them overlap and trail convincingly while the legs articulate as one rigid
linkage — the clearest remaining mannequin tell, and the reason the lower body reads stiffer than
the upper.

### R8 — Enriched (AI-composed) gaits get zero double support *(noticeable)*

`gaitEnrichment.ts:534-550`: `deriveGaitStanceSchedule` walks the resolved keyframes assigning each
whole span to exactly one foot, merges same-side runs, then emits
`contacts: valid.map(w => ({foot, fromMs, toMs}))`. Each window's `toMs` **is** the next window's
`fromMs`, so the windows *partition* the timeline — no instant has two feet bearing. By contrast
the deterministic walk measures ~21% double support (`gaitDoubleSupport.test.ts`), and
`gaitEnrichment.test.ts:293-297` pins the contiguity as intended behaviour.

**Symptom:** an enriched AI walk transfers weight in a single frame — one foot bearing, the next
instant the other, with no shared-floor overlap. The body hitches at each handoff.

### R9 — Footfall impact is capped at 1 cm and saturates early *(cosmetic, but pervasive)*

`rootMotion.ts:1562-1569`: dip 0.005–0.01 m, saturating at
`HEEL_STRIKE_REF_DESCENT_M_S = 0.25` m/s. I confirmed the accent contributes nothing measurable to
the pelvis arc (9.45 cm with it on and off).

**Symptom:** every footfall lands with the same barely-perceptible 5–10 mm dip. A brisk heavy step
and a gentle one are visually identical at contact — the body never looks like it catches its own
weight. There is no push-off counterpart either: accents fire only at stance-window **starts**
(`stageComposedDerivations.ts:319`).

### R10 — The legs are an exact mirror; the only asymmetry is arm amplitude *(noticeable)*

`healthySignature.ts:108-110` touches `L_UpperArm` / `R_UpperArm` `shoulderFlexion` and nothing
else; `:34` documents why ("leg-channel asymmetry… feeds the foot-driven travel derivation… would
push against rig gates"). The walk's two half-cycles are byte-identical mirrors, and
`paceFloorSymmetry.test.ts` pins 0% L/R step-time asymmetry.

**Symptom:** footfalls land on a perfect metronome, left and right identical to the millimetre.
Over more than a few steps the walk reads as a looped animation rather than a person.

### R11 — The trunk never flexes or extends through the cycle *(noticeable)*

`gaitModifiers.ts:330`: "Only `rotation` + `lateralTilt` on the spine — NEVER sagittal `flexion`,
which would shift the world-anchored `shoulderFlexion` motor." And the walk template authors **no
`Spine` target at all** in any of its 8 phases (grep over `movementTemplates.data.ts:320-500`
returns nothing).

**Symptom:** from a sagittal camera the torso is a stiff column riding the pelvis — no small
forward-back oscillation over the stride, no trunk response to loading or push-off.

### 3.2 Claimed by docs, NOT verified here

- **Foot-skate on the in-place walk/run.** The docs report a skate ratio of 1.0 with the gate
  downgraded to `warn` via `travelEpsM` (`validityGate.ts:166, 274`). The threshold and the warn
  downgrade are real in code; I did not re-measure the ratio after the retime, and the retime
  changed the pace, which changes skate. **Re-measure before acting.**
- **Toe/ankle floor penetration (~4 cm toe, ~6 cm ankle headroom).** The tolerances are real
  (`validityGate.ts:170-171`) and the toe-vs-ankle floor-reference mismatch argument is sound, but
  the measured penetration figures predate the retime.
- **`_ikIterations = 4` as a global plant weakness.** Now **stale for plants**: `footContact.ts:57`
  raises plant solves to 8. The shared default is still 4 for pose editing and exam-command IK
  (`poseRig.ts:~474`) — the split is deliberate and scoped.
- **The squat hard-failing the ROM invariant.** The completeness critic reports that
  `validityGate.ts:468-471` reads only `def.range` and ignores `weightBearingMax`, so a legitimate
  32° planted ankle registers as a 12° violation. The code reads that way, but `'squat'` is not in
  the shipped sweep and I did not run `assessValidity` on it. **Plausible, unconfirmed.**
- **Stage overlay modules being behaviourally unguarded.** `stageBreath.ts` has no test references
  and three sibling overlay modules are covered only by source regex. Structurally true; the
  runtime consequence is a risk, not an observed defect.

---

## 4. What is already gated — and what regresses silently

### 4.1 The strong gates

Most realism tests load the real male runtime GLB, apply the anatomic pose, capture a rest
reference, resolve through the production resolver, and sample through the same offline sampler the
live stage mirrors. A pass generally means measured kinematics, not bookkeeping. Four patterns do
the heavy lifting:

1. **Byte-identity contracts.** `distalEnergy.test.ts` pins speed-1 to JSON equality;
   `settleShapes.test.ts` pins `'deliberate'` to exact float equality per quaternion component;
   `healthySignature.test.ts` pins non-arm channels to 1e-9°; `heelStrike.test.ts` pins
   outside-span isolation to <1 nm and <1e-6°. These make an unintended side effect impossible to
   land quietly.
2. **Explicit counterfactuals.** `balanceCoordination.test.ts` strips the authored counterbalance
   and proves the stripped copy topples. `validityGate.test.ts` injects four defects and checks
   each flips exactly one check. `footContact.test.ts` measures the un-planted moonwalk.
   `floorMargin.test.ts` authors a keyframe 5 ms above its floor. `gaitTemplate.test.ts` rejects a
   thin 2-keyframe walk.
3. **Determinism assertions everywhere** — enforcing the kinematic charter: no hidden live
   controller can come back.
4. **Documented baselines in headers**, so tightness is auditable.

Highest-value specific gates to know:

| Property | Gate | Threshold |
|---|---|---|
| Perry phase fractions + **cadence in band** | `gaitPerryTiming.test.ts:67-68` | half-cycle 572 ms exact; cadence within `CADENCE_SPM` |
| Double support | `gaitDoubleSupport.test.ts` | 0.15–0.25 of stride; no-contact run <300 ms |
| Vertical calibration accuracy (**in-place only**) | `gaitBounce.test.ts:64, 108` | within 0.6 cm of 3/5/8 cm targets |
| Stance-foot slide | `gaitTravel.test.ts:149-150` | <0.03 m (<0.05 m at speed 1.45) |
| In-window drift at three paces | `gaitContactSync.test.ts` | <0.04 m; release <0.08 m and <10°/frame |
| Trunk/head coordination | `spinalCoordination.test.ts` | head lateral <2.5 cm, roll <2.5°, yaw <6°; rotation ≥1.8× lean |
| Follow-through ordering + overshoot | `trajectoryFollowThrough.test.ts` | strict delay ordering, legs exactly 0; ballistic overshoot −1.5°…−6° |
| Spline velocity | `splineVelocityCap.test.ts` | ≤1.3× class cap (measured 1.10×) |
| Retune safety across the whole catalogue | `floorMargin.test.ts` | every keyframe clears its velocity floor by ≥10 ms |
| Loop seam | `motionTrajectoryLoop.test.ts` | C0+C1 at the wrap; never within 15° of standing |
| Run absorption + flight | `runParity.test.ts` | knee yields 6–16° past the drive knee; both feet airborne |
| Healthy asymmetry | `healthySignature.test.ts` | 2–4%, scales sum to 2, non-arm within 1e-9° |

### 4.2 UNGUARDED — a retune regresses these with a fully green suite

This is the list to keep open while tuning.

| Property | Why nothing catches it |
|---|---|
| **Stride length, step width, walking speed, walk ratio** | `STRIDE_M`/`STEP_WIDTH_M`/`SPEED_MPS`/`walkRatio` are referenced only from `normativeGait.test.ts:267-302`, asserted equal to themselves. Zero runtime or rig callers. **This is how R1 landed.** |
| **Measured cadence** | `gaitPerryTiming.test.ts:66` computes cadence from authored `durationMs`. Nothing derives step frequency from sampled foot-contact events, so a resolver/governor/pace change that alters realized timing is invisible. |
| **Per-joint waveform conformance to the Perry curves** | `gaitBiomechCheck` computes it; `gaitBiomechCheck.test.ts:99-104` deliberately declines to assert it passes. Only an injected +45° offset is caught. All checks are `warn`. |
| **Vertical CoM for everything except the straight walk** | The generalizing check uses the widened [2,9] cm band, warn-only. Run, travel-run, curved walk, figure-eight and turn have no vertical band of their own. |
| **Head vertical bob and head pitch** | `spinalCoordination` gates head *lateral*, *roll* and *yaw*. Nothing bounds vertical excursion or pitch — so the missing heel-strike head nod is both unimplemented and ungated. |
| **Swing-foot clearance on travelling gaits** | The only clearance gate (`gaitTemplate.test.ts`, >0.05 m) is on the **in-place** template. No travel gait gates it, and nothing anywhere sets an *upper* bound — a march-height swing passes. |
| **ML shuttle and double support beyond the straight walk** | Both are asserted on `buildTravelWalk` alone. A curved walk's shuttle could be zero or 10 cm with no failure. |
| **Settle shape / terminal overshoot on any shipped motion** | `trajectoryFollowThrough` and `settleShapes` build *synthetic* motions. No test asserts a shipped template carries a `functional`/`ballistic` final class — so reclassifying everything to `deliberate` would silently delete all overshoot and late-brake shaping. |
| **Smoothness / jerk as a physical quantity** | The only thing named "jerk" is `seamJerkMaxMs` (`validityGate.ts:169`), a 12 m/s teleport detector. No third-derivative bound anywhere; it is also sample-rate dependent, so raising `sampleHz` makes it ~2× more permissive. |
| **Self-collision / limb interpenetration** | Zero coverage. Only *floor* penetration is gated. An arm through the torso or thighs crossing the midline fails nothing. `stsArmStrategy.test.ts` asserts hand-to-thigh distance is *small* with **no minimum** — driving the hand into the leg makes it pass harder. |
| **Cadence drift as observed behaviour** | `cadenceRate` is gated as pure math and consumed at exactly one line (`ExamStage3D.svelte:2195`). No test observes drift on a recording. |
| **Validity-gate breadth** | `assessValidity` sweeps 9 motions; `floorMargin` sweeps 25 templates + 28 builders. ~40 shipped motions get no skate/penetration/seam-jerk/CoM/ROM grading. And the sweep only asserts `overall !== 'fail'` and `score > 0.5`. |
| **14 of 25 templates assert nothing on the rig** | `movementTemplates.test.ts:151,157` filters the ±6° round-trip to `PRIMARY[t.id] ?? []`, empty for ankle/hip/stepping-strategy, kick, endpoint-reach, heel-raise and the AROM screens. They load the GLB, sample, and assert nothing. |
| **Jump/hop magnitude ceilings** | `jump.test.ts` requires >0.3 m rise with no upper bound; `singleLegHop.test.ts` asserts one fact (>0.08 m clearance). A 1.5 m superhuman vertical passes. |
| **Ballistic gravity** | `ballistic.test.ts` accepts implied acceleration anywhere in **0.5*g* to 2.0*g*** and a 2×-height airtime ratio anywhere in [1.2, 2.0] (theory √2 ≈ 1.41). |
| **Turn pivot-foot budget** | `turnInPlace.test.ts` allows **0.15 m** of planted-foot drift — 5× the walk's 0.03 m — self-described as generous. |
| **Effort beyond breathing rate** | Nothing asserts tempo asymmetry, bracing, or any amplitude/timing coupling separating maximal from light effort. |
| **`peakAt` leads outside squat and hinge** | Only two leads are gated. Nothing asserts that deleting a `peakAt` from a shipped template breaks anything. |

### 4.3 Gates whose bounds are deliberately loose

Know these before mistaking them for quality bounds — each is a blow-up detector, annotated as such
in its file: `splineVelocityCap` 1.3× vs measured 1.10×; `groundingSeam` 8 cm/frame vs measured
~2.7; `turnInPlace` 15 cm pivot; `ballistic` 0.5–2.0*g*; `footContact` 0.08 m planted slide and
0.12 m vertical float (its own comment says "best-effort") against `gaitTravel`'s 0.03 m.

---

## 5. Coupling map

Nothing here moves alone. These are the clusters.

### 5.1 Cadence ⇄ stride ⇄ vertical bob ⇄ foot slide — **the tightest loop in the engine**

```
walk phase durations (movementTemplates.data.ts:339…)
   │  requires
   ├─► velocityClass 'functional' → VELOCITY_CLASS_MIN_KEYFRAME_MS (motionSequence.ts:584)
   │                                and VELOCITY_CLASS_CAPS (:100)
   │
   ├─► cadence ──► deriveFootDrivenTravel (rootMotion.ts:978)
   │                  │
   │                  ├─► emergent STEP LENGTH ── (not authored; UNCHANGED by the retime —
   │                  │        └─► stride, speed, walk ratio  ← R1
   │                  │
   │                  └─► plant residual ──► FOOT_PLANT_IK_ITERATIONS
   │                           (footContact.ts:57 — raised 4→8 *because of* the retime)
   │
   └─► deriveVerticalCalibration (rootMotion.ts:718) ──► clamped by
            GAIT_VERTICAL_MAX_RISE_M (motionRecording.ts:352)  ← R2
              └─► pelvis height over the pin ──► effective leg length
                     └─► feeds back into emergent step length
```

The retime is the proof of the coupling — one cadence change forced a plant-iteration change (CCD
residual grows with per-frame root travel, so 4 passes no longer held the < 4 cm slide budget).
Step length itself did NOT move: it is geometry, not timing. **Treat cadence, vertical clamp and
plant convergence as one parameter; step length is coupled to the authored hip/knee excursion
instead.**

### 5.2 Arm swing ⇄ trunk rotation ⇄ gaze ⇄ head steadiness

`spinalGaitCoordination` derives thoracic rotation from the **L/R arm-swing difference**
(`gaitModifiers.ts:458`), so:

- Authored arm amplitude → `kAx` (`:367`) → thoracic rotation → capped at `SPINE_AXIAL_MAX`
  (`:229`) → inherited by the neck → countered by gaze stabilization within `SPINE_NECK_MAX`
  (`motionSequence.ts:558`) → residual roll cancelled by `NECK_AXIAL_ROLL_COMP` (`:315`) → gated at
  head roll <2.5° and yaw <6° (`spinalCoordination.test.ts`).
- `scaleArmSwing` therefore damps the **trunk** automatically — a coupled, visible change, not a
  local one.
- `healthySignature`'s split is **sum-preserving** (scales sum to exactly 2) precisely so the
  reciprocal *difference* — the rotation driver — is untouched. Break the sum and trunk rotation
  shifts and every head-steadiness gate moves.

### 5.3 Shuttle ⇄ trunk lean ⇄ head position ⇄ base width

`GAIT_SHUTTLE_CM` (`movementLocomotion.ts:147`) → `GAIT_SHUTTLE_ABSORB_DEG` (`:150`) split
0.45 lumbar / 0.55 thoracic → `leanUpper` counter −0.6 (`gaitModifiers.ts` region) → head lateral
<2.5 cm gate. Independently, the realized shuttle is capped at `0.6·|stanceX|`
(`rootMotion.ts:~1256`), so **`widenStep` changes the shuttle** — a narrow stance silently sways
less than authored.

### 5.4 Vertical clamp ⇄ heel strike ⇄ plant target

The accent dip is *subtracted* from the captured plant target (`motionRecording.ts:1094`) so the
foot is not buried. Raising the accent therefore shifts work onto the loading knee; raising
`GAIT_VERTICAL_MAX_RISE_M` rounds the double-support valley but over-reaches the stance leg and
pushes on the 0.03 m slide gate.

### 5.5 The duplicated enrichment constants

`GAIT_ENRICH_VERTICAL_CM` / `SHUTTLE_CM` (`gaitEnrichment.ts:91, 94`) are **copies** of the builder
values, cross-asserted by test rather than imported. Retune one without the other and AI-composed
and deterministic walks visibly differ in bob and sway.

### 5.6 Live-only overlays ⇄ measurement

`idleLiveliness` / `motionLiveliness` / clinical sway / eyes all perturb the screen and are undone
before the recording tap (`ExamStage3D.svelte`, order pinned by `stageReliability.test.ts` and
`idleLiveliness.test.ts`). Consequence: **the screen and the graded recording legitimately differ**,
and any new overlay must join the same sandwich or it will contaminate goniometry.

### 5.7 Cross-cutting: what `motionLiveliness = 0` suppresses at once

One dial gates motion-time breath, motion-time micro-sway, **and** cadence variability
(`ExamStage3D.svelte:932, 2195`; `stageMotionLiveliness.ts`; `liveliness.ts:173`). Three separately
built realism features share one off switch.

---

## 6. Honest constraints

### 6.1 Rig caveats

- **Grounding is a vertical floor pin plus foot-plant IK, not a full foot-lock.** This single fact
  explains R6 (pelvic yaw held at half physiologic), R2 (the vertical smoothing must be clamped),
  and the multi-centimetre slide budgets. `rootMotion.ts:240` and `gaitModifiers.ts:240` both say so
  in comments.
- **No pelvic-list DOF.** `normativeGait.ts:413-418`: `PELVIC_OBLIQUITY_NORMAL_DEG = 6` ships with
  the note that the rig "has NO pelvic-list DOF today… obliquity is NOT yet measurable." The
  pelvis stays level in the frontal plane, so Trendelenburg — a core PT finding — cannot be shown.
  Note the earlier rejection of a pelvic-list DOF was argued on *vertical-CoM* grounds (Gard &
  Childress / Kuo), which does **not** cover obliquity or fault fidelity. This is a live open
  decision, not a settled one.
- **Feet-only contact keys** for the standing pin (`CONTACT_KEYS` = feet + toes). Multi-contact
  postures use posture-scoped arithmetic rather than the contact set.
- **Toe-only support does not exist** as a base patch: toes drive the vertical pin but are never IK
  effectors, so through heel-off and push-off the engine believes that foot is not supporting the
  body.
- **One Character-Creator skeleton**, and `referenceHeightWorld` is 1.97 m (male) — unusually tall.
  Anything expressed as a fraction of stature is scaled by that.
- **No blink morphs** — stripped at export (`eyeGaze.ts` header). A hard asset ceiling; eye
  rotation is the whole budget.
- **`rootYOffset` is authored (−0.18) and applied nowhere** — grep finds only the type declaration
  and the literal. `sceneBoot` applies only `rootScale`.
- **ROM clamping defaults OFF in the browser, ON in node** (`poseRomClamp.ts:~281-290`, returns
  `typeof window === 'undefined'`). So the headless recording is clamped and live playback IK
  generally is not — the same motion can be a different shape on screen and in the recording. The
  one in-browser enabler is the hand-posing layer, which restores the default afterwards.

### 6.2 Non-negotiable operating principles (from `docs/`)

These are settled. Work inside them.

1. **The kinematic charter.** No forces, GRF, torque, or live balance controller. Physics is
   *mimicked at author/build time*; playback stays deterministic. The COM instrument is consulted,
   never fed back live.
2. **The house pattern.** New naturalism ships as pure, additive, ROM-clamped, per-keyframe
   transforms in the `spinalGaitCoordination` / `stabilizeGaze` family — zeroed in clean mode,
   invisible to grading.
3. **Rig-gate everything.** Every change lands with a headless-rig regression test measuring
   world-space behaviour. No gate, no merge.
4. **Stage/sampler lockstep.** Every transform must apply byte-identically offline and live —
   recording = grade = screen. Enforced in practice by shared derivation helpers; the docs
   correctly flag this as "a convention, not a type-enforced invariant," and two lockstep breaks
   (DET-LOCK-01/02) were once invisible to every recording and test.
5. **Product-claims boundary.** Normative *kinematics* within ±1 SD may be claimed. Dynamic
   consistency, GRF, joint moments, muscle force and EMG are **out of charter — never claim**.
6. **Exaggeration is deliberately withheld.** Clinical fidelity is the identity; the one exception
   (high-knee march) is scoped and labelled in code.
7. **ROM legality and measured round-trip.** Authored peaks must pass the clamp *unchanged* and
   measure back within ±6° on the rig. An authored value that exceeds ROM is a defect, not an input
   to be silently clamped.
8. **Determinism is enshrined in a test** (`balance.test.ts`). Repetitions are bit-identical
   replays.

### 6.3 What this architecture structurally cannot do

- **No physics-based recovery or perturbation response.** The kinematic camp is a deliberate
  architectural choice, affirmed in `docs/design-benchmark-redteam.md` on the grounds that RL
  controllers cost non-determinism, non-auditability and loss of exact clinical control. Any
  physics corrector would have to be optimization-based, byte-reproducible and explicitly flagged.
- **Balance is purely static.** `signedDistToConvex` takes only a position — there is no COM
  velocity or extrapolated-COM term anywhere. Nothing distinguishes a controlled fall-forward
  (which is what walking *is*) from a topple, which is exactly why COM-driven postural control must
  be excluded for all gait. Every travelling, looping, floating or grounding-posture motion is
  exempt from the CoM check.
- **No stochasticity in the deterministic path.** No RNG in the resolve/trajectory core;
  `reps` replays identical knots, so rep 1 and rep 20 are pixel-identical — no fatigue, no
  amplitude decay, no timing drift. The only seeded variation is `healthySignature` (arm amplitude)
  plus the live-only overlays.
- **Weight bearing is binary**, a 5 cm ankle band with no graded loading — so the support base
  snaps from two feet to one in a single frame.
- **The base of support is one hard-coded adult rectangle**, never scaled to the body variant.
- **Elbow/knee frontal-plane deviation cannot be commanded.** A frontal re-aim is geometrically
  indistinguishable from the geometric hinge-flexion term, so it would read as ~1:1 phantom
  flexion. Valgus must be built from the hip. Related: the elbow/knee flexion readout *is* the raw
  parent-vs-child angle, so pure sideways deviation is currently *measured as flexion*.
- **The world-frame shoulder readout saturates** past horizontal and reports phantom
  flexion/abduction under trunk flexion. The mitigation is a display mask plus a manual driver
  allowlist; the *recorded* series is unfiltered.
- **Nine registry ROM fields have no command path**, including all three pelvis fields — so the
  lumbopelvic region is a welded block in every animation.

---

## Appendix — measurement provenance

Everything in §0 was measured by me on this working tree with a temporary probe test:
`buildTravelWalk()` → `resolveComposedMotion` → `sampleComposedMotion` at **120 Hz** on
`models/painmap3D_male.runtime.glb` with `BODY_VARIANTS.male`, using the same harness pattern as
`gaitTravel.test.ts:36-72`. Step length was taken as Hips Z displacement across one steady stance
window (`gaitStanceWindowsMs[1].fromMs → [2].fromMs`, 1037 → 1609 ms = 572 ms). Hip height for
Froude was the frame-0 Hips world Y (1.079 m). Biomech figures are `runGaitBiomechChecks(resolved,
frames, { floorY: 0 })`. The probe was removed; the suite is green at 106 files / 1179 tests.

Raw output:

```
resolved durations: [300,285,114,169,169,120,114,169,169,250,450]  total 2309 ms
Hips p2p:               9.45 cm      (accent OFF: 9.45 cm — accent-independent)
stance windows:         R 0→1037, L 1037→1609, R 1609→2309 (travelLock)
steady half-cycle:      572 ms   → cadence 104.9 spm
step length (STEADY):   0.773 m  → stride 1.547 m   (whole-clip peak 0.912 m — entry-inflated)
steady speed:           1.352 m/s
walk ratio:             0.00737  (band 0.0055–0.0075 — IN band)
hip height:             1.06 m   → Froude (steady) 0.176
biomech froude:         pass=true   measured=0.031   ← whole-clip, 7x under-read
biomech vertical-com:   pass=true   measured=7.4     ← band widened to [2,9]
biomech normative-knee: pass=false  measured=0.19
biomech normative-hip:  pass=false  measured=0.19
biomech normative-ankle:pass=false  measured=0.43
```
