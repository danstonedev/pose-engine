# Unified movement development execution prompt

Act as my lead engineering partner for completing the movement catalogue and improving movement realism across pose-engine, simMOVE and simLAB. Run one coordinated program from the existing master: consolidate known defects, connect the movements to their real reference data, strengthen enforcement, and correct the defects through verified shared implementations. Continue through bounded implementation and validation batches; a new inventory, roadmap or passing build does not finish this mission.

This is the execution prompt for future movement work, adopted on 2 October 2026. It supplements the existing engineering charter and catalogue process. It is an instruction document; all movement requirements, defects, references, work ownership and acceptance status belong in the single master.

## Read the current state before changing it

Read [engine instructions](../AGENTS.md), the [engineering charter](movement-engineering-charter.md), [catalogue process](movement-catalogue-process.md), [Blender workflow](blender-workflow.md), and [historical movement status](movement-improvement-status.md). In the shared workspace, also read `movement-realism-implementation/AGENTS.md` and `movement-realism-implementation/remaining-batches/shipment-2026-10-01.md` when available. Inspect actual branches, dirty files, worktrees, active workers, open PRs, engine pins, tools and retained evidence. Verify current identities before relying on any checkpoint.

Identify work already implemented, already shipped, actively being corrected, superseded or still unsupported. Preserve active floor-contact, native tracking, recording and import work. Coordinate with its owner and reuse its results when their scope and identities match. Do not restart a correction or create another branch for the same cause because the work is absent from a catalogue row. Treat historical OPEN labels and measurements as findings to reconcile, rather than automatic proof of current defects.

## Keep one master and one shared implementation

Use [MASTER-MOVEMENT-JOINT-CATALOGUE.html](MASTER-MOVEMENT-JOINT-CATALOGUE.html) as the canonical ledger. Extend its embedded machine-readable data and interface for defects, reference sources, reconciliation and work ownership. Preserve existing joint records, notes, observations, identities and the pinned historical baseline. Version and migrate the schema through the existing generator and gate; verify save, reload and refresh preserve every supported record.

Derive inventories and progress views from this master. Supporting reports, raw data, Blender projects and captures remain linked evidence artifacts. Convert existing backlog documents into linked historical evidence or generated views after reconciliation. Do not maintain an independently edited second backlog, regional acceptance catalogue, host-specific defect register or separate work assignment ledger.

Implement shared anatomy, coordination, recipes and contact behavior once in pose-engine or the existing authoritative shared subsystem. Hosts consume that implementation. Record actual host-specific delivery defects where they exist; do not copy a shared correction into separate host implementations.

## Account for every known finding

Inventory the source material that could contain findings: current audits and status documents, shipment reports, prior inventories, reference notes, source TODOs, failing tests, retained measurements, rejection reports, accessible issue/PR discussions, and user reports or screenshots available in the session. Register each inspected source and its revision or content hash. Record unavailable sources and unresolved mapping gaps explicitly.

Give each finding a stable source locator and a disposition: linked to a canonical defect, duplicate of another finding, resolved with matching evidence, superseded by a later result, historical and awaiting reproduction, or excluded with a recorded reason. Preserve the original observation and its measurement scope. Record the current reproduction separately. Make this reconciliation repeatable: rerunning it updates existing identities and does not multiply records.

Give each canonical defect a stable ID, concise symptom, affected motion IDs, body/side/phase and playback paths, affected joints or anatomical chain, source findings, severity, owner, dependencies, reproduction, expected behavior, acceptance criteria, current status, next action and evidence links. Label suspected root causes as hypotheses until tested. Link one shared defect to all affected contexts; do not duplicate it for each bone or host. Keep related symptoms separate when a common cause is unproven.

Keep unavailable recipes, unsupported anatomical claims, missing references and unreviewed motions visible as distinct gaps. A default Unreviewed row is not a recorded defect. If a finding cannot map to a current motion, retain it as an explicit mapping gap; do not silently discard it or force an incorrect match.

## Connect each movement to its reference data

Start with existing [template references](movement-templates-reference.md), reference-media provenance, retained authoring sources and assessment protocols. Verify cited primary sources when incorporating their claims. A document saying literature validation occurred is a lead to verify, rather than a substitute for traceable reference data.

Give each reference a stable ID and record its type, title/creator, edition or version, exact URL/DOI or retained asset path, relevant pages/figures/timestamps, content hash where available, access date, license and retention conditions. Record task, population, body dimensions, laterality, load, speed, equipment, units, coordinate systems, sampling and relevant uncertainty. Preserve raw observations and identify preprocessing, mirroring, time normalization, interpolation and retargeting separately.

Link references to the exact movement, contexts, phases, joints and claims they support. Distinguish protocols, normative ROM limits, measured trajectories, demonstration media, clinician decisions and authoring assumptions. Specify expected coordination, timing, contacts and endpoint criteria with justified tolerances and uncertainty. Record observed, derived and assumed channels separately. Preserve media timestamps and landmarks; retain reproducible access to the needed source instead of relying solely on one browser's storage.

Do not infer whole-body coordination from a ROM table, independent scapular or vertebral motion from unsupported imagery, or natural motion from the engine's own output. Do not prescribe one universal shoulder ratio or spine distribution. Missing or unsuitable data remains an owned reference gap with a next action. Unsigned clinical review remains unsigned. Never invent data, licenses, numerical tolerances or clinical approval.

## Assign ownership and reuse work

Record work units in the master with stable IDs, linked defects/references, affected contexts and files, one accountable owner, an integration branch, dependencies, progress and next action. Check existing assignments before starting. Choose coherent batches by shared root cause and risk, rather than by catalogue row count.

Parallelize independent investigation, reference extraction and isolated changes when useful. Use one integrator for the canonical HTML and shared schema; workers return patches or structured findings against a recorded revision. Coordinate writes and detect conflicting revisions. Use isolated copies for Blender experiments and one owner per editable project or overlapping solver change. Integrate existing drafts instead of opening duplicate PRs.

Reuse evidence only when the exact inputs and acceptance scope match. One artifact may support several contexts only when it actually covers them and each link passes the existing identity checks. Source changes invalidate affected evidence. Do not repeat a completed experiment solely because another host or agent needs its result; do run fresh checks when changed inputs or unresolved concerns require them.

## Correct and validate the complete motion

For each bounded work unit, reproduce the current baseline, define acceptance before tuning, select the smallest coherent correction, and validate the affected scope through the existing pipeline. Finish active corrections before starting overlapping work. Prioritize confirmed shared failures, including the reported shoulder flexion/abduction inconsistency and coordinated head-to-hip motion, according to current severity and dependencies.

Account for every actual rig bone. The adoption snapshot contains 101 identities; discover the current skeleton rather than hard-coding that count. Include Hips, Spine_Lower, Spine_Mid, Spine_Upper, Neck_Lower, Neck and Head, both shoulder girdles, limb joints, digits and deformation helpers. Assign driven, derived with an owner, held, contact, free or explicitly not-involved roles with purpose and measurable constraints. Account for all segments without forcing every segment to move.

Use the actual production bodies in editable Blender projects. Review setup, transitions, motion, hold, return, loop seams and following-motion state on male, female and neutral bodies and applicable sides. Inspect local/world bone motion, clinical readouts, visible skin, support/contact, elbow/knee direction, gaze and pelvic/trunk coordination as relevant to the task. Apply reference comparisons to supported channels; record unsupported anatomical detail explicitly.

Transfer corrections through the shared engine. Verify export/replay agreement and actual playback in both hosts, including live, sampled, recorded and edited paths when affected. Run the existing native simulation when applicable; document its unavailable contexts and justified non-applicability. Use dense or event-aware checks for contact and transitions, with repeatability and timestep checks where relevant. Preserve clinical/patient limits, existing thresholds and failed candidates. Never conceal a defect by changing a gate, silently increasing actuator capacity, disabling relevant collisions or rebaselining the master.

Store current hashes, tool versions, commands/results, editable projects, matched captures and measurements. Identify the first failing time, phase, segment and metric. Distinguish import success, numerical completion, tracking, skin/contact, reference agreement, visual acceptance, clinical review, merged code and deployed delivery. Each claim needs its own evidence.

## Extend the existing development gates

Extend the current catalogue generator, sampler, validation gate, UI and regression coverage. Validate defect/reference/work links, scope applicability, reference completeness, reconciliation dispositions, evidence identities and preservation across regeneration. Require adequate reference support and resolved applicable release-blocking defects before accepting a new or changed context. Treat assumptions and missing evidence explicitly; do not let a prose note or status selection bypass a requirement.

Preserve the historical unreviewed baseline without promoting its motions to accepted. Define migration behavior explicitly, keep legacy limitations visible, and ensure changed motions cannot inherit an exemption to avoid review. Close defects only for the verified context scope; partially corrected families retain their open contexts. Schema coverage tests should reject orphan links, dropped records, duplicated imports, unsupported closure claims and stale evidence.

## Deliver coherent batches and continue from the master

Begin with a bounded catalogue/schema batch that preserves existing data, imports and deduplicates known findings, connects existing references, and makes missing coverage visible. Then complete the highest-value implementation units using the same workflow. Continue until the declared scope is verified, or a specific dependency needs external evidence or a user decision. Continue independent work while that dependency remains open.

Carry forward the user's existing authorization to commit, open PRs and merge when ready. Check current session instructions and repository rules; do not request the same approval again. Publish coherent changes with current catalogue/evidence, pass required checks, merge the shared engine first, update both host pins, and verify delivered revisions where applicable. A merged enforcement change does not close a motion defect.

At handoff, update the master with completed units, current owners, exact revisions, open failures and the next ready unit. Report source findings reconciled and unresolved mappings, canonical defects and duplicates merged, reference coverage and missing data, verified motion contexts, and merged/deployed results separately. Claim all known findings are accounted for only against the recorded inspected source set. Claim the mission complete only when its coverage and acceptance criteria are met; unresolved limitations stay explicit.

## Completion criteria

- Every finding in the inspected source set has a traceable disposition in the master, including historical and superseded findings.
- Every current motion and declared context has explicit defect/reference coverage; missing evidence and unsupported behavior are visible and assigned.
- One canonical record and owner coordinate each shared correction, and both hosts consume the same verified implementation.
- Reference-supported intent and measured whole-body behavior remain distinguishable, with current evidence for each acceptance claim.
- Existing records survive save, reload and refresh; the development gates enforce the new requirements without weakening the historical baseline or movement checks.
- Each defect reported as fixed has passed its scoped closure criteria. Open, partial, stale, blocked and unsupported cases remain open and accurately reported.
