# Proposed anatomy and musculotendon foundation

Prepared 2 October 2026. This specification proposes the shared anatomical and mechanical foundation for a functional neuromusculoskeletal system. No new anatomy, muscle controller, calibration or clinical acceptance is established by this document. Its movement references and eventual work units belong in the [single master catalogue](../MASTER-MOVEMENT-JOINT-CATALOGUE.html), following the [catalogue process](../movement-catalogue-process.md).

Read alongside [system architecture](02-system-architecture.md), [research and sources](01-research-and-sources.md), [validation](04-validation-and-experiments.md) and [delivery roadmap](05-delivery-roadmap.md). These specifications must preserve active joint-frame, contact and recording corrections rather than restart overlapping work.

## What the accessible anatomy actually provides

The inspected SimPACS source is `audit-sources/simpacs`, HEAD `399224ea4f346272db2fd7fc8ffdddba1e80aa2d`, whose last commit is dated 28 July 2026. It is a limited historical snapshot, not evidence of the current October deployment. Its `src/lib/anatomy/anatomyLayers.ts` registers upper- and lower-limb GLBs and an optional rigged upper-limb asset. `jointRig.ts` and `static/models/upper-limb.rigged.meta.json` connect joints to shared canonical keys and ROM fields using Y-up axes. The README's “no rigging/posing” description is therefore incomplete even for that snapshot. The [inspection snapshot](current-state-snapshot.json) records selected identities separately from catalogue acceptance.

The local attribution file identifies AnatomyTool Open 3D, Z-Anatomy and BodyParts3D lineage and records CC BY-SA 4.0 for the two assets. These are provenance leads, not verification of future downloads, combined derivatives or mechanical validity. Direct AnatomyTool page retrievals failed. The accessible LUMC viewer tutorial disables skinning, shape keys and animation during GLB export: following that static-viewer recipe alone would not preserve our movement rig. [Open 3D viewer tutorial](https://caskanatomy.info/open3dviewertutorials/). Full-body assembly instructions, head/neck source coverage and exact download manifests remain unverified.

Retrieve and retain the actual source release and instructions before combining components. Preserve authorship, source URLs, license notices and modification history with exported anatomy. License review must cover the selected artifacts and their redistribution; this specification makes no legal conclusion about combining them with the existing body skin.

The current pose engine has male, female and neutral presentation rigs. Native fixtures in the inspected simMOVE pathway are male/female. Its 23 represented segments and regional surface cells include head and cervical segments, but remain engineering proxies. Named atlas structures, animation bones and physical bodies must be related explicitly; matching names alone cannot establish anatomical equivalence. See the [pipeline audit](../movement-pipeline-audit-2026-10-02.md) and `simmove/docs/blender-body-physics.md`.

## Canonical model package

Proposed implementation: a versioned model package shared by pose-engine, native adapters and anatomy visualization. Separate anatomical identities from display names and preserve original source identifiers. A package describes its population, supported bodies/tasks and omitted anatomy, with provenance attached to every derived parameter.

| Entity | Required fields | First acceptance evidence |
| --- | --- | --- |
| Segment | Identity, parent, neutral frame, geometry, mass/COM/inertia and provenance | Landmark/frame comparisons; positive inertias; declared mass accounting |
| Joint | Parent/child frames, coordinates, axes/order, neutral pose, translations, bounds/coupling and clinical readout mapping | Isolated coordinate sweeps and cross-system transform/readout agreement |
| Muscle unit | Anatomical muscle/compartment, attachments, path/wrap rules, crossed coordinates and parameter sources | Path lengths, moment arms and force behavior over the supported range |
| Tendon/ligament | Associated structures, slack/reference length, force law and state definition | Controlled displacement/velocity experiments and numerical convergence |
| Neural pathway | Root/branch identities, modalities, muscle/sensory relationships and uncertainty | Independently reviewed mapping; no unsupported unique-root assignment |
| Presentation binding | Rig bones, helpers, skin weights, atlas meshes and coordinate transforms | Posed skin/anatomy alignment in Blender and both hosts |
| Collision binding | Core/surface geometry, contact exclusions, material regions and rendered-skin correspondence | Coverage, support and deformation measurements across poses |

Use metres, seconds, kilograms, newtons and radians internally; convert clinical degrees at defined interfaces. Document world handedness, up/forward axes, quaternion order, rotation composition and neutral references. Existing runtime conventions use +Y up and XYZW quaternions in authored route data; Blender/native adapters must export actual transforms instead of relying on remembered axis conversions.

Left/right correspondence needs explicit mirrored frames and signed clinical coordinates. A spatial reflection is not a rotation quaternion; test the transformed axes, ordered coordinate motions and muscle moment-arm signs. Record bind pose separately from anatomical zero and measured subject reference posture.

## Whole body accounting and registration

Discover the actual rig on each import; the catalogue adoption snapshot's 101 bones is historical, not a hard-coded coverage count. Account for pelvis, lumbar/thoracic regions, both cervical segments and head, both shoulder girdles, arms/forearms/hands, legs/feet/toes, digits and deformation helpers. For each identity, state whether it is a physical segment, an anatomical display structure, a derived skin helper or outside physical scope. Missing independent fingers, jaw/eyes, vertebrae or nerve mechanics remain explicit unsupported detail.

Assembly should first produce a neutral anatomical reference. Validate component scale, laterality, overlaps, missing structures and duplicated pelvis/trunk geometry before fitting it to an external body. Landmark registration and controlled local deformation may align anatomy to presentation, but preserve joint centers, muscle attachments, lengths and mechanical properties as separately reviewed quantities. Do not force internal structures to fit a cosmetic silhouette by silently moving anatomical axes.

Keep physical mass independent from render-mesh inventory: adding a muscle mesh must not add mass twice to its segment. Preserve current bone names, bind poses, skin weights, paint atlases, saved poses and application contracts. Where a new topology is necessary, supply an explicit migration and correspondence map rather than assuming old surface annotations remain valid.

Treat nerve meshes as anatomical visualization initially. Posing a nerve mesh does not model conduction, entrapment, excursion or strain; those require separate geometry/mechanics and evidence. Likewise, muscle coloration requires an identified activation source, not merely a visible muscle name.

## Muscle paths and conversion

OpenSim distinguishes fixed attachments, conditional via points, coordinate-dependent moving points and wrapping geometry. Conversion must preserve those semantics, not only sampled endpoint coordinates. [OpenSim Muscle Editor documentation](https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim33/pages/53674058/Muscle%2BEditor).

For each candidate subsystem, retain the original model and an executable conversion report. Test neutral and boundary poses, multi-joint combinations and wrap-transition neighborhoods. Compare path length, its derivatives, line of action, moment-arm sign/magnitude and resulting joint torque. A visually plausible path can still transmit the wrong torque.

Our proposed computational convention defines signed moment arms from the negative derivative of musculotendon length with respect to the corresponding joint coordinate, with a virtual-work comparison to the exported force application. Validate derivatives using independent perturbations and retain coordinate/sign conventions. Geometry approximations or fitted path functions require explicit ranges and withheld-pose checks; do not extrapolate silently.

The native muscle model's wrapping and tendon/pennation assumptions differ from OpenSim. These differences require explicit model selection and conversion checks, not format-only acceptance. [MuJoCo muscle modeling and OpenSim comparison](https://mujoco.readthedocs.io/en/stable/modeling.html#muscles).

## Contractile and tendon law choice

Introduce muscle physiology incrementally, using a bounded antagonist subsystem before a whole-body replacement. Its model must declare excitation-to-activation dynamics, active force-length/velocity curves, passive force, pennation treatment, maximum force and tendon behavior. Parameters remain measured, literature-derived, fitted or assumed, with units and uncertainty. Do not initialize physiological values merely because a renderer looks correct.

| Proposed option | Appropriate initial purpose | Dependency and exit decision |
| --- | --- | --- |
| Existing capped joint torque | Establish sensor/control interfaces and supported plant behavior | No individual-muscle or physiological recruitment claim |
| Native muscle with declared rigid-tendon assumptions | Low-cost bounded force/activation experiment | Path/force checks and sensitivity establish whether the assumption supports the teaching claim |
| Compliant tendon/contractile model | Tasks where tendon dynamics are material to the claim | Independent equilibrium, transient response, stability and performance evidence |
| Specialist offline reference model | Compare conversion and solve recruitment/trajectory problems | Retain solver/version/objective and distinguish estimated recruitment from observations |

OpenSim's DeGrooteFregly2016 implementation offers rigid/compliant tendon settings and explicit/implicit compliance formulations; its documentation restricts implicit dynamics to compatible solvers rather than ordinary forward time stepping. This illustrates why an offline model cannot be assumed to transfer directly into browser stepping. [OpenSim muscle API](https://opensim-org.github.io/opensim-moco-site/docs/1.3.0/html_user/classOpenSim_1_1DeGrooteFregly2016Muscle.html).

## Calibration and foundation exit

Scale anatomy from retained landmarks and anthropometry, then recheck muscle paths and physical parameters. OpenSim scaling updates length-dependent components and mass/inertia under specified settings; muscle strength requires separate handling. Geometric registration cannot establish force capacity. [OpenSim scaling documentation](https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim/pages/53089158/How%2BScaling%2BWorks).

Calibrate in an order that exposes confounding: frames/geometry, masses/inertias and passive support, muscle paths, contractile/tendon behavior, then neural controller parameters. Hold out tasks or configurations for validation. Track reserve torque and changes to passive resistance so a fit cannot hide missing muscle capacity. Compare available joint traces, external forces and processed EMG channels within their measured scope; document preprocessing and interpretation separately.

Exit the foundation stage when provenance and supported scope are complete; coordinate/neutral conversions pass; all presentation identities are accounted for; selected muscle paths and force laws reproduce predeclared source comparisons; contacts represent skin adequately for the task; and Blender/native/both-host exchange evidence identifies exact inputs. A reproducible engineering proof of a parameterized hypothesis remains separate from a physiological validation gate. Anatomical and clinical review require named reviewers and retained artifacts. Thresholds must be justified before experiments using source uncertainty and intended use. Until those decisions exist, report measurements and gaps rather than acceptance.

Unresolved decisions are the retrievable full-body atlas release, registration strategy for each production body, first physiological subsystem, tendon/pennation formulation, parameter identifiability and intended educational claim. Resolve them through the [research](01-research-and-sources.md), [validation](04-validation-and-experiments.md) and [delivery](05-delivery-roadmap.md) specifications, then link actual movement implementation to the existing master.
