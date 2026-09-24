/**
 * The host scene layer (ExamStage3D's `sceneLayer` prop). The guarded mount is
 * exercised directly; the stage's wiring is pinned against its source, as
 * stageDriverWiring.test.ts does, since the stage (WebGL + Svelte) cannot be
 * mounted here.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mountSceneLayer, type StageSceneContext } from '../services/stageSceneLayer';

const context = {} as StageSceneContext;
const quiet = () => {};

describe('mountSceneLayer', () => {
  it('is null for the default stage (no factory)', () => {
    expect(mountSceneLayer(null, context)).toBeNull();
    expect(mountSceneLayer(undefined, context)).toBeNull();
  });

  it('hands the factory the context and drives every hook', () => {
    const calls: string[] = [];
    let seen: StageSceneContext | null = null;
    const mounted = mountSceneLayer((ctx) => {
      seen = ctx;
      return {
        onModelLoaded: () => calls.push('loaded'),
        beforeRender: () => calls.push('render'),
        wantsFrame: () => true,
        dispose: () => calls.push('dispose'),
      };
    }, context)!;
    expect(seen).toBe(context);
    mounted.onModelLoaded();
    mounted.beforeRender();
    expect(mounted.wantsFrame()).toBe(true);
    mounted.dispose();
    expect(calls).toEqual(['loaded', 'render', 'dispose']);
    expect(mounted.active).toBe(false);
  });

  it('treats missing hooks as no-ops, and a layer that only draws as never asking for frames', () => {
    const mounted = mountSceneLayer(() => ({}), context)!;
    expect(() => {
      mounted.onModelLoaded();
      mounted.beforeRender();
      mounted.dispose();
    }).not.toThrow();
    expect(mountSceneLayer(() => ({}), context)!.wantsFrame()).toBe(false);
  });

  it('is null when the factory returns nothing, and when it throws (logged, never rethrown)', () => {
    expect(mountSceneLayer(() => undefined, context, quiet)).toBeNull();
    const log = vi.fn();
    expect(mountSceneLayer(() => { throw new Error('boom'); }, context, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('retires a layer whose hook throws: disposed once, logged once, silent afterwards', () => {
    const log = vi.fn();
    const dispose = vi.fn();
    let renders = 0;
    const mounted = mountSceneLayer(() => ({
      beforeRender: () => { renders += 1; throw new Error('bad frame'); },
      wantsFrame: () => true,
      dispose,
    }), context, log)!;
    expect(() => mounted.beforeRender()).not.toThrow();
    expect(mounted.active).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    mounted.beforeRender();
    expect(mounted.wantsFrame()).toBe(false);
    mounted.dispose();
    expect(renders).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes only once', () => {
    const dispose = vi.fn();
    const mounted = mountSceneLayer(() => ({ dispose }), context)!;
    mounted.dispose();
    mounted.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('ExamStage3D wiring of the scene layer', () => {
  const source = readFileSync(fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

  it('defaults to no layer, so other consumers are untouched', () => {
    expect(source).toMatch(/\n\s+sceneLayer = null,\n/);
    expect(source).toMatch(/if \(sceneLayer && !disposed\) \{\n\s+sceneLayerHooks = mountSceneLayer\(sceneLayer, \{/);
  });

  it('draws the layer after the pose and every live overlay are final, right before the draw', () => {
    const loop = source.slice(source.indexOf('const loop = () => {'), source.indexOf('const startLoop = () => {'));
    const at = (needle: string) => {
      const index = loop.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(at('applyEyeGaze(motionDelta)')).toBeLessThan(at('sceneLayerHooks?.beforeRender()'));
    expect(at('sceneLayerHooks?.wantsFrame()')).toBeLessThan(at('if (!renderNeeded) return;'));
    expect(at('sceneLayerHooks?.beforeRender()')).toBeLessThan(at('renderer.render(scene, camera)'));
  });

  it('re-anchors on every model load and is disposed before the scene is torn down', () => {
    expect(source).toMatch(/poseLayerOnModelLoaded\?\.\(\);\n\s+sceneLayerHooks\?\.onModelLoaded\(\);/);
    const cleanup = source.slice(source.indexOf('\n      cleanup = () => {'));
    expect(cleanup.indexOf('sceneLayerHooks?.dispose()')).toBeLessThan(cleanup.indexOf('disposeModel()'));
    expect(cleanup.indexOf('sceneLayerHooks?.dispose()')).toBeLessThan(cleanup.indexOf('renderer.dispose()'));
  });

  it('mounts before the first model load, so the layer hears about it', () => {
    expect(source.indexOf('sceneLayerHooks = mountSceneLayer(')).toBeLessThan(source.lastIndexOf('await loadModel(variant, modelUrl, authoredPose);'));
  });
});
