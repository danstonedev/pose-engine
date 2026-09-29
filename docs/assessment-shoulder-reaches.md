# SFMA/FMS shoulder reach correction

The overhead assessment previously placed the elbow forward/outward and the hand across the neck. A shared runtime defect also reduced valid external rotation: a requested -90 degrees became -70 degrees because the production arm's local axis and the clamp's canonical axis point in opposite directions. The asymmetric rotation limits were applied to the wrong sign.

The clamp now derives the shoulder twist sign from the captured rest axis before applying normative or patient-specific limits. Synthetic rigs whose child already lies along local -Y retain their convention. Hip and hinge conventions, ROM ranges, and the 120-degree engineering shoulder-capacity budget are unchanged.

The shared angle readout also removes swing before measuring twist about the rest arm axis. Its previous use of the current axis reversed the displayed rotation above horizontal. This changes measurements, not stored pose quaternions; consumers should regenerate derived measurements when comparing old recordings.

Hand-reach recovery and raised hand-contact checks now compare anatomical rotation with anatomical limits. Opt-in recovery retains a better valid incoming pose and tries a mirrored local twist seed in addition to its bend seeds. The historic lower-back wrist probe now stops approximately 12.5 cm short on the male rig and 17.0 cm short on the female rig at 70 degrees internal rotation; its former near-contact result relied on the reversed limit. Its test explicitly records the partial result. The reachable inward cross-body tracking test retains its 15 mm position and 10-degree step thresholds.

The hand-contact engagement ramp is 200 ms instead of 150 ms. This reduces the corrected-limit bird-dog re-engagement peak from approximately 24 to 18 degrees per 30 Hz frame. Existing planted-hand position, acceleration, penetration and transition thresholds are retained.

## Shared assessment routes

SFMA upper-extremity patterns 1 and 2 and FMS shoulder mobility use the existing production clavicle/girdle strategy. Both projected shoulder elevation fields now author the overhead direction, external rotation is retained, elbow flexion follows the approach, and forearm/wrist targets orient the hand. The lower route is staged behind the torso with a bounded low-back endpoint. Feet and trunk remain held, both routes return to setup, and the FMS fist command is retained.

No host-specific shoulder solver or experimental rig is introduced. Explicit girdle targets, patient restrictions and the shared capacity policy remain authoritative.

## Validation and limits

- Production female, male and neutral rigs, both sides: endpoint geometry, orientation, fixed feet/trunk and return tests.
- All 18 upper/lower/reciprocal trajectories are checked at 60 Hz against conservative torso and head/neck skin envelopes, using a 3 mm penetration threshold. The head envelope assumes the head/trunk remain held. This is a collision regression, not a surface-contact solver.
- Production-rig regression checks preserve external rotation, enforce both asymmetric normative endpoints and patient-specific internal/external bounds, and retain elevated-arm commands.
- An analytic sweep verifies rotation sign below, at and above horizontal on both sides; existing synthetic clamp tests remain applicable.

The lower route still does not reach the opposite scapula. FMS fists remain separated; thumb contact, hand-length scoring, true skin contact and clinical endpoint validation remain unresolved. Numerical or visual playback completion does not grant clinical acceptance or establish native dynamics tracking.

The [original FMS description](https://www.functionalmovement.com/files/Articles/335a_najspt-01-132.pdf) describes reciprocal upper and lower shoulder combinations with contribution from the scapula and thorax. These recipes are editable engineering approximations of those routes, not an automated screen or score.
