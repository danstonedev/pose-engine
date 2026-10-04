# Expert review and decisions

Planning specification, 2 October 2026. These prompts define a reusable AI-assisted review process; no named specialist has reviewed or approved this plan. Decisions below are proposals for investigation, not implementation acceptance.

Use [research and sources](01-research-and-sources.md), [architecture](02-system-architecture.md), [anatomical foundation](03-foundation-and-anatomy.md), [experiments](04-validation-and-experiments.md) and [roadmap](05-delivery-roadmap.md) together. The [existing master](../MASTER-MOVEMENT-JOINT-CATALOGUE.html) owns movement requirements, defects, references, work assignments and acceptance. Decision notes document rationale and point to those records; they must not become a second backlog or acceptance ledger.

## Panel contract and evidence packet

A synthetic panel supplies specialized perspectives and challenges. It does not possess professional credentials, constitute independent human clinical review, or certify physiological validity. Humans sign the reviews for which they are accountable. Existing authorization permits reversible preparation and research while that review is pending; this process invents no extra approval requirement.

Every review packet contains: intended educational question and excluded claims; exact master context/phase links; code and asset revisions; body/side scope; diagram of state, sensors, controller, actuators and plant; equations and units; parameter origins and uncertainty; raw/reference-data identifiers and permissions; calibration/holdout boundaries; baseline/candidate outputs; all failed ablations; runtime/replay behavior; and explicit unresolved questions. Include evidence locators, not only a summary written by the implementation author.

Reusable prefix for every reviewer:

> Work only from the supplied revision and retrievable primary evidence. Distinguish observed results, sourced claims, engineering assumptions and hypotheses. Identify missing evidence rather than inventing measurements, normative ranges, licenses or approval. Give an exact locator for each finding, affected claim/context, consequence, discriminating experiment and evidence needed to resolve it. Return a recommendation with uncertainty and scope. Proposed defects and work assignments go to the master integrator; do not create another ledger. Do not edit active projects or recommend bypassing existing gates.

## Specialist prompts

### Biomechanics and musculoskeletal modeling

> Audit the smallest model capable of answering the declared task. Trace axes, units, segment mass/inertia, muscle paths, wrapping, moment arms, force-length/velocity relations, activation and tendon assumptions. Check support reactions and all assistance. Identify parameters that cannot be inferred from the supplied observations. Compare torque-only and muscle-driven trials and distinguish matched kinematics from matched mechanics. Recommend one controlled experiment that could falsify the dominant modeling assumption. State which anatomical or loading claims remain unsupported and which evidence would justify additional detail.

### Motor control and sensory systems

> Draw the actual information path from physical event to acquisition, delay, estimator, policy and command. Inspect controller inputs for ground-truth or future-state leakage and undeclared knowledge of perturbations. Separate feedforward planning, feedback recovery and across-trial learning. Audit reset of sensor queues and adaptive state. Design removal, delay, restoration and disconnected-channel ablations. State whether the evidence demonstrates an engineering controller, a specific physiological mechanism, or neither. Require measured causal timestamps before using nervous-system labels. Do not equate a learned policy with a replicated cortex.

### Neurology, rehabilitation and orthopaedics

> Review the educational claims and lesion-to-channel mapping. Distinguish root, plexus, named peripheral nerve, sensory pathway, motor pathway, muscle/tendon injury and joint restriction. Check affected and spared functions, laterality, severity and population applicability against primary evidence. Determine whether the intervention only demonstrates a parameter change or supports a named condition. Require healthy, mechanical-only and pathway-specific comparisons where applicable. Identify counterexamples and clinically misleading simplifications. Propose safe teaching wording that preserves uncertainty. Do not infer diagnosis, prognosis or treatment benefit from a synthetic trajectory.

### Anatomy, Blender rigging and presentation

> Audit registration of the anatomical atlas, physical segments and production avatar using joint centers, axes, attachments and scale. Identify what was fitted, mirrored or approximated. Inspect actual all-body motion and visible skin on applicable bodies/sides through setup, transitions, hold, return and loop. Check support geometry, collisions, helper bones and saved-data compatibility. Explain where visual deformation differs from modeled mechanics. Verify editable Blender and round-trip evidence. Recommend the smallest correction that preserves anatomical landmarks and current interfaces; do not hide errors by deforming the anatomy to fit an incompatible skin.

### Software, simulation and runtime

> Trace shared implementation and actual native/host delivery paths. Audit state ownership, simulation clock, sensor timestamps, fixed-step behavior, unit transformations, error handling and serialization. Compare frozen replay with live recalculation and identify any stale force/deformation overlay. Inspect input identity coverage, deterministic resets, timestep convergence, regression scope and resource budgets on intended devices. Specify behavior for unsupported edits and interrupted trials. Preserve existing MuJoCo and shared pose-engine infrastructure unless a measured requirement warrants change. Produce concrete interface/validation recommendations, not another independent controller implementation.

### Data, attribution and licensing

> Inspect original source pages, exact asset/data releases and their license text. Distinguish software, geometry, textures, recordings, participant data and derived outputs. Record attribution, modifications, redistribution/retention restrictions and incompatibilities with the outer avatar or packaged datasets. Verify consent/use scope where relevant without assuming open access means unrestricted reuse. Check raw-data availability, preprocessing provenance and population/task suitability. Return permissible proposed handling and unresolved questions; do not assert that one license governs everything or copy an asset before its conditions are understood.

### Independent adversarial reviewer

> Begin from the packet and declared acceptance criteria without relying on other reviewers' conclusions. Try to explain every result through hidden assistance, leakage, calibration reuse, parameter non-identifiability, mechanical confounds, inaccurate registration or stale evidence. Seek the earliest falsifying counterexample and reproduce a retained failure when execution is available. Audit whether the holdout was actually unseen. Challenge claims beyond the supported task, bodies and runtime mode. Distinguish an uncovered defect from an untested case. Recommend release scope only after examining contrary evidence; consensus among AI agents is not independent experimental validation.

## Review rubric and human accountability

Use this rubric to structure discussion, not to compute an automatic acceptance score:

| Dimension | Evidence sought | Human accountability |
| --- | --- | --- |
| Provenance | Primary sources, exact identities and use permissions | Research/data reviewer |
| Anatomical fidelity | Audited joints/paths and body-specific registration | Anatomy/biomechanics reviewer |
| Mechanism | Correct equations, causal ablations, declared assistance | Controls/simulation reviewer |
| Independent validation | Locked holdout, uncertainty and counterexamples | Independent methods reviewer |
| Educational/clinical scope | Supported wording and explicit exclusions | Qualified domain reviewer |
| Delivery | Current Blender, native and both-host manifests | Engineering integrator and scoped reviewers |

For each dimension report **missing**, **partial**, **supported for stated scope**, or **contradicted** with evidence. One contradicted critical claim cannot be averaged away. An AI recommendation may propose a correction or flag risk; only executed evidence and the applicable accountable review can establish acceptance. Clinical wording remains unsigned when no qualified human reviewer has signed it. Technical acceptance does not imply clinical endorsement.

Have specialists inspect independently before sharing conclusions. Then compare disagreements by claim and evidence rather than vote. For each substantive disagreement, ask what observation would distinguish the alternatives and whether it affects current scope. Assign related movement/reference work through the master integrator. Preserve minority objections and unsupported cases. Re-review changed claims, assets or controller inputs; an old signature does not cover a new identity.

## Formal decisions to prepare before the first implementation

These are decision questions and proposed starting positions, with final rationale retained in linked decision artifacts. They create no new movement assignment/status list.

1. **First task and claims.** Propose the supported elbow experiment in [04](04-validation-and-experiments.md). Confirm its master linkage, support assumptions, parameters and educational purpose before selecting a trajectory. Success initially means a bounded causal-control demonstration; spatial reaching requires additional validated degrees of freedom.
2. **Physical model and controller.** Propose the existing MuJoCo pathway, torque control as a sensor-interface bridge, then a minimal antagonistic muscle model. Compare model complexity against the required outputs, identifiability and evidence. OpenSim-derived data/models require explicit coordinate, actuator and parameter translation; transferring geometry alone establishes no equivalence. Record what the selected model omits and a measurable trigger for reconsideration.
3. **Runtime placement.** Propose native experiments and identity-bound replay first; decide browser/server live execution only after measured latency, resource, reset and numerical-consistency evidence. Declare observation/controller/physics rates independently. Both hosts consume the shared system. Unsupported parameter changes must request a new trial or remain unavailable; old traces cannot represent new inputs.
4. **Anatomy and licensing.** Separate source anatomy, outer avatar and physical model identities. The source viewer's instructions disable skinning and animation during export, so visual assembly cannot be treated as an existing mechanical rig. [LUMC tutorial](https://caskanatomy.info/open3dviewertutorials/). Record asset-specific rights before fitting or redistribution. CC BY-SA requires attribution and appropriate licensing of distributed adaptations; a combined asset needs its own compatibility assessment. [License deed](https://creativecommons.org/licenses/by-sa/4.0/).
5. **Pathology evidence and wording.** Begin with named parameter interventions. A later condition-specific feature requires a verified pathway/mechanical mapping, independent comparison, uncertainty analysis and qualified review of the intended teaching claim. If evidence is insufficient, retain generic labels such as reduced modeled motor capacity. Clinical outcomes remain outside this program's current supported scope.

## Decision record template

Use an ordinary versioned rationale artifact linked from the existing master where it affects movements. Do not put independent defect status or work assignment tables here.

```text
Decision title / revision / date / decision authority:
Master context/reference/work links (where applicable):
Question / intended use / excluded claims:
Exact evidence packet and source identities:
Options / assumptions / compatibility constraints:
Chosen option and reasons; alternatives rejected with evidence:
Uncertainty / contrary evidence / unresolved dependent questions:
Validation required by the master before acceptance:
Reconsideration trigger / superseded decision link:
Human signatures and scopes, or explicitly unsigned:
```

The first panel output should be a narrowly bounded testable specification, with open dependencies linked to the master. Do not turn research enthusiasm into an implied clinical capability. Move to the next [roadmap gate](05-delivery-roadmap.md) only when its required evidence is available; continue independent authorized preparation while narrower claims remain unresolved.
