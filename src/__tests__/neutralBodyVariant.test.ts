import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BODY_VARIANTS, getBodyVariant } from '../anatomy/bodyVariants';

let neutralDoc: Document;
let maleDoc: Document;

beforeAll(async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
  });
  [neutralDoc, maleDoc] = await Promise.all([
    io.read(fileURLToPath(new URL('../../models/painmap3D_neutral.runtime.glb', import.meta.url))),
    io.read(fileURLToPath(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url))),
  ]);
});

describe('neutral youth body variant', () => {
  it('is registered as a distinct, explicitly described model', () => {
    expect(getBodyVariant('neutral')).toBe(BODY_VARIANTS.neutral);
    expect(BODY_VARIANTS.neutral.label).toBe('Youth / neutral');
    expect(BODY_VARIANTS.neutral.description).toMatch(/older-adolescent/i);
    expect(BODY_VARIANTS.neutral.modelUrl('')).toBe('/models/painmap3D_neutral.runtime.glb');
    expect(BODY_VARIANTS.neutral.referenceHeightWorld).toBe(1.65);
    expect(BODY_VARIANTS.neutral.defaultBodySurfaceAreaCm2).toBe(15880);
  });

  it('keeps the complete production CC rig and default animation', () => {
    const root = neutralDoc.getRoot();
    expect(root.listNodes()).toHaveLength(103);
    expect(root.listSkins()).toHaveLength(1);
    expect(root.listSkins()[0].listJoints()).toHaveLength(101);
    expect(root.listAnimations()).toHaveLength(1);
    expect(root.listAnimations()[0].getName()).toBe('Armature|Default');
    expect(root.listAnimations()[0].listChannels()).toHaveLength(303);
  });

  it('shares the canonical CC UVs, joints, and atlas triangle ordering', () => {
    const neutralPrimitives = neutralDoc.getRoot().listMeshes()[0].listPrimitives();
    const malePrimitives = maleDoc.getRoot().listMeshes()[0].listPrimitives();
    expect(neutralPrimitives).toHaveLength(6);

    for (let index = 0; index < neutralPrimitives.length; index++) {
      const neutral = neutralPrimitives[index];
      const male = malePrimitives[index];
      expect(Array.from(neutral.getAttribute('TEXCOORD_0')!.getArray()!)).toEqual(
        Array.from(male.getAttribute('TEXCOORD_0')!.getArray()!),
      );
      expect(Array.from(neutral.getAttribute('JOINTS_0')!.getArray()!)).toEqual(
        Array.from(male.getAttribute('JOINTS_0')!.getArray()!),
      );
      expect(Array.from(neutral.getIndices()!.getArray()!)).toEqual(
        Array.from(male.getIndices()!.getArray()!),
      );

      const weights = neutral.getAttribute('WEIGHTS_0')!.getArray()!;
      for (let offset = 0; offset < weights.length; offset += 4) {
        const total = weights[offset] + weights[offset + 1] + weights[offset + 2] + weights[offset + 3];
        expect(Number.isFinite(total)).toBe(true);
        expect(total).toBeCloseTo(1, 4);
      }
    }
  });
});
