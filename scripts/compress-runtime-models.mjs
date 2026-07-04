/**
 * Meshopt-compress the runtime pain-map mannequin GLBs (in place) — LOSSLESSLY.
 *
 * The `painmap3D_{male,female}.runtime.glb` files are produced by body-chart's
 * `scripts/prune-runtime-models.mjs` (a lossless orphan-data prune) and ship
 * with plain uncompressed geometry (~1.05 MiB each). This script wraps that
 * pipeline's OUTPUT in EXT_meshopt_compression and nothing else.
 *
 * IMPORTANT — why NO quantize and NO reorder:
 * body-chart's paint/metrics ecosystem depends on the DECODED buffers being
 * byte-identical to the originals:
 *   - the triangle-region atlas keys anatomy attribution by faceIndex, so the
 *     triangle ORDER must not change (gltf-transform's reorder() permutes it);
 *   - hot paths read attribute arrays directly, and three's raycast culling
 *     derives bounds from raw attribute values — quantized int storage
 *     (KHR_mesh_quantization with the dequant folded into the IBMs) broke the
 *     BVH paint proxy and slowed direct skinned raycasts ~60x (no culling).
 * Pure EXT_meshopt_compression is a transport codec: attributes decode
 * byte-for-byte, and the index codec preserves face order and winding (it may
 * only rotate vertices WITHIN a triangle, which nothing keys on). Verified by
 * scripts/verify-runtime-models.mjs via the SHA-256 baseline captured below.
 *
 * Size: ~1,051 kB -> ~695 kB per model (-34%). Loaders must register
 * MeshoptDecoder (all pose-engine + body-chart GLTFLoader sites do; the
 * decoder is backward-compatible with uncompressed GLBs).
 *
 * Idempotent: re-running decodes and re-encodes the same bytes.
 *
 * Usage: npm run models:compress   (then npm run models:verify)
 */
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeModelIO, snapshotRuntimeModel } from './runtime-model-snapshot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = resolve(ROOT, 'models');
const VARIANTS = ['male', 'female'];
const BASELINE_PATH = resolve(MODELS_DIR, 'runtime-models.baseline.json');

const io = await createRuntimeModelIO();

const baseline = {};
for (const variant of VARIANTS) {
  const path = resolve(MODELS_DIR, `painmap3D_${variant}.runtime.glb`);
  const before = statSync(path).size;

  // 1) Snapshot the pre-compression structure + bytes BEFORE overwriting.
  const doc = await io.read(path);
  baseline[variant] = { bytesBefore: before, ...snapshotRuntimeModel(doc) };

  // 2) Pure EXT_meshopt_compression — no quantize, no reorder (see header).
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

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
