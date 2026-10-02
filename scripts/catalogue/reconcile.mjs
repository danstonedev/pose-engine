import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COLLECTIONS = ['sources','findings','defects','references','workUnits'];
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function migrateProgram(previous, contexts) {
  const program = structuredClone(previous ?? {schemaVersion:1,sources:[],findings:[],defects:[],references:[],workUnits:[],coverage:[]});
  if (program.schemaVersion !== 1) throw Error('Unsupported movement program version; use an explicit migration.');
  for (const name of [...COLLECTIONS,'coverage']) if (!Array.isArray(program[name])) throw Error(`Movement program ${name} must be an array.`);
  const present = new Set(program.coverage.map(item => item.motionId));
  for (const motionId of new Set(contexts.map(context => context.id))) if (!present.has(motionId)) {
    program.coverage.push({motionId,defectReview:'pending',referenceStatus:'missing',defectIds:[],referenceIds:[],gapReason:'Known findings and reference applicability have not been completely reconciled.',owner:'catalogue-integration',nextAction:'Reconcile source findings and obtain scoped reference support.'});
  }
  return program;
}

export function reconcileProgram(previous, incoming, contexts) {
  const program = migrateProgram(previous, contexts), added = {}, conflicts = [];
  for (const name of COLLECTIONS) {
    const records = incoming[name] ?? [];
    if (!Array.isArray(records)) throw Error(`Import ${name} must be an array.`);
    const known = new Map(program[name].map(record => [record.id,record])), seen = new Set();
    added[name] = 0;
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || !record.id.trim() || seen.has(record.id)) throw Error(`Missing or duplicate import ID in ${name}: ${record?.id}`);
      seen.add(record.id);
      if (!known.has(record.id)) {program[name].push(structuredClone(record));known.set(record.id,record);added[name]++;}
      else if (hash(known.get(record.id)) !== hash(record)) conflicts.push({collection:name,id:record.id,reason:'Existing record retained; reconcile differing input explicitly.'});
    }
  }
  // Coverage is a derived index. Reconciliation status remains explicit and does
  // not become accepted simply because a defect or citation was imported.
  for (const entry of program.coverage) {
    const contextsForMotion = contexts.filter(context => context.id === entry.motionId);
    const matches = record => contextsForMotion.some(context => {
      const scope = record.scope ?? {};
      return (scope.motionIds?.includes(context.id) || scope.allAvailable === true && context.available) && (!scope.bodies?.length || scope.bodies.includes(context.variant)) && (!scope.sides?.length || scope.sides.includes(context.side));
    });
    entry.defectIds = program.defects.filter(matches).map(record => record.id).sort();
    const referenceIds = program.references.filter(matches).map(record => record.id).sort();
    const changed = JSON.stringify([...entry.referenceIds].sort()) !== JSON.stringify(referenceIds);
    entry.referenceIds = referenceIds;
    if (changed || entry.referenceStatus !== 'linked') entry.referenceStatus = entry.referenceIds.length ? 'partial' : 'missing';
    if (entry.defectIds.length && entry.defectReview === 'pending') entry.defectReview = 'partial';
  }
  return {program,added,conflicts};
}

export function retentionErrors(previous, current) {
  if (!previous) return [];
  const errors = [];
  for (const name of [...COLLECTIONS,'coverage']) {
    const key = name === 'coverage' ? 'motionId' : 'id';
    const next = new Map((current?.[name] ?? []).map(record => [record[key],record]));
    for (const record of previous[name] ?? []) {
      const saved = next.get(record[key]);
      if (!saved) errors.push(`Movement program dropped ${name} record ${record[key]}; preserve it with an explicit disposition.`);
      else if (name === 'findings' && (record.sourceId !== saved.sourceId || record.locator !== saved.locator)) errors.push(`Finding provenance was rewritten: ${record.id}; retain the original finding and link a new revision.`);
      else if (name === 'sources' && record.snapshot && JSON.stringify(record.snapshot) !== JSON.stringify(saved.snapshot) && !saved.revisions?.some(revision => JSON.stringify(revision) === JSON.stringify(record.snapshot))) errors.push(`Source snapshot was replaced without retaining its revision: ${record.id}`);
    }
  }
  return errors;
}

export function trackingRetentionErrors(previous, current) {
  if (!previous) return [];
  const errors = [];
  for (const key of Object.keys(previous)) {
    if (!current || !Object.hasOwn(current, key)) errors.push(`Tracking record was dropped: ${key}; preserve the existing review, observation or joint record.`);
    else if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) errors.push(`Tracking record became malformed: ${key}; retain an object so previous context reviews remain enforceable.`);
  }
  // Record contents may change normally. A retained $review object keeps its
  // context in the gate, which rejects stale identity, unresolved roles and
  // missing evidence instead of restoring the historical exemption.
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [masterPath,inputPath,mode='preview',expected] = process.argv.slice(2);
  if (!masterPath || !inputPath || !['preview','apply'].includes(mode)) throw Error('Use reconcile.mjs MASTER.html INPUT.json [preview|apply EXPECTED_MASTER_SHA256].');
  const html = readFileSync(masterPath,'utf8');
  if (mode === 'apply' && expected !== hash(html)) throw Error('Master changed or expected hash omitted; preview and inspect its current revision before applying.');
  const data = JSON.parse(html.match(/<script id="catalogue-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? 'null');
  if (!data) throw Error('Master catalogue data is missing.');
  const result = reconcileProgram(data.program, JSON.parse(readFileSync(inputPath,'utf8')), data.contexts);
  console.log(JSON.stringify({mode,masterSha256:hash(html),added:result.added,conflicts:result.conflicts},null,2));
  if (mode === 'apply') {
    if (result.conflicts.length) throw Error('Import conflicts require explicit reconciliation; master was not changed.');
    if (hash(readFileSync(masterPath,'utf8')) !== expected) throw Error('Concurrent master edit detected; nothing was written.');
    data.schemaVersion = 2;data.program = result.program;
    writeFileSync(masterPath,html.replace(/(<script id="catalogue-data" type="application\/json">)[\s\S]*?(<\/script>)/,(_,open,close)=>open+JSON.stringify(data).replace(/</g,'\\u003c')+close));
  }
}
