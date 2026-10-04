# Shared SFMA/FMS shoulder reaches

The pinned engine corrects SFMA upper-extremity pattern 2 and the upper arm of
FMS shoulder mobility: the elbow sits beside the head and the palm faces the
upper back. Both hosts use the same production clavicle/girdle path. Forearm
and wrist targets are explicit. Engine documentation and trajectory tests are
in `pose-engine/docs/assessment-shoulder-reaches.md`.

## Native standing support

The revised reciprocal reach exposed a balance regression in the female native
body. Both sides fell backwards with the general loaded-contact reduction's
0.05 regularization. This was a native floor-contact failure, separate from the
kinematic head/torso clearance tests.

The four held standing upper-extremity tasks now use 0.0001 regularization in
their loaded-foot motor-feedback reduction. This retains ankle/root coupling
when projecting gravity, balance and pelvis feedback to existing motors.
Unilateral and floor-task policies are unchanged. The native solver still
determines actual support, slip and contact force; no root wrench, prescribed
contact force or pose correction is introduced. Controller identity is v14.

The targeted native probe completed all four FMS shoulder-mobility cases
(female/male, both sides), with maximum sampled pelvis error below 8 mm, joint
tracking error below 10 degrees and key-pose segment error below 13 degrees.
The committed regression runs the complete right-arm reciprocal sequence on
both native body fixtures with the default 2 ms standing timestep, the existing
1 mm contact gate, joint tracking within 15 degrees and pelvis error within
5 cm. It also checks torque caps, zero external wrenches and unchanged source
packet. Completion does not grant physical or clinical acceptance.

Broader evidence is generated with `scripts/export-core-physics.mjs` and
`scripts/verify-core-physics.mjs`; the release report records the exact source
hashes and complete 64-case comparison. A smaller timestep, stronger upright
feedback, and a moving center-of-mass target were diagnostic experiments and
are not part of this change.

## Remaining limits

The lower arm remains a low-back reach, short of the opposite scapula. FMS
fists remain separated. No landmark contact, hand-length score, tissue
calibration or clinical screen completion is inferred from these poses.
