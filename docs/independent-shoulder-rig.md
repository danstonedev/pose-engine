# Independent clavicle/scapula rig (opt-in)

`IndependentShoulderLab` and `independentShoulderVariant` expose a versioned engineering rig for all three body models. Existing default models and patient-facing motion playback remain on v1. The v2 hierarchy is thorax -> clavicle -> scapula -> upper arm, with the original forearm, hand and twist chains retained.

There are two added deforming joints (one scapula per side): 103 skin joints versus 101. Each side has three independently controllable segment rotations, SC, AC and GH (nine rotational coordinates). ST and HT are derived observations of that chain, not two additional independently actuated joints. Pelvic articulation and root placement remain separate existing controls.

## Assets and calibration

Run `node scripts/build-shoulder-v2-models.mjs`. It reads the existing source assets and writes separate `*.shoulder-v2.glb` files, a version-specific manifest and generated runtime asset identities. It never overwrites the v1 asset or baseline manifest. Original joint indices, geometry, normals, UVs, triangle order and materials remain intact; the converter appends scapula joints/inverse binds, changes the reviewed skin weights and retargets default animation translations. Both new joints have a posterior skin patch: 63 vertices per side for male, 81 female and 73 neutral, with zero pruned influence weight in these outputs. Four influences per vertex are retained. Maximum measured bind-pose displacement is below 0.00014 mm.

The existing clavicle attachment is the provisional SC location. AC is placed 15 mm medial and superior to the existing GH origin. These are explicit engineering estimates, not measured anatomical landmarks. Skin blending is a bounded spatial patch using existing thoracic/clavicular influence. It does not simulate rib contact or calibrated scapular muscle/tissue mechanics. The manifest records each variant's positions, source/output hashes, weight counts and geometry hashes.

Frames align with physical +X (left), +Y (superior), +Z (anterior) at reference capture, then follow their segments. Readouts are relative quaternions and rotation magnitudes with version/convention metadata. They are not relabeled legacy projections or ISB clinical Euler angles. SC = thorax-relative clavicle; AC = clavicle-relative scapula; ST = thorax-relative scapula; GH = scapula-relative humerus; HT = thorax-relative humerus. Root and trunk movement do not change these relative measurements.

## Ownership and compatibility

`applyIndependentShoulderTargets` composes a complete command atomically. Explicit SC/AC/GH take priority. An ST target solves AC only when AC was not explicit; HT solves GH only when GH was not explicit. Conflicting derived targets return angular residuals. The controller validates finite unit quaternions before mutation. It supplies kinematics, not patient-specific physiological limits or physical ST contact. The review sliders use stated engineering ranges; no universal shoulder rhythm is introduced.

Pose version, a distinct saved-pose schema and exact asset SHA protect playback. Explicit legacy migration inserts identity scapula rotations and transforms upper-arm positions into their new parent frames, preserving old bone world transforms. Clip migration adjusts translation tracks and supplies neutral scapula tracks; repeat migration is rejected. Incompatible/malformed poses fail before mutation. Identity survives interpolation, sequence sampling and compact recording. Arm IK selects semantic segments, including the independent scapula when present, rather than relying on a fixed parent count. Existing v1 hand-contact regressions continue to pass.

Use `holdUnmentioned` when a composed sequence must preserve an authored independent shoulder pose; ordinary sequences retain their existing settle-unmentioned policy. The legacy shoulder command vocabulary and capacity proxy are not promoted to anatomical v2 clinical semantics. Automatic full-catalog coordination, patient-bound integration of independent SC/AC/GH, calibrated ST contact and promotion into the standard exam stage remain explicit follow-up work.

## Validation

- 39 production-rig tests: both sides, independent controls and priorities, SC/AC/ST closure, root/trunk invariance, real skin displacement, semantic IK, legacy pose/clip migration, version rejection and sampled recording replay.
- Three host-quantization tests use simMOVE's exact 14-bit position/8-bit weight settings, with a preselected maximum skin displacement of 1 mm at neutral and articulated poses. Observed maxima: 0.661 mm male, 0.442 mm female, 0.456 mm neutral.
- 18 rendered cases across all three models and both sides cover neutral, elevation and isolated scapular rotation, plus skin-weight views and pose restoration.
- Existing v1 engine tests and support tolerances are retained. Numerical validation and rendered review do not confer clinical calibration or sign-off.

The anatomical distinction between SC/AC/GH and derived segment motion follows the [ISB shoulder-coordinate recommendation](https://isbweb.org/images/documents/standards/Wu%20et%20al%20J%20Biomech%2038%20%282005%29%20981%E2%80%93992.pdf); this implementation deliberately labels its provisional frames separately. Skin joint ordering and inverse-bind handling follow the [glTF skin specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#skins).
