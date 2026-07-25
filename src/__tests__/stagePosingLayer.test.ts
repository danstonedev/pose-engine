/**
 * POSING-LAYER EXTRACTION GUARDS.
 *
 * `createPosingLayer` needs a live WebGL renderer + TransformControls, so it
 * cannot be constructed headlessly — the same reason `ExamStage3D.svelte`
 * itself is untestable. What CAN be locked down is the CONTRACT the extraction
 * established, and in particular the two hazards that were found by reading the
 * original code and would have been silent regressions:
 *
 *  1. The block's `if (disposed) return;` returned from the STAGE'S BOOT IIFE,
 *     not from the block — it aborted the whole boot (`loadModel` never ran).
 *     Turning it into a plain early-return inside a function would have silently
 *     let boot continue. The layer must return `null`, and the stage must
 *     re-raise the abort.
 *  2. Ownership runs ONE WAY. The layer returns its hooks + api; it must never
 *     reach back and assign the stage's `poseLayer*` / `poseApiImpl` variables,
 *     and the only stage state it may write is `currentPose`, via
 *     `setCurrentPose`.
 *
 * These are structural, so they are checked against the module source — the
 * same technique the stage's own guards use, but now pointed at a file that is
 * one concern instead of five.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const layerSource = readFileSync(
  fileURLToPath(new URL('../services/stagePosingLayer.ts', import.meta.url)),
  'utf8',
);
const stageSource = readFileSync(
  fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)),
  'utf8',
);

describe('posing layer — the disposed-during-load abort (hazard 1)', () => {
  it('the layer returns null when the stage was disposed while the module loaded', () => {
    expect(layerSource).toMatch(/if \(stageCtx\.disposed\) return null;/);
    // …and that is the documented meaning of a null return.
    expect(layerSource).toMatch(/PosingLayer \| null/);
  });

  it('the stage RE-RAISES the abort — a null layer must stop the boot, not just skip posing', () => {
    // The `return` here exits the boot IIFE, so loadModel() below never runs —
    // exactly what the old inline `if (disposed) return;` did. Downgrading this
    // to a `continue`/no-op would boot a disposed stage.
    expect(stageSource).toMatch(/if \(!layer\) return;/);
    // The abort must come BEFORE the hooks are wired and BEFORE loadModel.
    expect(stageSource).toMatch(
      /if \(!layer\) return;[\s\S]{0,600}poseLayerOnTakeover = layer\.hooks\.onTakeover;/,
    );
    expect(stageSource).toMatch(
      /if \(!layer\) return;[\s\S]{0,3000}await loadModel\(variant, modelUrl, authoredPose\);/,
    );
  });
});

describe('posing layer — ownership runs one way (hazard 2)', () => {
  it('the layer never assigns the stage’s hook or api variables', () => {
    // Assignment only — a *reference* would be fine, but there should be none
    // of either; the stage wires these from the returned object.
    for (const name of [
      'poseLayerOnTakeover',
      'poseLayerOnModelLoaded',
      'poseLayerBeforeRender',
      'poseLayerAfterRender',
      'poseLayerBusy',
      'poseLayerDispose',
      'poseApiImpl',
    ]) {
      expect(layerSource, `${name} must stay the stage's own`).not.toContain(name);
    }
  });

  it('the layer returns every lifecycle hook plus the api', () => {
    expect(layerSource).toMatch(
      /return \{\s*\n\s*hooks: \{ onTakeover, onModelLoaded, beforeRender, afterRender, busy, dispose \},\s*\n\s*api,\s*\n\s*\};/,
    );
  });

  it('the ONLY stage state the layer writes is currentPose, through setCurrentPose', () => {
    // Every write goes through the callback…
    expect(layerSource.match(/stageCtx\.setCurrentPose\(/g) ?? []).toHaveLength(4);
    // …and never by assigning a stage field directly.
    expect(layerSource).not.toMatch(/stageCtx\.\w+\s*=(?!=)/);
    // The context exposes the rig/driver state as READ-ONLY.
    expect(layerSource).toMatch(/readonly skinnedRef:/);
    expect(layerSource).toMatch(/readonly modelRoot:/);
    expect(layerSource).toMatch(/readonly disposed: boolean;/);
  });

  it('the stage clears its own hook + api around the layer’s teardown, in the original order', () => {
    // The original dispose set poseLayerBusy = null FIRST (stop suspending idle
    // liveliness) and poseApiImpl = null LAST (after teardown). Both lines were
    // hoisted out of the moved block, so the order is pinned here.
    expect(stageSource).toMatch(
      /poseLayerDispose = \(\) => \{\s*\n\s*poseLayerBusy = null;[\s\S]{0,120}layer\.hooks\.dispose\(\);\s*\n\s*poseApiImpl = null;\s*\n\s*\};/,
    );
  });
});

describe('posing layer — it stays out of a default consumer’s bundle', () => {
  it('the stage reaches the layer through a DYNAMIC import, gated on `posable`', () => {
    expect(stageSource).toMatch(
      /if \(posable\) \{\s*\n\s*const \{ createPosingLayer \} = await import\('\.\/services\/stagePosingLayer'\);/,
    );
    // A static import would pull TransformControls + the whole posing stack into
    // every consumer (and into SSR). The only static mention may be type-only.
    const staticImport = /^\s*import\s+(?!type\b)[^;]*from '\.\/services\/stagePosingLayer'/m;
    expect(stageSource).not.toMatch(staticImport);
  });

  it('the host-facing option types live with the layer and are re-exported by the stage', () => {
    for (const t of ['StagePosingOptions', 'StagePlaneVisibility', 'StageSliceOptions', 'StagePoseApi']) {
      expect(layerSource).toMatch(new RegExp(`export interface ${t}\\b`));
    }
    // Hosts keep importing them from the component.
    expect(stageSource).toMatch(/export type StagePosingOptions = PosingOptions;/);
    expect(stageSource).toMatch(/export type StagePlaneVisibility = PlaneVisibility;/);
    expect(stageSource).toMatch(/export type StageSliceOptions = SliceOptions;/);
  });
});
