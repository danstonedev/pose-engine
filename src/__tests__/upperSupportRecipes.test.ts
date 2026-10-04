import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose, buildBoneByPoseKey, buildIKChainContext, solveIKChain, readAxialTwist } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { inspectClinicalAngles } from '../services/poseRomClamp';
import { buildComposedCommandPose } from '../services/movementCommand';
import { buildSequencePoses, resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type RecordedFrame } from '../services/motionRecording';
import { buildGetDownToPlank, buildGetDownToQuadruped, buildBirdDog, buildPushUp, MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { UPPER_ASSESSMENT_MOTIONS } from '../services/assessmentUpperMotions';
import { inspectBodyControl, MAJOR_BODY_JOINTS } from '../services/movementControl';

const reach = () => templateToComposedMotion(MOVEMENT_TEMPLATES.find(t => t.id === 'endpoint-reach')!);
const all = [reach(), buildPushUp(), buildBirdDog(), buildBirdDog({ side: 'L' }),
  ...Object.values(UPPER_ASSESSMENT_MOTIONS).flatMap(make => [make('L'), make('R')])];

it('every phase assigns all major joints and resolves its complete intent without dropped or duplicate channels', () => {
  for (const motion of all) {
    const resolved = resolveComposedMotion(motion);
    expect(resolved.status, motion.name).toBe('ok');
    expect(resolved.outcomes.filter(o => o.status !== 'complied'), motion.name).toEqual([]);
    for (const phase of motion.keyframes) {
      expect(Object.keys(phase.control!.joints).sort()).toEqual([...MAJOR_BODY_JOINTS].sort());
      expect(inspectBodyControl(phase.control!, phase.targets)).toEqual([]);
      const keys = phase.targets!.map(t => `${t.joint}/${t.motion}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  }
});

for (const variant of ['male', 'female', 'neutral'] as const) describe(`${variant}: whole-body reach and support`, () => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skin: THREE.SkinnedMesh;
  let baseline: ReturnType<typeof serializeCustomPose>, rest: ReturnType<typeof captureJointAngleRestReference>;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    root = (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale); root.updateMatrixWorld(true);
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skin) skin = o as THREE.SkinnedMesh; });
    baseline = serializeCustomPose(skin.skeleton, cfg, variant);
    rest = captureJointAngleRestReference(skin.skeleton, cfg);
  });
  function sample(motion: ComposedMotion, entry?: RecordedFrame) {
    root.position.set(0, 0, 0); root.quaternion.identity();
    applyCustomPose(skin.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    return sampleComposedMotion(resolveComposedMotion(motion, cfg), { baselinePose: baseline, variantCfg: cfg, rest,
      skeletonHarness: { root, skinned: skin }, sampleHz: 60, trackedBones: [...MAJOR_BODY_JOINTS],
      ...(entry ? { currentPose: entry.pose, currentRoot: { quat: entry.root.orientQuat, translateM: entry.root.translateM } } : {}),
    });
  }
  const qdist = (a: number[], b: number[]) => new THREE.Quaternion().fromArray(a).normalize().angleTo(new THREE.Quaternion().fromArray(b).normalize()) * 180 / Math.PI;

  it('elbow flexion and forearm rotation have the same result in either target order', () => {
    for (const side of ['L', 'R']) for (const elbow of [5, 90, 130]) for (const rotation of [-45, 30]) {
      const targets = [{ motion: 'elbowFlexion', degrees: elbow }, { motion: 'forearmRotation', degrees: rotation }];
      const first = buildComposedCommandPose(baseline, `${side}_Forearm`, targets, cfg, baseline, rest)!;
      const reversed = buildComposedCommandPose(baseline, `${side}_Forearm`, [...targets].reverse(), cfg, baseline, rest)!;
      expect(qdist(first.bones[`${side}_Forearm`]!, reversed.bones[`${side}_Forearm`]!)).toBeLessThan(.001);
    }
  });

  it('a hand-position solve retains authored pronation and supination while respecting the elbow bound', () => {
    const bones = buildBoneByPoseKey(skin.skeleton, cfg);
    for (const side of ['L', 'R']) for (const rotation of [-30, 0, 30]) for (const cap of [60, 145]) {
      root.position.set(0, 0, 0); root.quaternion.identity();
      const pose = buildComposedCommandPose(baseline, `${side}_Forearm`, [
        { motion: 'elbowFlexion', degrees: 60 }, { motion: 'forearmRotation', degrees: rotation },
      ], cfg, baseline, rest)!;
      applyCustomPose(skin.skeleton, cfg, pose); root.updateMatrixWorld(true);
      const forearm = bones.get(`${side}_Forearm`)!, hand = bones.get(`${side}_Hand`)!;
      const reference = new THREE.Quaternion().fromArray(rest.localQuats[`${side}_Forearm`]!);
      const before = readAxialTwist(forearm.quaternion, reference);
      const target = bones.get(`${side}_UpperArm`)!.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, -.35, .05));
      solveIKChain(buildIKChainContext(skin, hand, 2, cfg)!, target, {
        rest, hinges: new Set([`${side}_Forearm`]), iterations: 12,
        constraints: { [`${side}_Forearm`]: { elbowFlexion: { availableRange: { max: cap } } } },
      });
      const flexion = inspectClinicalAngles(forearm, `${side}_Forearm`, rest)!.anatomicFlexion;
      if (cap === 145) {
        expect(Math.abs(readAxialTwist(forearm.quaternion, reference) - before) * 180 / Math.PI).toBeLessThan(.01);
        expect(flexion).toBeGreaterThan(65);
      } else {
        // Active ROM projection takes precedence over orientation preservation.
        // Its rest-relative clamp angle differs from the geometric elbow angle
        // by the small rig bind bend; assert the actual constraint convention.
        expect(flexion).toBeLessThan(60.01);
      }
    }
  });

  it('loaded palms face down throughout settled push-up and bird-dog repetitions', () => {
    const bones = buildBoneByPoseKey(skin.skeleton, cfg);
    const world = (key: string) => bones.get(key)!.getWorldPosition(new THREE.Vector3());
    // Landmark-plane normal: wrist -> middle MCP crossed with index -> little
    // MCP. Both meshes use opposite handedness across the two hands.
    const normal = (side: string) => new THREE.Vector3().crossVectors(
      world(`${side}_Mid1`).sub(world(`${side}_Hand`)),
      world(`${side}_Pinky1`).sub(world(`${side}_Index1`)),
    ).normalize().multiplyScalar(side === 'R' ? 1 : -1);
    for (const [motion, setup, supported] of [
      [buildPushUp({ reps: 2 }), buildGetDownToPlank(), ['L', 'R']],
      [buildBirdDog({ side: 'L', reps: 2 }), buildGetDownToQuadruped(), ['R']],
      [buildBirdDog({ side: 'R', reps: 2 }), buildGetDownToQuadruped(), ['L']],
    ] as const) {
      const entry = sample(setup).frames.at(-1)!;
      for (const f of sample(motion, entry).frames.filter(f => f.tMs >= 1200)) {
        root.position.fromArray(f.root.translateM); root.quaternion.fromArray(f.root.orientQuat);
        applyCustomPose(skin.skeleton, cfg, f.pose); root.updateMatrixWorld(true);
        for (const side of supported) {
          // Engineering orientation envelope, not a claim of flat skin contact.
          expect(normal(side).y, `${motion.name} ${side} at ${f.tMs}`).toBeLessThan(-Math.cos(Math.PI / 6));
          if (motion.contacts?.some(contact => contact.holdOrientation)) {
            // A bounded palm-pose solve distributes orientation across the
            // girdle, shoulder, forearm and wrist. Check the actual palm plane
            // more strictly, instead of requiring one joint to supply 40 deg.
            expect(normal(side).y).toBeLessThan(-.995);
            expect(Math.abs(f.angles[`${side}_Forearm`]!.forearmRotation!)).toBeLessThanOrEqual(90.01);
          } else expect(f.angles[`${side}_Forearm`]!.forearmRotation!).toBeLessThan(-40);
        }
      }
    }
  });

  it('replaces stale pelvic/trunk rotations, wrist deviation and a prior fist in each supported phase', () => {
    let dirty = baseline;
    for (const [joint, motion, degrees] of [
      ['Hips', 'rotation', 12], ['Hips', 'lateralTilt', 8], ['Spine_Lower', 'rotation', 15],
      ['Spine_Upper', 'lateralTilt', 12], ['Neck', 'rotation', 20],
      ...(['L', 'R'] as const).flatMap(s => [[`${s}_UpLeg`, 'hipRotation', 20], [`${s}_Forearm`, 'forearmRotation', 40],
        [`${s}_Hand`, 'wristDeviation', 20], ...['Thumb', 'Index', 'Mid', 'Ring', 'Pinky'].map(d => [`${s}_${d}1`, 'fingerFlexion', 120])]),
    ] as [string, string, number][]) dirty = buildComposedCommandPose(baseline, joint, [{ motion, degrees }], cfg, dirty, rest)!;
    for (const motion of [buildPushUp(), buildBirdDog(), buildBirdDog({ side: 'L' })]) {
      const resolved = resolveComposedMotion(motion, cfg);
      const clean = buildSequencePoses(baseline, resolved, cfg, rest);
      const carried = buildSequencePoses(baseline, resolved, cfg, rest, { currentPose: dirty });
      for (let i = 0; i < carried.poses.length; i++) for (const [key, quat] of Object.entries(clean.poses[i]!.bones)) {
        expect(qdist(quat, carried.poses[i]!.bones[key]!), `${motion.name} phase ${i} ${key}`).toBeLessThan(.001);
      }
    }
  });

  it('push-up changes the girdle through a real chest descent while stabilizing pelvis and trunk', () => {
    const entry = sample(buildGetDownToPlank()).frames.at(-1)!;
    const rec = sample(buildPushUp({ reps: 2 }), entry);
    const ys = rec.frames.map(f => f.worldTracks!.Head![1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(.15);
    for (const key of ['Hips', 'Spine_Lower', 'Spine_Mid', 'Spine_Upper']) {
      for (const f of rec.frames) expect(qdist(f.pose.bones[key]!, baseline.bones[key]!)).toBeLessThan(.01);
    }
    for (const side of ['L', 'R']) {
      expect(Math.max(...rec.frames.map(f => qdist(f.pose.bones[`${side}_Shoulder`]!, rec.frames[0]!.pose.bones[`${side}_Shoulder`]!)))).toBeGreaterThan(2);
      expect(Math.max(...rec.frames.map(f => f.worldTracks![`${side}_Hand`]![1]))).toBeLessThan(.08);
      expect(Math.max(...rec.frames.map(f => f.worldTracks![`${side}_Toes`]![1]))).toBeLessThan(.06);
    }
  });

  for (const side of ['L', 'R'] as const) it(`${side} bird-dog releases one hand and holds the opposite hand and knee`, () => {
    const entry = sample(buildGetDownToQuadruped()).frames.at(-1)!;
    const rec = sample(buildBirdDog({ side }), entry), opposite = side === 'L' ? 'R' : 'L';
    expect(Math.max(...rec.frames.map(f => f.worldTracks![`${side}_Hand`]![1]))).toBeGreaterThan(.25);
    expect(Math.max(...rec.frames.map(f => f.worldTracks![`${opposite}_Foot`]![1]))).toBeGreaterThan(.25);
    expect(Math.max(...rec.frames.map(f => f.worldTracks![`${opposite}_Hand`]![1]))).toBeLessThan(.10);
    expect(Math.max(...rec.frames.map(f => f.worldTracks![`${side}_Leg`]![1]))).toBeLessThan(.08);
    const peak = rec.frames.reduce((best, f) => f.worldTracks![`${side}_Hand`]![1] > best.worldTracks![`${side}_Hand`]![1] ? f : best);
    expect(Math.abs(peak.angles[`${side}_Hand`]!.wristFlexion!)).toBeLessThan(10);
    expect(peak.angles[`${opposite}_Hand`]!.wristFlexion!).toBeLessThan(-30);
    for (const key of ['Hips', 'Spine_Lower', 'Spine_Mid', 'Spine_Upper']) {
      for (const f of rec.frames) expect(qdist(f.pose.bones[key]!, baseline.bones[key]!)).toBeLessThan(.01);
    }
  });
});
