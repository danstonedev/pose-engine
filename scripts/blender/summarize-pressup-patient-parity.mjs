import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const [batchDirectory, output] = process.argv.slice(2);
if (!batchDirectory || !output) throw new Error('Supply remaining-batches directory and fresh summary path.');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const source = name => {
  const bytes = readFileSync(resolve(batchDirectory, name));
  return { path: `remaining-batches/${name}`, sha256: sha256(bytes), data: JSON.parse(bytes) };
};
const host = source('pressup-clinical-cone-host-geometry-1/results.json');
const geometry = source('pressup-clinical-cone-patient-geometry-2.json');
const originalMatrix = source('pressup-clinical-cone-host-parity-1/results.json');
const experiment = source('pressup-initial-prior-host-matrix-1/results.json');
const changedDefault = source('pressup-initial-prior-default-change-1.json');
const row = host.data.cases[0];
const artifact = ({ path, sha256 }) => ({ path, sha256 });
const millimeters = value => value * 1000;
const phases = geometry.data.cases.map((observed, index) => {
  const sample = row.samples[index];
  if (sample.tMs !== observed.tMs) throw new Error('Phase order mismatch.');
  const measuredPatientFields = Object.entries(row.setup.persistedConstraints).flatMap(([joint, fields]) =>
    Object.entries(fields).map(([field, constraint]) => {
      const range = constraint.availableRange;
      const expected = sample.expectedAngles[joint][field], actual = sample.actualAngles[joint][field];
      return { joint, field, rangeDegrees: range, expectedDegrees: expected, actualDegrees: actual,
        strictMaximumOverageDegrees: Math.max(0, range.min - expected, expected - range.max, range.min - actual, actual - range.max) };
    }));
  return {
    tMs: sample.tMs,
    maximumLocalRotation: observed.originalLocalDifference,
    maximumBoneOriginDifferenceMm: millimeters(Math.max(...observed.boneDifferences.map(value => value.meters))),
    maximumSkinDifferenceMm: millimeters(observed.allSkinMaximum.meters),
    maximumHandSkinDifferenceMm: Object.fromEntries(['L', 'R'].map(side => [side, millimeters(observed.regionMaximum[`${side}_handSkin`].meters)])),
    maximumPalmSkinDifferenceMm: Object.fromEntries(['L', 'R'].map(side => [side, millimeters(observed.regionMaximum[`${side}_palmSkin`].meters)])),
    expectedHandSkinFloorMinimumMm: Object.fromEntries(['L', 'R'].map(side => [side, millimeters(observed.expectedFloorMinima[`${side}_handSkin`].y)])),
    actualHandSkinFloorMinimumMm: Object.fromEntries(['L', 'R'].map(side => [side, millimeters(observed.actualFloorMinima[`${side}_handSkin`].y)])),
    expectedPalmSkinFloorMinimumMm: Object.fromEntries(['L', 'R'].map(side => [side, millimeters(observed.expectedFloorMinima[`${side}_palmSkin`].y)])),
    actualPalmSkinFloorMinimumMm: Object.fromEntries(['L', 'R'].map(side => [side, millimeters(observed.actualFloorMinima[`${side}_palmSkin`].y)])),
    rootDifferenceM: sample.rootDifferenceM,
    measuredPatientFields,
    patientViolationsAtExistingPointZeroFiveDegreeTolerance: observed.patientBoundViolations,
    lowerSupportFeasible: sample.support.feasible,
    endpointReached: sample.layout.endpointReached,
    unsupportedReasons: [...sample.support.reasons, ...sample.layout.reasons],
  };
});
const result = {
  schemaVersion: 1, date: '2026-10-02',
  scope: 'Seven retained male severe-patient browser checkpoints; all captured expected/live poses continued after the original parity failure. No production source, clinical limits or acceptance thresholds changed. Current user-approved default motion is preserved.',
  decision: 'Initial-prior experiment rejected: it improves parity but materially changes the approved default. Current severe-patient mismatch is retained as an unsupported-case delivery difference, not physical motion approval. Acceptance policy remains with the parent release review.',
  sourceIdentity: { hostRuntimeStable: host.data.runtimeStable, handSolverSha256: host.data.before.simmove['services/handContactPose.ts'], assetSha256: geometry.data.assetSha256,
    poseModeClampEnabled: row.setup.poseModeClampEnabled, geometryScriptSha256: geometry.data.scriptSha256, summaryScriptSha256: sha256(readFileSync(new URL(import.meta.url))) },
  replay: { qualified: geometry.data.replayQualified, reconstructedBones: geometry.data.cases[0].boneCount,
    capturedMappedLocals: Object.keys(row.samples[0].actualFrame.pose.bones).length,
    capturedBoneWorldWitnessesPerFrame: geometry.data.cases[0].replayWorldWitnessCount,
    maximumWorldWitnessErrorM: Math.max(...geometry.data.cases.flatMap(value => [value.expectedBoneReplayResidualM, value.actualBoneReplayResidualM])),
    scope: geometry.data.scope, regionMembership: geometry.data.regions, floorY: 0 },
  currentBrowserMatrix: { ...artifact(originalMatrix), runtimeStable: originalMatrix.data.runtimeStable,
    total: originalMatrix.data.cases.length, passed: originalMatrix.data.cases.filter(value => value.pass).length,
    failures: originalMatrix.data.cases.filter(value => !value.pass).map(value => ({ host: value.host, variant: value.variant, scenario: value.scenario, failure: value.failure })) },
  existingParityGates: { localRotationDegrees: .01, worldTrackM: .0001, status: 'Unchanged; failed checkpoints remain failed.' },
  clinicalScope: 'Both expected and actual six explicit patient fields checked at every checkpoint: bilateral elbow flexion, wrist flexion, locked knee flexion. This is not an all-field clinical requalification.',
  phases,
  findings: [
    'At 1800 ms the local forearm rotation difference is 0.26808 degrees, while maximum actual skin displacement is 0.146622 mm and right hand skin displacement is 0.028025 mm.',
    'At 4800 ms the maximum tracked/bone origin difference is 0.133224 mm, above the existing 0.1 mm parity criterion; maximum skin displacement is 0.145149 mm. This remains a recorded failure.',
    'All six explicit patient fields remain within the existing 0.05-degree checking tolerance; strict numerical overages are separately recorded.',
    'Absolute support is invalid in both paths: setup/return right hand skin is about 180.64 mm below world-zero, and lower support is explicitly infeasible throughout. Tiny between-path displacement does not validate that patient motion.',
    'No new solver experiment or visible default-motion change follows this report.'
  ],
  rejectedInitialPriorExperiment: {
    promoted: false, policyChange: 'Supply the initial projected arm pose as a posture prior to formerly no-prior solves on the guarded calculation graph.',
    experimentalSolverSha256: experiment.data.experimentalSolverSha256,
    browserMatrix: { ...artifact(experiment), runtimeStable: experiment.data.runtimeStable,
      passed: experiment.data.cases.filter(value => value.pass).length, total: experiment.data.cases.length,
      scope: 'simMOVE only, all three bodies and default/feasible/severe patient scenarios; process-local module override.' },
    defaultComparison: { ...artifact(changedDefault), sourceStable: changedDefault.data.sourceStable,
      cases: changedDefault.data.cases.map(value => ({ variant: value.variant, maximumLocalRotation: value.maximumRotation, maximumWorldTrackDifferenceMm: millimeters(value.maximumPosition.meters), positionWitness: value.maximumPosition })) },
    rejectionReason: 'Default local rotations move 15–27 degrees and body landmarks 31–47 mm. The user requested the approved appearance remain stable.'
  },
  artifacts: [artifact(host), artifact(geometry)],
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ phases: phases.length, replayQualified: result.replay.qualified, sourceStable: host.data.runtimeStable,
  maximumStrictPatientOverageDegrees: Math.max(...phases.flatMap(value => value.measuredPatientFields.map(field => field.strictMaximumOverageDegrees))) }));
