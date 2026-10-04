import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const planDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(planDirectory, '../../../../..');
const inspectionStartedAt = new Date().toISOString();
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') {
  throw new Error('Use --out <new-snapshot.json>; this tool never overwrites an audit.');
}
const output = resolve(planDirectory, args[1]);
const outputRelative = relative(planDirectory, output);
if (isAbsolute(outputRelative) || outputRelative.startsWith('..') || basename(output) !== outputRelative || !output.endsWith('.json')) {
  throw new Error('Output must be a JSON filename within this plan directory.');
}
if (existsSync(output)) throw new Error('Existing snapshot retained; choose a new output filename.');

function command(binary, argv, cwd) {
  // Trust only the named workspace repository for this read-only invocation.
  // No persistent or global Git configuration is changed.
  const commandArgs = binary === 'git' ? ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...argv] : argv;
  const result = spawnSync(binary, commandArgs, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || result.error) {
    return { available: false, reason: result.error?.message ?? result.stderr.trim() ?? 'Command failed' };
  }
  return { available: true, value: result.stdout.trim() };
}

const repositoryPaths = [
  ['engine', 'movement-realism-implementation/simmove/pose-engine'],
  ['simMOVE', 'movement-realism-implementation/simmove'],
  ['simLAB', 'movement-realism-implementation/simlab'],
  ['available SimPACS snapshot', 'audit-sources/simpacs'],
];
const repositories = repositoryPaths.map(([label, path]) => {
  const cwd = resolve(workspaceRoot, path);
  return {
    label, path,
    head: command('git', ['rev-parse', 'HEAD'], cwd),
    branch: command('git', ['branch', '--show-current'], cwd),
    status: command('git', ['status', '--short', '--untracked-files=normal'], cwd),
    ...(label === 'simMOVE' || label === 'simLAB'
      ? { committedEngineGitlink: command('git', ['ls-tree', 'HEAD', 'pose-engine'], cwd) } : {}),
  };
});

const movement = 'movement-realism-implementation/';
const engine = movement + 'simmove/pose-engine/';
const simmove = movement + 'simmove/';
const simlab = movement + 'simlab/';
const selectedFiles = [
  movement + 'AGENTS.md', movement + 'UNIFIED-MOVEMENT-DEVELOPMENT-PROMPT.md',
  engine + 'AGENTS.md', engine + 'docs/movement-engineering-charter.md',
  engine + 'docs/movement-catalogue-process.md', engine + 'docs/MASTER-MOVEMENT-JOINT-CATALOGUE.html',
  engine + 'docs/unified-movement-development-prompt.md',
  engine + 'scripts/catalogue/reconcile.mjs', engine + 'scripts/catalogue/program.mjs',
  engine + 'docs/movement-pipeline-audit-2026-10-02.md', engine + 'docs/blender-workflow.md',
  engine + 'src/anatomy/bodyVariants.ts', engine + 'src/services/movementFaults.ts',
  engine + 'src/services/romConstraints.ts',
  simmove + 'package.json', simmove + 'package-lock.json',
  simmove + 'experiments/lower-body/model.mjs',
  simmove + 'experiments/lower-body/authored-task-controller.mjs',
  simmove + 'experiments/lower-body/authored-route-packet.mjs',
  simmove + 'experiments/lower-body/physics-worker.mjs',
  simmove + 'experiments/lower-body/EXPERIMENT-RUNNER.md',
  simmove + 'experiments/upper-body/model.mjs',
  simmove + 'experiments/upper-body/task-space-control.mjs',
  simmove + 'src/editing/EditingWorkspace.svelte',
  simlab + 'scripts/movement-inventory/run.mjs',
  simlab + 'packages/ddx/src/movement/sampler.ts',
  simlab + 'packages/ddx/src/movement/builderSteps.ts',
  simlab + 'packages/ddx/src/data/examBuilder.ts',
  simlab + 'packages/ddx/src/props/nerves.ts',
  simlab + 'apps/painmap/src/lib/simulation/neuroanatomy.ts',
  'audit-sources/simpacs/ATTRIBUTION.md',
  'audit-sources/simpacs/src/lib/anatomy/anatomyLayers.ts',
  'audit-sources/simpacs/static/models/upper-limb.rigged.meta.json',
  'audit-sources/simpacs/tools/blender/rig_elbow.py',
];
const files = selectedFiles.map(path => {
  const absolute = resolve(workspaceRoot, path);
  if (!existsSync(absolute)) return { path, available: false, reason: 'Selected source not available' };
  const bytes = readFileSync(absolute);
  return { path, available: true, hashMode: 'raw-bytes', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
});
const packageJson = JSON.parse(readFileSync(resolve(workspaceRoot, simmove + 'package.json'), 'utf8'));
const blender = command('C:/Program Files/Blender Foundation/Blender 5.2/blender.exe', ['--version'], workspaceRoot);
if (blender.available) blender.value = blender.value.split(/\r?\n/).slice(0, 7).join('\n');

const filesUnchanged = files.every(file => {
  const absolute = resolve(workspaceRoot, file.path);
  if (!file.available) return !existsSync(absolute);
  return existsSync(absolute) && createHash('sha256').update(readFileSync(absolute)).digest('hex') === file.sha256;
});
const repositoriesUnchanged = repositories.every(repository => {
  const cwd = resolve(workspaceRoot, repository.path);
  return JSON.stringify(command('git', ['rev-parse', 'HEAD'], cwd)) === JSON.stringify(repository.head) &&
    JSON.stringify(command('git', ['status', '--short', '--untracked-files=normal'], cwd)) === JSON.stringify(repository.status);
});
if (!filesUnchanged || !repositoriesUnchanged) {
  throw new Error('Selected inputs changed during inspection; no snapshot written. Retry after coordinating active writes.');
}
const inspectionFinishedAt = new Date().toISOString();

const snapshot = {
  schemaVersion: 1,
  kind: 'selected-source-planning-audit',
  capturedAt: inspectionFinishedAt,
  clientDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()),
  timeZone: 'America/Chicago',
  consistency: { inspectionStartedAt, inspectionFinishedAt,
    selectedFilesUnchanged: filesUnchanged, repositoryHeadAndStatusUnchanged: repositoriesUnchanged,
    method: 'Before and after selected byte hashes and repository HEAD/status comparisons; not a locked filesystem snapshot.' },
  repositories,
  tools: { node: process.version, platform: process.platform, architecture: process.arch,
    mujocoDeclaredVersion: packageJson.dependencies['@mujoco/mujoco'], blender },
  files,
  limitations: [
    'Selected source files only; not a complete import graph, installed package or binary manifest.',
    'Raw inspection hashes do not replace the canonical catalogue context identities or experiment fingerprints.',
    'Dirty repository status is captured; Git HEAD alone does not identify inspected development code.',
    'A version command is not scene review, simulator execution, acceptance or production verification.',
    'The available SimPACS source snapshot does not establish current deployed anatomy coverage.',
    'Before/after comparisons detect observed changes but do not lock writers or detect an intervening change that was reverted.',
  ],
};
writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
console.log(`Captured ${files.filter(file => file.available).length}/${files.length} selected sources to ${basename(output)}.`);
