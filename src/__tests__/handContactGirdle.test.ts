import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyCustomPose, buildBoneByPoseKey, solveIKChain } from '../services/poseRig';
import { buildFootPlant, buildHandPlant, solveFootPlant, solveHandPlant, solveHandReach } from '../services/footContact';
import { inspectClinicalAngles } from '../services/poseRomClamp';
import { loadHandRig, type HandRig } from './handPlantCases';

describe.each(['male', 'female'] as const)('%s hand contact girdle', variant => {
  let rig: HandRig;
  let bones: Map<string, THREE.Bone>;
  const cfg = BODY_VARIANTS[variant];
  beforeAll(async () => {
    rig = await loadHandRig(variant);
    bones = buildBoneByPoseKey(rig.skinned.skeleton, cfg);
  });
  const reset = () => {
    applyCustomPose(rig.skinned.skeleton, cfg, rig.baselinePose);
    rig.root.position.copy(rig.rootRest0);
    rig.root.quaternion.copy(rig.rootQuat0);
    rig.root.updateMatrixWorld(true);
  };
  for (const side of ['L', 'R'] as const) for (const declared of [false, true]) {
    it(`${side} ${declared ? 'declared contact' : 'hand plant'} recruits bounded girdle for a raised reach`, () => {
      reset();
      const solver = (declared ? buildFootPlant : buildHandPlant)(rig.skinned, `${side}_Hand`, cfg)!;
      expect(solver.ctx.canonicalKeys).toEqual([`${side}_Hand`, `${side}_Forearm`, `${side}_UpperArm`, `${side}_Shoulder`]);
      expect(solver.distalCtx!.canonicalKeys).toEqual([`${side}_Hand`, `${side}_Forearm`, `${side}_UpperArm`]);
      const hand = bones.get(`${side}_Hand`)!;
      const shoulder = bones.get(`${side}_Shoulder`)!;
      for (const xyz of [[0.3, 1.9, 0.1], [0.2, 1.75, 0.35], [0.3, 2.1, 0.1]]) {
        const target = new THREE.Vector3(xyz[0]! * (side === 'L' ? 1 : -1), xyz[1], xyz[2]);
        reset();
        solveIKChain(solver.distalCtx!, target, { rest: rig.rest, hinges: new Set([solver.kneeKey]), iterations: declared ? 8 : 4 });
        const legacyError = hand.getWorldPosition(new THREE.Vector3()).distanceTo(target);
        reset();
        const initialGirdle = shoulder.quaternion.clone();
        (declared ? solveFootPlant : solveHandPlant)(solver, target, rig.rest);
        const error = hand.getWorldPosition(new THREE.Vector3()).distanceTo(target);
        const turn = initialGirdle.angleTo(shoulder.quaternion) * 180 / Math.PI;
        expect(error).toBeLessThanOrEqual(legacyError + 1e-8);
        expect(turn).toBeLessThanOrEqual(20.01);
        if (xyz[1] === 2.1) {
          expect(turn, 'the girdle contributes to the high reach').toBeGreaterThan(3);
          expect(error, 'the raised-support fallback improves the endpoint').toBeLessThan(legacyError * 0.9);
          for (let i = 1; i < solver.ctx.bones.length; i += 1) {
            const report = inspectClinicalAngles(solver.ctx.bones[i]!, solver.ctx.canonicalKeys[i], rig.rest)!;
            for (const axis of ['flexion', 'abduction', 'rotation'] as const) {
              const value = axis === 'flexion' ? report.anatomicFlexion : axis === 'rotation' ? report.anatomicRotation : report.raw.abduction;
              const range = report.ranges[axis];
              expect(Number.isFinite(value)).toBe(true);
              if (range) {
                expect(value).toBeGreaterThanOrEqual(range.min - 0.5);
                expect(value).toBeLessThanOrEqual(range.max + 0.5);
              }
            }
          }
        }
      }
    });

    it(`${side} ${declared ? 'declared contact' : 'hand plant'} preserves authored girdle for a lower support`, () => {
      reset();
      const solver = (declared ? buildFootPlant : buildHandPlant)(rig.skinned, `${side}_Hand`, cfg)!;
      const shoulder = bones.get(`${side}_Shoulder`)!;
      // Deliberate girdle positioning belongs to the recipe during support.
      shoulder.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.1));
      rig.root.updateMatrixWorld(true);
      const initial = solver.ctx.bones.map(bone => bone.quaternion.clone());
      const target = new THREE.Vector3(side === 'L' ? 0.25 : -0.25, 0.2, 0.3);
      solveIKChain(solver.distalCtx!, target, { rest: rig.rest, hinges: new Set([solver.kneeKey]), iterations: declared ? 8 : 4 });
      const legacy = solver.ctx.bones.map(bone => bone.quaternion.clone());
      solver.ctx.bones.forEach((bone, i) => bone.quaternion.copy(initial[i]!));
      rig.root.updateMatrixWorld(true);
      (declared ? solveFootPlant : solveHandPlant)(solver, target, rig.rest);
      solver.ctx.bones.forEach((bone, i) => expect(bone.quaternion.toArray()).toEqual(legacy[i]!.toArray()));
      expect(shoulder.quaternion.toArray()).toEqual(initial.at(-1)!.toArray());
    });
  }

  for (const side of ['L', 'R'] as const) {
    it(`${side} reach engagement and release include the girdle`, () => {
      const solver = buildHandPlant(rig.skinned, `${side}_Hand`, cfg)!;
      const target = new THREE.Vector3(side === 'L' ? 0.3 : -0.3, 2.1, 0.1);
      reset();
      const initial = solver.ctx.bones.map(bone => bone.quaternion.clone());
      solveHandReach(solver, { target }, 0, rig.rest, 1, true);
      const solved = solver.ctx.bones.map(bone => bone.quaternion.clone());
      const offsets = solved.map((q, i) => initial[i]!.clone().invert().multiply(q));
      expect(offsets.at(-1)!.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.05);
      reset();
      solveHandReach(solver, { target }, 0, rig.rest, 0.5, true);
      solver.ctx.bones.forEach((bone, i) => {
        expect(bone.quaternion.clone().normalize().angleTo(initial[i]!.clone().slerp(solved[i]!, 0.5).normalize())).toBeLessThan(1e-6);
      });
      reset();
      solveHandReach(solver, { target, lettingGo: offsets }, 0, rig.rest, 0.5, true);
      solver.ctx.bones.forEach((bone, i) => {
        expect(bone.quaternion.clone().normalize().angleTo(initial[i]!.clone().slerp(solved[i]!, 0.5).normalize())).toBeLessThan(1e-6);
      });
      reset();
      solveHandReach(solver, { target, lettingGo: offsets }, 0, rig.rest, 0, true);
      solver.ctx.bones.forEach((bone, i) => expect(bone.quaternion.toArray()).toEqual(initial[i]!.toArray()));
    });
  }
});
