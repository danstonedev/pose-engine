# Blender movement workflow

Apply the [movement engineering charter](movement-engineering-charter.md) to each
improvement. Establish acceptance criteria before tuning, audit the actual runtime
path, and preserve distinct interchange, contact, tracking, clinical and delivery
results. The charter includes the longer-term whole-body roadmap and constraints.

## Use the master catalogue throughout each movement change

The single [master movement–joint catalogue](MASTER-MOVEMENT-JOINT-CATALOGUE.html)
is the workspace's requirements and review ledger. The current generator lives
in simLAB at `scripts/movement-inventory/`; it stores the source inventory and
tracking records inside that same HTML. Browser-only records become available
to file-reading tools after **Save updated master file** and replacement of the
workspace copy with that saved file.

1. **Select and establish intent.** Identify the exact motion ID, body, side and
   phase. Review all joint/bone rows. Assign task-appropriate roles and owners:
   driven, derived, held, contact, free or explicitly not involved. Keep the
   pelvis-to-head chain and shoulder attachment coherent. Helper and digit
   groups can share a documented controller; no direct target does not prove
   that a segment is stable or irrelevant. An intentional stabilizer need not
   have visible excursion.
2. **Author from those requirements.** Use the existing shared controls/recipes
   and an actual-rig Blender project. Define task-specific timing, orientations,
   support and limits before tuning. Translate the requirements into existing
   `BodyControlPhase` declarations where supported, with an explicit plan for
   the remaining digit/helper bones. A catalogue entry is a requirement, not
   a per-frame controller or a reason to add motion indiscriminately.
3. **Validate observed behavior.** Measure relevant local and world transforms
   through setup, approach, hold, return and loop. Check coordinated curvature,
   pelvic participation, cervical/head behavior, shoulder attachment, skin and
   support rather than only target counts or endpoints. Run the exchange,
   patient/clinical bounds, both-host and affected native checks below. Include
   sibling contexts that use the changed shared controller.
4. **Refresh and close only evidenced scope.** Regenerate the same master after
   code/asset changes; embedded records are retained and older source identities
   become stale. Attach project/capture/report/test references to the applicable
   context and phase. Leave failures and missing evidence open. Human visual
   review, contact acceptance, native tracking and clinical acceptance require
   their own evidence; selecting Verified cannot substitute for them.

From the simLAB checkout:

```powershell
$env:SIMMOVE_CATALOGUE_ROOT='../simmove'
node scripts/movement-inventory/run.mjs refresh
node scripts/movement-inventory/run.mjs sample
node scripts/movement-inventory/run.mjs check
```

Build and CI now enforce current source/asset/native/dependency identities, every required bone role, actual-rig constraints and current scoped review manifests. Refresh preserves the frozen historical unreviewed baseline and existing records. Read [the enforced process](movement-catalogue-process.md) for sampling and evidence requirements. Historical motions remain unreviewed; incomplete motion work cannot ship merely because numerical construction passes.

## Required for every movement — 2 October 2026

Blender authoring and full-motion review are required for new and revised movements,
including locomotion, floor transfers, screening motions, trunk, legs, arms and head.
The requirement applies to the entire body. A numerical completion or low wrist
tracking error does not establish a natural movement.

1. Export the actual production motion and skin into a fresh review directory.
2. Author coordinated movement in Blender. Establish stable support anchors and
   elbow/knee bend directions; inspect body contact, tissue clearance and head/neck.
3. Review setup, approach, hold, return and loop from multiple views on all three
   body models and applicable sides. Keep the editable project and evidence.
4. Transfer the result into the shared engine. Validate clinical/patient bounds,
   bone and rendered-skin exchange, contact stability and motion continuity.
5. Review the complete result in simMOVE and simLAB. Re-run affected native trials
   and record source tracking separately from numerical completion.

The floor-support work now has an actual Blender authoring project at
`movement-realism-implementation/blender-workspace/floor-support-authoring-2/floor-support.blend`.
It contains twelve editable scenes (four movements on three models), bilateral
palm anchors and elbow guides, with stretching disabled. The normalized layout
in `floorPalmSupports.ts` comes from these controls. The scenes currently author
the middle pose. `floor-support-timing-1/floor-support-timing.blend` authors the
one-second push-up approach on all three imported animations. Full-cycle and
clinical validation are still required. Other
movements must not be marked Blender-reviewed until their own evidence exists.

Export floor references from a host with dependencies installed:

```powershell
node node_modules/vite-node/vite-node.mjs pose-engine/scripts/blender/export-review.ts ../blender-workspace/floor-review-new floor
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python pose-engine/scripts/blender/build-floor-support.py -- ../blender-workspace/floor-review-new
```

The exporter also accepts a `ComposedMotion` JSON file in place of `floor`, so
any movement can use the same actual-rig export and measurement path. The floor
control builder is specific to floor supports; author the appropriate support
controls for other movements rather than reusing an unrelated pose.

## Full animation review and exchange

Use a fresh directory for each candidate. From the simMOVE host checkout:

```powershell
node node_modules/vite-node/vite-node.mjs pose-engine/scripts/blender/export-review.ts ../blender-workspace/movement-review-new path/to/movement.json
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python pose-engine/scripts/blender/build-motion-review.py -- ../blender-workspace/movement-review-new
node node_modules/vite-node/vite-node.mjs pose-engine/scripts/blender/verify-roundtrip.ts ../blender-workspace/movement-review-new
```

Use `floor` instead of the JSON path to export the four current floor-support
movements on all three models. For a sided movement, export and review the JSON
for each applicable side. The manifest records source and asset hashes, sampled
poses, rendered twist deformation, timing and bone/skin reference measurements.

For an already retained dense native-source recording, use
`scripts/blender/export-retained-recording-review.ts <dense-export-manifest.json> <fresh-folder>`
through the same `vite-node` runner. This replays the recorded whole-body locals,
including baked twist, without rerunning the motion solver. It verifies the exact
model and recording hashes and checks that all recorded bone worlds reconstruct
from those locals before writing review GLBs. Then use `build-motion-review.py`,
`verify-roundtrip.ts` and `render-motion-review.py` as above. The review keeps the
capture's original source identity and development limitations; a successful
exchange does not qualify its movement or native simulation.

### Verify the press-up in both development hosts

`scripts/browser/verify-pressup-host-parity.mjs` mounts the real shared stage on
each running Vite host and compares its public capture against an independent
rig at seven setup, motion, hold and return times. It preserves the existing
0.01 degree / 0.1 mm parity and 0.05 degree patient-bound checks. It also checks
served model bytes, the browser ROM-clamp mode, identical shared source across
hosts and unchanged runtime source during capture. This is delivery evidence;
motion, native contact, visible skin and full product controls have separate
checks.

Provide a JSON configuration with `playwrightModule` pointing to an installed
Playwright ESM entry and `hosts` keyed by host name. Each host supplies `origin`,
the Vite `engine` URL prefix and the engine checkout's `sourceRoot`. Filesystem
paths resolve relative to the configuration file. simMOVE uses its `/models/`
URLs. For simLAB, set `modelResolver` to `/src/lib/painMapAssets.ts` so male/female
use the actual product asset resolver. The additional neutral check loads the
shared engine rig and is explicitly identified as component coverage, since the
simLAB product selector exposes male/female only. The script discovers dependency
URLs from the compiled stage, avoiding a second unversioned Svelte runtime.

```powershell
node scripts/browser/verify-pressup-host-parity.mjs path/to/hosts.json path/to/fresh-report all all all
```

Optional filters are host name, `male|female|neutral`, and
`default|patient-feasible|patient`; `all` selects the full dimension. Reports keep
failures, browser diagnostics, screenshots and source/configuration identities.
Restart a stale development server if it serves `Outdated Optimize Dep`; retain
the failed run before rerunning. Do not treat a harness boot failure as a motion
pass or alter movement tolerances to clear it.

The exporter accepts a final integer sample rate from 15 to 240 Hz (default 30).
For a dense check of the current extension-clearing recipe, preserve both the
recipe and a fresh export:

```powershell
node node_modules/vite-node/vite-node.mjs pose-engine/scripts/blender/export-assessment-json.ts extension-clearing ../remaining-batches/extension-clearing-new.json R
node node_modules/vite-node/vite-node.mjs pose-engine/scripts/blender/export-review.ts ../blender-workspace/extension-review-new ../remaining-batches/extension-clearing-new.json 60
```

Run the build, roundtrip and complete-skin checks above/below on that new folder.
The manifest distinguishes the explicit `supportPlaneY` from `restContactFloorY`.
Extension clearing opts into world zero; recipes without the field retain their
previous convention. Compare support geometry on a common named floor before
interpreting a change in penetration.

Open `full-motion-review.blend`, choose each body/movement scene, and play the
whole timeline. Saved side, front, back and overhead cameras support inspection;
markers identify setup, middle and return. The project retains full animations,
not only the authoring pose. Preserve separate authoring scenes and record
contacts, joint bends, skin clearance, head/neck and transitions seen in review.

The import and replay comparison both use the unchanged 0.1 mm bone/skin gate.
Imported sampled tracks are exported as active actions without integer-frame
rebaking, preserving fractional terminal keys (for example 1.695 seconds).
This avoids shifting the final pose during exchange. A passing comparison
establishes interchange fidelity; movement acceptance still requires visual,
contact, clinical and affected native checks in both consuming apps.

Current reference evidence includes twelve full-animation scenes in
`floor-support-motion-3/full-motion-review.blend`. Its original integer-frame
export failed the three push-up terminal checks; that evidence is retained.
`floor-support-timefix-1/roundtrip-results.json` verifies the corrected export
on all three push-up models. These are development checkpoints, not final
acceptance of subsequent contact changes.

The earlier prepared-start/contact checkpoint is
`floor-support-motion-5/full-motion-review.blend`: all twelve imports and replay
comparisons pass. Its `renders` folder covers six phases from the side and three
supported phases overhead, across all bodies. The prepared floor starts were
authored separately in `floor-assessment-start-1/floor-assessment-start.blend`.
That fixes the earlier review's standing-through-floor entrance; it does not
establish native loaded-contact stability or a completed clinical endpoint.

The subsequent `floor-support-motion-6` project corrects the elbow guide to follow
the shoulder and includes the engine's measured `floorY` in each exported case.
All twelve import/replay comparisons pass. The renderer now requires this field;
the old hard-coded plane at -25 mm hid contact defects. The engine's floor
reference is a rest bone height, not a measured skin plane, and currently sits
15–20 mm above world zero. Reconcile that datum with each host before accepting
floor contact. Projects `floor-support-authoring-3` and `floor-support-authoring-5`
retain the editable upward and tucked elbow guides; project 4's advanced palm
candidate failed contact checks and was rejected.

Measure the entire animated skin, including head/neck and fingers/toes:

```powershell
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python pose-engine/scripts/blender/measure-floor-clearance.py -- ../blender-workspace/movement-review-new
```

This reports every evaluated vertex at every exported sample, with regions
assigned by dominant skin weight. It measures geometric clearance, without
claiming pressure or compression. `floor-support-motion-6/skin-floor-clearance-2.json`
still records hand and lower-limb penetration; the first report's toe/finger
classification was wrong and is preserved separately. A passing joint check
does not supersede these skin failures.

### Measured palm support and whole-chain review

The versioned `author-palm-surface-support.py` and
`derive-palm-support-plane.py` scripts take a floor-review folder and a fresh
output directory. They currently select its `extension-clearing` cases and keep
the original whole-body animations unchanged. The first provides editable
surface/wrist targets; the second fits heel/thenar/ulnar skin patches and saves
isolated hand previews. These patch labels describe geometric regions, not
measured pressure distribution. `verify-palm-support-plane.ts` compares the
Blender fit with the shared runtime fitter.

Existing editable evidence is in `palm-surface-authoring-3` and
`palm-support-plane-2`. The fitted targets are integrated only into the local
extension-clearing candidate. Its three-body 60 Hz project is
`pressup-surface-motion-2/full-motion-review.blend`; the corresponding work-list
entry retains the unresolved elbows, lower-body support and native tracking.

For extension changes, explicitly review the complete spine, pelvis, hips,
knees, ankles and toes together with the arms and head. Record each segment's
trajectory and intended supporting skin patches through the full cycle. A stable
segment can provide support without a large visible excursion. Do not judge a
prone foot by a standing sole-flat criterion, or obtain chest height by bending
only the lumbar segment. The engine's thoracic command already spans both
`Spine_Mid` and `Spine_Upper`; do not add its regional readout to those individual
segments a second time. Use the same root/pelvis-adjusted clinical frame as the
runtime when checking world-dependent joint measurements.

### Compare the engine reference with an explicitly chosen floor

The diagnostic now preserves the original engine-reference `frames` and `worst`
fields and adds named plane summaries with first below-plane sample/time bracket,
mesh/vertex/dominant-bone witness and engine-coordinate position. It records the
Blender build, source/asset identities and script/manifest/project hashes. Phase
is explicitly unknown when the manifest only supplies review markers. It checks
exported samples, not between-sample intersections or native integration steps.

From simMOVE, compare the saved motion-6 project to world Y = 0, using a fresh
output filename each time:

```powershell
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python pose-engine/scripts/blender/measure-floor-clearance.py -- ../blender-workspace/floor-support-motion-6 skin-floor-clearance-world-new.json --comparison-floor-y 0 --comparison-label world-zero
```

Both comparison arguments are required together; no host authority is inferred
from the label. Repeat `--case male-extension-clearing --case female-extension-clearing`
to limit the run to those cases. The current native assessment support and simLAB
support reference use world Y = 0; the cosmetic simLAB floor disc is 1 mm above it.
Do not change a motion or plane merely to hide penetration.

`skin-floor-clearance-datums-3.json` measures all twelve motion-6 cases at 1,734
sampled times. Its legacy measurements are exactly unchanged from report 2.
At world zero, extension-clearing palm/finger minima are about -19.52 mm male
and -15.95 mm female; flexion-clearing toes reach -110.49 mm and -92.71 mm.
These are failures still requiring a movement/contact correction. Existing
Blender scenes and matched phase renders depict the same unchanged geometry.

The focused synthetic Blender regression also passed (exit 0), checking transformed
vertex positions, strict zero crossing, first-sample/bracket semantics, case
selection and rejection of changed source, invalid arguments or existing output.
Compact hashes and comparisons are in
[`evidence/floor-plane-diagnostic-2026-10-02.json`](evidence/floor-plane-diagnostic-2026-10-02.json).
Reproduce from simMOVE with a fresh test directory:

```powershell
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python pose-engine/scripts/blender/test-measure-floor-clearance.py -- ../blender-workspace/floor-clearance-test-new
```

Generate phase images from any full-motion review (fresh output folder required):

```powershell
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python pose-engine/scripts/blender/render-motion-review.py -- ../blender-workspace/movement-review-new
```
All movement changes must use the [single master catalogue](MASTER-MOVEMENT-JOINT-CATALOGUE.html)
and satisfy [the enforced catalogue process](movement-catalogue-process.md). Include
all actual rig bones, the complete head-to-pelvis chain and all applicable bodies,
sides and phases. Review the entire motion and retain current separate evidence.


## Whole-body physics authoring

The companion project `../blender-workspace/whole-body-foundation-v5/body-physics.blend`
contains the native female/male collision models: 23 segments each, including
head, both cervical segments and measured lumbar contact. Its 12 regional material controls export a
profile that simMOVE's local physics editor and native verifier consume.
See `../simmove/docs/blender-body-physics.md` for generation, import and the
remaining continuous-surface/host-integration work. This enhances native physics
authoring; Blender has not replaced the runtime solver.

## Movement authoring

Blender 5.2.2 LTS is now used for visual movement authoring and measured exchange
with the engine. The latest improved-reach project is in the implementation
workspace at `../blender-workspace/improved-lower-reach-v2/movement-review.blend`
(relative to this repository). The initial project is preserved at
`../blender-workspace/movement-review.blend` for comparison.

The first resulting engine improvement raises the wrist 3.57–4.31 cm and the
open hand's distal middle-finger joint 9.81–12.25 cm. The original hand target
was more ambitious than the bounded fit; see [measurements and remaining work](lower-reach-followup.md).

## Open and use the project

The project opens in **Author male-L hand target**. The wrist control is selected.

- **G** moves the wrist target. **X**, **Y** or **Z** constrains the move to an axis.
- **R** changes the palm orientation.
- To explore shoulder coordination, select **Reach authoring controls**, enter
  Pose Mode and rotate **Clavicle**.
- The Scene selector offers **Reference male-L/R**, **female-L/R** and
  **neutral-L/R**. Press Space to play; timeline markers identify approach and
  assessed hold. Frame 123 is the assessed hold at 30 fps.
- Numpad 0 toggles the rear camera view. The embedded **START HERE** text repeats
  these instructions.

The first editable control scene is male-left. All six body/side combinations
have reference animations; the other five do not yet have authoring controls.

## Export an edit

With an Author scene active, switch an area to Text Editor, choose
**EXPORT CURRENT AUTHOR SCENE**, and run it with Alt+P. This writes a new
`candidate-<timestamp>` folder beside the project, containing the baked GLB and
measurements of the Blender pose. Existing candidates are preserved.

From this repository, verify that the candidate plays the same in the engine:

```powershell
node node_modules/vite-node/vite-node.mjs scripts/blender/verify-roundtrip.ts ../blender-workspace/candidate-<timestamp>
```

A passing export check establishes bone/skin agreement at sampled times. Joint
limits, shoulder capacity, body contact and movement quality still need their
own checks before a candidate becomes a production recipe. Blender IK here is
a visual authoring control and has not been mapped to the engine's clinical
limit conventions. Stretching is disabled.

## Regenerate from current engine source

```powershell
./scripts/blender/review.ps1 -OutputDirectory ../blender-review-new
```

Use a new directory each time. `-BlenderPath` selects another Blender executable.
The workflow:

1. Samples UE pattern 1 at 30 Hz on three bodies and both sides.
2. Bakes the same render-time twist helpers used in the application.
3. Exports the reference clips with neutral review materials and source hashes.
4. Imports them into Blender and compares bone heads and sampled skin vertices.
5. Builds the editable control scene and exercises a 3 cm target move.
6. Exports the six reference animations and verifies replay in Three.js.
7. Saves the project, JSON evidence and three rear-view renders.

Review exports are intended for authoring and animation exchange. Promoting a
replacement body asset also requires topology/paint-atlas, skin-weight, naming,
bind-pose and saved-pose compatibility checks; Blender can reorder mesh data.

## Initial measured results — 1 October 2026

- Six clips, 226 frames each, eight checkpoints per clip.
- Blender import: maximum bone-head discrepancy **0.0298 mm**; maximum sampled
  skin nearest-vertex discrepancy **0.0103 mm** (rounded upward).
- Exported GLB replay: maximum bone-head discrepancy **0.0296 mm** and sampled
  skin discrepancy **0.0101 mm**, below the unchanged **0.1 mm** comparison gate.
- The authoring scene preserves the original held pose within the same gate.
  A 30 mm target move produced a 30 mm wrist move, with less than **0.001 mm**
  endpoint error.
- Strict TypeScript checks passed for both engine-side tools.
- An actual 30 mm wrist edit was exported from the saved Author scene and
  replayed in the engine. Maximum checked bone/skin differences were below
  **0.001 mm**. This was an export-path smoke test, not an accepted reach change;
  see `remaining-batches/blender-authored-export.log` and the timestamped
  candidate folder beside the project.

Evidence is in `blender-workspace/{manifest,blender-results,roundtrip-results}.json`;
execution logs remain in `remaining-batches/blender-workspace-final.log`.
Earlier failed setup attempts are retained in the dated review directories.

The first direct IK attempt used imported deform-bone display geometry and
shifted the wrist roughly 24 cm. The working authoring rig uses separate control
bones through actual joint positions, with offsets preserving the original
deformation frames. This fixes the authoring tool; it does not establish that
the production rig is anatomically wrong or complete the lower-reach task.

The revised reach has also passed this exchange check on all six cases.
`scripts/blender/fit-reach.ts` fits male-left Blender landmark displacements to
shared bounded commands on all three bodies and both sides, scaling by arm length and
penalizing refreshed torso-envelope penetration with rendered twist included.
Its output is a candidate; the production sampler must still validate both
sides, open hands/fists and the whole route before changing the recipe.

The authored target JSON contains `variant: "male"`, `side: "L"`, and `baseline`
and `candidate` maps from original bone names to engine-coordinate points in
metres. It currently supports this one authoring scene. Example:

```sh
npx vite-node scripts/blender/fit-reach.ts ../blender-workspace/raised-reach-01/target.json fresh-fit.json
npx vite-node scripts/characterize-lower-reach.ts fresh-validation.json fresh-fit.json 60
```

A fourth argument can name a previous fit to refine, and a fifth `hand-only`
argument limits refinement to forearm rotation and wrist orientation. This was
used for the final bilateral hand adjustment; every resulting route still went
through the full 60 Hz validation.

To render matching close-ups, use `scripts/blender/render-comparison.py` with
`-- <before.blend> <after.blend> <fresh-output-directory>` in background Blender.

API references: [Blender glTF import](https://docs.blender.org/api/main/bpy.ops.import_scene.html)
and [Blender glTF export](https://docs.blender.org/api/main/bpy.ops.export_scene.html).
