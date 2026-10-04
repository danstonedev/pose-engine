# Movement pipeline audit — 2 October 2026

This audit applies the [user's engineering charter](movement-engineering-charter.md).
It describes inspected source and retained evidence, not clinical approval.
Paths in the table are relative to `movement-realism-implementation`; `engine/`
means the active `simmove/pose-engine/` checkout.

## Verified state

- Engine development HEAD: `274ad55a3a84df593c12c24852ec80bc744d3d13`, also checked
  out in local simLAB. [PR #168](https://github.com/danstonedev/pose-engine/pull/168)
  remains open and draft. The user requires remaining motion work before merging.
- [Cloud run 36987592474](https://github.com/danstonedev/pose-engine/actions/runs/36987592474)
  passed: 2,648 tests plus 19 isolated timing/contact tests; typecheck reported
  zero errors and warnings. These results describe that commit, not later edits.
- Earlier local host evidence: 9/9 sampler comparisons; twelve settled browser
  captures without page/harness errors. Motion-7 GLBs are byte-identical to the
  twelve Blender-reviewed motion-6 clips. This establishes a limited authored
  playback comparison, not delivery of the native simulated result.
- The latest changed floor subset has **4/8 native completions, 1/8 tracking
  passes**. Four unchanged shoulder controls complete and pass tracking. All four
  flexion-clearing contexts stop. The historical **44/64 completion, 32/64
  tracking** matrix belongs to `2465b6d`, not the current candidate.
- Parent simMOVE/simLAB edits and the native v17 axis correction remain in
  progress. No new merge or host release occurred.

## Actual architecture

### Subsequent bounded implementation

The later local `pressup-surface-motion-2` candidate implements an explicit
world-zero plane for extension clearing, measured palm skin support orientation
and height, and current torso/pelvis skin grounding. It also fixes unwanted
prepared-start spline motion. These are opt-in authored-contact changes, not
native tissue forces. The floor-convention gap below still applies to the other
recipes. Full measurements and remaining failures are in
[the current work list](movement-improvement-status.md#latest-local-candidate-press-up-skin-support).

The latest native comparison isolates another pipeline disagreement. Female
source capture shifts the skin by at most 0.139 mm, but native initialization
lifts the model 20.77 mm after pose fitting. The same upper-torso contact hull
at its source transform reaches -2.888 mm; after native retargeting it reaches
-19.770 mm. The extra 16.88 mm is a pose-representation effect. The source-exact
placement is diagnostic, not proof that those source transforms are attainable
within the native joint model. Resolve joint conventions and retain unattainable
residuals before considering controller tuning. Female full-step prefix tracking
reaches 15.5967 degrees and fails the unchanged 15-degree gate.

The same candidate has three passing Blender roundtrips and both-host authored
playback checks. Feet/pelvis support and complete press-up extension remain open.
The native route still omits the prepared setup second, captures sparse target
poses, and fits its own joint representation. It is not identical playback of
the dense Blender animation, and its forces must not be attached to that clip.

| Responsibility | Inspected implementation and limits |
| --- | --- |
| Production anatomy and appearance | `engine/src/anatomy/bodyVariants.ts`, `shoulderRigAssets.ts`, and runtime GLBs bind rig mappings and assets. Male/female/neutral authored playback exists. An animation skeleton alone is not proof of anatomical joint validity. |
| Authored motion and contacts | `engine/src/services/assessmentBodyMotions.ts`, `floorPalmSupports.ts`, `footContact.ts`, `rootMotion.ts`. Blender controls informed normalized support layouts; the engine still evaluates bounded motion and contact commands. |
| Editable motion exchange | `engine/scripts/blender/export-review.ts`, `build-motion-review.py`, `verify-roundtrip.ts` export actual skin and bone tracks, including twist helpers, and verify Blender exchange. GLB does not carry the native physical configuration. |
| Native anatomy and dynamics | `simmove/experiments/lower-body/{model,authored-anatomy,assessment-task,assessment-support-controller,authored-task-controller}.mjs`. MuJoCo drives bounded motors, gravity and represented contact. Native fixtures exist for female and male; neutral remains unsupported here. |
| Contact and materials | The same directory's `body-tissue-profile.mjs`, `physical-contact-settings.mjs`, `deformable-contact.mjs` define 12 regional profiles and passive cells on 23 segments, including head and both cervical segments. These are engineering parameters, not calibrated patient tissue. |
| Blender physical authoring | `simmove/scripts/blender/{export-body-physics.mjs,build-body-physics.py,export-tissue-profile.py}` inspect compiled native geometry and exchange material values. Blender geometry, joint and mass edits are currently reference-only. |
| Local physical calculation/replay | `simmove/src/editing/AssessmentPhysics.svelte`, `assessment-physics-runner.mjs`, `movement-editor.mjs`, and native `physics-worker.mjs` calculate and replay session body/contact states. `EditingWorkspace.svelte` restricts native calculation to local development. Saved trial evidence does not include replay frames. |
| Student playback | `simlab/packages/ddx/src/movement/sampler.ts` calls shared `sampleComposedMotion`. Existing geometric contact/deformation is not native MuJoCo replay or native regional-material parity. |

### Trial identity

`authored-route-packet.mjs` fingerprints the route, source binding, physical
settings and controller. The worker and runner verify those identities.
`AssessmentPhysics.svelte` invalidates replay when those inputs change;
`movement-editor.mjs` clears physical skin state when restoring authored playback.
Saved history explicitly compares trial inputs. Playback viewing speed is separate
from physical settings. The legacy squat/ASLR panel permits older replay with a
visible mismatch warning; this audit did not establish silent misattribution there.
Retain and test these protections as native replay is extended to simLAB.

## Consequential gaps

1. **Floor and skin geometry disagree.** `rootMotion.ts` derives `floorY` from the
   lowest rest foot/toe bone center. `footContact.ts` places the palm's wrist
   center on it. The male/female/neutral references are respectively 20.23, 16.98
   and 15.35 mm above world zero. Native assessment support in `model.mjs` and
   simLAB's `props/support.ts` use world Y = 0 (the cosmetic simLAB disc adds
   1 mm). A stable wrist does not prove palm skin support. The old Blender
   report measured only against the engine reference.
   simMOVE's main shared stage grounds the initial skin bounding box at world zero;
   no visible floor mesh was found in that main scene. Its separate movement
   editor uses a cosmetic floor at -1 mm and grid at zero. The new comparison
   plane is therefore explicitly labeled `world-zero`, not silently presented
   as a universal host-rendered floor.
2. **Dynamics are not delivered to students yet.** Authored simLAB playback and
   local native trials are different paths. Native completion and tracking do
   not establish rendered-skin contact or approved runtime delivery.
3. **Material density needs an explicit experiment.** `deformable-contact.mjs`
   assigns each cell the region's full stiffness. Regional response cannot be
   assumed invariant when cell count or geometry changes. Measure force versus
   displacement and recovery under controlled loads before choosing any density
   normalization or claiming calibration.
4. **Coverage and sampling remain limited.** Joint seams, posed skin/collider fit,
   fingers, native neutral fixtures and clinical endpoints remain open. Native
   stop gates run each integration step; the matrix tracking maxima are sampled
   at approximately 100 ms. Those tracking values are not full-step maxima.

## Bounded improvement selected

Extend the existing Blender skin-floor diagnostic before tuning another contact
candidate. Preserve engine-reference measurements and add an explicitly named
comparison plane, first below-plane sample/time bracket, and a mesh/vertex/bone
witness in engine coordinates. Record actual tool/project/manifest identities.
Do not infer clinical phases from generic review markers. This fixes measurement
ambiguity; it does not fix the underlying movements or qualify native trials.

Acceptance defined before implementation:

1. All twelve existing animation cases retain their previous per-frame regional
   minima and worst times exactly at the original engine reference plane.
2. Against an explicit world-zero plane, each clearance changes only by the
   recorded plane offset. Use the same geometry and timestamps.
3. First-crossing records distinguish already-penetrating setup from a later
   crossing and identify the exact evaluated mesh/vertex plus previous/current
   sample times. Zero is a geometric plane crossing, not a clinical tolerance.
4. Reports identify source/model/GLB/project/tool inputs and sample scope; they
   refuse to overwrite existing evidence and reject invalid comparison inputs.
5. No production motion, rig, patient bound, solver gate or native material changes.
   Preserve the failing skin examples. Do not substitute this diagnostic run for
   new native or host motion qualification.

The result and exact reproduction commands are recorded in the workspace shipment
log and [Blender workflow](blender-workflow.md). Use
`blender-workspace/floor-support-motion-6/full-motion-review.blend` for the matching
editable full-cycle scenes; the earlier matched side/overhead images remain in
`remaining-batches/blender-floor-review-sheets-6`. No new motion improvement is
claimed by these diagnostic views.

The all-case run `skin-floor-clearance-datums-3.json` retained all legacy results
exactly across 12 cases and 1,734 sampled times. The world-zero comparison still
finds press-up palm/finger minima of -19.52 mm male / -15.95 mm female, and
flexion-clearing toe minima of -110.49 mm male / -92.71 mm female. The geometry
did not improve in this diagnostic change. The observations now identify which
plane, time and actual vertex need to be examined.

## Prioritized progression

1. **Palm-supported benchmark:** use extension clearing on both native bodies to
   measure a real palm support point and reconcile the engine, skin, collider and
   world-floor conventions. Female native tracking currently passes; male does
   not. Establish full-cycle skin/support, joint and tracking criteria before
   tuning. Check neutral authored playback and both hosts, then native timestep
   sensitivity/repeatability. Raising the whole root can conceal one defect while
   creating floating knees or feet, so inspect all supports and head clearance.
2. **Remaining floor motion:** repair flexion-clearing leg/foot support and late
   self-contact stops, push-up tracking and setup, and press-up endpoints. Rerun
   the full 64-context matrix once these bounded cases meet their separate gates.
3. **Shared anatomy/contact/material foundation:** cross-system axis and neutral
   tests, posed collider/skin coverage and seams, density/geometry sensitivity,
   regional compression/recovery experiments, explicit supported parameter ranges.
4. **Delivery and reusable benchmarks:** persist replay plus its identities,
   synchronize native state/forces/deformation in simLAB, invalidate edited trials,
   and extend coverage to hand-on-back, deep squat and supine/side-lying support.
   Add a supported jump/landing only when a suitable controller exists.
5. **Broader task families:** gait, turns, transfers, stairs and equipment, then
   loading/dynamic recovery/inversions. Contact transitions and actuator limits
   need explicit criteria. Existing recipes require fidelity work, not replacement.
6. **Teaching and future capabilities:** licensed mocap and retargeting, task-goal
   authoring, validated body/stance/load/speed variations, clinician-defined
   impairment profiles, synchronized traces/multiview overlays, supported student
   experiments, datasets with provenance, and runtime/geometry detail budgets.
   Keep presentation details separate from biomechanical evidence; use specialist
   muscle or volumetric solvers only for a demonstrated unsupported requirement.

The [current backlog](movement-improvement-status.md) retains the concrete open
issues, including 81 SFMA breakout contexts, shoulder calibration and clinical
review. None are closed by adopting the charter.

## Tools and assumptions

The installed executable reported Blender **5.2.2 LTS**, build `d13f752e3b9c`.
Automation uses the existing local Python/CLI path; no Blender MCP connection is
assumed. Attempts to fetch the official versioned 5.2 Scene/Depsgraph documentation
returned HTTP 402 during this audit. Installed execution and existing API usage
are the evidence for the diagnostic; online versioned API verification is unverified.
No dependency upgrade or new physics engine is part of this change.
