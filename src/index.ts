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

// Clinical joint-angle measurement (also the canonical JointAngleReport)
export * from './services/jointAngles';

// Range-of-motion definitions + clamping
export * from './services/romRegistry';
export * from './services/poseRomClamp';

// Camera view presets + orbit tween math
export * from './services/cameraTween';

// Limb-axis polyline model
export * from './services/limbAxisModel';

// Movement-clip sampling (catalog-free; app owns its clip catalog)
export * from './services/movementClipSampling';

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
