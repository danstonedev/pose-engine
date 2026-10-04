import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey, applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { setRomClampEnabled } from '../services/poseRomClamp';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { createStageTwistOverlay } from '../services/stageTwistOverlay';

afterEach(() => setRomClampEnabled(null));

describe.each(['male', 'female', 'neutral'] as const)('%s press-up rendered surface', variant => {
  it('supports actual bilateral hand skin at world zero throughout the 60 Hz trajectory', async () => {
    const cfg = BODY_VARIANTS[variant];
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    const skins: THREE.SkinnedMesh[] = [];
    root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skins.push(object as THREE.SkinnedMesh); });
    const skinned = skins[0]!;
    const bones = buildBoneByPoseKey(skinned.skeleton, cfg);
    const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant);
    const rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    const twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
    const members = ['L', 'R'].map(side => skins.map(mesh => {
      const hand = bones.get(`${side}_Hand`)!;
      const descendants = mesh.skeleton.bones.map(bone => {
        let ancestor: THREE.Object3D | null = bone;
        while (ancestor && ancestor !== hand) ancestor = ancestor.parent;
        return ancestor === hand;
      });
      const indices = mesh.geometry.getAttribute('skinIndex');
      const weights = mesh.geometry.getAttribute('skinWeight');
      const vertices: number[] = [], palmVertices: number[] = [];
      for (let vertex = 0; vertex < indices.count; vertex++) {
        let influence = 0, dominantWeight = -Infinity, dominantIndex = -1;
        for (let slot = 0; slot < weights.itemSize; slot++) {
          if (descendants[indices.getComponent(vertex, slot)]) influence += weights.getComponent(vertex, slot);
          if (weights.getComponent(vertex, slot) > dominantWeight) {
            dominantWeight = weights.getComponent(vertex, slot); dominantIndex = indices.getComponent(vertex, slot);
          }
        }
        if (influence >= .5) vertices.push(vertex);
        if (mesh.skeleton.bones[dominantIndex] === hand) palmVertices.push(vertex);
      }
      return { mesh, vertices, palmVertices };
    }));
    for (const side of members) expect(side.reduce((count, mesh) => count + mesh.vertices.length, 0)).toBeGreaterThan(1000);
    setRomClampEnabled(false); // Explicit contact still enforces clinical bounds.
    const motion = resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg);
    expect(motion.supportPlaneY).toBe(0);
    const recording = sampleComposedMotion(motion, {
      baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
    });
    const point = new THREE.Vector3();
    const extremes = [Infinity, -Infinity];
    for (const frame of recording.frames) {
      root.position.fromArray(frame.root.translateM); root.quaternion.fromArray(frame.root.orientQuat);
      applyCustomPose(skinned.skeleton, cfg, frame.pose);
      twist.sampleWithTwist(() => {
        root.updateMatrixWorld(true);
        for (const [side, meshes] of members.entries()) {
          let minimum = Infinity, palmMinimum = Infinity;
          for (const { mesh, vertices, palmVertices } of meshes) {
            mesh.skeleton.update();
            for (const vertex of vertices) minimum = Math.min(minimum, mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld).y);
            for (const vertex of palmVertices) palmMinimum = Math.min(palmMinimum, mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld).y);
          }
          extremes[0] = Math.min(extremes[0]!, minimum); extremes[1] = Math.max(extremes[1]!, minimum);
          expect(minimum, `${side === 0 ? 'L' : 'R'} skin penetration at ${frame.tMs} ms`).toBeGreaterThanOrEqual(-.002);
          expect(minimum, `${side === 0 ? 'L' : 'R'} skin support gap at ${frame.tMs} ms`).toBeLessThanOrEqual(.002);
          expect(palmMinimum, `${side === 0 ? 'L' : 'R'} palm support, not solely a digit at ${frame.tMs} ms`).toBeLessThanOrEqual(.002);
        }
      });
    }
    console.info(variant, 'bilateral hand skin minimum range (m)', extremes);
  });
});
