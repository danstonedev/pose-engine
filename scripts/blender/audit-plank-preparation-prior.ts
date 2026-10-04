/** Process-local default posture-preference experiment; runtime files untouched.
 * vite-node THIS <retained-recipe> <new-output> [neutral|all] [sparse|dense]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { captureJointAngleRestReference, computeJointAngles, isShoulderFieldMasked } from '../../src/services/jointAngles';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../../src/services/poseRig';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { getEffectiveRomRange } from '../../src/services/romConstraints';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';
import * as Contact from '../../src/services/footContact';
import * as Hand from '../../src/services/handContactPose';

const [recipePath, output, filter = 'neutral', sampling = 'sparse', modesArgument] = process.argv.slice(2);
if (!output || !['neutral', 'all'].includes(filter) || !['sparse', 'dense'].includes(sampling)) throw Error('Invalid options');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['motionRecording', 'footContact', 'handContactPose', 'poseRomClamp', 'rootMotion', 'jointAngles', 'plankSkinSupport'];
const source = () => Object.fromEntries(sourcePaths.map(name => [name, sha(readFileSync(new URL('../../src/services/' + name + '.ts', import.meta.url)))]));
const sourceBefore = source();
const report: any = { version: 1, kind: 'default-plank-preparation-prior-experiment', sourceBefore,
  recipeSha256: sha(readFileSync(recipePath)), scriptSha256: sha(readFileSync(new URL(import.meta.url))),
  criteriaBeforeRun: { skinToleranceM: .001, fixedPalmDriftToleranceM: .002, clinicalToleranceDeg: .05,
    intention: 'Reduce default mirrored elbow/girdle asymmetry, preserve 76 degree top near-straight arms and whole-body clearance. Default-only numerical preference; patient constraints must be bypassed and no ROM caps change.' },
  scope: sampling === 'dense' ? 'All 169 30 Hz runtime frames, render twist and all skin. No Blender/native/clinical acceptance.' : 'Three exact setup/top/return runtime clocks plus complete prepared guides. Sparse diagnostic only; not movement acceptance.', cases: [] };
setRomClampEnabled(false);
let mode = 'baseline', preparationTime: number | undefined;
let sourceQuats = new Map<string, THREE.Quaternion[]>(), trace: any[] = [], firstCalls = new Set<string>();
let sourceWorldQuats = new Map<string, THREE.Quaternion[]>(), firstSolvedWorldQuats = new Map<string, THREE.Quaternion[]>();
let currentSkeleton: THREE.Skeleton, currentCfg: typeof BODY_VARIANTS.neutral;
let currentBones: ReturnType<typeof buildBoneByPoseKey>;
let currentPlants: Parameters<typeof Contact.preparePalmSupportApproach>[0] = [];
const prepare = Contact.preparePalmSupportApproach, originalHand = Hand.solveHandContactPose;
const descriptor = Object.getOwnPropertyDescriptor(Contact, 'preparePalmSupportApproach')!;
const handDescriptor = Object.getOwnPropertyDescriptor(Hand, 'solveHandContactPose')!;
if (!descriptor.configurable || !handDescriptor.configurable) throw Error('Process-local Vite exports unavailable');
Object.defineProperty(Contact, 'preparePalmSupportApproach', { configurable: true, value: (...args: Parameters<typeof prepare>) => {
  currentPlants = args[0];
  const poseAt = args[4], previousTime = preparationTime;
  args[4] = tMs => {
    preparationTime = tMs; poseAt(tMs);
    sourceQuats = new Map(args[0].filter(plant => plant.palmSupport).map(plant => [plant.solver.footKey, plant.solver.ctx.bones.map(bone => bone.quaternion.clone())]));
    sourceWorldQuats = new Map(args[0].filter(plant => plant.palmSupport).map(plant => [plant.solver.footKey, plant.solver.ctx.bones.map(bone => bone.getWorldQuaternion(new THREE.Quaternion()))]));
  };
  try { return prepare(...args); } finally { preparationTime = previousTime; }
} });
Object.defineProperty(Hand, 'solveHandContactPose', { configurable: true, value: (...args: Parameters<typeof originalHand>) => {
  const solver = args[0], authored = sourceQuats.get(solver.footKey), priorBefore = args[8];
  const first = !firstCalls.has(solver.footKey); firstCalls.add(solver.footKey);
  const hasPatientConstraint = args[4] != null && Object.keys(args[4]).length > 0;
  const initial = first && preparationTime != null;
  const apply = !hasPatientConstraint && authored && preparationTime != null &&
    (mode === 'initial-authored' ? initial : mode === 'initial-girdle' ? initial : mode === 'guide-girdle' ? args[5] != null : false);
  const measuredBefore = initial && args[3] ? computeJointAngles(currentSkeleton, currentCfg, currentCfg.id, args[3]).joints : undefined;
  if (['fixed-authored-pole', 'initial-mirror-fixed-pole'].includes(mode) && preparationTime != null && args[5] && !hasPatientConstraint) {
    const plant = currentPlants.find(plant => plant.solver === solver)!, layout = plant.palmSupport!, forward = plant.supportForward!;
    args[5] = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward)
      .multiplyScalar(layout.elbowOutward * (solver.footKey.startsWith('L_') ? 1 : -1))
      .addScaledVector(forward, -layout.elbowBackward).add(new THREE.Vector3(0, layout.elbowUpward ?? 0, 0));
  }
  let mirroredSeed = false;
  if (['initial-mirrored-branch', 'initial-mirror-fixed-pole', 'initial-mirror-palm', 'initial-mirror-refine-only'].includes(mode) ? initial && !hasPatientConstraint && solver.footKey === 'R_Hand' && firstSolvedWorldQuats.has('L_Hand') : ['guide-mirrored-branch', 'guide-mirror-refine-only'].includes(mode) && preparationTime != null && !hasPatientConstraint && solver.footKey === 'R_Hand' && firstSolvedWorldQuats.has('L_Hand')) {
    const left = solver.ctx.canonicalKeys.map(key => currentBones.get(key.replace(/^R_/, 'L_'))!.getWorldQuaternion(new THREE.Quaternion()));
    const sourceLeft = sourceWorldQuats.get('L_Hand')!, sourceRight = sourceWorldQuats.get('R_Hand')!;
    for (let joint = solver.ctx.bones.length - 1; joint >= 0; joint--) {
      const delta = left[joint]!.clone().multiply(sourceLeft[joint]!.clone().invert()).normalize();
      delta.set(delta.x, -delta.y, -delta.z, delta.w); // World-X reflection; bounded experiment has zero body yaw.
      const world = ['initial-mirror-palm', 'initial-mirror-refine-only', 'guide-mirror-refine-only'].includes(mode) && joint === 0 ? args[2].clone() : delta.multiply(sourceRight[joint]!).normalize(), bone = solver.ctx.bones[joint]!;
      bone.quaternion.copy(bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
      bone.updateWorldMatrix(false, true);
    }
    args[8] = solver.ctx.bones.map(bone => bone.quaternion.clone()); mirroredSeed = true;
    if (['initial-mirror-refine-only', 'guide-mirror-refine-only'].includes(mode)) { args[5] = undefined; args[7] = undefined; }
  }
  if (apply) {
    args[8] = mode === 'initial-authored' ? authored!.map(quat => quat.clone()) : solver.ctx.bones.map((bone, index) => index === solver.ctx.bones.length - 1 ? authored![index]!.clone() : (priorBefore?.[index]?.clone() ?? bone.quaternion.clone()));
  }
  const mirroredSeedState = mirroredSeed ? { angles: args[3] ? computeJointAngles(currentSkeleton, currentCfg, currentCfg.id, args[3]).joints : undefined,
    handOrientationErrorRadians: solver.ctx.bones[0]!.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(args[2].clone().normalize()),
    positions: Object.fromEntries(['L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm', 'L_Hand', 'R_Hand'].map(key => [key, currentBones.get(key)!.getWorldPosition(new THREE.Vector3()).toArray()])) } : undefined;
  const result = originalHand(...args);
  if (initial) firstSolvedWorldQuats.set(solver.footKey, solver.ctx.bones.map(bone => bone.getWorldQuaternion(new THREE.Quaternion())));
  if (initial || apply || (preparationTime != null && [1000, 2500, 5600].some(t => Math.abs(t - preparationTime!) < .001))) trace.push({
    preparationTime, hand: solver.footKey, first, changedPrior: !!apply, mirroredSeed, patientBypassed: hasPatientConstraint,
    canonicalKeys: solver.ctx.canonicalKeys, authoredQuats: authored?.map(quat => quat.toArray()), priorBefore: priorBefore?.map(quat => quat.toArray()),
    beforeAngles: measuredBefore, afterAngles: args[3] ? computeJointAngles(currentSkeleton, currentCfg, currentCfg.id, args[3]).joints : undefined,
    afterQuats: solver.ctx.bones.map(bone => bone.quaternion.toArray()), mirroredSeedState, target: args[1].toArray(), targetOrientation: args[2].toArray(), elbowDirection: args[5]?.toArray(), result,
  });
  return result;
} });
for (const variant of (filter === 'all' ? ['male', 'female', 'neutral'] : ['neutral']) as ('male' | 'female' | 'neutral')[]) {
 for (mode of modesArgument?.split(',') ?? ['baseline', 'initial-authored', 'initial-girdle', 'guide-girdle', 'initial-mirrored-branch', 'guide-mirrored-branch']) {
  const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url)), cfg = BODY_VARIANTS[variant];
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const skins: THREE.SkinnedMesh[] = []; root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skins.push(object as THREE.SkinnedMesh); });
  const skin = skins[0]!, skeleton = skin.skeleton, bones = buildBoneByPoseKey(skeleton, cfg), rest = captureJointAngleRestReference(skeleton, cfg);
  currentSkeleton = skeleton; currentCfg = cfg; currentBones = bones; sourceQuats = new Map(); sourceWorldQuats = new Map(); firstSolvedWorldQuats = new Map(); firstCalls = new Set(); trace = [];
  const baselinePose = serializeCustomPose(skeleton, cfg, variant), rootRestP = root.position.clone(), rootRestQ = root.quaternion.clone();
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8')); recipe.supportPlaneY = 0; recipe.plankSkinSupport = true;
  for (const contact of recipe.contacts ?? []) if (contact.palmSupport) contact.palmSupport.surface = 'skin';
  const recording = sampleComposedMotion(resolveComposedMotion(recipe, cfg), { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned: skin }, sampleHz: 30,
    ...(sampling === 'sparse' ? { frameTimesMs: [0, 2500, 5600] } : {}) });
  if (!recording.frames.length) throw Error('Recording refused: ' + recording.refusalReason);
  const twist = createStageTwistOverlay(); twist.reset(skeleton, cfg);
  const frames = recording.frames.map(frame => {
    root.position.copy(rootRestP).add(new THREE.Vector3().fromArray(frame.root.translateM)); root.quaternion.copy(rootRestQ).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat)); applyCustomPose(skeleton, cfg, frame.pose);
    let minimum = Infinity, witness: any;
    const geometry = twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true); const point = new THREE.Vector3();
      for (const mesh of skins) { mesh.skeleton.update(); for (let index = 0; index < mesh.geometry.getAttribute('position').count; index++) {
        mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld); if (point.y < minimum) { minimum = point.y; witness = { mesh: mesh.name, index, positionM: point.toArray() }; }
      } }
      return { bones: Object.fromEntries([...bones].map(([key, bone]) => [key, bone.getWorldPosition(new THREE.Vector3()).toArray()])), localQuats: Object.fromEntries(skeleton.bones.map(bone => [bone.name, bone.quaternion.toArray()])) };
    });
    const breaches = Object.entries(frame.angles).flatMap(([joint, set]) => Object.entries(set).flatMap(([field, value]) => {
      const range = getEffectiveRomRange(null, joint, field), masked = isShoulderFieldMasked(joint, field, set);
      return range && !masked && (value < range.min - .05 || value > range.max + .05) ? [{ joint, field, value, range }] : [];
    }));
    const left = geometry.bones.L_Forearm!, right = geometry.bones.R_Forearm!;
    return { tMs: frame.tMs, root: frame.root, pose: frame.pose, angles: frame.angles, ...geometry, minimumSkinM: minimum, witness, breaches,
      mirroredElbowDifferenceM: [left[0] + right[0], left[1] - right[1], left[2] - right[2]] };
  });
  const first = frames[0]!;
  const row = { variant, mode, assetSha256: sha(bytes), sampleCount: frames.length, trace, frames,
    worstSkinM: Math.min(...frames.map(frame => frame.minimumSkinM)),
    maxPalmDriftM: Math.max(...frames.flatMap(frame => ['L_Hand', 'R_Hand'].map(key => new THREE.Vector3().fromArray(frame.bones[key]!).distanceTo(new THREE.Vector3().fromArray(first.bones[key]!))))),
    focusedBreaches: frames.flatMap(frame => frame.breaches.filter(breach => !/Thumb|Index|Mid|Ring|Pinky/.test(breach.joint))) };
  report.cases.push(row); console.log(JSON.stringify({ variant, mode, skin: row.worstSkinM, palmDrift: row.maxPalmDriftM, focusedBreaches: row.focusedBreaches.length,
    phases: frames.filter(frame => [0, 2500, 5600].some(t => Math.abs(t - frame.tMs) < .01)).map(frame => ({ tMs: frame.tMs, girdles: [frame.angles.L_Shoulder, frame.angles.R_Shoulder], elbows: [frame.angles.L_Forearm, frame.angles.R_Forearm], mirroredElbowDifferenceM: frame.mirroredElbowDifferenceM })) }));
 }
}
report.sourceAfter = source(); report.sourceStable = JSON.stringify(sourceBefore) === JSON.stringify(report.sourceAfter);
if (!report.sourceStable) throw Error('Shared runtime changed during probe');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
