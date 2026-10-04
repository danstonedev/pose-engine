# Validation and experiments

Planning specification, 2 October 2026. No experiments described here have been executed. This protocol proposes a bounded educational demonstration; it provides no patient outcome prediction or clinical qualification.

Read [research and sources](01-research-and-sources.md), [architecture](02-system-architecture.md), [anatomical foundation](03-foundation-and-anatomy.md), and [delivery roadmap](05-delivery-roadmap.md). The [existing master](../MASTER-MOVEMENT-JOINT-CATALOGUE.html) remains the only movement requirements, defects, references, ownership and acceptance ledger. Trial files support master records; this document creates no parallel ledger.

## Evidence ladder and intended claims

Hicks et al. distinguish software verification, calibration, independent experimental validation and sensitivity analysis. [Primary paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC4321112/).

Our proposed evidence ladder is: equation correctness; reproducible integration; causal feedback; calibrated mechanics; independent reference agreement; anatomical review; faithful host delivery. Each stage records its own result. Import success cannot establish muscle realism; endpoint tracking cannot establish control mechanism; matching another simulator cannot establish human validity. Declare which outputs are supported, assumed, unobservable or outside scope before any run.

## First task and supported elbow movement

Choose an existing elbow-flexion master context after checking active work ownership. If the proposed target/load experiment is absent, register a reconstructible experimental context in that master before acceptance. Do not fabricate a current motion ID.

Use a seated or equivalently restrained setup with declared upper-arm support, fixed shoulder pose, controlled forearm orientation and a single active elbow degree of freedom. Represent wrist/hand posture and the hand-held load or fixture explicitly. Declare table, torso and upper-arm constraints and their reaction forces; artificial supports are part of this benchmark. Target geometry must lie within the audited mechanical and existing patient bounds. Begin with movement, hold, return and reset; add a spatial reach only after releasing and validating its additional degrees of freedom. This task does not support general shoulder, grasp, balance or gait claims.

Capture segment dimensions, inertias, gravity, axes, rest state, limits, passive resistance, support geometry, target schedule, speed and load. Specify reset/warm-up behavior, phase boundaries, perturbation onset and repeat count before tuning. All proposed levels and repetitions require justification; this document supplies no numerical norms.

Predeclare endpoint error (mm), angular error (degrees), overshoot, settling time (s), command/torque (N m), muscle force (N), observation age (ms), time at saturation, support slip/penetration (mm), and support reactions. Retain continuous traces and event times, not only averages. Specify reference alignment and aggregation for each metric.

### Torque actuation and sensor causality

Retain the existing MuJoCo route. Use bounded torque actuation first, with one explicitly versioned controller. Give it only the declared observation interface: timestamped position/velocity estimates, target and permitted task context. Simulation truth belongs to the evaluator. Audit controller inputs for hidden access to current joint state, external forces, future observations or trial labels.

Inject a known observation delay through a timestamped queue. Log acquisition, delivery and consumption times. Compare intact feedback, delayed feedback, channel removal, zero-delay restoration and an intentionally disconnected test channel. A signal that the controller never consumes must have no effect. An observation perturbation cannot affect command before delivery. Repeated identical plant/controller states must produce identical commands until their available observations differ. A mechanical perturbation may alter the plant immediately; only its feedback-mediated command change is latency-gated. Keep intentional feedforward knowledge explicit.

Success establishes this engineering feedback loop, not a synthetic proprioceptor or cortex. Repeat the same tests after muscle actuation so physiological naming cannot conceal sensory leakage.

Predeclare the expected direction and uncertainty of each effect, including a plausible null result. Sensor consumption and causal timing are separate checks from task performance: delayed or noisy feedback need not monotonically worsen every metric. Preserve identical prior controller knowledge across acute conditions so hidden patient or trial IDs cannot reveal the intervention.

### Muscle actuation

Replace the elbow torque source with a declared flexor/extensor actuator set while retaining the task, evaluation and observation contract. Audit paths, wrapping, moment-arm signs and operating lengths before tuning capacity. Record excitation, activation, force and resulting joint moment separately. MuJoCo separates tendon geometry from its muscle force mechanism; its documented formulation must be checked against the installed version and required tendon behavior. [Official modeling documentation](https://mujoco.readthedocs.io/en/3.6.0/modeling.html#muscle-actuators).

Keep reserve torques off for the claimed muscle-driven task or report their magnitudes, necessity and exclusion from acceptance. Named nerves/roots require independently reviewed mappings; the initial actuator set may remain an engineering proxy.

Before comparing task outcomes, test the actuation change in isolation with fixed high-level torque demands. Version the excitation allocator and measure realized moment, saturation and the feasible torque envelope. Freeze the high-level policy for a matched comparison, and report any changes to capacity, assistance or controller assumptions that prevent isolation of the actuation effect. Remove existing torque feedback on the selected coordinates through the mutually exclusive strategy boundary in the architecture; double actuation would invalidate the comparison.

| Experiment | Change while other inputs remain fixed | Record and interpret |
| --- | --- | --- |
| Nominal healthy model | None; repeat reset and trial | Repeatability and baseline reference agreement |
| External load | Measured load/inertia or declared force pulse | Command, saturation, timing and error; compensation is a hypothesis |
| Motor capacity | Torque limit, then muscle capacity separately | Capacity-limited performance; no diagnosis inferred |
| Sensory latency | Observation delivery delay only | Causal command onset, trajectory and recovery |
| Mechanical impairment | Passive resistance, range limit or tendon/path property separately | Restricted mechanics versus altered neural command |
| Negative controls | Identical inputs; unused channel; perturbation outside the task chain | Detect unintended coupling and fabricated effects |

Run single-factor experiments before selected interactions. Use a frozen controller first, with identical initial state and paired seeds. This measures an acute response within the model. A separate adaptation experiment may update controller parameters across training trials; retain learning rule, training history, compute budget and held-out tasks. Retuned tracking is a different claim from immediate recovery, and neither establishes biological rehabilitation.

## Verification, observability and identifiability

Verify units, rotations, handedness, neutral references and mirrored axes with isolated joint tests. Use analytical restrained-link torque balances, passive settling and conservative energy checks where appropriate; account for actuator work, damping and support reactions in driven trials. Check limits, activation bounds, force signs, moment-arm derivatives, passive response and state initialization. Validate delay buffers and interpolation with known synthetic signals, including reset and discontinuity cases. Reject NaN, unbounded state, unexplained applied force and hidden assistance.

Create a channel map: directly measured, computed from measurements, simulated, inferred or assumed. Angle tracking alone cannot distinguish different antagonist activations. Fit identifiable parameter groups rather than interpreting every fitted value as physiology. Probe combinations of load, speed and perturbation timing to separate gain, inertia, passive resistance and delay. Examine parameter-profile fits, sensitivity/Jacobian rank and uncertainty where suitable. If materially different parameters fit equally well, retain that ambiguity and narrow the claim or obtain an additional measurement.

## Calibration and independent validation

Before fitting, lock a data manifest and split by participant/session/task or whole trial, according to the claim; adjacent frames from one trial are not independent validation. Reserve unseen loads/targets for generalization and, where available, an external study for transfer. Predeclare fitting objective, parameter bounds and preprocessing. Retain raw data, units, coordinate transforms, sampling, filters, missing channels, synchronization uncertainty and every normalization/retargeting step.

Once a holdout result guides model selection, parameter tuning or preprocessing changes, mark it as development evidence. Reserve untouched participants/trials or an independent dataset for the next validation. If no fresh data are available, label reassessment as nonindependent and retain that limitation; repeatedly testing the same holdout does not restore its independence.

EMG measures electrical activity; activation and muscle force require further modeling, including delay and length/velocity dependence. Therefore a timing/envelope comparison does not validate force magnitude. [Buchanan et al., primary paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC1357215/). In this protocol, predefine onset/offset and amplitude processing; retain electrode and normalization metadata. EMG used to tune activation cannot also be independent validation of that activation. Use separate force/torque measurements for corresponding mechanical claims; label inverse-dynamics estimates as derived rather than direct measurements.

Separate neural pathway, sensory, muscle/tendon and joint-mechanical interventions. A strength reduction is not sufficient evidence for a named nerve injury. Require lesion location, affected/unaffected channels, severity assumptions and a supported comparison before adding pathology labels. Healthy and mechanical-only controls test whether an apparent neurological effect is explainable by mechanics alone.

## Numerical robustness and threshold derivation

Repeat trials with recorded seeds and complete controller/plant initialization. Preserve activations, delay queues and solver-relevant state; resetting pose alone is insufficient. MuJoCo documents state/control handling and numerical integration separately. [Simulation](https://mujoco.readthedocs.io/en/3.6.0/programming/simulation.html#state-and-control), [integration](https://mujoco.readthedocs.io/en/3.6.0/computation/index.html#numerical-integration). These cited documentation pages target 3.6.0; confirm the required API and reset behavior in the installed 3.13.0 JS/WASM build before implementing the contract.

Refine timestep and solver settings until endpoint, peak torque/force, energy balance, contact events and intervention conclusions converge within predeclared engineering bounds. Establish reproducibility on each intended platform; do not assume bitwise equality across platforms. Sweep uncertain anatomy, inertia, muscle capacity, resistance and latency, then selected interactions. Report unsupported parameter combinations and changes in qualitative conclusions.

Derive each acceptance threshold by documenting: the intended claim; source measurement resolution and repeatability; population/task applicability; preprocessing/registration uncertainty; numerical convergence error; and acceptable educational discrepancy. Use independent reference distributions where available. Proposed engineering tolerances need explicit review and cannot masquerade as clinical norms. Freeze thresholds before candidate tuning; any justified revision creates a new protocol revision and preserves the previous failure. Existing stricter gates remain intact.

## Proposed acceptance and delivery template

Attach a completed version to the applicable master context; placeholders confer no acceptance:

```text
Master context / phase / exact input identity:
Claim and excluded claims:
Reference ID / independent holdout identity:
Metric / units / time window / aggregation:
Threshold / derivation / uncertainty / approving reviewer:
Baseline / candidate / effect estimate and uncertainty:
Causal ablation / numerical convergence / sensitivity result:
Whole-body roles / skin and contacts / applicable bodies and sides:
Blender / round trip / native / simMOVE / simLAB manifest links:
Result: unexecuted | fail | unsupported | scoped pass
First failure time / phase / segment / retained evidence:
```

Inspect every actual bone, including pelvis-to-head, girdles, digits and helpers. Review actual male/female/neutral assets and applicable sides in editable Blender scenes. Held segments need measured bounds; the supported elbow fixture does not exempt the rest of the body. Sample all phases and densely bracket perturbations, saturation, support changes and loop seams. The catalogue's minimum sampling does not replace physics-step/event-aware contact checks. Evaluate visible skin, anatomical overlays, support reactions and colliders separately.

Native body contexts without actual solver support remain unavailable; a similar avatar or another body's evidence cannot substitute.

Use current scoped manifests required by the [catalogue process](../movement-catalogue-process.md). Record source, rig, physical model, parameters, controller, sensor configuration, datasets, preprocessing, tool versions, seeds and trial hashes. Edited load, speed, anatomy, delay or motion invalidates affected trial evidence. Verify both hosts with current engine pins; a replay supports only its recorded inputs. Live parameter changes need recalculation and their own bounded validation. Slow viewing must preserve physical timestamps.

On failure, preserve the candidate and first failing witness, classify the observed failure separately from its suspected cause, and link the finding to the master owner. Correct one justified mechanism, rerun affected and regression scope, and keep independent holdouts unopened until the planned assessment. Missing reference data or human review stays visibly unsupported; numerical completion cannot close it.
