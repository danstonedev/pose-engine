/** Pinned model and runtime provenance, shared by provisioning and the worker. */
export const REFERENCE_MEDIA_MODEL = Object.freeze({
  name: 'MediaPipe Pose Landmarker Full',
  version: 'float16/1; tasks-vision/1.0.1',
  sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1',
});
export const REFERENCE_MEDIA_PACKAGE_VERSION = '1.0.1';
export const REFERENCE_MEDIA_MODEL_FILENAME = 'pose_landmarker_full.task';
export const REFERENCE_MEDIA_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
export const REFERENCE_MEDIA_WASM_FILES = Object.freeze([
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
]);
