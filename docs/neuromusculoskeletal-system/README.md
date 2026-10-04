# Neuromusculoskeletal system research and implementation plan

This package defines how to incrementally build a functional sensory, motor and musculoskeletal system for simMOVE and simLAB. It connects scientific research, anatomical foundations, reproducible controllers, injury modeling, delivery and testing. Start with one supported task and expand only after its mechanisms and visible behavior have evidence.

Prepared on 2 October 2026. **Status: researched planning package; the proposed nervous system and muscle controllers have not been implemented or validated.** The current software audit and documentation integrity checks are separate deliverables. No clinical signoff, movement acceptance, release or deployment follows from this plan.

## Start here

Read [current capabilities and scope](00-current-state-and-scope.md), then [the delivery roadmap](05-delivery-roadmap.md). Use the remaining documents as working specifications during each increment.

| Document | What it helps us do |
| --- | --- |
| [Current capabilities and scope](00-current-state-and-scope.md) | Establish what exists, what is missing, and which claims the program intends to support |
| [Research and sources](01-research-and-sources.md) | Evaluate primary literature, tools, models and datasets with their limitations |
| [System architecture](02-system-architecture.md) | Define the sensory and motor loop, patient state, interfaces and runtime responsibilities |
| [Foundation and anatomy](03-foundation-and-anatomy.md) | Establish joint conventions, mechanical anatomy, muscle paths and alignment with visible skin |
| [Validation and experiments](04-validation-and-experiments.md) | Design the first task, verify equations, validate behavior and diagnose failures |
| [Delivery roadmap](05-delivery-roadmap.md) | Sequence increments, dependencies, required artifacts and exit decisions |
| [Expert review and decisions](06-expert-review-and-decisions.md) | Conduct synthetic specialist reviews and obtain accountable clinical and scientific review |
| [Working protocols and templates](07-working-protocols.md) | Prepare a research question, implementation batch, experiment and handoff |
| [Planning review](08-planning-review.md) | See the synthetic critiques and safeguards incorporated before implementation |
| [Source library](sources.json) | Read structured literature and tool provenance; this is not a movement acceptance register |
| [Current source snapshot](current-state-snapshot.json) | Identify the selected files, repository states and tool versions inspected during planning |

## Proposed first increment

Use a supported elbow flexion and extension task as the **initial candidate**, subject to the foundation and dataset checks. A supported region reduces the number of unvalidated balance and contact mechanisms that could explain a failure. Reuse an existing native fixture only after confirming its joint geometry, supports and represented actuation are suitable.

First verify that an existing bounded torque controller consumes its permitted sensory channels, then test predeclared delay and reliability hypotheses. Null, improved or adverse performance can all be legitimate results; verify channel consumption separately from performance degradation. Introduce a calibrated agonist and antagonist muscle model for that region after the interface checks. Compare an intact condition, a changed load, reduced motor capacity and degraded sensory feedback with identical goals and frozen controller parameters. Evaluate mechanical impairment separately. These are mechanism experiments until independent clinical evidence supports a named disorder.

The first implementation entry point is [the foundation audit and task decision](05-delivery-roadmap.md#increment-0-research-and-task-definition). The plan includes a concrete experiment protocol, but no synthetic clinical measurement or numerical acceptance tolerance has been invented.

## How this fits the existing program

The [engineering charter](../movement-engineering-charter.md), [catalogue process](../movement-catalogue-process.md) and [Blender workflow](../blender-workflow.md) remain binding. The [versioned unified execution prompt](../unified-movement-development-prompt.md) coordinates active work.

The [master movement and joint catalogue](../MASTER-MOVEMENT-JOINT-CATALOGUE.html) remains the only movement requirements, defects, movement references, ownership and acceptance ledger. Register each implementation unit and its affected contexts there using the supported schema; link these documents as specifications. Generic literature citations here become master reference records when they support a particular movement claim. Supporting protocols and blank templates do not create another backlog or authorize closure.

Preserve the ongoing floor support, shoulder and native tracking work. Reconcile dependencies with its current owner before touching shared code or assets. The first regional experiment can remain isolated until it is ready for a shared implementation and both-host qualification. Every changed movement requires the existing whole-body Blender review, including head and neck, body variants and applicable sides.

## Check this package

From the shared engine checkout:

```powershell
node docs/neuromusculoskeletal-system/validate-plan.mjs
```

This checks document links, source records and audit structure. It does not run a simulator, verify physiology, access remote URLs or satisfy the movement catalogue gate. To check whether the selected inspected source files still match this historical audit:

```powershell
node docs/neuromusculoskeletal-system/validate-plan.mjs --check-snapshot
```

Retained checks: [earlier package integrity report](package-validation-2026-10-02.json) and [five negative integrity probes](integrity-negative-checks-2026-10-02.json). Reports identify their execution time and checked scope. Re-run the command above for the current documents; the simulation protocols remain unexecuted.

A source mismatch means the audit must be revisited. Preserve the prior snapshot and capture a new one using a fresh filename:

```powershell
node docs/neuromusculoskeletal-system/capture-current-state.mjs --out current-state-snapshot-next.json
```

The capture tool performs read-only inspection and writes only the named snapshot within this package. It refuses to overwrite an existing file. Future simulation evidence uses the authoritative catalogue and experiment identity mechanisms, not this limited planning snapshot.
