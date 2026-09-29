import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createStageTwistOverlay, stopClipPreservingBones } from '../services/stageTwistOverlay';
import { buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { loadRigOf, type Rig } from './plantReleaseRig';

const Y = new THREE.Vector3(0, 1, 0);
const turn = (degrees: number) => new THREE.Quaternion().setFromAxisAngle(Y, degrees * Math.PI / 180);

describe.each(['male', 'female'] as const)('%s stage twist ownership', (variant) => {
  let rig: Rig;
  let rest: THREE.Quaternion[];
  let byKey: Map<string, THREE.Bone>;
  let overlay: ReturnType<typeof createStageTwistOverlay>;
  const helpers = (side: string) => {
    const first = byKey.get(`${side}_Forearm`)!.children.find((b) => /twist\d/i.test(b.name))!;
    return [first, first.children.find((b) => /twist\d/i.test(b.name))!];
  };
  beforeAll(async () => {
    rig = await loadRigOf(variant);
    rest = rig.skinned.skeleton.bones.map((bone) => bone.quaternion.clone());
    byKey = buildBoneByPoseKey(rig.skinned.skeleton, rig.variantCfg);
  });
  beforeEach(() => {
    rig.skinned.skeleton.bones.forEach((bone, i) => bone.quaternion.copy(rest[i]));
    rig.root.updateMatrixWorld(true);
    overlay = createStageTwistOverlay();
    overlay.reset(rig.skinned.skeleton, rig.variantCfg);
  });

  it.each(['L', 'R'])('grades %s forearm and hand rotation without moving any measured joint', (side) => {
    const chain = helpers(side);
    const helperRest = chain.map((bone) => bone.quaternion.clone());
    byKey.get(`${side}_Forearm`)!.quaternion.multiply(turn(40));
    byKey.get(`${side}_Hand`)!.quaternion.multiply(turn(30));
    rig.root.updateMatrixWorld(true);
    const pose = serializeCustomPose(rig.skinned.skeleton, rig.variantCfg, variant);
    const positions = new Map([...byKey].map(([key, bone]) => [key, bone.getWorldPosition(new THREE.Vector3())]));
    overlay.beforeRender();
    rig.root.updateMatrixWorld(true);
    // Segment carries 40 degrees; proximal helper counters it to zero, and
    // the next carries half of the combined forearm + hand 70-degree twist.
    expect(chain[0].quaternion.angleTo(helperRest[0].clone().multiply(turn(-40)))).toBeLessThan(1e-6);
    expect(chain[1].quaternion.angleTo(helperRest[1].clone().multiply(turn(35)))).toBeLessThan(1e-6);
    expect(serializeCustomPose(rig.skinned.skeleton, rig.variantCfg, variant)).toEqual(pose);
    for (const [key, bone] of byKey) {
      expect(bone.getWorldPosition(new THREE.Vector3()).distanceTo(positions.get(key)!)).toBeLessThan(1e-8);
    }
    const rendered = chain.map((bone) => bone.quaternion.clone());
    overlay.afterRender();
    chain.forEach((bone, i) => expect(bone.quaternion.angleTo(helperRest[i])).toBeLessThan(1e-6));
    overlay.beforeRender();
    chain.forEach((bone, i) => expect(bone.quaternion.angleTo(rendered[i])).toBeLessThan(1e-6));
    overlay.afterRender();
  });

  it.each(['name', 'uuid', 'bones', 'index'] as const)('preserves a clip-owned helper chain with %s binding, including the held end frame', (binding) => {
    const left = helpers('L');
    const right = helpers('R');
    byKey.get('L_Forearm')!.quaternion.multiply(turn(60));
    byKey.get('R_Forearm')!.quaternion.multiply(turn(60));
    const rightRest = right[0].quaternion.clone();
    left[0].quaternion.multiply(turn(17));
    left[1].quaternion.multiply(turn(-11));
    const authored = left.map((bone) => bone.quaternion.clone());
    const name = binding === 'uuid' ? left[1].uuid : binding === 'bones' ? `.bones[${left[1].name}]` : binding === 'index' ? `.bones[${rig.skinned.skeleton.bones.indexOf(left[1] as THREE.Bone)}]` : left[1].name;
    const clip = new THREE.AnimationClip('authored-twist', 1, [
      new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [...authored[1].toArray(), ...authored[1].toArray()]),
    ]);
    for (let frame = 0; frame < 3; frame++) {
      overlay.beforeRender(clip);
      left.forEach((bone, i) => expect(bone.quaternion.angleTo(authored[i])).toBeLessThan(1e-6));
      expect(right[0].quaternion.angleTo(rightRest)).toBeGreaterThan(0.9);
      overlay.afterRender();
      left.forEach((bone, i) => expect(bone.quaternion.angleTo(authored[i])).toBeLessThan(1e-6));
    }
    // A recorded/procedural pose derives twist even after a source clip ended.
    overlay.beforeRender(null);
    expect(left[0].quaternion.angleTo(authored[0])).toBeGreaterThan(0.9);
    overlay.afterRender();
  });

  it('restores an interrupted render when disabled, and rebuilds against a new baseline', () => {
    const chain = helpers('L');
    const original = chain[0].quaternion.clone();
    byKey.get('L_Forearm')!.quaternion.multiply(turn(50));
    overlay.beforeRender();
    overlay.setEnabled(false);
    expect(chain[0].quaternion.angleTo(original)).toBeLessThan(1e-6);
    overlay.beforeRender();
    expect(chain[0].quaternion.angleTo(original)).toBeLessThan(1e-6);
    overlay.setEnabled(true);
    overlay.reset(rig.skinned.skeleton, rig.variantCfg);
    overlay.beforeRender();
    expect(chain[0].quaternion.angleTo(original)).toBeLessThan(1e-6);
    overlay.afterRender();
  });

  it('recomputes after a host arm correction, then restores the original helper pose', () => {
    const bone = byKey.get('L_Forearm')!;
    const helper = helpers('L')[0];
    const original = helper.quaternion.clone();
    bone.quaternion.multiply(turn(40));
    overlay.beforeRender();
    const hostSavedHelper = helper.quaternion.clone();
    bone.quaternion.multiply(turn(20));
    overlay.refresh();
    expect(helper.quaternion.angleTo(original.clone().multiply(turn(-60)))).toBeLessThan(1e-6);
    // Reverse the host correction, then the shared overlay, just as the stage does.
    bone.quaternion.multiply(turn(-20));
    helper.quaternion.copy(hostSavedHelper);
    overlay.afterRender();
    expect(helper.quaternion.angleTo(original)).toBeLessThan(1e-6);
  });

  it('releases a frozen source clip to manual posing without reverting the visible bones', () => {
    const bone = byKey.get('L_Forearm')!;
    const helper = helpers('L')[0];
    const mixer = new THREE.AnimationMixer(rig.root);
    const clip = new THREE.AnimationClip('once', 0.1, [bone, helper].map(node =>
      new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, [0, 0.1],
        [...node.quaternion.toArray(), ...node.quaternion.clone().multiply(turn(40)).toArray()]),
    ));
    const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.update(0.2);
    const frozen = rig.skinned.skeleton.bones.map(node => node.quaternion.clone());
    stopClipPreservingBones(mixer, rig.skinned.skeleton.bones);
    mixer.update(1);
    // Float32 animation tracks need not be perfectly unit length: identical
    // quaternion components are a stronger preservation check than angleTo.
    rig.skinned.skeleton.bones.forEach((node, i) => expect(node.quaternion.toArray()).toEqual(frozen[i].toArray()));
    // Once released, the procedural renderer owns helpers again.
    overlay.beforeRender(null);
    expect(helper.quaternion.angleTo(frozen[rig.skinned.skeleton.bones.indexOf(helper as THREE.Bone)])).toBeGreaterThan(1);
    overlay.afterRender();
    mixer.uncacheRoot(rig.root);
  });
});
