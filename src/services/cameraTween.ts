// Pure helpers for the camera-view + focus-orbit tween used by
// PainBody3D. The component still owns the THREE camera + controls
// instances and the rAF loop; this module just supplies the
// constants, shape definitions, and math.

import * as THREE from 'three';
import type { PainBodyView } from '../types';

/** On narrow screens, pull the camera back so the model is smaller
 *  and the controls have room. */
export const MOBILE_ZOOM_OUT = 1.4;

export interface CameraViewPreset {
  position: [number, number, number];
  target: [number, number, number];
}

export const VIEW_PRESETS: Record<PainBodyView, CameraViewPreset> = {
  front: { position: [0, 0.85, 3.2], target: [0, 0.75, 0] },
  back: { position: [0, 0.85, -3.2], target: [0, 0.75, 0] },
  left: { position: [-2.8, 0.85, 0], target: [0, 0.75, 0] },
  right: { position: [2.8, 0.85, 0], target: [0, 0.75, 0] },
};

/** OrbitTween fully describes a single camera-orbit pass. The camera
 *  rotates around the body's vertical (Y) axis through `pivot` so a
 *  mark ends up on the screen's vertical midline without altering
 *  pitch or zoom. */
export interface OrbitTween {
  /** Rotation axis passes through here (along Y). */
  pivot: THREE.Vector3;
  /** Horizontal distance from axis. */
  radius: number;
  /** Initial azimuth in the XZ plane (atan2(z, x)). */
  fromAngle: number;
  /** Signed shortest arc to the target azimuth. */
  deltaAngle: number;
  fromY: number;
  toY: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  startedAt: number;
  durationMs: number;
}

/** Compute the desired camera position + look-at target for a static
 *  view preset, applying the mobile zoom-out scaling on narrow
 *  screens. Pure: no scene state. */
export function resolveCameraViewSetpoint(
  view: PainBodyView,
  isMobile: boolean,
): { position: [number, number, number]; target: [number, number, number] } {
  const preset = VIEW_PRESETS[view];
  const scale = isMobile ? MOBILE_ZOOM_OUT : 1;
  return {
    position: [preset.position[0] * scale, preset.position[1], preset.position[2] * scale],
    target: [...preset.target],
  };
}

/** Build an OrbitTween that orbits the camera around the front-preset
 *  pivot until it faces the supplied world target. Returns null when
 *  the existing camera is already essentially facing the target, or
 *  when the target sits on the rotation axis (no orbit can reveal it
 *  better). Pure: copies vectors and reads inputs. */
export function buildOrbitTweenForWorldTarget(opts: {
  cameraPosition: { x: number; y: number; z: number };
  controlsTarget: THREE.Vector3;
  worldTarget: { x: number; y: number; z: number };
  startedAt: number;
}): OrbitTween | null {
  const frontPreset = VIEW_PRESETS.front;
  const pivot = new THREE.Vector3(
    frontPreset.target[0],
    frontPreset.target[1],
    frontPreset.target[2],
  );

  const camDX = opts.cameraPosition.x - pivot.x;
  const camDZ = opts.cameraPosition.z - pivot.z;
  let radius = Math.hypot(camDX, camDZ);
  if (radius < 0.0001) {
    // Degenerate: camera sitting on the axis. Fall back to preset
    // radius so we have something to orbit on.
    radius = Math.hypot(frontPreset.position[0], frontPreset.position[2]);
  }
  const fromAngle = Math.atan2(camDZ, camDX);

  const markDX = opts.worldTarget.x - pivot.x;
  const markDZ = opts.worldTarget.z - pivot.z;
  if (Math.hypot(markDX, markDZ) < 0.0001) {
    // Mark is on the central axis — no orbit can reveal it better.
    return null;
  }
  const toAngle = Math.atan2(markDZ, markDX);

  // Shortest signed arc in (-π, π].
  let delta = toAngle - fromAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  // Skip if already essentially facing the mark.
  if (Math.abs(delta) < 0.01) return null;

  return {
    pivot,
    radius,
    fromAngle,
    deltaAngle: delta,
    fromY: opts.cameraPosition.y,
    // Preserve pitch; only yaw changes.
    toY: opts.cameraPosition.y,
    fromTarget: opts.controlsTarget.clone(),
    toTarget: pivot.clone(),
    startedAt: opts.startedAt,
    // Scale duration with angular distance so short flicks feel
    // snappy and 180° flips get enough time to read.
    durationMs: 260 + (Math.abs(delta) / Math.PI) * 340,
  };
}

/** Fit-to-sphere camera placement for the export pipeline. Given the
 *  model's bounding sphere, the view preset, and the export camera's
 *  aspect / fov, compute the camera position that keeps the sphere
 *  fully visible with the supplied margin. Pure: only does math —
 *  caller writes the result onto a THREE.PerspectiveCamera.
 *
 *  The horizontal direction comes from the preset (Y-component is
 *  zeroed so a posed mannequin still gets a level-eye export);
 *  fitDistance uses the smaller of vTan / hTan since a tall narrow
 *  panel is horizontally constrained. */
export function fitExportCameraToSphere(opts: {
  sphereCenter: THREE.Vector3;
  sphereRadius: number;
  preset: CameraViewPreset;
  cameraAspect: number;
  cameraFovDeg: number;
  margin: number;
}): { position: THREE.Vector3; target: THREE.Vector3 } | null {
  const { sphereCenter, sphereRadius, preset, cameraAspect, cameraFovDeg, margin } = opts;
  if (!Number.isFinite(sphereRadius) || sphereRadius <= 0) return null;

  const horizPlanar = Math.hypot(preset.position[0], preset.position[2]);
  const dirX = horizPlanar > 0 ? preset.position[0] / horizPlanar : 0;
  const dirZ = horizPlanar > 0 ? preset.position[2] / horizPlanar : 1;

  const vFovRad = (cameraFovDeg * Math.PI) / 180;
  const vTan = Math.tan(vFovRad / 2);
  const hTan = vTan * cameraAspect;
  // Smallest of the two governs how far we need to be back: a tall
  // narrow panel (aspect < 1) is horizontally constrained, so
  // hTan < vTan and dictates the distance.
  const fitDistance = (sphereRadius / Math.min(vTan, hTan)) * margin;

  return {
    position: new THREE.Vector3(
      sphereCenter.x + dirX * fitDistance,
      sphereCenter.y,
      sphereCenter.z + dirZ * fitDistance,
    ),
    target: sphereCenter.clone(),
  };
}

/** Fall-back camera placement when the model's bounding sphere
 *  isn't measurable: scale the preset's position by the report /
 *  mobile zoom, look at the preset's target. Pure. */
export function placeExportCameraFromPreset(
  preset: CameraViewPreset,
  scale: number,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  return {
    position: new THREE.Vector3(
      preset.position[0] * scale,
      preset.position[1],
      preset.position[2] * scale,
    ),
    target: new THREE.Vector3(...preset.target),
  };
}

/** Evaluate an OrbitTween at a given time. Returns the camera
 *  position, look-at target, and a `done` flag indicating whether
 *  the tween has reached t=1. Pure given the tween shape + an
 *  easing function. */
export function evaluateOrbitTween(
  tween: OrbitTween,
  now: number,
  easing: (t: number) => number,
): { position: THREE.Vector3; target: THREE.Vector3; done: boolean } {
  const t = Math.min(1, Math.max(0, (now - tween.startedAt) / tween.durationMs));
  const eased = easing(t);
  const angle = tween.fromAngle + tween.deltaAngle * eased;
  const y = tween.fromY + (tween.toY - tween.fromY) * eased;
  const position = new THREE.Vector3(
    tween.pivot.x + tween.radius * Math.cos(angle),
    y,
    tween.pivot.z + tween.radius * Math.sin(angle),
  );
  const target = new THREE.Vector3().lerpVectors(tween.fromTarget, tween.toTarget, eased);
  return { position, target, done: t >= 1 };
}
