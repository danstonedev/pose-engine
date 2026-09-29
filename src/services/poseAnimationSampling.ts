import type * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';
import { applyCustomPose } from './poseRig';

/** Sample local animation tracks, including derived twist, while preserving
 * every live bone (CustomPose itself does not include the helper bones). */
export function samplePoseAnimation(
  skeleton: THREE.Skeleton,
  cfg: BodyVariantConfig,
  frames: { t: number; pose: CustomPose }[],
  sampleWithTwist: (read: () => void) => void,
) {
  const saved = skeleton.bones.map(bone => ({ quaternion: bone.quaternion.clone(), position: bone.position.clone() }));
  const perBone = new Map(skeleton.bones.map(bone => [bone.name, [] as number[]]));
  const rootBone = skeleton.bones.find(bone => !(bone.parent as THREE.Bone)?.isBone) ?? skeleton.bones[0]!;
  const rootPos: number[] = [];
  try {
    for (const frame of frames) {
      applyCustomPose(skeleton, cfg, frame.pose);
      sampleWithTwist(() => {
        for (const bone of skeleton.bones) perBone.get(bone.name)!.push(...bone.quaternion.toArray());
        rootPos.push(...rootBone.position.toArray());
      });
    }
  } finally {
    skeleton.bones.forEach((bone, i) => {
      bone.quaternion.copy(saved[i].quaternion);
      bone.position.copy(saved[i].position);
    });
    for (const bone of skeleton.bones) {
      if (!(bone.parent as THREE.Bone)?.isBone) bone.updateWorldMatrix(true, true);
    }
  }
  return { times: frames.map(frame => frame.t), perBone, rootBone, rootPos };
}
