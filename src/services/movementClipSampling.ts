// Pure helpers for sampling movement clips and computing transition
// budgets. Extracted from PainBody3D.svelte during the maintainability
// refactor; every function takes a THREE.AnimationClip / Track plus
// scalar inputs and returns derived data without touching scene state.

import * as THREE from 'three';

// NOTE: `getMovementClipSpeed` (and its `MOVEMENT_CLIPS` catalog dependency
// from the body-chart `movementTimeline` module) is intentionally NOT part of
// the shared pose-engine — the clip catalog is an application concern, not a
// pose-math primitive. Consumers that need per-clip speed should own their own
// catalog and pass the scalar in. This keeps the engine free of body-chart's
// pain-map dependency chain (bodyRenderScene / symptomGrouping / bodyChartDebug).

export interface SampledMovementBonePose {
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
}

/** Clamp a movement progress value into [0, 1], coercing NaN / Infinity
 *  to 0 so timeline math never propagates bad values. */
export function clampMovementProgressValue(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  return progress;
}

/** Normalize a rig bone name for cross-rig clip remapping. The CC
 *  skeleton ships without animation clips, so this is currently a
 *  no-op pass; future variants can plug in renames here without
 *  touching call sites. */
export function normalizeRigBoneName(name: string): string {
  return name ?? '';
}

/** Sample every position / quaternion track in a clip at `sampleTime`
 *  and return a map keyed by normalized bone name. The caller passes
 *  in the bone-name normalizer so this stays decoupled from any
 *  particular rig-naming convention. */
export function sampleMovementClipPose(
  clip: THREE.AnimationClip | null,
  duration: number,
  sampleTime: number,
  normalizeBoneName: (name: string) => string,
): Map<string, SampledMovementBonePose> {
  const sampledPose = new Map<string, SampledMovementBonePose>();
  if (!clip) return sampledPose;

  const clampedTime = Math.max(0, Math.min(duration || 0, sampleTime));
  for (const track of clip.tracks) {
    const dotIndex = track.name.indexOf('.');
    if (dotIndex === -1) continue;

    const normalizedBoneName = normalizeBoneName(track.name.slice(0, dotIndex));
    const property = track.name.slice(dotIndex + 1);
    if (property !== 'position' && property !== 'quaternion') continue;

    const interpolant = (
      track as THREE.KeyframeTrack & { createInterpolant: () => { evaluate: (t: number) => Float32Array } }
    ).createInterpolant();
    const sampled = interpolant.evaluate(clampedTime);
    let pose = sampledPose.get(normalizedBoneName);
    if (!pose) {
      pose = {};
      sampledPose.set(normalizedBoneName, pose);
    }

    if (property === 'position' && sampled.length >= 3) {
      pose.position = new THREE.Vector3(sampled[0] ?? 0, sampled[1] ?? 0, sampled[2] ?? 0);
    } else if (property === 'quaternion' && sampled.length >= 4) {
      pose.quaternion = new THREE.Quaternion(
        sampled[0] ?? 0,
        sampled[1] ?? 0,
        sampled[2] ?? 0,
        sampled[3] ?? 1,
      ).normalize();
    }
  }

  return sampledPose;
}

/** Max abs delta between a track's first sample and the value at
 *  `sampleIndex`. Used to detect the first non-trivial keyframe so we
 *  can pick a "preview" pose that actually shows motion. */
export function getTrackValueDelta(
  track: THREE.KeyframeTrack,
  sampleIndex: number,
  valueSize: number,
): number {
  const nextOffset = sampleIndex * valueSize;
  let maxDelta = 0;

  for (let index = 0; index < valueSize; index += 1) {
    const delta = Math.abs((track.values[nextOffset + index] ?? 0) - (track.values[index] ?? 0));
    if (delta > maxDelta) maxDelta = delta;
  }

  return maxDelta;
}

/** Time of the first keyframe that meaningfully differs from the
 *  clip's t=0 pose. Used to seed a preview frame that's not a
 *  blank-canvas zero pose. Returns 0 when no track has a useful
 *  early frame. */
export function computeMovementPreviewTime(clip: THREE.AnimationClip): number {
  let previewTime = Number.POSITIVE_INFINITY;

  for (const track of clip.tracks) {
    const sampleCount = track.times.length;
    const valueSize = track.getValueSize();
    if (sampleCount <= 1 || valueSize <= 0) continue;

    for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
      const sampleTime = track.times[sampleIndex] ?? 0;
      if (!Number.isFinite(sampleTime) || sampleTime <= 0) continue;

      const delta = getTrackValueDelta(track, sampleIndex, valueSize);
      if (delta <= 0.0005) continue;

      previewTime = Math.min(previewTime, sampleTime);
      break;
    }
  }

  if (!Number.isFinite(previewTime) || previewTime <= 0) return 0;
  return Math.min(clip.duration, previewTime);
}
