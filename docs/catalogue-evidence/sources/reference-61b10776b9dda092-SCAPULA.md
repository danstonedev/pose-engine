# Force-driven scapular support experiment

The [fitted-contact increment](COORDINATION.md) adds curved posterior support and
bounded surface-following control, with measured skin-fit errors and explicit
coverage limits. The older guide conditions documented below remain available.

The [coupled-body comparison](COUPLED.md) now carries this mechanism with the
physical trunk. It uses a finite moving guide and measures border clearance in
that guide's live frame. The supported experiments below retain the static plane.

This opt-in experiment inserts a separate `R_Scapula` rigid body between the
existing clavicle proxy and humerus. Its moving attachment carries the physical
humeral origin; the renderer receives the solved blade and arm world poses. It
uses actual native joint dynamics, passive springs/dampers, bounded motors and
contact forces. It does not set solved positions to satisfy a visual target.
The local engineering geometry currently requires an unrotated reference root;
other root orientations are rejected explicitly. Orbiting the viewer camera
does not change the reference root and remains supported.

## What is represented

- Two tangential slides, one outward slide, and three rotational hinges form a
  reduced six-coordinate articulation relative to the clavicle proxy.
- A 104 × 136 × 8 mm ellipsoid represents the blade, with 0.12 kg mass. Its
  engineering attachment offset preserves the original neutral humeral origin
  and orientation. These dimensions and attachment points are assumptions, not
  patient landmarks or a segmented scapular mesh.
- A fixed internal posterior tangent plane supplies unilateral contact with
  the blade. Contact masks separate this internal support from external
  arm/deformable-tissue contact. The plane is infinite in the physics engine;
  its finite displayed rectangle only illustrates its location.
- Native joint springs and damping provide passive support. Bounded motors
  restore the relative resting coordinates and compensate a chosen fraction
  of bias loads. `scapulaStabilization` scales both active feedback and force
  capacity; it leaves the geometry, passive parameters and ROM unchanged.
- `scapulaPerturbationNm` applies a known wing-axis torque between 0.5 and 1.5
  simulated seconds. The pulse is deterministic and preserves other applied
  forces exactly. Releasing motors leaves native passive support and contact.

Default passive translational stiffness is 500/500/600 N/m with damping
18/18/20 N·s/m; rotational stiffness is 0.8 N·m/rad with damping 0.8 N·m·s/rad.
`scapulaPassiveScale` scales stiffness only. Active feedback gains are 1500 N/m
and 30 N·m/rad, with unscaled actuator caps of 120 N and 8 N·m. These are
engineering support parameters, not muscle/material measurements.

The rotational coordinate names are engineering axes in the blade's neutral
frame, not clinical scapular angles. Tangential/normal directions follow the
parent frame as the clavicle moves. Available ranges are ±40 mm tangential,
−15 to +60 mm outward, ±20° tilt, −10 to +40° wing, and ±40° rotation. Native
soft limits enforce these values; their small numerical excess is reported.

## Reproduce

```js
const bench = createUpperBodyBench(mj, fixture, {
  scapula: 'articulated',
  scapulaStabilization: 1, // compare with 0.1; identical available ROM
  scapulaPassiveScale: 1,
  scapulaPerturbationNm: 1.5,
  gravity: false, contact: false, timestep: 0.0005,
});
bench.command.mode = 'rest';
bench.step(3000); // peak loaded phase at 1.5 s
bench.step(3000); // recovery at 3 s
```

`contact:false` disables arm versus external tissue contact in this isolated
test; the scapular/thoracic contact remains active. The main saved-reach test
enables gravity, expanded deformable tissue, compliant edge support, and the
existing three-axis girdle. All pre-existing modes remain unchanged unless
`scapula:'articulated'` is selected.

Run `node verify-scapula.mjs --report` in this directory. The optional report
is stored under ignored `.validation.local/scapula-report.json`. Tests compile
the real MuJoCo 3.13.0 model and check neutral mapping, actual socket attachment,
equal ROM, bounded actuator effort, passive-only tangential gliding/recovery,
native contact reaction and penetration, finite integration and active recovery.
The same test checks that irregular display/worker batching preserves exact
joint states and that halving the integration step keeps loaded wrist and peak
lift differences below 1 mm in the two perturbation conditions.

Measured at 0.5 ms steps:

`liftM` is increased medial-border site distance above the initial 4.5 mm guide
clearance. `borderSeparationM` separately reports absolute site/plane distance;
actual blade penetration is measured from native contact constraints.

| Active support | Peak medial-border lift | Peak wing coordinate | Worst contact penetration | Lift at 3 s |
| --- | ---: | ---: | ---: | ---: |
| 100% | 2.986 mm | 2.929° | 0.019 mm | 0.061 mm |
| 10% | 30.676 mm | 20.039° | 0.105 mm | 0 mm |

The same pulse produces greater lift with reduced active support; both recover.
This demonstrates mechanical response to engineering inputs, not a diagnosis
or correspondence between the percentages and measured muscle capacity.

An additional paired 8 s saved lower-back reach enables gravity, expanded
tissue and compliant edges. Run `node verify-scapula-reach.mjs`; its report is
`.validation.local/scapula-reach-report.json`. Both conditions use 0.25 ms
integration steps. At 0.5 ms the weak-support approach exceeded the 1 mm
external contact gate (1.062 mm), so that setting is not accepted for this pair.

| Active support | Final wrist gap | Hand error | Worst external residual | Worst guide penetration | Minimum volume ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100% | 0.00277 mm | 0.04595° | 0 mm | 0 mm | 0.9834 |
| 10% | 36.404 mm | 9.246° | 0.789 mm | 0.0325 mm | 0.8048 |

Peak arm speed remained below 1.332 rad/s in both trials. The full-support
trial did not create an arm/tissue contact event; the weak-support approach
had a transient 49.77 N sum of normal forces, and no external contact force at
the endpoint. The 36.4 mm gap remains an incomplete reach, rather than
teleporting the arm to the saved position. These are numerical fixture outcomes,
not estimates of human movement accuracy. This pair does not validate the
inward-press or restricted approach when combined with the added scapula.

## Remaining anatomy and validation

This is a local support bench, not a complete scapulothoracic model. The native
springs restore a clavicle-relative pose, while the guide is fixed to the
thorax. Therefore the saved reach can place the medial border 19.3 mm from the
plane (14.8 mm above the starting clearance) even at full active support. A curved guide and calibrated thoracic
attachment forces are still needed for congruence throughout broader motion.
The six coordinates also permit translations that a measured SC/AC articulation
would constrain more specifically. Blade thickness and contact shape are
coarse; shoulder muscles, capsules, segmented ribs, scapular skin coupling,
and individual morphology are not yet represented.

Seth et al. describe a four-coordinate scapulothoracic model with ellipsoidal
gliding and independent medial-border lift, validated for selected bone-pin
tasks. Their approach motivates the next curved guide and anatomical-axis
increment. Our tangent-plane model is a different implementation and inherits
none of their validation results. [Primary modeling paper](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0141028).

Native spring, damping, joint-limit and contact semantics follow the installed
MuJoCo engine. [MuJoCo XML reference](https://mujoco.readthedocs.io/en/stable/XMLreference.html).
