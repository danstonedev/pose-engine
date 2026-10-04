import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { createStageTwistOverlay } from '../services/stageTwistOverlay';
import { getEffectiveRomRange } from '../services/romConstraints';

const supportTimings = vi.hoisted(() => [] as { ms: number; reused: boolean }[]);
vi.mock('../services/proneSkinSupport', async importOriginal => {
  const original = await importOriginal<typeof import('../services/proneSkinSupport')>();
  return { ...original, createProneSkinSupport: (...args: Parameters<typeof original.createProneSkinSupport>) => {
    const support = original.createProneSkinSupport(...args);
    return { ...support, solve: (...input: Parameters<typeof support.solve>) => {
      const start = performance.now(), result = support.solve(...input);
      supportTimings.push({ ms: performance.now() - start, reused: result.reusedSolution });
      return result;
    } };
  } };
});

describe.each(['male', 'female', 'neutral'] as const)('%s integrated prone skin support', variant => {
  it('grounds final rendered skin through the cycle and exposes restricted support without leaking into the next motion', async () => {
    const cfg = BODY_VARIANTS[variant], bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    const skins: THREE.SkinnedMesh[] = [];
    root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skins.push(object as THREE.SkinnedMesh); });
    const skinned = skins[0]!;
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    const baselinePose = serializeCustomPose(skinned.skeleton, cfg, variant), rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    const referencePosition = root.position.clone(), referenceQuaternion = root.quaternion.clone();
    const twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
    const source = BODY_ASSESSMENT_MOTIONS['extension-clearing']!('R');
    // The authored recipe now opts in. Keep a deliberate opt-out fixture to
    // verify that a following unsupported motion inherits no helper state.
    const normal = resolveComposedMotion({ ...source, proneSkinSupport: false, pronePalmAnchorFit: false }, cfg);
    const flagged = resolveComposedMotion({ ...source, proneSkinSupport: true }, cfg);
    const options = { baselinePose, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60 };
    const sparseTimes = [0, 1000, 2500, 3000, 4400, 5400];
    const before = sampleComposedMotion(normal, { ...options, frameTimesMs: sparseTimes });
    supportTimings.length = 0;
    const start = performance.now(), recording = sampleComposedMotion(flagged, options), samplingMs = performance.now() - start;
    const supportMs = supportTimings.reduce((sum, entry) => sum + entry.ms, 0);
    const supportPerformance = { calls: supportTimings.length, cachedCalls: supportTimings.filter(entry => entry.reused).length,
      totalMs: supportMs, fractionOfSamplingTime: supportMs / samplingMs,
      freshMeanMs: supportTimings.filter(entry => !entry.reused).reduce((sum, entry) => sum + entry.ms, 0) / supportTimings.filter(entry => !entry.reused).length };
    const groups = skins.map(skin => {
      const ids = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
      const classified: Record<string, number[]> = { all: [], pelvis: [], torso: [], legs: [], head: [], L_toes: [], R_toes: [], L_hand: [], R_hand: [] };
      for (let vertex = 0; vertex < ids.count; vertex++) {
        let maximum = -1, name = '';
        for (let slot = 0; slot < weights.itemSize; slot++) if (weights.getComponent(vertex, slot) > maximum) {
          maximum = weights.getComponent(vertex, slot); name = skin.skeleton.bones[ids.getComponent(vertex, slot)]!.name;
        }
        classified.all.push(vertex);
        if (/(?:Hip|Pelvis)$/.test(name)) classified.pelvis.push(vertex);
        if (/(?:Waist|Spine|Breast|Ribs)/.test(name)) classified.torso.push(vertex);
        if (/(?:Thigh|Calf|Foot|Toe)/.test(name)) classified.legs.push(vertex);
        if (/(?:Head|Neck)/.test(name)) classified.head.push(vertex);
        for (const side of ['L', 'R']) {
          if (name.includes(`_${side}_`) && /Toe/.test(name)) classified[`${side}_toes`]!.push(vertex);
          if (name.includes(`_${side}_`) && /(?:Hand|Finger|Thumb|Index|Middle|Ring|Pinky)/.test(name)) classified[`${side}_hand`]!.push(vertex);
        }
      }
      return { skin, classified };
    });
    const keys = Object.keys(groups[0]!.classified), worst = Object.fromEntries(keys.map(key => [key, Infinity]));
    for (const key of keys) expect(groups.some(group => group.classified[key]!.length), `measured region ${key}`).toBe(true);
    const highest = Object.fromEntries(keys.map(key => [key, -Infinity]));
    const rows: unknown[] = [], point = new THREE.Vector3();
    let infeasibleCount = 0;
    for (const frame of recording.frames) {
      root.position.copy(referencePosition).add(new THREE.Vector3().fromArray(frame.root.translateM));
      root.quaternion.copy(referenceQuaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
      applyCustomPose(skinned.skeleton, cfg, frame.pose);
      const minima = Object.fromEntries(keys.map(key => [key, Infinity]));
      twist.sampleWithTwist(() => {
        root.updateMatrixWorld(true);
        for (const { skin, classified } of groups) {
          skin.skeleton.update();
          for (const [region, vertices] of Object.entries(classified)) for (const vertex of vertices) {
            minima[region] = Math.min(minima[region]!, skin.getVertexPosition(vertex, point).applyMatrix4(skin.matrixWorld).y);
          }
        }
      });
      expect(frame.proneSupport).toBeDefined();
      if (!frame.proneSupport!.feasible) infeasibleCount++;
      for (const key of keys) { worst[key] = Math.min(worst[key]!, minima[key]!); highest[key] = Math.max(highest[key]!, minima[key]!); }
      rows.push({ tMs: frame.tMs, minima, feasible: frame.proneSupport!.feasible, reasons: frame.proneSupport!.reasons });
      for (const side of ['L', 'R']) for (const [part, field] of [['UpLeg', 'hipFlexion'], ['Leg', 'kneeFlexion'], ['Foot', 'ankleFlexion'], ['Toes', 'toeFlexion']]) {
        const key = `${side}_${part}`, range = getEffectiveRomRange(null, key, field)!;
        expect(frame.angles[key]![field]!, `${frame.tMs} ${key}.${field}`).toBeGreaterThanOrEqual(range.min - .05);
        expect(frame.angles[key]![field]!, `${frame.tMs} ${key}.${field}`).toBeLessThanOrEqual(range.max + .05);
      }
    }
    console.log('INTEGRATED_PRONE_SKIN_SUPPORT', JSON.stringify({ variant, samples: recording.frames.length, samplingMs, supportPerformance, infeasibleCount, worst, highest,
      first: rows[0], last: rows.at(-1), scope: 'Flagged clone of existing recipe; final rendered geometry and lower-chain bounds. Upper-chain clinical, visual, native tracking and both-host acceptance remain separate.' }));
    expect(infeasibleCount).toBe(0);
    expect(Math.max(Math.abs(worst.pelvis!), Math.abs(highest.pelvis!))).toBeLessThan(.00015);
    for (const key of ['torso', 'head', 'legs']) expect(worst[key]!, key).toBeGreaterThan(-.00015);
    for (const key of ['L_toes', 'R_toes']) expect(Math.max(Math.abs(worst[key]!), Math.abs(highest[key]!)), key).toBeLessThan(.00015);

    root.position.copy(referencePosition); root.quaternion.copy(referenceQuaternion);
    const constraints = Object.fromEntries(['L', 'R'].flatMap(side => [
      [`${side}_UpLeg`, { hipFlexion: { availableRange: { min: 0, max: 0 } } }],
      [`${side}_Leg`, { kneeFlexion: { availableRange: { min: 0, max: 0 } } }],
    ]));
    const restricted = sampleComposedMotion(flagged, { ...options, constraints, frameTimesMs: sparseTimes });
    expect(restricted.frames.every(frame => frame.proneSupport && !frame.proneSupport.feasible)).toBe(true);
    for (const frame of restricted.frames) for (const side of ['L', 'R']) {
      expect(Math.abs(frame.angles[`${side}_UpLeg`]!.hipFlexion!)).toBeLessThan(.05);
      expect(Math.abs(frame.angles[`${side}_Leg`]!.kneeFlexion!)).toBeLessThan(.05);
    }
    const following = sampleComposedMotion(normal, { ...options, frameTimesMs: sparseTimes });
    expect(following.frames.every(frame => frame.proneSupport === undefined)).toBe(true);
    expect(following.frames).toEqual(before.frames);

    // A Blender-authored bent leg must initialize the same command-space
    // residual used by the finite probes, despite the rig's geometric rest bend.
    const bentSeed = structuredClone(source);
    bentSeed.proneSkinSupport = true;
    for (const frame of bentSeed.keyframes) for (const side of ['L', 'R']) for (const [part, motion, degrees] of [['UpLeg', 'hipFlexion', 6], ['Leg', 'kneeFlexion', 10]] as const) {
      const target = frame.targets!.find(item => item.joint === `${side}_${part}` && item.motion === motion)!;
      target.targetDegrees = degrees;
    }
    const bent = sampleComposedMotion(resolveComposedMotion(bentSeed, cfg), { ...options, frameTimesMs: [0] });
    expect(bent.frames[0]!.proneSupport!.feasible, JSON.stringify(bent.frames[0]!.proneSupport)).toBe(true);
  }, 120000);
});
