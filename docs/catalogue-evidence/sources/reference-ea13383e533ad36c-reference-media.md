# Reference media authoring

Open `/edit` and use **Image or video reference** in the left workflow rail.

1. Upload an image or video; decoding and detection happen on this device.
2. Choose **Detect this pose**, inspect landmarks and select the intended person.
3. Choose the body-position foundation and adjust confidence or mirrored-reference interpretation if needed.
4. **Apply estimate to working pose**, refine it using the existing editor and explicitly capture a key pose.
5. Run supported physical trials, review the result, and save a library version.

For video, **Build a route from this clip** samples 2–12 frames across up to 12
seconds. Review each thumbnail, its person selection and overlay. The explicit
replacement action fits all selected frames before saving a new route. Start
and End use the first/last selected samples; at least three samples also assign
a middle Target. Route timestamps are relative to the first selected sample,
while original source times remain in provenance. Intermediate visual playback
uses the existing interpolation, which is not a simulated trajectory.

## Profile views and squat fitting

For a side-view overhead squat, **Fit this squat** selects feet-on-floor support,
recognizes a clear profile view, and declares matching left/right movement before
applying an editable estimate. It does not capture or validate a movement.

A profile fit uses aspect-corrected image directions and the mannequin's own
segment lengths, rather than relying on uncertain hidden-side depth. The more
visible arm/leg can guide its obscured counterpart only when **Assume matching
left and right movement** is enabled. Turn it off for asymmetric movements.
Use **Reference view** to specify which direction the person faces in the image
if automatic profile recognition is inconclusive. The report distinguishes the
observed landmarks from symmetry and support assumptions; the original detector
output remains unchanged in saved provenance.

**Standing / squat (feet on floor)** and **Sitting (on a seat)** describe different
support conditions. Feet-on-floor support omits seat/bed props and solves both
foot frames against the floor while keeping the source segment lengths. It is
an authoring constraint; contact forces and balance still need a physical trial.
Keeping the existing bar in a bilateral squat reuses the rig's calibrated grip
as an equipment assumption. It does not infer finger detail from the photograph.

Mean landmark visibility is shown separately from fit quality, with low-visibility
limbs named before applying the estimate. A high average can coexist with an
obscured arm or leg; it must not be read as whole-pose accuracy.

## Storage and runtime

Source blobs are content-addressed by SHA-256 in the browser's
`simmove-reference-media-v1` IndexedDB database. Drafts, revisions and exported
movement JSON retain the hash, name/type/size, detector version/hash, original
33 image/world landmarks, source timestamp, fitting options and diagnostic
report. Raw media is not embedded in movement JSON. Source files must be
reattached on a different browser or device, or after browser data is cleared.
Changing host/port also changes the browser storage origin.

`npm ci` installs the exact `@mediapipe/tasks-vision` runtime. `npm run dev` and
`npm run build` provision the pinned official model and copy the package's WASM
files into `public/reference-media`. The initial model download needs network
access; subsequent starts reuse the checksum-verified local model. To repair
assets, run `npm run prepare:reference-media`. The worker reads only the app's
local runtime/model files, verifies the model SHA-256, uses the CPU delegate,
and blocks telemetry and external network transports. Source images/video
frames are never sent to a service. Production builds include the local assets.
Model/runtime provenance and license details are recorded in
[the asset manifest notes](../public/reference-media/README.md).

Detection is serialized in a dedicated module worker. Cancellation rejects the
pending call and terminates that worker; the next detection creates a fresh one.
Frames are resized to a maximum 1280-pixel dimension before inference, with the
original file retained for review. The client consumes and closes transferred
image bitmaps. Browser codec support determines which videos can be decoded.

## Interpretation and physical limits

The fitter operates on the actual loaded GLB skeleton. It preserves bone-local
positions/scales and segment lengths, fits torso and limb directions, and holds
uncertain segments at their foundation values unless declared bilateral inference
supplies a matching limb. The shoulder/hip frame needs confident observations;
a profile fit may use its visible side with an explicit source-width prior.
Single-view depth and axial twist
remain estimates. Finger articulation, precise scapular motion, spinal segment
distribution and object grasp are not observed by this body-landmark detector.
Keeping an existing bar repositions that bar to the achieved palms while
preserving its dimensions; it does not detect the bar or establish a valid grip.

The selected foundation supplies authoring/support intent. Camera image vertical
is assumed to align with gravity, with a flat floor; tilted-camera calibration
is not implemented. Foot orientation uses heel/toe surface landmarks rather than treating a distal
toe marker as a toe joint. Estimated depth can still tilt an apparently planted
foot; this is reported for review. Source-skin floor placement and visual
seat/backrest props do not calculate contact forces. Existing native ASLR/squat controllers remain
responsible for supported physics attempts, with their existing compatibility
and acceptance gates. A saved estimate cannot certify anatomical accuracy,
balance, assessment quality or physical success.

Video samples are independent still-image detections. Nearest image-space hip
position helps choose the same person across samples, but crossings and
occlusions can switch identity. Review person selection per frame. Temporal
smoothing, robust identity tracking and automatic keyframe ranking remain
future work.
