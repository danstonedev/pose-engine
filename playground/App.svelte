<script lang="ts">
  /** simMOVE is the first-party front end for the pose engine itself. */
  import PoseViewer from '../src/PoseViewer.svelte';
  import PoseLab from './PoseLab.svelte';

  type ViewName = 'front' | 'back' | 'left' | 'right';
  const VIEWS: ViewName[] = ['front', 'back', 'left', 'right'];
  const ECOSYSTEM = ['DevPT', 'simPAIN', 'PainMap', 'Aquatic', 'Body Chart'];

  let mode = $state<'inspect' | 'lab'>('inspect');
  let variant = $state<'male' | 'female'>('female');
  let view = $state<ViewName>('front');
</script>

<div class="app">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true">SM</span>
      <div>
        <h1>simMOVE</h1>
        <p>First-party motion and pose interface for the DevPT ecosystem.</p>
      </div>
    </div>
    <div class="engine-state" aria-label="Engine architecture">
      <span>Direct pose-engine source</span>
      <span>No copied rig layer</span>
      <span>Browser-native</span>
    </div>
  </header>

  <main>
    <section class="stage" aria-label="simMOVE pose engine visual">
      <div class="stage-head">
        <div>
          <p class="eyebrow">Live engine view</p>
          <h2>Inspect, pose, and validate movement from the source of truth.</h2>
        </div>
        <div class="tabs" role="tablist" aria-label="simMOVE mode">
          <button
            class:active={mode === 'inspect'}
            aria-selected={mode === 'inspect'}
            role="tab"
            onclick={() => (mode = 'inspect')}
          >
            Inspect
          </button>
          <button
            class:active={mode === 'lab'}
            aria-selected={mode === 'lab'}
            role="tab"
            onclick={() => (mode = 'lab')}
          >
            Pose Lab
          </button>
        </div>
      </div>

      <div class="toolbar">
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

      {#if mode === 'inspect'}
        <div class="viewer-shell">
          <PoseViewer {variant} {view} height="34rem" />
        </div>
      {:else}
        <PoseLab />
      {/if}
    </section>

    <section class="system-strip" aria-label="DevPT ecosystem connection">
      <div>
        <p class="eyebrow">DevPT ecosystem</p>
        <h2>One motion layer, shared everywhere.</h2>
      </div>
      <div class="ecosystem">
        {#each ECOSYSTEM as app (app)}
          <span>{app}</span>
        {/each}
      </div>
    </section>

    <section class="principles" aria-label="simMOVE architecture principles">
      <article>
        <span>01</span>
        <h3>Lightweight</h3>
        <p>Vite, Svelte, Three, and the engine source. No separate simulation framework.</p>
      </article>
      <article>
        <span>02</span>
        <h3>Fast</h3>
        <p>The runtime GLBs are copied into the local public folder only when the visual starts.</p>
      </article>
      <article>
        <span>03</span>
        <h3>Drift-resistant</h3>
        <p>simMOVE imports <code>../src</code> directly, so the interface exercises the real pose engine.</p>
      </article>
    </section>
  </main>
</div>

<style>
  :global(body) {
    margin: 0;
    background: #f4f7f6;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .app {
    max-width: 72rem;
    margin: 0 auto;
    padding: 1.25rem;
    color: #101820;
    font-family:
      Inter,
      system-ui,
      -apple-system,
      'Segoe UI',
      Roboto,
      sans-serif;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 4rem;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .mark {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border-radius: 8px;
    background: #101820;
    color: #7be0c3;
    font: 800 0.7rem/1 ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
    letter-spacing: 0;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 1.15rem;
    letter-spacing: 0;
  }

  .brand p {
    margin-top: 0.2rem;
    color: #5d6971;
    font-size: 0.82rem;
  }

  .engine-state,
  .ecosystem {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.45rem;
  }

  .engine-state span,
  .ecosystem span {
    border: 1px solid #d8e3df;
    border-radius: 999px;
    padding: 0.34rem 0.58rem;
    background: #ffffff;
    color: #43505a;
    font-size: 0.72rem;
    font-weight: 700;
  }

  main {
    display: grid;
    gap: 1rem;
    margin-top: 1rem;
  }

  .stage {
    padding: 1rem;
    border: 1px solid #dfe8e5;
    border-radius: 8px;
    background: #ffffff;
  }

  .stage-head,
  .system-strip {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
  }

  .stage-head {
    margin-bottom: 1rem;
  }

  .eyebrow {
    margin-bottom: 0.3rem;
    color: #008a61;
    font: 800 0.7rem/1 ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  h2 {
    max-width: 36rem;
    font-size: clamp(1.35rem, 2vw, 2rem);
    line-height: 1.08;
    letter-spacing: 0;
  }

  .tabs {
    display: inline-flex;
    gap: 0.3rem;
    padding: 0.25rem;
    border: 1px solid #d8e3df;
    border-radius: 8px;
    background: #f4f7f6;
  }

  .tabs button {
    border: 0;
    border-radius: 6px;
    padding: 0.42rem 0.8rem;
    background: transparent;
    color: #5d6971;
    font-size: 0.78rem;
    font-weight: 800;
    cursor: pointer;
  }

  .tabs button.active {
    background: #101820;
    color: #ffffff;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 0.9rem;
  }

  .seg {
    display: inline-flex;
    gap: 0.3rem;
    padding: 0.25rem;
    border: 1px solid #d8e3df;
    border-radius: 8px;
    background: #f4f7f6;
  }

  .seg button {
    border: 0;
    border-radius: 6px;
    padding: 0.32rem 0.7rem;
    background: transparent;
    color: #5d6971;
    font-size: 0.74rem;
    font-weight: 800;
    text-transform: capitalize;
    cursor: pointer;
  }

  .seg button.active {
    background: #008a61;
    color: #ffffff;
  }

  .viewer-shell {
    overflow: hidden;
    border-radius: 8px;
  }

  .system-strip {
    padding: 1.1rem 0;
  }

  .principles {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .principles article {
    min-height: 8.5rem;
    padding: 1rem;
    border: 1px solid #dfe8e5;
    border-radius: 8px;
    background: #ffffff;
  }

  .principles span {
    display: block;
    margin-bottom: 1.3rem;
    color: #008a61;
    font: 800 0.72rem/1 ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
  }

  h3 {
    margin-bottom: 0.45rem;
    font-size: 1rem;
  }

  .principles p {
    color: #5d6971;
    font-size: 0.82rem;
    line-height: 1.45;
  }

  code {
    font-family: ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
    color: #008a61;
  }

  @media (max-width: 760px) {
    .topbar,
    .stage-head,
    .system-strip {
      align-items: stretch;
      flex-direction: column;
    }

    .engine-state,
    .ecosystem {
      justify-content: flex-start;
    }

    .tabs {
      width: 100%;
    }

    .tabs button {
      flex: 1;
    }

    .principles {
      grid-template-columns: 1fr;
    }
  }
</style>
