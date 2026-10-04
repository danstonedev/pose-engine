/** Retain executable definitions separately from reference/planner prose. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MOVEMENT_TEMPLATES, describeMovementTemplates, templateToComposedMotion } from '../../src/services/movementTemplates';
const [output] = process.argv.slice(2);
if (!output) throw Error('Provide a fresh output JSON path');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const templates = MOVEMENT_TEMPLATES.map(({ coordination, source, ...definition }) => definition);
const motions = MOVEMENT_TEMPLATES.map(templateToComposedMotion);
const report = {
  kind: 'template-executable-definition-snapshot',
  templates, motions, definitionSha256: sha(JSON.stringify({ templates, motions })),
  plannerProse: describeMovementTemplates(),
  sources: ['movementTemplates.ts', 'movementTemplates.data.ts'].map(name => ({ path: 'src/services/' + name, sha256: sha(readFileSync(new URL('../../src/services/' + name, import.meta.url))) })),
};
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ templates: templates.length, definitionSha256: report.definitionSha256 }));
