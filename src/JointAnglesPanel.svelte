<script lang="ts">
  /**
   * Clinical joint-angle readout — the canonical panel shared by body-chart and
   * any pose-engine host. Renders the live ROM readout per joint: clinician
   * direction labels (`formatRomValue`), within/near-limit/outside status, and a
   * plane-coloured range track. Promoted here so every consumer shows IDENTICAL
   * angles + limits (the single source of truth is the ROM registry).
   *
   * Theme via the host's CSS custom properties (`--surface-2`, `--text-1/2/3`);
   * the fallbacks give a self-contained dark panel.
   */
  import {
    ROM_JOINT_ROWS,
    formatRomStatus,
    formatRomValue,
    getRomFieldState,
  } from './services/romRegistry';
  import type { JointAngleReport } from './services/jointAngles';

  interface Props {
    report: JointAngleReport | null;
    /** When true, only render joints whose readouts include at least one
     *  field with |value| ≥ MOVED_DEG_THRESHOLD. Used on snapshot review so
     *  the panel collapses down to "what the clinician actually posed away
     *  from anatomic" rather than a wall of 0° rows. Live pose mode keeps
     *  the full panel so the clinician can see ROM context as they pose. */
    filterChangedOnly?: boolean;
    /** Heading shown in the panel header. Defaults to "Joint angles" but
     *  history review uses "Pose at snapshot" to make it obvious the
     *  numbers are from saved data, not the live rig. */
    title?: string;
  }
  let { report, filterChangedOnly = false, title = 'Joint angles' }: Props = $props();

  const MOVED_DEG_THRESHOLD = 1;

  function fieldMoved(value: number | undefined): boolean {
    return typeof value === 'number' && Math.abs(value) >= MOVED_DEG_THRESHOLD;
  }

  function jointMoved(set: Record<string, number> | undefined): boolean {
    if (!set) return false;
    for (const key of Object.keys(set)) {
      if (fieldMoved(set[key])) return true;
    }
    return false;
  }
</script>

<aside class="joint-angles" aria-label="Clinical joint angles">
  <header class="joint-angles__header">
    <h3 class="joint-angles__title">{title}</h3>
    {#if report?.at}
      <time class="joint-angles__timestamp" datetime={report.at}>
        {filterChangedOnly ? 'saved' : 'live'}
      </time>
    {/if}
  </header>
  <div class="joint-angles__body">
    {#if !report || Object.keys(report.joints).length === 0}
      <p class="joint-angles__empty">Pose the model to see clinical angles here.</p>
    {:else if filterChangedOnly && !ROM_JOINT_ROWS.some((row) => jointMoved(report.joints[row.canonicalKey]))}
      <p class="joint-angles__empty">No joints moved on this snapshot.</p>
    {:else}
      <table class="joint-angles__table">
        <tbody>
          {#each ROM_JOINT_ROWS as row (row.canonicalKey)}
            {@const set = report.joints[row.canonicalKey]}
            {#if set && (!filterChangedOnly || jointMoved(set))}
              <tr>
                <th scope="row">{row.label}</th>
                <td>
                  {#each row.fields as field (field.key)}
                    {#if set[field.key] !== undefined && (!filterChangedOnly || fieldMoved(set[field.key]))}
                      {@const state = getRomFieldState(set[field.key], field)}
                      <span
                        class={`joint-angles__field joint-angles__field--${state.status}`}
                        style={`--rom-color: ${field.color}; --rom-value: ${state.valuePercent}%; --rom-zero: ${state.zeroPercent}%;`}
                        title={`${field.label}: ${formatRomValue(state.value, field)} (${state.rangeText})`}
                      >
                        <span class="joint-angles__field-main">
                          <span class="joint-angles__field-label">{field.label}</span>
                          <span class="joint-angles__field-value">
                            {formatRomValue(state.value, field)}
                          </span>
                          {#if formatRomStatus(state)}
                            <span class="joint-angles__field-status">{formatRomStatus(state)}</span>
                          {/if}
                        </span>
                        <span
                          class="joint-angles__rom-track"
                          aria-label={`${field.label} range ${state.rangeText}`}
                        >
                          <span class="joint-angles__rom-zero"></span>
                          <span class="joint-angles__rom-marker"></span>
                        </span>
                      </span>
                    {/if}
                  {/each}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</aside>

<style>
  .joint-angles {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface-2, rgba(20, 24, 22, 0.92));
    color: var(--text-1, #e7eaea);
    border-radius: 12px;
    padding: 12px 14px;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 12px;
    overflow: hidden;
  }
  .joint-angles__header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .joint-angles__title {
    font-size: 13px;
    font-weight: 600;
    margin: 0;
    letter-spacing: 0.02em;
  }
  .joint-angles__timestamp {
    font-size: 10px;
    color: var(--text-3, rgba(231, 234, 234, 0.55));
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .joint-angles__body {
    overflow: auto;
  }
  .joint-angles__empty {
    margin: 8px 0;
    color: var(--text-3, rgba(231, 234, 234, 0.55));
    font-style: italic;
  }
  .joint-angles__table {
    width: 100%;
    border-collapse: collapse;
  }
  .joint-angles__table th,
  .joint-angles__table td {
    text-align: left;
    padding: 6px 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    vertical-align: top;
  }
  .joint-angles__table th {
    width: 34%;
    font-weight: 500;
    color: var(--text-2, rgba(231, 234, 234, 0.78));
  }
  .joint-angles__field {
    display: inline-grid;
    grid-template-rows: auto 4px;
    gap: 3px;
    min-width: 116px;
    max-width: 148px;
    margin-right: 10px;
    margin-bottom: 6px;
    color: var(--text-1, #e7eaea);
    font-variant-numeric: tabular-nums;
  }
  .joint-angles__field:last-child {
    margin-right: 0;
  }
  .joint-angles__field-main {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
  }
  .joint-angles__field-label {
    flex: 0 0 auto;
    color: var(--text-3, rgba(231, 234, 234, 0.55));
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .joint-angles__field-value {
    color: var(--text-1, #e7eaea);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .joint-angles__field-status {
    flex: 0 0 auto;
    border-radius: 999px;
    padding: 1px 4px;
    font-size: 9px;
    line-height: 1.25;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #111827;
    background: #facc15;
  }
  .joint-angles__field--outside .joint-angles__field-status {
    color: #fff;
    background: #ef4444;
  }
  .joint-angles__rom-track {
    position: relative;
    display: block;
    height: 4px;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.14));
    overflow: hidden;
  }
  .joint-angles__rom-zero,
  .joint-angles__rom-marker {
    position: absolute;
    top: 0;
    bottom: 0;
  }
  .joint-angles__rom-zero {
    left: var(--rom-zero);
    width: 1px;
    background: rgba(255, 255, 255, 0.45);
  }
  .joint-angles__rom-marker {
    left: var(--rom-value);
    width: 6px;
    transform: translateX(-50%);
    border-radius: 999px;
    background: var(--rom-color);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.28);
  }
  .joint-angles__field--near-limit .joint-angles__rom-marker {
    background: #facc15;
  }
  .joint-angles__field--outside .joint-angles__rom-marker {
    background: #ef4444;
  }
</style>
