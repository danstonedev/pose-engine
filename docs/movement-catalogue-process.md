# Enforced movement catalogue

[MASTER-MOVEMENT-JOINT-CATALOGUE.html](MASTER-MOVEMENT-JOINT-CATALOGUE.html) is the
single requirements, inventory, measurement and review ledger. Both hosts consume
this file through their pinned shared engine. Do not create regional catalogues.

The adoption snapshot records 291 named motions, 1,422 body/side contexts and all
101 bones on each production rig. The seven pelvis-to-head segments are mandatory,
as are shoulder girdles, limbs, every digit and deformation helper. The initial
baseline is **historical and unreviewed**, not an acceptance claim. No existing
movement became Blender-reviewed or clinically qualified through this change.

## What blocks delivery

The shared engine CI, simLAB CI and both hosts' production build scripts run the
catalogue gate. It rejects missing files, stale source/rig hashes, newly omitted
runtime files, incomplete actual skeleton inventories and mismatches between the
master and the live simLAB registries. Source hashes normalize Windows/Linux line
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
