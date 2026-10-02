# Extension-clearing surface contact candidate

Acceptance recorded before runtime tuning, 2 October 2026.

## Scope and baseline

Correct bilateral hand skin support and the physical floor reference for extension
clearing on the production male/female/neutral rigs. Author and inspect actual
geometry in Blender. Native qualification covers male and female only. Retain
other movements' behavior unless a separate measured candidate justifies change.

Baseline: engine HEAD `274ad55`, motion-6/7 identical exported animations, measured
with `skin-floor-clearance-datums-3.json`. World-zero palm/finger minima: male
-19.5243 mm, female -15.9543 mm. The existing native extension results in
`blender-floor-native-4.json` have matching current native source/fixture identities:
female completes and passes sampled tracking (pelvis36.868 mm, joint14.8195 degrees,
segment12.3272 degrees); male completes but fails joint tracking (pelvis44.3514 mm,
joint21.0704 degrees, segment10.3150 degrees). These are separate achievements.

## Candidate checks

- Derive the hand surface from actual skin and hand/finger bone weights; retain
  editable bilateral surface anchors and explain the physical support plane.
  No hand-specific arbitrary height constants or whole-body lift to hide contact.
- At the 60 Hz authored trajectory samples, each hand's lowest supported skin
  stays within 2 mm of the floor. Check rendered twist and both hands. Report
  palm-region contact separately from distal finger contact; a low fingertip
  alone does not establish distributed palm loading.
- Keep existing 2 mm palm landmark drift, orientation, patient ROM, continuity
  and playback-rate tests. An unreachable patient target must retain its limit
  and expose its residual, never disable a limit to obtain contact.
- Measure the entire skin trajectory, including head/neck, legs and pelvis;
  disclose any newly introduced or worsened penetration/support gap relative to
  baseline. Existing global failures remain open and cannot become accepted.
- Blender bone/skin interchange remains within the existing 0.1 mm tolerance.
  Inspect matched setup, hold and return views plus the full trajectory.
- Verify both local hosts on the same runtime source, record source/asset hashes,
  and keep authored playback distinct from native replay.
- Fresh native trials retain the existing 5 cm pelvis / 15-degree joint /
  15-degree segment tracking gates and numerical/contact stops. Reproduce both
  bodies; retain failed trials. Completion alone does not pass the candidate.
  For a passing native candidate, check repeatability and timestep sensitivity.

No merge or clinical acceptance is implied by an improved geometric candidate.
This file records targets, not results; subsequent outcomes belong in the shipment
log and immutable candidate reports.

## Whole-chain revision requested during review

The user explicitly requires the entire spine, pelvis, hips and lower extremities
to participate in the extension movement. Candidate 2 does not satisfy that
requirement. Before revising the source:

- Author and inspect the complete chain in Blender: lumbar, middle/upper thoracic,
  cervical/head, pelvis, both hips, knees, ankles and toes. Record joint and support
  traces over setup, ascent, hold, descent and return. A stable segment must have
  an explicit supporting role; artificial movement is not required in every joint.
- Distribute spinal shape through the represented chain; do not obtain a higher
  chest or straighter elbows solely by adding lumbar extension or moving the root.
- Keep both palms anchored; reconcile pelvis/thigh/leg/foot skin support with the
  torso rather than lifting the lower body when the chest touches the floor.
  Skin compression and contact forces remain unvalidated unless newly simulated.
- Compare the source and native joint frames before accepting a pose that one
  model can represent and the other cannot. Retain patient bounds and expose
  unreachable support/extension residuals.
- Retain the preceding quantitative gates and all failed candidates. Fresh motion
  requires fresh Blender exchange, both-host playback and native trials.

The related FMS breathing press-up describes spinal extension with a maintained
pelvis: https://www.functionalmovement.com/exercises/973/press_up_breath_in . It uses
a foam roll and is not the clearing-test protocol or a numerical calibration for
this model. No universal joint-coupling ratio is inferred from it.
