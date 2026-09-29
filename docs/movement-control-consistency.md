# Movement control and deformation ownership

This change addresses shared control defects identified in the September 2026 movement audit. It does not add an independent scapula to the existing Character Creator rig or enable a physical dynamics solver for ordinary playback.

## Pelvis and support

`Hips` is the articulated pelvis. The model root places and orients the whole body. A planted movement must not cancel an authored pelvic rotation by applying the opposite rotation to the root.

The foot-root solver retains its established placement for leg-authored squats and hinges. When pelvic articulation is present, supporting hips, knees and ankles compensate to preserve support. An elevated leg remains free. Small pelvic movements engage the solver before the older five-centimetre root-drift threshold, avoiding a delayed correction. Recordings include the resulting leg pose as well as root placement.

This is a kinematic contact solution. It does not estimate muscle forces, contact pressure or physical stability.

Consecutive pelvis-only edits retain the original supporting-leg intent separately from the solved leg pose. That provenance is held in memory on the live skeleton; historical recordings do not acquire missing pre-IK authoring intent through a schema migration. Explicit newly authored leg controls take precedence. Patient-specific leg limits are enforced for the new compensation even when browser calibration mode disables ordinary clamps; unreachable contacts remain best-effort rather than widening those limits.

## Shoulder composition

Within one keyframe, an upper-arm target and its shoulder-girdle targets form one composed command:

- Explicit girdle fields override the automatic value for that field, including an explicit zero.
- Automatic rhythm supplies un-authored elevation fields. Existing protraction is retained unless explicitly replaced.
- The humerus compensates against the final girdle orientation, preserving the requested arm orientation and downstream palm orientation.
- A girdle-only command retains its existing behavior of carrying the attached arm.

Target order is therefore immaterial. A single movement command uses the same arm composition as a one-target sequence. The rig's `Shoulder` bone is still one clavicle/girdle proxy; these controls are not separate SC, AC and scapulothoracic joints. Projected angle readouts also remain subject to their existing coordinate convention.

## Supported arms

Hand contacts include the girdle in pose capture, temporary solves and release blending. A distal arm solve remains the starting strategy. A raised target can recruit bounded girdle motion if the distal chain remains short; a candidate is accepted only when endpoint error improves and measured joint limits hold.

Floor supports preserve their authored girdle strategy. Push-ups and other loaded arm tasks still need deliberate task-specific scapular coordination; open-chain elevation rhythm is not a substitute for that authoring.

## Twist deformation

The stage derives helper-bone twist during rendering for composed motion, commands, recorded poses and manual posing, including hosts without posing controls. The baseline is captured before any authored pose. Helper rotations are restored after rendering, so they do not accumulate or enter clinical pose recording.

An animation clip retains ownership of a segment when it authors any twist helper in that segment. Name, UUID and skeleton-index bindings are recognized. Frozen clip end frames preserve that ownership until another driver or a manual edit takes over. Host render-time arm corrections are followed by a fresh twist calculation. Clinical bones and measured joint positions are unchanged by the deformation layer.

This does not turn on skin compression or self-collision globally. Those remain separate host or physical-controller capabilities.

GLB pose-animation exports bake the same derived helper rotations into their animation tracks. They restore every live bone after sampling, including on failure. An exported clip can therefore retain its own helper tracks on replay without freezing twist at the neutral value.

## Rotation screens and review

The raw shoulder, forearm and tibial templates establish their stated testing positions before rotation, hold those positions through the sweep, centre the rotation, then return. Tibial rotation uses bilateral leg setup and seated pelvis support. These setup changes do not replace simLAB's separately authored examination recipes.

For visual review, run `npm run dev` and open `/movement-review.html`. It exposes all three body models, the relevant pelvis and shoulder cases, rotation screens, gait, and capture/replay with or without posing controls. The displayed measurements come from the live shared stage.

For automated validation, run `npm run check` and `npm test`. Focused regressions include `pelvisPlantOwnership`, `shoulderComposition`, `handContactGirdle`, `rotationScreenSetup` and `stageTwistOverlay`, alongside the existing gait, contact, release and validity suites.
