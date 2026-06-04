// Pure helpers for the in-3D pose goniometer overlay (the colored
// rings + reference/live arms drawn around the selected joint when
// pose-mode is active). Pulled out of PainBody3D.svelte during the
// maintainability refactor; every function takes its inputs and
// returns / mutates only what's passed in.

import * as THREE from 'three';
import type { RomFieldDefinition, RomPlane } from './romRegistry';

export const POSE_GONIOMETER_SEGMENTS = 96;

export interface PoseGoniometerSlot {
  root: THREE.Group;
  ring: THREE.Line;
  reference: THREE.Line;
  arm: THREE.Line;
}

/** Build a unit-circle BufferGeometry at the given radius, sampled at
 *  POSE_GONIOMETER_SEGMENTS to keep all overlay rings visually consistent. */
export function createPoseGoniometerCircleGeometry(radius: number): THREE.BufferGeometry {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index < POSE_GONIOMETER_SEGMENTS; index += 1) {
    const theta = (index / POSE_GONIOMETER_SEGMENTS) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

/** Two-point segment from origin out to +X at the given radius — the
 *  template arm geometry that gets rotated to show reference vs. live
 *  joint angles. */
export function createPoseGoniometerArmGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(radius, 0, 0),
  ]);
}

/** Orient the goniometer's plane root so the ring lies in the canonical
 *  ROM plane. Mutates the passed group's rotation in place. */
export function applyPoseGoniometerPlaneRotation(root: THREE.Group, plane: RomPlane): void {
  if (plane === 'sagittal') {
    root.rotation.set(0, Math.PI / 2, 0);
  } else if (plane === 'transverse') {
    root.rotation.set(Math.PI / 2, 0, 0);
  } else {
    root.rotation.set(0, 0, 0);
  }
}

/** Update the colors of a goniometer slot's three lines (ring,
 *  reference arm, live arm) to match a ROM field's tone. Cheap when
 *  the colors haven't actually changed (each line short-circuits if
 *  the current hex matches). */
export function setPoseGoniometerSlotColor(
  slot: PoseGoniometerSlot,
  field: RomFieldDefinition,
  armColor: number,
): void {
  const ringMaterial = slot.ring.material as THREE.LineBasicMaterial;
  const referenceMaterial = slot.reference.material as THREE.LineBasicMaterial;
  const armMaterial = slot.arm.material as THREE.LineBasicMaterial;
  if (ringMaterial.color.getHex() !== field.colorHex) ringMaterial.color.setHex(field.colorHex);
  if (referenceMaterial.color.getHex() !== field.colorHex) {
    referenceMaterial.color.setHex(field.colorHex);
  }
  if (armMaterial.color.getHex() !== armColor) armMaterial.color.setHex(armColor);
}
