import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';

setRomClampEnabled(false);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const files = ['assessmentBodyMotions', 'motionRecording', 'motionTrajectory', 'footContact', 'handContactPose', 'proneSkinSupport', 'poseRomClamp', 'pressupPalmLayout'];
const hashes = () => Object.fromEntries(files.map(name => [name, digest(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url)))]));
const report: any = { before: hashes(), poseModeClampEnabled: false, sampleHz: 30,
  scope: 'Production engine versus currently served simMOVE public assets. Fresh rig/cache per asset; same unrestricted full source motion. Actual 101-bone replay includes twist. Support gaps are freshly measured by the actual skin controller, not full-skin Blender acceptance.', cases: [] };
for (const variant of ['male', 'female', 'neutral'] as const) {
  const cfg = BODY_VARIANTS[variant], cases: any[] = [];
  for (const asset of ['engine', 'public'] as const) {
    const path = asset === 'engine' ? `../../models/painmap3D_${variant}.runtime.glb` : `../../../public/models/painmap3D_${variant}.runtime.glb`;
    const bytes = readFileSync(new URL(path, import.meta.url));
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    let skinned!: THREE.SkinnedMesh;
    root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
    const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    const position = root.position.clone(), quaternion = root.quaternion.clone(), twist = createStageTwistOverlay();
    twist.reset(skinned.skeleton, cfg);
    const start = performance.now();
    const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
      baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 30,
    });
    const elapsedMs = performance.now() - start;
    const frames = recording.frames.map(frame => {
      root.position.copy(position).add(new THREE.Vector3().fromArray(frame.root.translateM));
      root.quaternion.copy(quaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
      applyCustomPose(skinned.skeleton, cfg, frame.pose);
      const bones = twist.sampleWithTwist(() => {
        root.updateMatrixWorld(true);
        return Object.fromEntries(skinned.skeleton.bones.map(bone => [bone.name, {
          position: bone.getWorldPosition(new THREE.Vector3()).toArray(), quaternion: bone.getWorldQuaternion(new THREE.Quaternion()).normalize().toArray(),
        }]));
      });
      return { frame, bones };
    });
    cases.push({ asset, sha256: digest(bytes), bytes: bytes.length, elapsedMs, frames, bones: skinned.skeleton.bones.length,
      supportFailures: recording.frames.filter(frame => !frame.proneSupport?.feasible).map(frame => ({ tMs: frame.tMs, support: frame.proneSupport })),
      supportGapsM: Object.fromEntries(Object.keys(recording.frames[0]!.proneSupport!.regions).map(key => [key, {
        min: Math.min(...recording.frames.map(frame => (frame.proneSupport!.regions as any)[key].gapM)),
        max: Math.max(...recording.frames.map(frame => (frame.proneSupport!.regions as any)[key].gapM)),
      }])),
    });
  }
  const [engine, served] = cases;
  const row: any = { variant, frames: engine.frames.length,
    assets: cases.map(({ frames, ...summary }) => summary), maxLocalBoneDeg: { value: 0 }, maxWorldBoneDeg: { value: 0 },
    maxBonePositionM: { value: 0 }, maxPalmPositionM: { value: 0 }, maxRootTranslationM: { value: 0 }, maxAngleDifferenceDeg: { value: 0 }, maxSupportGapDifferenceM: { value: 0 },
  };
  const record = (metric: string, value: number, tMs: number, key: string) => { if (value > row[metric].value) row[metric] = { value, tMs, key }; };
  engine.frames.forEach((a: any, i: number) => {
    const b = served.frames[i], tMs = a.frame.tMs;
    if (tMs !== b.frame.tMs) throw Error('Frame clocks differ');
    for (const [key, raw] of Object.entries(a.frame.pose.bones)) record('maxLocalBoneDeg', new THREE.Quaternion().fromArray(raw as number[]).normalize().angleTo(new THREE.Quaternion().fromArray(b.frame.pose.bones[key]).normalize()) * 180 / Math.PI, tMs, key);
    for (const [key, raw] of Object.entries(a.bones) as [string, any][]) {
      record('maxWorldBoneDeg', new THREE.Quaternion().fromArray(raw.quaternion).angleTo(new THREE.Quaternion().fromArray(b.bones[key].quaternion)) * 180 / Math.PI, tMs, key);
      record('maxBonePositionM', new THREE.Vector3().fromArray(raw.position).distanceTo(new THREE.Vector3().fromArray(b.bones[key].position)), tMs, key);
    }
    record('maxRootTranslationM', new THREE.Vector3().fromArray(a.frame.root.translateM).distanceTo(new THREE.Vector3().fromArray(b.frame.root.translateM)), tMs, 'root');
    for (const side of ['L', 'R']) record('maxPalmPositionM', new THREE.Vector3().fromArray(a.frame.worldTracks[`${side}_Hand`]).distanceTo(new THREE.Vector3().fromArray(b.frame.worldTracks[`${side}_Hand`])), tMs, side);
    for (const [key, fields] of Object.entries(a.frame.angles) as [string, Record<string, number>][]) for (const [field, value] of Object.entries(fields)) {
      if (Number.isFinite(value) && Number.isFinite(b.frame.angles[key]?.[field])) record('maxAngleDifferenceDeg', Math.abs(value - b.frame.angles[key][field]), tMs, `${key}.${field}`);
    }
    for (const [region, witness] of Object.entries(a.frame.proneSupport.regions) as [string, any][]) record('maxSupportGapDifferenceM', Math.abs(witness.gapM - b.frame.proneSupport.regions[region].gapM), tMs, region);
  });
  row.sameAssetBytes = engine.sha256 === served.sha256;
  report.cases.push(row); console.log(JSON.stringify(row));
}
report.after = hashes(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
