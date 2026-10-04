import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey } from '../../src/services/poseRig';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
const [input, output] = process.argv.slice(2); if (!input || !output) throw Error('Supply captured host frames and fresh report');
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const inputBytes = readFileSync(input), source = JSON.parse(inputBytes.toString('utf8')), row = source.cases[0];
if (row.variant !== 'male' || !row.samples.every((s: any) => s.expectedFrame && s.actualFrame)) throw Error('Expected full male frame capture');
const cfg = BODY_VARIANTS.male, bytes = readFileSync(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url));
const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
const meshes: THREE.SkinnedMesh[] = []; root.traverse(n => { if ((n as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(n as THREE.SkinnedMesh); });
const skin = meshes[0]!, bones = buildBoneByPoseKey(skin.skeleton, cfg), twist = createStageTwistOverlay(); twist.reset(skin.skeleton, cfg);
setRomClampEnabled(false);
const membership = meshes.map(mesh => {
  const index = mesh.geometry.getAttribute('skinIndex'), weight = mesh.geometry.getAttribute('skinWeight');
  return Array.from({ length: index.count }, (_, vertex) => {
    let dominant = -1, biggest = -1; const handWeight = { L: 0, R: 0 };
    for (let slot = 0; slot < weight.itemSize; slot++) {
      const bone = mesh.skeleton.bones[index.getComponent(vertex, slot)]!, value = weight.getComponent(vertex, slot);
      if (value > biggest) { biggest = value; dominant = index.getComponent(vertex, slot); }
      for (const side of ['L', 'R'] as const) { let ancestor: THREE.Object3D | null = bone; const hand = bones.get(`${side}_Hand`); while (ancestor && ancestor !== hand) ancestor = ancestor.parent; if (ancestor === hand) handWeight[side] += value; }
    }
    return ['L', 'R'].flatMap(side => [
      ...(handWeight[side as 'L' | 'R'] >= .5 ? [`${side}_handSkin`] : []),
      ...(mesh.skeleton.bones[dominant] === bones.get(`${side}_Hand`) ? [`${side}_palmSkin`] : []),
    ]);
  });
});
const point = new THREE.Vector3();
const reconstruct = (frame: any) => {
  root.position.fromArray(row.setup.rootRest.position).add(new THREE.Vector3().fromArray(frame.root.translateM));
  root.quaternion.fromArray(row.setup.rootRest.quaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
  applyCustomPose(skin.skeleton, cfg, frame.pose);
  return twist.sampleWithTwist(() => {
    root.updateMatrixWorld(true); const bonePoints = Object.fromEntries([...bones].map(([key, bone]) => [key, bone.getWorldPosition(new THREE.Vector3()).toArray()]));
    const worldWitnesses = Object.entries(frame.worldTracks).filter(([key]) => key !== 'CoM');
    const witnessResidualM = Math.max(...worldWitnesses.map(([key, value]) => new THREE.Vector3().fromArray(value as number[]).distanceTo(new THREE.Vector3().fromArray(bonePoints[key]!))));
    const allBonePoints = Object.fromEntries(skin.skeleton.bones.map(bone => [bone.name, bone.getWorldPosition(new THREE.Vector3()).toArray()]));
    const minima: Record<string, { y: number; mesh: number; vertex: number; position: number[] }> = {};
    const positions = meshes.map((mesh, mi) => { mesh.skeleton.update(); const values = new Float64Array(mesh.geometry.getAttribute('position').count * 3); for (let vertex = 0; vertex < values.length / 3; vertex++) {
      mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld); values.set(point.toArray(), vertex * 3);
      for (const region of membership[mi]![vertex]!) if (!minima[region] || point.y < minima[region]!.y) minima[region] = { y: point.y, mesh: mi, vertex, position: point.toArray() };
    } return values; });
    return { bonePoints, allBonePoints, positions, minima, witnessResidualM, worldWitnessCount: worldWitnesses.length };
  });
};
const result: any = { inputSha256: hash(inputBytes), scriptSha256: hash(readFileSync(new URL(import.meta.url))), assetSha256: hash(bytes), runtimeStable: source.runtimeStable,
  scope: 'All public captured expected/actual male severe-patient poses replayed without solving on the actual asset with production twist overlay. Full skeleton is reconstructed from the 55 captured mapped locals plus asset baseline and production twist. Sixteen captured bone world points qualify replay; CoM is not a bone and is retained only in the original browser differences. Skin positions are reconstructed rendered skin, not independent native physics or live deformation measurements. Original acceptance gates unchanged.',
  floorY: 0, regions: 'handSkin: >=0.5 combined Hand+digit weight; palmSkin: dominant Hand bone; all skins also compared vertex-for-vertex.', cases: [] };
for (const sample of row.samples) {
  const expected = reconstruct(sample.expectedFrame), actual = reconstruct(sample.actualFrame);
  let allSkinMaximum = { meters: 0, mesh: -1, vertex: -1 }; const regionMaximum: Record<string, any> = {};
  for (const [mesh, positions] of expected.positions.entries()) for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const offset = vertex * 3, difference = Math.hypot(...[0, 1, 2].map(i => positions[offset + i]! - actual.positions[mesh]![offset + i]!));
    const witness = { meters: difference, mesh, vertex };
    if (difference > allSkinMaximum.meters) allSkinMaximum = witness;
    for (const region of membership[mesh]![vertex]!) if (!regionMaximum[region] || difference > regionMaximum[region].meters) regionMaximum[region] = witness;
  }
  const boneDifferences = Object.entries(expected.allBonePoints).map(([key, position]) => ({ key, meters: new THREE.Vector3().fromArray(position).distanceTo(new THREE.Vector3().fromArray(actual.allBonePoints[key]!)) }));
  result.cases.push({ tMs: sample.tMs, expectedBoneReplayResidualM: expected.witnessResidualM, actualBoneReplayResidualM: actual.witnessResidualM,
    boneCount: boneDifferences.length, replayWorldWitnessCount: expected.worldWitnessCount, boneDifferences, allSkinMaximum, regionMaximum, expectedFloorMinima: expected.minima, actualFloorMinima: actual.minima,
    originalLocalDifference: sample.maxBoneDifference, originalPointDifferences: sample.pointDifferences,
    patientBoundViolations: row.patientBoundViolations?.filter((v: any) => v.tMs === sample.tMs), supportFeasible: sample.support?.feasible });
}
result.replayQualified = result.cases.every((c: any) => Math.max(c.expectedBoneReplayResidualM, c.actualBoneReplayResidualM) < 1e-6);
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ replayQualified: result.replayQualified, phases: result.cases.map((c: any) => ({ tMs: c.tMs, bones: c.boneCount, skin: c.allSkinMaximum, hands: c.regionMaximum, replay: Math.max(c.expectedBoneReplayResidualM, c.actualBoneReplayResidualM) })) }));
