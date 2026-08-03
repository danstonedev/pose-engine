/**
 * Validate and package a texture-free GLB export of Reallusion's rigged
 * CC3_Base_Plus body as the neutral older-adolescent runtime mannequin.
 *
 * Export only `Armature` and `CC_Base_Body` from the supplied FBX before
 * running this script. The importer proves that the source still shares the
 * UVs, vertex correspondence, joint order, and animation contract used by the
 * male/female models. It then adopts the canonical male triangle ordering so
 * the existing face-indexed CC paint atlas is safe for all three variants.
 *
 * Usage: npm run models:neutral -- <path-to-CC3_Base_Plus.glb>
 */
import { EXTMeshoptCompression, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeModelIO, snapshotRuntimeModel } from './runtime-model-snapshot.mjs';

const sourceArg = process.argv[2];
if (!sourceArg) {
  throw new Error('Provide a texture-free CC3_Base_Plus GLB: npm run models:neutral -- <source.glb>');
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = resolve(ROOT, 'models');
const MALE_PATH = resolve(MODELS_DIR, 'painmap3D_male.runtime.glb');
const OUTPUT_PATH = resolve(MODELS_DIR, 'painmap3D_neutral.runtime.glb');
const BASELINE_PATH = resolve(MODELS_DIR, 'runtime-models.baseline.json');
const io = await createRuntimeModelIO();
const [doc, maleDoc] = await Promise.all([io.read(resolve(sourceArg)), io.read(MALE_PATH)]);

doc
  .getRoot()
  .listExtensionsUsed()
  .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
  ?.dispose();

const equal = (a, b) => {
  if (a.constructor !== b.constructor || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const root = doc.getRoot();
const maleRoot = maleDoc.getRoot();
const nodeNames = root.listNodes().map((node) => node.getName()).sort();
const maleNodeNames = maleRoot.listNodes().map((node) => node.getName()).sort();
if (JSON.stringify(nodeNames) !== JSON.stringify(maleNodeNames)) {
  throw new Error('CC3 Base Plus node names do not match the pose-engine CC rig');
}
if (root.listSkins().length !== 1 || root.listSkins()[0].listJoints().length !== 101) {
  throw new Error('CC3 Base Plus must contain the expected 101-joint CC skin');
}
if (root.listAnimations().length !== 1 || root.listAnimations()[0].listChannels().length !== 303) {
  throw new Error('CC3 Base Plus must contain the 303-channel Armature|Default animation');
}

const mesh = root.listMeshes().find((item) => item.getName() === 'CC_Base_Body');
const maleMesh = maleRoot.listMeshes().find((item) => item.getName() === 'CC_Base_Body');
if (!mesh || !maleMesh || root.listMeshes().length !== 1) {
  throw new Error('The source GLB must contain only CC_Base_Body');
}
const primitives = mesh.listPrimitives();
const malePrimitives = maleMesh.listPrimitives();
if (primitives.length !== 6 || malePrimitives.length !== primitives.length) {
  throw new Error('CC_Base_Body must retain its six paint-material primitives');
}

for (let index = 0; index < primitives.length; index++) {
  const primitive = primitives[index];
  const malePrimitive = malePrimitives[index];
  for (const semantic of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']) {
    if (primitive.getAttribute(semantic)?.getCount() !== malePrimitive.getAttribute(semantic)?.getCount()) {
      throw new Error(`Primitive ${index} ${semantic} vertex correspondence changed`);
    }
  }
  for (const semantic of ['TEXCOORD_0', 'JOINTS_0']) {
    if (!equal(primitive.getAttribute(semantic).getArray(), malePrimitive.getAttribute(semantic).getArray())) {
      throw new Error(`Primitive ${index} ${semantic} no longer matches the shared CC atlas/rig`);
    }
  }
  if (primitive.getIndices().getCount() !== malePrimitive.getIndices().getCount()) {
    throw new Error(`Primitive ${index} triangle count changed`);
  }
  // Vertex ordering is proven above; use the atlas-authoring triangle order.
  primitive.getIndices().setArray(malePrimitive.getIndices().getArray().slice());
}

// Match the texture-free material contract used by the existing runtime pair.
const specularExtension = doc.createExtension(KHRMaterialsSpecular);
for (const material of root.listMaterials()) {
  material
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setDoubleSided(true)
    .setAlphaMode(material.getName() === 'Std_Eyelash' ? 'BLEND' : 'OPAQUE');
  material.setExtension(
    'KHR_materials_specular',
    specularExtension.createSpecular().setSpecularFactor(1).setSpecularColorFactor([1, 1, 1]),
  );
}
for (const texture of [...root.listTextures()]) texture.dispose();

const uncompressed = await io.writeBinary(doc);
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
baseline.neutral = { bytesBefore: uncompressed.byteLength, ...snapshotRuntimeModel(doc) };

doc
  .createExtension(EXTMeshoptCompression)
  .setRequired(true)
  .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
const compressed = await io.writeBinary(doc);
writeFileSync(OUTPUT_PATH, compressed);
baseline.neutral.bytesAfter = compressed.byteLength;
writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);

console.log(
  `${OUTPUT_PATH}: ${(uncompressed.byteLength / 1024).toFixed(0)} kB -> ` +
    `${(compressed.byteLength / 1024).toFixed(0)} kB ` +
    `(-${Math.round((1 - compressed.byteLength / uncompressed.byteLength) * 100)}%)`,
);
