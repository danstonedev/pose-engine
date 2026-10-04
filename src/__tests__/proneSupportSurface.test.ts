import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { createStageTwistOverlay } from '../services/stageTwistOverlay';

describe.each(['male', 'female', 'neutral'] as const)('%s posed prone support', variant => {
  it('supports actual torso/pelvis skin through the cycle without grounding on the head', async () => {
    const cfg = BODY_VARIANTS[variant];
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const root = (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    const skins: THREE.SkinnedMesh[] = [];
    root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skins.push(object as THREE.SkinnedMesh); });
    const skinned = skins[0]!;
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant);
    const rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    const restPosition = root.position.clone(), restQuaternion = root.quaternion.clone();
    const twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
    const motion = resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg);
    expect(motion.supportPlaneY).toBe(0);
    const recording = sampleComposedMotion(motion, { baselinePose, variantCfg: cfg, rest,
      skeletonHarness: { root, skinned }, sampleHz: 10 });
    const regions = skins.map(skin => {
      const indices = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
      const classified: Record<string, number[]> = { torso: [], pelvis: [], legs: [], head: [] };
      for (let vertex = 0; vertex < indices.count; vertex++) {
        let weight = -1, name = '';
        for (let slot = 0; slot < 4; slot++) if (weights.getComponent(vertex, slot) > weight) {
          weight = weights.getComponent(vertex, slot);
          name = skin.skeleton.bones[indices.getComponent(vertex, slot)]!.name;
        }
        if (/(?:Hip|Pelvis|Spine\d*|[LR]_Breast)$/.test(name)) classified.torso.push(vertex);
        if (/(?:Hip|Pelvis)$/.test(name)) classified.pelvis.push(vertex);
        if (/(?:Thigh|Calf|Foot|Toe)/.test(name)) classified.legs.push(vertex);
        if (/Head$/.test(name)) classified.head.push(vertex);
      }
      return { skin, classified };
    });
    const p = new THREE.Vector3();
    const worst: Record<string, number> = { torso: Infinity, pelvis: Infinity, legs: Infinity, head: Infinity };
    let largestPelvisGap = -Infinity;
    for (const frame of recording.frames) {
      root.position.copy(restPosition).add(new THREE.Vector3().fromArray(frame.root.translateM));
      root.quaternion.copy(restQuaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
      applyCustomPose(skinned.skeleton, cfg, frame.pose);
      const minima: Record<string, number> = { torso: Infinity, pelvis: Infinity, legs: Infinity, head: Infinity };
      twist.sampleWithTwist(() => {
        root.updateMatrixWorld(true);
        for (const { skin, classified } of regions) {
          skin.skeleton.update();
          for (const [region, vertices] of Object.entries(classified)) for (const vertex of vertices) {
            const y = skin.getVertexPosition(vertex, p).applyMatrix4(skin.matrixWorld).y;
            minima[region] = Math.min(minima[region], y);
          }
        }
      });
      expect(Math.abs(minima.torso), `torso support at ${frame.tMs} ms`).toBeLessThan(.00015);
      expect(minima.legs, `leg skin at ${frame.tMs} ms`).toBeGreaterThan(-.00015);
      for (const region of Object.keys(worst)) worst[region] = Math.min(worst[region], minima[region]);
      largestPelvisGap = Math.max(largestPelvisGap, minima.pelvis);
    }
    console.log('POSED_PRONE_SUPPORT', JSON.stringify({ variant, samples: recording.frames.length, worst, largestPelvisGap,
      scope: 'Torso support and lower-limb nonpenetration only. Pelvis/foot contact, head clearance, forces and clinical acceptance remain separate.' }));
  });
});
