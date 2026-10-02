# Lower reach follow-up — 1 October 2026

Status: Blender-derived improvement implemented locally for UE pattern 1 and
the lower arm of reciprocal shoulder mobility. The released version remains
the earlier low-back recipe until this change is shipped. This advances priority 1 in
[the movement work list](movement-improvement-status.md).

## Blender-derived improvement — 1 October 2026

The male-left wrist control was moved 8 cm upward, 3.5 cm posteriorly and 2 cm
medially, with a 45-degree hand turn. That visual target was fitted to bounded
engine commands with torso clearance in the objective on all three bodies.
The hand fit was then checked on both sides to account for their different
rest geometry; both hands now angle upward without changing the wrist height.
The engine achieves part of that target; the unrestricted Blender pose is not
used as a replacement runtime animation.

The accepted local recipe coordinates shoulder abduction/retraction, elbow
flexion and hand orientation. The approach, timing, neutral trunk, original
meshes and ROM/capacity limits remain the same. The final peak commands are
`[-60, 15, 70, 115, -30, -25.5, 40, 20]` in the `arm()` parameter order.

| Body | Wrist raised | Distal middle-finger joint raised (open-hand UE1) |
|---|---:|---:|
| Female | 4.09 cm | 10.59–10.71 cm |
| Male | 4.31 cm | 11.83–12.25 cm |
| Neutral | 3.57 cm | 9.81–10.00 cm |

Measurements compare the assessed hold with the preserved shipped baseline.
Both sides and both lower-arm contexts were checked: 12 trajectories, 451
samples each at 60 Hz. Canonical and rendered-twist skin had **zero measured
torso/head envelope penetration**, including the other arm. Shoulder capacity
excess was zero; minimum lower-arm proxy margin exceeded 67 degrees. Requested
commands resolved without clamping. This is sampled envelope clearance, not
exact skin contact or a guarantee between frames.

The six revised UE1 clips also passed Blender import and GLB replay checks.
Maximum replay discrepancy was 0.0296 mm for bone heads and 0.0099 mm for sampled
skin, below the existing 0.1 mm gate. Matching before/after renders are retained
for all three bodies. Regression coverage now checks the wrist-height gain,
upward finger direction, fixed trunk and rendered skin throughout the route.
All **2,643 tests in 180 files** passed; engine typechecking reported zero errors
and warnings, and both diagnostic tools passed strict TypeScript checks.
The local simLAB page played UE1 with no browser errors and was confirmed to
load the working engine. This is a browser smoke check, not measured live/sampled parity.

An earlier fit was rejected: it passed a static neutral torso envelope but
penetrated the refreshed female torso envelope by 4.19 mm. The fitting tool
now refreshes that envelope for the posed and rendered body. A proposed
approach-timing change was not needed and was not applied.

Workspace evidence:

- `remaining-batches/raised-reach-final-trajectory.json`: source hashes and
  every measured frame; its runtime recipe matches this change.
- `blender-workspace/raised-reach-01/`: authored visual target and editable project.
- `blender-workspace/improved-lower-reach-v2/movement-review.blend`: actual revised
  engine clips and hand controls, with parity reports alongside it.
- `blender-workspace/improved-lower-reach-v2/comparison/`: matching close-ups
  for all six body/side combinations.
- `remaining-batches/raised-reach-engine-tests-v3.log`,
  `raised-reach-engine-check-v2.log`, `raised-reach-tools-typecheck-v2.log`
  and `blender-reach-preview.json`: final verification outputs.

**Still open:** calibrated opposite-scapula endpoint, exact hand/back contact,
reciprocal fist scoring/closure, clinical review and deployment. The movement
is a better partial reach; priority 1 is not complete.

## Original baseline measurements

Source: engine `e55a02003515a83c86b3b8c79b928b185877db8c` (release #166).
These commands describe the original baseline runs before the recipe changed:

```sh
npx vite-node scripts/characterize-lower-reach.ts baseline.json
npx vite-node scripts/characterize-lower-reach.ts elbow120.json 120
```

On the current source, record the revised movement with
`npx vite-node scripts/characterize-lower-reach.ts fresh-current.json current 60`.
Compare with the preserved original JSON; running the script now does not
recreate the old recipe automatically.

The diagnostic records every tracked source/model hash, its own hash, the Git
revision and working-tree status. The source digest is checked again at the end.
It covers UE pattern 1 and the lower arm of reciprocal shoulder mobility, both
sides, on female, male and neutral runtime models: 12 contexts per candidate.
The production sampler runs at 60 Hz; skin is inspected at 10 Hz plus the mapped
assessed hold and final frame. Assessed hold is at 4,100 ms in these recordings.
Neutral shoulder attachment exclusions are established before sampling; torso
and head envelopes are refreshed at each inspected pose.

## Findings

The released recipe showed zero lower-arm torso/head envelope penetration at
the inspected frames in all 12 contexts. Lower shoulder proxy capacity excess
was zero throughout the 60 Hz recordings; its minimum margin was approximately
65.7 degrees. These results do not establish scapular contact or clearance
between sampled frames.

Changing only peak elbow flexion from 100 to 120 degrees raised the wrist, but
also moved arm/hand skin inside the torso envelope in every context:

| Body | Wrist height gained | Maximum torso-envelope penetration across contexts |
|---|---:|---:|
| Female | 6.52 cm | 35.69–48.69 mm |
| Male | 6.82 cm | 54.15–62.21 mm |
| Neutral | 5.55 cm | 39.46–44.77 mm |

The candidate retained zero shoulder capacity excess and zero sampled head
penetration. It was **rejected** because the torso-clearance result deteriorated.
No ROM, capacity, contact tolerance or production recipe was changed.

Raw reports and logs are retained in the implementation workspace's
`remaining-batches/lower-reach-{baseline,elbow120}-2026-10-01.{json,log}`.
The new diagnostic also passed a strict standalone TypeScript check.

## Continuing implementation

The user installed Blender 5.2.2 LTS. A new [Blender workflow](blender-workflow.md)
now provides six production reference clips, a male-left hand-target authoring
scene, a built-in candidate export command and measured engine replay checks.
The source `.blend` was built from copies of the production GLBs. All six
reference imports and exports passed the 0.1 mm bone/skin comparison gate.

1. Inspect shoulder joint placement, bone axes, clavicle/upper-arm coordination,
   forearm twist and skin weights. The opt-in v2 scapula locations and skin patch
   are explicitly provisional engineering estimates, not a calibrated solution.
2. Pose a representative behind-back approach and hold using visual targets and
   joint constraints. Keep the bounds and any unreachable target explicit.
3. Export the resulting pose/clip and compare the bone transforms and deformed
   skin with engine playback. Use compatible skinning; a Blender-only modifier
   or constraint must not silently become a runtime requirement.
4. Repair the identified asset or motion-control problem, then repeat on all
   three bodies and both sides. Reference exchange now agrees at the sampled
   times; a better bounded reach is now implemented above. Anatomical calibration
   and completed endpoint contact remain pending.

Further procedural search should put torso clearance inside its objective and
candidate rejection rules. Retain existing joint and proxy bounds, and inspect
approach, assessed hold and return before promoting any candidate.

The current observables are wrist and distal middle-finger **joint** positions,
palm normal, joint-angle ranges and conservative skin envelopes. The diagnostic
deliberately records `clinicalScapularTarget: null`: there is no calibrated
opposite-scapula target in this measurement. Exact skin contact, validated
landmarks, live-host agreement, complete trajectory clearance and rendered
review remain required before promoting a better reach or claiming completion.
