/** Compare Blender-exported playback with the original engine measurements. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const folder = process.argv[2] && resolve(process.argv[2]);
if (!folder) throw Error('Provide the Blender review folder');
const resultPath = resolve(folder, 'roundtrip-results.json');
if (existsSync(resultPath)) throw Error('Do not overwrite existing evidence');
const manifest = JSON.parse(readFileSync(resolve(folder, 'manifest.json'), 'utf8'));
const results = [];
const toleranceM = 0.0001;
const gridSize = 0.005;
for (const entry of manifest.cases) {
  const bytes = readFileSync(resolve(folder, 'roundtrip', entry.file));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  if (!gltf.animations.length) throw Error(`No round-trip animation: ${entry.id}`);
  const root = gltf.scene;
  const mixer = new THREE.AnimationMixer(root);
  for (const clip of gltf.animations) {
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
  }
  const data = JSON.parse(readFileSync(resolve(folder, entry.expected), 'utf8'));
  const meshes: THREE.SkinnedMesh[] = [];
  const bones = new Map<string, THREE.Bone>();
  root.traverse(object => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh);
    if ((object as THREE.Bone).isBone) bones.set(object.name, object as THREE.Bone);
  });
  const checkpoints = [];
  for (const expected of data.expected) {
    mixer.setTime(expected.timeSec);
    root.updateMatrixWorld(true);
    const boneErrors = Object.entries(expected.bones as Record<string, number[]>).map(([name, point]) => {
      if (!bones.has(name)) throw Error(`Missing bone ${name} in ${entry.id}`);
      return { name, errorM: bones.get(name)!.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(point)) };
    });
    const cells = new Map<string, THREE.Vector3[]>();
    for (const mesh of meshes) {
      const positions = mesh.geometry.getAttribute('position');
      for (let index = 0; index < positions.count; index++) {
        const point = new THREE.Vector3().fromBufferAttribute(positions, index);
        mesh.applyBoneTransform(index, point); point.applyMatrix4(mesh.matrixWorld);
        const key = point.toArray().map(n => Math.floor(n / gridSize)).join(',');
        const cell = cells.get(key) ?? []; cell.push(point); cells.set(key, cell);
      }
    }
    let outsideSearch = 0;
    const skinErrors = (expected.skinPointsM as number[][]).map(value => {
      const point = new THREE.Vector3().fromArray(value);
      const [cx, cy, cz] = value.map(n => Math.floor(n / gridSize));
      let distance = Infinity;
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        for (const candidate of cells.get(`${cx + x},${cy + y},${cz + z}`) ?? []) distance = Math.min(distance, candidate.distanceTo(point));
      }
      if (!Number.isFinite(distance)) { outsideSearch++; return gridSize; }
      return distance;
    });
    const worstBone = boneErrors.reduce((a, b) => a.errorM > b.errorM ? a : b);
    checkpoints.push({ timeSec: expected.timeSec, maxBoneErrorM: worstBone.errorM, worstBone: worstBone.name,
      maxSkinNearestVertexErrorM: Math.max(...skinErrors), skinPointsOutsideSearch: outsideSearch });
  }
  const row = { id: entry.id, checkpoints, maxBoneErrorM: Math.max(...checkpoints.map(p => p.maxBoneErrorM)),
    maxSkinErrorM: Math.max(...checkpoints.map(p => p.maxSkinNearestVertexErrorM)),
    passed: checkpoints.every(p => p.maxBoneErrorM <= toleranceM && p.maxSkinNearestVertexErrorM <= toleranceM && !p.skinPointsOutsideSearch) };
  results.push(row);
  console.log(JSON.stringify({ ...row, checkpoints: undefined }));
}
writeFileSync(resultPath, JSON.stringify({ at: new Date().toISOString(), sourceRevision: manifest.sourceRevision, expectedSource: manifest.expectedSource ?? 'Engine reference',
  toleranceM, method: 'Original bone-head and rendered skin samples compared with exported glTF replay in Three.js. Nearest-vertex search within neighboring 5 mm cells; any missing neighbor fails. Original vertex indices are not assumed to survive export.', cases: results }, null, 2) + '\n', { flag: 'wx' });
if (results.some(row => !row.passed)) throw Error('Round-trip comparison failed; evidence preserved');
