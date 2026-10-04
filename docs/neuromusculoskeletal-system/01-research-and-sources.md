# Research and source library

Research checked on **2026-10-02, America/Chicago**. This is a generic literature, software and data library for the proposed neuromusculoskeletal system. [sources.json](sources.json) provides 31 stable source IDs, direct primary URLs, supported claims, limitations and license evidence. It is not a movement requirements, defects, reference-assignment, ownership or acceptance ledger. Movement-specific claims and their source IDs must be registered in the existing [master catalogue](../MASTER-MOVEMENT-JOINT-CATALOGUE.html).

The evidence supports an incremental, task-bounded system: verified mechanics, muscle actuation, sensory feedback, an interpretable controller and independently evaluated adaptation. A biologically faithful whole sensory/motor cortex, nervous system and patient-specific injury predictor is a separate research ambition. The proposed architecture and experiments in [02](02-system-architecture.md) and [04](04-validation-and-experiments.md) are design proposals, not results established by these papers.

## Reading and verification scope

Primary article methods, results and limitations, official documentation, repository READMEs and dataset descriptions were read in the browser. Repository trees and license pages were inspected where available. Reading depth is identified below; supplemental archives, model downloads, dataset contents, training weights and executable examples were not inspected or run. No model or experimental-data archive was downloaded and no third-party environment was installed.

Dates identify access, not certification that a moving `stable` page or unpinned repository will remain unchanged. The current workspace pins `@mujoco/mujoco` **3.13.0**; offline tools have not been selected or installed by this research. Published conversion and benchmarking results use historical versions and cannot establish equivalence for that installed runtime. Version, artifact hash and license text belong in the proposed provenance manifest when an artifact is actually acquired.

## Research questions and present evidence

| Question | Evidence and remaining gap |
| --- | --- |
| Can motor goals, muscle mechanics and feedback be connected? | OpenSim exposes model/controller components and Moco solves bounded optimal-control problems. An online controller and independently tested forward replay remain separate engineering work. [SRC-OPENSIM](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1006223), [SRC-MOCO](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1008493). |
| Does a cortex-like controller require simulating every neuron? | Functional control theories and small spiking-arm demonstrations offer different abstraction levels. Neither establishes an entire biological cortex or a clinically predictive lesion model. [SRC-OFC](https://roboti.us/lab/papers/TodorovNatNeurosci02.pdf), [SRC-NEURAL-ARM](https://www.frontiersin.org/journals/neurorobotics/articles/10.3389/fnbot.2015.00013/full). |
| Can delayed proprioception affect performance? | SCONE documents delayed muscle feedback. Gains, noise, delays and robustness still need task-specific evaluation. [SRC-SCONE-REFLEX](https://scone.software/doku.php?id=ref:muscle_reflex). |
| Can EMG identify the actual muscle forces? | CEINMS uses EMG and calibrated mechanics; estimates depend on processing and model parameters. EMG is an observed electrical signal, not a direct muscle-force measurement. [SRC-CEINMS](https://github.com/CEINMS/CEINMS/blob/master/help/introduction/CEINMS.rst). |
| Will injury-like parameter changes create realistic impairments? | Bounded gait studies explore mechanical and reflex changes, with incomplete or model-dependent effects. Diagnosis labels, causal mechanisms and compensations require separate evidence. [SRC-PF-GAIT](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1006993), [SRC-REFLEX-GAIT](https://physoc.onlinelibrary.wiley.com/doi/full/10.1113/JP282609). |
| Is there an observed pathological comparison dataset? | A 2025 descriptor includes post-stroke and healthy upper-limb EMG/kinematics. Small, differently aged groups do not establish general norms; files and missing-data patterns still need inspection. [SRC-STROKE-EMG](https://pmc.ncbi.nlm.nih.gov/articles/PMC12675522/). |
| Can an OpenSim model be translated into the current runtime? | Prior conversion and upper-limb benchmarking show why paths, passive behavior and force models need independent checks. File-format translation alone is insufficient. [SRC-CONVERSION](https://arxiv.org/pdf/2006.10618), [SRC-MOBL](https://pmc.ncbi.nlm.nih.gov/articles/PMC4282829/). |

## Tool selection and proposed decisions

These are research-stage choices, not implementation or acceptance commitments. Keep the existing MuJoCo runtime and current controls as the integration base. Compare a deliberately scoped reference offline before introducing more actuators or controllers.

| Candidate | Proposed role | Selection condition |
| --- | --- | --- |
| Existing MuJoCo runtime | Online physics and closed-loop experiments. | Verify the selected model against offline mechanics. [SRC-MUJOCO](https://mujoco.readthedocs.io/en/stable/modeling.html#muscles). |
| OpenSim + Moco | Offline model inspection, reference tracking and objective-sensitivity studies. | Pin one reproducible environment; treat controls and recruitment as estimated solutions. [SRC-MOCO](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1008493). |
| MyoSuite | Separate engineering benchmark for control plumbing. | Its simplified elbow is explicitly physiologically inaccurate; use a different verified reference for physiology claims. [SRC-MYOSUITE](https://myosuite.readthedocs.io/en/stable/suite.html). |
| SCONE | Optional offline reflex-controller comparison. | Check core/Studio/engine licensing and reproduce a bounded baseline before importing design ideas. [SRC-SCONE](https://github.com/tgeijten/scone-core). |
| CEINMS | Later EMG calibration comparison. | Select synchronized, licensed inputs and independent trials first. [SRC-CEINMS](https://github.com/CEINMS/CEINMS/blob/master/help/introduction/CEINMS.rst). |
| AddBiomechanics / OpenCap | Later motion-reference and capture options. | Choose datasets by task coverage and provenance; keep measured and estimated channels distinct. [SRC-ADDBIOMECH](https://www.addbiomechanics.org/download_data.html), [SRC-OPENCAP](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1011462). |

An initial controller should expose goal, sensed state, delay, excitation and failure conditions. A neural network or spiking model can follow only if it answers a defined question that the interpretable baseline cannot answer. Online recovery after a disturbance, offline parameter fitting, policy retraining and adaptation retained across sessions need different experiments and labels.

## Data selection and channel provenance

The elbow EMG dataset is a promising first candidate, conditional on resolving its rights and torque derivation. MoBL-ARMS is a candidate mechanical reference conditional on obtaining the exact permitted model. Neither has been acquired. The post-stroke dataset is a later comparison option, not a substitute for a sound unimpaired baseline. [SRC-UE-EMG](https://zenodo.org/records/11209324), [SRC-MOBL](https://pmc.ncbi.nlm.nih.gov/articles/PMC4282829/), [SRC-STROKE-EMG](https://pmc.ncbi.nlm.nih.gov/articles/PMC12675522/).

| Channel class | Examples in this library | Proposed handling |
| --- | --- | --- |
| Measured observations | Raw EMG, force-platform signals, camera images and instrument samples. | Preserve original units, timestamps, sensor placement and collection protocol. |
| Processed observations | Filtered/normalized EMG; reconstructed or gap-filled marker trajectories; calibrated glove angles. | Preserve filters, normalization references, calibration, missing-data and interpolation flags. |
| Inverse-estimated biomechanics | Joint angles from inverse kinematics; joint moments from inverse dynamics; estimated segment dimensions/inertias. | Store model, external loads, coordinate conventions and residuals alongside outputs. |
| Optimization-derived muscle variables | Excitations, activations and forces from recruitment or trajectory optimization. | Store costs, constraints and calibration; do not label these measured muscle forces. |
| Learned inference | Video keypoints, augmented markers and any learned controller outputs. | Record training domain and weights; evaluate subject/task transfer independently. |

These classes describe proposed provenance labels. Actual classification requires inspecting the selected artifact and methods. In particular, `muscleTorque.csv` in the elbow landing page cannot presently be classified as direct measurement. [SRC-UE-EMG](https://zenodo.org/records/11209324). AddBiomechanics and OpenCap include estimation stages; they do not turn an observed motion into unique muscle-force ground truth. [SRC-ADDBIOMECH-METHOD](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0295152), [SRC-OPENCAP](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1011462).

Proposed splits should hold out participants and trials before calibration or controller tuning. Keep every participant's closely related repetitions together. Test at least one separately withheld task/load condition when claiming transfer; disclose whether it is within the original training domain. Preserve a pathological cohort for final comparison and account for age, severity and task differences. Matching a motion used for fitting cannot establish an independently identified control mechanism.

## Primary source matrix

Each entry links the primary reading used here. Detailed support, boundaries and license evidence are in `sources.json`. A verified publication license covers the publication; it does not silently cover downloadable models, data, code, weights or a hosted service.

| ID / reading | Scope read; version/date | Main boundary |
| --- | --- | --- |
| [SRC-OPENSIM — software paper](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1006223) | 2018 architecture, implementation and applications. | General platform capability, not validity of a new model. |
| [SRC-MOCO — optimal control](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1008493) | 2020 methods, examples and validation discussion. | Solutions depend on objectives; forward replay needs evaluation. |
| [SRC-OPENSIM46 — release documentation](https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim/pages/1274118147/Whats+New+in+OpenSim+4.6%3E) | Full release page; 4.6. | SynergyController is a control interface, not proof of neural circuitry. |
| [SRC-MUJOCO — muscle documentation](https://mujoco.readthedocs.io/en/stable/modeling.html#muscles) | Relevant modeling sections; moving stable documentation. | Check pinned runtime assumptions. |
| [SRC-MYOSUITE — task suite](https://myosuite.readthedocs.io/en/stable/suite.html) | Full suite page; rendered 2.11 label; repository README. | Engineering elbow warning and inconsistent arm counts require exact-file inspection. |
| [SRC-SCONE — core](https://github.com/tgeijten/scone-core) | Full README and licensing; unpinned repository. | Optional GUI and engines have distinct terms. |
| [SRC-SCONE-REFLEX — feedback](https://scone.software/doku.php?id=ref:muscle_reflex) | MuscleReflex and linked ReflexController pages. | Parameterized signals do not identify nerve lesions. |
| [SRC-CEINMS — EMG models](https://github.com/CEINMS/CEINMS/blob/master/help/introduction/CEINMS.rst) | Full introduction and repository usage/licensing. | Calibration estimates forces; optimization feedback differs from sensory feedback. |
| [SRC-MOBL — arm benchmark](https://pmc.ncbi.nlm.nih.gov/articles/PMC4282829/) | 2015 methods, tests, results and discussion. | Historical implementations; restricted motion/sample; files inaccessible. |
| [SRC-UE-MODEL — geometry](https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim/pages/53087772/Upper+Extremity+Model) | Full official model-description page. | Kinematic reference differs from an established dynamic model. |
| [SRC-UE-EMG — elbow/arm data](https://zenodo.org/records/11209324) | Full v1 landing description and file listing; 2024 deposit. | License and torque derivation unresolved; archive unread. |
| [SRC-KINMUS — hand/forearm data](https://zenodo.org/records/3469380) | Full v1.0 landing description and listing; 2019. | Regional EMG channels; archive/license unresolved. |
| [SRC-STROKE-EMG — observed impairment](https://pmc.ncbi.nlm.nih.gov/articles/PMC12675522/) | 2025 cohort, acquisition, processing, quality and availability sections. | Small cohorts; measurement quality is not simulator validation. |
| [SRC-ADDBIOMECH — downloadable data](https://www.addbiomechanics.org/download_data.html) | Full core/public-data page; core v1.0. | Review status and limb coverage vary. |
| [SRC-ADDBIOMECH-METHOD — estimation](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0295152) | 2023 workflow, evaluation and limitations. | Registration ambiguity and anthropometric assumptions. |
| [SRC-OPENCAP — video biomechanics](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1011462) | 2023 methods, validation and limitations. | Upper-limb torque motors; no injury-transfer validation. |
| [SRC-OPENCAP-SOURCE — implementation](https://github.com/opencap-org/opencap-core) | README and Apache license; unpinned main. | Dynamics, weights, upstream assets and service terms separate. |
| [SRC-VALIDATION — verification/validation](https://pmc.ncbi.nlm.nih.gov/articles/PMC4321112/) | 2015 methodological guidance. | Intended-use and independent-data evaluation required. |
| [SRC-CONVERSION — translation](https://arxiv.org/pdf/2006.10618) | Full two-page 2020 paper; OpenSim 4.0 / MuJoCo 2.0. | Test controls were also optimized; equivalence remains unproven. |
| [SRC-NEURAL-ARM — spiking controller](https://www.frontiersin.org/journals/neurorobotics/articles/10.3389/fnbot.2015.00013/full) | 2015 methods, virtual/robot distinctions and discussion. | Two-dimensional task; scripted grasp; no whole cortex. |
| [SRC-OFC — control theory](https://roboti.us/lab/papers/TodorovNatNeurosci02.pdf) | 2002 theory, simulations and experiment sections. | Computational theory leaves biological implementation unresolved. |
| [SRC-PF-GAIT — mechanical impairment](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1006993) | 2019 model, optimization, results and limitations. | Planar gait and re-optimization per impairment. |
| [SRC-REFLEX-GAIT — neural/mechanical perturbation](https://physoc.onlinelibrary.wiley.com/doi/full/10.1113/JP282609) | 2022 methods, results and limitations. | Partial pattern reproduction; controller dependence. |
| [SRC-ANATOMY-TUTORIAL — visual preparation](https://caskanatomy.info/open3dviewertutorials/) | Full tutorial; Blender 4.4.3 instructions. | Static export is not functional rigging. |
| [SRC-EMG-METHOD — activation and force](https://pmc.ncbi.nlm.nih.gov/articles/PMC1357215/) | 2004 methods and EMG/force distinctions. | Electrical signals require activation, contraction and geometry models. |
| [SRC-MUJOCO-STATE — state and reset](https://mujoco.readthedocs.io/en/3.6.0/programming/simulation.html#state-and-control) | Official 3.6.0 programming reference. | Check the installed 3.13.0 implementation; controller histories are additional state. |
| [SRC-MUJOCO-INTEGRATION — numerics](https://mujoco.readthedocs.io/en/3.6.0/computation/index.html#numerical-integration) | Official 3.6.0 integration reference. | Solver documentation does not replace model-specific convergence checks. |
| [SRC-OPENSIM-MUSCLE — tendon formulation](https://opensim-org.github.io/opensim-moco-site/docs/1.3.0/html_user/classOpenSim_1_1DeGrooteFregly2016Muscle.html) | Official muscle API, Moco 1.3.0. | Offline implicit formulations need compatible solvers. |
| [SRC-OPENSIM-SCALING — model dimensions](https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim/pages/53089158/How%2BScaling%2BWorks) | Official scaling description. | Scaling geometry cannot establish subject force capacity. |
| [SRC-CC-BY-SA — license scope](https://creativecommons.org/licenses/by-sa/4.0/) | Official license deed. | The deed does not prove the grant for a specific combined asset. |
| [SRC-MUSCLE-PATHS — attachment and wrapping](https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim33/pages/53674058/Muscle%2BEditor) | Official historical muscle editor reference. | Preserve path semantics and check the selected modern model; editing a path does not validate its leverage. |

## Licensing and access gaps

The source register deliberately separates verified grants from unknown artifact terms. Article CC BY does not resolve model rights. Apache code does not resolve a third-party mesh, controller checkpoint or data archive. Source availability also does not establish hosted-service permissions.

The following acquisition questions remain open:

- **MoBL-ARMS / upper-extremity files:** SimTK access failed. Obtain an authorized exact artifact, included license, model revision and dependencies before selecting the reference.
- **Elbow EMG data:** Zenodo description was readable, but the retrieved license section was empty and linked detailed methods were inaccessible. Resolve rights and torque derivation with an accessible primary methods record before use.
- **KIN-MUS:** The readable description does not establish the currently retrievable archive license. Inspect metadata and included terms before acquisition.
- **Post-stroke data:** The descriptor explicitly gives the dataset CC BY 4.0, separately from the article's CC BY-NC-ND terms. The Figshare collection/archive was not retrieved; inspect channels, omissions, file terms and any code license before use. [SRC-STROKE-EMG](https://pmc.ncbi.nlm.nih.gov/articles/PMC12675522/).
- **Anatomy assembly/head:** The primary preparation tutorial was readable. The AnatomyTool download page and head/full-body artifact inventory remain unverified; available local asset attribution is documented in [03](03-foundation-and-anatomy.md). The tutorial is not evidence of an existing integrated controller-ready anatomy model.
- **Learned models:** No MyoSuite policy or OpenCap model weights were inspected. Check weight provenance and permissions independently of repository code.

Unknown licensing is a research gap, not a conclusion that reuse is prohibited. Resolve it before an acquisition or redistribution decision.

## Exact next research actions

1. Select one fixed-torso elbow task and describe observable outputs, disturbances and excluded motions. Register any resulting movement requirement and supporting source IDs in the master; keep this library generic.
2. Resolve the candidate model and data licenses above. Acquire a small trial and exact reference model in an artifact-intake batch within established authorization; record artifact hashes, versions and included terms in the provenance manifest.
3. Inspect model bodies, joint frames, muscle paths, wrapping, tendon assumptions, inertias, limits and units. Inspect the trial's time bases, EMG normalization, missing samples, external loads and torque derivation. Reject unresolved channels as validation targets.
4. Freeze subject/trial splits before fitting. Choose a second load or target condition that is withheld from fitting. State whether later pathological comparisons have compatible tasks, cohorts and measurement definitions.
5. Pin the offline reference environment and reproduce one source-defined mechanical test. Compare conversions with passive motion, moment arms, force curves and forward response using identical inputs; disclose any retuning or corrective controls.
6. Establish the torque-actuated observation boundary and delayed-feedback checks first, then compare muscle actuation and repeat those checks. Separate steady-state tracking, immediate disturbance recovery, offline retraining and persistent adaptation. Keep controller changes and mechanical changes independently identifiable in each experiment.
7. Review the scoped mechanical and control claims with biomechanics, motor-control and anatomy expertise using [06](06-expert-review-and-decisions.md). Add injury-specific clinical expertise before mapping a diagnosis or nerve-root lesion to model parameters.
8. Reconcile evidence into the master and the experiment record only after the prescribed numerical, visual and independent-data checks. A good animation or an optimizer fit is not an acceptance result by itself.

No reference in this library establishes a unique relationship between an anatomical mesh, a nerve root, a muscle excitation and an impairment outcome. Peripheral innervation, segmental overlap, sensory modalities and lesion-specific effects need their own authoritative regional evidence before those mappings become movement claims.
