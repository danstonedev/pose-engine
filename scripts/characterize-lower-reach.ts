/** Current-source lower-reach measurements, not a clinical endpoint test.
 * Run with: npx vite-node scripts/characterize-lower-reach.ts <fresh.json> [peak-elbow-deg]
 * Optional elbow override changes only an in-memory candidate, never the recipe.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vector3, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS, type BodyVariantId } from '../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../src/services/anatomicPose';
import { UPPER_ASSESSMENT_MOTIONS } from '../src/services/assessmentUpperMotions';
import { createArmTorsoContact } from '../src/services/armTorsoContact';
import { captureJointAngleRestReference } from '../src/services/jointAngles';
import { authoredToTrajectoryTimeMap, sampleComposedMotion } from '../src/services/motionRecording';
import { resolveComposedMotion } from '../src/services/motionSequence';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../src/services/poseRig';
import { armHeadContact } from '../src/__tests__/helpers/armHeadContact';

type Side = 'L' | 'R';
const opposite = (side: Side): Side => side === 'L' ? 'R' : 'L';
const repository = fileURLToPath(new URL('../', import.meta.url));
const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${repository.replaceAll('\\', '/').replace(/\/$/, '')}`, ...args], { cwd: repository, encoding: 'utf8' }).trim();
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const output = process.argv[2] && resolve(process.argv[2]);
const elbowDeg = process.argv[3] === undefined ? null : Number(process.argv[3]);
if (!output || existsSync(output)) throw Error('Provide a fresh output JSON path; existing evidence is never replaced.');
if (elbowDeg !== null && (!Number.isFinite(elbowDeg) || elbowDeg < 0 || elbowDeg > 150)) throw Error('Elbow candidate must be within 0..150 degrees.');
const sourceFiles = git('ls-files', 'src', 'models', 'package.json', 'package-lock.json', 'tsconfig.json').split('\n').filter(Boolean);
const sourceHashes = () => Object.fromEntries(sourceFiles.map(path => [path, sha256(readFileSync(resolve(repository, path)))]));
const source = sourceHashes();
const sourceDigest = sha256(JSON.stringify(source));
const sourceRevision = git('rev-parse', 'HEAD');
const sourceStatus = git('status', '--porcelain');
const rows = [];
for (const variant of ['female', 'male', 'neutral'] as BodyVariantId[]) {
  const cfg = BODY_VARIANTS[variant];
  const bytes = readFileSync(resolve(repository, `models/painmap3D_${variant}.runtime.glb`));
  const { scene: root } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  root.scale.setScalar(cfg.pose.rootScale);
  applyAnatomicPose(root, cfg);
  root.updateMatrixWorld(true);
  const meshes: SkinnedMesh[] = [];
  root.traverse(object => { if ((object as SkinnedMesh).isSkinnedMesh) meshes.push(object as SkinnedMesh); });
  const skinned = meshes[0];
  if (!skinned) throw Error(`Missing skinned model: ${variant}`);
  const bones = buildBoneByPoseKey(skinned.skeleton, cfg);
  const rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant);
  const world = (key: string) => {
    const bone = bones.get(key);
    if (!bone) throw Error(`Missing landmark bone: ${key}`);
    return bone.getWorldPosition(new Vector3());
  };
  for (const side of ['L', 'R'] as Side[]) for (const id of ['ue-pattern1', 'shoulder-mobility'] as const) {
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    applyCustomPose(skinned.skeleton, cfg, baselinePose);
    root.updateMatrixWorld(true);
    // Capture attachment exemptions at neutral, before sampling mutates the rig.
    const torso = createArmTorsoContact(root);
    if (!torso) throw Error(`Missing torso/arm skin: ${variant}`);
    const lowerSide = id === 'shoulder-mobility' ? opposite(side) : side;
    const motion = UPPER_ASSESSMENT_MOTIONS[id](side);
    if (elbowDeg !== null) {
      const target = motion.keyframes[2].targets!.find(t => t.joint === `${lowerSide}_Forearm` && t.motion === 'elbowFlexion');
      if (!target) throw Error('Missing lower elbow peak target');
      target.targetDegrees = elbowDeg;
    }
    const resolved = resolveComposedMotion(motion, cfg);
    const recording = sampleComposedMotion(resolved, { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60 });
    const durationMs = recording.frames.at(-1)!.tMs;
    const map = authoredToTrajectoryTimeMap(resolved, durationMs);
    const peak = motion.keyframes[2];
    const authoredHoldMidpointMs = motion.keyframes.slice(0, 2).reduce((sum, k) => sum + k.durationMs + (k.holdMs ?? 0), 0) + peak.durationMs + (peak.holdMs ?? 0) / 2;
    const assessedTimeMs = map.toTrajectory(authoredHoldMidpointMs);
    const assessedIndex = recording.frames.reduce((best, f, i) => Math.abs(f.tMs - assessedTimeMs) < Math.abs(recording.frames[best].tMs - assessedTimeMs) ? i : best, 0);
    const indices = new Set(recording.frames.map((_, i) => i).filter(i => i % 6 === 0));
    indices.add(assessedIndex);
    indices.add(recording.frames.length - 1);
    const skinSamples = [];
    for (const i of [...indices].sort((a, b) => a - b)) {
      const frame = recording.frames[i];
      root.position.fromArray(frame.root.translateM);
      root.quaternion.fromArray(frame.root.orientQuat);
      applyCustomPose(skinned.skeleton, cfg, frame.pose);
      root.updateMatrixWorld(true);
      torso.refresh();
      const head = armHeadContact(root, bones.get('Neck_Lower')!);
      const wrist = world(`${lowerSide}_Hand`);
      const distalMiddleJoint = world(`${lowerSide}_Mid3`);
      const upperSpine = world('Spine_Upper');
      const palmNormal = world(`${lowerSide}_Mid1`).sub(wrist).cross(world(`${lowerSide}_Pinky1`).sub(world(`${lowerSide}_Index1`))).normalize().multiplyScalar(lowerSide === 'R' ? 1 : -1);
      skinSamples.push({
        tMs: frame.tMs, assessed: i === assessedIndex,
        wristM: wrist.toArray(), distalMiddleJointM: distalMiddleJoint.toArray(),
        elbowM: world(`${lowerSide}_Forearm`).toArray(), upperSpineM: upperSpine.toArray(),
        wristRelativeUpperSpineM: wrist.clone().sub(upperSpine).toArray(),
        distalMiddleRelativeUpperSpineM: distalMiddleJoint.clone().sub(upperSpine).toArray(),
        palmNormal: palmNormal.toArray(),
        oppositeShoulderHeightAboveDistalMiddleM: world(`${opposite(lowerSide)}_UpperArm`).y - distalMiddleJoint.y,
        // Mid3 is a distal finger JOINT, not a measured fingertip or scapular target.
        lowerTorsoPenetrationM: torso.inspect(lowerSide).penetrationM,
        lowerHeadPenetrationM: head(lowerSide),
        otherTorsoPenetrationM: torso.inspect(opposite(lowerSide)).penetrationM,
        otherHeadPenetrationM: head(opposite(lowerSide)),
      });
    }
    const assessedFrame = recording.frames[assessedIndex];
    const capacities = recording.frames.map(f => f.shoulders?.[lowerSide].capacity);
    if (capacities.some(c => !c || c.enforced !== true || c.excessDeg === null)) throw Error('Missing enforced capacity measurements');
    const fieldRanges = (joint: string) => Object.fromEntries(Object.keys(assessedFrame.angles[joint] ?? {}).map(field => {
      const values = recording.frames.map(f => f.angles[joint]?.[field]).filter(Number.isFinite);
      return [field, { min: Math.min(...values), max: Math.max(...values), assessed: assessedFrame.angles[joint][field] }];
    }));
    const row = {
      variant, id, selectedSide: side, lowerSide, durationMs, frameCount: recording.frames.length,
      authoredHoldMidpointMs, assessedTimeMs, assessedSampleTimeMs: assessedFrame.tMs,
      requestedPeakTargets: peak.targets!.filter(t => t.joint.startsWith(`${lowerSide}_`)),
      noncompliantOutcomes: resolved.outcomes.filter(o => o.status !== 'complied'),
      lowerCapacityMaxExcessDeg: Math.max(...capacities.map(c => c!.excessDeg!)),
      lowerCapacityMinMarginDeg: Math.min(...capacities.map(c => c!.marginDeg!)),
      measuredRanges: Object.fromEntries(['Shoulder', 'UpperArm', 'Forearm', 'Hand'].map(name => [`${lowerSide}_${name}`, fieldRanges(`${lowerSide}_${name}`)])),
      assessedShoulder: assessedFrame.shoulders?.[lowerSide],
      assessed: skinSamples.find(s => s.assessed)!,
      maxLowerTorsoPenetrationM: Math.max(...skinSamples.map(s => s.lowerTorsoPenetrationM)),
      maxLowerHeadPenetrationM: Math.max(...skinSamples.map(s => s.lowerHeadPenetrationM)),
      maxOtherTorsoPenetrationM: Math.max(...skinSamples.map(s => s.otherTorsoPenetrationM)),
      maxOtherHeadPenetrationM: Math.max(...skinSamples.map(s => s.otherHeadPenetrationM)),
      skinSamples,
    };
    rows.push(row);
    console.log(JSON.stringify({ variant, id, lowerSide, wristM: row.assessed.wristRelativeUpperSpineM, lowerTorsoM: row.maxLowerTorsoPenetrationM, capacityExcessDeg: row.lowerCapacityMaxExcessDeg }));
  }
}
if (sourceDigest !== sha256(JSON.stringify(sourceHashes())) || sourceRevision !== git('rev-parse', 'HEAD')) throw Error('Source changed during measurement; results not written.');
writeFileSync(output, JSON.stringify({
  at: new Date().toISOString(), sourceRevision, sourceStatus, sourceDigest, source,
  diagnosticSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  candidate: elbowDeg === null ? null : { peakLowerElbowDeg: elbowDeg },
  sampleHz: 60, skinInspectHz: 10, clinicalScapularTarget: null,
  method: 'Production sampler and runtime assets. Skin at 10 Hz plus assessed hold and final frame. Conservative torso/head convex envelopes; neutral arm attachment seams excluded before sampling, torso and head envelopes refreshed each inspected frame. Wrist/Mid3 bone observables only; no scapular calibration, exact surface contact, between-sample clearance, live-host parity or clinical acceptance established.',
  rows,
}, null, 2) + '\n', { flag: 'wx' });
