/** Compact bounded trunk candidate witness from retained reports, without reruns.
 * node THIS <movement-realism-implementation-folder> <new-summary.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [workspace, output] = process.argv.slice(2);
if (!output) throw Error('Workspace and new output required');
const hash = data => createHash('sha256').update(data).digest('hex');
const load = path => JSON.parse(readFileSync(resolve(workspace, path), 'utf8'));
const candidatePath = 'remaining-batches/halfway-trunkpushup-skin-candidate-1.json';
const comparisonPath = 'remaining-batches/halfway-trunkpushup-clinical-comparison-2.json';
const baselinePath = 'blender-workspace/halfway-trunkpushup-baseline-1/skin-floor-clearance-world-1.json';
const candidate = load(candidatePath), comparison = load(comparisonPath), baseline = load(baselinePath);
const files = [candidatePath, comparisonPath, baselinePath,
  'remaining-batches/halfway-trunkpushup-baseline-1.json',
  'blender-workspace/halfway-trunkpushup-baseline-1/manifest.json',
  'simmove/pose-engine/scripts/blender/audit-plank-skin-candidate.ts',
  'simmove/pose-engine/scripts/blender/audit-retained-plank-clinical.ts',
  'simmove/pose-engine/scripts/blender/summarize-plank-skin-candidate.mjs'];
const extent = values => ({ min: Math.min(...values), max: Math.max(...values) });
const mm = value => value * 1000;
const report = {
  version: 1, kind: 'bounded-trunk-skin-support-summary',
  decision: 'Original 76 degree top is feasible with existing bounded measured-palm solver and geometric toe-skin root support. No pitch planner or body-specific pitch table is needed.',
  scope: 'Read-only in-memory recipe probe, all three production rigs, whole 169-frame 30 Hz chapter including setup/top/return, render-time helper twist and every production skin vertex. Baseline full-skin measurement used actual Blender 5.2.2. Updated candidate is evaluated runtime geometry; fresh Blender/native/host review and clinical signoff remain separate.',
  runtimeMutation: false, masterMutation: false,
  cloneOnlyChanges: { supportPlaneY: 0, plankSkinSupport: true, bothPalmSupportSurface: 'skin' },
  unchanged: ['original 76 degree top pitch', 'all authored poses and durations', 'fixed palm layout X/Z', 'clinical joint capacity registry'],
  sourceDigest: candidate.sourceDigest, sourceStable: candidate.sourceStable,
  criteria: candidate.criteriaBeforeRun,
  additionalParentCriterion: 'Also passes parent predeclared 1 mm full-skin limit; this summary does not replace or loosen stored criteria.',
  fileHashes: Object.fromEntries(files.map(path => [path, hash(readFileSync(resolve(workspace, path)))])),
  rejectedDiagnostics: [{ path: 'remaining-batches/halfway-trunkpushup-clinical-comparison-1.json', reason: 'First retained-export readout omitted sampler root/pelvis reference rotations, falsely treating world root pitch as pelvic tilt. Superseded by comparison-2, whose three-clock parity is below 0.00000632 degree.' }],
  cases: candidate.cases.map(row => {
    const old = baseline.cases.find(item => item.variant === row.variant).planes.find(item => item.label === 'world-zero');
    const clinical = comparison.cases.find(item => item.variant === row.variant);
    const currentMinimum = Math.min(...Object.values(row.worstSkin).map(item => item.clearanceM));
    const toeXZ = Object.fromEntries(['L', 'R'].map(side => {
      const key = side + '_Toes', anchor = row.frames[0].positions[key];
      return [side, mm(Math.max(...row.frames.map(frame => Math.hypot(frame.positions[key][0] - anchor[0], frame.positions[key][2] - anchor[2]))))];
    }));
    const unchangedChainKeys = Object.keys(row.frames[0].angles).filter(key => !/^([LR]_(Shoulder|UpperArm|Forearm|Hand)|[LR]_(Thumb|Index|Mid|Ring|Pinky))/.test(key));
    const unchangedChainReadoutMaxDeltaDeg = Math.max(...row.frames.flatMap((frame, index) => unchangedChainKeys.flatMap(joint => Object.entries(frame.angles[joint]).map(([field, value]) => Math.abs(value - clinical.frames[index].angles[joint][field])))));
    return {
      variant: row.variant, sourceModelSha256: row.assetSha256, sampleCount: row.sampleCount, topPitchDeg: row.pitch,
      baselineWorstPenetrationMm: mm(Math.max(0, -Math.min(...Object.values(old.regions).map(item => item.worst.clearanceM)))),
      updatedWorstPenetrationMm: mm(Math.max(0, -currentMinimum)),
      passesStored2mmFullSkinCriterion: row.firstSkinFailure === null,
      passesParent1mmFullSkinCriterion: currentMinimum >= -.001,
      maxPalmWristDriftMm: mm(row.maxPalmDriftM), maxPalmOrientationDriftDeg: THREEradToDeg(row.maxPalmOrientationDriftRadians),
      rootTranslationRangeMm: { x: extent(row.frames.map(frame => mm(frame.root.translateM[0]))), y: extent(row.frames.map(frame => mm(frame.root.translateM[1]))), z: extent(row.frames.map(frame => mm(frame.root.translateM[2]))) },
      rootLoopPositionErrorMm: mm(row.rootLoopPositionErrorM), rootLoopAngleErrorDeg: THREEradToDeg(row.rootLoopAngleErrorRadians),
      toeBoneContactXZMaximumDriftMm: toeXZ,
      skinMinimumClearanceMm: Object.fromEntries(Object.entries(row.worstSkin).map(([region, item]) => [region, mm(item.clearanceM)])),
      top: row.peak,
      clinical: {
        toleranceDeg: comparison.boundToleranceDeg, newBreachedFields: clinical.newBreachedFields,
        focusedChainBreachCount: clinical.focusedChainBreachCount,
        inheritedBreachedFields: clinical.inheritedBreachedFields,
        beforeAndAfterBreachedFields: clinical.changes,
        retainedExportVsOriginalSamplerMaxAngleErrorDeg: Math.max(...clinical.parity.map(item => item.maxAngleDeltaDeg)),
        unchangedHeadSpinePelvisLowerChainMaxReadoutDifferenceDeg: unchangedChainReadoutMaxDeltaDeg,
      },
    };
  }),
  limitations: [
    'Thumb1 flexion is slightly negative in both retained baseline and candidate on every frame; candidate changes are only export float precision. The unchanged 0..85 degree registry bounds are retained and breaches are not waived.',
    'Left/right modeled clavicle girdle rotation asymmetry remains within current registry capacities. This is a clavicle proxy and does not establish independent anatomical SC/AC behavior.',
    'Root Z travel during plank pitch is rigid toe-pivot motion, not palm drift; root closes exactly and toe bone support X/Z drift remains below 0.0006 mm.',
    'Full-skin minima include fingers; toe-supported foot skin appropriately stays above the floor, rather than meeting dorsal-foot-rest contact.',
    'No updated Blender/native/clinical acceptance is implied by this runtime probe.'
  ],
};
function THREEradToDeg(value) { return value * 180 / Math.PI; }
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sha256: hash(readFileSync(output)), cases: report.cases.map(row => ({ variant: row.variant, penetrationMm: row.updatedWorstPenetrationMm, palmDriftMm: row.maxPalmWristDriftMm, newBreachedFields: row.clinical.newBreachedFields })) }));
