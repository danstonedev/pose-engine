# FMS and SFMA movement audit

Reviewed 2026-09-13. Scope: the application's seven FMS tests, three clearing
tests, and ten SFMA top-tier entries. This is an implementation audit and task
specification, not a clinical qualification or a replacement for a protocol
manual. Breakout movements are outside this pass.

The main problem is source fidelity: several entries resolve successfully but
play a different exercise. Reusing the editing workflow is appropriate; reusing
the name of a generic exercise as proof that an assessment is covered is not.
The tables record the sources present **at the beginning of this implementation
pass**, so they remain useful after replacement recipes are added.

## Protocol identity must travel with the movement

The public [FMS course outline](https://www.functionalmovement.com/store/35/fms_level_1_online_course)
still identifies seven movement tests. The repository's three clearing entries
and same-side-first Rotary Stability instructions represent an older procedure
set. FMS announced changes to Rotary Stability and an additional ankle clearing
component in 2020. The public announcement establishes that a version difference
exists; its linked detailed release requires login. Preserve existing cases and
label their procedure version rather than silently treating them as the current
screen. [Official FMS update](https://www.functionalmovement.com/Articles/916/functional_movement_screen_updates_rota).

The repository's SFMA overhead squat belongs to a legacy procedure. The official
version-16 score sheet includes Overhead Deep Squat; the currently accessible
course outline and FMS explanation identify Arms Down Deep Squat. Preserve the
existing `overhead-deep-squat` ID and its saved cases as legacy. A current arms-down
task needs its own identity and verified procedure; merely dropping the bar from
the FMS task would not establish its setup or scoring. [Legacy SFMA v16](https://www.functionalmovement.com/files/Articles/463a_SFMA_Scoresheet_Flowcharts_v16.pdf),
[current SFMA course outline](https://functionalmovement.com/Store/200/sfma_level_1_-_online_certification),
[official comparison of FMS and SFMA](https://www.functionalmovement.com/articles/1133/fms_and_sfma_when_should_i_use_what).

The ten SFMA rows are the app's subdivisions: cervical flexion, extension and
rotation are separate entries, as are the two UE patterns. They are not ten
independent official top-tier families.

Store protocol identity, source/revision, side meaning, setup, assessed phase,
return, equipment and support with every reusable recipe. Keep geometric targets
separate from evidence that those targets were achieved. Pain remains explicit
case input or a user's observation; joint angles and solver errors do not establish
pain or an automatic clinical score.

## FMS task specifications and source defects

These concise task specifications paraphrase the repository's own
[`fms.ts`](../src/screen/data/fms.ts). The corrections concerning stance, heels
and hand placement are supported by FMS's
[official setup review](https://www.functionalmovement.com/articles/793/commonly_made_mistakes_when_using_the_fms).
That review specifies shoulder-width forward-facing feet for deep squat, an
in-line stance measured from tibial height with heels down, and distinct
forehead/chin/clavicle hand levels for push-up variants. Exact dimensions must
come from the model landmarks and selected procedure, not one hardcoded body.

| Entry | Setup → assessed movement → return | Support / equipment | Source defect found; immediate authoring action |
| --- | --- | --- | --- |
| Deep Squat | Shoulder-width upright stance with overhead grasp → controlled descent and inspectable depth → stand with the same grasp. | Both soles; dowel. Heel-elevated variant is separate. | `buildSquat` plus overhead arm override is a useful seed. Its compensation solver and arm targets are authored kinematics. Retain the newer fitted overhead endpoints and native squat trial; compare source and native route explicitly. Do not confuse ankle-center spacing with the official inside-foot/armpit landmark relationship. |
| Hurdle Step | Feet together and dowel across shoulders → selected leg clears the measured hurdle, heel touches beyond it → crosses back and restores stance. | Stance foot, light far-side heel contact; hurdle and dowel. | `high-knee-march` alternates both legs, swings the opposite arm, uses floating stance, and has no hurdle crossing or heel touch. Replace with an explicit side-specific crossing route and fixed upper-body setup. |
| In-Line Lunge | Establish measured in-line stance and vertical dowel behind back → lower rear knee toward the board behind front heel → recover in the same stance. | Narrow two-foot support plus knee contact; board and dowel with head/thorax/sacrum contact goals. | `forward-lunge` is right-leading and deliberately lifts the rear heel, adds trunk flexion, and lacks the board/dowel setup. Build the actual measured stance and keep all three dowel contacts inspectable. Side must identify the tested front leg. |
| Shoulder Mobility | Upright with hands prepared as fists → reciprocal upper and lower reaches behind back → arms return to sides. | Feet; hands do not support body weight. No bar. | Unposed. Reuse saved lower-back reach, upper reach controls, grasp/finger editing and scapular/trunk tools. Define which side is the upper arm and mirror the whole reciprocal task, not just one hand. Measure fist gap and model hand length, rather than wrist-target distance. |
| Active Straight-Leg Raise | Supine, legs extended and arms at sides → selected straight leg raises while opposite leg stays down → controlled lowering. | Posterior body and non-raised leg; measurement dowel is a guide, not a grasped load. | `buildSupineLegRaise` only commands raised hip/knee and uses a fixed 70° target. Reuse the ASLR fixture and current gravity/contact trial, ensure supine setup first, and expose down-leg/pelvis behavior. Hip angle alone is not the landmark-based result. |
| Trunk Stability Push-Up | Prone at the selected hand level, toes prepared → press trunk and pelvis upward together → controlled return to prone. | Hands and toes after lift; anterior body at setup/return. | `buildPushUp` starts at the top plank, lowers and returns to plank. It demonstrates an exercise repetition, not the prone-start test. Replace phase order and use explicit hand-level variants. Model sex must not silently substitute for the user's selected test condition. |
| Rotary Stability — repository legacy procedure | Quadruped over board → same-side arm/leg reach, elbow-knee approximation over board and re-extension → all fours. Keep diagonal fallback separate. | Remaining hand, knee and foot contacts; board. | `buildBirdDog` raises the opposite leg, omits elbow-knee approximation and contains only one extension/return. Replace with distinct ipsilateral and diagonal routes; retain legacy label pending current-protocol verification. |
| Shoulder Clearing | Upright, palm on opposite shoulder → raise that elbow while retaining palm contact → lower and release. | Feet; hand-to-shoulder contact. | Unposed. Reuse cross-body IK and named shoulder/elbow controls. A generic reach to an isolated wrist marker does not establish palm placement. |
| Spinal Extension Clearing | Prone, hands set near shoulders → press chest up while pelvis remains supported → chest returns to surface. | Palms, pelvis/anterior lower body; floor or specified table. | `buildLowerToProne` ends face-down with arms alongside and never presses upward. Use a prone-start extension route with maintained pelvis support. |
| Spinal Flexion Clearing | Quadruped → hips sit toward heels with forward hand reach and spinal flexion → return to quadruped. | Hands, knees, shins/feet; body contact changes with depth. | `buildGetDownToQuadruped` merely transfers from standing onto all fours. Use the final quadruped setup as the beginning, then add the actual rock-back and recovery. |

The FMS article on movement patterns distinguishes reciprocal shoulder/hip tasks
from isolated joint tests and describes the three traditional clearing tests as
pain checks. It supports retaining the entire chain and explicit case-reported
pain, rather than assigning a result from endpoint angle alone.
[Official pattern explanation](https://www.functionalmovement.com/Articles/767/simplicity_and_the_fms_peeling_back_the_layers_of_the_screen).

## SFMA top-tier task specifications and source defects

Task descriptions below follow the app's
[`topTier.ts`](../src/screen/data/topTier.ts) legacy procedure. The official older
score sheet records separate UE targets, whole-body flexion/extension/rotation
observations, and open/closed-eye single-leg holds. This confirms why isolated
hip rotation, generic lumbar AROM and a short balance exercise are insufficient
substitutes. It does not validate the rig's corresponding landmarks or angular
readouts. [Official legacy procedure observations](https://www.functionalmovement.com/files/articles/463a_sfma-version11flowcharts-2015.pdf).

| Entry | Setup → assessed movement → return | Reusable tools and source defect found | Remaining physical / reference requirement |
| --- | --- | --- | --- |
| Cervical Flexion | Feet together, upright, mouth closed → chin toward chest → neutral head. | Existing authored neck 0/50/0° sequence and neutral trunk targets are relevant. Keep direct neck controls and anatomical view. | Landmark contact and mouth state are not proved by a 50° neck command. Native neck articulation elsewhere is not a verified standing cervical trial. |
| Cervical Extension | Feet together, upright → head extends upward/back → neutral. | Existing neck 0/−60/0° sequence is relevant. Retain thorax/pelvis observation. | Validate face-plane orientation and trunk substitution; full neck mechanics and anatomical joint frames remain independent evidence. |
| Cervical Rotation | Upright, chin level → turn toward selected side → return to center. | Generic template rotates left then right at 70°, while hold mode stops at the first hold. Build selected-side trajectory and match side semantics. | Validate head rotation against torso and landmark target; don't rotate the root as a substitute. |
| UE Pattern 1 | Upright → hand behind back toward inferior angle of opposite scapula → arm returns. | Unposed despite existing lower-back R&D reach and hand/shoulder/scapular tools. Transfer those controls into a named route. | Opposite scapula moves with trunk/girdle. Target must be an anatomical moving landmark; body contact and palm orientation require evidence on both sides/models. |
| UE Pattern 2 | Upright → hand over head toward opposite scapular spine → arm returns. | Unposed. Reuse overhead preset, upper reach IK, elbow controls and scapular coordination. | Overhead routing needs head/neck/upper-back clearance and fitted contact. Do not label a lowered wrist close to a world-space marker as anatomical success. |
| Multi-Segmental Flexion | Feet together, knees straight → bend and reach toes → return upright. | `forward-hip-hinge` explicitly unlocks both knees 12°. Replace that substitution and retain pelvis/lumbar/thoracic coordination. | Planted soles and balanced posterior shift; fingertip-to-toe and sacral/spinal observations need fitted landmarks. A two-segment spine cannot establish a uniformly distributed vertebral curve. |
| Multi-Segmental Extension | Feet together, arms overhead without bar → extend through body → upright. | `lumbar-flexion-extension` first flexes forward and only later extends; hold mode chooses the forward bend. Build only setup/whole-body extension/return with maintained arm position. | Closed-chain hip/pelvis/trunk balance; support bounds and shoulder/hip landmark observations. Never add a bar to satisfy an unrelated squat backend. |
| Multi-Segmental Rotation | Feet together → rotate pelvis and trunk toward selected side while soles remain → return center. | `hip-rotation` is floating open-chain rotation of only the right thigh. Replace with a coupled pelvis/hip/tibial/trunk route and actual selected side. | Rotational foot friction, tibial/hip coupling and residual side-bend. Pelvis and shoulder angles need an explicitly stated reference frame. |
| Single-Leg Stance | Upright, arms at sides → shift load, raise selected knee to hip height, hold → replace foot and re-center. Separate eyes-open and eyes-closed trials. | Generic template raises hip only 30°, knee 45°, holds 1.5 s, and authors 32° arm abduction plus trunk list. Use proper setup/hold timing and expose substitutions. | Ten-second legacy holds need actual loaded single-foot support and loss-of-balance events. Closing rendered eyelids does not simulate removal of visual feedback. |
| Overhead Deep Squat — legacy SFMA | Legacy feet-together overhead setup without bar → squat and hold → stand. | Currently shares FMS `buildSquat` and overhead override. Retain the legacy ID but use its own stance/equipment intent. | FMS native bar-grasp trial does not validate this task. Current Arms Down Deep Squat must be added/versioned separately after its procedure is confirmed. |

## Shared implementation decisions

At audit start, [`positions.ts`](../src/screen/positions.ts) reports 16/20 mapped
entries. That number means only that a source exists. Four are unposed; several
mapped sources are the wrong movement. The inventory must distinguish:

1. **Editable route:** correct named setup, side, assessed phase and return are
   available, visible and savable.
2. **Physical trial:** that route can be followed by a compatible native body
   with actual supports, forces, contacts, limits and bounded active effort.
3. **Reference agreement:** anatomy and movement measurements have independent
   evidence for the intended protocol and person conditions.

The existing [`PhysicsWorkflow`](../src/editing/PhysicsWorkflow.svelte) dispatches
only ASLR and squat trials. Preset grounding, joint interpolation and COM overlays
can help author all routes but do not create a new native support family.
The newer squat controller has active balance feedback and verified local routes;
its disturbance recovery is still limited. Existing reach R&D is likewise a
regional experiment. Preserve those distinctions when surfacing recipe readiness.
See [active squat stabilization](archive/squat-active-stabilization.md),
[movement acceptance](archive/movement-acceptance.md), and
[authored compatibility audit](archive/authored-compatibility-audit.md).

Two dispatch defects cut across multiple movements:

- The generic template branch of `composeFor` did not use `side`. Selecting left
  can replay a right-leading or two-sided clip unchanged. Bilateral tests need
  side-specific output, anatomical sign handling and a documented side meaning.
- `holdAtAssessedPosition` selected the first positive `holdMs`, despite its
  comment saying the largest hold. Neither heuristic expresses the actual test
  phase. Recipe metadata should explicitly name the assessed frame; approach,
  contact and recovery waypoints must not be mistaken for the target.

## Priorities and acceptance for this pass

**First: repair authored coverage.** Replace the incorrect substitutions, add the
four missing reach routes, provide explicit setup/assessed/return roles and side
semantics, and keep existing authoring edits and library versions. The user should
select a task and immediately inspect a plausible complete route without manually
reconstructing its starting position. No native failure should prevent pose
preview of an unsupported family.

**Then: exercise the shared movement families.** Reuse ASLR and squat as physical
regressions; next qualify loaded standing trunk/unilateral support, then hand/knee
floor tasks, then the expanded two-arm reach tasks. Hurdle/board/palm contacts must
carry forces before their physical results are trusted. Posture labels and prop
meshes alone are insufficient.

For every route, check both models, both assessed sides where applicable, neutral
setup, correct support context, explicit equipment presence/absence, target
selection, retained return, and saved-route replay. Inspect front/side/back views
and intermediate frames. Add targeted geometry checks for the known defects
(straight knees in MS flexion, no bar in free overhead tasks, complete rotary
phases, correct side, prone-start push-up), not tests that simply mirror every
authored joint constant.

Native qualification additionally requires measured contact, balance, torque,
numerical tolerances and return success over the full time series, including a
limited-range case and a bounded unsuccessful attempt. Reference validation and
current protocol migration remain separate work; passing a generated route or
browser smoke test does not complete them.

## Updated requirement: every movement needs a physical attempt

The user subsequently clarified that physics must be involved in **all twenty
movements**. Editable guides alone do not fulfill that request. The next delivery
is a physically integrated attempt for every entry, with actual gravity, contact,
bounded motor effort, measured achieved motion and replayable evidence. An
unreachable endpoint or failed balance recovery can be an honest simulated
outcome; an unsupported dispatch, missing controller, or kinematic playback
presented as physics cannot.

The 64-context authoring regression and follow-up camera checks establish usable
routes to drive those attempts. They must not be reported as 64 physical trials.
See [workflow evidence](../.validation.local/assessment-library/report.md) and
[visual review](../.validation.local/assessment-library/visual-review.md).

The following hardcoded gates were verified before extending native dispatch:

| Layer | Gate or assumption | Required change for actual full coverage |
| --- | --- | --- |
| `EditingWorkspace.svelte` | `physicsFor` recognizes ASLR, FMS squat, and old SFMA captures containing a bar. Iframe creation and physical comparison UI depend on this result. | Resolve an explicit physical task/capability for all twenty entries; preserve the original assessment ID independently of backend family. |
| `PhysicsWorkflow.svelte` | `kind` is only `aslr` or `squat`; every squat frame requires an identically sized bar. All non-squat condition descriptions assume ASLR hip stops and capacities. | Use declared equipment requirements and family-appropriate conditions. Do not classify a free-standing or prone task as a squat merely to unlock the button. |
| `automatic-support.mjs` | Same assessment whitelist; accepts standing/supine only, rejects visual support boxes, requires the squat bar, and treats lost heel/foot support as failure. | Dispatch the correct support task and distinguish intended contact release from loss of support. A hand/knee or torso-supported task cannot use a feet-only acceptance rule. |
| `viewer.mjs` | Movement options, context matching and condition parsing only accept ASLR/squat. Requested `both` side is collapsed to an internal right-side setting outside squat. | Validate an explicit new task family while preserving authored side identity. Keep origin, request ID, revision and source fingerprints checked. |
| `authored-movement-route.mjs` | `coverage` whitelists only three assessment IDs. Squat conversion requires equipment; ASLR rejects it. Baseline selection is neutral versus overhead by that binary kind. | Pass declared source baseline and equipment policy through preparation and conversion; audit the whole route before installation. |
| `authored-squat-preference.mjs` | Consumer binding and coverage validation only admit squat/ASLR; overhead provenance is inferred from `movement === 'squat'`. | Extend an explicit source-bound consumer contract without dropping asset, fixture, canonical-bone, scale or rotation validation. |
| `model.mjs` | Model options reject any movement outside ASLR/squat; topology/controller/support assumptions follow that binary choice. | Create a general articulated body attempt with task-specific support and actuator configuration, preserving the existing verified specialized regressions. |
| `authored-route-packet.mjs` | Every authored support box is rejected. Physical settings contain only preset, assisted flag, topology and controller version; body-position validation contains three legacy assessment requirements. | Represent actual supported contact geometry and task parameters in canonical request identity. A UI-only field must not silently disappear from the physics hash. |
| Viewer observations and saved history | Generic panels fall through to ASLR measurements; squat panels label non-foot contact as failure. Intent landmarks omit hands in the ASLR branch. | Report generic achieved joint/root/landmark tracking and actual contact sets first, then task-specific observations. Preserve failed attempts and missing measurements explicitly. |
| `movement-editor.mjs::applyPhysicalSnapshot` | Expected transform set and required equipment depend on squat versus anatomical ASLR. | Apply only the declared native model's complete finite transform set. Optional equipment must stay optional; no pose overwrite may masquerade as integrated native motion. |

The route/condition/binding/controller fingerprint checks and the distinction
between `executionCompleted`, `physicalAcceptance` and endpoint agreement should
remain. The change is to supply a real supported physical consumer for each task,
not to bypass those checks. Force and contact results need to be visible even
when the attempt fails, so the user can improve the authored route using the
actual model response.

## Implemented pass: source routes and physical attempts

The new source library now supplies setup, assessed target, intermediate stages,
holds and return for all twenty core entries. The existing ASLR and FMS squat
routes retain their specialized consumers. The legacy SFMA squat now has a
separate narrow-stance, bar-free source; this preserves its recorded protocol
version rather than relabeling it as the current arms-down procedure.

The authoring sweep passed **64/64 model/side contexts**, including source
creation, visibly different targets, preview, restoration and representative
library save/reload checks. The initial squat/ASLR camera warnings were corrected
and their six contexts passed reruns. These are authoring checks, not simulated
movement acceptance. Remaining visual reference issues include approximate
clearing arm placement, rotary support-chain fitting, lunge foot support through
the target, missing hurdle/board contact geometry and individual ROM variation.

`AssessmentPhysics.svelte` now connects the additional movements to the actual
`movement: 'assessment'` native body. It uses the verified route, mannequin,
condition and controller fingerprints; initializes the fitted setup once; then
integrates gravity, native rigid-floor contact and bounded joint motors. The
signed initial vertical floor fit is measured separately. It is not a continuing
root assignment or a guarantee that every desired support point can touch.

The central portrait shows live native states while calculating, then replays
recorded achieved states. Users can switch to the entire intended route, even
after the physical attempt stops early. Physical measurements remain explicitly
held at their last actual state beyond that time. Reference and 55% active
capacity conditions are available. Saved evidence contains hashes, actual
duration, contact/tracking summaries, initial fitting and stops; it does not
duplicate every source or replay frame.

Two complete browser workflows with controller
`authored-pelvis-support-torque-v10` passed: cervical flexion and rotary stability.
They check actual native time advancement, visible physical/intended switching,
scrubbing, exact authored-pose protection, leaving the physics panel, condition
changes, cancellation and local evidence reload. Cervical flexion also checks
that recording capture restores the authored body before export, and that camera
changes remain available while pose getters protect the original. See
[physical workflow evidence](../.validation.local/assessment-physics-ui-v10/results.json).

Six runner lifecycle tests cover early native stops, zero-advance terminal
states, cancellation, mismatched route identity, partial worker errors and
initial-only evidence. Transport or rendering interruptions remain distinct
from measured native physics failures. Eleven native backend tests exercise
general standing and floor-supported initialization/control. The separate final
58-context matrix executed every case at the live 2 ms timestep: 30 reached the
requested duration, 28 stopped at measured native gates, and none threw runtime
exceptions. All retained finite state, motor caps and source timing. See the
[full physics results and next work](assessment-physics-results.md). These counts
do not qualify the completed routes' endpoints or the stopped routes' support.

The native scope currently excludes body-to-body collision, independent finger
forces, calibrated deformable skin, most equipment and clinical acceptance.
Native numerical completion does not establish endpoint fidelity, correct task
support, balance recovery or a clinical score. The physical results now provide
the measured feedback needed to refine those routes, instead of stopping at an
unsupported UI dispatch or presenting their interpolated guides as physics.
