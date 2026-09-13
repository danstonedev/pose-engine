import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { buildBoneByPoseKey, buildIKChainContext, serializeCustomPose, applyCustomPose } from '../services/poseRig';
import { solveArmChainWithRhythm } from '../services/poseScapulohumeral';
import { inspectClinicalAngles } from '../services/poseRomClamp';
import type { RomScenarioConstraints } from '../services/romConstraints';

// Reproduce the handoff's world-space wrist targets. These are solver probes,
// not validated anatomical landmarks or finished FMS/SFMA assessment poses.
const BACK_LOW = [0.075, 1.44, -0.145] as const;
const CROSS_BODY = [0.13, 1.58, 0.02] as const;

describe.each(['male', 'female'] as const)('%s arm reach accuracy', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: THREE.Object3D;
  let skin: THREE.SkinnedMesh;
  let bones: Map<string, THREE.Bone>;
  let baseline: ReturnType<typeof serializeCustomPose>;
  let rest: ReturnType<typeof captureJointAngleRestReference>;

  beforeAll(async () => {
    const b = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '',
    );
    root = gltf.scene;
    root.scale.setScalar(cfg.pose.rootScale);
    root.traverse(o => { if (!skin && (o as THREE.SkinnedMesh).isSkinnedMesh) skin = o as THREE.SkinnedMesh; });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, cfg);
    root.updateMatrixWorld(true);
    rest = captureJointAngleRestReference(skin.skeleton, cfg);
    bones = buildBoneByPoseKey(skin.skeleton, cfg);
    baseline = serializeCustomPose(skin.skeleton, cfg, variant);
  });

  function reach(side: 'L' | 'R', xyz: readonly number[], iterations?: number, constraints?: RomScenarioConstraints, recoverStalledReach = false) {
    applyCustomPose(skin.skeleton, cfg, baseline);
    root.updateMatrixWorld(true);
    const hand = bones.get(`${side}_Hand`)!;
    const full = buildIKChainContext(skin, hand, 3, cfg)!;
    const distal = buildIKChainContext(skin, hand, 2, cfg)!;
    const target = new THREE.Vector3(xyz[0] * (side === 'L' ? -1 : 1), xyz[1], xyz[2]);
    solveArmChainWithRhythm(full, distal, target, { rest, constraints, iterations, recoverStalledReach });
    root.updateMatrixWorld(true);
    return hand.getWorldPosition(new THREE.Vector3()).distanceTo(target);
  }

  function expectInRange(side: 'L' | 'R', constraints?: RomScenarioConstraints) {
    for (const segment of ['Shoulder', 'UpperArm', 'Forearm']) {
      const key = `${side}_${segment}`;
      const report = inspectClinicalAngles(bones.get(key)!, key, rest, constraints)!;
      for (const axis of ['flexion', 'abduction', 'rotation'] as const) {
        const value = axis === 'flexion' ? report.anatomicFlexion : report.raw[axis];
        const range = report.ranges[axis];
        expect(Number.isFinite(value), `${key}.${axis} finite`).toBe(true);
        if (!range) continue;
        expect(value, `${key}.${axis} min`).toBeGreaterThanOrEqual(range.min - 0.5);
        expect(value, `${key}.${axis} max`).toBeLessThanOrEqual(range.max + 0.5);
      }
    }
  }

  it.each(['L', 'R'] as const)('%s: the default settles the lower back reach beyond the historic four-pass result', side => {
    const oldError = reach(side, BACK_LOW, 4);
    const error = reach(side, BACK_LOW);
    expect(oldError).toBeGreaterThan(0.2);
    expect(error).toBeLessThan(oldError / 3);
    expect(error).toBeLessThan(variant === 'male' ? 0.025 : 0.10);
    expectInRange(side);
  });

  it.each(['L', 'R'] as const)('%s: a straightforward forward reach settles within one millimeter', side => {
    expect(reach(side, [-0.2, 1.4, 0.45])).toBeLessThan(0.001);
    expectInRange(side);
  });

  it.each(['L', 'R'] as const)('%s: an explicit iteration budget reaches the actual CCD solver', side => {
    const short = reach(side, BACK_LOW, 4);
    const longer = reach(side, BACK_LOW, 40);
    expect(longer).toBeLessThan(short / 3);
    expectInRange(side);
  });

  it.each(['L', 'R'] as const)('%s: patient elbow limits stay in force with the larger budget', side => {
    const constraints: RomScenarioConstraints = {
      [`${side}_Forearm`]: { elbowFlexion: { availableRange: { max: 40 } } },
    };
    reach(side, [-0.12, 1.45, 0.05], undefined, constraints);
    expectInRange(side, constraints);
    expect(inspectClinicalAngles(bones.get(`${side}_Forearm`)!, `${side}_Forearm`, rest)!.anatomicFlexion)
      .toBeLessThanOrEqual(40.5);
  });

  it.each(['L', 'R'] as const)('%s: unreachable targets remain short while the joints remain in range', side => {
    expect(reach(side, [-1, 2.7, 0.3])).toBeGreaterThan(0.5);
    expectInRange(side);
  });

  it.each(['L', 'R'] as const)('%s: recovery escapes a stalled cross-body reach without widening limits', side => {
    const stalled = reach(side, CROSS_BODY, 40);
    const recovered = reach(side, CROSS_BODY, undefined, undefined, true);
    expect(recovered).toBeLessThan(stalled / 3);
    expect(recovered).toBeLessThan(variant === 'female' ? 0.001 : 0.01);
    expectInRange(side);
  });

  it.each(['L', 'R'] as const)('%s: a recovered arm tracks small target changes without jumping', side => {
    reach(side, CROSS_BODY, undefined, undefined, true);
    const hand = bones.get(`${side}_Hand`)!;
    const full = buildIKChainContext(skin, hand, 3, cfg)!;
    const distal = buildIKChainContext(skin, hand, 2, cfg)!;
    for (let i = 1; i <= 30; i += 1) {
      const before = full.bones.map(bone => bone.quaternion.clone());
      const target = new THREE.Vector3((CROSS_BODY[0] + i * 0.001) * (side === 'L' ? -1 : 1), CROSS_BODY[1], CROSS_BODY[2]);
      solveArmChainWithRhythm(full, distal, target, { rest, recoverStalledReach: true });
      root.updateMatrixWorld(true);
      expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(0.015);
      for (let j = 1; j < full.bones.length; j += 1) {
        expect(full.bones[j].quaternion.angleTo(before[j]) * 180 / Math.PI, `step ${i}, ${full.canonicalKeys[j]}`).toBeLessThan(10);
      }
      expectInRange(side);
    }
  });

  if (variant === 'male') {
    it.each(['L', 'R'] as const)('%s: the opposite-shoulder target settles without the four-pass ROM overshoot', side => {
      expect(reach(side, CROSS_BODY, 4)).toBeGreaterThan(0.2);
      expect(reach(side, CROSS_BODY)).toBeLessThan(0.04);
      expectInRange(side);
    });
  }
});
