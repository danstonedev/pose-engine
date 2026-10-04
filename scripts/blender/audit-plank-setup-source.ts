/** Reconstruct saved pre-contact source locals; no motion/solver resampling. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { buildBoneByPoseKey } from '../../src/services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../../src/services/jointAngles';
import { rotateRestReferenceByRoot, rotateRestReferenceByPelvis } from '../../src/services/rootMotion';
const [probePath, recipePath, output] = process.argv.slice(2);
if (!output) throw Error('Dense probe, retained recipe and fresh report required');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const probe = JSON.parse(readFileSync(probePath, 'utf8')), recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
const targets = (side: string) => recipe.keyframes[0].targets.filter((target: any) => new RegExp('^' + side + '_(Shoulder|UpperArm|Forearm|Hand)$').test(target.joint)).map((target: any) => ({ ...target, joint: target.joint.slice(2) }));
const report: any = { version: 1, kind: 'retained-default-plank-setup-source', probeSha256: sha(readFileSync(probePath)), recipeSha256: sha(readFileSync(recipePath)),
  sourceBefore: probe.sourceBefore, sourceStable: probe.sourceStable,
  scope: 'Saved sourceQuats from initial prepared setup restored on exact recorded whole-body/root pose. Original recipe semantic controls and parent ancestry are retained. No sampler or solver rerun.',
  sameExplicitBilateralSetupTargets: JSON.stringify(targets('L')) === JSON.stringify(targets('R')),
  setupTargets: { L: targets('L'), R: targets('R') }, samePalmLayout: JSON.stringify(recipe.contacts[0].palmSupport) === JSON.stringify(recipe.contacts[1].palmSupport), cases: [] };
for (const entry of probe.cases) {
  const cfg = BODY_VARIANTS[entry.variant as keyof typeof BODY_VARIANTS], bytes = readFileSync(new URL(`../../models/painmap3D_${entry.variant}.runtime.glb`, import.meta.url));
  if (sha(bytes) !== entry.assetSha256) throw Error('Asset changed');
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skeleton!: THREE.Skeleton; root.traverse(object => { if (!skeleton && (object as THREE.SkinnedMesh).isSkinnedMesh) skeleton = (object as THREE.SkinnedMesh).skeleton; });
  const rest = captureJointAngleRestReference(skeleton, cfg), rootRestQ = root.quaternion.clone(), rootRestP = root.position.clone(), frame = entry.frames[0];
  root.position.copy(rootRestP).add(new THREE.Vector3().fromArray(frame.root.translateM)); root.quaternion.copy(rootRestQ).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
  for (const bone of skeleton.bones) bone.quaternion.fromArray(frame.localQuats[bone.name]);
  const bones = buildBoneByPoseKey(skeleton, cfg);
  for (const side of ['L', 'R']) { const trace = entry.trace.find((trace: any) => trace.first && trace.hand === side + '_Hand');
    trace.canonicalKeys.forEach((key: string, index: number) => bones.get(key)!.quaternion.fromArray(trace.authoredQuats[index])); }
  root.updateMatrixWorld(true);
  const measureRest = rotateRestReferenceByPelvis(rotateRestReferenceByRoot(rest, root.quaternion.clone().multiply(rootRestQ.clone().invert())), skeleton, cfg);
  const angles = computeJointAngles(skeleton, cfg, cfg.id, measureRest).joints;
  const parts = ['Shoulder', 'UpperArm', 'Forearm', 'Hand'];
  const pair = parts.map(part => { const l = bones.get('L_' + part)!, r = bones.get('R_' + part)!, a = l.getWorldPosition(new THREE.Vector3()), b = r.getWorldPosition(new THREE.Vector3());
    return { part, L: { positionM: a.toArray(), worldQuaternion: l.getWorldQuaternion(new THREE.Quaternion()).toArray(), parent: l.parent!.name, axes: (angles as any)['L_' + part] },
      R: { positionM: b.toArray(), worldQuaternion: r.getWorldQuaternion(new THREE.Quaternion()).toArray(), parent: r.parent!.name, axes: (angles as any)['R_' + part] },
      mirroredPositionErrorM: new THREE.Vector3(a.x + b.x, a.y - b.y, a.z - b.z).length() };
  });
  const parentL = bones.get('L_Shoulder')!.parent!, parentR = bones.get('R_Shoulder')!.parent!;
  report.cases.push({ variant: entry.variant, assetSha256: sha(bytes), pair,
    sharedGirdleParent: parentL === parentR, parent: { name: parentL.name, positionM: parentL.getWorldPosition(new THREE.Vector3()).toArray(), quaternion: parentL.getWorldQuaternion(new THREE.Quaternion()).toArray() },
    all101SourceWorldPositions: Object.fromEntries(skeleton.bones.map(bone => [bone.name, bone.getWorldPosition(new THREE.Vector3()).toArray()])) });
  console.log(JSON.stringify({ variant: entry.variant, parent: parentL.name, sharedParent: parentL === parentR, pair: pair.map(pair => ({ part: pair.part, mirroredErrorMm: pair.mirroredPositionErrorM * 1000, L: pair.L.axes, R: pair.R.axes })) }));
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
