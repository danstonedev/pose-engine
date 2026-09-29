import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import { applyTwistRig, buildTwistRig, type TwistSegment } from './twistRig';

/** AnimationMixer restores its original bindings when stopped. A manual edit
 * of a completed clip must instead retain the currently visible bone pose. */
export function stopClipPreservingBones(mixer: THREE.AnimationMixer, bones: THREE.Bone[]): void {
  const saved = bones.map(bone => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() }));
  mixer.stopAllAction();
  bones.forEach((bone, i) => {
    bone.position.copy(saved[i].position);
    bone.quaternion.copy(saved[i].quaternion);
    bone.scale.copy(saved[i].scale);
  });
}

/** Render-only twist distribution shared by posing, commands, composed motion
 * and recorded poses. A clip owns a segment if it animates any of that segment's
 * helper bones; its authored twist must survive both playback and a frozen end
 * frame. Restore after rendering so helpers never leak into another driver. */
export function createStageTwistOverlay() {
  let rig: TwistSegment[] = [];
  let skeletonBones: THREE.Bone[] = [];
  let saved: THREE.Quaternion[][] = [];
  let applied: number[] = [];
  let enabled = true;
  let clipCache = new WeakMap<THREE.AnimationClip, Set<number>>();

  function restore(): void {
    for (const index of applied) {
      rig[index].chain.forEach((bone, i) => bone.quaternion.copy(saved[index][i]));
    }
    applied = [];
  }

  function clipOwnedSegments(clip: THREE.AnimationClip): Set<number> {
    const cached = clipCache.get(clip);
    if (cached) return cached;
    const owned = new Set<number>();
    for (const track of clip.tracks) {
      const binding = THREE.PropertyBinding.parseTrackName(track.name);
      if (binding.propertyName !== 'quaternion' && binding.propertyName !== 'rotation') continue;
      const name = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
      // Match Three's bone binding: names take precedence over numeric indices.
      const boundBone = binding.objectName === 'bones'
        ? skeletonBones.find(bone => bone.name === name) ?? (/^\d+$/.test(name ?? '') ? skeletonBones[Number(name)] : undefined)
        : undefined;
      rig.forEach((segment, i) => {
        if (segment.chain.some((bone) => bone === boundBone || bone.name === name || bone.uuid === name)) owned.add(i);
      });
    }
    clipCache.set(clip, owned);
    return owned;
  }

  return {
    /** Call after the anatomic baseline, before applying an authored pose. */
    reset(skeleton: THREE.Skeleton | null, cfg: BodyVariantConfig): void {
      restore();
      rig = skeleton ? buildTwistRig(skeleton, cfg) : [];
      skeletonBones = skeleton?.bones ?? [];
      saved = rig.map((segment) => segment.chain.map(() => new THREE.Quaternion()));
      clipCache = new WeakMap();
    },
    setEnabled(value: boolean): void {
      restore();
      enabled = value;
    },
    beforeRender(clip: THREE.AnimationClip | null = null): void {
      restore();
      if (!enabled) return;
      const owned = clip ? clipOwnedSegments(clip) : null;
      const eligible: TwistSegment[] = [];
      rig.forEach((segment, index) => {
        if (owned?.has(index)) return;
        segment.chain.forEach((bone, i) => saved[index][i].copy(bone.quaternion));
        applied.push(index);
        eligible.push(segment);
      });
      applyTwistRig(eligible);
    },
    /** A host can make render-only arm corrections after markers/slicing have
     * updated. Re-derive twist from that final pose without replacing the clean
     * pre-render snapshot that afterRender must restore. */
    refresh(): void {
      applyTwistRig(applied.map(index => rig[index]));
    },
    afterRender: restore,
  };
}
