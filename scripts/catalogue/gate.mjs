import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { validateProgram, appliesScope } from './program.mjs';

export const MASTER_PATH = 'docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html';
export const HOST_SOURCE_DIRS = { simlab:['packages/ddx/src/movement','packages/ddx/src/lab'], simmove:['src','experiments/lower-body','scripts'] };
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const sourceHash = bytes => digest(bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
export const referenceIdentity = reference => digest({...reference,updatedAt:undefined});
export const contextKey = context => JSON.stringify([context.id, context.variant, context.side]);
export const jointKey = (context, joint, phase = 'all') => JSON.stringify([context.id, context.variant, context.side, phase, joint]);
export const reviewKey = context => JSON.stringify([context.id, context.variant, context.side, '$review']);
export const observationKey = context => JSON.stringify([context.id, context.variant, context.side, '$observation']);
export function parseMaster(html) {
  const read = id => {
    const found = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)<\\/script>`));
    if (!found) throw Error(`Master catalogue is missing ${id}`);
    return JSON.parse(found[1]);
  };
  return { data: read('catalogue-data'), tracking: read('tracking-data') };
}
export function readMaster(engineRoot) { return parseMaster(readFileSync(resolve(engineRoot, MASTER_PATH), 'utf8')); }
export function definitionSignature(definition) {
  return digest(definition);
}
export function runtimeSources(hashes) {
  // These constructors are replayed from live registries by the host gate.
  // Their full resulting definitions identify affected contexts. Shared solver,
  // rig, playback and un-reconstructed host changes conservatively affect all.
  const constructors = new Set(['assessmentBodyMotions.ts','assessmentUpperMotions.ts','movementTemplates.data.ts','movementTemplates.ts','movementTemplateMotion.ts','movementPostures.ts','movementLocomotion.ts','functionalRecipes.ts','upperSupportRecipes.ts']);
  const hostConstructors = new Set(['catalog.ts','play.ts','settings.ts','libraryMotions.ts','screenMotions.ts','taskMotions.ts','motion.ts']);
  return Object.fromEntries(Object.entries(hashes).filter(([path]) => {
    const name=path.split('/').at(-1);
    if(path.startsWith('pose-engine/src/')) return !constructors.has(name);
    if(path.startsWith('pose-engine/models/') || path==='pose-engine/package-lock.json') return true;
    if(path.startsWith('packages/ddx/src/movement/') || path.startsWith('packages/ddx/src/lab/')) return !hostConstructors.has(name);
    return path.startsWith('simmove/') || path==='pnpm-lock.yaml';
  }).sort(([a], [b]) => a.localeCompare(b)));
}
export function sourceFiles(root, directories) {
  const result = [];
  function walk(path) {
    if (!existsSync(resolve(root, path))) return;
    for (const item of readdirSync(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${item.name}`;
      if (item.isDirectory()) walk(child);
      else if (/\.(ts|mjs|svelte|json|py|xml|glb)$/.test(item.name) && !/(^|\/)(__tests__|node_modules)\/|\.test\.|\.node-test\./.test(child)) result.push(child);
    }
  }
  directories.forEach(walk);
  return result.sort();
}
export function makeBaseline(data) {
  return { version: 1, disposition: 'Historical unreviewed inventory; no motion acceptance granted', sources: runtimeSources(data.hashes), contexts: Object.fromEntries(data.contexts.map(context => [contextKey(context), { signature: definitionSignature(data.definitions[context.definitionId]), rig: data.rigs[context.variant].sha256, available: context.available }])) };
}
export function identity(data, context) {
  return digest({ definition: definitionSignature(data.definitions[context.definitionId]), rig: data.rigs[context.variant].sha256, sources: runtimeSources(data.hashes) });
}
export function changedContexts(data) {
  const baseline = data.enforcement?.baseline;
  if (!baseline) return data.contexts;
  const runtimeChanged = digest(runtimeSources(data.hashes)) !== digest(baseline.sources);
  return data.contexts.filter(context => {
    if (!context.available) return false; // Registry-only availability gaps remain visible and unqualified.
    const old = baseline.contexts[contextKey(context)];
    return !old || !old.available || runtimeChanged || old.rig !== data.rigs[context.variant].sha256 || old.signature !== definitionSignature(data.definitions[context.definitionId]);
  });
}
export function checkRules(rules, metrics) {
  const failures = [];
  if (!Array.isArray(rules)) return ['constraints must be an array'];
  for (const rule of rules) {
    if (!rule || typeof rule.metric !== 'string' || !Number.isFinite(rule.min ?? rule.max) || (rule.min !== undefined && !Number.isFinite(rule.min)) || (rule.max !== undefined && !Number.isFinite(rule.max)) || (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max)) { failures.push('invalid metric bounds'); continue; }
    const measured = metrics?.[rule.metric];
    if (!Number.isFinite(measured)) failures.push(`missing measured metric ${rule.metric}`);
    else if (rule.min !== undefined && measured < rule.min || rule.max !== undefined && measured > rule.max) failures.push(`${rule.metric}=${measured} outside ${rule.min ?? '-inf'}..${rule.max ?? 'inf'}`);
  }
  return failures;
}
function evidenceBytes(root, path) {
  // A Git-backed reader compares base evidence against its original bytes.
  if (typeof root === 'object') {
    if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) throw Error('external evidence');
    return root.read(path);
  }
  const target = resolve(root, path), rel = relative(realpathSync(root), realpathSync(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('external evidence');
  return readFileSync(target);
}
export function stageReport(root, report, context, currentIdentity, failures) {
  if (!report || typeof report.path !== 'string' || !/^[a-f\d]{64}$/.test(report.sha256 ?? '')) { failures.push('invalid evidence reference'); return; }
  let bytes;
  try { bytes = evidenceBytes(root, report.path); }
  catch { failures.push(`evidence outside repository or missing: ${report.path}`); return; }
  if (digest(bytes) !== report.sha256) { failures.push(`evidence hash differs: ${report.path}`); return; }
  let evidence;
  try { evidence = JSON.parse(bytes); } catch { failures.push(`evidence must be a structured review manifest: ${report.path}`); return; }
  if (evidence.stage !== report.stage || evidence.result !== 'pass' || evidence.context !== contextKey(context) || evidence.identity !== currentIdentity || !evidence.scope?.trim() || !evidence.reviewer?.trim() || !evidence.toolVersion?.trim()) failures.push(`failed, stale or incorrectly scoped ${report.stage} evidence: ${report.path}`);
  for(const phase of ['setup','transitions','hold','return','loop']) if(!evidence.phases?.includes(phase)) failures.push(`${report.stage} evidence omits ${phase}`);
  if(!Array.isArray(evidence.artifacts) || !evidence.artifacts.length) failures.push(`${report.stage} evidence requires retained artifacts`);
  for(const artifact of evidence.artifacts??[]) {
    if(typeof artifact.path!=='string' || !/^[a-f\d]{64}$/.test(artifact.sha256??'') || !artifact.kind?.trim()) { failures.push('invalid evidence artifact');continue; }
    try { if (digest(evidenceBytes(root,artifact.path))!==artifact.sha256) failures.push(`changed or escaped evidence artifact: ${artifact.path}`); }
    catch { failures.push(`missing or external evidence artifact: ${artifact.path}`); }
  }
  if(report.stage==='blender' && !evidence.artifacts?.some(artifact=>artifact.kind==='editable-project'&&artifact.path.endsWith('.blend'))) failures.push('Blender review requires an editable .blend project');
}
/** Definition/availability/rig changes cannot be omitted from a delivery scope.
 * Shared-source changes remain in changedContexts as a separate impact warning. */
export function directlyChangedContexts(data) {
  const baseline = data.enforcement?.baseline;
  return data.contexts.filter(context => {
    if (!context.available) return false;
    const old = baseline?.contexts[contextKey(context)];
    return !old || !old.available || old.rig !== data.rigs[context.variant].sha256
      || old.signature !== definitionSignature(data.definitions[context.definitionId]);
  });
}
/** One selection shared by the static gate and the host's fresh sampler. */
export function requiredContexts(data, tracking) {
  const delivery = data.enforcement?.delivery;
  const keys = new Set(delivery === undefined ? changedContexts(data).map(contextKey)
    : (Array.isArray(delivery?.contexts) ? delivery.contexts : []).map(entry => entry?.context));
  return data.contexts.filter(context => keys.has(contextKey(context)) || tracking[reviewKey(context)]);
}

function deliveryErrors(data, delivery, engineRoot) {
  const failures = [], text = value => typeof value === 'string' && value.trim().length > 0;
  if (!delivery || delivery.version !== 1 || delivery.mode !== 'authored-playback' || delivery.qualification !== 'unqualified')
    return ['Delivery must explicitly declare authored-playback version 1 and unqualified status'];
  const sourceIdentity = digest(runtimeSources(data.hashes));
  if (delivery.identity !== sourceIdentity) failures.push('Delivery has stale shared-source identity');
  for (const field of ['reviewer','scope','limitations']) if (!text(delivery[field])) failures.push(`Delivery requires ${field}`);
  if (delivery.native?.status !== 'deferred' || !text(delivery.native?.reason)) failures.push('Delivery must retain native qualification as explicitly deferred with a reason');
  const units = new Map((data.program?.workUnits ?? []).map(unit => [unit.id, unit]));
  if (!Array.isArray(delivery.native?.workUnitIds) || !delivery.native.workUnitIds.length
    || delivery.native.workUnitIds.some(id => !units.has(id) || units.get(id).status === 'done')) failures.push('Deferred native work requires an existing open work unit');
  const contexts = new Map(data.contexts.map(context => [contextKey(context), context])), selected = new Set();
  if (!Array.isArray(delivery.contexts) || !delivery.contexts.length) failures.push('Delivery requires a nonempty explicit context scope');
  for (const entry of Array.isArray(delivery.contexts) ? delivery.contexts : []) {
    const context = contexts.get(entry?.context);
    if (!context || !context.available) { failures.push(`Delivery links an unknown or unavailable context: ${entry?.context}`); continue; }
    if (selected.has(entry.context)) failures.push(`Duplicate delivery context: ${entry.context}`);
    selected.add(entry.context);
    if (entry.identity !== context.identity || !text(entry.limitations)) failures.push(`Stale or unscoped delivery context: ${entry.context}`);
  }
  for (const context of directlyChangedContexts(data)) if (!selected.has(contextKey(context))) failures.push(`Delivery omits directly changed or newly available context: ${contextKey(context)}`);
  for (const key of selected) if (!Array.isArray(delivery.native?.workUnitIds)
    || !delivery.native.workUnitIds.some(id => units.has(id) && appliesScope(units.get(id).scope, contexts.get(key)))) failures.push(`Deferred native owner does not cover delivery context: ${key}`);
  const defects = new Map((data.program?.defects ?? []).map(defect => [defect.id, defect]));
  if (!Array.isArray(delivery.openDefectIds) || delivery.openDefectIds.some(id => !defects.has(id) || defects.get(id).status === 'closed')) failures.push('Delivery open-defect links must identify retained unresolved defects');
  for (const defect of defects.values()) if (['open','in-progress','blocked','partial'].includes(defect.status)
    && [...selected].some(key => appliesScope(defect.scope, contexts.get(key))) && !delivery.openDefectIds?.includes(defect.id)) failures.push(`Delivery omits applicable unresolved defect: ${defect.id}`);
  const loaded = evidenceManifest(engineRoot, delivery.regression, 'Delivery regression');
  failures.push(...loaded.failures);
  if (loaded.manifest) {
    const manifest = loaded.manifest;
    if (manifest.kind !== 'authored-playback-regression' || manifest.result !== 'pass' || manifest.identity !== sourceIdentity
      || !text(manifest.reviewer) || !text(manifest.scope) || !text(manifest.limitations)) failures.push('Delivery regression is failed, stale or unscoped');
    for (const key of selected) if (!Array.isArray(manifest.contexts) || !manifest.contexts.includes(key)) failures.push(`Delivery regression omits context: ${key}`);
    for (const id of ['clinical-patient-bounds','contact-continuity','shared-runtime-regression']) {
      const checks = Array.isArray(manifest.checks) ? manifest.checks.filter(check => check?.id === id) : [];
      if (checks.length !== 1 || checks[0].result !== 'pass' || !text(checks[0].scope) || !text(checks[0].observed)
        || !Array.isArray(checks[0].evidence) || !checks[0].evidence.length) failures.push(`Delivery regression requires passing scoped ${id} evidence`);
      else for (const artifact of checks[0].evidence) failures.push(...artifactErrors(engineRoot, artifact));
    }
    comparisonArtifacts(engineRoot, manifest, failures);
  }
  return failures;
}
// Playback delivery can retain an explicitly unresolved anatomical constraint.
// Do not invent an excursion limit for a driven/helper bone just to release it.
// Stabilization/contact promises and every declared rule remain mandatory.
function hasDeferredConstraint(record, delivering) {
  return delivering && ['driven','derived'].includes(record.requiredRole)
    && record.constraintStatus === 'unqualified'
    && typeof record.constraintReason === 'string' && record.constraintReason.trim().length > 0;
}
function hasSupportPositionBound(rules) {
  // A support's vertical bone height can change as the posed skin rolls on the
  // plane. X/Z anchoring is a distinct promise from the required skin review.
  return rules.some(rule => ['worldPositionExcursionM','worldHorizontalPositionExcursionM'].includes(rule.metric) && Number.isFinite(rule.max));
}
export function artifactErrors(root, artifact) {
  if (!root || !artifact || typeof artifact.path !== 'string' || !/^[a-f\d]{64}$/.test(artifact.sha256 ?? '')) return ['missing repository or invalid artifact reference'];
  try { if (digest(evidenceBytes(root,artifact.path))!==artifact.sha256) return [`changed or escaped artifact: ${artifact.path}`]; }
  catch { return [`missing or external artifact: ${artifact.path}`]; }
  return [];
}
function evidenceManifest(root, ref, label) {
  const failures = artifactErrors(root, ref);
  if (failures.length) return {failures,manifest:null};
  try {return {failures,manifest:JSON.parse(evidenceBytes(root,ref.path).toString('utf8'))};}
  catch {return {failures:[`${label} requires a structured JSON comparison manifest`],manifest:null};}
}
function comparisonArtifacts(root, manifest, failures) {
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) failures.push('Comparison requires retained underlying data or captures');
  for (const artifact of manifest.artifacts ?? []) failures.push(...artifactErrors(root,artifact));
}
export function referenceComparisonErrors(root, criterion, reference, context) {
  const failures = [];
  for (const ref of criterion.evidence ?? []) {
    const loaded=evidenceManifest(root,ref,'Reference comparison');failures.push(...loaded.failures);
    const manifest=loaded.manifest;if(!manifest)continue;
    if(manifest.kind!=='reference-comparison'||manifest.result!=='pass'||manifest.context!==contextKey(context)||manifest.identity!==context.identity||manifest.referenceId!==reference.id||manifest.referenceIdentity!==referenceIdentity(reference)||manifest.criterionId!==criterion.id||!manifest.reviewer?.trim()||!manifest.method?.trim()||!manifest.scope?.trim()) failures.push('Reference comparison is failed, stale, or belongs to a different reference/criterion/context');
    if(!Array.isArray(manifest.claimIds)||criterion.claimIds.some(id=>!manifest.claimIds.includes(id))) failures.push('Reference comparison omits its supported claim IDs');
    if(!manifest.comparison?.expected?.trim()||!manifest.comparison?.observed?.trim()||typeof manifest.comparison?.limitations!=='string') failures.push('Reference comparison must state expected/observed behavior and limitations');
    if(manifest.method==='quantitative') {
      if(!Array.isArray(manifest.measurements)||!manifest.measurements.length) failures.push('Quantitative comparison needs actual measurements and justified bounds');
      for(const measured of manifest.measurements??[]) {
        if(!measured?.metric?.trim()||!measured.units?.trim()||!measured.thresholdBasis?.trim()||!Number.isFinite(measured.value)||!Array.isArray(measured.claimIds)||!measured.claimIds.length||measured.claimIds.some(id=>!criterion.claimIds.includes(id))) {failures.push('Invalid quantitative measurement or unsupported threshold basis');continue;}
        failures.push(...checkRules([{metric:measured.metric,min:measured.min,max:measured.max}],{[measured.metric]:measured.value}));
      }
    }
    comparisonArtifacts(root,manifest,failures);
  }
  return failures;
}
export function defectClosureErrors(root, closure, defect, context) {
  const loaded=evidenceManifest(root,closure.acceptanceEvidence,'Defect closure'),failures=loaded.failures,manifest=loaded.manifest;
  if(!manifest)return failures;
  if(manifest.kind!=='defect-closure'||manifest.result!=='pass'||manifest.defectId!==defect.id||manifest.context!==contextKey(context)||manifest.identity!==context.identity||!manifest.reviewer?.trim()||!manifest.scope?.trim()) failures.push('Defect closure is failed, stale or belongs to a different defect/context');
  if(!Array.isArray(manifest.criteria)) failures.push('Defect closure requires explicit acceptance criteria');
  for(const description of defect.acceptance) {
    const criterion=manifest.criteria?.find(item=>item.description===description);
    if(!criterion||criterion.result!=='pass'||!criterion.observed?.trim()||!Array.isArray(criterion.evidence)||!criterion.evidence.length) failures.push(`Defect closure has not verified criterion: ${description}`);
    else for(const artifact of criterion.evidence)failures.push(...artifactErrors(root,artifact));
  }
  return failures;
}
export function evaluateCatalogue(data, tracking, { engineRoot, baselineDigest, freshObservations = {}, reviewAll = false } = {}) {
  const errors = [], changed = changedContexts(data);
  const phaseRecords = new Map();
  for (const [phaseKey, record] of Object.entries(tracking)) {
    let parts; try { parts = JSON.parse(phaseKey); } catch { continue; }
    if (!Array.isArray(parts) || parts.length !== 5 || parts[3] === 'all') continue;
    const key = JSON.stringify([parts[0], parts[1], parts[2], parts[4]]);
    if (!phaseRecords.has(key)) phaseRecords.set(key, []);
    phaseRecords.get(key).push({ phase: parts[3], record });
  }
  const baseline = data.enforcement?.baseline;
  if (!baseline || digest(baseline) !== baselineDigest) errors.push('Frozen historical baseline is missing or was rewritten; refresh may not reset acceptance requirements');
  const allKeys = data.contexts.map(contextKey);
  if (new Set(allKeys).size !== allKeys.length) errors.push('Duplicate motion/body/side context');
  for(const [id,definition] of Object.entries(data.definitions)) if(digest(definition)!==id) errors.push(`Edited definition identity does not match its contents: ${id}`);
  for(const context of data.contexts) if(context.identity!==identity(data,context)) errors.push(`Invalid current context identity: ${contextKey(context)}`);
  for(const rig of Object.values(data.rigs)) {
    if(new Set(rig.bones.map(bone=>bone.id)).size!==rig.bones.length) errors.push('Duplicate joint/bone identity');
    for(const id of ['Hips','Spine_Lower','Spine_Mid','Spine_Upper','Neck_Lower','Neck','Head']) if(!rig.bones.some(bone=>bone.id===id)) errors.push(`Full axial chain omitted: ${id}`);
  }
  for (const key of Object.keys(baseline?.contexts ?? {})) if (!allKeys.includes(key)) errors.push(`Context removed without an explicit retirement: ${key}`);
  const changedSet = new Set(changed.map(contextKey));
  const delivery = data.enforcement?.delivery;
  if (delivery !== undefined) errors.push(...deliveryErrors(data, delivery, engineRoot));
  // Delivery eligibility never replaces an explicit qualification or closure.
  const candidates = reviewAll ? data.contexts.filter(context => context.available !== false) : requiredContexts(data, tracking);
  const qualified = delivery === undefined ? candidates : candidates.filter(context => tracking[reviewKey(context)]);
  errors.push(...validateProgram(data, tracking, {
    requiredContexts: qualified,
    checkArtifact: artifact => artifactErrors(engineRoot, artifact),
    checkComparison: (criterion, reference, context) => referenceComparisonErrors(engineRoot,criterion,reference,context),
    checkClosure: (closure, defect, context) => defectClosureErrors(engineRoot,closure,defect,context),
    checkReport: (report, context, currentIdentity) => {
      const failures = [];
      if (engineRoot) stageReport(engineRoot, report, context, currentIdentity, failures);
      else failures.push('cannot verify review evidence without the engine repository');
      return failures;
    }
  }));
  for (const context of candidates) {
    const key = contextKey(context), currentIdentity = identity(data, context), failures = [];
    const qualification = tracking[reviewKey(context)];
    const delivering = delivery !== undefined && !qualification;
    const review = qualification ?? (Array.isArray(delivery?.contexts) ? delivery.contexts.find(entry => entry?.context === key) : undefined), stored = tracking[observationKey(context)], measured = freshObservations[key] ?? stored;
    if (!review || review.identity !== currentIdentity) failures.push('missing or stale context review');
    if (!measured || measured.identity !== currentIdentity || measured.context !== key || measured.rigSha256 !== data.rigs[context.variant].sha256 || !Number.isFinite(measured.sampleHz) || measured.sampleHz < 30 || !Number.isInteger(measured.frameCount) || measured.frameCount < 2 || measured.complete !== true) failures.push('missing, incomplete or stale actual-rig trajectory observations');
    const bones = data.rigs[context.variant].bones;
    for (const bone of bones) {
      for(const metric of ['localRotationExcursionDeg','worldRotationExcursionDeg','worldPositionExcursionM','localAngularPathDeg','worldPositionPathM']) if(!Number.isFinite(measured?.metrics?.[bone.id]?.[metric])) failures.push(`${bone.id}: missing or nonfinite ${metric}`);
      const record = tracking[jointKey(context, bone.id)];
      if (!record || !['driven','derived','held','contact','free','not-involved'].includes(record.requiredRole)) { failures.push(`${bone.id}: missing required role`); continue; }
      if (record.identity !== currentIdentity || !delivering && record.status !== 'verified' || !record.note?.trim() || !record.evidence?.trim()) failures.push(`${bone.id}: unresolved, unscoped or stale review`);
      if (record.requiredRole === 'derived' && (!bones.some(item => item.id === record.owner) || record.owner === bone.id)) failures.push(`${bone.id}: invalid or missing derived controller owner`);
      const rules = record.rules ?? [];
      if (record.requiredRole !== 'free' && !rules.length && !hasDeferredConstraint(record, delivering)) failures.push(`${bone.id}: missing measured trajectory constraints`);
      if (['held','not-involved'].includes(record.requiredRole) && !rules.some(rule => rule.metric === 'localRotationExcursionDeg' && Number.isFinite(rule.max))) failures.push(`${bone.id}: stabilization requires a local angular excursion ceiling`);
      if (record.requiredRole === 'contact' && !hasSupportPositionBound(rules)) failures.push(`${bone.id}: support requires a world-position constraint over the reviewed window`);
      failures.push(...checkRules(rules, measured?.metrics?.[bone.id]).map(error => `${bone.id}: ${error}`));
      // Any phase record entered is also checked; full-motion coverage cannot hide phase failures.
      for (const { phase, record: phaseRecord } of phaseRecords.get(JSON.stringify([context.id, context.variant, context.side, bone.id])) ?? []) {
        const parts = [context.id, context.variant, context.side, phase, bone.id];
        if (phaseRecord.identity !== currentIdentity || !delivering && phaseRecord.status !== 'verified' || !['driven','derived','held','contact','free','not-involved'].includes(phaseRecord.requiredRole) || !phaseRecord.note?.trim() || !phaseRecord.evidence?.trim()) failures.push(`${bone.id} phase ${parts[3]}: unresolved or stale`);
        if(phaseRecord.requiredRole==='derived' && (!bones.some(item=>item.id===phaseRecord.owner) || phaseRecord.owner===bone.id)) failures.push(`${bone.id} phase ${parts[3]}: missing controller owner`);
        if(phaseRecord.requiredRole!=='free' && !phaseRecord.rules?.length && !hasDeferredConstraint(phaseRecord, delivering)) failures.push(`${bone.id} phase ${parts[3]}: missing constraints`);
        if(['held','not-involved'].includes(phaseRecord.requiredRole) && !phaseRecord.rules?.some(rule=>rule.metric==='localRotationExcursionDeg'&&Number.isFinite(rule.max))) failures.push(`${bone.id} phase ${parts[3]}: missing stabilization ceiling`);
        if(phaseRecord.requiredRole==='contact' && !hasSupportPositionBound(phaseRecord.rules ?? [])) failures.push(`${bone.id} phase ${parts[3]}: missing support-position ceiling`);
        failures.push(...checkRules(phaseRecord.rules ?? [], measured?.phaseMetrics?.[parts[3]]?.[bone.id]).map(error => `${bone.id} phase ${parts[3]}: ${error}`));
      }
    }
    const stages = ['blender','roundtrip','skin-contact','simlab','simmove'];
    if (!delivering) {
      if (review?.nativeRequired === true) stages.push('native');
      else if (review?.nativeRequired !== false || !review.nativeReason?.trim()) failures.push('native applicability must be explicit, with a reason if not required');
    }
    for (const stage of stages) {
      const reports = Array.isArray(review?.reports) ? review.reports.filter(report => report?.stage === stage) : [];
      if (!reports.length) failures.push(`missing ${stage} evidence`);
      for (const report of reports) {
        if (engineRoot) stageReport(engineRoot, report, context, currentIdentity, failures);
        else failures.push(`cannot verify ${stage} evidence without the engine repository`);
      }
    }
    if (failures.length) errors.push({ context: key, failures });
  }
  const candidateKeys = new Set(candidates.map(contextKey));
  return { pass: errors.length === 0, changedContexts: changed.length, reviewedContexts: qualified.length,
    deliveryContexts: candidates.length - qualified.length,
    unqualifiedAffectedContexts: changed.filter(context => !candidateKeys.has(contextKey(context))).length,
    historicalContexts: data.contexts.filter(context => !candidateKeys.has(contextKey(context)) && !changedSet.has(contextKey(context))).length, errors };
}
export function checkSnapshotSources(data, roots) {
  const errors = [];
  for (const [path, expected] of Object.entries(data.hashes)) {
    let root, suffix;
    if (path.startsWith('pose-engine/')) { root = roots.engine; suffix = path.slice('pose-engine/'.length); }
    else if (path.startsWith('simmove/')) { root = roots.simmove; suffix = path.slice('simmove/'.length); }
    else { root = roots.simlab; suffix = path; }
    if (!root) continue; // A standalone engine validates its own repository scope.
    const absolute = resolve(root, suffix);
    if (!existsSync(absolute) || (path.endsWith('.glb') ? digest(readFileSync(absolute)) : sourceHash(readFileSync(absolute))) !== expected) errors.push(`stale source inventory: ${path}`);
  }
  for (const [variant, rig] of Object.entries(data.rigs)) {
    const bytes=readFileSync(resolve(roots.engine, `models/painmap3D_${variant}.runtime.glb`));
    if(digest(bytes)!==rig.sha256) errors.push(`stale ${variant} body asset`);
    const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString('utf8'));
    const raw=[...new Set(gltf.skins.flatMap(skin=>skin.joints))].map(index=>gltf.nodes[index].name).sort();
    if(digest(raw)!==digest(rig.bones.map(bone=>bone.raw).sort()) || rig.skinJointCount!==raw.length) errors.push(`Incomplete actual ${variant} skeleton inventory`);
  }
  // Newly added runtime files cannot disappear from freshness checks.
  for (const path of sourceFiles(roots.engine, ['src','models'])) if (!data.hashes[`pose-engine/${path}`]) errors.push(`runtime source missing from inventory: pose-engine/${path}`);
  if (roots.simlab) for (const path of sourceFiles(roots.simlab, HOST_SOURCE_DIRS.simlab)) if (!data.hashes[path]) errors.push(`host source missing from inventory: ${path}`);
  if (roots.simmove) for (const path of sourceFiles(roots.simmove, HOST_SOURCE_DIRS.simmove)) if (!data.hashes[`simmove/${path}`]) errors.push(`host source missing from inventory: simmove/${path}`);
  return errors;
}
export function assertGate(result) {
  if (result.pass) return;
  const summary = result.errors.slice(0, 8).map(error => typeof error === 'string' ? error : `${error.context}: ${error.failures.slice(0, 6).join('; ')}${error.failures.length > 6 ? ` (+${error.failures.length-6} more)` : ''}`).join('\n');
  throw Error(`Movement catalogue gate failed (${result.changedContexts ?? '?'} changed contexts)\n${summary}\nRefresh the same master, define required joint roles, sample actual rigs and attach current evidence. Unreviewed motion is not approved.`);
}
