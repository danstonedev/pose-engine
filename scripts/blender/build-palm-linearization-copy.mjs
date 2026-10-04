import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sourcePath = new URL('../../src/services/handContactPose.ts', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
let copy = source.replaceAll("from './", "from '../../src/services/");
copy = copy.replace('const currentMatrixReadback =', 'export const linearizationReuseStatistics = { built: 0, reused: 0 };\nconst currentMatrixReadback =');
copy = copy.replace("  let stopReason: HandContactSolveResult['stopReason'] = 'iteration-limit';", `  let stopReason: HandContactSolveResult['stopReason'] = 'iteration-limit';
  let linearization: { pose: THREE.Quaternion[]; raw: number[][]; rotations: number[][]; feasible: number[][]; atBoundary: boolean } | null = null;`);
copy = copy.replace('    const rawColumns: number[][] = [];', '    let rawColumns: number[][] = [];')
  .replace('    const feasibleColumns: number[][] = [], feasibleRotations: number[][] = [];', '    let feasibleColumns: number[][] = [], feasibleRotations: number[][] = [];');
const start = copy.indexOf('    for (let joint = 0; joint < bones.length; joint += 1) for (const axis of axes)');
const end = copy.indexOf('    // Damped least squares in residual coordinates', start);
if (start < 0 || end < start) throw Error('Linearization block not found');
copy = copy.slice(0, start) + `    if (useCurrentMatrices && linearization && before.every((q, i) => q.equals(linearization!.pose[i]!))) {
      rawColumns = linearization.raw; feasibleRotations = linearization.rotations;
      feasibleColumns = linearization.feasible; atBoundary = linearization.atBoundary;
      linearizationReuseStatistics.reused++;
    } else {
      linearizationReuseStatistics.built++;
` + copy.slice(start, end) + `      if (useCurrentMatrices) linearization = { pose: before, raw: rawColumns, rotations: feasibleRotations, feasible: feasibleColumns, atBoundary };
    }
` + copy.slice(end);
const target = new URL('./captured-palm-linearization-reuse.ts', import.meta.url);
writeFileSync(target, copy, { flag: 'wx' });
let audit = readFileSync(new URL('./audit-current-palm-work-full.ts', import.meta.url), 'utf8');
audit = audit.replace("import { solveHandContactPose as candidate } from './captured-current-perf-combined';", "import { solveHandContactPose as candidate, linearizationReuseStatistics } from './captured-palm-linearization-reuse';")
  .replaceAll('captured-current-perf-combined.ts', 'captured-palm-linearization-reuse.ts')
  .replace("  report.after = identity();", "  report.linearizationReuseStatistics = linearizationReuseStatistics;\n  report.after = identity();")
  .replace("Candidate differs only in same-order dot loops/symmetric Gram plus current-matrix hinge reads on the existing private graph, with exact all101 local/world and result comparison.", "Candidate differs only by retaining an identical exact-quaternion linearization within one guarded solve across rejected steps. Every physical input is constant for that invocation; damping alone changes. All101 local/world and solver results compare exactly.");
const auditPath = new URL('./audit-palm-linearization-full.ts', import.meta.url);
writeFileSync(auditPath, audit, { flag: 'wx' });
const hash = value => createHash('sha256').update(value).digest('hex');
writeFileSync(new URL('../../../../remaining-batches/pressup-linearization-copy-1.json', import.meta.url), JSON.stringify({
  createdAtUtc: new Date().toISOString(), original: sourcePath.href, originalSha256: hash(source),
  candidate: target.href, candidateSha256: hash(copy), audit: auditPath.href, auditSha256: hash(audit),
  scope: 'Offline per-invocation exact-state derivative reuse only on existing guarded private graph. No source mutation or solver tolerance/objective/iteration changes.'
}, null, 2) + '\n', { flag: 'wx' });
