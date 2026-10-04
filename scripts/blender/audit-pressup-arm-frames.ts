/** Read-only arm-frame diagnostic. Does not alter recipes, bounds or poses on disk.
 * vite-node this.ts <proposal-directory> <fresh-output.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, serializeCustomPose, buildBoneByPoseKey } from '../../src/services/poseRig';
import { captureJointAngleRestReference, computeJointAngles, upperArmWorldAngles } from '../../src/services/jointAngles';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from '../../src/services/rootMotion';
import { inspectClinicalAngles, clampBoneToRom } from '../../src/services/poseRomClamp';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { resolveComposedMotion } from '../../src/services/motionSequence';

const [directory, destination, mode] = process.argv.slice(2);
if (!directory || !destination) throw Error('Provide proposal directory and fresh report path');
const engine = fileURLToPath(new URL('../../', import.meta.url));
const parse = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const names = ['poseRomClamp', 'jointAngles', 'handContactPose', 'footContact', 'motionRecording', 'rootMotion', 'proneSkinSupport'];
const identity = () => Object.fromEntries(names.map(name => [name, hash(readFileSync(resolve(engine, 'src/services', name + '.ts')))]));
const report: any = { sourceBefore: identity(), sourceDirectory: resolve(directory),
  scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  scope: 'Sparse frame and constraint diagnostics only. Saved poses reconstructed with independent world-track equality; new forward=1 trial is unpromoted. No bounds changed. Thorax-rest comparison is a diagnostic of the existing clamp frame, not a promoted replacement.', cases: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skinned!: THREE.SkinnedMesh;
  root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
  const baseline = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const initial = { position: root.position.clone(), quaternion: root.quaternion.clone() };
  const bones = buildBoneByPoseKey(skinned.skeleton, cfg), point = (key: string) => bones.get(key)!.getWorldPosition(new THREE.Vector3());
  const thoraxRest = bones.get('L_Shoulder')!.parent!.getWorldQuaternion(new THREE.Quaternion());
  const savedPath = resolve(directory, variant + '-planned-whole-chain.json'), saved = parse(savedPath);
  if (saved.sourceModelSha256 !== hash(bytes)) throw Error('Saved rig identity changed');
  const motion = parse(resolve(directory, 'proposed.motion.json'));
  motion.pronePalmAnchorFit = false;
  for (const contact of motion.contacts) contact.palmSupport.forward = 1;
  const farther = mode === 'saved-only' ? null : sampleComposedMotion(resolveComposedMotion(motion, cfg), { baselinePose: baseline, variantCfg: cfg, rest,
    skeletonHarness: { root, skinned }, frameTimesMs: [0, 1000, 2500], sampleHz: 1,
    trackedBones: ['L_Shoulder', 'L_UpperArm', 'L_Forearm', 'L_Hand', 'R_Shoulder', 'R_UpperArm', 'R_Forearm', 'R_Hand'] });
  const cases: any[] = [];
  for (const [kind, frames] of [['saved-selected', saved.frames], ...(farther ? [['forward-one', farther.frames]] : [])] as const) {
    for (const frame of frames) {
      root.position.copy(initial.position).add(new THREE.Vector3().fromArray(frame.root.translateM));
      root.quaternion.copy(initial.quaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
      applyCustomPose(skinned.skeleton, cfg, frame.pose); root.updateMatrixWorld(true);
      const residuals = Object.entries(frame.worldTracks).filter(([key]) => bones.has(key)).map(([key, value]) =>
        point(key).distanceTo(new THREE.Vector3().fromArray(value as number[])));
      const maxTrackResidualM = Math.max(...residuals);
      if (maxTrackResidualM > 1e-7) throw Error('Pose reconstruction does not match recorded tracks');
      const rotated = rotateRestReferenceByPelvis(rotateRestReferenceByRoot(rest,
        root.quaternion.clone().multiply(initial.quaternion.clone().invert())), skinned.skeleton, cfg);
      const thoraxDelta = bones.get('L_Shoulder')!.parent!.getWorldQuaternion(new THREE.Quaternion()).multiply(thoraxRest.clone().invert());
      const inverseThorax = thoraxDelta.clone().invert();
      const thoraxFrameRest = rotateRestReferenceByRoot(rest, thoraxDelta);
      const readout = computeJointAngles(skinned.skeleton, cfg, variant, rotated);
      const sides: any = {};
      for (const side of ['L', 'R'] as const) {
        const upper = bones.get(side + '_UpperArm')!;
        const thoraxAngles = upperArmWorldAngles(upper.getWorldQuaternion(new THREE.Quaternion()).premultiply(inverseThorax),
          new THREE.Quaternion().fromArray(rest.worldQuats[side + '_UpperArm']!),
          point(side + '_Forearm').sub(point(side + '_UpperArm')).normalize().applyQuaternion(inverseThorax),
          new THREE.Vector3().fromArray(rest.worldDirs![side + '_UpperArm']!), side === 'R');
        const clampReports = Object.fromEntries(['Shoulder', 'UpperArm', 'Forearm', 'Hand'].map(part => {
          const key = side + '_' + part;
          return [part, inspectClinicalAngles(bones.get(key)!, key, rotated)];
        }));
        const original = upper.quaternion.clone();
        const currentChanged = clampBoneToRom(upper, side + '_UpperArm', rotated, null, true);
        const currentClampChangeDeg = original.angleTo(upper.quaternion) * 180 / Math.PI;
        upper.quaternion.copy(original); root.updateMatrixWorld(true);
        const liveThoraxClamp = inspectClinicalAngles(upper, side + '_UpperArm', thoraxFrameRest);
        const thoraxChanged = clampBoneToRom(upper, side + '_UpperArm', thoraxFrameRest, null, true);
        const thoraxClampChangeDeg = original.angleTo(upper.quaternion) * 180 / Math.PI;
        upper.quaternion.copy(original); root.updateMatrixWorld(true);
        const shoulder = point(side + '_UpperArm'), elbow = point(side + '_Forearm'), wrist = point(side + '_Hand');
        sides[side] = { runtimeProjectedShoulder: readout.joints[side + '_UpperArm'], liveThoraxShoulder: thoraxAngles,
          clampReports, liveThoraxClamp, currentChanged, currentClampChangeDeg, thoraxChanged, thoraxClampChangeDeg,
          reported: Object.fromEntries(['Shoulder', 'Forearm', 'Hand'].map(part => [part, readout.joints[side + '_' + part]])),
          shoulderPositionM: shoulder.toArray(), elbowPositionM: elbow.toArray(), wristPositionM: wrist.toArray(),
          reachLengthM: shoulder.distanceTo(wrist), segmentLengthsM: [shoulder.distanceTo(elbow), elbow.distanceTo(wrist)] };
      }
      cases.push({ kind, tMs: frame.tMs, maxTrackResidualM, sides });
    }
  }
  report.cases.push({ variant, sourceModelSha256: hash(bytes), savedSha256: hash(readFileSync(savedPath)), frames: cases });
  console.log(JSON.stringify({ variant, peak: cases.filter(frame => frame.tMs === 2500).map(frame => ({ kind: frame.kind,
    sides: Object.fromEntries(Object.entries(frame.sides).map(([side, value]: [string, any]) => [side, {
      legacy: value.runtimeProjectedShoulder, thorax: value.liveThoraxShoulder,
      clamp: value.clampReports.UpperArm, elbow: value.reported.Forearm.elbowFlexion,
      currentClampChangeDeg: value.currentClampChangeDeg, thoraxClampChangeDeg: value.thoraxClampChangeDeg,
    }])) })) }));
}
report.sourceAfter = identity(); report.sourceStable = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
writeFileSync(resolve(destination), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
