/** Actual-rig, browser-mode sensitivity to tiny authored elbow changes.
 * <fresh-report.json> [male|female|neutral|all]
 * Uses the existing playback-equivalence tolerances; no gate is relaxed.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
import * as Contact from '../../src/services/footContact';
import * as HandContact from '../../src/services/handContactPose';
import { solveHandContactPose as experimentalHandSolve } from './captured-hand-solver-coherent-hinge-posture-cone';

const [output, filter = 'neutral', witnessTimeArgument = '4516.666666666667', witnessHand = 'L_Hand', sampling = 'dense'] = process.argv.slice(2);
if (!output || !['male', 'female', 'neutral', 'all'].includes(filter)) throw Error('Provide fresh report path and optional body');
const witnessTimesMs = witnessTimeArgument.split(',').map(Number);
const witnessTimeMs = witnessTimesMs[0]!;
if (!witnessTimesMs.length || witnessTimesMs.some(time => !Number.isFinite(time)) || !['L_Hand', 'R_Hand'].includes(witnessHand) || !['dense', 'witness-only'].includes(sampling)) throw Error('Invalid witness options');
setRomClampEnabled(false);
const engine = fileURLToPath(new URL('../../', import.meta.url));
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(path, entry.name)) : [resolve(path, entry.name)]).sort();
const digest = () => hash(files(resolve(engine, 'src')).map(path => relative(engine, path).replaceAll('\\', '/') + ':' + hash(readFileSync(path))).join('\n'));
const constraints = {};
const rotationTolerance = THREE.MathUtils.degToRad(.01);
// Read the final prepared guides without altering any solve or its inputs.
let currentGuides: any[] = [];
let currentWitnesses: any[] = [], playbackTime: number | undefined, preparationTime: number | undefined;
let currentSolveResults: any[] = [];
const descriptor = Object.getOwnPropertyDescriptor(Contact, 'preparePalmSupportApproach')!;
if (!descriptor.configurable) throw Error('ViteNode export instrumentation unavailable');
const prepare = Contact.preparePalmSupportApproach;
Object.defineProperty(Contact, 'preparePalmSupportApproach', { configurable: true, value: (...args: Parameters<typeof prepare>) => {
  const poseAt = args[4];
  const previousPreparationTime = preparationTime;
  args[4] = tMs => { preparationTime = tMs; return poseAt(tMs); };
  let result: ReturnType<typeof prepare>;
  try { result = prepare(...args); } finally { preparationTime = previousPreparationTime; }
  currentGuides.push(...args[0].filter(plant => plant.palmApproach?.path).map(plant => ({
    key: plant.solver.footKey, joints: plant.solver.ctx.canonicalKeys,
    path: plant.palmApproach!.path!.map(knot => ({ tMs: knot.tMs, quats: knot.quats.map(quat => quat.toArray()) })),
  })));
  return result;
} });
const stepDescriptor = Object.getOwnPropertyDescriptor(Contact, 'stepContactPlants')!;
const step = Contact.stepContactPlants;
Object.defineProperty(Contact, 'stepContactPlants', { configurable: true, value: (...args: Parameters<typeof step>) => {
  playbackTime = args[1];
  try { return step(...args); } finally { playbackTime = undefined; }
} });
const handDescriptor = Object.getOwnPropertyDescriptor(HandContact, 'solveHandContactPose')!;
const solveHand = experimentalHandSolve;
Object.defineProperty(HandContact, 'solveHandContactPose', { configurable: true, value: (...args: Parameters<typeof solveHand>) => {
  const solver = args[0];
  const effectiveTime = playbackTime ?? preparationTime;
  const invoke = () => {
    const result = solveHand(...args);
    currentSolveResults.push({ tMs: effectiveTime ?? null, key: solver.footKey,
      invocation: playbackTime == null ? 'guide preparation' : 'final playback refinement', result });
    return result;
  };
  if (effectiveTime == null || !witnessTimesMs.some(time => Math.abs(effectiveTime - time) <= .001) || solver.footKey !== witnessHand) return invoke();
  let root: THREE.Object3D = solver.ctx.bones.at(-1)!;
  while (root.parent) root = root.parent;
  const objects: any[] = [];
  const capture = (node: THREE.Object3D, path: number[]) => {
    objects.push({ path, name: node.name, type: node.type, position: node.position.toArray(), quaternion: node.quaternion.toArray(), scale: node.scale.toArray(), matrixAutoUpdate: node.matrixAutoUpdate, matrix: node.matrix.toArray() });
    node.children.forEach((child, index) => capture(child, [...path, index]));
  };
  capture(root, []);
  const witness: any = { tMs: effectiveTime, invocation: playbackTime == null ? 'guide preparation' : 'final playback refinement', canonicalKeys: solver.ctx.canonicalKeys,
    boneNames: solver.ctx.bones.map(bone => bone.name), objects, target: args[1].toArray(), orientation: args[2].toArray(),
    rest: structuredClone(args[3]), constraints: structuredClone(args[4]), elbowDirection: args[5]?.toArray(), minimumElbowY: args[6],
    elbowFlexionRadians: args[7], posturePrior: args[8]?.map(quat => quat.toArray()) };
  const result = invoke();
  witness.solveResult = result;
  witness.after = solver.ctx.bones.map(bone => bone.quaternion.toArray());
  currentWitnesses.push(witness);
  return result;
} });
const report: any = { experimentalSolver: { path: 'scripts/blender/captured-hand-solver-coherent-hinge-posture-cone.ts', sha256: hash(readFileSync(new URL('./captured-hand-solver-coherent-hinge-posture-cone.ts', import.meta.url))), scope: 'Process-local paired forearm/hand feasible directions only when a posture objective exists; no production promotion.' }, sourceBefore: digest(), scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), sampleHz: 60, globalRomClamp: false,
  controllerHashes: Object.fromEntries(['handContactPose', 'footContact', 'poseRomClamp', 'motionRecording', 'motionTrajectory'].map(name => [name,
    hash(readFileSync(resolve(engine, 'src/services', `${name}.ts`)))])), solverRuns: [],
  sampling, witnessTimeMs, witnessTimesMs, witnessHand,
  scope: 'Fresh rig for each run; all authored elbow target angles perturbed by ±5e-8 degrees under the unrestricted default scenario. This tests sensitivity, not attainable contact or movement acceptance.',
  tolerances: { rotationRadians: rotationTolerance, rotationDegrees: .01, trackedPositionM: .0001, provenance: 'Existing browser stage parity checks; stricter than floorPalmSupports rotational tolerance' }, cases: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  if (filter !== 'all' && filter !== variant) continue;
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  const runs = [];
  for (const deltaDeg of [0, -5e-8, 5e-8]) {
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    let skinned!: THREE.SkinnedMesh;
    root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
    const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    const motion = BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R');
    for (const frame of motion.keyframes) for (const target of frame.targets) if (target.motion === 'elbowFlexion') target.targetDegrees += deltaDeg;
    const started = performance.now();
    currentGuides = []; currentWitnesses = []; currentSolveResults = [];
    const recording = sampleComposedMotion(resolveComposedMotion(motion, cfg), { baselinePose, rest, variantCfg: cfg,
      skeletonHarness: { root, skinned }, sampleHz: 60, constraints,
      ...(sampling === 'witness-only' ? { frameTimesMs: witnessTimesMs } : {}),
      trackedBones: ['Hips', 'Head', ...['L', 'R'].flatMap(side => ['Shoulder', 'UpperArm', 'Forearm', 'Hand', 'Mid1', 'Index1', 'Pinky1'].map(part => `${side}_${part}`))] });
    runs.push({ deltaDeg, elapsedMs: performance.now() - started, frames: recording.frames, guides: currentGuides });
    report.solverRuns.push({ variant, deltaDeg, scope: 'Actual solver invocations; exact cached poses do not trigger a new solve. Numerical stops and residuals are not movement/contact acceptance.', solves: currentSolveResults });
    writeFileSync(`${output}.${variant}.${deltaDeg}.witness.json`, JSON.stringify({ variant, deltaDeg, sourceBefore: report.sourceBefore, guides: currentGuides, witnesses: currentWitnesses }, null, 2) + '\n', { flag: 'wx' });
  }
  const baseline = runs[0]!.frames;
  const cases = runs.slice(1).map(run => {
    const result: any = { variant, deltaDeg: run.deltaDeg, sourceModelSha256: hash(bytes), frames: run.frames.length, elapsedMs: run.elapsedMs,
      maximumRotation: { radians: 0 }, maximumPosition: { meters: 0 }, patientViolations: [], firstDifferenceFailure: null };
    result.guide = { maximumRotation: { radians: 0 }, firstDifferenceFailure: null };
    for (const [guideIndex, guide] of run.guides.entries()) for (const [knotIndex, knot] of guide.path.entries()) {
      const before = runs[0]!.guides[guideIndex].path[knotIndex];
      if (before.tMs !== knot.tMs) throw Error('Guide clocks differ');
      for (const [joint, values] of knot.quats.entries()) {
        const angle = new THREE.Quaternion().fromArray(values).normalize().angleTo(new THREE.Quaternion().fromArray(before.quats[joint]).normalize());
        const witness = { radians: angle, degrees: THREE.MathUtils.radToDeg(angle), key: guide.joints[joint], tMs: knot.tMs };
        if (angle > result.guide.maximumRotation.radians) result.guide.maximumRotation = witness;
        if (angle > rotationTolerance && (!result.guide.firstDifferenceFailure || knot.tMs < result.guide.firstDifferenceFailure.tMs)) result.guide.firstDifferenceFailure = witness;
      }
    }
    for (const [index, frame] of run.frames.entries()) {
      const before = baseline[index]!;
      for (const [key, values] of Object.entries(frame.pose.bones)) {
        const angle = new THREE.Quaternion().fromArray(values).normalize().angleTo(new THREE.Quaternion().fromArray(before.pose.bones[key]!).normalize());
        if (angle > result.maximumRotation.radians) result.maximumRotation = { radians: angle, degrees: THREE.MathUtils.radToDeg(angle), key, tMs: frame.tMs };
        if (angle > rotationTolerance && !result.firstDifferenceFailure) result.firstDifferenceFailure = { metric: 'rotation', key, tMs: frame.tMs, radians: angle };
      }
      for (const [key, values] of Object.entries(frame.worldTracks!)) {
        const distance = new THREE.Vector3().fromArray(values).distanceTo(new THREE.Vector3().fromArray(before.worldTracks![key]!));
        if (distance > result.maximumPosition.meters) result.maximumPosition = { meters: distance, key, tMs: frame.tMs };
        if (distance > .0001 && !result.firstDifferenceFailure) result.firstDifferenceFailure = { metric: 'position', key, tMs: frame.tMs, meters: distance };
      }
      for (const [joint, fields] of Object.entries(constraints)) for (const [field, { availableRange }] of Object.entries(fields)) {
        const value = frame.angles[joint]?.[field];
        if (value == null || value < availableRange.min - .01 || value > availableRange.max + .01) result.patientViolations.push({ joint, field, tMs: frame.tMs, value });
      }
    }
    result.passed = !result.firstDifferenceFailure && !result.guide.firstDifferenceFailure && result.patientViolations.length === 0;
    console.log(JSON.stringify(result)); return result;
  });
  report.cases.push(...cases);
}
report.sourceAfter = digest(); report.sourceStable = report.sourceAfter === report.sourceBefore;
Object.defineProperty(Contact, 'preparePalmSupportApproach', descriptor);
Object.defineProperty(Contact, 'stepContactPlants', stepDescriptor);
Object.defineProperty(HandContact, 'solveHandContactPose', handDescriptor);
report.passed = report.sourceStable && report.cases.every((row: any) => row.passed);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
