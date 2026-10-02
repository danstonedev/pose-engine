import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export const MASTER_PATH = 'docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html';
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const sourceHash = bytes => digest(bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
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
    if(path.startsWith('packages/ddx/src/movement/') || path.startsWith('packages/ddx/src/lab/')) return !hostConstructors.has(name);
    return path.startsWith('simmove/');
  }).sort(([a], [b]) => a.localeCompare(b)));
}
export function sourceFiles(root, directories) {
  const result = [];
  function walk(path) {
    if (!existsSync(resolve(root, path))) return;
    for (const item of readdirSync(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${item.name}`;
      if (item.isDirectory()) walk(child);
      else if (/\.(ts|mjs|svelte|json)$/.test(item.name) && !/(^|\/)(__tests__|node_modules)\/|\.test\.|\.node-test\./.test(child)) result.push(child);
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
function stageReport(root, report, context, currentIdentity, failures) {
  if (!report || typeof report.path !== 'string' || !/^[a-f\d]{64}$/.test(report.sha256 ?? '')) { failures.push('invalid evidence reference'); return; }
  const path = resolve(root, report.path), rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(path)) { failures.push(`evidence outside repository or missing: ${report.path}`); return; }
  const resolvedRelative = relative(realpathSync(root), realpathSync(path));
  if (resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) { failures.push(`evidence escapes repository through a link: ${report.path}`); return; }
  const bytes = readFileSync(path);
  if (digest(bytes) !== report.sha256) { failures.push(`evidence hash differs: ${report.path}`); return; }
  let evidence;
  try { evidence = JSON.parse(bytes); } catch { failures.push(`evidence must be a structured review manifest: ${report.path}`); return; }
  if (evidence.stage !== report.stage || evidence.result !== 'pass' || evidence.context !== contextKey(context) || evidence.identity !== currentIdentity || !evidence.scope?.trim() || !evidence.reviewer?.trim() || !evidence.toolVersion?.trim()) failures.push(`failed, stale or incorrectly scoped ${report.stage} evidence: ${report.path}`);
  for(const phase of ['setup','transitions','hold','return','loop']) if(!evidence.phases?.includes(phase)) failures.push(`${report.stage} evidence omits ${phase}`);
  if(!Array.isArray(evidence.artifacts) || !evidence.artifacts.length) failures.push(`${report.stage} evidence requires retained artifacts`);
  for(const artifact of evidence.artifacts??[]) {
    if(typeof artifact.path!=='string' || !/^[a-f\d]{64}$/.test(artifact.sha256??'') || !artifact.kind?.trim()) { failures.push('invalid evidence artifact');continue; }
    const target=resolve(root,artifact.path),rel=relative(root,target);
    if(!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(target)) { failures.push(`missing or external evidence artifact: ${artifact.path}`);continue; }
    const realRel=relative(realpathSync(root),realpathSync(target));
    if(realRel.startsWith('..') || isAbsolute(realRel) || digest(readFileSync(target))!==artifact.sha256) failures.push(`changed or escaped evidence artifact: ${artifact.path}`);
  }
  if(report.stage==='blender' && !evidence.artifacts?.some(artifact=>artifact.kind==='editable-project'&&artifact.path.endsWith('.blend'))) failures.push('Blender review requires an editable .blend project');
}
export function evaluateCatalogue(data, tracking, { engineRoot, baselineDigest, freshObservations = {} } = {}) {
  const errors = [], changed = changedContexts(data);
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
  // Reviewed contexts remain enforceable even if originally historical.
  const candidates = data.contexts.filter(context => changedSet.has(contextKey(context)) || tracking[reviewKey(context)]);
  for (const context of candidates) {
    const key = contextKey(context), currentIdentity = identity(data, context), failures = [];
    const review = tracking[reviewKey(context)], stored = tracking[observationKey(context)], measured = freshObservations[key] ?? stored;
    if (!review || review.identity !== currentIdentity) failures.push('missing or stale context review');
    if (!measured || measured.identity !== currentIdentity || measured.context !== key || measured.rigSha256 !== data.rigs[context.variant].sha256 || !Number.isFinite(measured.sampleHz) || measured.sampleHz < 30 || !Number.isInteger(measured.frameCount) || measured.frameCount < 2 || measured.complete !== true) failures.push('missing, incomplete or stale actual-rig trajectory observations');
    const bones = data.rigs[context.variant].bones;
    for (const bone of bones) {
      for(const metric of ['localRotationExcursionDeg','worldRotationExcursionDeg','worldPositionExcursionM','localAngularPathDeg','worldPositionPathM']) if(!Number.isFinite(measured?.metrics?.[bone.id]?.[metric])) failures.push(`${bone.id}: missing or nonfinite ${metric}`);
      const record = tracking[jointKey(context, bone.id)];
      if (!record || !['driven','derived','held','contact','free','not-involved'].includes(record.requiredRole)) { failures.push(`${bone.id}: missing required role`); continue; }
      if (record.identity !== currentIdentity || record.status !== 'verified' || !record.note?.trim() || !record.evidence?.trim()) failures.push(`${bone.id}: unresolved, unscoped or stale review`);
      if (record.requiredRole === 'derived' && (!bones.some(item => item.id === record.owner) || record.owner === bone.id)) failures.push(`${bone.id}: invalid or missing derived controller owner`);
      const rules = record.rules ?? [];
      if (record.requiredRole !== 'free' && !rules.length) failures.push(`${bone.id}: missing measured trajectory constraints`);
      if (['held','not-involved'].includes(record.requiredRole) && !rules.some(rule => rule.metric === 'localRotationExcursionDeg' && Number.isFinite(rule.max))) failures.push(`${bone.id}: stabilization requires a local angular excursion ceiling`);
      if (record.requiredRole === 'contact' && !rules.some(rule => rule.metric === 'worldPositionExcursionM' && Number.isFinite(rule.max))) failures.push(`${bone.id}: support requires a world-position constraint over the reviewed window`);
      failures.push(...checkRules(rules, measured?.metrics?.[bone.id]).map(error => `${bone.id}: ${error}`));
      // Any phase record entered is also checked; full-motion coverage cannot hide phase failures.
      for (const [phaseKey, phaseRecord] of Object.entries(tracking)) {
        let parts; try { parts = JSON.parse(phaseKey); } catch { continue; }
        if (parts.length !== 5 || parts[0] !== context.id || parts[1] !== context.variant || parts[2] !== context.side || parts[4] !== bone.id || parts[3] === 'all') continue;
        if (phaseRecord.identity !== currentIdentity || phaseRecord.status !== 'verified' || !['driven','derived','held','contact','free','not-involved'].includes(phaseRecord.requiredRole) || !phaseRecord.note?.trim() || !phaseRecord.evidence?.trim()) failures.push(`${bone.id} phase ${parts[3]}: unresolved or stale`);
        if(phaseRecord.requiredRole==='derived' && (!bones.some(item=>item.id===phaseRecord.owner) || phaseRecord.owner===bone.id)) failures.push(`${bone.id} phase ${parts[3]}: missing controller owner`);
        if(phaseRecord.requiredRole!=='free' && !phaseRecord.rules?.length) failures.push(`${bone.id} phase ${parts[3]}: missing constraints`);
        if(['held','not-involved'].includes(phaseRecord.requiredRole) && !phaseRecord.rules?.some(rule=>rule.metric==='localRotationExcursionDeg'&&Number.isFinite(rule.max))) failures.push(`${bone.id} phase ${parts[3]}: missing stabilization ceiling`);
        if(phaseRecord.requiredRole==='contact' && !phaseRecord.rules?.some(rule=>rule.metric==='worldPositionExcursionM'&&Number.isFinite(rule.max))) failures.push(`${bone.id} phase ${parts[3]}: missing support-position ceiling`);
        failures.push(...checkRules(phaseRecord.rules ?? [], measured?.phaseMetrics?.[parts[3]]?.[bone.id]).map(error => `${bone.id} phase ${parts[3]}: ${error}`));
      }
    }
    const stages = ['blender','roundtrip','skin-contact','simlab','simmove'];
    if (review?.nativeRequired === true) stages.push('native');
    else if (review?.nativeRequired !== false || !review.nativeReason?.trim()) failures.push('native applicability must be explicit, with a reason if not required');
    for (const stage of stages) {
      const reports = review?.reports?.filter(report => report.stage === stage) ?? [];
      if (!reports.length) failures.push(`missing ${stage} evidence`);
      for (const report of reports) {
        if (engineRoot) stageReport(engineRoot, report, context, currentIdentity, failures);
        else failures.push(`cannot verify ${stage} evidence without the engine repository`);
      }
    }
    if (failures.length) errors.push({ context: key, failures });
  }
  return { pass: errors.length === 0, changedContexts: changed.length, reviewedContexts: candidates.length, historicalContexts: data.contexts.length - candidates.length, errors };
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
    if (!existsSync(absolute) || sourceHash(readFileSync(absolute)) !== expected) errors.push(`stale source inventory: ${path}`);
  }
  for (const [variant, rig] of Object.entries(data.rigs)) {
    const bytes=readFileSync(resolve(roots.engine, `models/painmap3D_${variant}.runtime.glb`));
    if(digest(bytes)!==rig.sha256) errors.push(`stale ${variant} body asset`);
    const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString('utf8'));
    const raw=[...new Set(gltf.skins.flatMap(skin=>skin.joints))].map(index=>gltf.nodes[index].name).sort();
    if(digest(raw)!==digest(rig.bones.map(bone=>bone.raw).sort()) || rig.skinJointCount!==raw.length) errors.push(`Incomplete actual ${variant} skeleton inventory`);
  }
  // Newly added runtime files cannot disappear from freshness checks.
  for (const path of sourceFiles(roots.engine, ['src'])) if (!data.hashes[`pose-engine/${path}`]) errors.push(`runtime source missing from inventory: pose-engine/${path}`);
  if (roots.simlab) for (const path of sourceFiles(roots.simlab, ['packages/ddx/src/movement', 'packages/ddx/src/lab'])) if (!data.hashes[path]) errors.push(`host source missing from inventory: ${path}`);
  if (roots.simmove) for (const path of sourceFiles(roots.simmove, ['src'])) if (!data.hashes[`simmove/${path}`]) errors.push(`host source missing from inventory: simmove/${path}`);
  return errors;
}
export function assertGate(result) {
  if (result.pass) return;
  const summary = result.errors.slice(0, 8).map(error => typeof error === 'string' ? error : `${error.context}: ${error.failures.slice(0, 6).join('; ')}${error.failures.length > 6 ? ` (+${error.failures.length-6} more)` : ''}`).join('\n');
  throw Error(`Movement catalogue gate failed (${result.changedContexts ?? '?'} changed contexts)\n${summary}\nRefresh the same master, define required joint roles, sample actual rigs and attach current evidence. Unreviewed motion is not approved.`);
}
