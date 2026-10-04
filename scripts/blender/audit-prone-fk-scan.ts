/** Historical diagnostic for the rejected FK-only guide scan API.
 * The production API was reverted after neutral restricted-patient parity failed.
 * Re-run only against the experimental source identities retained in its report.
 */
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
import * as Contact from '../../src/services/footContact';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';

setRomClampEnabled(false);

const sourceFiles = ['assessmentBodyMotions', 'motionRecording', 'motionTrajectory', 'footContact', 'handContactPose', 'proneSkinSupport', 'poseRomClamp', 'pressupPalmLayout'];
const hashes = () => Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url))).digest('hex')]));
const report: any = { before: hashes(), poseModeClampEnabled: false, sampleHz: 60, boneToleranceDeg: .01, worldToleranceM: .0001,
  scope: 'Actual production rigs, fresh root/skeleton per mode to isolate caches; all 325 frames. Optimized FK-only bend scan compared with supported-pose fallback, same exact guide knots. All 101 replayed bone worlds include rendered twist. Existing parity thresholds; not visual/native acceptance.', cases: [] };
const descriptor = Object.getOwnPropertyDescriptor(Contact, 'preparePalmSupportApproach')!;
if (!descriptor.configurable) throw Error('ViteNode export instrumentation unavailable');
const original = Contact.preparePalmSupportApproach;
let currentMode: 'optimized' | 'fallback' = 'optimized', probes: any[] = [];
Object.defineProperty(Contact, 'preparePalmSupportApproach', { configurable: true,
  value: (...args: Parameters<typeof original>) => {
    if (typeof args[8] !== 'function') throw Error('The experimental FK-only scan API is absent; its production callers were reverted after failed patient parity.');
    const raw = currentMode === 'fallback' ? args[4] : args[8] ?? args[4];
    const rows: any[] = []; probes.push(rows);
    args[8] = (tMs: number) => {
      raw(tMs);
      rows.push({ tMs, bends: args[0].filter(plant => plant.palmSupport && plant.holdOrientation).map(plant => {
        const shoulder = plant.solver.ctx.bones[2]!.getWorldPosition(new THREE.Vector3());
        const elbow = plant.solver.ctx.bones[1]!.getWorldPosition(new THREE.Vector3());
        const wrist = plant.solver.ctx.bones[0]!.getWorldPosition(new THREE.Vector3());
        return Math.PI - shoulder.sub(elbow).angleTo(wrist.sub(elbow));
      }) });
    };
    return original(...args);
  },
});
const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -10, max: 10 } } }, L_Forearm: { elbowFlexion: { availableRange: { min: 110, max: 125 } } }, R_Forearm: { elbowFlexion: { availableRange: { min: 40, max: 70 } } } };
try {
  for (const variant of ['male', 'female', 'neutral'] as const) for (const patient of [false, true]) {
    const cfg = BODY_VARIANTS[variant], cases: any[] = [];
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    for (const mode of ['optimized', 'fallback'] as const) {
      currentMode = mode; probes = [];
      const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
      root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
      let skinned!: THREE.SkinnedMesh; root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
      const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
      const position = root.position.clone(), quaternion = root.quaternion.clone(), twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
      const start = performance.now();
      const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
        baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 60, ...(patient ? { constraints } : {}),
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
      cases.push({ mode, elapsedMs, frames, probes, boneCount: skinned.skeleton.bones.length });
    }
    const [optimized, fallback] = cases;
    const row: any = { variant, patient, sourceModelSha256: createHash('sha256').update(bytes).digest('hex'), frames: optimized.frames.length,
      boneCount: optimized.boneCount, elapsedMs: Object.fromEntries(cases.map(item => [item.mode, item.elapsedMs])),
      maxLocalBoneDeg: { value: 0 }, maxWorldBoneDeg: { value: 0 }, maxBonePositionM: { value: 0 }, maxPalmPositionM: { value: 0 },
      maxRawBendDifferenceDeg: 0, maxAngleDifferenceDeg: { value: 0 }, patientViolations: [], differences: [] };
    const record = (name: string, value: number, tMs: number, key: string) => { if (value > row[name].value) row[name] = { value, tMs, key }; };
    for (let i = 0; i < optimized.frames.length; i++) {
      const a = optimized.frames[i], b = fallback.frames[i], tMs = a.frame.tMs;
      if (tMs !== b.frame.tMs) throw Error('Frame clocks differ');
      for (const [key, raw] of Object.entries(a.frame.pose.bones)) {
        const value = new THREE.Quaternion().fromArray(raw as number[]).normalize().angleTo(new THREE.Quaternion().fromArray(b.frame.pose.bones[key]).normalize()) * 180 / Math.PI;
        record('maxLocalBoneDeg', value, tMs, key);
      }
      for (const [key, raw] of Object.entries(a.bones) as [string, any][]) {
        record('maxWorldBoneDeg', new THREE.Quaternion().fromArray(raw.quaternion).angleTo(new THREE.Quaternion().fromArray(b.bones[key].quaternion)) * 180 / Math.PI, tMs, key);
        record('maxBonePositionM', new THREE.Vector3().fromArray(raw.position).distanceTo(new THREE.Vector3().fromArray(b.bones[key].position)), tMs, key);
      }
      for (const side of ['L', 'R']) record('maxPalmPositionM', new THREE.Vector3().fromArray(a.frame.worldTracks[`${side}_Hand`]).distanceTo(new THREE.Vector3().fromArray(b.frame.worldTracks[`${side}_Hand`])), tMs, side);
      for (const [key, fields] of Object.entries(a.frame.angles) as [string, Record<string, number>][]) for (const [field, value] of Object.entries(fields)) {
        if (Number.isFinite(value) && Number.isFinite(b.frame.angles[key]?.[field])) record('maxAngleDifferenceDeg', Math.abs(value - b.frame.angles[key][field]), tMs, `${key}.${field}`);
      }
      if (patient) for (const result of [a.frame, b.frame]) for (const [key, fields] of Object.entries(constraints)) for (const [field, spec] of Object.entries(fields)) {
        const value = result.angles[key][field], range = spec.availableRange;
        if (!Number.isFinite(value) || value < range.min - .01 || value > range.max + .01) row.patientViolations.push({ tMs, key, field, value, range });
      }
    }
    const activeProbes = (item: any) => item.probes.filter((scan: any[]) => scan.length);
    const aProbes = activeProbes(optimized), bProbes = activeProbes(fallback);
    if (aProbes.length !== bProbes.length) throw Error('Raw scan counts differ');
    aProbes.forEach((scan: any[], scanIndex: number) => scan.forEach((sample, frameIndex) => {
      const other = bProbes[scanIndex][frameIndex];
      if (sample.tMs !== other.tMs) throw Error('Raw scan clocks differ');
      sample.bends.forEach((bend: number, side: number) => { row.maxRawBendDifferenceDeg = Math.max(row.maxRawBendDifferenceDeg, Math.abs(bend - other.bends[side]) * 180 / Math.PI); });
    }));
    row.pass = row.maxLocalBoneDeg.value < report.boneToleranceDeg && row.maxWorldBoneDeg.value < report.boneToleranceDeg
      && row.maxBonePositionM.value < report.worldToleranceM && row.maxPalmPositionM.value < report.worldToleranceM && !row.patientViolations.length;
    if (!row.pass) process.exitCode = 1;
    report.cases.push(row); console.log(JSON.stringify(row));
  }
} finally { Object.defineProperty(Contact, 'preparePalmSupportApproach', descriptor); }
report.after = hashes(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
