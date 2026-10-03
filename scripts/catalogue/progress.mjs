import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { digest, parseMaster, evaluateCatalogue, observationKey, reviewKey } from './gate.mjs';
import { retentionErrors, trackingRetentionErrors } from './reconcile.mjs';

const git = (root, args, binary = false) => execFileSync('git', args, {
  cwd: root, encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
});
export function loadComparisonBase(engineRoot, hostRoot) {
  const root = hostRoot ?? engineRoot;
  let revision;
  if (process.env.GITHUB_EVENT_PATH && ['pull_request', 'push'].includes(process.env.GITHUB_EVENT_NAME)) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    revision = event.pull_request?.base?.sha ?? event.before;
    if (!revision || /^0+$/.test(revision)) throw Error('A trusted comparison base is required; initial adoption needs explicit review.');
  } else {
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    const main = git(root, ['rev-parse', 'origin/main']).trim();
    revision = head === main ? git(root, ['rev-parse', 'HEAD^1']).trim() : git(root, ['merge-base', 'HEAD', 'origin/main']).trim();
  }
  if (!/^[a-f\d]{40}$/.test(revision)) throw Error('Invalid comparison revision.');
  const engineRevision = hostRoot ? git(root, ['ls-tree', revision, 'pose-engine']).match(/^160000 commit ([a-f\d]{40})\tpose-engine\s*$/)?.[1] : revision;
  if (!engineRevision) throw Error('Comparison base has no pose-engine gitlink.');
  const files = new Map();
  const evidenceRoot = { read(path) {
    if (!files.has(path)) files.set(path, git(engineRoot, ['show', `${engineRevision}:${path}`], true));
    return files.get(path);
  }};
  const master = parseMaster(evidenceRoot.read('docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html').toString('utf8'));
  const pin = JSON.parse(evidenceRoot.read('scripts/catalogue/baseline-pin.json').toString('utf8'));
  return { ...master, pin, revision, engineRevision, evidenceRoot };
}
function issue(context, message) {
  const numeric = message.match(/^(.*)=(-?[\d.]+(?:e[+-]?\d+)?) outside (-inf|-?[\d.]+(?:e[+-]?\d+)?)\.\.(inf|-?[\d.]+(?:e[+-]?\d+)?)$/i);
  if (!numeric) return { key: JSON.stringify([context, message]), severity: 1, context, message };
  const value = Number(numeric[2]), min = numeric[3] === '-inf' ? -Infinity : Number(numeric[3]), max = numeric[4] === 'inf' ? Infinity : Number(numeric[4]);
  return { key: JSON.stringify([context, numeric[1], numeric[3], numeric[4]]), severity: Math.max(min - value, value - max, 0), context, message };
}
function* issues(result) {
  for (const error of result.errors) {
    if (typeof error !== 'string') {
      for (const message of error.failures) yield issue(error.context, message);
    } else {
      const scoped = error.match(/^Context (\[.*?\]): (.*)$/);
      yield issue(scoped?.[1] ?? null, scoped?.[2] ?? error);
    }
  }
}
export function compareIssues(before, after) {
  const previous = new Map(), current = new Map();
  for (const [result, map] of [[before, previous], [after, current]]) for (const item of issues(result)) {
    if (!map.has(item.key) || item.severity > map.get(item.key).severity) map.set(item.key, item);
  }
  const errors = [];
  let remainingIssues = 0, improvedIssues = 0;
  for (const item of current.values()) {
    const old = previous.get(item.key);
    // Structural, provenance and evidence-integrity failures require repair.
    const corruptEvidence = /evidence hash differs|changed or escaped|outside repository|external (?:evidence )?artifact|invalid (?:evidence|artifact) reference/.test(item.message);
    if (item.context === null || corruptEvidence || !old || item.severity > old.severity) errors.push(item.context === null ? item.message : { context: item.context, failures: [item.message] });
    else { remainingIssues++; if (item.severity < old.severity) improvedIssues++; }
    previous.delete(item.key);
  }
  improvedIssues += previous.size;
  return { pass: errors.length === 0, errors, remainingIssues, improvedIssues };
}
export function preservationErrors(base, current) {
  const errors = [...retentionErrors(base.data.program, current.data.program), ...trackingRetentionErrors(base.tracking, current.tracking)];
  if (digest(base.data.enforcement?.baseline) !== digest(current.data.enforcement?.baseline)) errors.push('Frozen historical baseline differs from the comparison base.');
  for (const [key, old] of Object.entries(base.tracking)) {
    const next = current.tracking[key];
    for (const rule of old.rules ?? []) {
      if (!(next?.rules ?? []).some(candidate => candidate.metric === rule.metric && (rule.min === undefined || candidate.min >= rule.min) && (rule.max === undefined || candidate.max <= rule.max))) errors.push(`Existing constraint removed or relaxed: ${key} / ${rule.metric}`);
    }
    if (old.nativeRequired === true && next?.nativeRequired !== true) errors.push(`Native requirement removed: ${key}`);
  }
  const defects = new Map((current.data.program?.defects ?? []).map(defect => [defect.id, defect]));
  for (const old of base.data.program?.defects ?? []) {
    const next = defects.get(old.id);
    if (old.blocking && next && (!next.blocking || digest(old.scope) !== digest(next.scope) || old.acceptance.some(item => !next.acceptance.includes(item)) || ['unsupported','historical'].includes(next.status) && next.status !== old.status)) errors.push(`Existing blocking defect requirements changed: ${old.id}`);
  }
  return errors;
}
export function evaluateProgress(current, base, { engineRoot, baselineDigest, freshObservations = {} }) {
  const preservation = preservationErrors(base, current);
  if (base.pin && base.pin.sha256 !== baselineDigest) preservation.push('Historical baseline pin differs from the comparison base.');
  const before = evaluateCatalogue(base.data, base.tracking, { engineRoot: base.evidenceRoot ?? engineRoot, baselineDigest, reviewAll: true });
  const after = evaluateCatalogue(current.data, current.tracking, { engineRoot, baselineDigest, freshObservations, reviewAll: true });
  const result = compareIssues(before, after);
  result.errors.unshift(...preservation);
  result.pass = result.errors.length === 0;
  result.changedContexts = after.changedContexts;
  return result;
}
export function sampledContexts({ data, tracking }) {
  // Recheck measured/reviewed contexts; missing measurements remain open gaps.
  return data.contexts.filter(context => context.available !== false && (tracking[observationKey(context)] || tracking[reviewKey(context)]));
}
export function progressMessage(result) {
  return `Movement regression gate passed: ${result.improvedIssues} issues improved; ${result.remainingIssues} existing qualification issues remain open. Merging grants no movement acceptance.`;
}
