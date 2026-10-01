# Blender movement workflow

Blender 5.2.2 LTS is now used for visual movement authoring and measured exchange
with the engine. The initial project is in the implementation workspace at
`../blender-workspace/movement-review.blend` (relative to this repository).

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

These results show that the existing incomplete reach survives Blender exchange
faithfully at the checked samples. The next step is to use the controls to
investigate shoulder, elbow and palm coordination, then test a candidate against
the existing engine limits and actual surface clearance.

API references: [Blender glTF import](https://docs.blender.org/api/main/bpy.ops.import_scene.html)
and [Blender glTF export](https://docs.blender.org/api/main/bpy.ops.export_scene.html).
