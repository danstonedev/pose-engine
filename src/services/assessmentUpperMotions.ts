/**
 * The FMS and SFMA assessment motions for the neck and arms — the cervical
 * patterns, shoulder mobility and clearing, and the two upper-extremity patterns.
 *
 * Moved here verbatim from simMOVE (`src/screen/assessment-upper-motions.ts`) so
 * simMOVE and simLAB play the same patterns; `movementScreen.ts` is the front
 * door. simMOVE is still where these movements are authored, physics-checked and
 * signed off, and a change here changes what both apps play and the routes
 * simMOVE's editor generates from them.
 */
import type { ComposedMotion, SequenceTarget } from './motionSequence';
import { completeBodyTargets, upperScreenControl } from './upperSupportRecipes';

type Side = 'R' | 'L';
const opposite = (side: Side): Side => side === 'R' ? 'L' : 'R';
const target = (joint: string, motion: string, targetDegrees: number): SequenceTarget => ({joint,motion,targetDegrees});
// Atomic shoulder composition retains authored protraction while automatic
// rhythm supplies elevation and tilt. This is still one girdle proxy.
const arm = (side:Side,flexion=0,abduction=0,rotation=0,elbow=0,protraction=0,forearm=0,wrist=0,deviation=0):SequenceTarget[] => [
  target(`${side}_Shoulder`,'protraction',protraction),
  target(`${side}_UpperArm`,'shoulderFlexion',flexion),
  target(`${side}_UpperArm`,'shoulderAbduction',abduction),
  target(`${side}_UpperArm`,'shoulderRotation',rotation),
  target(`${side}_Forearm`,'elbowFlexion',elbow),
  target(`${side}_Forearm`,'forearmRotation',forearm),
  target(`${side}_Hand`,'wristFlexion',wrist),
  target(`${side}_Hand`,'wristDeviation',deviation),
];
// Shoulder flexion and abduction are projected angles, not sequential Euler
// rotations. Both projections describe the overhead direction; shared rhythm
// supplies the clavicle motion. Forearm and wrist targets orient the palm.
// The lower route remains a bounded low-back reach, not claimed scapular contact.
const lower = (side:Side) => arm(side,-60,0,70,100,-15,-60,10,20);
const upper = (side:Side) => arm(side,174,155,-90,148,-5,30,8,3);
const lowerApproach = (side:Side) => arm(side,-45,20,55,20,-2,-30);
const upperApproach = (side:Side) => arm(side,174,140,-90,45,-5,30);
const neutral = () => completeBodyTargets([...arm('R'),...arm('L')]);
function standing(name:string,approach:SequenceTarget[],peak:SequenceTarget[]):ComposedMotion {
  // Realized coupled capacity is enforced as well as the individual ROM rows.
  const result: ComposedMotion = {name,controlId:'upper-assessment',startFrom:'neutral',stance:'planted',startPosture:'standing',endPosture:'standing',keyframes:[
    {durationMs:700,holdMs:300,targets:neutral()},
    {durationMs:1200,targets:completeBodyTargets(approach)},
    {durationMs:1200,holdMs:1400,targets:completeBodyTargets(peak)},
    {durationMs:1200,targets:completeBodyTargets(approach)},
    {durationMs:1200,holdMs:300,targets:neutral()},
  ]};
  result.keyframes.forEach((frame, i) => { frame.control = upperScreenControl(`upper-assessment/${i}`); });
  result.shoulderCapacity = 'enforce-proxy';
  return result;
}
function cervical(motion:'flexion'|'rotation',degrees:number,name:string):ComposedMotion {
  const neck = (value:number) => completeBodyTargets(['flexion','rotation','lateralTilt','protraction'].map(field=>target('Neck',field,field===motion?value:0)));
  return {name,startFrom:'neutral',stance:'planted',startPosture:'standing',endPosture:'standing',keyframes:[
    {durationMs:500,targets:neck(0),control:upperScreenControl('cervical/setup')},
    {durationMs:900,holdMs:1400,targets:neck(degrees),control:upperScreenControl('cervical/peak')},
    {durationMs:900,targets:neck(0),control:upperScreenControl('cervical/return')},
  ]};
}

function shoulderMobility(side:Side):ComposedMotion {
 const motion=standing(`Shoulder mobility · ${side} overhead`,[...upperApproach(side),...lowerApproach(opposite(side))],[...upper(side),...lower(opposite(side))]);
 // Composite digit curls provide editable fist shapes. Thumb-under-fingers
 // contact is not established by this approximate authoring command.
 for(const frame of motion.keyframes)frame.targets!.push(...(['R','L'] as const).flatMap(s=>['Thumb','Index','Mid','Ring','Pinky'].map(digit=>target(`${s}_${digit}1`,'fingerFlexion',digit==='Thumb'?65:140))));
 return motion;
}
export const UPPER_ASSESSMENT_MOTIONS = {
  'shoulder-mobility':shoulderMobility,
  'shoulder-clearing':(side:Side)=>standing(`Shoulder clearing · ${side}`,[...arm(side,65,-20,70,110,3),...arm(opposite(side))],[...arm(side,90,30,70,130,6),...arm(opposite(side))]),
  'ue-pattern1':(side:Side)=>standing(`Upper extremity pattern 1 · ${side}`,[...lowerApproach(side),...arm(opposite(side))],[...lower(side),...arm(opposite(side))]),
  'ue-pattern2':(side:Side)=>standing(`Upper extremity pattern 2 · ${side}`,[...upperApproach(side),...arm(opposite(side))],[...upper(side),...arm(opposite(side))]),
  'cervical-flexion':(_side:Side)=>cervical('flexion',50,'Cervical flexion'),
  'cervical-extension':(_side:Side)=>cervical('flexion',-60,'Cervical extension'),
  'cervical-rotation':(side:Side)=>cervical('rotation',side==='R'?-80:80,`Cervical rotation · ${side}`),
} satisfies Record<string,(side:Side)=>ComposedMotion>;

export const UPPER_ASSESSMENT_NOTES:Record<keyof typeof UPPER_ASSESSMENT_MOTIONS,string[]> = {
  'shoulder-mobility':['Editable over/under approach, with the selected side overhead. The fists remain separated; this is not a completed mobility endpoint. Thumb placement, hand-length scoring and skin contact require review.'],
  'shoulder-clearing':['Editable shoulder-clearing approach. Opposite-shoulder palm contact and pain response require review.'],
  'ue-pattern1':['Editable reach behind the low back, short of the opposite scapular target. The forearm and wrist orient the hand away from the torso; joint angles alone do not establish landmark contact.'],
  'ue-pattern2':['Editable overhead reach with the elbow beside the head and the palm directed toward the upper back. Opposite-scapula contact is not established; joint angles alone do not establish landmark contact.'],
  'cervical-flexion':['Neck motion is commanded with the trunk neutral. Chin-to-sternum contact and mouth closure are not measured.'],
  'cervical-extension':['Neck motion is commanded with the trunk neutral. The face-to-horizontal criterion is not measured.'],
  'cervical-rotation':['The selected side is assessed and returns to neutral. Chin-to-clavicle alignment and feet-together placement require review.'],
};
