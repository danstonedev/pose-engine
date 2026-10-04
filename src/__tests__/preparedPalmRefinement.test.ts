import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import { buildHandPlant, stepContactPlants, type ContactPlant, type ContactPlantFrame } from '../services/footContact';

describe.each(['male', 'female', 'neutral'] as const)('%s exact prepared palm refinement', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D, skinned: THREE.SkinnedMesh;
  let baseline: ReturnType<typeof serializeCustomPose>;
  let rest: ReturnType<typeof captureJointAngleRestReference>;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    root.scale.setScalar(cfg.pose.rootScale);
    root.traverse(node => { if (!skinned && (node as THREE.SkinnedMesh).isSkinnedMesh) skinned = node as THREE.SkinnedMesh; });
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    baseline = serializeCustomPose(skinned.skeleton, cfg, variant);
    rest = captureJointAngleRestReference(skinned.skeleton, cfg);
  });

  function fixture() {
    root.position.set(0, 0, 0); root.quaternion.identity();
    applyCustomPose(skinned.skeleton, cfg, baseline); root.updateMatrixWorld(true);
    const solver = buildHandPlant(skinned, 'L_Hand', cfg)!;
    const seed = solver.ctx.bones.map(bone => bone.quaternion.clone());
    const plant: ContactPlant = { solver, fromMs: 0, toMs: 1000, reuseInitialAnchor: false,
      target: solver.ctx.bones[0]!.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(.003, 0, 0)),
      targetOrientation: solver.ctx.bones[0]!.getWorldQuaternion(new THREE.Quaternion()),
      palmApproach: { untilMs: 0, seed, path: [{ tMs: 0, quats: seed }, { tMs: 1000, quats: seed.map(quat => quat.clone()) }] } };
    const frame: ContactPlantFrame = { rest: structuredClone(rest), hingeAxisRest: rest, heelStrikeY: 0, initialTargets: new Map() };
    return { plant, frame };
  }
  const pose = (plant: ContactPlant) => plant.solver.ctx.bones.map(bone => bone.quaternion.toArray());

  it.each(['playback', 'preparation'] as const)('holds the same exact solve input and cloned result during %s', mode => {
    const { plant, frame } = fixture();
    if (mode === 'preparation') plant.palmApproach!.path = [];
    stepContactPlants([plant], 0, frame);
    const expected = pose(plant);
    for (const time of [100, 333, 750, 1000]) {
      // Previous playback state must not alias the stored solution.
      plant.solver.ctx.bones[0]!.quaternion.identity();
      stepContactPlants([plant], time, frame);
      expect(pose(plant)).toEqual(expected);
      expect(plant.palmRefinements?.size).toBe(1);
    }
  });

  it('re-solves changed target, patient, reference, ancestor, geometry and guide inputs', () => {
    const edits: Array<(plant: ContactPlant, frame: ContactPlantFrame) => void> = [
      plant => { plant.target!.x += .001; },
      plant => { plant.targetOrientation!.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .01)); },
      (_, frame) => { frame.constraints = { L_Forearm: { elbowFlexion: { availableRange: { min: 20, max: 40 } } } }; },
      (_, frame) => { frame.rest = { ...frame.rest!, localQuats: { ...frame.rest!.localQuats, L_Hand: [0, 0, 0, 1] } }; },
      () => { root.position.x += .001; },
      plant => { plant.solver.ctx.bones[1]!.position.x += .0001; },
      plant => { plant.palmApproach!.seed = plant.palmApproach!.seed.map(quat => quat.clone()); plant.palmApproach!.seed[0]!.x += .00001; },
      plant => { plant.palmApproach!.sourcePrior = plant.palmApproach!.seed.map(quat => quat.clone()); plant.palmApproach!.sourcePrior[0]!.x += .00001; },
      plant => { plant.palmApproach!.path![1]!.quats[0]!.x += .00001; },
    ];
    for (const edit of edits) {
      const { plant, frame } = fixture();
      const positions = plant.solver.ctx.bones.map(bone => bone.position.clone());
      stepContactPlants([plant], 500, frame);
      edit(plant, frame);
      stepContactPlants([plant], 500, frame);
      expect(plant.palmRefinements?.size).toBe(2);
      const changed = pose(plant);
      plant.palmRefinements!.clear();
      stepContactPlants([plant], 500, frame);
      expect(pose(plant)).toEqual(changed);
      plant.solver.ctx.bones.forEach((bone, index) => bone.position.copy(positions[index]!));
    }
  });
});
