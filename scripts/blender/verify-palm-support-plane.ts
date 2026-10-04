/** Compare runtime skin-plane fitting with the actual Blender authoring evidence.
 * vite-node scripts/blender/verify-palm-support-plane.ts <review> <plane-authoring> <fresh-report.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { fitPalmSupportPlane, handSupportSurfaceHeight } from '../../src/services/handSupportSurface';

const [sourceArg, authorArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !authorArg || !outputArg) throw new Error('Provide source review, plane authoring, and fresh report paths');
const source = resolve(sourceArg), author = resolve(authorArg), output = resolve(outputArg);
const bytes = readFileSync(resolve(author, 'palm-support-plane.json'));
const reference = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const results: Record<string, unknown>[] = [];
let passed = true;
for (const entry of reference.cases) {
  const binary = readFileSync(resolve(source, entry.id + '.glb'));
  const parsed = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength), '');
  const mixer = new THREE.AnimationMixer(parsed.scene);
  mixer.clipAction(parsed.animations[0]!).play(); mixer.setTime(entry.timeSec);
  parsed.scene.updateMatrixWorld(true);
  let skin: THREE.SkinnedMesh | undefined;
  parsed.scene.traverse(object => { if (!skin && (object as THREE.SkinnedMesh).isSkinnedMesh) skin = object as THREE.SkinnedMesh; });
  if (!skin) throw new Error('Missing skin');
  for (const side of ['L', 'R']) {
    const bone = (part: string) => skin!.skeleton.bones.find(value => value.name === `CC_Base_${side}_${part}`)!;
    const hand = bone('Hand'), origin = hand.getWorldPosition(new THREE.Vector3());
    const inverse = hand.getWorldQuaternion(new THREE.Quaternion()).normalize().invert();
    const forward = bone('Mid1').getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
    const normal = forward.clone().cross(bone('Index1').getWorldPosition(new THREE.Vector3()).sub(bone('Pinky1').getWorldPosition(new THREE.Vector3()))).normalize().multiplyScalar(side === 'L' ? 1 : -1);
    const localForward = forward.clone().applyQuaternion(inverse), localNormal = normal.clone().applyQuaternion(inverse);
    const lateral = localNormal.clone().cross(localForward).normalize();
    const fit = fitPalmSupportPlane(skin, hand, localNormal, localForward);
    const anatomical = new THREE.Vector3(fit.normalLocal.dot(localForward), fit.normalLocal.dot(lateral), fit.normalLocal.dot(localNormal));
    const expected = entry.hands[side];
    const normalErrorDeg = anatomical.angleTo(new THREE.Vector3().fromArray(expected.targetSkinNormalInAnatomicalPalmFrame)) * 180 / Math.PI;
    const depthErrorM = Math.abs(fit.depthM - expected.supportDepthM);
    const patchErrorM = Math.max(...(['heel', 'thenar', 'ulnar'] as const).map(patch => Math.abs(fit.patchClearanceM[patch] - expected.candidatePatchClearancesM[patch])));
    const worldOrientation = hand.getWorldQuaternion(new THREE.Quaternion()).normalize();
    const worldNormal = fit.normalLocal.clone().applyQuaternion(worldOrientation).normalize();
    const orientation = new THREE.Quaternion().setFromUnitVectors(worldNormal, new THREE.Vector3(0, -1, 0)).multiply(worldOrientation).normalize();
    const height = handSupportSurfaceHeight(skin, hand, orientation);
    const rowPassed = normalErrorDeg < .1 && depthErrorM < .0001 && patchErrorM < .0001 && Math.abs(height - fit.depthM) < 1e-10;
    passed &&= rowPassed;
    results.push({ id: entry.id, side, normalErrorDeg, depthErrorM, patchErrorM, heightMinusPlaneDepthM: height - fit.depthM,
      runtime: { normalInAnatomicalPalmFrame: anatomical.toArray(), supportDepthM: fit.depthM, patchClearanceM: fit.patchClearanceM,
        contactSpanM: fit.contactSpanM, contactTriangleAreaM2: fit.contactTriangleAreaM2, vertexCount: fit.vertexCount }, passed: rowPassed });
  }
}
const report = { scope: 'Runtime geometric fitter compared to Blender evaluated production animation. Not whole-body contact/ROM/native acceptance.',
  sourceDigest: reference.sourceDigest, referenceSha256: createHash('sha256').update(bytes).digest('hex'),
  tolerances: { normalDeg: .1, geometryM: .0001 }, passed, results };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
if (!passed) throw new Error('Runtime palm-plane fit differs from Blender evidence; inspect preserved report');
