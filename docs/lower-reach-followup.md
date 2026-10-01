# Lower reach follow-up — 1 October 2026

Status: current baseline measured; first bounded candidate rejected; Blender
5.2.2 authoring and import/export workflow established. The released lower-reach
recipe remains unchanged. This begins priority 1 in
[the movement work list](movement-improvement-status.md).

## Reproducible measurements

Source: engine `e55a02003515a83c86b3b8c79b928b185877db8c` (release #166).
Use a fresh output path for each run:

```sh
npx vite-node scripts/characterize-lower-reach.ts baseline.json
npx vite-node scripts/characterize-lower-reach.ts elbow120.json 120
```

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

## Next implementation step

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
   times; anatomical calibration and a better accepted reach remain pending.

Further procedural search should put torso clearance inside its objective and
candidate rejection rules. Retain existing joint and proxy bounds, and inspect
approach, assessed hold and return before promoting any candidate.

The current observables are wrist and distal middle-finger **joint** positions,
palm normal, joint-angle ranges and conservative skin envelopes. The diagnostic
deliberately records `clinicalScapularTarget: null`: there is no calibrated
opposite-scapula target in this measurement. Exact skin contact, validated
landmarks, live-host agreement, complete trajectory clearance and rendered
review remain required before promoting a better reach or claiming completion.
