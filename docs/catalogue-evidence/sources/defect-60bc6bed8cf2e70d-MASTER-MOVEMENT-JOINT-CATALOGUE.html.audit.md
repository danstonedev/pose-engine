# Movement coordination inventory — 2 October 2026

The [catalogue](movement-joint-catalogue.md) inventories every one of the current **209 simLAB Movement lab entries**, plus the engine template library. The [JSON](movement-joint-inventory.json) retains every target channel and its commanded range, constant-versus-changing targets, body-control declarations, foot contacts, limitations and source hashes. Applicable left/right settings and male/female/neutral construction are included. This is a source-definition audit; those body contexts do not imply that their actual skeletons have been sampled or their skin reviewed.

The definitions include examination setup and return targets. A named bone is not necessarily moving: a constant zero can stabilize it. Conversely, an unnamed bone can move with its parent, through shoulder coupling, IK, spinal distribution, balance assistance or collision clearance. The catalogue therefore separates explicit bones from implicit shoulder proxies. It must not be read as a measured list of every deforming skin bone.

## Complete modeled axial chain

The [spine participation catalogue](spine-participation-catalogue.md) now accounts for **Hips → Spine_Lower → Spine_Mid → Spine_Upper → Neck_Lower → Neck → Head** in every movement, including segments absent from direct targets. Each context in the JSON and main catalogue records changing targets, constant targets, derived companions, declared control roles, or an unspecified independent role requiring runtime verification. Missing targets do not prove that a segment stays still or is stabilized.

In the current Character Creator mapping these correspond to Hip, Waist, Spine01, Spine02, NeckTwist01, NeckTwist02 and Head. These are regional rig segments, not one joint per vertebra. The inventory also lists every ROM-registry control and its available channels in `modeledJointControls`; registry controls do not cover every deformation/helper bone or every anatomical articulation.

Source-confirmed coordination limitations relevant to the reported spinal appearance:

- Thoracic flexion, side-bending and rotation split equally between Spine_Upper and Spine_Mid when the baseline includes the companion bone; a partial baseline keeps the command on the upper bone. This is a fixed regional distribution, not measured vertebral motion.
- Cervical flexion splits equally across the two neck segments. Protraction uses opposed lower/upper flexion. Cervical rotation and side-bending currently command the upper Neck segment without the same lower-neck companion distribution.
- Head has no independent ROM command in this path. Some functional recipes explicitly hold its entry orientation relative to the cervical region; other definitions leave its independent role unspecified. Neither condition establishes task-appropriate world-space gaze.
- SFMA Multi-Segmental Flexion commands lumbar 40°, thoracic 35° and cervical 20° at its reach phase, alongside bilateral hip flexion. It has no independent Hips target or Head control declaration. Pelvic/root positioning and inherited head motion therefore require examination on the actual trajectory; hip targets alone do not establish coordinated pelvic articulation.

The spine must be reviewed as a coordinated pelvis-to-head chain: curvature distribution, pelvic contribution, sequencing, gaze, shoulder attachment, setup and return. More named targets or equal splits alone do not establish anatomical quality. No source-definition finding here is a Blender visual review or a movement correction.

## Joint and bone interpretation

| Runtime key (L/R where applicable) | Anatomical region / participating structures | Coordination to review |
|---|---|---|
| Shoulder | Clavicle-based shoulder-girdle proxy; intended contribution of clavicle and scapula | SC/AC contributions and scapulothoracic movement are not independently represented; review upward rotation, tilt, protraction and humeral rotation together |
| UpperArm | Humerus; glenohumeral / humerothoracic task | Girdle contribution, axial rotation, elbow direction, trunk-relative arm orientation |
| Forearm | Elbow and forearm; radius/ulna region | Elbow flexion plus pronation/supination; not an independently articulated radius and ulna |
| Hand | Wrist and hand root; distal radius/ulna and carpal region | Palm orientation, wrist flexion/deviation, grip/support |
| Thumb1… / finger keys | Thumb/digit phalangeal chains and proximal controls | Finger descendants, thumb opposition, contact surface; inspect actual mappings before assigning individual anatomical joints |
| Hips | Pelvic root | Independent pelvic tilt/rotation versus whole-body root motion, hip/spine coordination |
| UpLeg | Femur / hip | Hip flexion, abduction, axial rotation and pelvis participation |
| Leg | Tibia/fibula region / knee | Knee flexion and rotation, knee direction, ankle and hip coupling |
| Foot | Ankle/hindfoot proxy | Tibial progression, plantar/dorsiflexion, inversion/eversion, support timing |
| Toes | Forefoot/toe proxy | Toe rollover/support; not independently modeled metatarsal and phalangeal anatomy |
| Spine_Lower | Lumbar region | Distributed curvature and pelvic contribution rather than a single rigid hinge |
| Spine_Mid / Spine_Upper | Thoracic region | Distributed thoracic movement and shoulder support; implicit companion distribution can add motion |
| Neck / head descendants | Cervical and head region | Gaze and cervical coordination, head clearance throughout transitions |

These mappings describe rig regions, not a validated anatomical segmentation. Bones downstream of a control remain participants even when their local transform is unchanged.

## Confirmed shoulder discrepancy

The current `pose-engine/src/services/movementCommand.ts` uses `girdleSplit` for both elevation planes. Flexion drives the proxy's `scapularTilt`; abduction drives `upRotation`. The setting thresholds are 60° flexion and 30° abduction, with a 2:1 split of the subsequent excursion, a nominal 120° humeral ceiling, and different proxy ceilings (40° tilt, 60° upward rotation).

At the lab's default 180° flexion endpoint the function yields **140° humeral + 40° proxy**; at 180° abduction it yields **120° + 60°**. The source explicitly documents the 20° flexion overdraft. This is a confirmed implementation asymmetry and a candidate explanation for the reported distortion. It does not prove the screenshot's exact cause. A tilt-only sagittal proxy cannot be assumed to reproduce a scapula's three-dimensional movement simply because the measured arm endpoint is correct.

The isolated lab entries author elevation and neutral hip/knee targets; they do not explicitly coordinate humeral axial rotation, elbow, forearm, wrist or trunk channels. Shared coupling supplies the girdle. The catalogue flags these implicit contributors so an absent explicit Shoulder target is not mistakenly labeled absent rhythm.

The SFMA Multi-Segmental Flexion definition already names shoulders' upper-arm controls, forearms, hands, spine, neck, hips' thigh controls, knees, ankles and toes. Its visible failure therefore requires examining orientations, coupling and inherited transforms; adding more bone names alone would not establish a correction.

## Required coordination review by movement family

Apply these review requirements to every corresponding catalogue row. They are proposed authoring checks, not findings that each joint must move in every task.

| Family | Moving and stabilizing participants to account for |
|---|---|
| Shoulder elevation / reach / SFMA upper-extremity patterns | Clavicle/scapular proxy, humerus axial rotation and elevation, elbow, forearm, wrist, hand, thoracic support, cervical/head orientation; avoid imposing compensatory trunk movement on an isolated ROM task |
| Elbow / forearm / wrist / digits | Proximal arm/girdle stabilization, forearm orientation, wrist/digit descendants and palm direction; fingers should not inherit implausible twists |
| Neck / thoracic / lumbar / multisegmental trunk | Pelvis, distributed lumbar/thoracic/cervical regions, head, arms, hips, knees, ankle/foot support; distinguish intentional multisegmental motion from isolated testing |
| Squat / lunge / hurdle / single-leg stance | Pelvis and bilateral hips, knee bend direction, ankle/foot/toes, trunk/head, arms for balance, planted versus unloaded foot timing |
| Gait / run / gait deviations | Bilateral pelvis/hip/knee/ankle/toe timing, trunk counterrotation, contralateral arm/forearm/girdle motion, head stability, support transitions and root travel |
| Transfers / rolling / floor setup | Pelvis/root orientation, spine/head, both limb chains, seat/floor contact anchors, elbow/knee guides, setup/return continuity |
| Push-up / quadruped / prone extension | Palm/wrist/forearm/elbow/humerus/girdle chain, trunk/pelvis/head, knee/foot support, full skin contact; bone clearance alone is insufficient |
| Jump / hop / landing | Hip/knee/ankle/toe sequencing, pelvis/trunk, arm preparation and recovery, head, takeoff/flight/landing support events |
| ROM / strength / special tests | Tested joint plus position-specific pelvic/trunk and adjacent-limb stabilization; examiner/equipment contact; passive/resisted labels do not establish simulated force fidelity |
| Sensory / palpation / reflex | Setup-support participants and any reflex excursion; static patient joints can be appropriate. Examiner/contact motion is separate from patient movement |

## Priority and acceptance

1. Reproduce isolated shoulder flexion and abduction in matched views and record girdle/humeral quaternions, axial rotation and skin throughout both sides and all three rigs. Trace any later solver overwrite and compare interactive versus composed playback.
2. Review the demonstrated SFMA forward bend with trunk-relative arm orientation, inherited humeral twist, elbow direction and shoulder skin. Keep source identities matched to the isolated comparison.
3. Expand the same measurements to reaches, overhead squat, upper-extremity screens and loaded palm support before generalizing a shoulder correction.
4. Use the family requirements above to qualify all remaining catalogue rows, explicitly accounting for stabilizers and head/neck.

Before changing motion, use the standing Blender workflow and define trajectory gates: endpoint fidelity, humeral/girdle capacity, orientation continuity, full skin clearance, support and both-host agreement. Independent scapular anatomy and native tracking acceptance remain separate requirements. No runtime motion, limits, assets or physics were changed by this inventory.

## Reproduction and scope

From `movement-realism-implementation/simlab` in PowerShell:

```powershell
$env:MOVEMENT_INVENTORY_OUT='C:/Users/danst/probonoEMR/movement-realism-implementation/remaining-batches/movement-inventory-2026-10-02'
node node_modules/vitest/vitest.mjs run packages/ddx/src/__tests__/movementInventory.test.ts --maxWorkers=1
```

The executed diagnostic passed. It checks unique catalogue IDs, successful motion construction for every context and finite target ranges. It covers default settings, not the Cartesian product of severity, pain, speed, equipment, impairment or arbitrary user-composed motion. Custom saved poses, examiner skeleton animation, skin helper deformation and native-controller-only tasks are outside the 209-entry definition inventory. The JSON preserves current dirty-source hashes; it should be regenerated after edits. No visual, clinical or native acceptance is claimed.
