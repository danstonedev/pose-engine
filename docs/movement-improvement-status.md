# Movement improvement status

> Historical status and source findings. Use the
> [master movement-joint catalogue](MASTER-MOVEMENT-JOINT-CATALOGUE.html) for
> current defects, reference coverage, work ownership and acceptance. Record
> updates there. Dates, work-list labels and measurements below describe their
> original checkpoints; this document remains supporting historical evidence.
> Reconciliation is partial; the master retains pending sources and open gaps.

Reviewed 1 October 2026. Standing stance/dowel shipped in engine #166 as
`e55a020`; its final cloud run passed 2,637 tests and a clean typecheck.
Host release outcomes are recorded in the workspace's October 1 shipment report.
This is the current work list. `improvement-roadmap.md` and the older entries in
`outstanding-work.md` preserve earlier plans and measurements; their old OPEN
labels are not a current inventory.

Lower-reach follow-up: the Blender-derived lower reach now raises the wrist 3.57–4.31 cm
on all bodies. All 12 sampled trajectories retain canonical/rendered torso/head
clearance and shoulder capacity. This change passes 2,643 engine tests; host shipment is tracked separately;
the opposite-scapular endpoint remains open. See [the measured change](lower-reach-followup.md#blender-derived-improvement--1-october-2026).

## Implementation in this change

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
physics editor. This is a native material authoring bridge; deployment is tracked in the host PR.

Whole-body surface coverage and host integration take priority over more
isolated endpoint fitting. The companion simMOVE foundation now gives all 23 body segments passive contact
cells. Torso triangle clipping recovers the lumbar surface and retains shared
neutral seam intersections. Native lumbar displacement is mapped back to the
actual skin, including vertices with no waist-bone weight. Posed seam continuity
and full surface coverage still require separate qualification.
simLAB/kinematic playback parity, neutral-variant native support, finger contact,
patient material calibration and actual hand/back contact remain open.
See simMOVE's `docs/blender-body-physics.md` for the implemented scope.

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
| 1 | Lower hand-behind-back reach — improved locally | Blender-derived coordination raises the wrist 3.57–4.31 cm, with zero measured canonical/rendered torso/head envelope penetration at 60 Hz in 12 contexts. Deployment, opposite-scapular contact and reciprocal fist completion remain open. See [measurements](lower-reach-followup.md). | Calibrated endpoint/palm contact, clinical review and live-host agreement on all bodies/sides. Retain the existing ROM/capacity and clearance gates; record genuinely unreachable targets explicitly. |
| 2 | Loaded palm contact | Chair assistance and assessment push-up/rotary-clearing still lack demonstrated flat-palm skin contact. Bird-dog support/release also needs continued surface validation. | Actual skin contact and no penetration through setup, loading, release and return, with patient bounds retained. Bone anchors alone are insufficient. |
| 3 | In-place gait grounding | The September 29 studio review retained sliding, toe-floor and some hand/thigh warnings. Travel-gait clearance tests do not establish in-place contact validity. | Reproduce each warning on current source, distinguish frame-time-dependent diagnostics from geometric defects, then pass floor/clearance checks across body models and playback speeds. |
| 4 | Restricted squat geometry | Default support was improved; limited ankle range and restricted-depth cases remain incompletely validated. | Capacity sweeps with achieved depth, sole contact, balance estimate and explicit refusal/residual reporting. Default-squat passes do not close this item. |
| 5 | Native physics tracking | The #162-era 41/64 numerical completions and 32/64 sampled tracking passes are historical. The companion foundation shipment refreshes all 64 contexts; its exact results belong in simMOVE docs/assessment-physics-results.md and the shipment evidence. | Keep the 64-case matrix current with source/fixture hashes; address loaded floor support and dynamic balance failures without loosening gates. Preserve completion, tracking and clinical acceptance as separate results. |
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
