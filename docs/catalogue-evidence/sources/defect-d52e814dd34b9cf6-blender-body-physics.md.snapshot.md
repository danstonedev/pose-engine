# Whole-body physics authoring in Blender

Future work follows the user's
[movement engineering charter](../pose-engine/docs/movement-engineering-charter.md)
and the [current pipeline audit](../pose-engine/docs/movement-pipeline-audit-2026-10-02.md).
The audit distinguishes authored playback, local native calculation/replay and
student delivery. These paths do not yet establish native contact parity in simLAB.

Blender edits a single material profile consumed by simMOVE's native MuJoCo
controller for all 20 core movement entries. The profile covers head, neck,
trunk, pelvis, shoulder girdle, upper arm, forearm, hand, thigh, shank, foot and
toes. Both sides use the same regional properties. Current native fixtures are
female and male; this does not establish native support for the neutral variant.

This enhances the existing simulation workflow. Blender Bullet/Soft Body has
not replaced MuJoCo. The project displays compiled native collision geometry,
and exports solver material settings separately from GLB animation. Blender's
[glTF exporter](https://github.com/KhronosGroup/glTF-Blender-IO/blob/main/docs/blender_docs/scene_gltf2.rst)
supports skeletal/morph animation, not automatic transfer of its physics setup.

## Generate and open

From simMOVE, choose a new directory:

```powershell
node scripts/blender/export-body-physics.mjs ../blender-workspace/body-physics-new
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python scripts/blender/build-body-physics.py -- ../blender-workspace/body-physics-new
```

Open `body-physics.blend` from that directory. **Whole body - female/male**
shows the actual collider surfaces. Each model has 42 passive surface cells and 65 core/surface shapes. The Outliner also contains hard cores and
joint-bound reference arrows. All 23 segments have passive contact cells: four
head cells, four lumbar cells, and a cell on each cervical segment.

Choose **Body tissue materials**, select **Tissue - head** (or another region),
and edit **Object Properties → Custom Properties**:

- `maximumThicknessM`: maximum passive layer travel in metres; primitive
  envelopes cap this to fit their size. Measured convex cores are rebuilt with
  the chosen inward offset. An impossible core fails compilation.
- `stiffnessNPerM`: stiffness per passive cell, in N/m.
- `dampingTimeS`: damping equals stiffness times this value.
- Sliding, torsional and rolling friction: native contact coefficients;
  torsional and rolling friction use metres. Native contact mixing still applies.

Cell count is mechanically relevant: `deformable-contact.mjs` currently gives each
cell the full configured regional stiffness. Before changing cell density or
geometry, run controlled regional force/displacement and recovery comparisons.
Density-invariant regional behavior and patient-specific calibration have not
been established. Do not silently rescale stiffness or call a denser mesh a more
accurate material model without that evidence.

In the Text Editor, run **EXPORT WHOLE BODY MATERIALS** with Alt+P. It writes a
new JSON candidate beside the project. Editing properties does not recalculate
the displayed geometry. Geometry edits, segment masses, joint bounds and
collision exclusions are reference-only in this first authoring bridge.

## Use the profile

In the local editor, choose **Physics → Contact model · advanced → Import body
properties from Blender**. Load the exported JSON. The same profile feeds the
physical calculation and editing support. Changing it invalidates trial inputs;
previous captures remain intact. **Restore default body properties** resets it.

The existing native verifier also accepts the file:

```powershell
node scripts/verify-core-physics.mjs --inputs=<captured-input-directory> --filter=cervical-flexion --tissue=<exported-json> --out=<new-report.json> --no-probes
```

The schema requires all 12 regions and rejects unknown keys, wrong units,
nonfinite values and values outside its engineering input bounds. Recorded
contact metadata retains the resolved profile and per-segment cell coverage.
The underlying controller/version and settings hashes prevent old trial evidence
from silently matching a different material model.

## What this establishes, and what remains

The default material values are preserved. Imported profiles are engineering
experiments, not patient-calibrated tissue. A supplied 20%-softer profile is a
controlled exchange test; it is not promoted as a better clinical default.

The native foundation now includes material validation, source-bound geometry,
passive contact on every represented segment, skin displacement, exact trial
identity, reproducible Blender exchange, and automated regression checks.
Defaults remain unchanged engineering assumptions. It is ready for further
contact calibration; this does not mean all movements or tissue behavior are
physically validated.

The lumbar gap is fixed using actual skin triangles clipped at summed torso
influence 0.5 and neutral joint heights. Each torso neighbor retains the shared
cut vertices; tests require both padded hulls to enclose every seam intersection.
The display uses the same measured region assignment so a lumbar cell can deform
skin even when the original rig gave that skin no waist-bone weight. Skinning
weights, source bones and masses are preserved. The unarticulated diagnostic
model retains its original full-trunk primitive.

Remaining geometry work: pose-dependent seam continuity, other joint gaps,
complete source-skin coverage, hand/finger articulation and local compression on
all sides of each curved cell. Head/neck compliance still needs calibration;
jaw/eyes and individual fingers are not independent native contact bodies.

| Path | Current contact/material behavior |
| --- | --- |
| simMOVE native calculation and replay | All 23 female/male segments; one 12-region material profile; recorded native forces and skin displacement. |
| Blender authoring | Exact compiled collider review and strict material exchange; edits require recompilation to affect geometry. |
| simMOVE authored playback | Kinematic pose path; no native force parity is claimed. |
| simLAB and embedded engine playback | Existing geometric contact/deformation; the native material profile is not yet consumed here. |
| Neutral body variant | Engine movement support exists; native fixtures remain female/male only. |

Hand-on-back contact, calibrated scapular endpoints, dynamic balance and loaded
movement acceptance remain on the work list. Numerical completion does not close
them. The source geometry is a coarse envelope, not volumetric tissue.

## Verification

`body-tissue-profile.node-test.mjs` checks both complete native fixtures, loaded
compression response in all 12 regions, profile identity, mass/joint/exclusion
preservation and compiled head/trunk display geometry. `probe-material-exchange.py`
opens the saved Blender project and exports a controlled edit in all regions.
`blender-results.json` compares every exported collider vertex with its native
position at a 0.1 mm gate. Reports and renders remain outside the repository.

The foundation verification includes both native fixtures, measured torso seam
containment, native loaded response in all 12 material regions, actual lumbar
skin deformation under body rotation, mass conservation, reset determinism,
resting support and unchanged stop gates. The full engine suite passed 2,643
tests. The final native assessment suite passed all 31 tests, including relaxed
prone, supine and hands-and-knees holds on both models.

Blender 5.2.2 reproduces every collider vertex within 0.000123 mm (0.1 mm gate).
The final project is in the implementation workspace at
`../blender-workspace/whole-body-foundation-v5/body-physics.blend`.
The Blender probe changes stiffness by exactly 20% in all 12 regions; defaults
are not replaced. Its imported cervical-flexion browser trial completed 3.2 s,
with no terminal failure or page error. Import, missing-head rejection, capture
preservation, native profile consumption and reset all pass. Native dependencies
are preloaded during development so the first calculation does not trigger a
Vite dependency-discovery reload.

## Foundation shipment evidence (before the moving-contact follow-up)

The fresh 20-movement / 64-context native matrix ran every case with gravity,
bounded motors, passive contact and self-collision. It recorded **36 clock
completions, 28 stopped cases, zero integration/invariant errors, and 32 sampled
tracking passes**. All 32 previously passing tracking contexts still pass.
Those diagnostics use sampled joint error <=15 degrees, pelvis error <=5 cm,
and captured segment error <=15 degrees. They are not per-step or clinical
acceptance. Motor-off and zero-gravity probes produce different native outcomes.

Compared with the September 30 report, six unchanged source routes now stop:
flexion clearing on both bodies/sides (self-contact residual), male extension
clearing and male push-up (passive-cell travel). Female multisegmental extension
now reaches its end. None of those seven contexts met the tracking diagnostic
before or after. The additional stops require contact/coordination investigation;
they are not silently accepted or removed from the catalog. Joint bounds, motor
capacities and stop thresholds were not relaxed.

See [the refreshed per-movement results](assessment-physics-results.md). Next
work is posed seam/contact qualification, moving floor support and coordination,
hand/back and palm contact, shared kinematic-host behavior, and calibrated tissue.
The work list must distinguish these tasks from the completed material/import,
measured neutral torso and state-transport foundation.

`scripts/verify-blender-body-profile.mjs <profile.json> <new-report.json> [base]`
reproduces the isolated editor/native exchange test. The PR verification workflow
runs types, app/engine tests, native regressions and a production build without
deploying a feature branch.

[Committed per-case foundation evidence and source hashes](evidence/body-foundation-2026-10-02.json).

## Moving-contact qualification - 2 October 2026

Implementation and qualification evidence for contact v8, paired with [pose-engine #168](https://github.com/danstonedev/pose-engine/pull/168). The host pull request records release/deployment status.

- All six additional foundation stops now complete. The full matrix improves from 36 to **44 completions**, with **20 stops**, **32 retained sampled tracking passes**, and no installation/invariant errors. No prior completion or tracking pass was lost.
- Only female/male extension-clearing routes changed. A measured anterior pelvis support point and combined shoulder abduction/rotation reduce the male setup's native lumbar floor clearance from 117.2 mm to 11.7 mm. Native dynamics still determine subsequent support; the pelvis is not pinned during simulation.
- Shared skin activation margin is 0.9 mm; travel stops activate up to 1 mm before the unchanged bounds (capped at one quarter of layer thickness). Requested stop time constant is 2 ms, subject to MuJoCo's existing timestep safety clamp. These are numerical settings, not new tissue calibration.
- The 1 mm contact candidate completed more cases but lost two male ASLR tracking passes; it was rejected. A 0.7 mm candidate retained ASLR but left female flexion-clearing stops. Increasing Blender trunk damping, reducing the timestep alone and alternative prone arm/IK seeds were also rejected. Their evidence remains in the implementation workspace.
- Blender review: `../blender-workspace/posed-contact-review/posed-contact.blend`. Eight contexts include initial, quarter-duration and final native collider collections (the final 120 ms also remains in JSON). Maximum vertex exchange error is 0.000241 mm against a 0.1 mm gate. Head and cervical colliders are included. These samples do not establish continuous source-skin coverage or closed joint seams.
- Browser verification imports all 12 material regions, rejects a missing-head profile, preserves captures and historical evidence, and completes the cervical trial in 3.2 s with no page errors. This remains a local development calculation.

Remaining work: the 20 stopped contexts are hurdle step (4), in-line lunge (4), rotary stability (4), multisegmental flexion (2), multisegmental rotation (4), and legacy SFMA squat (2). The eight recovered contexts still fail the sampled tracking diagnostic. Loaded palm orientation/contact, source target tracking, moving seam/skin coverage, neutral native fixtures and broader host parity remain open. A focused playback regression verifies measured pelvis support on the neutral kinematic model; it does not supply the missing neutral native fixture.

Reproduce contact captures with `node scripts/blender/inspect-posed-contact.mjs <inputs-directory> <fresh-output-directory>`, then run `scripts/blender/build-posed-contact.py` in Blender background mode with that output directory after `--`. The inspector's optional numerical overrides are diagnostic mutations after setup; only runs without overrides qualify compiled defaults. `scripts/blender/create-material-candidate.py` creates a separate Blender material candidate and verifies that unrelated profile fields are retained.

[Exact case comparison](evidence/posed-contact-2026-10-02.json), [full matrix](../../remaining-batches/posed-contact-qualified-matrix.json), and [per-movement status](assessment-physics-results.md).
