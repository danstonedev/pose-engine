/** Warm guide cache after a controlled in-memory pelvis skin edit versus fresh rig.
 * No production assets are written. <fresh-report.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { serializeCustomPose, applyCustomPose } from '../../src/services/poseRig';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { BODY_ASSESSMENT_MOTIONS } from '../../src/services/assessmentBodyMotions';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
import * as Contact from '../../src/services/footContact';
setRomClampEnabled(false);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const files = ['footContact', 'handContactPose', 'motionRecording', 'proneSkinSupport', 'motionRigInputKey'];
const identity = () => Object.fromEntries(files.map(name => [name, digest(readFileSync(new URL(`../../src/services/${name}.ts`, import.meta.url)))]));
const report: any = { before: identity(), scope: 'Actual male rig; controlled5mm anterior movement of pelvis-owned skin vertices in memory, no production asset edit. Authored palm anchor fit disabled so fixed placement remains the same. Warm guide after geometry edit compared with fresh-cache edited rig.', runs: [] };
let guideCalls: any[] = [], lastPaths: unknown[] = [];
const original = Contact.preparePalmSupportApproach, descriptor = Object.getOwnPropertyDescriptor(Contact, 'preparePalmSupportApproach')!;
Object.defineProperty(Contact, 'preparePalmSupportApproach', { configurable: true, value: (...args: Parameters<typeof original>) => {
  const poseAt = args[4]; let calls = 0; args[4] = time => { calls++; poseAt(time); };
  original(...args);
  const paths = args[0].filter(p => p.palmApproach?.path).map(p => p.palmApproach!.path);
  guideCalls.push({ calls, reusedPathObjects: paths.map((p, i) => p === lastPaths[i]) }); lastPaths = paths;
} });
const cfg = BODY_VARIANTS.male, bytes = readFileSync(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url));
const createRig = async () => {
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  let skin!: THREE.SkinnedMesh; root.traverse(n => { if (!skin && (n as THREE.SkinnedMesh).isSkinnedMesh) skin = n as THREE.SkinnedMesh; });
  return { root, skin, baseline: serializeCustomPose(skin.skeleton, cfg, 'male'), rest: captureJointAngleRestReference(skin.skeleton, cfg), position: root.position.clone(), quaternion: root.quaternion.clone() };
};
let peakWitness: { mesh: string; vertex: number };
const edit = (rig: Awaited<ReturnType<typeof createRig>>) => {
  let changed = 0;
  rig.root.traverse(node => {
    const mesh = node as THREE.SkinnedMesh; if (!mesh.isSkinnedMesh) return;
    const p = mesh.geometry.getAttribute('position'), ids = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
    for (let i = 0; i < p.count; i++) {
      if (mesh.name !== peakWitness.mesh || i !== peakWitness.vertex) continue;
      let owner = 0, weight = -1; for (let j = 0; j < weights.itemSize; j++) if (weights.getComponent(i, j) > weight) { owner = ids.getComponent(i, j); weight = weights.getComponent(i, j); }
      if (!/Hip$|Pelvis$/.test(mesh.skeleton.bones[owner]?.name ?? '')) continue;
      const source = [p.getX(i), p.getY(i), p.getZ(i)], origin = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      const columns = [0, 1, 2].map(axis => {
        const next = [...source]; next[axis]! += 1; p.setXYZ(i, next[0]!, next[1]!, next[2]!);
        const response = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).sub(origin);
        p.setXYZ(i, source[0]!, source[1]!, source[2]!); return response;
      });
      const jacobian = new THREE.Matrix3().set(columns[0]!.x, columns[1]!.x, columns[2]!.x, columns[0]!.y, columns[1]!.y, columns[2]!.y, columns[0]!.z, columns[1]!.z, columns[2]!.z);
      const localDelta = new THREE.Vector3(0, 0, .005).applyMatrix3(jacobian.invert());
      p.setXYZ(i, source[0]! + localDelta.x, source[1]! + localDelta.y, source[2]! + localDelta.z); changed++;
      report.measuredEdits ??= []; report.measuredEdits.push({ mesh: mesh.name, vertex: i, worldDelta: mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).sub(origin).toArray() });
    }
    p.needsUpdate = true;
  });
  return changed;
};
const sample = (rig: Awaited<ReturnType<typeof createRig>>, label: string) => {
  rig.root.position.copy(rig.position); rig.root.quaternion.copy(rig.quaternion); applyCustomPose(rig.skin.skeleton, cfg, rig.baseline); rig.root.updateMatrixWorld(true);
  const motion = BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'); motion.pronePalmAnchorFit = false;
  guideCalls = [];
  const rec = sampleComposedMotion(resolveComposedMotion(motion, cfg), { baselinePose: rig.baseline, rest: rig.rest, variantCfg: cfg,
    skeletonHarness: { root: rig.root, skinned: rig.skin }, frameTimesMs: [0, 1000, 2500, 4100, 5400], sampleHz: 60 });
  report.runs.push({ label, guideCalls, roots: rec.frames.map(f => f.root), support: rec.frames.map(f => f.proneSupport) });
  return rec;
};
try {
  const warmRig = await createRig(); const original = sample(warmRig, 'warm-original');
  peakWitness = original.frames[2]!.proneSupport!.regions.pelvis;
  warmRig.root.position.copy(warmRig.position); warmRig.root.quaternion.copy(warmRig.quaternion); applyCustomPose(warmRig.skin.skeleton, cfg, warmRig.baseline); warmRig.root.updateMatrixWorld(true);
  report.changedVertices = edit(warmRig); if (!report.changedVertices) throw Error('No pelvis skin selected');
  const warm = sample(warmRig, 'warm-edited');
  const freshRig = await createRig(); report.changedFreshVertices = edit(freshRig);
  const fresh = sample(freshRig, 'fresh-edited');
  report.maxRotationDeg = { value: 0 }; report.maxTrackedPositionM = { value: 0 };
  warm.frames.forEach((a, i) => {
    const b = fresh.frames[i]!;
    for (const [key, q] of Object.entries(a.pose.bones)) {
      const value = new THREE.Quaternion().fromArray(q).normalize().angleTo(new THREE.Quaternion().fromArray(b.pose.bones[key]!).normalize()) * 180 / Math.PI;
      if (value > report.maxRotationDeg.value) report.maxRotationDeg = { value, key, tMs: a.tMs };
    }
    for (const [key, p] of Object.entries(a.worldTracks!)) {
      const value = new THREE.Vector3().fromArray(p).distanceTo(new THREE.Vector3().fromArray(b.worldTracks![key]!));
      if (value > report.maxTrackedPositionM.value) report.maxTrackedPositionM = { value, key, tMs: a.tMs };
    }
  });
} finally { Object.defineProperty(Contact, 'preparePalmSupportApproach', descriptor); }
report.after = identity(); report.sourceStable = JSON.stringify(report.before) === JSON.stringify(report.after);
writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ sourceStable: report.sourceStable, changedVertices: report.changedVertices, runs: report.runs.map((r: any) => ({ label: r.label, guideCalls: r.guideCalls })), maxRotationDeg: report.maxRotationDeg, maxTrackedPositionM: report.maxTrackedPositionM }));
