# Incremental movement merge policy

On 3 October 2026 the user changed the merge threshold: improvements to existing
issues may merge; newly introduced or worsened issues block. This supersedes the
older requirement that an implementation batch qualify every affected historical
context before delivery. It does not change clinical acceptance or numeric bounds.

The production and CI catalogue checks compare the candidate with the PR base
revision, or the previous revision for a push. Host checks use the engine gitlink
at that host revision. Local checks use the merge base with `origin/main` (the
previous commit when already on main). Git history must be available; a missing
base fails the check. Evidence in the base is read from Git, not candidate files.

Both snapshots are assessed with the same qualification validator, including
historical available contexts. Existing missing roles, reference comparisons,
clinical review and stage evidence remain visible and unqualified. They do not
become new defects solely because a shared source hash changes. Previously fresh
measurements or evidence becoming stale create new failures and must be refreshed.
Every retained measured or reviewed context is sampled again at 30 Hz by the
production-rig sampler. Unmeasured contexts remain explicit gaps.

Each context and failure is compared independently. Removing one failure cannot
offset a new failure elsewhere. Numeric failures compare distance outside the
same bounds: improving 20 to 15 with a ceiling of 10 may merge; increasing to 25
blocks. Bounds cannot be widened or removed to manufacture improvement. New or
newly available contexts need their own qualification.

Inventory freshness, actual skeleton completeness, provenance, artifact hashes,
program links and record preservation remain enforced. Frozen adoption baseline
and pin rewrites, dropped tracking records, removed native requirements and
weakened existing blocking defect requirements fail the gate. Existing malformed
structural or provenance data must be repaired. Defect closure still requires
current, scoped evidence for every acceptance criterion; merging an improvement
does not mark a motion clinically accepted or native simulation validated.

The strict `evaluateCatalogue` API remains available for qualification. CI and
production use `evaluateProgress` for merge eligibility and report remaining
qualification issues separately. Existing unit, skin/contact, native and browser
checks continue to run under the repository's protected merge requirements.
