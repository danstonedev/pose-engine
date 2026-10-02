# Movement authoring requirement

## Unified execution prompt

Before future movement development, read and follow
[UNIFIED-MOVEMENT-DEVELOPMENT-PROMPT.md](UNIFIED-MOVEMENT-DEVELOPMENT-PROMPT.md).
It coordinates known-defect reconciliation, reference provenance, work ownership,
shared implementation and evidence-based closure through the existing single master.
It supplements the standing charter and catalogue process below. Writing the prompt
does not establish that its reconciliation, reference coverage or new gates are complete.

## One master movement–joint catalogue

Use `simmove/pose-engine/docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html`
as the single movement/joint requirements and review ledger for future movement
work. Its `catalogue-data` and `tracking-data` JSON blocks are readable by tools;
do not create separate movement, shoulder or spinal acceptance catalogues.

Before changing a motion, identify its master ID, body, side and phases. Inspect
all 101 current rig bones, including the entire pelvis-to-head chain. Decide
driven, derived (with the owning controller), held, contact, free or explicitly
not involved for each relevant joint/bone. Helper/digit groups may share an
identified owner; absence of a target is not evidence of stabilization or
irrelevance. Record unresolved intent instead of inventing a required excursion.

Translate task requirements into the existing shared engine controls and focused
trajectory checks. Review shared recipes' affected contexts. Keep authored
intent separate from observed local/world bone motion, visible skin, contact and
native tracking. Use Blender and both hosts as required below. Account for all
segments; do not require all segments to move.

After source/asset changes, refresh this same master with its documented inventory
command and retain embedded tracking records. Save browser edits into the master
file before expecting other tools/agents to see them. Attach current project,
capture and measurement references and explicit review scope to changed contexts.
Leave failing, unreviewed and stale cases open. Inventory construction passing or
a manually selected Verified status does not establish movement acceptance.

The master is now versioned in the shared engine and enforced in engine/host CI and both production build commands. Read `simmove/pose-engine/docs/movement-catalogue-process.md`. Stale inventories, missing roles/measurements/evidence and failed constraints block delivery. Refresh preserves the pinned historical unreviewed baseline and all embedded notes. Existing unfinished motion work remains unqualified; do not bypass or rebaseline it to pass.

## Standing engineering charter

Read `simmove/pose-engine/docs/movement-engineering-charter.md` before future
movement improvement work. It preserves the user's 2 October engineering prompt.
Audit actual code and delivery paths; define acceptance before tuning; improve one
bounded case through Blender, native simulation and both hosts before generalizing.
Use the existing MuJoCo integration. Separate authored motion, simulation replay,
live recalculation and experimentally validated behavior. Verify rendered skin as
well as landmarks, retain failed evidence, and never attach stale trial forces or
deformation to changed motion. Record versions, source/configuration identities,
assumptions and unsupported cases. Include all body regions, head and neck.


The user requires Blender to be used for every movement going forward (2026-10-02).

- Use the actual body assets and current motion in Blender before approving a movement change. Keep an editable project with contact anchors and bend-direction guides where applicable.
- Review the entire setup, motion, hold, return and loop, including transitions. Inspect all body regions, including head and neck, on male, female and neutral models and both sides where applicable.
- Correct the authored pose and coordinated motion in Blender, then transfer it through the shared pose engine. Retain the runtime's clinical limits, patient constraints and contact checks.
- Verify export/replay agreement, skin clearance, stable support contacts and both simMOVE and simLAB playback. Numerical completion or small wrist error alone is not visual or clinical approval.
- Record source hashes, project path, screenshots, test results and unresolved issues. Do not label older motions Blender-reviewed without that evidence.
- Continue authorized reversible work autonomously. The current user instruction is to finish remaining motion work before merging draft engine PR #168.

Shared tooling and instructions: `simmove/pose-engine/docs/blender-workflow.md`.
