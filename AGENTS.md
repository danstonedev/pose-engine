Read `docs/unified-movement-development-prompt.md` before movement work. Reconcile defects, references and shared ownership in the single master; changed and reviewed contexts require current comparison and closure evidence.

# Blender is required for movement work

Use the workspace's single master movement–joint catalogue at
`docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html`
before editing a movement. Follow the catalogue protocol in
`docs/blender-workflow.md`: identify motion/body/side/phase; define joint roles
and shared controller ownership; validate the complete body, including head to
pelvis; refresh the same master and record scoped, current evidence. Do not
create separate regional acceptance catalogues or treat missing targets as
held/uninvolved joints. Catalogue roles still require runtime measurement;
the master is enforced by build/CI gates. Read docs/movement-catalogue-process.md.

Read `docs/movement-engineering-charter.md` before movement improvement work. This
is the user's standing engineering brief: audit the actual pipeline, define gates
before tuning, make a bounded improvement and retain reproducible evidence. Extend
the existing MuJoCo pathway; distinguish authored playback, simulated replay, live
recalculation and experimental validation. Check actual skin and contact surfaces,
not only joint markers. Never reuse old trial forces/deformation for edited motion.
Record source/asset/configuration identities, assumptions and unsupported behavior.


The user requires Blender authoring and full-motion visual review for **all movements**, not only floor or upper-extremity motions.

Read `docs/blender-workflow.md` when changing a movement, contact solver or body deformation. Use actual production rigs; author coherent whole-body movement with contact anchors and elbow/knee guides as needed. Include the head and neck.

Check setup, transitions, assessed hold, return and looping on male/female/neutral models and applicable sides. Transfer changes through the shared engine, preserve clinical and patient bounds, and verify rendered skin and playback in both consuming apps. Native physics checks are also required when the change affects their inputs or behavior.

Keep editable Blender projects and reproducible evidence. A solver completion, a small marker residual, or a still pose is not sufficient movement acceptance. Explicitly record remaining visual, contact and tracking gaps. No extra user confirmation is required for already authorized local implementation and verification.
