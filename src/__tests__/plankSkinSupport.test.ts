import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { sampleComposedMotion, type RecordedFrame } from '../services/motionRecording';
import { createPlankSkinSupport } from '../services/plankSkinSupport';
import { captureFloorReference, floorReferenceForSupport, groundingContactsFor, pinContactsToFloor } from '../services/rootMotion';
import { createStageTwistOverlay } from '../services/stageTwistOverlay';
import { setRomClampEnabled } from '../services/poseRomClamp';

// Declare the same1mm visible floor-contact allowance used for the preceding
// flexion batch, before enabling/tuning a plank recipe. Exchange/native and
// stricter prone-support gates are separate, unchanged requirements.
const skinAllowanceM = .001;
describe.each(['male', 'female', 'neutral'] as const)('%s plank foot/toe skin support', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skinned: THREE.SkinnedMesh;
  let baseline: ReturnType<typeof serializeCustomPose>;
  let frames: RecordedFrame[];
  let twist: ReturnType<typeof createStageTwistOverlay>;
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  const groups: { skin: THREE.SkinnedMesh; vertices: Record<'L' | 'R', number[]> }[] = [];
  beforeAll(async () => {
    setRomClampEnabled(false);
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(object => {
      const skin = object as THREE.SkinnedMesh;
      if (!skin.isSkinnedMesh) return;
      skinned ??= skin;
      const indices = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
      const vertices: Record<'L' | 'R', number[]> = { L: [], R: [] };
      for (let vertex = 0; vertex < indices.count; vertex++) {
        let maximum = -1, name = '';
        for (let slot = 0; slot < weights.itemSize; slot++) if (weights.getComponent(vertex, slot) > maximum) {
          maximum = weights.getComponent(vertex, slot); name = skin.skeleton.bones[indices.getComponent(vertex, slot)]!.name;
        }
        if (/(?:Foot|Toe)/.test(name)) for (const side of ['L', 'R'] as const) if (name.includes(`_${side}_`)) vertices[side].push(vertex);
      }
      groups.push({ skin, vertices });
    });
    baseline = serializeCustomPose(skinned.skeleton, cfg, variant);
    const rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    position.copy(root.position); quaternion.copy(root.quaternion);
    twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
    frames = sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['trunk-stability-push-up']!('L'), cfg), {
      baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30,
    }).frames;
    expect(frames.length).toBeGreaterThan(150);
  });
  afterAll(() => setRomClampEnabled(null));
  function place(frame: RecordedFrame) {
    root.position.copy(position).add(new THREE.Vector3().fromArray(frame.root.translateM));
    root.quaternion.copy(quaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
    applyCustomPose(skinned.skeleton, cfg, frame.pose); root.updateMatrixWorld(true);
  }
  function locals() { return skinned.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]); }
  function actualMinimumY() {
    return twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true);
      const minima = { L: Infinity, R: Infinity }, point = new THREE.Vector3();
      for (const { skin, vertices } of groups) {
        skin.skeleton.update();
        for (const side of ['L', 'R'] as const) for (const vertex of vertices[side]) minima[side] = Math.min(minima[side], skin.getVertexPosition(vertex, point).applyMatrix4(skin.matrixWorld).y);
      }
      return minima;
    });
  }
  it('selects one bilateral setup branch while retaining the fixed palm targets', () => {
    const first = frames[0]!, last = frames.at(-1)!;
    const left = new THREE.Vector3().fromArray(first.worldTracks!.L_Forearm!);
    const right = new THREE.Vector3().fromArray(first.worldTracks!.R_Forearm!);
    // This explicitly mirrored authoring task shares one elbow branch at setup.
    // Use the existing 2mm contact allowance; later poses still follow their
    // individual clinical projections rather than enforced visual symmetry.
    right.x = -right.x;
    expect(left.distanceTo(right), 'mirrored setup elbows').toBeLessThan(.002);
    for (const key of ['L_Hand', 'R_Hand']) {
      const start = new THREE.Vector3().fromArray(first.worldTracks![key]!);
      for (const frame of frames) expect(start.distanceTo(new THREE.Vector3().fromArray(frame.worldTracks![key]!)), `${key} remains planted`).toBeLessThan(.002);
    }
    expect(Object.keys(first.pose.bones)).toEqual(Object.keys(last.pose.bones));
    for (const [key, quat] of Object.entries(first.pose.bones)) for (let component = 0; component < 4; component++) {
      expect(last.pose.bones[key]![component], `${key} loop component`).toBeCloseTo(quat[component]!, 12);
    }
  });
  it('bypasses the bilateral setup preference for explicit patient limits', () => {
    const source = BODY_ASSESSMENT_MOTIONS['trunk-stability-push-up']!('L');
    const unseeded = structuredClone(source);
    for (const contact of unseeded.contacts ?? []) if (contact.palmSupport) delete contact.palmSupport.bilateralSetupSeed;
    const constraints = { L_Hand: { wristFlexion: { availableRange: { min: -70, max: 70 } } } };
    const sample = (motion: typeof source) => {
      root.position.copy(position); root.quaternion.copy(quaternion);
      applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
      return sampleComposedMotion(resolveComposedMotion(motion, cfg, { constraints }), {
        baselinePose: baseline, variantCfg: cfg, rest: captureJointAngleRestReference(skinned.skeleton, cfg),
        skeletonHarness: { root, skinned }, frameTimesMs: [0, 2500, 5600], sampleHz: 30,
      });
    };
    const withoutPreference = sample(unseeded), withPreference = sample(source);
    expect(withoutPreference.frames.length).toBeGreaterThan(0);
    expect(withPreference.refusalReason).toEqual(withoutPreference.refusalReason);
    expect(withPreference.frames.map(frame => ({ pose: frame.pose, root: frame.root })))
      .toEqual(withoutPreference.frames.map(frame => ({ pose: frame.pose, root: frame.root })));
  });
  it('retains an asymmetric authored setup instead of imposing a mirrored branch', () => {
    const source = BODY_ASSESSMENT_MOTIONS['trunk-stability-push-up']!('L');
    for (const keyframe of source.keyframes) {
      const elbow = keyframe.targets?.find(target => target.joint === 'R_Forearm' && target.motion === 'elbowFlexion');
      if (elbow) elbow.targetDegrees = 60;
    }
    const unseeded = structuredClone(source);
    for (const contact of unseeded.contacts ?? []) if (contact.palmSupport) delete contact.palmSupport.bilateralSetupSeed;
    const sample = (motion: typeof source) => {
      root.position.copy(position); root.quaternion.copy(quaternion);
      applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
      return sampleComposedMotion(resolveComposedMotion(motion, cfg), {
        baselinePose: baseline, variantCfg: cfg, rest: captureJointAngleRestReference(skinned.skeleton, cfg),
        skeletonHarness: { root, skinned }, frameTimesMs: [0, 2500, 5600], sampleHz: 30,
      });
    };
    const individual = sample(unseeded), requested = sample(source);
    expect(individual.frames.length).toBeGreaterThan(0);
    expect(requested.frames.map(frame => ({ pose: frame.pose, root: frame.root })))
      .toEqual(individual.frames.map(frame => ({ pose: frame.pose, root: frame.root })));
  });
  it('grounds actual foot/toe skin through the complete motion without changing any local joint', () => {
    const support = createPlankSkinSupport({ root, skinned, variantCfg: cfg, baselinePose: baseline });
    const floor = floorReferenceForSupport(captureFloorReference(skinned.skeleton, cfg), 0);
    floor.plankSupport = support;
    for (const frame of frames) {
      place(frame);
      const recordedMinimum = actualMinimumY();
      for (const side of ['L', 'R'] as const) expect(Math.abs(recordedMinimum[side]), `${side} replayed support at${frame.tMs}`).toBeLessThan(skinAllowanceM);
      const before = locals(), rotation = root.quaternion.clone();
      pinContactsToFloor(root, skinned.skeleton, cfg, groundingContactsFor('plank', floor));
      const measured = actualMinimumY();
      for (const side of ['L', 'R'] as const) expect(Math.abs(measured[side]), `${side} foot/toe skin at${frame.tMs}`).toBeLessThan(skinAllowanceM);
      expect(locals(), 'all101 production locals are preserved').toEqual(before);
      expect(root.quaternion.toArray(), 'body pitch is authored').toEqual(rotation.toArray());
      const grounded = root.position.clone();
      pinContactsToFloor(root, skinned.skeleton, cfg, groundingContactsFor('plank', floor));
      expect(root.position.distanceTo(grounded), 'repeated support must not drift').toBeLessThan(1e-8);
    }
  });
  it('does not leak prepared skin support into later motions', () => {
    const floor = floorReferenceForSupport(captureFloorReference(skinned.skeleton, cfg), 0);
    floor.plankSupport = createPlankSkinSupport({ root, skinned, variantCfg: cfg, baselinePose: baseline });
    expect(floorReferenceForSupport(floor).plankSupport).toBeUndefined();
    expect(groundingContactsFor('standing', floor).every(contact => !contact.prepare)).toBe(true);
  });
  it('rejects a mixed or missing support plane and preserves resolver-only patient constraints', () => {
    const source = BODY_ASSESSMENT_MOTIONS['trunk-stability-push-up']!('L');
    const supported = { ...source, supportPlaneY: 0, plankSkinSupport: true };
    expect(resolveComposedMotion(supported, cfg).plankSkinSupport).toBe(true);
    const constraints = { L_Forearm: { elbowFlexion: { availableRange: { min: 0, max: 120 } } } };
    expect(resolveComposedMotion(supported, cfg, { constraints }).constraints).toEqual(constraints);
    expect(resolveComposedMotion({ ...supported, supportPlaneY: undefined }, cfg).plankSkinSupport).toBeUndefined();
    expect(resolveComposedMotion({ ...supported, kneelingSkinSupport: true }, cfg).plankSkinSupport).toBeUndefined();
  });
});
