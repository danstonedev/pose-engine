import * as THREE from 'three';
import {
  type AnatomicPoseTarget,
  type BodyVariantConfig,
  normalizeBoneNameForVariant,
} from '../anatomy/bodyVariants';

/**
 * Pose a freshly-loaded mannequin into ANATOMIC position (arms at sides, palms
 * forward) — the clinical 0° reference. The shared GLB rigs bind in a T-pose, so
 * every app must apply this on load to start from the same place.
 *
 * Driven entirely by the variant config's `pose` block (world-direction targets,
 * Euler rotations, and/or absolute bone-quaternion overrides), so the anatomic
 * definition lives with the rig in pose-engine and never drifts between apps.
 */
export function applyAnatomicPose(root: THREE.Object3D, variantCfg: BodyVariantConfig): void {
  let skeleton: THREE.Skeleton | null = null;
  root.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.SkinnedMesh && child.skeleton) {
      skeleton = child.skeleton;
    }
  });
  if (!skeleton) return;

  const skel = skeleton as THREE.Skeleton;
  const map = variantCfg.boneNameMap;

  // Build a lookup keyed by 'L_UpperArm', 'R_Forearm', 'Hips', etc.
  const boneByPoseKey = new Map<string, THREE.Bone>();
  for (const bone of skel.bones) {
    const norm = normalizeBoneNameForVariant(bone.name, map);
    if (!norm.canonical) continue;
    const sidePrefix = norm.side === 'Left' ? 'L_' : norm.side === 'Right' ? 'R_' : '';
    boneByPoseKey.set(`${sidePrefix}${norm.canonical}`, bone);
  }

  const targets = variantCfg.pose.targets;
  if (targets && Object.keys(targets).length > 0) {
    applyWorldDirectionTargets(root, boneByPoseKey, targets);
  } else {
    for (const [key, [rx, ry, rz]] of Object.entries(variantCfg.pose.rotations)) {
      const bone = boneByPoseKey.get(key);
      if (!bone) continue;
      bone.rotation.x += rx;
      bone.rotation.y += ry;
      bone.rotation.z += rz;
    }
  }

  // Per-bone absolute quaternion overrides, applied last. Any L_* key whose R_*
  // mirror is omitted is auto-applied to R_* via (x, -y, -z, w) — the CC rig's
  // natural L/R local-frame convention. This is how hand-tuned calibration values
  // from the dev-console pose recorder get baked in.
  const overrides = variantCfg.pose.boneQuaternions;
  if (overrides) {
    for (const [key, q] of Object.entries(overrides)) {
      const bone = boneByPoseKey.get(key);
      if (bone) {
        bone.quaternion.set(q[0], q[1], q[2], q[3]);
      }
      if (key.startsWith('L_')) {
        const rightKey = `R_${key.slice(2)}`;
        if (!(rightKey in overrides)) {
          const rightBone = boneByPoseKey.get(rightKey);
          if (rightBone) {
            rightBone.quaternion.set(q[0], -q[1], -q[2], q[3]);
          }
        }
      }
    }
    root.updateMatrixWorld(true);
  }
}

/** Swing each targeted bone's long axis onto its world-direction target (then an
 *  optional twist about that axis), parent-first so children inherit a stable
 *  parent transform. */
function applyWorldDirectionTargets(
  root: THREE.Object3D,
  boneByPoseKey: Map<string, THREE.Bone>,
  targets: Record<string, AnatomicPoseTarget>,
): void {
  root.updateMatrixWorld(true);

  // Process in parent-first order so each bone aligns relative to a stable parent
  // transform. Limb chain: shoulder → upper → fore → hand.
  const orderHints: Record<string, number> = {
    Hips: 0,
    Spine_Lower: 1,
    Spine_Mid: 2,
    Spine_Upper: 3,
    Neck: 4,
    Head: 5,
    Shoulder: 6,
    UpperArm: 7,
    Forearm: 8,
    Hand: 9,
    UpLeg: 10,
    Leg: 11,
    Foot: 12,
    Toes: 13,
  };
  const orderedKeys = Object.keys(targets).sort((a, b) => {
    const tokenA = a.replace(/^[LR]_/, '');
    const tokenB = b.replace(/^[LR]_/, '');
    return (orderHints[tokenA] ?? 99) - (orderHints[tokenB] ?? 99);
  });

  const boneWorldPos = new THREE.Vector3();
  const childWorldPos = new THREE.Vector3();
  const currentWorldDir = new THREE.Vector3();
  const targetDir = new THREE.Vector3();
  const swingWorldQuat = new THREE.Quaternion();
  const currentWorldQuat = new THREE.Quaternion();
  const parentWorldQuat = new THREE.Quaternion();
  const newWorldQuat = new THREE.Quaternion();
  const twistWorldQuat = new THREE.Quaternion();

  for (const key of orderedKeys) {
    const target = targets[key];
    if (!target) continue;
    const bone = boneByPoseKey.get(key);
    if (!bone) continue;

    // Pick a child to define the bone's long-axis direction. Prefer a child bone
    // (skeletal child); fall back to first child of any kind.
    const childBone =
      bone.children.find((c): c is THREE.Bone => (c as THREE.Bone).isBone === true) ??
      bone.children[0];
    if (!childBone) continue;

    bone.updateWorldMatrix(true, false);
    childBone.updateWorldMatrix(true, false);
    bone.getWorldPosition(boneWorldPos);
    childBone.getWorldPosition(childWorldPos);
    currentWorldDir.copy(childWorldPos).sub(boneWorldPos);
    if (currentWorldDir.lengthSq() < 1e-10) continue;
    currentWorldDir.normalize();

    targetDir.set(target.worldDir[0], target.worldDir[1], target.worldDir[2]).normalize();

    // Swing the bone's current world direction onto the target direction.
    swingWorldQuat.setFromUnitVectors(currentWorldDir, targetDir);

    bone.getWorldQuaternion(currentWorldQuat);
    newWorldQuat.copy(swingWorldQuat).multiply(currentWorldQuat);

    // Optional twist about the new world-space long axis.
    if (target.twist) {
      twistWorldQuat.setFromAxisAngle(targetDir, target.twist);
      newWorldQuat.premultiply(twistWorldQuat);
    }

    // Convert the new world quaternion to local (relative to parent).
    if (bone.parent) {
      bone.parent.getWorldQuaternion(parentWorldQuat);
      parentWorldQuat.invert();
      bone.quaternion.copy(parentWorldQuat).multiply(newWorldQuat);
    } else {
      bone.quaternion.copy(newWorldQuat);
    }

    // Refresh world matrices so children inherit the new transform.
    bone.updateMatrixWorld(true);
  }
}
