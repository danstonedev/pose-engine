import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, measureHingeFlexion } from '../services/jointAngles';
import { BODY_ASSESSMENT_MOTIONS } from '../services/assessmentBodyMotions';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type RecordedFrame } from '../services/motionRecording';
import { createKneelingSkinSupport } from '../services/kneelingSkinSupport';
import { captureGroundSupportAnchors, pinContactsToFloor, type GroundContact } from '../services/rootMotion';
import { createStageTwistOverlay } from '../services/stageTwistOverlay';
import { buildComposedCommandPose } from '../services/movementCommand';
import { clampContactHingeToRom, setRomClampEnabled } from '../services/poseRomClamp';
import type { RomScenarioConstraints } from '../services/romConstraints';

const sides = ['L', 'R'] as const;
// Predeclared for the new flexion correction before integration. This visual
// contact allowance does not change prone support or Blender exchange gates.
const skinAllowanceM = .001;

describe.each(['male', 'female', 'neutral'] as const)('%s kneeling skin support', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skinned: THREE.SkinnedMesh;
  let rest: ReturnType<typeof captureJointAngleRestReference>;
  let baseline: ReturnType<typeof serializeCustomPose>;
  let bones: ReturnType<typeof buildBoneByPoseKey>;
  let support: ReturnType<typeof createKneelingSkinSupport>;
  let twist: ReturnType<typeof createStageTwistOverlay>;
  let frames: RecordedFrame[];
  const initialPosition = new THREE.Vector3(), initialQuaternion = new THREE.Quaternion();
  const groups: { skin: THREE.SkinnedMesh; vertices: Record<string, number[]> }[] = [];

  beforeAll(async () => {
    setRomClampEnabled(false);
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '',
    )).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(object => {
      const skin = object as THREE.SkinnedMesh;
      if (!skin.isSkinnedMesh) return;
      skinned ??= skin;
      const indices = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
      const vertices: Record<string, number[]> = { lower: [], L_knee: [], R_knee: [], L_foot: [], R_foot: [], L_palm: [], R_palm: [] };
      for (let vertex = 0; vertex < indices.count; vertex++) {
        let maximum = -1, name = '';
        for (let slot = 0; slot < weights.itemSize; slot++) if (weights.getComponent(vertex, slot) > maximum) {
          maximum = weights.getComponent(vertex, slot);
          name = skin.skeleton.bones[indices.getComponent(vertex, slot)]!.name;
        }
        if (/(?:Thigh|Calf|Knee|Foot|Toe)/.test(name)) vertices.lower!.push(vertex);
        for (const side of sides) if (name.includes(`_${side}_`)) {
          if (/Knee/.test(name)) vertices[`${side}_knee`]!.push(vertex);
          if (/(?:Foot|Toe)/.test(name)) vertices[`${side}_foot`]!.push(vertex);
          if (!/Toe/.test(name) && /(?:Hand|Thumb|Index|Mid|Ring|Pinky|Finger)/.test(name)) vertices[`${side}_palm`]!.push(vertex);
        }
      }
      groups.push({ skin, vertices });
    });
    rest = captureJointAngleRestReference(skinned.skeleton, cfg);
    baseline = serializeCustomPose(skinned.skeleton, cfg, variant);
    bones = buildBoneByPoseKey(skinned.skeleton, cfg);
    initialPosition.copy(root.position); initialQuaternion.copy(root.quaternion);
    // Construct against the real anatomical rig, before any posed frame.
    support = createKneelingSkinSupport({ root, skinned, variantCfg: cfg });
    twist = createStageTwistOverlay(); twist.reset(skinned.skeleton, cfg);
    const source = { ...BODY_ASSESSMENT_MOTIONS['flexion-clearing']!('L'),
      contacts: [], fixedGroundSupports: [], supportPlaneY: 0, kneelingSkinSupport: false };
    frames = sampleComposedMotion(resolveComposedMotion(source, cfg), {
      baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned },
      frameTimesMs: [0, 1800, 2600, 4400, 5100, 5800],
    }).frames;
    expect(frames).toHaveLength(6);
  });
  afterAll(() => setRomClampEnabled(null));

  function place(frame: RecordedFrame, headingDeg = 0) {
    const heading = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), headingDeg * Math.PI / 180);
    root.position.copy(initialPosition).add(new THREE.Vector3().fromArray(frame.root.translateM)).applyQuaternion(heading);
    root.quaternion.copy(heading).multiply(initialQuaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
    applyCustomPose(skinned.skeleton, cfg, frame.pose); root.updateMatrixWorld(true);
  }
  function locals() {
    return skinned.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
  }
  function measuredSkin() {
    return twist.sampleWithTwist(() => {
      root.updateMatrixWorld(true);
      const minima = Object.fromEntries(Object.keys(groups[0]!.vertices).map(key => [key, Infinity]));
      const point = new THREE.Vector3();
      for (const { skin, vertices } of groups) {
        skin.skeleton.update();
        for (const [region, indices] of Object.entries(vertices)) for (const vertex of indices) {
          minima[region] = Math.min(minima[region]!, skin.getVertexPosition(vertex, point).applyMatrix4(skin.matrixWorld).y);
        }
      }
      return minima;
    });
  }
  function groundedContacts(anchors: Record<string, [number, number]>): GroundContact[] {
    return sides.map(side => ({ bone: `${side}_Leg`, targetY: 0, targetXZ: anchors[`${side}_Leg`],
      mode: 'vertical', localPoint: support.points[side], prepare: support.prepare }));
  }

  it.each([0, 67])('supports the lower skin without moving local joints, at heading %s degrees', heading => {
    for (const frame of frames) {
      place(frame, heading);
      const beforeLocals = locals();
      const anchors = captureGroundSupportAnchors(skinned.skeleton, cfg, ['L_Leg', 'R_Leg']);
      const contacts = groundedContacts(anchors);
      pinContactsToFloor(root, skinned.skeleton, cfg, contacts);
      expect(locals(), `local transforms at ${frame.tMs}ms`).toEqual(beforeLocals);
      const minima = measuredSkin();
      expect(minima.lower, `full lower skin at ${frame.tMs}ms`).toBeGreaterThanOrEqual(-skinAllowanceM);
      for (const side of sides) {
        expect(Math.abs(minima[`${side}_knee`]!), `${side} knee support at ${frame.tMs}ms`).toBeLessThan(skinAllowanceM);
        expect(Math.abs(minima[`${side}_foot`]!), `${side} dorsal foot/toe support at ${frame.tMs}ms`).toBeLessThan(skinAllowanceM);
        const point = bones.get(`${side}_Leg`)!.getWorldPosition(new THREE.Vector3());
        expect(Math.hypot(point.x - anchors[`${side}_Leg`]![0], point.z - anchors[`${side}_Leg`]![1])).toBeLessThan(.005);
      }
      const firstPosition = root.position.clone(), firstQuaternion = root.quaternion.clone();
      pinContactsToFloor(root, skinned.skeleton, cfg, contacts);
      expect(root.position.distanceTo(firstPosition), 'repeated grounding must not accumulate a lift').toBeLessThan(1e-6);
      expect(root.quaternion.clone().normalize().angleTo(firstQuaternion.normalize()), 'repeated grounding must not accumulate pitch').toBeLessThan(1e-6);
      expect(locals()).toEqual(beforeLocals);
    }
  });

  it('preserves a genuinely restricted measured knee pose through geometric placement', () => {
    place(frames[0]!, 35);
    const constraints: RomScenarioConstraints = Object.fromEntries(sides.map(side =>
      [`${side}_Leg`, { kneeFlexion: { availableRange: { min: 95, max: 95 } } }]));
    for (const side of sides) {
      const key = `${side}_Leg`;
      const current = serializeCustomPose(skinned.skeleton, cfg, variant);
      const pose = buildComposedCommandPose(baseline, key, [{ motion: 'kneeFlexion', degrees: 110 }], cfg, current, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose); root.updateMatrixWorld(true);
      clampContactHingeToRom(bones.get(`${side}_UpLeg`)!, bones.get(key)!, key, rest, constraints);
      expect(measureHingeFlexion(bones.get(`${side}_UpLeg`)!, bones.get(key)!, key, rest)).toBeCloseTo(95, 5);
    }
    const beforeLocals = locals();
    const anchors = captureGroundSupportAnchors(skinned.skeleton, cfg, ['L_Leg', 'R_Leg']);
    pinContactsToFloor(root, skinned.skeleton, cfg, groundedContacts(anchors));
    expect(locals()).toEqual(beforeLocals);
    for (const side of sides) expect(measureHingeFlexion(bones.get(`${side}_UpLeg`)!, bones.get(`${side}_Leg`)!, `${side}_Leg`, rest)).toBeCloseTo(95, 5);
    // This checks bound preservation and nonpenetration of the measured lower
    // support, not feasibility of the complete patient task or arm reach.
    expect(measuredSkin().lower).toBeGreaterThanOrEqual(-skinAllowanceM);
  });

  it.each([null, 120])('records and replays the complete supported motion with knee maximum %s', maximum => {
    // Reset the rig after the preceding support tests. These are full public
    // motion samples with the actual recipe and palm contacts, not helper-only
    // poses. A later mounting must still use anatomical twist references.
    root.position.copy(initialPosition); root.quaternion.copy(initialQuaternion);
    applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    const constraints: RomScenarioConstraints | undefined = maximum === null ? undefined : Object.fromEntries(sides.map(side =>
      [`${side}_Leg`, { kneeFlexion: { availableRange: { min: 0, max: maximum } } }]));
    const source = BODY_ASSESSMENT_MOTIONS['flexion-clearing']!('L');
    expect(source.kneelingSkinSupport).toBe(true);
    expect(source.supportPlaneY).toBe(0);
    const resolved = resolveComposedMotion(source, cfg, { constraints });
    const recording = sampleComposedMotion(resolved, {
      baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned },
      // Public callers may supply patient limits at resolution only. The
      // resolved motion must carry them through both support and sampling;
      // repeating them here would conceal missing constraint propagation.
      sampleHz: 30, trackedBones: [...bones.keys()],
    });
    expect(recording.frames.length).toBeGreaterThan(100);
    const first = recording.frames[0]!, last = recording.frames.at(-1)!;
    expect(first.tMs).toBe(0);
    expect(last.tMs).toBeGreaterThan(4000);
    let maxReplayErrorM = 0, maximumKneeDeg = -Infinity;
    for (const frame of recording.frames) {
      place(frame);
      // Compare independently reconstructed world transforms with the points
      // measured during sampling. Authored root orientation cannot substitute
      // for the achieved support orientation in the recorded frame.
      for (const [key, track] of Object.entries(frame.worldTracks ?? {})) {
        if (key === 'CoM') continue;
        const bone = bones.get(key);
        expect(bone, `replayed tracked bone ${key}`).toBeDefined();
        const residual = bone!.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(track));
        maxReplayErrorM = Math.max(maxReplayErrorM, residual);
        expect(residual, `${key} recorded/replayed world position at ${frame.tMs}ms`).toBeLessThan(1e-7);
      }
      const minima = measuredSkin();
      expect(minima.lower, `recorded lower skin at ${frame.tMs}ms`).toBeGreaterThanOrEqual(-skinAllowanceM);
      for (const side of sides) {
        expect(minima[`${side}_palm`], `${side} palm skin at ${frame.tMs}ms`).toBeGreaterThanOrEqual(-skinAllowanceM);
        const hand = new THREE.Vector3().fromArray(frame.worldTracks![`${side}_Hand`]!);
        expect(hand.distanceTo(new THREE.Vector3().fromArray(first.worldTracks![`${side}_Hand`]!)), `${side} fixed hand at ${frame.tMs}ms`).toBeLessThan(.002);
        const knee = new THREE.Vector3().fromArray(frame.worldTracks![`${side}_Leg`]!).sub(new THREE.Vector3().fromArray(first.worldTracks![`${side}_Leg`]!));
        expect(Math.hypot(knee.x, knee.z), `${side} knee anchor at ${frame.tMs}ms`).toBeLessThan(.005);
        const flexion = frame.angles[`${side}_Leg`]!.kneeFlexion!;
        expect(flexion, `${side} measured knee at ${frame.tMs}ms`).toBeLessThanOrEqual((maximum ?? 140) + .01);
        maximumKneeDeg = Math.max(maximumKneeDeg, flexion);
      }
    }
    // Exact endpoint clocks and all pose channels are compared, not just the
    // low hand residual or the displayed joint values. The micrometre/radian
    // allowances handle floating-point quaternion/skin calculations only.
    expect(Object.keys(last.pose.bones).sort()).toEqual(Object.keys(first.pose.bones).sort());
    for (const [key, initial] of Object.entries(first.pose.bones)) {
      expect(new THREE.Quaternion().fromArray(initial).normalize().angleTo(new THREE.Quaternion().fromArray(last.pose.bones[key]!).normalize()), `${key} loop`).toBeLessThan(1e-6);
    }
    expect(new THREE.Vector3().fromArray(last.root.translateM).distanceTo(new THREE.Vector3().fromArray(first.root.translateM)), 'root loop position').toBeLessThan(1e-6);
    expect(new THREE.Quaternion().fromArray(last.root.orientQuat).normalize().angleTo(new THREE.Quaternion().fromArray(first.root.orientQuat).normalize()), 'root loop orientation').toBeLessThan(1e-6);
    if (maximum !== null) expect(maximumKneeDeg, 'restricted case exercises the active cap').toBeGreaterThan(maximum - .01);
    console.log('KNEELING_RECORDING_SUPPORT', JSON.stringify({ variant, maximum, frames: recording.frames.length, maxReplayErrorM, maximumKneeDeg }));
  }, 30_000);
});
