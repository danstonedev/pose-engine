import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Minimal config so `svelte-check` can type-check PoseViewer.svelte. */
export default {
  preprocess: vitePreprocess(),
};
