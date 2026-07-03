/**
 * Meshopt-compress the runtime pain-map mannequin GLBs (in place).
 *
 * The `painmap3D_{male,female}.runtime.glb` files are produced by body-chart's
 * `scripts/prune-runtime-models.mjs` (a lossless orphan-data prune) and ship
 * with plain uncompressed geometry (~1.05 MiB each). This script adds an
 * EXT_meshopt_compression stage on that pipeline's OUTPUT: quantize + reorder +
 * meshopt-encode via glTF-Transform, cutting the payload roughly in half while
 * staying loadable by three's GLTFLoader once `setMeshoptDecoder(...)` is
 * registered (which every loader site in this repo now does; the decoder is
 * backward-compatible with uncompressed GLBs).
 *
 * Safety: the paint-raycast pipeline and joint-angle code key off node names,
 * and pose logic depends on the skin joint list — so BEFORE overwriting, this
 * script snapshots each file's sorted node names, sorted mesh names, skin
 * joint counts, and extensionsUsed to `models/runtime-models.baseline.json`.
 * Run `node scripts/verify-runtime-models.mjs` (or `npm run models:verify`)
 * afterwards to prove the compressed files preserve all of them.
 *
 * Idempotent: re-running decodes and re-encodes; names/skins are unchanged.
 *
 * Usage: npm run models:compress
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = resolve(ROOT, 'models');
const VARIANTS = ['male', 'female'];
const BASELINE_PATH = resolve(MODELS_DIR, 'runtime-models.baseline.json');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});

/** Structural snapshot the runtime consumers depend on. */
function snapshot(doc) {
  const root = doc.getRoot();
  return {
    nodeNames: root
      .listNodes()
      .map((n) => n.getName())
      .sort(),
    meshNames: root
      .listMeshes()
      .map((m) => m.getName())
      .sort(),
    skinJointCounts: root.listSkins().map((s) => s.listJoints().length),
    extensionsUsed: root
      .listExtensionsUsed()
      .map((e) => e.extensionName)
      .sort(),
  };
}

const baseline = {};
for (const variant of VARIANTS) {
  const path = resolve(MODELS_DIR, `painmap3D_${variant}.runtime.glb`);
  const before = statSync(path).size;

  // 1) Snapshot the pre-compression structure BEFORE overwriting anything.
  const doc = await io.read(path);
  baseline[variant] = { ...snapshot(doc), bytesBefore: before };

  // 2) Quantize + reorder + meshopt-encode (EXT_meshopt_compression).
  await doc.transform(meshopt({ encoder: MeshoptEncoder }));

  // 3) Write to a temp file, then atomically replace the original.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, await io.writeBinary(doc));
  renameSync(tmp, path);

  const after = statSync(path).size;
  baseline[variant].bytesAfter = after;
  console.log(
    `${path}: ${(before / 1024).toFixed(0)} kB -> ${(after / 1024).toFixed(0)} kB ` +
      `(-${Math.round((1 - after / before) * 100)}%)`,
  );
}

writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`Baseline snapshot written: ${BASELINE_PATH}`);
console.log('Now run: node scripts/verify-runtime-models.mjs');
// Sanity: the baseline file itself must round-trip as JSON.
JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
