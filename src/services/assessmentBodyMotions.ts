/**
 * The FMS and SFMA assessment motions for the whole body — hurdle step, in-line
 * lunge, rotary stability, the trunk stability push-up, the clearing tests, the
 * multi-segmental patterns, single-leg stance and the legacy SFMA overhead squat.
 *
 * Moved here verbatim from simMOVE (`src/screen/assessment-body-motions.ts`) so
 * simMOVE and simLAB play the same patterns; `movementScreen.ts` is the front
 * door. simMOVE is still where these movements are authored, physics-checked and
 * signed off, and a change here changes what both apps play and the routes
 * simMOVE's editor generates from them.
 */
import type { ComposedMotion, SequenceKeyframe, SequenceTarget } from './motionSequence';
import { overheadSquatTargets } from './overheadSquat';
import { stepIntoStandingStance } from './stanceTransition';
import { buildBirdDog, buildPushUp } from './movementPostures';
import { supportedBodyTargets } from './upperSupportRecipes';
import { floorPalmSupports } from './floorPalmSupports';

type Side = 'R' | 'L';
const opposite = (side: Side): Side => side === 'R' ? 'L' : 'R';
const target = (joint: string, motion: string, targetDegrees: number): SequenceTarget => ({ joint, motion, targetDegrees });
const leg = (side: Side, hip: number, knee: number, ankle = 0): SequenceTarget[] => [
  target(`${side}_UpLeg`, 'hipFlexion', hip), target(`${side}_Leg`, 'kneeFlexion', knee), target(`${side}_Foot`, 'ankleFlexion', ankle),
];
const trunk = (lumbar = 0, thoracic = 0): SequenceTarget[] => [
  target('Spine_Lower', 'flexion', lumbar), target('Spine_Upper', 'flexion', thoracic),
  target('Spine_Lower', 'rotation', 0), target('Spine_Upper', 'rotation', 0),
  target('Spine_Lower', 'lateralTilt', 0), target('Spine_Upper', 'lateralTilt', 0), target('Neck', 'flexion', 0),
];
const arms = (elevation = 0, elbow = 0, motion = 'shoulderFlexion'): SequenceTarget[] => ['R', 'L'].flatMap(side => [
  target(`${side}_UpperArm`, motion, elevation), target(`${side}_Forearm`, 'elbowFlexion', elbow), target(`${side}_Hand`, 'wristFlexion', 0),
]);
const standing = (): SequenceTarget[] => [
  ...leg('R', 0, 0), ...leg('L', 0, 0), ...arms(), ...trunk(),
  ...['R', 'L'].flatMap(side => [target(`${side}_UpLeg`, 'hipAbduction', 0), target(`${side}_UpLeg`, 'hipRotation', 0), target(`${side}_Toes`, 'toeFlexion', 0)]),
];
/** A replacement arm recipe owns the complete humeral command group. The
 * shared atomic composer combines its elevation, axial rotation and girdle. */
function withTargets(base: SequenceTarget[], changes: SequenceTarget[]): SequenceTarget[] {
  changes = [...new Map(changes.map(item => [`${item.joint}|${item.motion}`, item])).values()];
  const replaced = new Set(changes.map(item => `${item.joint}|${item.motion}`));
  const shoulders = new Set(changes.filter(item => item.joint.endsWith('_UpperArm')).map(item => item.joint));
  return [...base.filter(item => !replaced.has(`${item.joint}|${item.motion}`) && !shoulders.has(item.joint)), ...changes];
}
const frame = (targets: SequenceTarget[], durationMs: number, extra: Partial<SequenceKeyframe> = {}): SequenceKeyframe => ({ durationMs, stance: 'planted', targets, ...extra });
const motion = (name: string, keyframes: SequenceKeyframe[], posture: 'standing' | 'prone' | 'quadruped' = 'standing'): ComposedMotion => ({ name, startFrom: 'neutral', stance: 'planted', startPosture: posture, endPosture: posture, keyframes });

function hurdleStep(side: Side): ComposedMotion {
  const shift=opposite(side)==='L'?.09:-.09,root={translateM:[shift,0,-.035] as [number,number,number]};
  const setup = withTargets(standing(), arms(85, 95, 'shoulderAbduction'));
  const clearance = withTargets(setup, leg(side, 80, 105, 15));
  const cross = withTargets(setup, leg(side, 65, 40, 15));
  const heel = withTargets(setup, leg(side, 22, 3, 20));
  return { ...motion(`Hurdle step · ${side} stepping leg`, [
    frame(setup, 800,{root:{translateM:[0,0,0]}}), frame(setup, 650,{root}), frame(clearance, 900,{root}), frame(cross, 800,{root}),
    frame(heel, 900, { root,holdMs: 1400 }), frame(clearance, 1100,{root}), frame(setup, 1100,{root:{translateM:[0,0,0]}}),
  ]), contacts: [{ foot: `${opposite(side)}_Foot` }] };
}

function inlineLunge(side: Side): ComposedMotion {
  const rear = opposite(side);
  const setup = withTargets(standing(), [
    // Ankle flexion cancels the split hip pitch at setup; matching signs
    // incorrectly left the lead sole about eight centimetres above the floor.
    ...leg(side, 20, 0, -20), ...leg(rear, -20, 0, 20),
    target(`${side}_UpLeg`, 'hipAbduction', -5), target(`${rear}_UpLeg`, 'hipAbduction', -5),
    target(`${rear}_Toes`, 'toeFlexion', 20),
    target(`${side}_UpperArm`, 'shoulderAbduction', 155), target(`${side}_Forearm`, 'elbowFlexion', 125),
    target(`${rear}_UpperArm`, 'shoulderFlexion', -25), target(`${rear}_Forearm`, 'elbowFlexion', 105),
  ]);
  const down = withTargets(setup, [...leg(side, 75, 90, 15), ...leg(rear, -10, 105, 35), target(`${rear}_Toes`, 'toeFlexion', 40)]);
  return { ...motion(`In-line lunge · ${side} foot forward`, [
    frame(setup, 900), frame(withTargets(setup, [...leg(side, 45, 50, 12), ...leg(rear, -10, 55, 25)]), 900),
    frame(down, 1100, { holdMs: 1600 }), frame(setup, 1400),
  ]), contacts: [{ foot: `${side}_Foot`, fromMs: 900 }, { foot: `${rear}_Foot`, fromMs: 900 }] };
}

function rotaryStability(side: Side): ComposedMotion {
  const reference = buildBirdDog({ side });
  const setup = withTargets(reference.keyframes[0].targets ?? [], trunk());
  const raised = withTargets(setup, [
    target(`${side}_UpperArm`, 'shoulderAbduction', 160), target(`${side}_Forearm`, 'elbowFlexion', 5), target(`${side}_Hand`, 'wristFlexion', 0),
    ...leg(side, 5, 5, -35),
  ]);
  const touch = withTargets(setup, [
    target(`${side}_UpperArm`, 'shoulderFlexion', 80), target(`${side}_Forearm`, 'elbowFlexion', 130), target(`${side}_Hand`, 'wristFlexion', 0),
    ...leg(side, 120, 125, -35),
  ]);
  const root = { orient: { pitchDeg: 90 } }, grounding = opposite(side) === 'L' ? 'quadruped-hand-L' : 'quadruped-hand-R';
  return motion(`Rotary stability · ${side} arm and leg`, [
    frame(setup, 900, { root, groundingPosture: grounding }),
    frame(raised, 1400, { root, groundingPosture: grounding, holdMs: 350 }),
    frame(touch, 1400, { root, groundingPosture: grounding, holdMs: 1800 }),
    frame(raised, 1100, { root, groundingPosture: grounding }),
    frame(setup, 1200, { root, groundingPosture: grounding }),
  ], 'quadruped');
}

function trunkPushUp(): ComposedMotion {
  const reference = buildPushUp({ reps: 1 }), bottom = withTargets(reference.keyframes[1].targets ?? [], trunk()), top = withTargets(reference.keyframes[2].targets ?? [], trunk());
  return { ...motion('Trunk stability push-up · whole-body press', [
    frame(bottom, 1000, { root: { orient: { pitchDeg: 90 } }, groundingPosture: 'plank' }),
    frame(top, 1500, { root: { orient: { pitchDeg: 76 } }, groundingPosture: 'plank', holdMs: 1600 }),
    frame(bottom, 1500, { root: { orient: { pitchDeg: 90 } }, groundingPosture: 'plank' }),
  ], 'prone'), startAtSetup: true, fixedGroundSupports: ['L_Toes', 'R_Toes'],
  contacts: floorPalmSupports('trunk-push-up', 1000) };
}

function extensionClearing(): ComposedMotion {
  // Ground the measured anterior pelvis and coordinate humeral abduction with
  // external rotation so the folded forearms clear the floor at setup.
  // A foot-height pin with dorsiflexed ankles left the trunk airborne
  // and introduced a floor impact at the beginning of native playback.
  // Palm orientation and the assessed endpoint still need separate qualification.
  const setup = withTargets(standing(), [...arms(35, 100, 'shoulderAbduction'), target('R_UpperArm', 'shoulderRotation', -45), target('L_UpperArm', 'shoulderRotation', -45), ...leg('R', 0, 0, -45), ...leg('L', 0, 0, -45), target('R_Hand', 'wristFlexion', -45), target('L_Hand', 'wristFlexion', -45)]);
  const chestUp = withTargets(setup, [...trunk(-20, -15), ...arms(140, 10), target('Neck', 'flexion', -10), target('R_Hand', 'wristFlexion', -45), target('L_Hand', 'wristFlexion', -45)]);
  return { ...motion('Spinal extension clearing · prone chest press', [
    frame(setup, 1000, { posture: 'prone', groundingPosture: 'prone-supported' }),
    frame(chestUp, 1500, { posture: 'prone', groundingPosture: 'prone-supported', holdMs: 1600 }),
    frame(setup, 1300, { posture: 'prone', groundingPosture: 'prone-supported' }),
  ], 'prone'), startAtSetup: true, fixedGroundSupports: ['Hips'],
  contacts: floorPalmSupports('press-up', 1000) };
}

function flexionClearing(): ComposedMotion {
  // Rock the pelvis back over fixed knees and reach through the shoulders.
  // Blender-authored palm anchors and elbow guides retain the support layout
  // through the complete approach and return; the clinical knee cap still applies.
  const setup = supportedBodyTargets(trunk(), 'quadruped', 0);
  const back = withTargets(setup, [...leg('R', 120, 140, -45), ...leg('L', 120, 140, -45), ...arms(160, 5), ...trunk(20, 20), target('R_Hand', 'wristFlexion', -35), target('L_Hand', 'wristFlexion', -35)]);
  const root = { orient: { pitchDeg: 90 } };
  return { ...motion('Spinal flexion clearing · hips back and reach', [
    frame(setup, 1000, { root, groundingPosture: 'quadruped' }),
    frame(back, 1600, { root: { orient: { pitchDeg: 70 } }, groundingPosture: 'quadruped', holdMs: 1800 }),
    frame(setup, 1400, { root, groundingPosture: 'quadruped' }),
  ], 'quadruped'), startAtSetup: true, fixedGroundSupports: ['L_Leg', 'R_Leg'],
  contacts: floorPalmSupports('rock-back', 1000) };
}

function multisegmentalFlexion(): ComposedMotion {
  const setup = standing(), reach = withTargets(setup, [...leg('R', 85, 0), ...leg('L', 85, 0), ...trunk(40, 35), ...arms(85), target('Neck', 'flexion', 20)]);
  return motion('Multi-segmental flexion · straight-knee toe reach', [
    frame(setup, 800), frame(withTargets(setup, [...leg('R', 35, 0), ...leg('L', 35, 0), ...trunk(15, 10), ...arms(35)]), 900),
    frame(reach, 1200, { holdMs: 1800 }), frame(setup, 1500),
  ]);
}

function multisegmentalExtension(): ComposedMotion {
  const setup = withTargets(standing(), arms(160, 0, 'shoulderAbduction'));
  const back = withTargets(setup, [...leg('R', -12, 0, 10), ...leg('L', -12, 0, 10), ...trunk(-20, -15), target('Neck', 'flexion', -15)]);
  return motion('Multi-segmental extension · arms overhead', [
    frame(setup, 1000), frame(back, 1600, { holdMs: 1800 }), frame(setup, 1600),
  ]);
}

function multisegmentalRotation(side: Side): ComposedMotion {
  const setup = withTargets(standing(), [target('Neck', 'rotation', 0), target('Hips', 'rotation', 0)]), sign = side === 'L' ? 1 : -1;
  const turn = withTargets(setup, [
    target('R_UpLeg', 'hipRotation', -sign * 35), target('L_UpLeg', 'hipRotation', sign * 35),
    target('Hips', 'rotation', sign * 30),
    target('Spine_Lower', 'rotation', sign * 10), target('Spine_Upper', 'rotation', sign * 30),
    target('Neck', 'rotation', 0),
  ]);
  return { ...motion(`Multi-segmental rotation · ${side}`, [frame(setup, 800), frame(turn, 1800, { holdMs: 1800 }), frame(setup, 1600)]), contacts: [{ foot: 'R_Foot' }, { foot: 'L_Foot' }] };
}

function singleLegStance(side: Side): ComposedMotion {
  const setup = standing(), support = opposite(side), shift = support === 'L' ? .09 : -.09;
  const lifted = withTargets(setup, [...leg(side, 90, 90, 0), target(`${side}_UpLeg`, 'hipAbduction', -5)]);
  return { ...motion(`Single-leg stance · ${side} knee raised`, [
    frame(setup, 800, { root: { translateM: [0, 0, 0] } }),
    frame(setup, 3000, { root: { translateM: [shift, 0, -.04] } }),
    frame(lifted, 3000, { root: { translateM: [shift, 0, -.04] }, holdMs: 10000 }),
    // Re-establish the lowered foot before moving the pelvis back between
    // both feet. Recapturing the start directly asks for lateral travel while
    // the returning leg is still airborne.
    frame(setup, 3000, { root: { translateM: [shift, 0, -.04] } }),
    frame(setup, 3000, { root: { translateM: [0, 0, 0] } }),
  ]), contacts: [{ foot: `${support}_Foot` }, { foot: `${side}_Foot`, toMs:3800 }, { foot: `${side}_Foot`, fromMs:19800,reuseInitialAnchor:true }] };
}

/** Legacy overhead SFMA protocol: shoulder-width feet and an overhead Y,
 * distinct from the current arms-down test and the FMS dowel squat.
 * Protocol: https://pmc.ncbi.nlm.nih.gov/articles/PMC4004125/ (Appendix A).
 */
function legacySfmaOverheadSquat(): ComposedMotion {
  const setup = overheadSquatTargets(standing(), false);
  const entry = stepIntoStandingStance(setup);
  const approach = overheadSquatTargets(withTargets(setup, [...leg('R', 57.5, 66.5, 17.5), ...leg('L', 57.5, 66.5, 17.5), ...trunk(10.5, 3.5)]), false);
  const squat = overheadSquatTargets(withTargets(setup, [...leg('R', 115, 133, 35), ...leg('L', 115, 133, 35), ...trunk(21, 7), target('Neck','flexion',-8)]), false);
  return { footSupportSetup: true, ...motion('Legacy SFMA overhead deep squat · shoulder-width stance · no dowel', [
    ...entry.keyframes, frame(approach, 1000), frame(squat, 1500, { holdMs: 1800 }), frame(setup, 1800),
  ]), contacts: entry.contacts };
}

/** Repository assessment-specific, editable kinematic sources. These do not
 * operate the native squat/ASLR controllers or grant movement acceptance. */
export const BODY_ASSESSMENT_MOTIONS: Record<string, (side: Side) => ComposedMotion> = {
  'hurdle-step': hurdleStep, 'in-line-lunge': inlineLunge, 'rotary-stability': rotaryStability,
  'trunk-stability-push-up': trunkPushUp, 'extension-clearing': extensionClearing, 'flexion-clearing': flexionClearing,
  'multisegmental-flexion': multisegmentalFlexion, 'multisegmental-extension': multisegmentalExtension,
  'multisegmental-rotation': multisegmentalRotation, 'single-leg-stance': singleLegStance,
  'sfma-overhead-deep-squat-legacy': legacySfmaOverheadSquat,
};

export const BODY_ASSESSMENT_NOTES: Record<string, string[]> = {
  'hurdle-step': ['The selected leg lifts, advances beyond the clearance position, lowers toward heel touch and clears the same route on return.', 'Hurdle height/contact and the across-shoulder dowel are not represented by this pose source; adjust apparatus and verify heel contact on the actual mannequin.'],
  'in-line-lunge': ['The selected foot starts forward in a narrow split stance and returns to that stance. Setup sole heights differ by at most 1.8 cm on the current mannequins.', 'The fixed ankle-point source still leaves a 6–8 cm sole-height difference at the assessed pose after skin grounding. Rear heel/toe support and knee touch therefore require editing; this source does not establish a physically supported lunge. Tibia-length spacing, board width and three dowel contacts also require source-specific placement; hands approximate a behind-back dowel grip.'],
  'rotary-stability': ['The selected arm and leg extend together, then bring the elbow and knee toward one another; the opposite hand supports the reference.', 'The source elbow and knee joint centers remain about 29–35 cm apart at closest approach. Contact and board alignment are not solved; the opposite-side compensation is a separate authored variation.'],
  'trunk-stability-push-up': ['Starts and returns prone; the press lifts the trunk and legs together on the existing hand/toe grounding path.', 'The prescribed thumb height differs by model/test condition and requires adjustment. Hand contact, spinal lag and strength are not accepted by kinematic playback.'],
  'extension-clearing': ['A prone chest press extends the lumbar and thoracic regions while the legs remain extended; the return is prone.', 'The palms advance about 27 cm during this reference press; their contact is not fixed. Pelvis contact also requires review. Pain is reported by the participant and cannot be inferred from this animation.'],
  'flexion-clearing': ['Starts and returns on hands and knees, bringing the hips back with deeper knee/hip flexion and an overhead reach.', 'A heel-to-pelvis gap remains under the hip range bound, and the arms bend to retain palm contact. The rig uses geometric grounding; pain is not inferred.'],
  'multisegmental-flexion': ['Combines bilateral hip flexion with lumbar and thoracic flexion while keeping the knees straight.', 'The source wrists finish about 17–22 cm above the floor with a lateral offset. Feet-together placement and fingertip-to-toe contact require review; this reference does not establish the criterion.'],
  'multisegmental-extension': ['The reference starts with both arms overhead and combines hip, lumbar and thoracic extension.', 'Pelvis-to-toe and shoulder-to-heel relationships must be checked on the actual body. Balance is not established by this kinematic source.'],
  'multisegmental-rotation': ['The selected turn combines bounded pelvic, hip, lumbar and thoracic rotation while both feet stay at the setup contacts.', 'The source pelvis command is limited to 30 degrees; it does not establish the 50-degree pelvis criterion. The opposite direction is a separate selected-side attempt.'],
  'single-leg-stance': ['Transfer weight for three seconds, raise the selected knee toward hip height over three seconds, hold for ten seconds, lower the leg over three seconds, then return the pelvis between both feet over three seconds. The arms stay at the sides.', 'Transfer and return timing are editable engineering defaults. Eyes-open and eyes-closed are separate case conditions; this source does not animate vision. Source foot contacts guide authoring; Test & vary measures the actual native hold and return.'],
  'sfma-overhead-deep-squat-legacy': ['Legacy SFMA overhead version: step each foot into a shoulder-width stance, raise straight arms in an overhead Y, squat, hold and return to that stance. No dowel is used.', 'The transition uses alternating foot contacts and an eased sole landing; the fixed bilateral base centers the root once both feet are down. This is a kinematic support approximation, not a measured force or clinical balance score. This is separate from the current arms-down SFMA squat and the FMS dowel squat.'],
};
