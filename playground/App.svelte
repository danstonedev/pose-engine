<script lang="ts">
  /** Standalone harness: the lightweight viewer + the interactive pose-tool editor. */
  import PoseViewer from '../src/PoseViewer.svelte';
  import PoseLab from './PoseLab.svelte';

  type ViewName = 'front' | 'back' | 'left' | 'right';
  const VIEWS: ViewName[] = ['front', 'back', 'left', 'right'];

  let mode = $state<'viewer' | 'editor'>('viewer');
  let variant = $state<'male' | 'female'>('female');
  let view = $state<ViewName>('front');
</script>

<div class="app">
  <header>
    <h1>@vspx/pose-engine</h1>
    <p>The shared clinical mannequin + pose toolset, standalone.</p>
  </header>

  <div class="tabs">
    <button class:active={mode === 'viewer'} onclick={() => (mode = 'viewer')}>Viewer</button>
    <button class:active={mode === 'editor'} onclick={() => (mode = 'editor')}>Editor (pose tools)</button>
  </div>

  {#if mode === 'viewer'}
    <div class="controls">
      <div class="seg" role="group" aria-label="Body variant">
        <button class:active={variant === 'female'} onclick={() => (variant = 'female')}>Female</button>
        <button class:active={variant === 'male'} onclick={() => (variant = 'male')}>Male</button>
      </div>
      <div class="seg" role="group" aria-label="Camera view">
        {#each VIEWS as v (v)}
          <button class:active={view === v} onclick={() => (view = v)}>{v}</button>
        {/each}
      </div>
    </div>
    <PoseViewer {variant} {view} height="32rem" />
    <p class="note">
      The lightweight shipped component. Props: <code>variant={variant}</code> ·
      <code>view={view}</code> — the same one a host drops into a scenario's <code>pose3d</code> slot.
    </p>
  {:else}
    <PoseLab />
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    background: #0b1016;
  }
  :global(*) {
    box-sizing: border-box;
  }
  .app {
    max-width: 60rem;
    margin: 0 auto;
    padding: 1.5rem 1.25rem;
    color: rgba(255, 255, 255, 0.9);
    font-family:
      Inter,
      system-ui,
      -apple-system,
      'Segoe UI',
      Roboto,
      sans-serif;
  }
  header h1 {
    margin: 0 0 0.25rem;
    font-size: 1.05rem;
  }
  header p {
    margin: 0 0 1rem;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.82rem;
  }
  .tabs {
    display: inline-flex;
    gap: 0.3rem;
    margin-bottom: 1rem;
    padding: 0.25rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.03);
  }
  .tabs button {
    border: 0;
    border-radius: 6px;
    padding: 0.34rem 0.8rem;
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .tabs button.active {
    background: #6fcdb8;
    color: #06231d;
    font-weight: 700;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 0.9rem;
  }
  .seg {
    display: inline-flex;
    gap: 0.3rem;
    padding: 0.25rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.03);
  }
  .seg button {
    border: 0;
    border-radius: 6px;
    padding: 0.32rem 0.7rem;
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.74rem;
    text-transform: capitalize;
    cursor: pointer;
  }
  .seg button.active {
    background: #6fcdb8;
    color: #06231d;
    font-weight: 700;
  }
  .note {
    margin: 0.9rem 0 0;
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.74rem;
  }
  code {
    font-family: ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
    color: #9fe3d6;
  }
</style>
