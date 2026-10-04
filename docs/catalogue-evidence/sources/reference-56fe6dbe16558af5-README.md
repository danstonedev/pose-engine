# Local reference pose detector assets

`npm run prepare:reference-media` provisions this folder before dev/build. It
copies the exact npm-locked MediaPipe 1.0.1 ES-module WASM runtime and downloads
the official Full float16 revision 1 model only when the pinned local copy is
absent or invalid. Model bytes are SHA-256 checked during provisioning and again
inside the browser worker. Generated binaries are ignored by Git and included
by Vite's public-directory copy during production builds.

Sources and licenses:

- Runtime: https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.0.1
  (Apache-2.0; integrity pinned in package-lock.json).
- Model: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task
- Google model card states Apache-2.0:
  https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf
- Runtime/model license and third-party notices: `LICENSE.Apache-2.0.txt`, from
  https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE
- Official worker/API reference:
  https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js

The worker uses CPU inference, at most two detected people, and no segmentation
masks. MediaPipe's image preprocessing still requires worker WebGL2 support;
this is checked by actual task initialization, with failures reported to the UI.
The model estimates 33 landmark positions per person; inferred depth and
hip-centred world coordinates are not calibrated motion capture or measured
anatomical joint rotations. Occlusions and limited viewpoints need review.

MediaPipe 1.0.1 contains usage telemetry. Our dedicated worker blocks every
fetch except exact local model/WASM GET requests and disables alternate network
transports. No reference frame or telemetry is uploaded. Model provisioning is
a development/build-time download; there is no runtime CDN fallback.

Validation uses Google's public example photograph
https://storage.googleapis.com/mediapipe-assets/pose.jpg only in
`.validation.local/reference-pose.jpg`; the photograph is not shipped with the app.
