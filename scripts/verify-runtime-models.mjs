/**
 * Verify the meshopt-compressed runtime mannequin GLBs against the
 * pre-compression baseline captured by scripts/compress-runtime-models.mjs.
 *
 * Checks, per variant:
 *   (a) extensionsUsed includes EXT_meshopt_compression AND still includes
 *       KHR_materials_specular (the material extension the source models use);
 *   (b) the full sorted node-name and mesh-name lists are IDENTICAL to the
 *       pre-compression file (paint raycast + joint-angle code key off names);
 *   (c) skin joint counts are identical;
 *   (d) prints a before/after byte-size table.
 *
 * Exits non-zero on ANY mismatch — do not ship models that fail this.
 *
 * Usage: npm run models:verify
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = resolve(ROOT, 'models');
const BASELINE_PATH = resolve(MODELS_DIR, 'runtime-models.baseline.json');

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

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
  const root = doc.getRoot();

  const extensionsUsed = root.listExtensionsUsed().map((e) => e.extensionName);
  if (!extensionsUsed.includes('EXT_meshopt_compression')) {
    fail(`${variant}: EXT_meshopt_compression missing (extensionsUsed=${extensionsUsed})`);
  }
  if (!extensionsUsed.includes('KHR_materials_specular')) {
    fail(`${variant}: KHR_materials_specular was dropped (extensionsUsed=${extensionsUsed})`);
  }

  const nodeNames = root
    .listNodes()
    .map((n) => n.getName())
    .sort();
  if (!eq(nodeNames, expected.nodeNames)) {
    fail(
      `${variant}: node names changed (${expected.nodeNames.length} -> ${nodeNames.length}); ` +
        `missing=${expected.nodeNames.filter((n) => !nodeNames.includes(n))} ` +
        `added=${nodeNames.filter((n) => !expected.nodeNames.includes(n))}`,
    );
  }

  const meshNames = root
    .listMeshes()
    .map((m) => m.getName())
    .sort();
  if (!eq(meshNames, expected.meshNames)) {
    fail(
      `${variant}: mesh names changed (${expected.meshNames.length} -> ${meshNames.length}); ` +
        `missing=${expected.meshNames.filter((n) => !meshNames.includes(n))} ` +
        `added=${meshNames.filter((n) => !expected.meshNames.includes(n))}`,
    );
  }

  const skinJointCounts = root.listSkins().map((s) => s.listJoints().length);
  if (!eq(skinJointCounts, expected.skinJointCounts)) {
    fail(
      `${variant}: skin joint counts changed ${JSON.stringify(expected.skinJointCounts)} -> ` +
        JSON.stringify(skinJointCounts),
    );
  }

  const after = statSync(path).size;
  rows.push({
    variant,
    'before (bytes)': expected.bytesBefore,
    'after (bytes)': after,
    saving: `${Math.round((1 - after / expected.bytesBefore) * 100)}%`,
    nodes: nodeNames.length,
    meshes: meshNames.length,
    'skin joints': skinJointCounts.join('+'),
  });
}

console.table(rows);
if (failures) {
  console.error(`${failures} verification failure(s) — models are NOT safe to commit.`);
  process.exit(1);
}
console.log('OK: extensions, node/mesh names, and skin joints all preserved.');
