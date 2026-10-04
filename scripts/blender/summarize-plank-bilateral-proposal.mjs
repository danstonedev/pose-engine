/** Retain bounded default setup-branch outcome and actual Blender comparison. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [workspace, output] = process.argv.slice(2);
if (!output) throw Error('Workspace and fresh output required');
const sha = value => createHash('sha256').update(value).digest('hex');
const file = path => readFileSync(resolve(workspace, path)), load = path => JSON.parse(file(path));
const folder = 'blender-workspace/halfway-trunkpushup-bilateral-proposal-1/';
const proposalPath = 'remaining-batches/halfway-trunkpushup-prior-probe-10.json', referencePath = 'remaining-batches/halfway-trunkpushup-skin-candidate-1.json';
const proposal = load(proposalPath), reference = load(referencePath), source = load('remaining-batches/halfway-trunkpushup-source-eligibility-1.json');
const manifest = load(folder + 'manifest.json'), exchange = load(folder + 'full-motion-exchange.json'), roundtrip = load(folder + 'roundtrip-results.json'), skin = load(folder + 'skin-floor-clearance-1.json');
const coreScript = 'simmove/pose-engine/scripts/blender/audit-plank-preparation-prior.ts';
if (proposal.scriptSha256 !== sha(file(coreScript))) throw Error('Candidate script no longer matches saved run');
const magnitude = vector => Math.hypot(...vector);
const elbowError = frame => magnitude(frame.mirroredElbowDifferenceM ?? frame.positions.L_Forearm.map((value, axis) => axis === 0 ? value + frame.positions.R_Forearm[axis] : value - frame.positions.R_Forearm[axis]));
const worstElbow = frames => frames.reduce((worst, frame) => elbowError(frame) > worst.errorM ? { tMs: frame.tMs, errorM: elbowError(frame) } : worst, { tMs: 0, errorM: -Infinity });
const rows = proposal.cases.map(row => {
  const before = reference.cases.find(entry => entry.variant === row.variant), first = row.frames[0], last = row.frames.at(-1), peak = row.frames.find(frame => Math.abs(frame.tMs - 2500) < .001);
  const blend = skin.cases.find(entry => entry.id === row.variant + '-trunk-bilateral-proposal').planes.find(plane => plane.label === 'world-zero');
  const allBreachedFields = [...new Set(row.frames.flatMap(frame => frame.breaches.map(breach => breach.joint + '.' + breach.field)))];
  const beforeBreachedFields = [...new Set(before.clinicalBreaches.map(breach => breach.joint + '.' + breach.field))];
  const exclusions = /^(?:[LR]_(?:Shoulder|UpperArm|Forearm|Hand|Thumb|Index|Mid|Ring|Pinky))/;
  const joints = Object.keys(first.angles).filter(joint => !exclusions.test(joint));
  return {
    variant: row.variant, assetSha256: row.assetSha256, sampleCount: row.sampleCount,
    setupMirroredElbowErrorMm: { before: elbowError(before.frames[0]) * 1000, after: elbowError(first) * 1000 },
    fullPathMaximumMirroredElbowError: { before: worstElbow(before.frames), after: worstElbow(row.frames) },
    bottomElbowsDeg: { L: first.angles.L_Forearm.elbowFlexion, R: first.angles.R_Forearm.elbowFlexion },
    topElbowsDeg: { L: peak.angles.L_Forearm.elbowFlexion, R: peak.angles.R_Forearm.elbowFlexion },
    bottomGirdles: { L: first.angles.L_Shoulder, R: first.angles.R_Shoulder }, topGirdles: { L: peak.angles.L_Shoulder, R: peak.angles.R_Shoulder },
    runtimeWorstSkinPenetrationMm: Math.max(0, -row.worstSkinM) * 1000,
    blenderWorstSkinPenetrationMm: Math.max(0, -Math.min(...Object.values(blend.regions).map(region => region.worst.clearanceM))) * 1000,
    allBlenderRegionMinimaM: Object.fromEntries(Object.entries(blend.regions).map(([region, data]) => [region, data.worst])),
    maxFixedPalmWristDriftMm: row.maxPalmDriftM * 1000,
    allBreachedFields, newBreachedFields: allBreachedFields.filter(field => !beforeBreachedFields.includes(field)), focusedClinicalBreachCount: row.focusedBreaches.length,
    rootLoopPositionErrorM: magnitude(first.root.translateM.map((value, axis) => value - last.root.translateM[axis])),
    rootLoopAngleErrorRadians: 2 * Math.acos(Math.min(1, Math.abs(first.root.orientQuat.reduce((sum, value, axis) => sum + value * last.root.orientQuat[axis], 0)))),
    returnedElbowPositionDifferenceM: Math.max(...['L_Forearm', 'R_Forearm'].map(key => magnitude(first.bones[key].map((value, axis) => value - last.bones[key][axis])))),
    unchangedHeadSpinePelvisLowerChainMaxReadoutDeltaDeg: Math.max(...row.frames.flatMap((frame, index) => joints.flatMap(joint => Object.entries(frame.angles[joint]).map(([field, value]) => Math.abs(value - before.frames[index].angles[joint][field]))))),
  };
});
const paths = [proposalPath, referencePath, coreScript, 'remaining-batches/halfway-trunkpushup-source-eligibility-1.json',
  'simmove/pose-engine/scripts/blender/export-plank-prior-review.ts', 'simmove/pose-engine/scripts/blender/audit-plank-setup-source.ts',
  'simmove/pose-engine/scripts/blender/build-plank-bilateral-sheets.mjs', 'simmove/pose-engine/scripts/blender/summarize-plank-bilateral-proposal.mjs',
  ...['manifest.json', 'full-motion-review.blend', 'full-motion-exchange.json', 'roundtrip-results.json', 'skin-floor-clearance-1.json', 'comparison-sheets.json'].map(name => folder + name),
  ...['male', 'female', 'neutral'].flatMap(body => ['overhead', 'side'].map(view => folder + body + '-' + view + '-comparison.png'))];
const report = { version: 1, kind: 'bounded-default-trunk-bilateral-setup-proposal',
  runtimeMutation: false, masterMutation: false, criteria: proposal.criteriaBeforeRun,
  scope: 'Isolated default recipe experiment, exact dense saved-locals export, actual Blender full-body review/skin and unchanged exchange checks. Runtime integration, patient scenarios, live hosts and native tracking remain parent-owned and unqualified here.',
  cause: [
    'Identical authored bilateral girdle targets enter first palm setup solves without a posture prior; independent bounded arm solves select distinct elbow/girdle branches.',
    'The prepared path then captures each already-solved elbow radial direction and weakly regularizes near its own independent branch.',
    'A feasible mirrored cold setup seed can be driven away by running the pole selector again; primary-only contact/ROM refinement retains that shared branch.',
    'Reflecting the Hand rest-frame delta also creates a false 10–12 degree target-orientation mismatch. Preserve its original measured target orientation directly.'
  ],
  minimalCandidateProcedure: [
    'Explicit trunk-only default bilateral setup intent; paired identical palm layout and source controls, common girdle parent, no inherited palm contact, no explicit patient constraints.',
    'Capture authored source world rotations. Solve the left setup contact normally.',
    'Reflect solved-minus-source world rotation deltas for Shoulder, UpperArm and Forearm into the right source pose. This experiment uses world X because this bounded source has zero yaw; integration must use the shared authored parent basis.',
    'Set right Hand world orientation to its unchanged existing targetOrientation. Convert the resulting four world rotations into parent-relative locals in proximal order.',
    'Use these feasible locals as the right posturePrior, omit elbowDirection and elbowFlexionRadians for this one existing primary palm/ROM refinement; target position/orientation, limits and tolerances remain unchanged.',
    'Continue original supportedSetupBends, per-arm bounded prepared guide and exact-time playback. Do not enforce bilateral equality in later patient or asymmetric contexts.'
  ],
  sourceEligibility: { sameExplicitSetupTargets: source.sameExplicitBilateralSetupTargets, samePalmLayout: source.samePalmLayout,
    cases: source.cases.map(row => ({ variant: row.variant, sharedParent: row.sharedGirdleParent, parent: row.parent, pairs: row.pair })) },
  exactReplay: { allCases: manifest.cases.map(row => ({ id: row.id, frames: row.frames, bones: row.boneCount, maxCanonicalReplayErrorM: row.maxCanonicalReplayErrorM })),
    blenderVersion: exchange.blenderVersion, exchangeToleranceM: exchange.toleranceM, allBlenderExchangePassed: exchange.cases.every(row => row.passed),
    allRoundtripPassed: roundtrip.cases.every(row => row.passed), roundtripToleranceM: roundtrip.toleranceM },
  cases: rows,
  rejectedExperiments: [
    { report: 'remaining-batches/halfway-trunkpushup-prior-probe-1.json', reason: 'Initial authored/girdle priors retain large positional asymmetry; throughout-guide raw girdle prior creates new shoulder-adduction breach.' },
    { report: 'remaining-batches/halfway-trunkpushup-prior-probe-5.json', reason: 'Initial mirrored seed with pole selector rerun stays numerically bounded but visibly diverges on male/female.' },
    { report: 'remaining-batches/halfway-trunkpushup-prior-probe-9.json', reason: 'Throughout-guide mirror/primary-only alternative worsens top elbow straightening; only setup-only candidate is proposed.' },
  ],
  remaining: [
    'Residual top/transition girdle and elbow positional asymmetry remains. At mirrored top with original palm target, right wrist readout requests roughly 73.5–74.1 degree extension, exceeding the unchanged 70 degree capacity; the candidate preserves bounded independent continuation.',
    'Inherited bilateral Thumb1 negative rest readout remains unchanged and is recorded as a breach, not waived.',
    'Process-local experiment explicitly bypasses nonempty patient constraints. Inherited-contact and patient delivery parity require integration tests; this report does not establish them.',
    'Native tracking is still failed per parent review; changed motion must receive fresh native evidence. No stale forces/deformation or clinical acceptance are attached.'
  ],
  artifactHashes: Object.fromEntries(paths.map(path => [path, sha(file(path))])),
};
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sha256: sha(readFileSync(output)), exchangePassed: report.exactReplay.allBlenderExchangePassed, roundtripPassed: report.exactReplay.allRoundtripPassed,
  cases: rows.map(row => ({ variant: row.variant, setupErrorMm: row.setupMirroredElbowErrorMm.after, skinMm: row.blenderWorstSkinPenetrationMm, driftMm: row.maxFixedPalmWristDriftMm, newBreaches: row.newBreachedFields })) }));
