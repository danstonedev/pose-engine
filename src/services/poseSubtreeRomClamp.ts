import type * as THREE from 'three';
import { clampBoneToRom, type JointAngleRestReference } from './poseRomClamp';
import type { RomScenarioConstraints } from './romConstraints';

/** Apply limits after an explicit edit, including descendants whose measured
 * world orientation changed with their parent. Loading a reference must not
 * call this: a human demonstration must remain exactly as captured.
 *
 * Hierarchy order matters because clamping a proximal joint can change the
 * world-frame angles of a distal ball joint. Return adjusted keys so editors
 * can explain downstream changes and offer one undo for the whole edit.
 */
export function clampPoseSubtreeToRom(
  edited: THREE.Object3D,
  bones: ReadonlyMap<string, THREE.Bone>,
  rest: JointAngleRestReference | null | undefined,
  constraints?: RomScenarioConstraints | null,
): string[] {
  const keys = new Map<THREE.Object3D, string>();
  for (const [key, bone] of bones) keys.set(bone, key);
  const adjusted: string[] = [];
  edited.updateWorldMatrix(true, true);
  edited.traverse(object => {
    const key = keys.get(object);
    if (!key || !clampBoneToRom(object as THREE.Bone, key, rest, constraints)) return;
    adjusted.push(key);
    // Refresh this whole branch before any descendant uses its world frame.
    object.updateWorldMatrix(false, true);
  });
  return adjusted;
}
