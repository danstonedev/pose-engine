# Whole-body functional motion foundations

The squat, forward bend and chair transfers now share explicit pelvis, spine,
limb and support intent. Each phase assigns a responsibility to all 23 major
body segments. This is an authoring contract, not evidence that every segment
moves or that a physical simulation has accepted the motion.

## What is controlled

| Segment(s) | Responsibility |
|---|---|
| Hips | Pelvic articulation, independently of support-derived root placement; seat-height contact during seated phases |
| Spine_Lower | Lumbar flexion with quiet lateral and axial channels |
| Spine_Upper, Spine_Mid | Regional thoracic flexion/lateral tilt/rotation, shared across both bones |
| Neck, Neck_Lower | Shared cervical orientation and task-dependent gaze |
| Head | Hold its entry local orientation relative to the cervical region |
| Left/right Shoulder | Derived elevation rhythm plus explicit neutral protraction |
| Left/right UpperArm, Forearm | Task-dependent arm counterbalance, reach, thigh-assistance shape or relaxed carriage; explicit rotation |
| Left/right Hand | Shared relaxed hand posture, or authored thigh-assistance wrist motion |
| Left/right UpLeg, Leg | Coordinated hip/knee flexion and quiet secondary axes |
| Left/right Foot | Authored ankle posture and task-dependent floor support |
| Left/right Toes | Quiet forefoot posture |

`movementControl.ts` validates omissions, duplicates, missing driver targets and
undeclared supports. `SequenceKeyframe.control` and `ComposedMotion.controlId`
remain authoring metadata; the resolver does not turn them into a runtime
constraint or retain them as measured controller state.

The regional thoracic command previously wrote Upper alone although its readout
included Mid. It now writes half to each available bone, absolutely rather than
accumulating a companion rotation. A partial baseline without Mid receives the
full angle at Upper. Equal sharing is an engineering approximation, not a
measured anatomical ratio. Cervical distribution retains its existing strategy.

## Recipes and support

Raw and builder squats use the same targets and phase timing. Pelvic tilt and
ankle dorsiflexion lead the descent, with coordinated lumbar/thoracic motion,
cervical orientation, forward arm counterbalance and relaxed hands. The final
foot IK clamp respects the weight-bearing ankle range while retaining explicit
patient restrictions and the existing open-chain limit.

The `forward-hip-hinge` template is a rounded forward bend/toe-touch: its authored
spinal flexion is intentional. It is not a neutral-spine lifting-hinge protocol.
Root orientation in these planted motions includes whole-body support placement;
it must not be interpreted as the isolated Hips articulation angle.

Chair descent uses pelvic/spinal lean and forward arm counterbalance before seat
support. Rise separates seated preparation, forward lean, seat-off, extension
and standing settle. Both foot contacts remain active while foot-derived root
translation carries the pelvis over them. The thigh-assisted template includes
a neutral-to-seat preparation; a host that already starts seated omits that
named phase. Its hand/thigh shape is authored, not a solved hand contact.

Fixed bilateral support is distinguished from alternating gait. These transfers
receive feet-based balance checks before seat support, skip feet-only scoring
while seated, and do not receive walking norms. Weighted descent can operate
with a fixed foot base; contact IK then accommodates its small root-height
adjustments. `settleEnds` keeps these transfers from inheriting cyclic gait
endpoint velocity.

## Counting joints

These categories answer different questions and must remain separate:

| Recipe | Phases | Directly targeted major joints | Resolved target joints | Commanded major joints |
|---|---:|---:|---:|---:|
| Squat (raw and default builder) | 2 | 18 | 30 | 22 |
| Forward bend | 2 | 18 | 30 | 22 |
| Thigh-assisted sit-to-stand, including setup | 6 | 20 | 20 | 22 |
| Sit down | 3 | 18 | 30 | 22 |
| Stand from sitting | 5 | 18 | 30 | 22 |

All rows declare 23 major segment roles. The resolved count of 30 includes 10
finger-base targets and two wrists supplied by relaxed-hand coordination.
Command ownership expands finger-base commands to all 30 phalanges: these rows
own 52 mapped bones, while the thigh-assisted variant owns 22. Head is held;
eyes are outside these task recipes. Neither count means every listed bone has
nonzero excursion.

Real-rig coverage sampled at 60 Hz, using a normalized local quaternion excursion
greater than one degree, finds 20 moving major segments for squat, forward bend
and sit-down; 18 for the full thigh-assisted sequence; and 14 for a rise starting
from the actual seated endpoint. These counts agree across male/female models.
Setup, initial pose, threshold and commanded versus achieved motion matter.

## Verification and limits

`functionalRecipes.test.ts` loads the production rigs and checks raw/builder
parity, regional participation, balance, toe clearance, explicit ankle limits,
carried-pose behavior and a real down/up continuation. Existing descent,
seat-height, hand/thigh, continuity and gait clearance gates are retained.
`playground/MovementReview.svelte` provides rendered squat, bend and transfer
cases with recording output for model-by-model inspection.

The corrected chair descent has positive minimum pre-seat balance margins on
both tested models and sub-millimeter tracked-foot drift. These are kinematic
support measurements, not validated forces or a clinical acceptance record.
The balance estimate depends on the engine's mass and support approximation.

The present Shoulder bone remains a combined girdle proxy. This work does not
add independent SC/AC articulations, a scapular skin region, or measured GH/ST
angles. Existing twist redistribution and host contact/compression mechanisms
remain separate capabilities; a whole-body target list does not enable native
dynamics or tissue compression automatically.
