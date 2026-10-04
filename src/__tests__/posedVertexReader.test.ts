import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { createStageTwistOverlay } from '../services/stageTwistOverlay';
import { createPosedVertexReader } from '../services/posedGeometry';

// Geometry equivalence checks, not anatomical acceptance of the probe poses.
it.each(['male', 'female', 'neutral'] as const)('%s CPU palette matches Three skin exactly across changed poses and render twist', async variant => {
  const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  const cfg = BODY_VARIANTS[variant]; root.scale.setScalar(cfg.pose.rootScale);
  applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
  const skins: THREE.SkinnedMesh[] = [];
  root.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) skins.push(node as THREE.SkinnedMesh); });
  const reader = createPosedVertexReader(), twist = createStageTwistOverlay();
  twist.reset(skins[0]!.skeleton, cfg);
  const expected = new THREE.Vector3(), actual = new THREE.Vector3();
  let compared = 0;
  for (const phase of [0, 1, 2]) {
    root.position.set(.2 * phase, -.13 * phase, .17 * phase); root.rotation.y = .35 * phase;
    for (const bone of skins[0]!.skeleton.bones) if (/Waist|Thigh|Calf|Forearm/.test(bone.name)) bone.rotateX(.07 * phase);
    twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true); reader.beginMeasurement();
      for (const skin of skins) for (let vertex = 0; vertex < skin.geometry.getAttribute('position').count; vertex += 19) {
        skin.getVertexPosition(vertex, expected);
        reader.getVertexPosition(skin, vertex, actual);
        expect(actual.toArray()).toEqual(expected.toArray()); compared++;
      }
    });
  }
  expect(compared).toBeGreaterThan(1000);
});

it.each([false, true])('preserves morphs (relative=%s), normalized weights, interleaved indices and custom surfaces', relative => {
  const root = new THREE.Group(), a = new THREE.Bone(), b = new THREE.Bone(); a.add(b); b.position.y = .7; root.add(a);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([.2, .4, .6, -.1, .5, .3], 3));
  geometry.setAttribute('skinIndex', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Uint16Array([0, 1, 0, 0, 99, 1, 0, 0, 0, 99]), 5), 4, 0));
  geometry.setAttribute('skinWeight', new THREE.Uint8BufferAttribute([127, 128, 0, 0, 200, 55, 0, 0], 4, true));
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([.1, .2, -.1, .3, -.2, .4], 3)];
  geometry.morphTargetsRelative = relative;
  const mesh = new THREE.SkinnedMesh(geometry); root.add(mesh); root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([a, b])); mesh.updateMorphTargets(); mesh.morphTargetInfluences![0] = .6;
  a.rotateZ(.2); b.rotateX(-.4); root.position.set(.3, -.5, .1); root.updateMatrixWorld(true);
  const reader = createPosedVertexReader(), actual = new THREE.Vector3(), expected = new THREE.Vector3();
  for (const change of [0, 1]) {
    b.rotateZ(.11 * change); mesh.morphTargetInfluences![0] += .1 * change;
    root.updateMatrixWorld(true); reader.beginMeasurement();
    for (const vertex of [0, 1]) expect(reader.getVertexPosition(mesh, vertex, actual).toArray()).toEqual(mesh.getVertexPosition(vertex, expected).toArray());
  }
  mesh.getVertexPosition = (_index, target) => target.set(1, 2, 3);
  expect(reader.getVertexPosition(mesh, 0, actual).toArray()).toEqual([1, 2, 3]);
});
