import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readMaster, checkSnapshotSources, assertGate } from './gate.mjs';
import { loadComparisonBase, evaluateProgress, progressMessage } from './progress.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  const { data, tracking } = readMaster(engineRoot);
  const pin = JSON.parse(readFileSync(resolve(engineRoot, 'scripts/catalogue/baseline-pin.json'), 'utf8'));
  const hostScope = process.argv[2];
  const roots = { engine: engineRoot, ...(hostScope === 'simlab' ? { simlab: resolve(engineRoot, '..') } : {}), ...(hostScope === 'simmove' ? { simmove: resolve(engineRoot, '..') } : {}) };
  const stale = checkSnapshotSources(data, roots);
  if (stale.length) assertGate({ pass: false, errors: stale });
  const hostRoot = ['simlab','simmove'].includes(hostScope) ? resolve(engineRoot,'..') : undefined;
  const base = loadComparisonBase(engineRoot,hostRoot);
  const result = evaluateProgress({data,tracking}, base, { engineRoot, baselineDigest: pin.sha256 });
  assertGate(result);
  console.log(progressMessage(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
