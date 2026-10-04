# Template reference/prose provenance supplement

This folder retains evidence for a proposed update to the existing reference and defect records in the [canonical master](../../../MASTER-MOVEMENT-JOINT-CATALOGUE.html). It supplements the [primary-reference audit](../template-reference-correction-2026-10-03/evidence.json).

- `definitions-before.json` and `definitions-after.json`: exact retained captures from the reference/planner prose correction.
- `definitions-current.json`: fresh current capture through the versioned `scripts/catalogue/capture-template-motion-definitions.ts` tool.
- `evidence.json`: verified definition parity, current source identities, tool version/command, retained artifact hashes and explicit limitations.
- `reference-records-before.json`: original canonical bibliography/claims/verification records preserved before the proposed metadata updates.
- `source-inventory-before.json` and `source-inventory-after.json`: complete actual engine and both-host source inventories around the fresh capture.
- `corrected-reference-sheet.snapshot.md`: exact current reference document snapshot. Its historical relative links retain the original `docs/movement-templates-reference.md` location semantics.

All 25 executable template definitions and their composed motions are identical before, after and in the fresh capture. The definition hash uses `JSON.stringify({templates,motions})`; only the template coordination/source prose is excluded. Rendered planner prose changed. This does not qualify future language-planner outputs or any clinical, trajectory, contact, native or host behavior.

No canonical HTML, runtime source, gate, tolerance, closure or clinical sign-off was edited by this evidence preparation. The proposed update preserves historical source/findings, existing reference IDs, partial coverage and all open clinical gaps.
