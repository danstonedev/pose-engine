import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readMaster, checkSnapshotSources, evaluateCatalogue, assertGate } from './gate.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  const { data, tracking } = readMaster(engineRoot);
  const pin = JSON.parse(readFileSync(resolve(engineRoot, 'scripts/catalogue/baseline-pin.json'), 'utf8'));
  // CI checks the original baseline against the base revision as well as the
  // current file. Editing both the HTML baseline and its pin cannot grandfather
  // unfinished movements. The initial adoption has no predecessor pin.
  if(process.env.GITHUB_REPOSITORY === 'danstonedev/pose-engine' && ['pull_request','push'].includes(process.env.GITHUB_EVENT_NAME)) {
    execFileSync('git',['rev-parse','HEAD^1'],{cwd:engineRoot,stdio:'pipe'});
    const previousFiles=execFileSync('git',['ls-tree','--name-only','HEAD^1','scripts/catalogue/baseline-pin.json'],{cwd:engineRoot,encoding:'utf8'}).trim();
    if(previousFiles) {
      const previousPin=JSON.parse(execFileSync('git',['show','HEAD^1:scripts/catalogue/baseline-pin.json'],{cwd:engineRoot,encoding:'utf8'}));
      if(previousPin.sha256!==pin.sha256) throw Error('The historical baseline pin differs from the base revision; rebaselining is prohibited.');
    }
  }
  const hostScope = process.argv[2];
  const roots = { engine: engineRoot, ...(hostScope === 'simlab' ? { simlab: resolve(engineRoot, '..') } : {}), ...(hostScope === 'simmove' ? { simmove: resolve(engineRoot, '..') } : {}) };
  const stale = checkSnapshotSources(data, roots);
  if (stale.length) assertGate({ pass: false, errors: stale });
  const result = evaluateCatalogue(data, tracking, { engineRoot, baselineDigest: pin.sha256 });
  assertGate(result);
  console.log(`Movement catalogue gate passed: ${result.reviewedContexts} qualified contexts; ${result.historicalContexts} unchanged historical contexts remain unreviewed.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
