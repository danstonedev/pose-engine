import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appliesScope, validateProgram } from './program.mjs';

const sha256 = 'a'.repeat(64);
const artifact = () => ({ path: 'docs/catalogue-evidence/source.json', sha256 });
const scope = (motionId = 'fixture') => ({ motionIds: [motionId], bodies: [], sides: [], phases: [], paths: [], joints: [] });
const contextKey = context => JSON.stringify([context.id, context.variant, context.side]);
const reviewKey = context => JSON.stringify([context.id, context.variant, context.side, '$review']);
function fixture() {
  const left = { id: 'fixture', variant: 'male', side: 'left', available: true, identity: 'current-left' };
  const right = { ...left, side: 'right', identity: 'current-right' };
  const source = { id: 'source', title: 'Retained source', origin: 'workspace audit', status: 'inspected', snapshot: artifact(), scope: 'Synthetic fixture only', reason: '' };
  const finding = { id: 'finding', sourceId: 'source', locator: 'lines 10-12', summary: 'Synthetic shoulder symptom', disposition: 'linked', defectIds: ['defect'], reason: '', evidence: [] };
  const defect = { id: 'defect', title: 'Synthetic symptom', category: 'coordination', severity: 'medium', status: 'open', scope: scope(), findingIds: ['finding'], owner: 'fixture owner', workUnitId: 'unit', expected: 'Reference-supported motion', acceptance: ['Whole-motion comparison passes'], nextAction: 'Reproduce fixture', dependencies: [], blocking: false, closures: [] };
  const reference = { id: 'reference', type: 'protocol', title: 'Synthetic protocol', status: 'verified', provenance: { locator: 'retained protocol page 1', sha256 }, scope: scope(), claims: [{ id: 'claim', description: 'Synthetic non-limit coordination claim', kind: 'protocol', joints: ['Head'], phases: [], limitations: 'Synthetic fixture only' }], conditions: 'Synthetic fixture conditions', limitations: 'No real movement approval', verification: { method: 'Synthetic test verifier', evidence: [artifact()] }, gaps: [] };
  const unit = { id: 'unit', title: 'One correction owner', owner: 'fixture owner', branch: 'fixture/branch', status: 'in-progress', defectIds: ['defect'], referenceIds: ['reference'], scope: scope(), files: ['src/services/solver.ts'], dependsOn: [], nextAction: 'Continue synthetic test' };
  const coverage = { motionId: 'fixture', defectReview: 'reconciled', referenceStatus: 'linked', referenceIds: ['reference'], defectIds: ['defect'], gapReason: '', owner: 'fixture owner', nextAction: 'Continue fixture' };
  const data = { schemaVersion: 2, contexts: [left, right], rigs: { male: { bones: [{ id: 'Head' }, { id: 'Hips' }] } }, program: { schemaVersion: 1, sources: [source], findings: [finding], defects: [defect], references: [reference], workUnits: [unit], coverage: [coverage] } };
  const acceptance = { referenceIds: ['reference'], criteria: [{ id: 'criterion', description: 'Compare supported motion', referenceId: 'reference', claimIds: ['claim'], result: 'pass', evidence: [artifact()] }], reviewer: 'fixture reviewer', limitations: 'Synthetic fixture only' };
  const tracking = Object.fromEntries(data.contexts.map(context => [reviewKey(context), { identity: context.identity, nativeRequired: false, nativeReason: 'Synthetic evidence fixture, no native claim', referenceAcceptance: structuredClone(acceptance) }]));
  const closureManifests = new Map();
  const options = {
    requiredContexts: [left], checkArtifact: () => [], checkComparison: () => [],
    checkReport: (report, context, identity) => report.path === `docs/catalogue-evidence/${context.side}-${report.stage}.json` && identity === context.identity ? [] : ['forged or incorrectly scoped report'],
    checkClosure: (closure, affectedDefect, context) => {
      const manifest = closureManifests.get(closure.acceptanceEvidence?.path);
      if (!manifest || manifest.defectId !== affectedDefect.id || manifest.context !== contextKey(context) || manifest.identity !== context.identity || manifest.result !== 'pass') return ['missing, stale or unrelated criterion-specific manifest'];
      return affectedDefect.acceptance.every(description => manifest.criteria.some(criterion => criterion.description === description && criterion.result === 'pass')) ? [] : ['defect-specific acceptance criterion missing or failed'];
    }
  };
  const close = (context = left) => {
    const acceptanceEvidence = { path: `docs/catalogue-evidence/${context.side}-defect-acceptance.json`, sha256 };
    closureManifests.set(acceptanceEvidence.path, { defectId: defect.id, context: contextKey(context), identity: context.identity, result: 'pass', reviewer: 'Fixture only', scope: 'Synthetic affected context', criteria: defect.acceptance.map(description => ({ description, result: 'pass', evidence: [artifact()] })) });
    const closure = { context: contextKey(context), identity: context.identity, acceptanceEvidence, reports: ['blender', 'roundtrip', 'skin-contact', 'simlab', 'simmove'].map(stage => ({ stage, path: `docs/catalogue-evidence/${context.side}-${stage}.json`, sha256 })) };
    defect.closures.push(closure); return closure;
  };
  return { data, tracking, options, left, right, source, finding, defect, reference, unit, coverage, close, closureManifests, validate: () => validateProgram(data, tracking, options) };
}
function rejected(name, mutate, pattern) {
  test(name, () => { const f = fixture(); mutate(f); const failures = f.validate(); assert.ok(failures.length, 'Expected the program gate to fail'); assert.match(failures.join('\n'), pattern); });
}

test('valid program fixture accepts explicit source and reference comparisons without approving an open non-blocking defect', () => assert.deepEqual(fixture().validate(), []));
test('unregistered unsupported recipes retain accountable blocked mapping work',()=>{
  const f=fixture();f.defect.status='unsupported';f.defect.scope.motionIds=[];f.defect.mappingGaps=['Dedicated breakout context is not registered'];
  f.unit.status='blocked';f.unit.mappingGaps=['Register the actual breakout context before implementation'];f.coverage.defectIds=[];
  assert.deepEqual(f.validate(),[]);
  f.unit.status='in-progress';assert.match(f.validate().join('\n'),/no matching context scope/);
});
test('scope selectors preserve unavailable gaps and body/side applicability', () => {
  const f = fixture();
  assert.equal(appliesScope(scope(), f.left), true);
  assert.equal(appliesScope({ ...scope(), bodies: ['female'] }, f.left), false);
  assert.equal(appliesScope({ ...scope(), sides: ['right'] }, f.left), false);
  assert.equal(appliesScope({ ...scope(), motionIds: [], allAvailable: true }, { ...f.left, available: false }), false);
  assert.equal(appliesScope({ ...scope(), motionIds: [] }, f.left), false);
  assert.equal(appliesScope({ ...scope(), phases: ['hold'] }, { ...f.left, phase: 'return' }), false);
  assert.equal(appliesScope({ ...scope(), paths: ['native'] }, { ...f.left, path: 'recorded' }), false);
});
test('historical untouched migration accepts explicit gaps without granting reference or defect acceptance', () => {
  const f = fixture();
  f.data.program = { schemaVersion: 1, sources: [], findings: [], defects: [], references: [], workUnits: [], coverage: [{ motionId: 'fixture', defectReview: 'pending', referenceStatus: 'missing', referenceIds: [], defectIds: [], gapReason: 'No inspection or sources yet', owner: 'fixture owner', nextAction: 'Inspect source set' }] };
  assert.deepEqual(validateProgram(f.data, {}, { requiredContexts: [] }), []);
  assert.match(validateProgram(f.data, {}, { requiredContexts: [f.left] }).join('\n'), /missing referenceAcceptance/);
});
rejected('old schema is never silently promoted', f => { f.data.schemaVersion = 1; }, /schemaVersion must be 2/);
rejected('coverage cannot be dropped for a named motion', f => { f.data.program.coverage = []; }, /missing its explicit.*coverage record/);
rejected('coverage cannot retain an orphan motion', f => { f.coverage.motionId = 'retired'; }, /motion is absent/);
rejected('applicable defects must stay linked through coverage', f => { f.coverage.defectIds = []; }, /dropped applicable defect/);
rejected('applicable references must stay linked through coverage', f => { f.coverage.referenceIds = []; }, /dropped applicable reference/);
rejected('unknown imported source is rejected', f => { f.finding.sourceId = 'unknown'; }, /links unknown source/);
rejected('uninspected source cannot claim imported findings', f => { f.source.status = 'pending'; f.source.reason = 'Pending access'; }, /uninspected source/);
rejected('source snapshots need exact byte identities', f => { delete f.source.snapshot.sha256; }, /snapshot: retained artifact needs/);
rejected('modified retained sources are rejected by artifact reader', f => { f.options.checkArtifact = () => ['hash differs']; }, /Source source snapshot: hash differs/);
rejected('missing stable canonical record IDs are rejected', f => { delete f.defect.id; }, /needs a stable id/);
rejected('duplicate canonical defect IDs are rejected', f => { f.data.program.defects.push(structuredClone(f.defect)); }, /Duplicate program.defects ID/);
rejected('duplicate imports cannot accumulate under different finding IDs', f => { f.data.program.findings.push({ ...f.finding, id: 'other' }); }, /duplicate imported source locator/);
rejected('reference imports cannot accumulate duplicate provenance under new IDs', f => { f.data.program.references.push({ ...f.reference, id: 'other-reference' }); }, /duplicate imported reference provenance/);
rejected('finding dispositions must be traceable rather than a loose resolved note', f => { f.finding.disposition = 'resolved'; f.finding.reason = 'Looks fixed'; }, /requires retained evidence|lacks fully verified/);
rejected('linked findings require reciprocal canonical links', f => { f.defect.findingIds = []; }, /omits the reciprocal findingIds/);
rejected('duplicates require a canonical finding', f => { f.finding.disposition = 'duplicate'; f.finding.reason = 'Repeated report'; }, /duplicate requires duplicateOf/);
rejected('supersession and duplicate graphs cannot cycle', f => {
  f.finding.disposition = 'duplicate'; f.finding.duplicateOf = 'new'; f.finding.reason = 'Repeated report';
  f.data.program.findings.push({ ...f.finding, id: 'new', locator: 'line 20', duplicateOf: 'finding', defectIds: [] });
}, /findings dependency cycle/);
rejected('defect dependencies cannot self-link', f => { f.defect.dependencies = ['defect']; }, /cannot depend on itself/);
rejected('scope cannot refer to a nonexistent rig joint', f => { f.defect.scope.joints = ['invented-vertebra']; }, /joints links unknown ID/);
rejected('scope body/side must match the declared production inventory', f => { f.reference.scope.bodies = ['adult-other']; }, /bodies links unknown ID/);
rejected('reference coverage cannot attach a different motion', f => {
  f.data.contexts.push({ ...f.left, id: 'different' }); f.reference.scope = scope('different');
  f.data.program.coverage.push({ ...f.coverage, motionId: 'different', defectIds: [] });
}, /incompatible motion.*scope|does not support this/);
rejected('citation-only references do not pass changed motion acceptance', f => { f.reference.status = 'citation-only'; f.coverage.referenceStatus = 'partial'; f.coverage.gapReason = 'Primary source not verified'; }, /citations and missing data cannot establish acceptance/);
rejected('missing references are kept visible and cannot establish acceptance', f => { f.reference.status = 'missing'; f.reference.gaps = ['Find primary source']; f.coverage.referenceStatus = 'missing'; f.coverage.gapReason = 'No source'; }, /reference reference is missing/);
rejected('verified references require retained verification evidence', f => { f.reference.verification.evidence = []; }, /verification evidence requires retained evidence/);
rejected('reference claims cannot extend anatomical scope', f => { f.reference.scope.joints = ['Hips']; }, /joints extend beyond declared reference scope/);
rejected('assumed channels do not become verified comparisons', f => { f.reference.claims[0].kind = 'assumed'; }, /assumed claim.*cannot establish/);
rejected('ROM limits alone cannot support whole-motion coordination', f => { f.reference.claims[0].kind = 'limit'; }, /limit-only or assumed.*whole-motion coordination/);
rejected('criterion claim IDs must exist in the cited reference', f => { f.tracking[reviewKey(f.left)].referenceAcceptance.criteria[0].claimIds = ['unknown']; }, /claimIds links unknown ID/);
rejected('failed reference comparisons cannot accept a changed context', f => { f.tracking[reviewKey(f.left)].referenceAcceptance.criteria[0].result = 'fail'; }, /comparison has not passed/);
rejected('reference comparison artifacts cannot be prose-only', f => { f.tracking[reviewKey(f.left)].referenceAcceptance.criteria[0].evidence = ['looks good']; }, /retained artifact needs path and SHA-256/);
rejected('acceptance cannot bypass actual evidence readers', f => { delete f.options.checkArtifact; }, /cannot verify retained evidence/);
rejected('arbitrary hashed artifacts cannot bypass scoped reference-comparison reader', f => { delete f.options.checkComparison; }, /scoped comparison: cannot verify retained evidence/);
rejected('failed or stale scoped reference-comparison manifests are rejected', f => { f.options.checkComparison = () => ['unrelated artifact or stale reference comparison']; }, /unrelated artifact or stale reference comparison/);
rejected('review identity must be current', f => { f.tracking[reviewKey(f.left)].identity = 'previous'; }, /same current context identity/);
rejected('required contexts cannot name a retired body or motion', f => { f.options.requiredContexts = ['["retired","male","left"]']; }, /Required review links unknown context/);
rejected('retired contexts cannot leave orphan reviews hidden in tracking', f => { f.tracking['["retired","male","left","$review"]'] = {}; }, /orphan motion\/body\/side context/);
rejected('retired bones cannot leave orphan records hidden in tracking', f => { f.tracking['["fixture","male","left","all","retired-bone"]'] = {}; }, /orphan joint\/bone/);
rejected('unresolved applicable blocking defects reject acceptance', f => { f.defect.blocking = true; }, /unresolved blocking defect defect/);
rejected('closed status cannot omit actual affected contexts', f => { f.defect.status = 'closed'; f.close(); }, /closed status omits current scoped closure.*right/);
rejected('closed status without closures never passes', f => { f.defect.status = 'closed'; }, /closed status omits current scoped closure/);
rejected('stale closure identities remain rejected', f => { f.defect.blocking = true; f.close().identity = 'previous'; }, /stale identity/);
rejected('closures cannot claim unknown contexts', f => { f.close().context = '["fixture","female","left"]'; }, /unknown or retired context/);
rejected('closures cannot apply outside a defect body/side scope', f => { f.defect.scope.sides = ['right']; f.close(); }, /outside defect scope/);
rejected('closure must prove every delivery stage', f => { f.close().reports.pop(); }, /missing simmove report/);
rejected('forged stage evidence cannot close blocking defects', f => { f.defect.blocking = true; f.close().reports[0].path = 'docs/unrelated.json'; }, /forged or incorrectly scoped report/);
rejected('closure validation requires retained report reader', f => { f.close(); delete f.options.checkReport; }, /cannot verify retained evidence/);
rejected('generic stage reviews cannot substitute for defect-specific closure evidence', f => { delete f.close().acceptanceEvidence; }, /acceptanceEvidence: retained artifact needs/);
rejected('closure criterion-specific checker cannot be bypassed', f => { f.close(); delete f.options.checkClosure; }, /defect-specific acceptance: cannot verify retained evidence/);
rejected('criterion-specific closure evidence must identify this current trajectory', f => { const closure = f.close(); f.closureManifests.get(closure.acceptanceEvidence.path).identity = 'previous'; }, /stale or unrelated criterion-specific/);
rejected('criterion-specific closure evidence must cover every declared acceptance criterion', f => { const closure = f.close(); f.closureManifests.get(closure.acceptanceEvidence.path).criteria = []; }, /acceptance criterion missing or failed/);
rejected('passing stage manifests cannot hide a failed defect-specific criterion', f => { const closure = f.close(); f.closureManifests.get(closure.acceptanceEvidence.path).criteria[0].result = 'fail'; }, /acceptance criterion missing or failed/);
rejected('native applicability is an explicit closure decision', f => { f.close(); delete f.tracking[reviewKey(f.left)].nativeRequired; }, /native applicability must be explicit/);
rejected('applicable native simulation requires a native report', f => { f.close(); f.tracking[reviewKey(f.left)].nativeRequired = true; }, /missing native report/);
rejected('duplicate closure imports cannot multiply evidence', f => { const closure = f.close(); f.defect.closures.push(structuredClone(closure)); }, /duplicate context/);
test('a current scoped closure accepts one context while other contexts stay partial and blocked', () => {
  const f = fixture(); f.defect.blocking = true; f.defect.status = 'partial'; f.close();
  assert.deepEqual(f.validate(), []);
  f.options.requiredContexts.push(f.right);
  assert.match(f.validate().join('\n'), /right.*unresolved blocking defect/);
});
test('full current closure closes the defect without accepting historical untouched reference gaps', () => {
  const f = fixture(); f.defect.blocking = true; f.defect.status = 'closed'; f.close(f.left); f.close(f.right);
  assert.deepEqual(f.validate(), []);
});
rejected('correction work cannot claim done with an open family', f => { f.unit.status = 'done'; }, /done correction still has an open/);
rejected('one accountable owner remains consistent across correction and work unit', f => { f.unit.owner = 'other worker'; }, /owner differs/);
rejected('active workers cannot independently claim overlapping files', f => { f.data.program.workUnits.push({ ...f.unit, id: 'other', owner: 'other owner', defectIds: [], files: ['src/services'] }); }, /claim overlapping file/);
rejected('path case or Windows slash cannot conceal overlapping work', f => { f.data.program.workUnits.push({ ...f.unit, id: 'other', defectIds: [], files: ['SRC\\services\\solver.ts'] }); }, /claim overlapping file/);
rejected('same defect cannot have duplicate independent correction owners', f => { f.data.program.workUnits.push({ ...f.unit, id: 'other', files: ['src/unrelated.ts'] }); }, /duplicate ownership of defect/);
rejected('explicit dependency does not allow two simultaneous solver changes', f => { f.data.program.workUnits.push({ ...f.unit, id: 'other', defectIds: [], dependsOn: ['unit'] }); }, /claim overlapping file/);
test('explicit sequential ownership avoids duplicate independent work', () => {
  const f = fixture(); f.data.program.workUnits.push({ ...f.unit, id: 'next', status: 'ready', defectIds: [], dependsOn: ['unit'] });
  assert.deepEqual(f.validate(), []);
});
test('external WIP with unknown file list remains visible without inventing a collision', () => {
  const f = fixture(); f.data.program.workUnits.push({ ...f.unit, id: 'external', status: 'external', branch: 'unknown; inspect existing draft', defectIds: [], referenceIds: [], files: [] });
  assert.deepEqual(f.validate(), []);
});
rejected('unmapped source findings prevent falsely reconciled scope', f => {
  f.source.scope = scope(); f.finding.disposition = 'mapping-gap'; f.finding.reason = 'Motion mapping unresolved';
}, /still has an uninspected or unmapped finding/);

test('malformed collection and nested arrays produce failures instead of throwing', () => {
  for (const value of [null, 'wrong', {}, 3]) {
    const f = fixture(); f.data.program.findings = value;
    assert.doesNotThrow(() => f.validate()); assert.ok(f.validate().length);
  }
  for (const [collection, field] of [['defects', 'scope'], ['defects', 'closures'], ['references', 'claims'], ['references', 'provenance'], ['workUnits', 'files'], ['coverage', 'referenceIds']]) {
    const f = fixture(); f.data.program[collection][0][field] = null;
    assert.doesNotThrow(() => f.validate()); assert.ok(f.validate().length, `${collection}.${field}`);
  }
});
test('unexpected evidence checker exceptions become actionable failures', () => {
  const f = fixture(); f.options.checkArtifact = () => { throw Error('Artifact missing'); };
  assert.match(f.validate().join('\n'), /evidence checker failed: Artifact missing/);
});
test('asynchronous or malformed evidence readers cannot silently pass the pure gate', () => {
  const f = fixture(); f.options.checkArtifact = async () => [];
  assert.match(f.validate().join('\n'), /checker must return an array/);
});
