# Coordinated reach and fitted posterior shoulder support

The live comparison now includes **Trunk–shoulder coordination** and **Fitted
contact · flat vs curved guide**. Both use the saved female/right lower-back
reference, the coupled body, deformable back/flank tissue, and bounded physical
motors. **Whole body** shows trunk participation and ground support. The saved
target remains attached to the torso; the purple marker shows the moving hand-path
command. The green marker remains the saved endpoint.

## Coordinated control

Both coordination views have the same fitted guide and hand-path controller.
The left trunk tracks an upright reference. The right selects a small
counterbalancing trunk command from measured arm mass distribution and whole-body
COM movement, then slows or holds the requested arm route near support, posture,
speed or contact thresholds. **Use coordinated control on both sides** makes the
two conditions identical. **Apply trunk disturbance** supplies the same 60 N·m
world-X pulse for 0.6 physical seconds to both models.

This is reactive command coordination, rather than a fixed spine-first delay.
It does not assume that moving the trunk can solve the intrinsic distance to a
body-attached hand target. The requested arm route follows the demonstrated
sequence while the physical arm adjusts to the moving shoulder socket.

The governor updates on a fixed 10 ms physical clock, independently of display
frames. Its engineering target envelope is ±8° bend/side bend, neutral axial
rotation, and at most 10°/s change in desired posture. It considers current loaded
foot-contact margin, trunk angle/speed, base tilt and recent valid contact
residuals. Contact forces are read after the native force solve; new contact rows
from `mj_step1` are never paired with old forces. Requested route time advances
only at the allowed rate. Arm release freezes that request and removes active
arm/scapular effort, while the trunk retains its last support target. Disabling
active trunk support holds a coordinated route explicitly.

`task-space-control.mjs` reconstructs the hand path from the original fixture's
joint targets. A damped six-coordinate Jacobian solve supplies bounded arm-motor
equilibrium errors, with a small posture preference for the demonstrated joint
configuration. Hinge directions demanding motion into an already active stop are
removed and the remaining joints are reconsidered. It never assigns solved joint
positions. Native joint limits, directional humeral resistance, tissue contact,
gravity and motor bounds remain authoritative. This is a local controller, not a
global path planner or proof that every reachable task will be found.

## Fitted contact

The old rigid guide is a local flat box. The new guide is a tilted ellipsoid
fitted to observed posterior skin from the actual runtime body asset. A broader
neutral-skin export retains 2,358 triangles by requiring each vertex to have more
than 50% axial/clavicular skin weight. Arm-majority vertices are excluded. No
triangles are invented to close the mask boundaries.

The export records the source capture, asset SHA256, triangle SHA256, bone-weight
mask and units. The fit samples posterior ray exits uniformly across angles and
heights. Its fitting objective and bounds are reproducible. Native convex contact
uses the resulting curved shape; exact closest-point queries supply the displayed
clearance and normal measurements.

| Fit diagnostic | Result |
| --- | ---: |
| Observed posterior fitting rays | 1,549 / 1,625 (95.32%) |
| Skin-fit RMS residual | 5.31 mm |
| 95th percentile / maximum absolute residual | 9.89 / 23.03 mm |
| Supported samples in original blade rectangle | 47 / 63 (74.6%) |
| Unsupported rectangle samples | 11 missing; 5 outside fitted posterior sector |
| Supported rectangle RMS residual | 6.83 mm |

The model contains external skin, not measured internal ribs. Each fitted
semi-axis is reduced by an explicitly assumed 8 mm; that construction is not a
constant normal tissue thickness. The anterior half and unsampled regions of the
ellipsoid are extrapolated. The guide is therefore fitted posterior support
geometry, not a complete anatomical rib cage or patient-specific scapula.

At rest, the blade is oriented tangent to the guide and its center is placed one
blade half-thickness plus 0.5 mm outside it. Its attachment offsets are recomputed
to preserve the existing neutral humeral origin and rotation exactly. During
motion, bounded motors target tangential movement and normal alignment with the
curve, including active compensation for the known passive spring load. Native
contact resists inward blade motion. Motor release removes the active support.
Medial-border lift is measured relative to its initial curved-surface separation;
center clearance and normal mismatch are distinct readouts.

Ellipsoidal scapulothoracic models with independent gliding and border lift have
been studied using bone-pin reference data. That motivates this representation;
their validation does not transfer to this skin-derived fixture.
[Seth et al., 2016](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0141028).
The physical Jacobian and geom/contact semantics use the installed MuJoCo engine.
[MuJoCo API](https://mujoco.readthedocs.io/en/stable/APIreference/APIfunctions.html#mj-jacsite),
[geom reference](https://mujoco.readthedocs.io/en/stable/XMLreference.html#body-geom).

## Measured outcomes and checks

At eight physical seconds, the coordinated fixture has a 0.047 mm wrist gap,
0.062° hand error, approximately 1.27° bend and 1.47° side bend. Blade center
clearance is approximately 0.50 mm. The upright-reference condition reaches the
same hand goal while maintaining its upright trunk reference. These tiny task
errors represent numerical agreement, while the skin-fit errors above remain
several millimetres.

With the humeral twist stop tightened to −50°, the movement remains incomplete:
107.3 mm wrist gap, 42.3° hand error and 4.66 mm blade center clearance. It is
rejected by the unchanged 5 mm / 3° hand and 3 mm / 3° guide movement gates.
Its stability, contact, joint-limit, bounded-effort and release checks still pass.
The 3 mm guide criterion is an offline movement acceptance gate; the runtime
governor currently responds to support, posture, speed and penetration.

The disturbance trial holds the requested route while support deteriorates,
recovers its progress rate, and reaches a 0.115 mm wrist gap by eight seconds.
Reach and three-second motor-release checks enforce bounded effort, finite speed,
native joint tolerances, positive sampled tissue volume and less than 1 mm
arm/guide/floor contact residual. Halving the timestep, rigid-transform invariance,
display grouping, guide contact, pulse timing during route holds and browser
alignment are checked separately; local reports preserve each case's actual
source fingerprint and outputs.

Comparing 0.5 ms with 0.25 ms integration across eight approach/hold samples and
the released state gives maximum differences of 0.497 mm wrist position, 0.081°
hand error, 0.0051° trunk angle, 0.344 mm guide clearance and 0.69 N ground force.
The checks also reproduce exact integrated state under different display grouping
and verify that a physical scapular pulse expires even when the route clock holds.

The two-worker Chrome check agrees with the native eight-second and released
states and checks the actual guide/blade meshes, physical joints, a transformed
skin vertex, anchors, pins and hand markers. Identical controls/replay, the
disturbance button, original-mode restoration, capture rejection/recovery and
mobile layout pass. The local harness is `.review.local/check-coordination.mjs`;
reports and screenshots are in `.validation.local/` inside this experiment.

Performance remains open. In one local headless Chrome run, the paired workers
advanced eight simulated seconds in 59.69 wall seconds (0.134×). Camera response
was 45 ms and animation callbacks remained near 60 Hz. This check requests
0.1-second physics chunks, producing 80 presented snapshots per view; it does not
measure automatic playback's smaller batches or establish a controlled throughput
benchmark. The 0.50× playback target has not been achieved for this coupled run.
See [execution notes](PERFORMANCE.md#coordinated-and-fitted-contact-runtime).

```powershell
node --test experiments/upper-body/coordinated-control.node-test.mjs experiments/upper-body/thoracic-fit.node-test.mjs
node experiments/upper-body/verify-fitted-mechanics.mjs
node experiments/upper-body/verify-coordination.mjs --case=coordinated
node experiments/upper-body/verify-coordination.mjs --case=upright
node experiments/upper-body/verify-coordination.mjs --case=flat
node experiments/upper-body/verify-coordination.mjs --case=half-step
node experiments/upper-body/verify-coordination.mjs --case=disturbance
node experiments/upper-body/verify-coordination.mjs --case=restricted
node experiments/upper-body/verify-coordination-steps.mjs
npx.cmd vitest run --config experiments/upper-body/thoracic-surface.vitest.config.mts
```

The extraction test/config is `thoracic-surface.probe.ts` /
`thoracic-surface.vitest.config.mts`; extraction writes only when explicitly
requested with `$env:EXPORT_THORACIC_SURFACE='1'`; without that setting it checks
the retained geometry against the actual runtime asset without rewriting it.
`fitted-guide.json` is the precomputed geometry
loaded by each browser worker, avoiding repeated fitting during playback.

The subsequent [skin-force](SCAPULAR-SKIN.md) and [chest/axilla coverage](UPPER-THORAX.md)
comparisons extend this baseline. Remaining anatomical work includes measured
skeletal geometry, complete contact coverage, calibrated material and actuator
parameters, and independent motion/force references. Lower limbs
are still rigid. Trunk control and a geometric COM margin do not supply a validated
standing balance or stepping model.
