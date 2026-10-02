# Enforced movement catalogue

[MASTER-MOVEMENT-JOINT-CATALOGUE.html](MASTER-MOVEMENT-JOINT-CATALOGUE.html) is the
single requirements, inventory, measurement and review ledger. Both hosts consume
this file through their pinned shared engine. Do not create regional catalogues.

The adoption snapshot records 291 named motions, 1,422 body/side contexts and all
101 bones on each production rig. The seven pelvis-to-head segments are mandatory,
as are shoulder girdles, limbs, every digit and deformation helper. The initial
baseline is **historical and unreviewed**, not an acceptance claim. No existing
movement became Blender-reviewed or clinically qualified through this change.

## Unified defects and reference data

Read [the unified execution prompt](unified-movement-development-prompt.md).
Catalogue schema 2 embeds `program` schema 1 in the same `catalogue-data` block.
Its `sources`, `findings`, `defects`, `references`, `workUnits` and per-motion
`coverage` records are the shared backlog, provenance and ownership ledger.
Retained reports are supporting evidence; their old OPEN labels and numerical
results must be reconciled against later source revisions. Pending sources and
unmapped findings remain visible. Counts describe the recorded source set.

The HTML displays defects, references and shared work for the selected body/side,
with an editor for existing program records. Save the master to retain changes
outside this browser. Conflicting browser drafts preserve the file's current
record and require reconciliation. Refresh preserves the entire program and
existing joint tracking. CI rejects orphan links, repeated imports, dropped
coverage, conflicting active ownership and unsupported closure claims.

New or changed reviewed contexts require `referenceAcceptance` in their current
`$review` record: applicable verified reference IDs, a reviewer, limitations and
passing criteria tied to exact supported claim IDs. ROM limits alone do not
establish coordinated movement. Citation-only, assumed and unavailable data stay
visible but cannot grant acceptance. Source verification establishes only the
recorded reference claims; it does not qualify the production movement.

Each comparison criterion retains a hashed JSON manifest with
`kind: "reference-comparison"`, exact `context` and `identity`, `referenceId`,
`referenceIdentity` (from the gate's `referenceIdentity(reference)`),
`criterionId`, `claimIds`, `result`, `reviewer`, `method`, `scope`,
`comparison: {expected, observed, limitations}` and retained `artifacts`.
Quantitative manifests additionally retain `measurements` with metric, value,
units, justified min/max bounds, threshold basis and supported claim IDs.
The gate checks the values against those bounds. Qualitative claims require
accountable scoped review and underlying captures or data.

An applicable blocking defect prevents context acceptance until that exact scope
has current closure. Each closure contains its context/identity, the existing
required stage reports and hashed `acceptanceEvidence`. This JSON manifest has
`kind: "defect-closure"`, `defectId`, context/identity, result, reviewer, scope and
one passing `criteria` entry for every declared acceptance description, with an
observed result and retained evidence. Generic stage reviews cannot close an
unrelated defect. A family stays partial until every declared context is closed.

Import findings by stable ID with the existing reconciliation tool:

```powershell
node scripts/catalogue/reconcile.mjs docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html INPUT.json preview
node scripts/catalogue/reconcile.mjs docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html INPUT.json apply EXPECTED_MASTER_SHA256
```

Imports retain existing records and stop on differing input instead of overwriting
reviewed work. The apply command checks the inspected file identity before writing.
Source snapshots are immutable evidence with original file hashes and extraction
selectors where only inspected portions were retained. Engine CI compares against
the previous master to prevent silently dropping findings or rewriting provenance.
Historical unchanged motions remain unreviewed; this migration grants no acceptance.

## What blocks delivery

The shared engine CI, simLAB CI and both hosts' production build scripts run the
catalogue gate. It rejects missing files, stale source/rig hashes, newly omitted
runtime/native input files, incomplete actual skeleton inventories and mismatches between the
master and the live simLAB registries. Native model/controller inputs, all engine GLB assets and locked dependencies
are included in freshness checks. Source hashes normalize Windows/Linux line
endings; binary rig and evidence hashes identify exact bytes.

For new or changed available contexts, and previously reviewed contexts, it requires:

- A deliberate driven, derived, held, contact, free or not-involved role for every
  actual bone. Derived roles name their owning bone; stabilization and support
  declare measured angular and positional bounds respectively. Free roles still
  require explicit purpose, scope, evidence and a measured trajectory.
- Current complete production-rig observations at 30 Hz or higher. These include
  render-time twist helpers, local/world rotation, world displacement/path and
  clinical angle extrema where the engine models them. Declared numeric constraints
  must pass. Any entered phase record must also be current and resolved.
- Separate passing, scoped manifests for Blender, export/replay round trip,
  visible skin/contact, simLAB and simMOVE. Native simulation is required when
  applicable; a non-applicability decision needs an explicit reason. Manifests
  cover setup, transitions, hold, return and loop, retain hash-checked artifacts,
  and identify the reviewer and tool version. Blender requires an editable project.

CI resamples reviewed trajectories and compares constraints to fresh measurements;
it does not trust a manually edited measured summary. A status dropdown, prose
evidence reference or successful inventory generation alone cannot pass this gate.
The sampler measures skeletal motion, not skin clearance or clinical quality.
Visual and clinical conclusions remain accountable human review decisions in the
separate manifests. Uniform sampling is not a replacement for event-aware native
contact/physics checks.

Construction changes are scoped by reconstructing their complete resulting motion
definitions. Changes to shared solver, anatomy, playback or un-reconstructed host
sources conservatively invalidate all available contexts. All three bodies and
applicable sides remain separate requirements. Registry-only clips stay visibly
unsupported; enabling one creates an acceptance requirement.

## Author and review a change

1. Open the master. Locate the motion ID/body/side and inspect all bones, including
   the entire spine and head. Define roles, owners and task-specific constraints
   before tuning. Do not invent universal shoulder ratios or obligatory spine motion.
2. Use actual production rigs in Blender as required by
   [the Blender workflow](blender-workflow.md) and
   [the engineering charter](movement-engineering-charter.md). Retain failed evidence.
3. Refresh from simLAB with both host checkouts available:

   ```powershell
   $env:SIMMOVE_CATALOGUE_ROOT='../simmove'
   node scripts/movement-inventory/run.mjs refresh
   $env:MOVEMENT_CATALOGUE_CONTEXT='joint:shoulder-flexion'
   node scripts/movement-inventory/run.mjs sample
   ```

   A motion ID samples all its body/side contexts. An exact JSON context key, e.g.
   `["joint:shoulder-flexion","male","left"]`, narrows diagnostic sampling. Build
   checks always cover every required context regardless of this filter.
4. Enter roles/constraints and the context's manifest references in the HTML. Save
   the updated file back to `pose-engine/docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html`.
   Browser storage alone is not visible to CI. Refresh preserves embedded reviews,
   observations and the original baseline; stale records stay stale. It offers no
   rebaseline command. The baseline digest is pinned in `scripts/catalogue/baseline-pin.json`.
5. Run `node scripts/movement-inventory/run.mjs check` in simLAB and
   `npm run catalogue:check` in simMOVE and the engine. Commit the same master,
   evidence artifacts and engine implementation together. Merge the engine first,
   then update both host gitlinks and run their existing checks. No accepted context
   may be silently removed; retirement requires an explicit policy change and review.

Every manifest lives in the engine checkout and is referenced by `{stage,path,sha256}`.
Use this shape with real evidence and exact current scope identities:

```json
{
  "stage": "blender",
  "result": "pass",
  "context": "[\"joint:shoulder-flexion\",\"male\",\"left\"]",
  "identity": "CURRENT_CONTEXT_SHA256_FROM_MASTER",
  "reviewer": "Reviewer name",
  "toolVersion": "Actual tool version",
  "scope": "What was inspected and measured; thresholds and limitations",
  "phases": ["setup", "transitions", "hold", "return", "loop"],
  "artifacts": [
    {"kind":"editable-project", "path":"docs/catalogue-evidence/candidate.blend", "sha256":"ACTUAL_FILE_SHA256"},
    {"kind":"capture", "path":"docs/catalogue-evidence/review.mp4", "sha256":"ACTUAL_FILE_SHA256"}
  ]
}
```

Store evidence under `docs/catalogue-evidence/`, whose bytes are preserved by
Git attributes. Paths outside the repository and escaping symlinks are rejected.
The manifest represents a review assertion with retained evidence; automation
cannot decide whether a rendered shoulder looks anatomically natural.

Custom patient motions and combinations of pain, speed, load or impairment remain
outside the named default inventory. Add explicit contexts and reconstructible
definitions before claiming acceptance for them. The gate does not certify this
unbounded parameter space or make the existing robotic motions realistic by itself.
