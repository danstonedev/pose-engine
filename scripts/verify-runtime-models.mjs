/**
 * Verify the meshopt-compressed runtime mannequin GLBs against the
 * pre-compression baseline captured by scripts/compress-runtime-models.mjs.
 *
 * The compression contract is LOSSLESS TRANSPORT. Checks, per variant:
 *   (a) extensionsUsed includes EXT_meshopt_compression AND still includes
 *       KHR_materials_specular; KHR_mesh_quantization must NOT appear (its
 *       IBM-folded dequantization breaks body-chart's bake + raycast culling);
 *   (b) sorted node-name and mesh-name lists identical (paint raycast +
 *       joint-angle code key off names);
 *   (c) skin joint counts identical;
 *   (d) EVERY attribute accessor decodes byte-identical (SHA-256), and every
 *       primitive's canonical triangle list is identical (faceIndex-keyed
 *       triangle-region atlas stays valid; intra-triangle rotation allowed);
 *   (e) prints a before/after byte-size table.
 *
 * Exits non-zero on ANY mismatch — do not ship models that fail this.
 *
 * Usage: npm run models:verify
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeModelIO, snapshotRuntimeModel } from './runtime-model-snapshot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = resolve(ROOT, 'models');
const BASELINE_PATH = resolve(MODELS_DIR, 'runtime-models.baseline.json');

const io = await createRuntimeModelIO();
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL: ${msg}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const rows = [];
for (const [variant, expected] of Object.entries(baseline)) {
  const path = resolve(MODELS_DIR, `painmap3D_${variant}.runtime.glb`);
  const doc = await io.read(path);
  const actual = snapshotRuntimeModel(doc);

  if (!actual.extensionsUsed.includes('EXT_meshopt_compression')) {
    fail(`${variant}: EXT_meshopt_compression missing (${actual.extensionsUsed})`);
  }
  if (!actual.extensionsUsed.includes('KHR_materials_specular')) {
    fail(`${variant}: KHR_materials_specular was dropped (${actual.extensionsUsed})`);
  }
  if (actual.extensionsUsed.includes('KHR_mesh_quantization')) {
    fail(`${variant}: KHR_mesh_quantization present — the encode was not lossless`);
  }

  if (!eq(actual.nodeNames, expected.nodeNames)) {
    fail(`${variant}: node names changed (${expected.nodeNames.length} -> ${actual.nodeNames.length})`);
  }
  if (!eq(actual.meshNames, expected.meshNames)) {
    fail(`${variant}: mesh names changed (${expected.meshNames} -> ${actual.meshNames})`);
  }
  if (!eq(actual.skinJointCounts, expected.skinJointCounts)) {
    fail(
      `${variant}: skin joint counts changed ${JSON.stringify(expected.skinJointCounts)} -> ` +
        JSON.stringify(actual.skinJointCounts),
    );
  }

  if (actual.primitives.length !== expected.primitives.length) {
    fail(
      `${variant}: primitive count changed ${expected.primitives.length} -> ${actual.primitives.length}`,
    );
  } else {
    for (let i = 0; i < expected.primitives.length; i++) {
      const exp = expected.primitives[i];
      const act = actual.primitives[i];
      for (const [sem, hash] of Object.entries(exp.semantics)) {
        if (act.semantics[sem] !== hash) {
          fail(`${variant}: primitive ${i} ${sem} bytes changed — decode is not lossless`);
        }
      }
      if (act.triangleCount !== exp.triangleCount) {
        fail(`${variant}: primitive ${i} triangle count ${exp.triangleCount} -> ${act.triangleCount}`);
      }
      if (act.triangleListSha256 !== exp.triangleListSha256) {
        fail(
          `${variant}: primitive ${i} triangle list changed — faceIndex-keyed atlas would break`,
        );
      }
    }
  }

  const after = statSync(path).size;
  rows.push({
    variant,
    'before (bytes)': expected.bytesBefore,
    'after (bytes)': after,
    saving: `${Math.round((1 - after / expected.bytesBefore) * 100)}%`,
    nodes: actual.nodeNames.length,
    meshes: actual.meshNames.length,
    'skin joints': actual.skinJointCounts.join('+'),
    primitives: actual.primitives.length,
  });
}

console.table(rows);
if (failures) {
  console.error(`${failures} verification failure(s) — models are NOT safe to commit.`);
  process.exit(1);
}
console.log(
  'OK: extensions, node/mesh names, skin joints, attribute bytes, and triangle lists all preserved.',
);
