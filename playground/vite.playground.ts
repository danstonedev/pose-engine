/**
 * Standalone dev harness for @vspx/pose-engine's PoseViewer. Named
 * `vite.playground.ts` (not `vite.config.ts`) so tools like svelte-check don't
 * auto-discover it. Root is this folder; the GLBs are served from public/models
 * (populated by the `predev` copy step).
 */
import { defineConfig } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    fs: { allow: [repoRoot] },
  },
  plugins: [svelte({ preprocess: vitePreprocess() })],
});
