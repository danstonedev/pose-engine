import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Run from pose-engine. Raw development reports remain immutable beside the
// workspace shipment records; this compact record can be linked by the master.
const raw = '../../remaining-batches/';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = path => {
  const bytes = readFileSync(path);
  return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
};
const json = name => JSON.parse(read(raw + name));
const reference = name => ({ path: raw + name, sha256: sha(raw + name) });
const provenance = (name, report) => ({ ...reference(name), sourceStable: report.sourceStable,
  sourceBefore: report.before ?? report.sourceBefore, sourceAfter: report.after ?? report.sourceAfter });
const baseline = json('pressup-default-hinge-readout-1.json');
const intersection = json('pressup-hinge-projection-intersection-1.json');
const scalar = json('pressup-hinge-projection-scalar-1.json');
const wrap = json('pressup-hinge-projection-wrap-1.json');
const lowerBefore = json('pressup-prone-knee-projection-1.json');
const lowerAfter = json('pressup-prone-knee-projection-2.json');
const key = row => [row.variant, row.key, row.mode, row.sign, row.offSign].join('/');
const bounds = value => ({ flexion: value.flexionViolation, deviation: value.deviationViolation,
  engineeringTwist: value.twistViolation });
const firstFinal = row => ({
  firstErrorDeg: bounds(row.passes[0].afterLocal),
  finalErrorDeg: bounds(row.passes.at(-1).afterMeasured),
  firstCorrectionDeg: row.passes[0].localTurnDeg,
  repeatDriftDeg: Math.max(...row.passes.map(p => p.measuredTurnDeg), ...row.passes.slice(1).map(p => p.localTurnDeg)),
  finalCombinedDriftDeg: row.passes.at(-1).combinedTurnDeg,
});
const priorByKey = new Map(intersection.cases.map(row => [key(row), row]));
const gate = json('pressup-original-patient-gate-6.source.json');
const gateBefore = new Map(gate.before.map(row => [row.path, row.sha256]));
const changedFiles = gate.after.filter(row => gateBefore.get(row.path) !== row.sha256).map(row => ({
  path: row.path.replaceAll('\\', '/').split('/pose-engine/')[1],
  beforeSha256: gateBefore.get(row.path), afterSha256: row.sha256,
}));
const gateTimes = [...read(raw + 'pressup-original-patient-gate-6.log').matchAll(/(male|female|neutral) Blender-authored floor supports > honors patient wrist and elbow bounds throughout the skin-supported press-up, including cached playback (\d+)ms/g)]
  .map(match => ({ variant: match[1], elapsedMs: Number(match[2]), result: 'timeout' }));
const sourcePaths = ['src/services/poseRomClamp.ts', 'src/services/handContactPose.ts',
  'src/services/proneSkinSupport.ts', 'src/services/jointAngles.ts', 'src/services/romConstraints.ts',
  'src/services/romRegistry.ts', 'src/__tests__/measuredHingeRom.test.ts',
  'src/__tests__/proneSkinSupportHingeBounds.test.ts'];
const test = (name, result, scope, command) => ({ ...reference(name), result, scope, command });
const report = {
  schemaVersion: 1,
  generatedAtUtc: new Date().toISOString(),
  scope: 'Shared contact hinge flexion coordinate ownership correction, including proven lower-support knee call site. This is scoped implementation evidence, not movement acceptance or defect closure.',
  movement: { id: 'screen:fms-repo-legacy-v1/trunk-stability-push-up/extension-clearing', variants: ['male', 'female', 'neutral'],
    sides: ['L', 'R'], phases: ['setup', 'motion', 'hold', 'return', 'loop'],
    applicability: 'Shared hinge projector tests both elbows and both knees. Historical motion failure is the press-up setup; lower-helper cases isolate support from arm solving.' },
  correction: {
    oldFailure: 'The local swing flexion clamp and geometric hinge readout used different frames. Chaining two flexion projectors also changed off-axis fields and cycled for locked patient flexion.',
    ownership: 'clampContactHingeToRom owns geometric flexion once. It clamps existing local deviation/engineering twist, preserves those bounded coordinates, then solves the remaining local flexion scalar against the actual geometric readout.',
    defaultBehavior: 'Legacy interactive clamp and explicit-patient-only wrapper are unchanged. Only arm contact hinges and demonstrated prone-support knee projection use the new sole-owner contact function.',
    limits: 'Registry, patient ranges, physical/contact gates, DLS settings and test timeouts unchanged.',
    scalarScope: 'Maximum eight secant updates on one scalar; output boolean means pose changed, not convergence. All listed diagnostics inspect actual final residuals.'
  },
  sourceAtSummary: Object.fromEntries(sourcePaths.map(path => [path, sha(path)])),
  modelIdentities: Object.fromEntries(['male', 'female', 'neutral'].map(variant => {
    const path = `models/painmap3D_${variant}.runtime.glb`; return [variant, { path, sha256: sha(path) }];
  })),
  historicalReadout: {
    provenance: provenance('pressup-default-hinge-readout-1.json', baseline),
    cases: baseline.cases.map(row => ({ variant: row.variant, frames: row.frames,
      inputPath: row.inputPath, inputSha256: row.inputSha256, modelSha256: row.modelSha256,
      maximumWorldReplayErrorM: row.maximumWorldReplayErrorM,
      maximumSavedReadoutDifferenceDeg: row.maximumSavedReadoutDifferenceDeg,
      maximumViolationDeg: row.maximumViolationDeg, violatingArmFrames: row.violations.length,
      setup: row.setup,
    })),
  },
  sequentialProjectorRejected: { provenance: provenance('pressup-hinge-projection-intersection-1.json', intersection), summary: intersection.summary },
  scalarProjection: {
    provenance: provenance('pressup-hinge-projection-scalar-1.json', scalar), summary: scalar.summary,
    cases: scalar.cases.map(row => ({ case: key(row), range: row.range,
      rejectedSequential: firstFinal(priorByKey.get(key(row))), soleOwner: firstFinal(row) })),
  },
  angularWrap: {
    provenance: provenance('pressup-hinge-projection-wrap-1.json', wrap),
    scope: '432 actual-rig cases: authored ±179, ±179.999, ±180.001 degrees, coupled deviation ±12 and rotation ±35; both elbows/knees, all3 bodies, default/ranged/locked40.',
    summary: wrap.summary,
    cases: wrap.cases.map(row => ({ case: [row.variant, row.key, row.mode, row.authoredDeg, row.offSign].join('/'), ...firstFinal(row) })),
  },
  lowerSupport: {
    beforeProvenance: provenance('pressup-prone-knee-projection-1.json', lowerBefore),
    afterProvenance: provenance('pressup-prone-knee-projection-2.json', lowerAfter),
    cases: lowerAfter.cases.map(row => {
      const old = lowerBefore.cases.find(old => old.variant === row.variant && old.mode === row.mode);
      return { variant: row.variant, mode: row.mode, previousActual: old.after, correctedActual: row.after,
        previousReasons: old.result.reasons, correctedReasons: row.result.reasons,
        feasible: row.result.feasible, exactRepeatPose: row.exactRepeatPose,
        repeated: row.repeated };
    }),
    limitation: 'Deliberately unreachable lower-support cases remain infeasible and their repeated whole poses may differ. Only normally feasible cases were exact repeat fixed points; bound compliance does not prove support feasibility.'
  },
  verification: [
    test('pressup-contact-hinge-scalar-contracts-1.log', '57 passed', 'Sole-owner hinge, contact refinement, continuous projection and girdle contracts before the lower knee call-site switch.',
      'node ../node_modules/vitest/vitest.mjs run src/__tests__/measuredHingeRom.test.ts src/__tests__/preparedPalmRefinement.test.ts src/__tests__/continuousRomProjection.test.ts src/__tests__/handContactGirdle.test.ts --maxWorkers=1 --minWorkers=1'),
    test('pressup-contact-knee-contracts-1.log', '9 passed', 'New default/locked knee regressions on all3 bodies; existing helper and975-frame integrated skin/lower-support tests.',
      'node ../node_modules/vitest/vitest.mjs run src/__tests__/proneSkinSupportHingeBounds.test.ts src/__tests__/proneSkinSupport.test.ts src/__tests__/proneSkinSupportIntegration.test.ts --maxWorkers=1 --minWorkers=1'),
    test('pressup-contact-hinge-check-2.log', '2 test typing errors retained', 'Missing nullable-range narrowing in new assertion; subsequently corrected explicitly.', null),
    test('pressup-contact-hinge-check-3.log', '0 errors, 0 warnings', 'Current engine TypeScript/Svelte check after explicit assertion guard.',
      'node ../node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json'),
  ],
  originalPatientGate: {
    log: reference('pressup-original-patient-gate-6.log'), identities: reference('pressup-original-patient-gate-6.source.json'),
    command: "node ../node_modules/vitest/vitest.mjs run src/__tests__/floorPalmSupports.test.ts -t 'honors patient wrist and elbow bounds throughout the skin-supported press-up, including cached playback' --maxWorkers=1 --minWorkers=1",
    timeoutMs: 5000, romClamp: 'off (existing test beforeEach)', startedUtc: gate.startedUtc, finishedUtc: gate.finishedUtc,
    result: 'All3 timed out; performance release gate remains failed.', cases: gateTimes,
    sourceStable: gate.sourceStable, changedFiles,
    limitation: 'Full source changed during capture in the two listed pain-response files. Contact/lower controllers were unchanged; retain as failed diagnostic, not a stable whole-source qualification.'
  },
  productionSensitivity: ['pressup-production-hinge-default-1.json', 'pressup-production-hinge-setup-1.json'].map(name => {
    const r = json(name); return { provenance: provenance(name, r), scope: r.scope, passed: r.passed, cases: r.cases };
  }),
  acceptance: {
    movementAccepted: false, defectClosed: false,
    remaining: [
      'Restricted-patient setup numerical sensitivity remains outside the existing pose-agreement gate, despite bound compliance. Contact owner is investigating saved-state convergence.',
      'The unchanged5000ms combined patient regression remains failed.',
      'Full current-source motion, both-host parity, Blender ROM-off visual/skin review and native tracking remain separate required gates. The scalar and lower-body tests do not establish them.',
      'Current sole-owner and lower-knee runtime changes require a final host synchronization before browser acceptance.'
    ]
  }
};
const output = process.argv[2] ?? 'docs/evidence/pressup-hinge-constraint-2026-10-02.json';
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sha256: sha(output), scalarCases: scalar.cases.length, wrapCases: wrap.cases.length,
  lowerCases: lowerAfter.cases.length, patientGateCases: gateTimes, movementAccepted: false }));
