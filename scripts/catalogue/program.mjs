// Pure validation for the program embedded in the one movement master.
// Evidence readers are supplied by the engine gate; this module does not read files.
const HASH = /^[a-f\d]{64}$/;
const STAGES = ['blender', 'roundtrip', 'skin-contact', 'simlab', 'simmove'];
const SCOPES = ['motionIds', 'bodies', 'sides', 'phases', 'paths', 'joints'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const key = context => JSON.stringify([context.id, context.variant, context.side]);
const reviewKey = context => JSON.stringify([context.id, context.variant, context.side, '$review']);
const selectorMatches = (values, value) => !Array.isArray(values) || !values.length || values.includes(value);

/** Empty body/side/phase/path selectors mean unrestricted. Empty motionIds means
 * no declared motion unless allAvailable explicitly selects available contexts.
 * Whole-motion contexts have no phase/path; their closure covers every phase/path. */
export function appliesScope(scope, context) {
  if (!object(scope) || !object(context)) return false;
  const motion = array(scope.motionIds).includes(context.id) || scope.allAvailable === true && context.available !== false;
  return motion && selectorMatches(scope.bodies, context.variant) && selectorMatches(scope.sides, context.side)
    && (context.phase === undefined || selectorMatches(scope.phases, context.phase))
    && (context.path === undefined || selectorMatches(scope.paths, context.path));
}

/** Returns actionable failures. Callback signatures are synchronous:
 * checkArtifact({path,sha256}, label) -> string[]
 * checkReport({stage,path,sha256}, context, currentIdentity) -> string[]
 * checkClosure(closure, defect, context) -> string[] checks the retained manifest
 * against every exact defect acceptance criterion, current identity and scope.
 * checkComparison(criterion, reference, context) -> string[] checks a retained
 * reference-comparison manifest; arbitrary hashed artifacts do not establish it.
 * Required acceptance and all closure claims fail without their evidence readers.
 * Historical unreviewed contexts only receive structural/link validation. */
export function validateProgram(data, tracking, { requiredContexts = [], checkArtifact, checkReport, checkClosure, checkComparison } = {}) {
  const failures = [];
  const fail = message => failures.push(message);
  if (!object(data)) return ['Catalogue must be an object with schemaVersion 2 and an embedded program'];
  if (data.schemaVersion !== 2) fail('Catalogue schemaVersion must be 2; migrate the existing master without granting acceptance');
  if (!object(data.program) || data.program.schemaVersion !== 1) {
    fail('Missing supported embedded program schemaVersion 1; reconciliation cannot be held in a second backlog');
    return failures;
  }
  const program = data.program;
  if (!Array.isArray(data.contexts)) fail('Catalogue contexts must be an array');
  if (!object(tracking)) { fail('Tracking must be an object'); tracking = {}; }
  if (!Array.isArray(requiredContexts)) { fail('requiredContexts must be an array'); requiredContexts = []; }
  const contexts = array(data.contexts).filter(object);
  const contextMap = new Map(contexts.map(context => [key(context), context]));
  const motionIds = new Set(contexts.map(context => context.id));
  const bodies = new Set(contexts.map(context => context.variant));
  const sides = new Set(contexts.map(context => context.side));
  const joints = new Set(Object.values(object(data.rigs) ? data.rigs : {}).flatMap(rig => array(rig?.bones).map(bone => bone?.id)));
  const collections = {};
  const maps = {};
  for (const name of ['sources', 'findings', 'defects', 'references', 'workUnits', 'coverage']) {
    if (!Array.isArray(program[name])) fail(`program.${name} must be an array; preserve and migrate existing records`);
    collections[name] = array(program[name]).filter((record, index) => {
      if (!object(record)) { fail(`program.${name}[${index}] must be an object`); return false; }
      return true;
    });
    maps[name] = new Map();
    for (const record of collections[name]) {
      const id = name === 'coverage' ? record.motionId : record.id;
      if (!nonempty(id)) fail(`program.${name} record needs a stable ${name === 'coverage' ? 'motionId' : 'id'}`);
      else if (maps[name].has(id)) fail(`Duplicate program.${name} ID ${id}; merge repeated imports into the canonical record`);
      else maps[name].set(id, record);
    }
  }
  const text = (value, label) => { if (!nonempty(value)) fail(`${label} must be a nonempty string`); };
  const strings = (value, label, known) => {
    if (!Array.isArray(value)) { fail(`${label} must be a string array`); return []; }
    const valid = value.filter(nonempty);
    if (valid.length !== value.length) fail(`${label} contains a missing or non-string ID`);
    if (new Set(valid).size !== valid.length) fail(`${label} contains duplicate IDs`);
    if (known) for (const id of valid) if (!known.has(id)) fail(`${label} links unknown ID ${id}`);
    return valid;
  };
  const enumValue = (value, choices, label) => { if (!choices.includes(value)) fail(`${label} must be one of ${choices.join(', ')}`); };
  const callback = (checker, args, label, mandatory = false) => {
    if (typeof checker !== 'function') { if (mandatory) fail(`${label}: cannot verify retained evidence without its checker`); return false; }
    try {
      const result = checker(...args);
      if (!Array.isArray(result) || result.some(item => typeof item !== 'string')) { fail(`${label}: evidence checker must return an array of failure strings`); return false; }
      for (const message of result) fail(`${label}: ${message}`);
      return result.length === 0;
    } catch (error) { fail(`${label}: evidence checker failed: ${error?.message ?? String(error)}`); return false; }
  };
  const artifact = (value, label, mandatory = false) => {
    if (!object(value) || !nonempty(value.path) || !HASH.test(value.sha256 ?? '')) { fail(`${label}: retained artifact needs path and SHA-256`); return false; }
    return callback(checkArtifact, [value, label], label, mandatory);
  };
  const artifacts = (values, label, mandatory = false, atLeastOne = false) => {
    if (!Array.isArray(values)) { fail(`${label} must be an evidence array`); return false; }
    if (atLeastOne && !values.length) { fail(`${label} requires retained evidence`); return false; }
    return values.map((value, index) => artifact(value, `${label}[${index}]`, mandatory)).every(Boolean);
  };
  const scope = (value, label) => {
    if (!object(value)) { fail(`${label} must declare structured motion/body/side/phase/path/joint scope`); return; }
    for (const field of SCOPES) strings(value[field], `${label}.${field}`, field === 'motionIds' ? motionIds : field === 'bodies' ? bodies : field === 'sides' ? sides : field === 'joints' ? joints : undefined);
    if (value.allAvailable !== undefined && typeof value.allAvailable !== 'boolean') fail(`${label}.allAvailable must be a boolean`);
  };
  const link = (ids, collection, label) => strings(ids, label, maps[collection]);
  const applicable = value => contexts.filter(context => appliesScope(value, context));
  const overlaps = (left, right) => contexts.some(context => appliesScope(left, context) && appliesScope(right, context));
  const mappingWork = (defect, unit) => ['unsupported','historical'].includes(defect?.status) && array(defect?.mappingGaps).length > 0 && !applicable(defect.scope).length && unit?.status === 'blocked' && array(unit?.mappingGaps).length > 0;

  for (const trackingKey of Object.keys(tracking)) {
    let parts;
    try { parts = JSON.parse(trackingKey); } catch { fail(`Tracking record ${trackingKey}: invalid JSON context key`); continue; }
    if (!Array.isArray(parts) || ![4, 5].includes(parts.length)) { fail(`Tracking record ${trackingKey}: expected a joint, observation or context review key`); continue; }
    const contextId = JSON.stringify(parts.slice(0, 3));
    const context = contextMap.get(contextId);
    if (!context) { fail(`Tracking record ${trackingKey}: orphan motion/body/side context ${contextId}`); continue; }
    if (parts.length === 4 && !['$review', '$observation'].includes(parts[3])) fail(`Tracking record ${trackingKey}: unknown context-level record kind`);
    if (parts.length === 5 && !array(data.rigs?.[context.variant]?.bones).some(bone => bone?.id === parts[4])) fail(`Tracking record ${trackingKey}: orphan joint/bone ${parts[4]}`);
  }

  for (const source of collections.sources) {
    const label = `Source ${source.id}`;
    text(source.title, `${label} title`); text(source.origin, `${label} origin`);
    enumValue(source.status, ['inspected', 'pending', 'unavailable'], `${label} status`);
    if (!nonempty(source.scope)) scope(source.scope, `${label} scope`);
    if (source.status === 'inspected') artifact(source.snapshot, `${label} snapshot`);
    else text(source.reason, `${label} pending/unavailable reason`);
  }
  const importedFindings = new Set();
  for (const finding of collections.findings) {
    const label = `Finding ${finding.id}`;
    text(finding.sourceId, `${label} sourceId`);
    if (!maps.sources.has(finding.sourceId)) fail(`${label} links unknown source ${finding.sourceId}`);
    else if (maps.sources.get(finding.sourceId).status !== 'inspected') fail(`${label}: a finding cannot be imported from an uninspected source`);
    text(finding.locator, `${label} locator`); text(finding.summary, `${label} summary`);
    const importedKey = JSON.stringify([finding.sourceId, finding.locator]);
    if (importedFindings.has(importedKey)) fail(`${label}: duplicate imported source locator ${finding.sourceId} / ${finding.locator}`);
    importedFindings.add(importedKey);
    enumValue(finding.disposition, ['linked', 'duplicate', 'historical', 'superseded', 'resolved', 'excluded', 'mapping-gap'], `${label} disposition`);
    const defectIds = link(finding.defectIds, 'defects', `${label} defectIds`);
    if (finding.disposition === 'linked' && !defectIds.length) fail(`${label}: linked disposition requires a canonical defect`);
    if (finding.disposition !== 'linked') text(finding.reason, `${label} disposition reason`);
    for (const [field, disposition] of [['duplicateOf', 'duplicate'], ['supersededBy', 'superseded']]) {
      if (finding.disposition === disposition && !nonempty(finding[field])) fail(`${label}: ${disposition} requires ${field}`);
      if (finding[field] !== undefined) {
        if (!maps.findings.has(finding[field])) fail(`${label} ${field} links unknown finding ${finding[field]}`);
        if (finding[field] === finding.id) fail(`${label}: ${field} cannot link itself`);
      }
    }
    artifacts(finding.evidence, `${label} evidence`, finding.disposition === 'resolved', finding.disposition === 'resolved');
    if (finding.disposition === 'resolved' && !defectIds.length) fail(`${label}: resolved disposition needs a defect with current scoped closure, otherwise retain it as historical`);
    for (const id of defectIds) if (maps.defects.has(id) && !array(maps.defects.get(id).findingIds).includes(finding.id)) fail(`${label}: defect ${id} omits the reciprocal findingIds link`);
  }
  for (const defect of collections.defects) {
    const label = `Defect ${defect.id}`;
    for (const field of ['title', 'category', 'severity', 'owner', 'expected', 'nextAction']) text(defect[field], `${label} ${field}`);
    enumValue(defect.status, ['open', 'in-progress', 'blocked', 'historical', 'partial', 'closed', 'unsupported'], `${label} status`);
    if (typeof defect.blocking !== 'boolean') fail(`${label} blocking must be explicit`);
    scope(defect.scope, `${label} scope`);
    const findings = link(defect.findingIds, 'findings', `${label} findingIds`);
    if (!findings.length) fail(`${label}: preserve at least one original source finding`);
    for (const id of findings) if (maps.findings.has(id) && !array(maps.findings.get(id).defectIds).includes(defect.id)) fail(`${label}: finding ${id} omits the reciprocal defectIds link`);
    const acceptance = strings(defect.acceptance, `${label} acceptance`);
    if (!acceptance.length) fail(`${label}: scoped acceptance criteria are required before correction`);
    link(defect.dependencies, 'defects', `${label} dependencies`);
    if (defect.workUnitId !== undefined) {
      const unit = maps.workUnits.get(defect.workUnitId);
      if (!unit) fail(`${label} links unknown work unit ${defect.workUnitId}`);
      else {
        if (!array(unit.defectIds).includes(defect.id)) fail(`${label}: work unit ${unit.id} omits its reciprocal defectIds link`);
        if (unit.owner !== defect.owner) fail(`${label}: owner differs from its single accountable work-unit owner ${unit.owner}`);
        if (!overlaps(defect.scope, unit.scope) && !mappingWork(defect,unit)) fail(`${label}: work unit ${unit.id} has no matching context scope`);
      }
    }
    if (!array(defect.scope?.motionIds).length && defect.scope?.allAvailable !== true && defect.status !== 'historical' && defect.status !== 'unsupported') fail(`${label}: active defect has no mapped motion; preserve unmapped findings as mapping-gap`);
    if (!Array.isArray(defect.closures)) fail(`${label} closures must be an array`);
  }
  const importedReferences = new Set();
  for (const reference of collections.references) {
    const label = `Reference ${reference.id}`;
    text(reference.type, `${label} type`); text(reference.title, `${label} title`);
    enumValue(reference.status, ['verified', 'citation-only', 'missing', 'unavailable'], `${label} status`);
    scope(reference.scope, `${label} scope`);
    if (!object(reference.provenance)) fail(`${label} provenance must be an object`);
    else {
      const provenance = reference.provenance;
      const primary = [provenance.doi, provenance.url, provenance.sha256].find(nonempty);
      if (primary) {
        const importedKey = JSON.stringify([reference.type, primary, provenance.locator ?? '', provenance.edition ?? '']);
        if (importedReferences.has(importedKey)) fail(`${label}: duplicate imported reference provenance; merge claims and scope into one canonical source`);
        importedReferences.add(importedKey);
      }
    }
    if (!object(reference.verification)) fail(`${label} verification must be an object`);
    if (!Array.isArray(reference.claims)) fail(`${label} claims must be an array`);
    if (!Array.isArray(reference.gaps)) fail(`${label} gaps must be an array`);
    if (!nonempty(reference.conditions) && !object(reference.conditions)) fail(`${label} conditions must explicitly describe reference conditions or their unknowns`);
    text(reference.limitations, `${label} limitations`);
    if (['verified', 'citation-only'].includes(reference.status) && ![reference.provenance?.url, reference.provenance?.doi, reference.provenance?.locator, reference.provenance?.sha256].some(nonempty)) fail(`${label}: traceable URL/DOI/retained locator is required`);
    if (reference.provenance?.sha256 !== undefined && !HASH.test(reference.provenance.sha256)) fail(`${label} provenance SHA-256 is invalid`);
    if (['missing', 'unavailable'].includes(reference.status) && !array(reference.gaps).length) fail(`${label}: missing/unavailable reference needs an explicit owned gap`);
    if (reference.status === 'verified') {
      text(reference.verification?.method, `${label} verification method`);
      artifacts(reference.verification?.evidence, `${label} verification evidence`, false, true);
      if (!array(reference.claims).length) fail(`${label}: verified reference needs explicit supported claims`);
    } else if (reference.verification?.evidence !== undefined) artifacts(reference.verification.evidence, `${label} verification evidence`);
    const claimIds = new Set();
    for (const claim of array(reference.claims)) {
      if (!object(claim)) { fail(`${label}: claim must be an object`); continue; }
      text(claim.id, `${label} claim id`);
      if (claimIds.has(claim.id)) fail(`${label}: duplicate claim ID ${claim.id}`);
      claimIds.add(claim.id);
      text(claim.description, `${label} claim ${claim.id} description`);
      enumValue(claim.kind, ['observed', 'derived', 'assumed', 'protocol', 'limit'], `${label} claim ${claim.id} kind`);
      const supportedJoints = strings(claim.joints, `${label} claim ${claim.id} joints`, joints);
      const supportedPhases = strings(claim.phases, `${label} claim ${claim.id} phases`);
      text(claim.limitations, `${label} claim ${claim.id} limitations`);
      for (const [field, values] of [['joints', supportedJoints], ['phases', supportedPhases]]) if (array(reference.scope?.[field]).length && values.some(value => !reference.scope[field].includes(value))) fail(`${label} claim ${claim.id}: ${field} extend beyond declared reference scope`);
    }
  }
  for (const unit of collections.workUnits) {
    const label = `Work unit ${unit.id}`;
    for (const field of ['title', 'owner', 'branch', 'nextAction']) text(unit[field], `${label} ${field}`);
    enumValue(unit.status, ['ready', 'in-progress', 'blocked', 'done', 'external'], `${label} status`);
    scope(unit.scope, `${label} scope`);
    const defectIds = link(unit.defectIds, 'defects', `${label} defectIds`);
    const referenceIds = link(unit.referenceIds, 'references', `${label} referenceIds`);
    strings(unit.files, `${label} files`);
    link(unit.dependsOn, 'workUnits', `${label} dependsOn`);
    for (const [ids, collection] of [[defectIds, 'defects'], [referenceIds, 'references']]) for (const id of ids) if (maps[collection].has(id) && !overlaps(unit.scope, maps[collection].get(id).scope) && !(collection==='defects' && mappingWork(maps.defects.get(id),unit))) fail(`${label}: ${collection} ${id} has no matching context scope`);
    if (unit.status === 'done' && defectIds.some(id => maps.defects.get(id)?.status !== 'closed')) fail(`${label}: done correction still has an open or only partially closed defect`);
  }
  const detectCycles = (collection, edges) => {
    const visiting = new Set(), visited = new Set();
    const visit = id => {
      if (visiting.has(id)) { fail(`${collection} dependency cycle at ${id}; use one canonical owner and ordered work`); return; }
      if (visited.has(id) || !maps[collection].has(id)) return;
      visiting.add(id);
      for (const next of edges(maps[collection].get(id)).filter(nonempty)) {
        if (next === id) fail(`${collection} ${id} cannot depend on itself`);
        visit(next);
      }
      visiting.delete(id); visited.add(id);
    };
    for (const id of maps[collection].keys()) visit(id);
  };
  detectCycles('findings', item => [item.duplicateOf, item.supersededBy]);
  detectCycles('defects', item => array(item.dependencies));
  detectCycles('workUnits', item => array(item.dependsOn));
  const dependsOn = (unit, target, visited = new Set()) => {
    if (visited.has(unit.id)) return false;
    visited.add(unit.id);
    return array(unit.dependsOn).some(id => id === target || maps.workUnits.has(id) && dependsOn(maps.workUnits.get(id), target, visited));
  };
  const activeUnits = collections.workUnits.filter(unit => ['ready', 'in-progress', 'blocked', 'external'].includes(unit.status));
  const normalizeFile = value => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
  for (let i = 0; i < activeUnits.length; i++) for (let j = i + 1; j < activeUnits.length; j++) {
    const left = activeUnits[i], right = activeUnits[j];
    const leftFiles = array(left.files).filter(nonempty).map(normalizeFile), rightFiles = array(right.files).filter(nonempty).map(normalizeFile);
    const collision = leftFiles.find(file => rightFiles.some(other => file === other || file.startsWith(`${other}/`) || other.startsWith(`${file}/`)));
    if (collision && (!dependsOn(left, right.id) && !dependsOn(right, left.id) || left.status === 'in-progress' && right.status === 'in-progress')) fail(`Work units ${left.id} and ${right.id} claim overlapping file ${collision}; assign one active owner or an explicit sequential dependency`);
    const duplicateDefect = array(left.defectIds).find(id => array(right.defectIds).includes(id));
    if (duplicateDefect && !dependsOn(left, right.id) && !dependsOn(right, left.id)) fail(`Work units ${left.id} and ${right.id} duplicate ownership of defect ${duplicateDefect}`);
  }

  for (const id of motionIds) if (!maps.coverage.has(id)) fail(`Motion ${id} is missing its explicit defect/reference coverage record`);
  for (const coverage of collections.coverage) {
    const label = `Coverage ${coverage.motionId}`;
    if (!motionIds.has(coverage.motionId)) fail(`${label}: motion is absent from the current catalogue`);
    enumValue(coverage.defectReview, ['pending', 'partial', 'reconciled'], `${label} defectReview`);
    enumValue(coverage.referenceStatus, ['missing', 'partial', 'linked'], `${label} referenceStatus`);
    const defectIds = link(coverage.defectIds, 'defects', `${label} defectIds`);
    const referenceIds = link(coverage.referenceIds, 'references', `${label} referenceIds`);
    for (const field of ['owner', 'nextAction']) text(coverage[field], `${label} ${field}`);
    if (coverage.defectReview !== 'reconciled' || coverage.referenceStatus !== 'linked') text(coverage.gapReason, `${label} gapReason`);
    const motionContexts = contexts.filter(context => context.id === coverage.motionId);
    for (const [ids, collection] of [[defectIds, 'defects'], [referenceIds, 'references']]) for (const id of ids) if (maps[collection].has(id) && !motionContexts.some(context => appliesScope(maps[collection].get(id).scope, context))) fail(`${label}: linked ${collection} ${id} has incompatible motion/body/side scope`);
    for (const defect of collections.defects) if (motionContexts.some(context => appliesScope(defect.scope, context)) && !defectIds.includes(defect.id)) fail(`${label}: dropped applicable defect ${defect.id}`);
    for (const reference of collections.references) if (motionContexts.some(context => appliesScope(reference.scope, context)) && !referenceIds.includes(reference.id)) fail(`${label}: dropped applicable reference ${reference.id}`);
    if (coverage.referenceStatus === 'linked' && !referenceIds.some(id => maps.references.get(id)?.status === 'verified')) fail(`${label}: linked reference status requires verified reference data, rather than a citation or missing source`);
    if (coverage.defectReview === 'reconciled') for (const source of collections.sources) if (object(source.scope) && motionContexts.some(context => appliesScope(source.scope, context)) && (source.status !== 'inspected' || collections.findings.some(finding => finding.sourceId === source.id && finding.disposition === 'mapping-gap'))) fail(`${label}: source ${source.id} still has an uninspected or unmapped finding; retain partial reconciliation`);
  }

  const closedContexts = new Map();
  for (const defect of collections.defects) {
    const successful = new Set(), encountered = new Set();
    for (const closure of array(defect.closures)) {
      const label = `Defect ${defect.id} closure`;
      if (!object(closure)) { fail(`${label} must be an object`); continue; }
      if (encountered.has(closure.context)) fail(`${label}: duplicate context ${closure.context}`);
      encountered.add(closure.context);
      const context = contextMap.get(closure.context);
      if (!context) { fail(`${label}: unknown or retired context ${closure.context}`); continue; }
      const before = failures.length;
      if (!appliesScope(defect.scope, context)) fail(`${label}: context ${closure.context} lies outside defect scope`);
      if (context.available === false) fail(`${label}: unavailable context cannot be claimed reproduced and closed`);
      if (!nonempty(context.identity) || closure.identity !== context.identity) fail(`${label}: stale identity for ${closure.context}`);
      artifact(closure.acceptanceEvidence, `${label} acceptanceEvidence`, true);
      callback(checkClosure, [closure, defect, context], `${label} defect-specific acceptance`, true);
      const review = tracking[reviewKey(context)];
      if (!object(review) || review.identity !== context.identity) fail(`${label}: missing or stale current context review for ${closure.context}`);
      const requiredStages = [...STAGES];
      if (review?.nativeRequired === true) requiredStages.push('native');
      else if (review?.nativeRequired !== false || !nonempty(review?.nativeReason)) fail(`${label}: native applicability must be explicit with a reason when not required`);
      if (!Array.isArray(closure.reports)) fail(`${label}: reports must be an array`);
      for (const stage of requiredStages) if (!array(closure.reports).some(report => report?.stage === stage)) fail(`${label}: missing ${stage} report for ${closure.context}`);
      for (const report of array(closure.reports)) {
        if (!object(report) || ![...STAGES, 'native'].includes(report.stage) || !nonempty(report.path) || !HASH.test(report.sha256 ?? '')) { fail(`${label}: report needs supported stage, path and SHA-256`); continue; }
        callback(checkReport, [report, context, context.identity], `${label} ${report.stage}`, true);
      }
      if (failures.length === before) successful.add(closure.context);
    }
    closedContexts.set(defect.id, successful);
    if (defect.status === 'closed') {
      const affected = applicable(defect.scope);
      if (!affected.length) fail(`Defect ${defect.id}: closed status has no actual affected contexts; do not silently close a mapping gap`);
      for (const context of affected) if (!successful.has(key(context))) fail(`Defect ${defect.id}: closed status omits current scoped closure for ${key(context)}`);
    }
  }
  for (const finding of collections.findings.filter(finding => finding.disposition === 'resolved')) if (!array(finding.defectIds).every(id => maps.defects.get(id)?.status === 'closed' && closedContexts.get(id)?.size)) fail(`Finding ${finding.id}: resolved disposition lacks fully verified linked defect closure; use historical or superseded instead`);

  const required = new Map();
  for (const value of requiredContexts) {
    const candidateKey = typeof value === 'string' ? value : object(value) ? key(value) : undefined;
    const context = contextMap.get(candidateKey);
    if (!context) fail(`Required review links unknown context ${candidateKey ?? String(value)}`);
    else required.set(candidateKey, context);
  }
  for (const [contextId, context] of required) {
    const label = `Context ${contextId}`;
    const review = tracking[reviewKey(context)], acceptance = review?.referenceAcceptance;
    if (!object(review) || review.identity !== context.identity) fail(`${label}: reference review requires the same current context identity`);
    if (!object(acceptance)) { fail(`${label}: missing referenceAcceptance; engine output is not its own motion reference`); }
    else {
      text(acceptance.reviewer, `${label} reference reviewer`); text(acceptance.limitations, `${label} reference limitations`);
      const referenceIds = link(acceptance.referenceIds, 'references', `${label} accepted referenceIds`);
      if (!referenceIds.length) fail(`${label}: reference acceptance requires a verified, applicable source`);
      const coverage = maps.coverage.get(context.id);
      for (const id of referenceIds) if (!array(coverage?.referenceIds).includes(id)) fail(`${label}: accepted reference ${id} is absent from motion coverage`);
      for (const id of referenceIds) {
        const reference = maps.references.get(id);
        if (!reference) continue;
        if (reference.status !== 'verified') fail(`${label}: reference ${id} is ${reference.status}; citations and missing data cannot establish acceptance`);
        if (!appliesScope(reference.scope, context)) fail(`${label}: reference ${id} does not support this body/side/motion scope`);
        if (reference.status === 'verified') artifacts(reference.verification?.evidence, `${label} reference ${id} verified source`, true, true);
      }
      if (!Array.isArray(acceptance.criteria) || !acceptance.criteria.length) fail(`${label}: reference acceptance requires explicit supported comparison criteria`);
      const criterionIds = new Set(); let supportedCoordination = false;
      for (const criterion of array(acceptance.criteria)) {
        if (!object(criterion)) { fail(`${label}: criterion must be an object`); continue; }
        const criterionLabel = `${label} criterion ${criterion.id}`;
        text(criterion.id, `${criterionLabel} id`); text(criterion.description, `${criterionLabel} description`);
        if (criterionIds.has(criterion.id)) fail(`${criterionLabel}: duplicate criterion ID`);
        criterionIds.add(criterion.id);
        if (criterion.result !== 'pass') fail(`${criterionLabel}: reference comparison has not passed`);
        if (!referenceIds.includes(criterion.referenceId)) fail(`${criterionLabel}: reference is absent from accepted referenceIds`);
        const reference = maps.references.get(criterion.referenceId);
        const claims = new Map(array(reference?.claims).filter(object).map(claim => [claim.id, claim]));
        const claimIds = strings(criterion.claimIds, `${criterionLabel} claimIds`, claims);
        if (!claimIds.length) fail(`${criterionLabel}: identify the exact reference claims supporting this comparison`);
        for (const id of claimIds) {
          const claim = claims.get(id);
          if (!claim) continue;
          if (claim.kind === 'assumed') fail(`${criterionLabel}: assumed claim ${id} cannot establish verified motion acceptance`);
          else if (claim.kind !== 'limit' && reference?.status === 'verified' && appliesScope(reference.scope, context)) supportedCoordination = true;
        }
        artifacts(criterion.evidence, `${criterionLabel} evidence`, true, true);
        callback(checkComparison, [criterion, reference, context], `${criterionLabel} scoped comparison`, true);
      }
      if (!supportedCoordination) fail(`${label}: limit-only or assumed reference claims cannot support whole-motion coordination; add an applicable non-limit comparison`);
    }
    for (const defect of collections.defects) if (defect.blocking === true && appliesScope(defect.scope, context) && !closedContexts.get(defect.id)?.has(contextId)) fail(`${label}: unresolved blocking defect ${defect.id}; obtain current scoped closure before accepting this context`);
  }
  return failures;
}
