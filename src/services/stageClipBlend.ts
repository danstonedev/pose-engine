/**
 * Clip transition blend — a short pose-space ease-in when a named clip starts,
 * so a locomotion swap (run → walk) or a start from a Stop-frozen mid-stride
 * pose eases in over ~0.3 s instead of hard-cutting to the new clip's frame 0.
 *
 * Pose-space (not mixer crossfade) ON PURPOSE: it captures the CURRENT skeleton
 * pose when the clip starts — whether that pose is a live outgoing clip frame
 * (direct interrupt) or a static frozen pose (Stop-freeze) — and slerps each
 * captured bone toward the running clip's per-frame value. So it needs no
 * outgoing AnimationAction and works identically from any starting pose.
 *
 * Usage each clip start: `begin(skeletonBones, 0.3)` BEFORE the first
 * `mixer.update`. Then every frame AFTER `mixer.update` (bones now hold the clip
 * pose): `apply(dt)` slerps from the captured pose toward the clip pose. Bones
 * the clip does not animate stay put (slerp(from, from) is identity). Returns
 * false once the ease completes.
 */
import * as THREE from 'three';

/** Anything with a mutable local quaternion (THREE.Bone / Object3D). */
export interface QuatCarrier {
  quaternion: THREE.Quaternion;
}

export interface ClipBlend {
  /** Capture the current local quats of `bones` as the blend START, over
   *  `durationSec`. Call BEFORE the first mixer.update of the new clip. */
  begin(bones: readonly QuatCarrier[], durationSec: number): void;
  /** Slerp each captured bone from its start toward its CURRENT (clip) value by
   *  the eased progress. Call AFTER mixer.update. Returns whether it applied
   *  (false once complete / inactive). */
  apply(dtSec: number): boolean;
  /** True while an ease is in progress. */
  readonly active: boolean;
  /** Abandon any in-progress ease (a takeover replaces it). */
  cancel(): void;
}

/** Smoothstep ease (0..1) — zero velocity at both ends. */
function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

export function createClipBlend(): ClipBlend {
  let bones: readonly QuatCarrier[] = [];
  let from: THREE.Quaternion[] = [];
  let elapsed = 0;
  let duration = 0;
  let isActive = false;
  const _q = new THREE.Quaternion();

  function begin(nextBones: readonly QuatCarrier[], durationSec: number): void {
    if (!nextBones.length || durationSec <= 0) {
      isActive = false;
      return;
    }
    bones = nextBones;
    // Reuse the from-array when the count matches (steady clip-swaps allocate 0).
    if (from.length !== nextBones.length) {
      from = nextBones.map((b) => b.quaternion.clone());
    } else {
      for (let i = 0; i < nextBones.length; i += 1) from[i]!.copy(nextBones[i]!.quaternion);
    }
    elapsed = 0;
    duration = durationSec;
    isActive = true;
  }

  function apply(dtSec: number): boolean {
    if (!isActive) return false;
    elapsed += dtSec;
    const t = elapsed / duration;
    const e = smoothstep(t);
    for (let i = 0; i < bones.length; i += 1) {
      // target = the bone's CURRENT value (the clip pose written by mixer.update)
      _q.slerpQuaternions(from[i]!, bones[i]!.quaternion, e);
      bones[i]!.quaternion.copy(_q);
    }
    if (t >= 1) isActive = false;
    return true;
  }

  function cancel(): void {
    isActive = false;
  }

  return {
    begin,
    apply,
    cancel,
    get active() {
      return isActive;
    },
  };
}
