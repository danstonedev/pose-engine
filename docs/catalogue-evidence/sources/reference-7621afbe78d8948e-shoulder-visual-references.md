# Shoulder reach references and scapular mechanics

The user supplied five posterior-view photographs during the September 11 R&D
session. They broaden the intended outcomes beyond one lower-back target. These
notes refer to their order in the conversation; the images are not bundled as
application assets. The saved 3D demonstration remains the numerical reference.

## Observable reference patterns

| Reference | Visible pattern | What the simulation should let us compare |
| --- | --- | --- |
| 1 | One hand descends from above, the other reaches upward behind the back; fingers remain separated | Fingertip gap, wrist orientation and lower elbow position |
| 2 | Over/under reach with fingers appearing to meet | Hand/finger contact as a separate outcome from wrist-target error |
| 3 | Over/under reach with fingers close near the midline | A second near-contact configuration with different visible arm proportions |
| 4 | Over/under reach with a larger visible gap and an open lower hand | An incomplete reach as a legitimate outcome under stated constraints |
| 5 | A single lower reach with an outward-facing palm; the other arm is lowered | Isolating the lower-reach task before combining both arms |

These are qualitative observations. Single still views do not supply exact 3D
joint angles, movement order, contact force, scapular stability, muscle capacity
or a diagnosis. Camera perspective, clothing, morphology and hand shape differ.
Do not label an example as winging or weakness from these photographs. Distances
in pixels cannot become centimetres without a suitable scale and camera model.

The lower hand's palm orientation and finger direction are explicit parts of
the task. Matching its wrist position alone does not reproduce these patterns.
Elbow position, trunk posture and the other arm's pose also need to be recorded,
with intended motion distinguished from compensations being studied.

## Independent variables to represent

1. **Available movement:** glenohumeral, clavicular and scapular motion limits;
   elbow, forearm and wrist ranges. Coupled limits need their own model.
2. **Scapular support and control:** blade position against the thorax, medial
   border/inferior-angle lift, passive restoring resistance and active effort.
   Reducing available ROM and reducing stabilization must be independent changes.
3. **Task and morphology:** lower/upper reach, both arms together, segment
   proportions, thorax shape, desired palm/finger orientation and hand contact.
4. **Trunk participation:** thoracic movement and later standing balance, with
   actual motion measured rather than prescribing a universal spine-first lag.

The next paired experiment should hold the target, humeral ranges and body
geometry constant while varying scapular stabilization. A separate comparison
should change ROM while keeping stabilization constant. Engineering effort or
stiffness variations must not be named as specific muscle or nerve disorders.

## Current implementation boundary

`bodyVariants.ts` maps the canonical Shoulder to a clavicle bone. The production
rig and original physical comparison retain that girdle proxy. Its three-axis
stops reproduce editor coordinates and cannot independently represent blade lift.

The opt-in [scapula experiment](../../experiments/upper-body/SCAPULA.md) now adds a
separate physical blade, moving humeral attachment, native guide contact,
passive support and bounded active stabilization. Its ellipsoid against a local
plane is an engineering fixture, not a measured scapulothoracic interface.
Changing stabilization preserves ROM. The display follows physical joint
translations as well as rotations, so socket motion carries the visible arm.

The [fitted-contact increment](../../experiments/upper-body/COORDINATION.md) now uses
a curved posterior guide derived from the actual skin asset, with native contact
and bounded surface-following motors. Its 5.31 mm global RMS skin-fit residual,
partial coverage and assumed inward offset remain explicit. Measured skeletal
geometry, appropriate support attachments and scapular skin coupling are still
required. The earlier local-plane model can generate large medial clearance;
neither that result nor a small new guide clearance establishes human congruence.

An established modeling reference is Seth et al. (2016): an ellipsoidal thoracic
guide with scapular elevation/abduction, upward rotation and an independent
medial-border lift coordinate. The authors tested scapular kinematics against
bone-pin data for selected movements and discussed inverse/forward dynamics.
This supports investigating an explicit scapula with independent motion; it
does not validate our implementation or these behind-back photos.
[Primary paper](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0141028).

Seth et al. (2019) extend that approach with muscles controlling scapular motion
and examine shoulder shrugging and arm elevation. This is a useful reference for
the later actuation layer, rather than treating a fixed scapulohumeral rhythm as
the source of stabilizing forces. Their task-specific validation does not cover
our lower-back reach.
[Muscle-driven shoulder model](https://www.frontiersin.org/journals/neurorobotics/articles/10.3389/fnbot.2019.00090/full).

Any thoracic guide used for internal scapular articulation must remain distinct
from the external deformable torso contact surface. The earlier global convex
torso approximation already produced false arm intersections at the lumbar
concavity. A convenient internal guide cannot replace measured external shape.

## Evidence required for that increment

- Reproduce rest/landmark geometry and move the humeral origin with the scapula.
- Show gliding and border lift independently, with forces determining motion.
- Under a known perturbation, compare stronger/weaker restoring support at
  unchanged ROM; measure lift, contact reaction, recovery and arm trajectory.
- Prevent penetration into the inner thorax and check contact throughout motion.
- Re-run the saved lower reach, restricted reach and inward-load/release cases.
- Add the visible upper-reach and two-arm patterns only after each arm's path,
  hand orientation and contact have an independently replayable reference.
- Keep material/muscle parameters labeled as engineering inputs until supported
  by independent measurements; photo agreement alone does not finish validation.
