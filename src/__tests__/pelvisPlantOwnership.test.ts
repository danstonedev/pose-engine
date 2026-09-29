import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { buildComposedCommandPose } from '../services/movementCommand';
import { captureFootFrames, plantStanceFoot, stanceFootNeedsPlant } from '../services/rootMotion';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import { isRomClampActive, setRomClampEnabled } from '../services/poseRomClamp';
import type { CustomPose } from '../types';

const angle = (a: THREE.Quaternion, b: THREE.Quaternion) =>
  a.clone().normalize().angleTo(b.clone().normalize()) * 180 / Math.PI;

for (const variant of ['male', 'female', 'neutral'] as const) {
  describe(`${variant}: planted pelvic articulation owns its world orientation`, () => {
    const cfg = BODY_VARIANTS[variant];
    let root: THREE.Group;
    let skinned: THREE.SkinnedMesh;
    let baseline: CustomPose;
    let rest: ReturnType<typeof captureJointAngleRestReference>;
    let frames: ReturnType<typeof captureFootFrames>;
    let bones: Map<string, THREE.Bone>;
    let rootPosition: THREE.Vector3;
    let rootQuaternion: THREE.Quaternion;
    let rootScale: THREE.Vector3;

    beforeAll(async () => {
      const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
      root = gltf.scene;
      root.scale.setScalar(cfg.pose.rootScale);
      root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh; });
      applyAnatomicPose(root, cfg);
      root.updateMatrixWorld(true);
      rest = captureJointAngleRestReference(skinned.skeleton, cfg);
      baseline = serializeCustomPose(skinned.skeleton, cfg, variant);
      bones = buildBoneByPoseKey(skinned.skeleton, cfg);
      frames = captureFootFrames(skinned.skeleton, cfg);
      rootPosition = root.position.clone();
      rootQuaternion = root.quaternion.clone();
      rootScale = root.scale.clone();
    }, 60_000);

    function reset() {
      root.position.copy(rootPosition);
      root.quaternion.copy(rootQuaternion);
      root.scale.copy(rootScale);
      applyCustomPose(skinned.skeleton, cfg, baseline);
      root.updateMatrixWorld(true);
    }

    for (const [motion, degrees] of [
      ['anteriorTilt', -20], ['anteriorTilt', 20],
      ['lateralTilt', -15], ['lateralTilt', 15],
      ['rotation', -20], ['rotation', 20],
    ] as const) {
      it(`${motion} ${degrees}: feet remain supported without inverse root rotation`, () => {
        reset();
        const pose = buildComposedCommandPose(baseline, 'Hips', [{ motion, degrees }], cfg, baseline, rest)!;
        applyCustomPose(skinned.skeleton, cfg, pose);
        root.updateMatrixWorld(true);
        const desiredPelvis = bones.get('Hips')!.getWorldQuaternion(new THREE.Quaternion());
        const upperLocals = ['Spine_Lower', 'Spine_Mid', 'Spine_Upper', 'L_UpperArm', 'R_UpperArm', 'Head']
          .map((key) => [key, bones.get(key)!.quaternion.clone()] as const);
        expect(stanceFootNeedsPlant(root, skinned.skeleton, cfg, frames)).toBe(true);
        expect(plantStanceFoot(root, skinned.skeleton, cfg, frames)).toBeTruthy();
        expect(angle(root.quaternion, rootQuaternion), 'root must not absorb pelvis rotation').toBeLessThan(0.01);
        expect(angle(bones.get('Hips')!.getWorldQuaternion(new THREE.Quaternion()), desiredPelvis)).toBeLessThan(0.01);
        for (const key of ['L_Foot', 'R_Foot']) {
          const error = bones.get(key)!.getWorldPosition(new THREE.Vector3())
            .distanceTo(new THREE.Vector3().setFromMatrixPosition(frames.restFrame[key]!));
          expect(error, `${key} plant error, ${motion} ${degrees}`).toBeLessThan(0.006);
          const expectedFootQ = new THREE.Quaternion().setFromRotationMatrix(
            new THREE.Matrix4().extractRotation(frames.restFrame[key]!),
          );
          expect(angle(bones.get(key)!.getWorldQuaternion(new THREE.Quaternion()), expectedFootQ), `${key} stays flat`).toBeLessThan(0.2);
        }
        for (const [key, q] of upperLocals) expect(angle(bones.get(key)!.quaternion, q), `${key} remains authored`).toBeLessThan(0.001);
        const measured = computeJointAngles(skinned.skeleton, cfg, variant, rest).joints;
        expect(measured.Hips![motion]).toBeCloseTo(degrees, 0);
        for (const key of ['L_Leg', 'R_Leg']) {
          expect(Math.abs(measured[key]?.kneeRotation ?? 0)).toBeLessThan(0.2);
          expect(measured[key]?.kneeFlexion ?? 0).toBeGreaterThan(-0.1);
        }
      });
    }

    it('engages for small pelvic motion before the legacy 5 cm drift gate', () => {
      reset();
      expect(stanceFootNeedsPlant(root, skinned.skeleton, cfg, frames)).toBe(false);
      const pose = buildComposedCommandPose(baseline, 'Hips', [{ motion: 'rotation', degrees: 0.1 }], cfg, baseline, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose);
      expect(stanceFootNeedsPlant(root, skinned.skeleton, cfg, frames)).toBe(true);
    });

    it('returns continuously through neutral on all pelvis axes', () => {
      for (const motion of ['anteriorTilt', 'lateralTilt', 'rotation']) {
        let previous: THREE.Quaternion[] | undefined;
        let previousRoot: THREE.Vector3 | undefined;
        for (const degrees of [-0.1, -0.01, 0, 0.01, 0.1]) {
          reset();
          const pose = buildComposedCommandPose(baseline, 'Hips', [{ motion, degrees }], cfg, baseline, rest)!;
          applyCustomPose(skinned.skeleton, cfg, pose);
          plantStanceFoot(root, skinned.skeleton, cfg, frames);
          const joints = ['L_UpLeg', 'R_UpLeg', 'L_Leg', 'R_Leg', 'L_Foot', 'R_Foot']
            .map((key) => bones.get(key)!.quaternion.clone());
          if (previous) joints.forEach((q, i) => expect(angle(q, previous![i]!), `${motion} neutral joint continuity`).toBeLessThan(3));
          if (previousRoot) expect(root.position.distanceTo(previousRoot), `${motion} neutral root continuity`).toBeLessThan(0.001);
          previous = joints;
          previousRoot = root.position.clone();
        }
      }
    });

    it('does not reinterpret its own leg compensation on repeat grounding', () => {
      reset();
      const pose = buildComposedCommandPose(baseline, 'Hips', [
        { motion: 'rotation', degrees: 15 }, { motion: 'lateralTilt', degrees: 8 },
      ], cfg, baseline, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose);
      const firstStance = plantStanceFoot(root, skinned.skeleton, cfg, frames);
      const world = root.matrixWorld.clone();
      const locals = serializeCustomPose(skinned.skeleton, cfg, variant);
      for (let i = 0; i < 8; i++) expect(plantStanceFoot(root, skinned.skeleton, cfg, frames)).toBe(firstStance);
      expect(root.matrixWorld.equals(world)).toBe(true);
      expect(serializeCustomPose(skinned.skeleton, cfg, variant).bones).toEqual(locals.bones);
    });

    it('recovers original support intent for a new direct pelvis-only command', () => {
      reset();
      for (const degrees of [15, 25, 0, 15, 0]) {
        const current = serializeCustomPose(skinned.skeleton, cfg, variant);
        const pose = buildComposedCommandPose(baseline, 'Hips', [{ motion: 'rotation', degrees }], cfg, current, rest)!;
        applyCustomPose(skinned.skeleton, cfg, pose);
        plantStanceFoot(root, skinned.skeleton, cfg, frames);
        expect(angle(root.quaternion, rootQuaternion)).toBeLessThan(0.01);
        expect(computeJointAngles(skinned.skeleton, cfg, variant, rest).joints.Hips!.rotation).toBeCloseTo(degrees, 0);
      }
      expect(root.position.distanceTo(rootPosition)).toBeLessThan(0.003);
    });

    it('new authored leg angles invalidate prior support-output recovery', () => {
      reset();
      let pose = buildComposedCommandPose(baseline, 'Hips', [{ motion: 'rotation', degrees: 20 }], cfg, baseline, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose);
      plantStanceFoot(root, skinned.skeleton, cfg, frames);
      pose = serializeCustomPose(skinned.skeleton, cfg, variant);
      pose = buildComposedCommandPose(baseline, 'L_UpLeg', [{ motion: 'hipFlexion', degrees: 45 }], cfg, pose, rest)!;
      pose = buildComposedCommandPose(baseline, 'L_Leg', [{ motion: 'kneeFlexion', degrees: 75 }], cfg, pose, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose);
      const desiredHip = bones.get('L_UpLeg')!.quaternion.clone();
      const desiredKnee = bones.get('L_Leg')!.quaternion.clone();
      plantStanceFoot(root, skinned.skeleton, cfg, frames);
      expect(angle(bones.get('L_UpLeg')!.quaternion, desiredHip)).toBeLessThan(0.01);
      expect(angle(bones.get('L_Leg')!.quaternion, desiredKnee)).toBeLessThan(0.01);
    });

    it('explicit patient limits beat contact accuracy, including calibration mode and mutated limits', () => {
      reset();
      const constraints = {
        L_UpLeg: { hipRotation: { availableRange: { min: -5, max: 5 } } },
        R_UpLeg: { hipRotation: { availableRange: { min: -5, max: 5 } } },
      };
      const pose = buildComposedCommandPose(baseline, 'Hips', [{ motion: 'rotation', degrees: 20 }], cfg, baseline, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose);
      setRomClampEnabled(false);
      try {
        expect(isRomClampActive()).toBe(false);
        plantStanceFoot(root, skinned.skeleton, cfg, frames, constraints);
        for (const max of [5, 2]) {
          constraints.L_UpLeg.hipRotation.availableRange = { min: -max, max };
          constraints.R_UpLeg.hipRotation.availableRange = { min: -max, max };
          plantStanceFoot(root, skinned.skeleton, cfg, frames, constraints);
          const angles = computeJointAngles(skinned.skeleton, cfg, variant, rest).joints;
          for (const key of ['L_UpLeg', 'R_UpLeg']) expect(Math.abs(angles[key]!.hipRotation)).toBeLessThan(max + 0.2);
          expect(angle(root.quaternion, rootQuaternion)).toBeLessThan(0.01);
          expect(angles.Hips!.rotation).toBeCloseTo(20, 0);
          expect(isRomClampActive()).toBe(false);
        }
      } finally { setRomClampEnabled(null); }
    });

    for (const [name, hip, knee, ankle] of [
      ['squat', 65, 85, 15], ['hinge', 60, 15, 0], ['chair rise', 75, 95, 10],
    ] as const) {
      it(`${name}: added pelvis rotation preserves the established closed-chain root`, () => {
        reset();
        let pose = baseline;
        for (const side of ['L_', 'R_']) {
          for (const [joint, motion, degrees] of [
            [`${side}UpLeg`, 'hipFlexion', hip], [`${side}Leg`, 'kneeFlexion', knee], [`${side}Foot`, 'ankleFlexion', ankle],
          ] as const) pose = buildComposedCommandPose(baseline, joint, [{ motion, degrees }], cfg, pose, rest)!;
        }
        applyCustomPose(skinned.skeleton, cfg, pose);
        plantStanceFoot(root, skinned.skeleton, cfg, frames);
        const placedRoot = root.quaternion.clone();
        const plantedFeet = ['L_Foot', 'R_Foot'].map(key => bones.get(key)!.getWorldPosition(new THREE.Vector3()));
        reset();
        pose = buildComposedCommandPose(baseline, 'Hips', [{ motion: 'rotation', degrees: 12 }], cfg, pose, rest)!;
        applyCustomPose(skinned.skeleton, cfg, pose);
        plantStanceFoot(root, skinned.skeleton, cfg, frames);
        expect(angle(root.quaternion, placedRoot)).toBeLessThan(0.01);
        for (const [i, key] of ['L_Foot', 'R_Foot'].entries()) expect(bones.get(key)!.getWorldPosition(new THREE.Vector3()).distanceTo(
          plantedFeet[i]!,
        ), `${name} ${key} stays planted`).toBeLessThan(0.006);
      });
    }

    it('preserves an inherited root heading', () => {
      reset();
      root.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3));
      root.updateMatrixWorld(true);
      const heading = root.quaternion.clone();
      const turnedFrames = captureFootFrames(skinned.skeleton, cfg, rest);
      const pose = buildComposedCommandPose(baseline, 'Hips', [{ motion: 'rotation', degrees: 15 }], cfg, baseline, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose);
      root.updateMatrixWorld(true);
      const pelvisWorld = bones.get('Hips')!.getWorldQuaternion(new THREE.Quaternion());
      plantStanceFoot(root, skinned.skeleton, cfg, turnedFrames);
      expect(angle(root.quaternion, heading)).toBeLessThan(0.01);
      expect(angle(bones.get('Hips')!.getWorldQuaternion(new THREE.Quaternion()), pelvisWorld)).toBeLessThan(0.01);
      for (const key of ['L_Foot', 'R_Foot']) expect(bones.get(key)!.getWorldPosition(new THREE.Vector3()).distanceTo(
        new THREE.Vector3().setFromMatrixPosition(turnedFrames.restFrame[key]!),
      )).toBeLessThan(0.006);
    });

    it('retains independent pelvis motion throughout sampled playback', () => {
      reset();
      const resolved = resolveComposedMotion({
        name: 'Planted pelvic rotation',
        keyframes: [0, 20, -20, 0].map(targetDegrees => ({
          targets: [{ joint: 'Hips', motion: 'rotation', targetDegrees }],
          durationMs: 600, holdMs: 100, stance: 'planted' as const,
        })),
      }, cfg);
      const recording = sampleComposedMotion(resolved, {
        baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60,
      });
      expect(Math.max(...recording.frames.map(f => f.angles.Hips?.rotation ?? 0))).toBeGreaterThan(19);
      expect(Math.min(...recording.frames.map(f => f.angles.Hips?.rotation ?? 0))).toBeLessThan(-19);
      for (const frame of recording.frames) {
        expect(angle(new THREE.Quaternion().fromArray(frame.root.orientQuat), new THREE.Quaternion())).toBeLessThan(0.01);
        root.position.copy(rootPosition).add(new THREE.Vector3().fromArray(frame.root.translateM));
        root.quaternion.copy(rootQuaternion).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));
        root.scale.copy(rootScale);
        applyCustomPose(skinned.skeleton, cfg, frame.pose);
        root.updateMatrixWorld(true);
        for (const key of ['L_Foot', 'R_Foot']) {
          expect(bones.get(key)!.getWorldPosition(new THREE.Vector3()).distanceTo(
            new THREE.Vector3().setFromMatrixPosition(frames.restFrame[key]!),
          ), `${key} contact at ${frame.tMs} ms`).toBeLessThan(0.006);
        }
      }
    });

    it('successive current-pose pelvic commands do not accumulate root yaw or height', () => {
      for (const motion of ['rotation', 'lateralTilt']) {
        reset();
        const chain = sampleMotionChain([15, 25, 0, 15, 0].map(targetDegrees => ({
          name: `${motion} ${targetDegrees}`, holdUnmentioned: true,
          keyframes: [{ targets: [{ joint: 'Hips', motion, targetDegrees }], durationMs: 800, holdMs: 100, stance: 'planted' as const }],
        })), { baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned }, sampleHz: 30 });
        for (const segment of chain) {
          const last = segment.recording.frames.at(-1)!;
          expect(angle(new THREE.Quaternion().fromArray(last.root.orientQuat), new THREE.Quaternion()), segment.motion.name).toBeLessThan(0.1);
        }
        const final = chain.at(-1)!.recording.frames.at(-1)!;
        expect(Math.abs(final.root.translateM[1]), `${motion} returns to original height`).toBeLessThan(0.003);
      }
    });

    it('does not turn a raised leg into a second support', () => {
      reset();
      let pose = buildComposedCommandPose(baseline, 'L_UpLeg', [{ motion: 'hipFlexion', degrees: 35 }], cfg, baseline, rest)!;
      pose = buildComposedCommandPose(baseline, 'L_Leg', [{ motion: 'kneeFlexion', degrees: 65 }], cfg, pose, rest)!;
      pose = buildComposedCommandPose(baseline, 'Hips', [{ motion: 'rotation', degrees: 20 }], cfg, pose, rest)!;
      applyCustomPose(skinned.skeleton, cfg, pose);
      root.updateMatrixWorld(true);
      const freeHip = bones.get('L_UpLeg')!.quaternion.clone();
      const freeKnee = bones.get('L_Leg')!.quaternion.clone();
      expect(plantStanceFoot(root, skinned.skeleton, cfg, frames)).toBe('R_Foot');
      expect(angle(bones.get('L_UpLeg')!.quaternion, freeHip)).toBeLessThan(0.001);
      expect(angle(bones.get('L_Leg')!.quaternion, freeKnee)).toBeLessThan(0.001);
      const foot = bones.get('R_Foot')!.getWorldPosition(new THREE.Vector3());
      expect(foot.distanceTo(new THREE.Vector3().setFromMatrixPosition(frames.restFrame.R_Foot!))).toBeLessThan(0.006);
      expect(bones.get('L_Foot')!.getWorldPosition(new THREE.Vector3()).y - foot.y).toBeGreaterThan(0.1);
    });
  });
}
