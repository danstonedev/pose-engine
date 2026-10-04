# Working protocols and reusable templates

Use these templates to turn the research plan into a bounded implementation and a reproducible review. They are blank specification formats. Actual movement requirements, source references, defects, assignments and acceptance belong in the [existing master](../MASTER-MOVEMENT-JOINT-CATALOGUE.html). Attach the completed protocol as an evidence artifact and link its canonical records; do not maintain a second status register here.

## Begin an implementation session

Read the [versioned unified execution prompt](../unified-movement-development-prompt.md), [charter](../movement-engineering-charter.md), [catalogue process](../movement-catalogue-process.md), current master records and matching source evidence. Inspect dirty files and current workers before editing. Continue existing work when its scope matches instead of starting an overlapping correction.

Select one question from the [roadmap](05-delivery-roadmap.md). Name the affected master motion, body, side, phase and parameter conditions using actual identities. If the proposed task or parameter context is absent, extend the existing schema and generator through a bounded preservation-tested change; do not fabricate an accepted row or create a regional catalogue.

Record the baseline, then define acceptance and dependencies. Decide which files and Blender project one worker owns. Use isolated experiments with fresh output names. Implementation remains in the existing authoritative shared subsystem; hosts consume the same result.

The current catalogue schema 2 embeds `program` schema 1 with `sources`, `findings`, `defects`, `references`, `workUnits` and per-motion `coverage`. Reuse those records. Verified movement claims need current `referenceAcceptance` and claim-specific `reference-comparison` manifests; blocking defects require scoped `defect-closure` manifests with each acceptance criterion evidenced. The [catalogue process](../movement-catalogue-process.md) defines the actual fields and identity checks. A source-library citation or this blank template cannot substitute for those records.

For a prepared import, first run the existing reconciliation preview from the engine:

```powershell
node scripts/catalogue/reconcile.mjs docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html INPUT.json preview
```

`INPUT.json` denotes the actual prepared import artifact. Inspect additions and conflicts, coordinate with the master integrator, and use the documented expected-hash apply step only for the authorized canonical update. The preview itself does not modify or accept a motion.

## Research question template

```text
Question and intended educational use:
Master motion and context identities or an explicit mapping gap:
Population and represented body region:
Task goal, setup, support, load, speed and phases:
Independent variable and intact comparison:
Measured outcome channels and units:
Mechanism hypothesis and competing explanations:
Independent primary sources and exact supported claims:
Unmodeled regions and unsupported claims:
Minimum model needed to answer the question:
Calibration data, held out validation data and partition method:
Decision if required data or reuse terms remain unavailable:
```

Changing a question after seeing the result creates a new protocol version. Preserve the original question and result. A numerical mechanism result may be useful even when the corresponding human validation channel is unavailable; label that scope locally.

## Dataset and model intake template

```text
Source title, DOI or URL, version and access date:
Creator and attribution:
Archive identifier and selected file hashes:
License text or exact evidence URL and unresolved reuse terms:
Allowed acquisition, processing and redistribution scope:
Participants, task, laterality, equipment, load and sampling:
Raw measured channels:
Preprocessed measured channels and processing recipe:
Inverse estimated or learned channels and model identities:
Units, axis conventions, time base and calibration:
Missing data, exclusions and uncertainty:
Participant level train/calibration/validation split:
Muscles, joints, supports and pathological population coverage:
Claim each selected channel can validate:
Exact master reference records when used for a movement:
```

Keep original downloaded files intact in an appropriately licensed location. Store preprocessing code and a manifest separately. Never treat the simulator's own output or retargeted presentation as independent validation data. An accessible webpage does not establish the license of every linked asset.

## Experiment specification template

```text
Protocol version and canonical master links:
Baseline source, assets, model and controller fingerprints:
Solver and dependency identities including runtime binary:
Body and patient state configuration:
Supported parameter domain and rejection behavior:
Initial conditions and declared external supports:
Observation channels, units, rates, history, delays and seeds:
Controller observations and prohibited privileged channels:
Motor actuation type, bounds and residual assistance:
Environment and perturbation schedule:
Frozen versus learned controller condition:
Hypothesis, intact comparator, sham control and ablations:
Trials and replication rationale:
Calibration and validation separation:
Per physics step events and retained sample channels:
Metrics with derivation, units and aggregation:
Acceptance thresholds, source or uncertainty rationale:
Numerical convergence and sensitivity comparisons:
Expected failure reporting and terminal stop conditions:
Required editable Blender project and full cycle views:
Reviewer responsibilities and required manifests:
```

Choose replication from observed variability, uncertainty and the claim being tested. Do not reuse an arbitrary sample count or clinical tolerance from an unrelated task. Existing catalogue and runtime safety limits remain applicable and cannot be loosened by this protocol.

The [existing experiment runner](../../../experiments/lower-body/EXPERIMENT-RUNNER.md) provides source-aware staging, cache and failure semantics. Extend its authoritative fingerprints and report contracts when adding new sensors, models or controller state. This plan does not implement those extensions. Retain an interrupted trial as incomplete; identify a verified terminal failure separately from a process exception.

## Acceptance specification template

Use one row per claim and measurement; the [validation document](04-validation-and-experiments.md) explains how to choose metrics and derive tolerances.

| Claim | Scope | Observed channel | Threshold derivation | Required evidence | Decision authority |
| --- | --- | --- | --- | --- | --- |
| Fill in the exact claim | Task, body, side, phase and condition | Quantity, units and measurement procedure | Independent source, numerical convergence or uncertainty analysis | Current hashes, raw results, comparison and relevant manifests | Named role and actual reviewer when available |

Do not fill this template with default passing values. Missing measured channels, pending review and unsimulated body variants remain explicit. Agreement with another solver is a separate check from agreement with independent experiments. Report import, numerical stability, tracking, skin/contact, physiology, clinical review and delivery separately.

## Proposed trial evidence contract

This is a design checklist, not an implemented schema or a substitute for the existing runner and catalogue manifests. Extend those contracts compatibly before a new pipeline relies on these fields.

```text
identity:
  protocol and schema versions
  master context and current canonical identity
  source, rig, atlas, model, parameters and environment fingerprints
  observation, estimator, controller and actuation fingerprints
  runtime JS/WASM or service build, solver, platform and seed
time:
  physics timestep, controller tick, sensor sampling and render mapping
  channel capture timestamps, arrival timestamps and event interpolation rules
state:
  reconstructible initial model, patient state and controller memory
  represented and unrepresented channels and external support definitions
result:
  immutable result identifier, payload/chunk hashes and schema
  units/coordinate conventions and monotonic matched stream timestamps
  complete, passed, stopped and unsupported flags with precise meanings
  first failing physics time, phase, segment, check and raw witness
  observed metrics, stated thresholds and uncertainty
  body replay, activation estimates, forces and contact events from this trial
provenance:
  measured, inverse estimated, model generated or explicitly authored per channel
  source unchanged verification before and after execution
  editable project, outputs, captures and reviewer records
```

An identity must include inputs that can alter movement or displayed measurements. It must also include controller history, random state and task phase if trials resume from checkpoints. Resetting the body alone is insufficient. Authenticate serialized outputs separately from inputs; reject incomplete or corrupted chunks, mismatched body/measurement streams and late worker results belonging to superseded requests. The [architecture](02-system-architecture.md) describes the separation between actual simulator state and available sensory observations.

## Refinement procedure

1. Reproduce the failure with exact current inputs and locate its first event. Check whether the evidence itself is stale or the measurement convention is wrong.
2. Test competing explanations using the smallest controlled comparison. Check anatomy and supports before tuning a controller around their errors.
3. Change one justified mechanism or a coherent shared cause; preserve the rejected candidate and its scope.
4. Run the targeted checks and affected-context regressions. Add tests for meaningful invariants and failures, not tests that merely repeat implementation formulas.
5. Inspect actual Blender skin and the full motion, including held regions, head and neck. Verify native behavior and both hosts where applicable.
6. Update the master only for evidence-supported scope. Preserve failures, unsupported conditions and clinical review still required.

Record whether a solution improved the intended claim, its numerical behavior, reference agreement and delivered appearance separately. A better task score with implausible recruitment is an unresolved model or objective problem.

## Commands and execution scope

The following are existing entry points verified by source inspection. They are commands for later implementation batches; this planning session did not execute the movement suites or claim their results.

From simLAB, after a movement or relevant source change:

```powershell
$env:SIMMOVE_CATALOGUE_ROOT='../simmove'
node scripts/movement-inventory/run.mjs refresh
node scripts/movement-inventory/run.mjs sample
node scripts/movement-inventory/run.mjs check
```

Use the process document's exact context filter for a targeted diagnostic. Required delivery checks cover the complete affected scope. Save browser catalogue edits into the canonical file before expecting tools to read them.

From the engine, use `npm run catalogue:check`, `npm run check` and the change-appropriate tests. From simMOVE, use its corresponding catalogue, type and production build checks. Use the matched [Blender workflow](../blender-workflow.md) and retained project commands, including native checks when relevant. Avoid unrelated broad reruns unless a new change or unresolved concern justifies them.

## Handoff template

```text
Bounded question and resulting behavior:
Canonical master requirements, work and context links:
Source and configuration identities:
Files changed and shared implementation ownership:
Baseline and current comparison with units and scope:
Executed commands and results:
Unexecuted checks and the precise missing dependency:
Retained failure events and rejected candidates:
Blender, native, round trip, skin/contact and both host evidence:
Clinical review status and unsupported conditions:
What changed in learning or controller state:
Release and delivered revision evidence if actually performed:
Next justified action and dependency:
```

At the end of a batch, the next worker should be able to reproduce the result without relying on the chat transcript. Link the exact source and evidence; avoid assigning historical results to new code. The [expert review procedure](06-expert-review-and-decisions.md) guides scientific decisions and accountability.
