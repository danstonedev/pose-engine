/** Read actual animation and captured native input with the engine clinical reference.
 * vite-node .../audit-pressup-chain.ts <review-dir> <native-input-dir> <fresh.json>
 * Diagnostic only: no pose, limits, fixture or native controller changes.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { captureJointAngleRestReference, computeJointAngles, decomposeBodyDelta, deltaFromRest } from '../../src/services/jointAngles';
import { applyCustomPose } from '../../src/services/poseRig';
import { fileURLToPath } from 'node:url';

const [reviewArg, inputsArg, outputArg] = process.argv.slice(2);
if (!reviewArg || !inputsArg || !outputArg) throw Error('Provide review, native inputs, fresh report');
const review = resolve(reviewArg), inputs = resolve(inputsArg);
const engine = fileURLToPath(new URL('../../', import.meta.url));
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const manifest = read(resolve(review, 'manifest.json'));
const report: any = { version: 1, sourceDigest: manifest.sourceDigest, sourceManifestSha256: hash(readFileSync(resolve(review, 'manifest.json'))),
  scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), scope: 'Clinical engine readout and geometric centerlines, not experimental validation or native acceptance.',
  coordinateConvention: 'Engine metres. Clavicle centerline in current thorax-relative anatomical reference: X subject left, Y superior, -Z anterior.',
  clinicalReference: 'Production model after applyAnatomicPose. Pelvis world tilt includes prone orientation and is not a local pelvic-tilt clinical verdict.',
  segmentReadout: 'Raw spine local YXZ delta shown separately from the regional thoracic readout, which already sums Mid+Upper.', cases: [] };
for (const entry of manifest.cases) {
  const variant = entry.variant as keyof typeof BODY_VARIANTS, cfg = BODY_VARIANTS[variant];
  const originalBytes = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const parse = (bytes: Buffer) => loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const original = await parse(originalBytes);
  original.scene.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(original.scene, cfg); original.scene.updateMatrixWorld(true);
  let originalSkin: THREE.SkinnedMesh | undefined;
  original.scene.traverse(o => { if (!originalSkin && (o as THREE.SkinnedMesh).isSkinnedMesh) originalSkin = o as THREE.SkinnedMesh; });
  if (!originalSkin) throw Error('Missing skin');
  const rest = captureJointAngleRestReference(originalSkin.skeleton, cfg);
  const names: Record<string, string> = { Hips: 'Hip', Pelvis: 'Pelvis', Spine_Lower: 'Waist', Spine_Mid: 'Spine01', Spine_Upper: 'Spine02', Neck_Lower: 'NeckTwist01', Neck: 'NeckTwist02', Head: 'Head' };
  for (const side of ['L', 'R']) for (const [key, name] of Object.entries({ Shoulder: 'Clavicle', UpperArm: 'Upperarm', Forearm: 'Forearm', Hand: 'Hand', UpLeg: 'Thigh', Leg: 'Calf', Foot: 'Foot', Toes: 'ToeBase' })) names[`${side}_${key}`] = `${side}_${name}`;
  const lookup = (skeleton: THREE.Skeleton, key: string) => skeleton.bones.find(b => b.name === `CC_Base_${names[key]}`)!;
  const point = (bone: THREE.Bone) => bone.getWorldPosition(new THREE.Vector3());
  const thoraxRest = lookup(originalSkin.skeleton, 'Spine_Upper').getWorldQuaternion(new THREE.Quaternion());
  const restCenters = Object.fromEntries(['L', 'R'].map(side => [side, point(lookup(originalSkin!.skeleton, `${side}_UpperArm`)).sub(point(lookup(originalSkin!.skeleton, `${side}_Shoulder`))).normalize()]));
  function measure(skeleton: THREE.Skeleton) {
    const clinical = computeJointAngles(skeleton, cfg, variant, rest);
    const thoraxDeltaInverse = lookup(skeleton, 'Spine_Upper').getWorldQuaternion(new THREE.Quaternion()).multiply(thoraxRest.clone().invert()).invert();
    const shoulders = Object.fromEntries(['L', 'R'].map(side => {
      const a = point(lookup(skeleton, `${side}_Shoulder`)), b = point(lookup(skeleton, `${side}_UpperArm`));
      const center = b.clone().sub(a).normalize().applyQuaternion(thoraxDeltaInverse), ref = restCenters[side];
      const angle = (v: THREE.Vector3) => ({ elevationDeg: Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI,
        protractionDeg: Math.atan2(-v.z, (side === 'L' ? 1 : -1) * v.x) * 180 / Math.PI });
      const currentAngles = angle(center), restAngles = angle(ref);
      return [side, { clavicleOriginM: a.toArray(), humeralHeadM: b.toArray(), centerlineThoraxAnatomical: center.toArray(), restCenterline: ref.toArray(),
        currentAngles, restAngles, elevationChangeDeg: currentAngles.elevationDeg - restAngles.elevationDeg,
        protractionChangeDeg: currentAngles.protractionDeg - restAngles.protractionDeg }];
    }));
    const segments = Object.fromEntries(['Spine_Lower', 'Spine_Mid', 'Spine_Upper', 'Neck_Lower', 'Neck', 'Head'].map(key => {
      const d = new THREE.Quaternion(); deltaFromRest(lookup(skeleton, key).quaternion, rest.localQuats[key], d);
      const a = decomposeBodyDelta(d); return [key, { flexion: -a.flexion, lateralTilt: -a.abduction, rotation: -a.rotation }];
    }));
    return { clinical, segments, shoulders, boneTransforms: Object.fromEntries(Object.keys(names).filter(key => lookup(skeleton, key)).map(key => {
      const bone = lookup(skeleton, key); return [key, { name: bone.name, localQuaternion: bone.quaternion.toArray(),
        worldQuaternion: bone.getWorldQuaternion(new THREE.Quaternion()).toArray(), parentWorldQuaternion: bone.parent!.getWorldQuaternion(new THREE.Quaternion()).toArray() }];
    })), bonePositionsM: Object.fromEntries(Object.keys(names).filter(key => lookup(skeleton, key)).map(key => [key, point(lookup(skeleton, key)).toArray()])) };
  }
  const binary = readFileSync(resolve(review, entry.file));
  if (hash(binary) !== entry.glbSha256) throw Error('Animation hash mismatch');
  const parsed = await parse(binary); let skin: THREE.SkinnedMesh | undefined;
  parsed.scene.traverse(o => { if (!skin && (o as THREE.SkinnedMesh).isSkinnedMesh) skin = o as THREE.SkinnedMesh; });
  const mixer = new THREE.AnimationMixer(parsed.scene); mixer.clipAction(parsed.animations[0]!).play();
  const frames = [];
  for (let index = 0; index < entry.frames; index++) {
    const timeSec = index / manifest.fps; mixer.setTime(timeSec); parsed.scene.updateMatrixWorld(true);
    frames.push({ sampleIndex: index, timeSec, ...measure(skin!.skeleton) });
  }
  const nativeSources = [];
  for (const filename of readdirSync(inputs).filter(name => name.includes(`-${variant}-`) && name.endsWith('.json'))) {
    const p = resolve(inputs, filename), data = read(p); if (!data.project?.keyframes) continue;
    const snapshots = [];
    for (const keyframe of data.project.keyframes) {
      const s = keyframe.snapshot;
      original.scene.position.fromArray(s.root.position); original.scene.quaternion.fromArray(s.root.quaternion); original.scene.scale.fromArray(s.root.scale);
      applyCustomPose(originalSkin.skeleton, cfg, s.pose); original.scene.updateMatrixWorld(true);
      snapshots.push({ timeMs: keyframe.timeMs, phase: s.referencePhase, ...measure(originalSkin.skeleton) });
    }
    nativeSources.push({ filename, sha256: hash(readFileSync(p)), snapshots });
  }
  report.cases.push({ id: entry.id, variant, glbSha256: entry.glbSha256, sourceModelSha256: hash(originalBytes), restReference: rest, frames, nativeSources });
  console.log(`${variant}: ${frames.length} frames + ${nativeSources.length} native source captures`);
}
writeFileSync(resolve(outputArg), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
