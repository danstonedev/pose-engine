---
name: verify-gate
description: >-
  Run pose-engine's exact pre-commit/pre-push checks (svelte-check type gate +
  vitest). Use before committing or pushing changes in this repo, when asked to
  "verify", "run checks/tests", confirm a change is green, or reproduce the CI
  typecheck+test gate locally. Captures the precise npm commands.
---

# pose-engine verify gate

Svelte / Vite library, **npm**. CI runs a type-check + unit gate (svelte-check +
vitest) — match it. If deps aren't installed, run `npm install` first. Run from the
repo root, in order; stop and fix on the first failure:

1. **Type-check** — `npm run check` (→ `svelte-check`).
2. **Unit tests** — `npm run test` (→ `vitest run`).

For a manual look, `npm run dev` launches the playground (`playground/vite.playground.ts`;
`predev` copies models). Report actual command output; paste failures rather than
summarizing green.
