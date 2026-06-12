/**
 * Copy the runtime mannequin GLBs into the playground's public/ dir so the dev
 * server serves them at /models/* (matching `variant.modelUrl(base)` with
 * base=''). Runs from the package's `predev` hook. The copies are gitignored;
 * `models/` is the source of truth.
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'models');
const destDir = join(here, 'public', 'models');

mkdirSync(destDir, { recursive: true });
for (const file of ['painmap3D_male.runtime.glb', 'painmap3D_female.runtime.glb']) {
  copyFileSync(join(srcDir, file), join(destDir, file));
  console.log('copied', file);
}
