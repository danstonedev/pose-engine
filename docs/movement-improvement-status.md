# Movement improvement status

Reviewed 2 October 2026. Standing stance/dowel shipped in engine #166 as
`e55a020`; its final cloud run passed 2,637 tests and a clean typecheck.
Host release outcomes are recorded in the workspace's October 1 shipment report.
This is the current work list. `improvement-roadmap.md` and the older entries in
`outstanding-work.md` preserve earlier plans and measurements; their old OPEN
labels are not a current inventory.

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

The new simLAB sampler comparison passes 9/9 on checkpoint `82c9c5b`; its arms
match the shared engine. Full current playback qualification in both hosts is
still pending. Fresh native trials of that checkpoint with the unqualified v17
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
| 5 | Native physics tracking | The October 2 follow-up has 44/64 numerical completions and 32/64 sampled tracking passes; all prior tracking passes remain. Twenty native stops and floor-motion tracking remain open. Exact source hashes and results are in simMOVE docs/assessment-physics-results.md. | Keep the 64-case matrix current with source/fixture hashes; address loaded floor support and dynamic balance failures without loosening gates. Preserve completion, tracking and clinical acceptance as separate results. |
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
