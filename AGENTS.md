# Movement development requirements

Read `docs/unified-movement-development-prompt.md` before future movement work.
Reconcile source findings and references in the existing master, check its work
ownership before starting, and implement each shared correction once. Current
reference comparison and defect-specific closure evidence are enforced alongside
the existing whole-body and host review gates.

Use `docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html` as the one master for all joints
and all named motions. Read `docs/movement-catalogue-process.md` and
`docs/movement-engineering-charter.md` before changing movement behavior.

Account for every actual rig bone, including the entire pelvis-to-head chain.
Define roles, coordination owners and scoped constraints before tuning. Preserve
the frozen historical unreviewed baseline. Refresh must retain review records;
never reset the baseline or mark historical motions accepted to make CI pass.

The user requires actual Blender authoring/review for every movement change.
Read `docs/blender-workflow.md`. Inspect setup, transitions, hold, return and loop
on male/female/neutral and applicable sides; check rendered skin as well as markers.
Preserve clinical/patient/contact bounds. Keep editable projects and scoped,
current evidence for Blender, round trip, skin/contact, native simulation where
applicable and both hosts. Do not relabel stale force/deformation data as current.

Run `npm run catalogue:check` and existing relevant checks. The same master must
ship through both hosts' engine pins. Do not bypass build/CI gates, hide failures,
loosen thresholds to pass, or claim numerical completion establishes clinical
or visual acceptance. Continue already authorized reversible work autonomously;
commit/PR/merge only when the user's session authorizes those actions.
