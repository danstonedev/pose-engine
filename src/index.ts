/**
 * @vspx/pose-engine — the shared 3D pose system (gold standard).
 *
 * Pure THREE.js pose math + rig config, extracted from the body-chart app so
 * body-chart and the aquatic-therapy simulator consume ONE source of truth.
 * No pain-map/EMR dependencies. The math surface is framework-free; the only
 * Svelte export is the optional {@link PoseViewer} clinical-mannequin component.
 *
 * Public surface = everything the consuming apps import. Internal helpers are
 * re-exported too (harmless) so consumers can reach the full math if needed.
 */

// Rig configuration + skeleton helpers
export * from './anatomy/bodyVariants';

// Pose manipulation: FK/IK solve, serialize, blend
export * from './services/poseRig';

// Twist-bone distribution (smooth limb twist deformation)
export * from './services/twistRig';

// Clinical joint-angle measurement (also the canonical JointAngleReport)
export * from './services/jointAngles';

// Range-of-motion definitions + clamping
export * from './services/romRegistry';
export * from './services/poseRomClamp';

// Scenario ROM constraints — per-patient available range / painful arc /
// end-feel overrides a host installs for the active case; the clamp enforces
// normative ∩ constraint and readouts render available-vs-normal.
export * from './services/romConstraints';

// Imperative exam movement commands (simLAB A0) — structural command/outcome
// types, ROM-clamped target resolution (with the documented refusal rule),
// and command-pose construction. Pure math; ExamStage3D animates it.
export * from './services/movementCommand';

// Camera view presets + orbit tween math
export * from './services/cameraTween';

// Limb-axis polyline model
export * from './services/limbAxisModel';

// Movement-clip sampling + lean speed catalog
export * from './services/movementClipSampling';
export * from './services/movementClips';

// Named basic-motion commands (simLAB A2) — the clip-driven sibling of the
// exam movement layer: "walk" / "sit" / "stand" motion vocabulary, per-motion
// metadata (kind / loop / speed), command resolution, and the asset-ingestion
// seam (MotionClipProvider). Clip BYTES/PATHS stay a host/asset concern.
export * from './services/motionCommand';

// Posed-geometry world-space baking
export * from './services/posedGeometry';

// In-3D goniometer overlay helpers
export * from './services/poseGoniometerHelpers';

// Standard scene boot — renderer, lights, GLB variant loader
export * from './services/sceneBoot';

// Shared orbit-viewer boot (scene + camera + OrbitControls + dirty-flag render
// loop + resize + context-loss), the rotate-gizmo TransformControls factory,
// and a DRACO-capable GLTF loader. Additive — collapses the scene-boot block
// duplicated across the consuming apps.
export * from './services/orbitViewer';

// Shared clinical camera controls — the ONE OrbitControls interaction model
// for PoseViewer / ObservationViewer / ExamStage3D: right-drag pan,
// zoom-to-cursor (0.35–6 m), double-click focus-or-reset, keyboard path,
// and opt-in cooperative touch (`allowPageScrollOnMiss`: one finger scrolls
// the page, two fingers move the camera, double-tap focuses).
export * from './services/clinicalCameraControls';

// TransformControls rotate-gizmo configuration helpers
export * from './services/poseGizmoHelpers';

// Full-ring rotate gizmo (swept-angle grab, 3D tube rings, depth overlay)
export * from './services/poseRotateRings';

// Click-vs-drag deselect for pose editing (shared dismiss-on-empty-click trait)
export * from './services/poseClickDeselect';

// Anatomical reference planes + cross-section slicing (cardinal + oblique)
export * from './services/anatomicalPlanes';

// Solid cross-section cap (stencil) for clipped models
export * from './services/sectionCap';

// Anatomic start pose (arms at sides) — the shared 0° clinical reference
export * from './services/anatomicPose';

// Pose types (JointAngleReport intentionally omitted — sourced from
// ./services/jointAngles above to avoid a duplicate-export conflict).
export {
  POSE_SCHEMA_VERSION,
  type ModelPose,
  type CustomPose,
  type PainBodyView,
  type BodySide,
  type PainBodyVector3,
  type MovementClipId,
} from './types';

// Optional Svelte viewer — the shared clinical mannequin (the only non-pure-TS
// export). Consumers that just want the pose math can ignore it; it lazy-loads
// three on mount, so importing the barrel stays SSR/prerender-safe.
export { default as PoseViewer } from './PoseViewer.svelte';

// Optional Svelte panel — the canonical clinical joint-angle readout (direction
// labels + ROM limit bars + status), so every host shows identical angles.
export { default as JointAnglesPanel } from './JointAnglesPanel.svelte';

// Optional Svelte viewer — read-only observation of an AUTHORED patient pose
// (mission-shell `move.observe`, ADR-0018): applies the pose over the anatomic
// baseline and reports the engine-computed joint angles via `onReport`. Same
// lazy-three contract as PoseViewer, so the barrel stays SSR/prerender-safe.
export { default as ObservationViewer } from './ObservationViewer.svelte';

// Optional Svelte stage — ObservationViewer's interactive sibling for simLAB
// exam encounters (voice-3D A0): exposes an imperative, ROM-clamped
// `applyMovementCommand(cmd)` on the component instance that tweens the
// patient and resolves with the MEASURED outcome. Same lazy-three contract,
// so the barrel stays SSR/prerender-safe.
export { default as ExamStage3D } from './ExamStage3D.svelte';
