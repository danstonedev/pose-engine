import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { createStageTwistOverlay } from '../services/stageTwistOverlay';
import { createProneSkinSupport } from '../services/proneSkinSupport';
import { getEffectiveRomRange } from '../services/romConstraints';

describe.each(['male', 'female', 'neutral'] as const)('%s prone skin support helper', variant => {
  it('uses actual skin to support both legs/toes, preserves source ownership and reports restricted reach', async () => {
    const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    const skins: THREE.SkinnedMesh[] = [];
    root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skins.push(object as THREE.SkinnedMesh); });
    const skinned = skins[0]!;
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    const twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
    const beforeFactory = serializeCustomPose(skinned.skeleton, cfg, variant);
    const support = createProneSkinSupport({ root, skinned, variantCfg: cfg, baselinePose, rest });
    expect(serializeCustomPose(skinned.skeleton, cfg, variant)).toEqual(beforeFactory);
    expect(support.pelvisSurface.meshes.length).toBeGreaterThan(0);
    const referencePosition = root.position.clone(), referenceQuaternion = root.quaternion.clone();
    const recording = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R'), cfg), {
      baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 5,
    });
    // Independent whole lower-skin check, including proximal thighs, feet,
    // helper-weighted vertices and all material meshes. It does not reuse the
    // support helper's selected distal envelope or cached witness membership.
    const vertices = skins.map(skin => {
      const ids = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight'), indices: number[] = [];
      for (let i = 0; i < ids.count; i++) {
        let largest = -1, name = '';
        for (let slot = 0; slot < weights.itemSize; slot++) if (weights.getComponent(i, slot) > largest) {
          largest = weights.getComponent(i, slot); name = skin.skeleton.bones[ids.getComponent(i, slot)]!.name;
        }
        if (/(?:Thigh|Calf|Foot|Toe)/.test(name)) indices.push(i);
      }
      return { skin, indices };
    });
    const rows: { timeMs: number; elapsedMs: number; feasible: boolean; coordinates: unknown; gaps: Record<string, number>; reasons: string[] }[] = [];
    const cacheTimes: number[] = [];
    for (const frame of recording.frames) {
      root.position.copy(referencePosition).add(new THREE.Vector3().fromArray(frame.root.translateM));
      root.quaternion.copy(referenceQuaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
      applyCustomPose(skinned.skeleton, cfg, frame.pose); root.updateMatrixWorld(true);
      const before = serializeCustomPose(skinned.skeleton, cfg, variant), rootBefore = root.position.toArray();
      const start = performance.now(), result = support.solve({ floorY: 0 }), elapsedMs = performance.now() - start;
      rows.push({ timeMs: frame.tMs, elapsedMs, feasible: result.feasible, coordinates: result.correctedDegrees,
        gaps: Object.fromEntries(Object.entries(result.regions).map(([key, value]) => [key, value.gapM])), reasons: result.reasons });
      expect(result.feasible, JSON.stringify(rows.at(-1))).toBe(true);
      expect(root.position.toArray()).toEqual(rootBefore);
      const after = serializeCustomPose(skinned.skeleton, cfg, variant);
      const changed = new Set(['Spine_Mid', 'Spine_Upper', 'L_UpLeg', 'R_UpLeg', 'L_Leg', 'R_Leg']);
      for (const [key, quaternion] of Object.entries(before.bones)) if (!changed.has(key)) expect(after.bones[key], key).toEqual(quaternion);
      const measured = computeJointAngles(skinned.skeleton, cfg, variant, rest).joints;
      for (const active of result.activeLimits) {
        const [joint, field] = active.split('.'), range = getEffectiveRomRange(null, joint!, field!)!;
        const actual = measured[joint!]![field!]!;
        expect(Math.min(Math.abs(actual - range.min), Math.abs(actual - range.max))).toBeLessThanOrEqual(.0001);
      }
      for (const side of ['L', 'R']) for (const [part, field] of [['UpLeg', 'hipFlexion'], ['Leg', 'kneeFlexion'], ['Foot', 'ankleFlexion'], ['Toes', 'toeFlexion']]) {
        const key = `${side}_${part}`, range = getEffectiveRomRange(null, key, field)!;
        expect(measured[key]![field]!, `${key}.${field}`).toBeGreaterThanOrEqual(range.min - .05);
        expect(measured[key]![field]!, `${key}.${field}`).toBeLessThanOrEqual(range.max + .05);
      }
      const again = support.solve();
      expect(again.feasible).toBe(true);
      expect(again.iterations, `already feasible source at ${frame.tMs}`).toBe(0);
      const repeated = serializeCustomPose(skinned.skeleton, cfg, variant);
      for (const [key, quaternion] of Object.entries(after.bones)) {
        expect(repeated.bones[key], key).toEqual(quaternion);
      }
      applyCustomPose(skinned.skeleton, cfg, before);
      const cacheStart = performance.now(), replay = support.solve();
      cacheTimes.push(performance.now() - cacheStart);
      expect(replay.reusedSolution, `same source at ${frame.tMs}`).toBe(true);
      expect(serializeCustomPose(skinned.skeleton, cfg, variant)).toEqual(after);
      if (frame.tMs === 0) {
        root.position.y += 1;
        const moved = support.solve();
        expect(moved.reusedSolution).toBe(true);
        expect(moved.requiredRootTranslationM).toBeCloseTo(result.requiredRootTranslationM - 1, 6);
        expect(moved.regions.L_toes.gapM).toBeCloseTo(result.regions.L_toes.gapM, 6);
        root.position.y -= 1;
      }
      root.position.y += result.requiredRootTranslationM; root.updateMatrixWorld(true);
      let minimum = Infinity;
      twist.sampleWithTwist(() => {
        // Twist writes helper locals; CPU skinning reads their world matrices.
        // Updating the GPU palette alone does not propagate those transforms.
        root.updateMatrixWorld(true);
        const point = new THREE.Vector3();
        for (const { skin, indices } of vertices) {
          skin.skeleton.update();
          for (const index of indices) minimum = Math.min(minimum, skin.getVertexPosition(index, point).applyMatrix4(skin.matrixWorld).y);
        }
      });
      expect(minimum, `full leg clearance at ${frame.tMs}`).toBeGreaterThan(-.00006);
    }
    console.log('PRONE_SKIN_SUPPORT', JSON.stringify({ variant, samples: rows.length,
      solveMs: { mean: rows.reduce((sum, row) => sum + row.elapsedMs, 0) / rows.length, max: Math.max(...rows.map(row => row.elapsedMs)) },
      cachedMs: { mean: cacheTimes.reduce((sum, value) => sum + value, 0) / cacheTimes.length, max: Math.max(...cacheTimes) },
      worstRegionGapM: Object.fromEntries(Object.keys(rows[0]!.gaps).map(key => [key, Math.min(...rows.map(row => row.gaps[key]!))])), first: rows[0], last: rows.at(-1) }));
    const first = recording.frames[0]!;
    root.position.copy(referencePosition).add(new THREE.Vector3().fromArray(first.root.translateM));
    root.quaternion.copy(referenceQuaternion).multiply(new THREE.Quaternion().fromArray(first.root.orientQuat));
    applyCustomPose(skinned.skeleton, cfg, first.pose);
    const constraints = Object.fromEntries(['L', 'R'].flatMap(side => [
      [`${side}_UpLeg`, { hipFlexion: { availableRange: { min: 0, max: 0 } } }],
      [`${side}_Leg`, { kneeFlexion: { availableRange: { min: 0, max: 0 } } }],
    ]));
    const restricted = support.solve({ constraints });
    expect(restricted.feasible).toBe(false);
    expect(restricted.reasons.some(reason => reason.includes('restricted'))).toBe(true);
    expect(restricted.correctedDegrees.L_hipFlexion).toBeCloseTo(0, 4);
    expect(restricted.correctedDegrees.R_hipFlexion).toBeCloseTo(0, 4);
    expect(restricted.correctedDegrees.L_kneeFlexion).toBeCloseTo(0, 4);
    expect(restricted.correctedDegrees.R_kneeFlexion).toBeCloseTo(0, 4);
    applyCustomPose(skinned.skeleton, cfg, first.pose);
    const ankleRestricted = support.solve({ constraints: { R_Foot: { ankleFlexion: { availableRange: { min: -30 } } } } });
    expect(ankleRestricted.reusedSolution).toBe(false);
    // Float32 asset rest rotations leave a few millionths of a degree of
    // readout noise; this checks the changed patient boundary to 0.00005°.
    expect(computeJointAngles(skinned.skeleton, cfg, variant, rest).joints.R_Foot!.ankleFlexion!).toBeCloseTo(-30, 4);
  }, 60000);
});
