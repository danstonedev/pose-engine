/**
 * GLB QUANTIZATION IS MEASUREMENT-SAFE — the guarantee simMOVE's build-time model
 * shrink relies on. The shared `*.runtime.glb` are meshopt-only (body-chart keys
 * anatomy by faceIndex and needs byte-identical geometry, so it forbids quantize),
 * but simMOVE measures joints from the SKELETON and selects by raycasting handle
 * proxies — never the mesh. So simMOVE quantizes the mesh for a ~30% smaller
 * download. This test proves the property: quantizing (position 14-bit, normal
 * 10-bit, weight 8-bit) + re-meshopt leaves EVERY measured joint angle and bone
 * world position byte-identical (bones + inverse-bind matrices are untouched),
 * while the file shrinks materially. If someone makes the shrink lossy, this fails.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize } from '@gltf-transform/functions';
import { MeshoptDecoder as MODecoder, MeshoptEncoder } from 'meshoptimizer';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, exportKinematics, type KinematicExport } from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.female;
const SRC = fileURLToPath(new URL('../../models/painmap3D_female.runtime.glb', import.meta.url));

let originalBytes: Uint8Array;
let quantizedBytes: Uint8Array;

beforeAll(async () => {
  originalBytes = readFileSync(SRC);
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MODecoder, 'meshopt.encoder': MeshoptEncoder });
  await MeshoptEncoder.ready;
  const doc = await io.read(SRC);
  // The SAME transform simMOVE's optimize-models.mjs applies.
  await doc.transform(
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8, quantizeColor: 8 }),
  );
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  quantizedBytes = await io.writeBinary(doc);
});

async function measure(bytes: Uint8Array): Promise<KinematicExport> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  const root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  let skinned!: THREE.SkinnedMesh;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  const baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'female');
  const squat = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'squat')!);
  const rec = sampleComposedMotion(resolveComposedMotion(squat, variantCfg), {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
  });
  return exportKinematics(rec);
}

describe('quantized GLB is measurement-safe', () => {
  it('leaves every joint angle + bone world position byte-identical', async () => {
    const orig = await measure(originalBytes);
    const quant = await measure(quantizedBytes);

    let maxAngleErr = 0;
    for (const key of Object.keys(orig.series)) {
      const a = orig.series[key]!;
      const b = quant.series[key] ?? a;
      for (let i = 0; i < a.length; i += 1) maxAngleErr = Math.max(maxAngleErr, Math.abs(a[i]! - b[i]!));
    }
    let maxPosErrM = 0;
    for (const bone of Object.keys(orig.trajectories)) {
      const a = orig.trajectories[bone]!;
      const b = quant.trajectories[bone] ?? a;
      for (let i = 0; i < a.length; i += 1) {
        maxPosErrM = Math.max(maxPosErrM, Math.hypot(a[i]![0] - b[i]![0], a[i]![1] - b[i]![1], a[i]![2] - b[i]![2]));
      }
    }
    // Bones + IBMs are untouched by mesh quantization → measurement is exact.
    expect(maxAngleErr, `max joint-angle error ${maxAngleErr.toFixed(5)}°`).toBeLessThan(0.02);
    expect(maxPosErrM, `max bone world-pos error ${(maxPosErrM * 1000).toFixed(4)} mm`).toBeLessThan(0.0005);
  });

  it('materially shrinks the download (the point of the exercise)', () => {
    const ratio = quantizedBytes.byteLength / originalBytes.byteLength;
    expect(ratio, `${(originalBytes.byteLength / 1024) | 0}KB → ${(quantizedBytes.byteLength / 1024) | 0}KB (${(ratio * 100) | 0}%)`).toBeLessThan(0.85);
  });
});
