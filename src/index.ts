/**
 * @vspx/pose-engine — the shared 3D pose system (gold standard).
 *
 * Pure THREE.js pose math + rig config, extracted from the body-chart app so
 * body-chart and the aquatic-therapy simulator consume ONE source of truth.
 * No Svelte, no pain-map/EMR dependencies.
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

// Camera view presets + orbit tween math
export * from './services/cameraTween';

// Limb-axis polyline model
export * from './services/limbAxisModel';

// Movement-clip sampling + lean speed catalog
export * from './services/movementClipSampling';
export * from './services/movementClips';

// Posed-geometry world-space baking
export * from './services/posedGeometry';

// In-3D goniometer overlay helpers
export * from './services/poseGoniometerHelpers';

// Standard scene boot — renderer, lights, GLB variant loader
export * from './services/sceneBoot';

// TransformControls rotate-gizmo configuration helpers
export * from './services/poseGizmoHelpers';

// Full-ring rotate gizmo (swept-angle grab, 3D tube rings, depth overlay)
export * from './services/poseRotateRings';

// Click-vs-drag deselect for pose editing (shared dismiss-on-empty-click trait)
export * from './services/poseClickDeselect';

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
