# Movement improvement status

Reviewed 2 October 2026. Standing stance/dowel shipped in engine #166 as
`e55a020`; its final cloud run passed 2,637 tests and a clean typecheck.
Host release outcomes are recorded in the workspace's October 1 shipment report.
This is the current work list. `improvement-roadmap.md` and the older entries in
`outstanding-work.md` preserve earlier plans and measurements; their old OPEN
labels are not a current inventory.

The user's [movement engineering charter](movement-engineering-charter.md) is now
the standing brief for future improvement work. Apply it alongside this measured
backlog and the Blender workflow. Detailed whole-pipeline findings and the next
bounded experiment are in [the current audit](movement-pipeline-audit-2026-10-02.md).

Lower-reach follow-up: the Blender-derived lower reach now raises the wrist 3.57–4.31 cm
on all bodies. All 12 sampled trajectories retain canonical/rendered torso/head
clearance and shoulder capacity. This change passed 2,643 engine tests and shipped in engine #167, simMOVE #130 and simLAB #333;
the opposite-scapular endpoint remains open. See [the measured change](lower-reach-followup.md#blender-derived-improvement--1-october-2026).

## Standing stance and dowel shipment

The standing-stance and overhead-dowel implementation passed 2,632 local engine
tests, then all 2,637 final tests in cloud CI after additional coverage was
recovered from the standalone checkout. Host release status is recorded separately. It supports
simLAB movement controls, simMOVE
standing endpoint controls, a shared stance transform, palm-based dowel placement,
and a regression found during release review: sagittal trunk compensation must
preserve the shoulder's complete orientation during an overhead squat.

## Already implemented

- Whole-body squat, hinge, chair transfers, upper reaches, push-up and bird-dog
  recipes shipped in engine #157/#159 and host integrations. The remaining
  contact limitations below do not mean those recipes are absent.
- Shoulder rotation/readout corrections, combined proxy-capacity enforcement,
  and overhead/reaching revisions shipped in #158/#160/#162. The production rig
  still uses a single girdle proxy; independent assets from #161 are experimental.
- Phase-specific gait impairments, pelvic articulation and leg clearance shipped
  in #163. Arm swing, overhead coordination and default support improved in #164.
  One-foot-at-a-time stance setup and centered squat support shipped in #165.
- Jog/run/sprint builders, travel walking/running, walk initiation/termination,
  step turns, figure-eight walking, balance-strategy templates and rigid log
  rolls already exist. See `movementLocomotion.ts`, `movementTemplates.data.ts`,
  and `movementPostures.ts`. Jog/run/sprint choices are exposed in simLAB.
  These features need specific residual fixes or validation, not reimplementation.
- simLAB's accessible goniometer changes shipped in #331. They are a host
  instrument improvement, separate from movement or clinical acceptance.

## Whole-body physics foundation

Blender now has a shared body-material authoring bridge in simMOVE. One profile
covers 12 regions, including the head and both cervical segments, and is consumed
by native physics across core movement families. The native collision models
can be reviewed in Blender, and exported profiles imported into the local
physics editor. The authoring/material foundation shipped in simMOVE #130; simLAB #333 pins the paired engine. Native calculation remains local development only under simMOVE's existing guard.

Whole-body surface coverage and host integration take priority over more
isolated endpoint fitting. The companion simMOVE foundation now gives all 23 body segments passive contact
cells. Torso triangle clipping recovers the lumbar surface and retains shared
neutral seam intersections. Native lumbar displacement is mapped back to the
actual skin, including vertices with no waist-bone weight. Posed seam continuity
and full surface coverage still require separate qualification.
simLAB/kinematic playback parity, neutral-variant native support, finger contact,
patient material calibration and actual hand/back contact remain open.
See simMOVE's `docs/blender-body-physics.md` for the implemented scope.

## Last qualified contact baseline - 2 October 2026

The contact qualification change resolves all six new foundation stops. The refreshed 64-context matrix has **44 numerical completions, 20 stops, 32 retained sampled tracking passes**, and zero installation/invariant errors. Only the two extension-clearing sources changed; 62 source routes are unchanged. A shared measured pelvis support point and combined humeral abduction/rotation improve prone setup. The eight recovered contexts do not meet the tracking diagnostic. Exact case evidence is in simMOVE's `docs/evidence/posed-contact-2026-10-02.json`.

This is the `2465b6d` comparison baseline, not qualification of the newer floor
motion development. PR #168 remains draft at the user's request to finish the
remaining motion work before merging. A separate native left-arm axis correction
regressed that frozen matrix to 40 completions / 24 stops and remains unqualified.

## Current Blender movement work

### Current unshipped development: complete prone chain

The user authorizes commit, PR and merge when the remaining motion work is ready.
PR #168 remains draft while final host, native tracking and regression checks
run. The following implementation is local; earlier candidate-2 evidence does
not qualify the changed source.

#### Latest local corrections, after the retained checkpoint below

- The guide now begins from the actually supported elbow bend and plane, follows
  the authored bend progression, and reuses the outbound branch during return.
  The full 60 Hz source check closes all 101 bones on all three bodies within
  0.000004 degrees; maximum adjacent rotations are about 2.6 degrees ascending
  and 3.14 degrees returning, without the previous arm branch spike.
  `pressup-guide-development-summary-1.json` preserves prior failed candidates.
  `pressup-guided-production-1` is the new provisional Blender export; its
  full review and final evidence after remaining source edits are still pending.
- Screen floor framing now includes head, hands and feet in inspected male and
  female Hold/Movement views, and yields to manual camera control. A display-only
  0.00001-degree roundoff allowance fixes false OUT badges at exactly 25 degrees;
  raw measurements, strict classification and clinical ranges are unchanged.
- Removed unnecessary GPU palette updates during CPU skin probes. Exact import
  parity now passes 20/20 with the original five-second limit (3.99/3.35/3.30
  seconds for male/female/neutral). The three dense hand-surface tests also pass.
  The separate repeated restricted-patient test still exceeds its original
  limit; patient-aware guide preparation is being corrected, not the timeout.
- Lower-support repeatability now uses its single existing feasibility verdict.
  Correct test-side twist matrix propagation and measured patient hip projection
  preserve the existing clearance/range gates. Nine focused tests pass, with
  975 dense integration samples checked. No force or compression qualification
  follows from this geometric support work.
- The experimental native arm representation fits eight sparse prototype arms
  within 0.000001 degrees without the former false local shoulder stop. It
  retains joint count, mass/inertia and actuator settings, and separately checks
  anatomical admissibility in the shared frame. Full-cycle dynamics, source
  equivalence, both-host patient parity and final regressions remain open.
- Engine typecheck is clean (0 errors/warnings). The catalogue readiness check
  currently fails stale source inventory. Separately merged engine #169 requires
  review of all 1,356 available contexts after a shared-runtime change; the user
  has been asked whether to retain that full scope or adopt evidence-based
  affected-movement scope. No catalogue acceptance or shipping gate was bypassed.

#### Retained whole-chain checkpoint (superseded source)

- Shared prone support now coordinates bounded thoracic clearance, pelvis skin
  grounding and bilateral hip/knee support. It preserves authored ankle/toe
  posture within patient limits and reports infeasible supports explicitly.
  Helper/integrated checks pass 6/6, including 975 dense rendered frames and
  84 helper samples, patient knee locks and following-motion state isolation.
  Workspace evidence: `prone-skin-support-integration-2.json`.
- Finger neutral references survive root/pelvis rebasing. Elbow/knee deviation
  clamps now use the readout's clinical side convention and patient ranges.
  A feasible-direction palm refinement preserves the original 40-iteration
  budget and contact gates. Combined regression: 126/126, unchanged default
  timeout; `hinge-clinical-consistency-evidence-1.json`. Constrained repeated
  sampling remains expensive (worst verified patient test 4.855 seconds).
- The local extension recipe now uses the Blender-reviewed whole-chain proposal8:
  pelvic tilt, lumbar/thoracic extension, cervical coordination and measured
  thigh/calf plus toe support. The actual lowest thigh surface bears support;
  distal-envelope and knee-band gaps remain separate diagnostics. Earlier drafts
  with thigh penetration or incomplete arm extension remain rejected and retained.
- A once-per-motion planner derives fixed bilateral palm anchors from actual
  segment geometry. All three default bodies reach near-straight elbows at the
  sampled endpoint. Two-phase Screen Hold and three-phase movement are supported;
  authored loops/repetitions/time scaling remain outside this planner's scope.
  Normal authored yaw is verified; changing the rig's baseline world orientation
  exposes a separate pre-existing command-frame issue before contact planning.
- `pressup-whole-chain-motion-1` contains the current editable Blender project and
  975 samples at 60 Hz. All three round trips pass the existing 0.1 mm gate
  (maximum bone error 0.0302 mm, sampled skin error 0.0252 mm). All lower-support
  solves are feasible. Full Blender skin has worst hand penetration 0.2081 mm;
  head clearance stays positive. This is geometric evidence, not measured loading.
- Independent dense clinical audit passes all 975 frames, including shoulders
  measured relative to the live thorax, pelvis, spine, head and digits. No
  registry fields are missing or outside their existing numerical tolerance.
  All 15 exported bone/rendered-skin checkpoints reproduce exactly in the engine:
  `pressup-clinical-dense-1.json`. Restricted-patient tests remain a separate gate.
- Native v21 shares the engine's wrist and forearm command frames. All 60 isolated
  and combined command cases retain identical engine poses and fit the compiled
  native axes within 0.000003 degrees. Two native DOFs, limits and actuation are
  unchanged. Source contact poses can still contain off-axis elbow play or
  distributed hand twist that these two-axis joints do not represent exactly.
  Fresh motion tracking is required; command conformance does not establish it.
- Recording now serializes the support-corrected joints even without declared
  palms. Live contacts retain resolved patient constraints when no host override
  is supplied. Editing a recorded pose invalidates its old support/layout claims.
  Focused recording/stage regression: 46/46,
  `prone-support-recording-contract-2.log`.

At the proposal8 checkpoint both hosts contained identical copies of all 125
runtime source files (`pressup-runtime-host-sync-4.json`). Default live/sampled
playback then agreed across 36 checkpoints on all three bodies; Screen Hold,
Movement, timeline, Loop and half-speed controls passed. Restricted-patient limits
held, but an infeasible support case still diverged between live and sampled poses.

Full visual review subsequently found an arm branch change near 2.23 seconds and
a return/start seam. Native v21 completes both fresh default trials but passes
neither tracking gate (sampled peak joint errors 34.07 degrees female / 22.78 male).
The earlier flexion-palm regression now passes both bodies. Contact-guide
continuity, restricted-patient parity and native source representation are under
active correction. These later edits require fresh source hashes, both-host sync
and verification; the preceding checkpoint does not qualify them. Do not attach
old native forces to changed motion.

Remaining shipment gates: full-phase visual/contact review, matching delivery in
both hosts, fresh native trials on male/female, and the existing regression/CI gates. The
single master catalogue holds 1,212 open intent/review records for this bilateral
movement; none are Verified. It must be refreshed after source changes settle.

### Historical candidate: press-up skin support

`pressup-surface-motion-2` is an **unqualified local candidate**, based on
`274ad55` with additional engine changes. Both local hosts have the same twelve
changed runtime files (content identities in `pressup-runtime-host-sync-2.json`).
The earlier eight-case floor result below describes the previous source; it is
not a fresh qualification of this candidate.

- Actual Blender palm patches determine support orientation and wrist height.
  Extension clearing now declares world Y = 0 explicitly and grounds its posed
  torso/pelvis skin. Other recipes retain their previous floor convention.
- A prepared-start interpolation defect is corrected: the initial setup
  interval now holds its pose instead of dipping toward the next spline tangent.
- All three Blender roundtrips pass the unchanged 0.1 mm gate. The 975 samples
  at 60 Hz have at most **0.172 mm hand penetration**, compared with about
  19.52 mm male / 15.95 mm female previously. Head clearance is positive and
  torso support is within numerical noise of the floor.
- Matched views expose unfinished motion: the elbows are more bent at the raised
  checkpoint, female pelvis separation reaches 19.51 mm in the separate 10 Hz
  check, and the feet/toes remain above the floor. Full press-up extension and
  physical loading are not accepted.
- Both fresh native trials complete, but only male passes sampled tracking.
  Female joint error is 15.20 degrees at the matrix samples and **15.5967 degrees
  at the diagnostic 1 ms steps**, above the unchanged 15-degree gate. Native
  retargeting adds about 16.88 mm of upper-torso floor intrusion compared with
  placing the same collider at the source transform. Joint/frame consistency is
  under investigation; no gains, capacities, geometry or gates were changed for
  this candidate.
- Verification after a measured patient-limit correction: 48 focused regressions
  pass, with a clean engine typecheck. Explicit elbow bounds now use the chart's
  geometric hinge measurement inside contact solving. A restrictive elbow/wrist
  test covers all three bodies and repeated cached playback. The unrestricted
  60 Hz GLBs remain byte identical to candidate 2. Nine simLAB sampler comparisons
  and twelve browser cases without page/harness errors preceded that correction.
  These local results are separate from the last committed cloud CI result.

The next Blender revision must explicitly coordinate the complete spine, pelvis,
hips and lower extremities, as the user requested during review. Its first
proposal is rejected for 31–53 mm forearm/elbow penetration. Subsequent geometric
authoring and clinical transfer checks are in progress; it has not replaced the
runtime recipe.

Native representation now has a separate **unqualified v19 candidate**. It keeps
the source's exactly representable central chain and uses a shared definition
of the production scapular proxy. All 64 isolated/combined pose comparisons now
fit within the existing engine proxy bounds; 52 previously exceeded the inherited
overhead-deviation native bounds. Source engine ROM values, native motor
capacities and tracking gates are unchanged. On the frozen surface-motion-2
inputs, v19 completes both trials but passes **0/2 tracking checks**. Full-step
shoulder-tilt errors reach 22.75 degrees female / 34.50 degrees male while the
10 Nm actuator saturates. One male flexion-clearing setup regression also fails
its unchanged 10 mm wrist-position gate at 19.09 mm. These failures remain open;
corrected joint semantics do not qualify loading or the wider movement matrix.

The simMOVE authored JSON import correction is implemented locally. It preserves
contacts, prepared starts, grounding and timing instead of discarding them through
the reduced AI mapper. The importer, stage and tool checks pass 92/92, with a clean
app typecheck and exact three-body press-up/gait playback comparisons. Unknown
directives are rejected explicitly. This delivery fix does not accept the motion.

Evidence: workspace `remaining-batches/pressup-surface-blender-review-2.json`,
`extension-palm-surface-native-summary-1.json`, and the October 1 shipment log.
Editable review: `blender-workspace/pressup-surface-motion-2/full-motion-review.blend`.
No merge, release, full-matrix qualification or clinical approval has occurred.

### Earlier floor-support development

Blender is required for **every new or revised movement**, across the whole body,
including head and neck. Keep editable authoring controls and full-animation
review evidence on all production models and applicable sides. A motion without
that evidence remains unreviewed; numerical completion is not movement acceptance.
See [the required workflow and reusable tools](blender-workflow.md).

Current development covers regular push-up, trunk-stability push-up, extension
clearing and flexion clearing on male/female/neutral rigs. Blender projects author
palm anchors, elbow guides, setup timing and prepared floor-assessment starts.
The shared engine retains those contacts through the motion and across an incoming
plank, with bounded palm orientation and a deterministic arm guide. The three
self-contained floor assessments start in their authored setup pose; floor
transfers are separate movements.

At development checkpoint `82c9c5b`, the full 3,555-test app/engine run and isolated 19-test hand-latch run passed, including the
unchanged continuity and parked-playback performance gates. New actual-rig tests
check palm landmarks within 2 mm, forward fingers, elbow direction, patient wrist
bounds, incoming contacts and agreement across playback rates. Twelve animations
passed Blender import/export in `floor-support-motion-5`, following the earlier
review's discovery of the standing-through-floor entrance. The prepared floor
starts and six motion phases were inspected on all three models. Typecheck
reported zero errors/warnings. These results do not qualify subsequent edits.

Subsequent simLAB catalog checks found elbow penetration in the low push-up and
press-up positions. The earlier Blender render plane was also too low. The current
candidate exports the engine's floor-reference height and uses it explicitly in
review. Elbow guides now follow the moving shoulder; keeping a fixed world-space
elbow point had constrained the girdle incorrectly. Blender authoring projects 3
and 5 set upward/tucked bend guides. The unchanged palm and clinical gates plus a
new elbow-clearance check pass in all 21 floor tests; 64 adjacent support tests
and a clean typecheck also pass (`floor-elbow-regression-12.log`,
`floor-elbow-check-12.log`). Rejected fits remain recorded in `floor-elbow-guide-*`.

All twelve current clips pass bone/skin import and replay in
`floor-support-motion-6/full-motion-review.blend`. Side/overhead phase review shows
improved arms, but a full-vertex Blender audit still finds skin below the engine
contact plane: palms/fingers about 30–41 mm and flexion-clearing feet/toes up to
131 mm. That plane is the lowest rest contact-bone height, 15–20 mm above world
zero; host floor alignment also needs reconciliation. The corrected region report
is `skin-floor-clearance-2.json`; the first report misclassified named toe bones
as fingers and is retained as invalid evidence. Stable bone anchors therefore do
not establish skin contact. Generic push-up's standalone standing-to-floor setup,
press-up extension, flexion-clearing heel contact, and loaded compression remain open.

The simLAB sampler comparison passes 9/9 on both checkpoints `82c9c5b` and
`bf34c01`; its arms match the shared engine. On `bf34c01`, twelve settled browser
captures across both hosts produced no page errors or harness failures. Six
additional simMOVE captures required manual camera adjustment to show the whole
body. These playback checks do not qualify skin contact or physical parity.
Fresh native trials of `82c9c5b` with the unqualified v17
axis correction completed 7 of 8 changed floor contexts; none passed tracking.
Male trunk push-up stopped at 0.169 s on the unchanged joint-speed gate. Four
shoulder-clearing controls completed and passed tracking. This subset does not
replace the historical 44/64 completion and 32/64 tracking baseline.

The current elbow-guide candidate was also re-exported and tested natively
(`blender-floor-native-3.json`, `blender-floor-native-4.json`). Of the eight changed
floor contexts, four complete and one passes tracking: female extension clearing
(pelvis 36.9 mm, joint 14.82 degrees, key-pose segment 12.33 degrees). Male trunk
push-up now completes, but both trunk variants still fail tracking. All four
flexion-clearing contexts now stop on the unchanged 1 mm self-contact residual
gate. Four shoulder-clearing controls still complete and pass tracking. This
mixed result is unqualified; it must not be promoted as an overall physics gain.
The isolated 19-test hand-latch file also passes for this candidate, retaining
the timing gate (`floor-elbow-hand-latch-12.log`).

Cloud CI on `bf34c01` subsequently failed the male parked-push-up timing check
(38.9 ms versus the unchanged 38.4 ms budget). The follow-up reuses residual
scratch objects and looks up a cached arm guide before solving its setup again.
The 40 floor/contact/timing tests pass locally; male/female push-up seeks measure
11.5/10.5 ms, with a clean typecheck. All twelve re-exported GLBs in
`floor-support-motion-7` are byte-identical to the reviewed motion-6 clips
(`docs/evidence/floor-support-cache-animation-2026-10-02.json`). Existing skin and
native failures therefore remain recorded; this performance correction does not
qualify them. Follow-up commit `274ad55a3a84df593c12c24852ec80bc744d3d13`
passed cloud typecheck/unit CI in run `36987592474` on 2 October 2026.
That run passed 2,648 tests plus 19 isolated tests (2,667 total), with zero
typecheck errors or warnings.
Both local consuming engine checkouts point to it. Draft PR #168 remains open;
host parent changes and the native axis correction remain uncommitted and
unqualified. The next diagnostic-only edits do not inherit a new CI run.

Next: qualify loaded palms and source/native tracking in the recovered floor movements, then the 20 remaining stops (hurdle 4, lunge 4, rotary 4, multisegmental flexion 2, rotation 4, legacy squat 2). Blender now contains timed native collider review scenes, including head/neck, but continuous skin coverage and posed joint seams remain open. The shared prone source also passes a neutral-model playback regression. Native neutral fixtures remain open; host rollout is tracked by the companion shipment and PRs.

## Remaining work and completion criteria

Blender 5.2.2 is now integrated into the [movement authoring workflow](blender-workflow.md).
Six revised reference clips pass measured import/export comparison. A male-left
hand control produced the first bounded reach improvement, now checked across
all bodies and both sides with rendered skin included. Next: calibrate the
endpoint and investigate the remaining reach/rig limitations. See
[the focused findings](lower-reach-followup.md).
The independent-rig calibration item remains open; adding estimated bones alone
does not close it.

| Priority | Work | Confirmed remainder | Evidence needed to close |
|---|---|---|---|
| 0 | Whole-body contact fidelity - foundation implemented | Shared Blender/native material profile covers head, both neck segments and all limb/trunk regions. All 23 native segments now have contact cells, with measured lumbar geometry and neutral torso seam coverage. Posed seam continuity and complete skin coverage remain open. | Continuous source-skin coverage, bounded intentional contact/compression, native model checks and shared live/sampled behavior. Material exchange alone does not close body realism. |
| 1 | Lower hand-behind-back reach — improvement shipped | Blender-derived coordination raises the wrist 3.57–4.31 cm, with zero measured canonical/rendered torso/head envelope penetration at 60 Hz in 12 contexts. Engine #167 and both host integrations shipped. Opposite-scapular contact and reciprocal fist completion remain open. See [measurements](lower-reach-followup.md). | Calibrated endpoint/palm contact, clinical review and live-host agreement on all bodies/sides. Retain the existing ROM/capacity and clearance gates; record genuinely unreachable targets explicitly. |
| 2 | Loaded palm contact | Chair assistance and assessment push-up/rotary-clearing still lack demonstrated flat-palm skin contact. Bird-dog support/release also needs continued surface validation. | Actual skin contact and no penetration through setup, loading, release and return, with patient bounds retained. Bone anchors alone are insufficient. |
| 3 | In-place gait grounding | The September 29 studio review retained sliding, toe-floor and some hand/thigh warnings. Travel-gait clearance tests do not establish in-place contact validity. | Reproduce each warning on current source, distinguish frame-time-dependent diagnostics from geometric defects, then pass floor/clearance checks across body models and playback speeds. |
| 4 | Restricted squat geometry | Default support was improved; limited ankle range and restricted-depth cases remain incompletely validated. | Capacity sweeps with achieved depth, sole contact, balance estimate and explicit refusal/residual reporting. Default-squat passes do not close this item. |
| 5 | Native physics tracking | Historical `2465b6d` baseline: 44/64 numerical completions, 32/64 sampled tracking passes. Current changed floor subset: 4/8 complete, 1/8 tracking pass; four flexion cases stop. The newer source has no qualified 64-case result. Twenty historical stops also remain unresolved. | Keep the 64-case matrix current with source/fixture hashes; address loaded floor support and dynamic balance failures without loosening gates. Preserve completion, tracking and clinical acceptance as separate results. |
| 6 | Independent clavicle/scapula rig | Opt-in assets and controls exist. Calibrated landmarks, weights, patient SC/AC/GH bounds, whole-catalog coordination and scapulothoracic contact remain open. | Asset/measurement calibration and open/loaded-chain review before production promotion. |
| 7 | SFMA breakout recipes | `movementScreen.ts` explicitly records 81 breakout contexts with no dedicated sources. Top-tier recipes are not breakout coverage. | Dedicated active/passive/load-specific recipes and accurate capability reporting, with per-context verification. |
| 8 | Shared contact/deformation behavior | Contact, self-collision, compression and native physics remain dependent on host and playback path. A shared solver alone does not establish host parity. | A capability matrix and integration checks for simLAB, simMOVE, embedded playback and recordings; explicit unsupported cases. |
| 9 | Locomotion/transfer fidelity | Natural segmental rolling remains separate from existing rigid log rolls. Running flight/grounding seams and contact-point travel derivation still have documented residuals. Existing turns/transfers need current rendered review. | Measured current baselines per defect; contact-point rather than ankle-only slide metrics; preserve intentional log-roll behavior and motion seams. |
| 10 | Assessment endpoint criteria | Upper-pattern scapular contact, shoulder-clearing palm contact and cervical chin/face landmarks are not established by the current source notes in `assessmentUpperMotions.ts`. | Measure the named landmarks and contact criteria on each body/side before claiming completed clinical endpoints; retain explicit partial/unsupported outcomes. |
| 11 | Complete audit refresh | The 420 engine + 960 simLAB inventory is a September 29 snapshot from before later releases. Full rendered review, metadata/gap reconciliation and clinical signoff remain incomplete. | Resample current source with provenance, review rendered motions, reconcile exact coverage, and retain unsigned clinical records until actually reviewed. |

## Older measurements requiring revalidation

The historical ledger also records excessive sprint flight duration, capped
pelvic excursion, run lateral sway, saturated girdle protraction, legacy
world-frame shoulder-abduction ambiguity and a recording `angles`/`pose`
discrepancy. Do not quote their old magnitudes as current measurements. Reproduce
them against the present engine before choosing a fix or claiming closure.
`RUN_TOEOFF_Y_M` and `RUN_TOUCHDOWN_Y_M` remain fixed constants in current source;
sample-dependent flight/grounding seams therefore remain a concrete follow-up.

The old statement that planted pelvis rotation necessarily counter-rotates the
root was superseded by the shared-control correction in #156 and its support
regressions. The old statement that only walking has pelvic channels is also
stale: both run builders use `spinalGaitCoordination`, which authors pelvic
rotation, obliquity and tilt. Their running-specific fidelity still needs review.

## Evidence policy

Source presence, automated tests, rendered review, native dynamics and clinical
acceptance are distinct. A release closes only the items it actually verifies.
The detailed September 29–30 reports and immutable baseline remain in the
workspace's `movement-realism-implementation/remaining-batches/` directory.
The shipment record tracks exact merged revisions and deployment outcomes.
Source implementation does not imply that every host has deployed it.
