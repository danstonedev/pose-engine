/** Quick actual-rig continuity diagnosis before a fresh Blender capture.
 * <motion.json> <fresh-report.json> [male|female|neutral|all]
 * Records source observations; does not establish skin/native/clinical approval.
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
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';

const [input, output, filter = 'all'] = process.argv.slice(2);
if (!input || !output) throw Error('Provide motion and fresh report path');
const engine = fileURLToPath(new URL('../../', import.meta.url));
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(path, entry.name)) : [resolve(path, entry.name)]).sort();
const digest = () => hash(files(resolve(engine, 'src')).map(path => relative(engine, path).replaceAll('\\', '/') + ':' + hash(readFileSync(path))).join('\n'));
const motion = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
const report: any = { sourceBefore: digest(), motionSha256: hash(readFileSync(input)), scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), sampleHz: 60,
  scope: 'Actual final source bones including production twist. Adjacent-step observations, source phase labels and loop seam; no new clinical/contact threshold.', cases: [] };
const phase = (t: number) => {
  let elapsed = 0;
  for (const [index, frame] of motion.keyframes.entries()) {
    const end = elapsed + frame.durationMs, holdEnd = end + (frame.holdMs ?? 0);
    if (t <= holdEnd + .001) return `${index}:${frame.control?.id ?? 'undeclared'}:${t > end + .001 ? 'hold' : 'move'}`;
    elapsed = holdEnd;
  }
  return 'after';
};
for (const variant of ['male', 'female', 'neutral'] as const) {
  if (filter !== 'all' && filter !== variant) continue;
  const cfg = BODY_VARIANTS[variant], bytes = readFileSync(resolve(engine, 'models', `painmap3D_${variant}.runtime.glb`));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skinned!: THREE.SkinnedMesh;
  root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
  const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  const twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
  const started = performance.now();
  const recording = sampleComposedMotion(resolveComposedMotion(motion, cfg), { baselinePose, rest, variantCfg: cfg, skeletonHarness: { root, skinned }, sampleHz: 60 });
  const row: any = { variant, sourceModelSha256: hash(bytes), elapsedMs: performance.now() - started, frames: recording.frames.length, phases: {}, seam: {}, trace: [], layout: recording.frames[0]?.pronePalmLayout };
  type State = { p: THREE.Vector3; q: THREE.Quaternion }[];
  let first: State | undefined, previous: State | undefined;
  for (const [index, frame] of recording.frames.entries()) {
    root.position.fromArray(frame.root.translateM); root.quaternion.fromArray(frame.root.orientQuat); applyCustomPose(skinned.skeleton, cfg, frame.pose);
    twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true);
      const state = skinned.skeleton.bones.map(bone => ({ p: bone.getWorldPosition(new THREE.Vector3()), q: bone.quaternion.clone().normalize() }));
      first ??= state;
      if (previous) {
        const key = phase(frame.tMs), summary = row.phases[key] ??= { rotationDeg: 0, translationM: 0 };
        for (const [joint, value] of state.entries()) {
          const degrees = THREE.MathUtils.radToDeg(value.q.angleTo(previous[joint]!.q)), distance = value.p.distanceTo(previous[joint]!.p);
          const witness = { bone: skinned.skeleton.bones[joint]!.name, fromMs: recording.frames[index - 1]!.tMs, toMs: frame.tMs };
          if (degrees > summary.rotationDeg) { summary.rotationDeg = degrees; summary.rotationWitness = witness; }
          if (distance > summary.translationM) { summary.translationM = distance; summary.positionWitness = witness; }
        }
      }
      previous = state;
      if (index === recording.frames.length - 1) {
        row.seam = { rotationDeg: Math.max(...state.map((value, joint) => THREE.MathUtils.radToDeg(value.q.angleTo(first![joint]!.q)))), translationM: Math.max(...state.map((value, joint) => value.p.distanceTo(first![joint]!.p))) };
      }
    });
    if (index % 5 === 0) row.trace.push({ tMs: frame.tMs, left: frame.angles.L_Forearm?.elbowFlexion, right: frame.angles.R_Forearm?.elbowFlexion });
  }
  report.cases.push(row); console.log(JSON.stringify({ ...row, trace: undefined, layout: undefined }));
}
report.sourceAfter = digest(); report.sourceStable = report.sourceAfter === report.sourceBefore;
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
