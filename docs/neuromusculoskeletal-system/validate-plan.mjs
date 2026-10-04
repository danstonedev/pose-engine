import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const planDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(planDirectory, '../../../../..');
const requiredDocuments = [
  'README.md', '00-current-state-and-scope.md', '01-research-and-sources.md',
  '02-system-architecture.md', '03-foundation-and-anatomy.md',
  '04-validation-and-experiments.md', '05-delivery-roadmap.md',
  '06-expert-review-and-decisions.md', '07-working-protocols.md',
  '08-planning-review.md',
];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validUrl = value => {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
};

export function validateSources(library) {
  const errors = [];
  const ids = new Set();
  if (library?.schemaVersion !== 1) errors.push('Source library schemaVersion must be 1.');
  if (!validDate(library?.accessedOn)) errors.push('Source library accessedOn must be a valid date.');
  if (!nonempty(library?.scope)) errors.push('Source library must declare its research scope.');
  if (!Array.isArray(library?.sources) || !library.sources.length) {
    return { errors: [...errors, 'Source library must contain source entries.'], ids };
  }
  for (const source of library.sources) {
    const label = source?.id ?? 'Unidentified source';
    if (!/^SRC-[A-Z0-9-]+$/.test(source?.id ?? '')) errors.push(`${label}: invalid stable source ID.`);
    if (ids.has(source?.id)) errors.push(`${label}: duplicate source ID.`);
    ids.add(source?.id);
    for (const field of ['title', 'type', 'candidateUse']) {
      if (!nonempty(source?.[field])) errors.push(`${label}: missing ${field}.`);
    }
    if (!validUrl(source?.url)) errors.push(`${label}: missing or invalid source URL.`);
    if (!validDate(source?.verifiedOn) || source.verifiedOn > library.accessedOn) {
      errors.push(`${label}: invalid or future verification date.`);
    }
    for (const field of ['supports', 'limitations']) {
      if (!Array.isArray(source?.[field]) || !source[field].length || !source[field].every(nonempty)) {
        errors.push(`${label}: ${field} must name supported claims and source limits explicitly.`);
      }
    }
    const license = source?.license;
    if (!['verified', 'unverified', 'mixed'].includes(license?.status) || !nonempty(license?.value)) {
      errors.push(`${label}: license status and scope must be explicit.`);
    }
    if (license?.evidenceUrl !== null && !validUrl(license?.evidenceUrl)) {
      errors.push(`${label}: invalid license evidence URL.`);
    }
    if (license?.status === 'verified' && !validUrl(license?.evidenceUrl)) {
      errors.push(`${label}: a verified license needs an evidence URL.`);
    }
  }
  return { errors, ids };
}

function insideWorkspace(path) {
  const location = relative(workspaceRoot, path);
  return !isAbsolute(location) && location !== '..' && !location.startsWith('..\\') && !location.startsWith('../');
}

export function validateSnapshot(snapshot, checkCurrent = false) {
  const errors = [];
  const warnings = [];
  if (snapshot?.schemaVersion !== 1 || snapshot?.kind !== 'selected-source-planning-audit') {
    errors.push('Audit must declare its schema and limited source audit kind.');
  }
  if (!validDate(snapshot?.clientDate) || snapshot?.timeZone !== 'America/Chicago' ||
      !nonempty(snapshot?.capturedAt) || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    errors.push('Audit must retain the capture time and client date context.');
  }
  if (!Array.isArray(snapshot?.limitations) || !snapshot.limitations.length) errors.push('Audit limitations are missing.');
  if (snapshot?.consistency?.selectedFilesUnchanged !== true ||
      snapshot?.consistency?.repositoryHeadAndStatusUnchanged !== true ||
      !nonempty(snapshot?.consistency?.method) ||
      Number.isNaN(Date.parse(snapshot?.consistency?.inspectionStartedAt)) ||
      Number.isNaN(Date.parse(snapshot?.consistency?.inspectionFinishedAt))) {
    errors.push('Audit requires its before/after consistency result and inspection times.');
  }
  if (!Array.isArray(snapshot?.repositories) || !snapshot.repositories.length) errors.push('Audit repositories are missing.');
  else for (const repository of snapshot.repositories) {
    if (!nonempty(repository.label) || !nonempty(repository.path) ||
        !insideWorkspace(resolve(workspaceRoot, repository.path))) errors.push('Invalid audit repository path.');
    if (repository.head?.available && !/^[a-f0-9]{40}$/.test(repository.head.value ?? '')) {
      errors.push(`${repository.label}: invalid recorded commit.`);
    }
    if (!repository.head?.available) warnings.push(`${repository.label}: Git HEAD unavailable at capture.`);
  }
  const seen = new Set();
  if (!Array.isArray(snapshot?.files) || !snapshot.files.length) errors.push('Audit source identities are missing.');
  else for (const file of snapshot.files) {
    if (!nonempty(file.path)) { errors.push('Audit source path missing.'); continue; }
    if (seen.has(file.path)) errors.push(`Duplicate audit source: ${file.path}`);
    seen.add(file.path);
    const location = resolve(workspaceRoot, file.path);
    if (!insideWorkspace(location)) { errors.push(`Audit path escapes workspace: ${file.path}`); continue; }
    if (!file.available) { warnings.push(`Source unavailable at capture: ${file.path}`); continue; }
    if (file.hashMode !== 'raw-bytes' || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0) errors.push(`Invalid inspection identity: ${file.path}`);
    if (checkCurrent) {
      if (!existsSync(location)) errors.push(`Inspected source no longer exists: ${file.path}`);
      else if (createHash('sha256').update(readFileSync(location)).digest('hex') !== file.sha256) {
        errors.push(`Inspection snapshot is stale: ${file.path}`);
      }
    }
  }
  return { errors, warnings, fileCount: seen.size };
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  const text = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].replace(/\s+#+\s*$/, '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    anchors.add(count ? `${base}-${count}` : base);
    counts.set(base, count + 1);
  }
  return anchors;
}

export function validateMarkdown(markdown, documentPath, sourceIds) {
  const errors = [];
  if (markdown.includes('\uFFFD')) errors.push('Invalid replacement character in document.');
  if (markdown.split('\n').some(line => /[\t ]+$/.test(line))) errors.push('Trailing whitespace in document.');
  const fenceCount = [...markdown.matchAll(/^```/gm)].length;
  if (fenceCount % 2) errors.push('Unbalanced fenced code block.');
  const plain = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  if ([...plain.matchAll(/^#\s+.+$/gm)].length !== 1) errors.push('Document must contain one clear title.');
  for (const id of new Set(plain.match(/\bSRC-[A-Z0-9-]+\b/g) ?? [])) {
    if (!sourceIds.has(id)) errors.push(`Unregistered research source ID: ${id}`);
  }
  let checkedLinks = 0;
  for (const match of plain.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const destination = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0];
    if (/^(https?:|mailto:|data:|app:)/i.test(destination)) continue;
    const [rawPath, rawFragment] = destination.split('#');
    const linkPath = decodeURIComponent(rawPath ?? '').replace(/:\d+$/, '');
    const target = linkPath ? resolve(dirname(documentPath), linkPath) : documentPath;
    checkedLinks++;
    if (!insideWorkspace(target) || !existsSync(target)) {
      errors.push(`Broken or escaping local link: ${destination}`);
      continue;
    }
    if (rawFragment && target.endsWith('.md') &&
        !headingAnchors(readFileSync(target, 'utf8')).has(decodeURIComponent(rawFragment))) {
      errors.push(`Unknown Markdown anchor: ${destination}`);
    }
  }
  return { errors, checkedLinks };
}

function readJson(filename, errors) {
  try { return JSON.parse(readFileSync(resolve(planDirectory, filename), 'utf8')); }
  catch (error) { errors.push(`${filename}: ${error.message}`); return null; }
}

function main() {
  const args = process.argv.slice(2);
  const checkSnapshot = args.includes('--check-snapshot');
  const reportIndex = args.indexOf('--report');
  const reportFilename = reportIndex >= 0 ? args[reportIndex + 1] : null;
  const remaining = args.filter((_, index) => index !== reportIndex && index !== reportIndex + 1 && args[index] !== '--check-snapshot');
  // With no --report, do not accidentally filter the first argument as its value.
  const unknown = reportIndex < 0 ? args.filter(arg => arg !== '--check-snapshot') : remaining;
  if (unknown.length || (reportIndex >= 0 && !reportFilename)) {
    throw new Error('Use [--check-snapshot] [--report <new-report.json>].');
  }
  const errors = [];
  const warnings = [];
  const library = readJson('sources.json', errors);
  const sources = validateSources(library);
  errors.push(...sources.errors);
  const snapshot = readJson('current-state-snapshot.json', errors);
  const audit = validateSnapshot(snapshot, checkSnapshot);
  errors.push(...audit.errors);
  warnings.push(...audit.warnings);
  let checkedLinks = 0;
  const documentIdentities = [];
  for (const filename of requiredDocuments) {
    const path = resolve(planDirectory, filename);
    if (!existsSync(path)) { errors.push(`Missing document: ${filename}`); continue; }
    const check = validateMarkdown(readFileSync(path, 'utf8'), path, sources.ids);
    documentIdentities.push({ path: filename, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    checkedLinks += check.checkedLinks;
    errors.push(...check.errors.map(error => `${filename}: ${error}`));
  }
  const report = { kind: 'planning-package-integrity', executedAt: new Date().toISOString(),
    passed: !errors.length, documents: requiredDocuments.length, sourceEntries: library?.sources?.length ?? 0,
    inspectedSourceFiles: audit.fileCount, checkedLocalLinks: checkedLinks,
    documentIdentities,
    sourceLibrarySha256: existsSync(resolve(planDirectory, 'sources.json'))
      ? createHash('sha256').update(readFileSync(resolve(planDirectory, 'sources.json'))).digest('hex') : null,
    validatorSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    currentSourceHashComparison: checkSnapshot ? 'executed' : 'not requested',
    scope: 'Local document, research metadata and selected audit integrity only; no remote verification, simulation or clinical acceptance.',
    errors, warnings };
  if (reportFilename) {
    const output = resolve(planDirectory, reportFilename);
    if (dirname(output) !== planDirectory || !output.endsWith('.json') || basename(output) !== reportFilename) {
      throw new Error('Report must be a new JSON filename in this package.');
    }
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
