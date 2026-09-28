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

type Side = 'R' | 'L';
const opposite = (side: Side): Side => side === 'R' ? 'L' : 'R';
const target = (joint: string, motion: string, targetDegrees: number): SequenceTarget => ({joint,motion,targetDegrees});
const trunk = (): SequenceTarget[] => ['Spine_Lower','Spine_Upper'].flatMap(joint =>
  ['flexion','rotation','lateralTilt'].map(motion => target(joint,motion,0)));
// Compose humeral swing and twist together. Explicit clavicle targets would
// overwrite the engine's coupled shoulder-girdle contribution.
const arm = (side:Side,flexion=0,abduction=0,rotation=0,elbow=0):SequenceTarget[] => [
  target(`${side}_UpperArm`,'shoulderFlexion',flexion),
  target(`${side}_UpperArm`,'shoulderAbduction',abduction),
  target(`${side}_UpperArm`,'shoulderRotation',rotation),
  target(`${side}_Forearm`,'elbowFlexion',elbow),
];
// Bounded approach endpoints measured on both source assets. A larger elbow
// bend on the lower route moved the wrist through the torso, so the seed stops
// behind the low back instead of pretending to have reached the scapula.
const lower = (side:Side) => arm(side,-60,-30,70,90);
const upper = (side:Side) => arm(side,155,0,-90,145);
const lowerApproach = (side:Side) => arm(side,-45,0,55,20);
const upperApproach = (side:Side) => arm(side,145,0,-70,20);
const neutral = () => [...trunk(),...arm('R'),...arm('L')];
function standing(name:string,approach:SequenceTarget[],peak:SequenceTarget[]):ComposedMotion {
  return {name,startFrom:'neutral',stance:'planted',startPosture:'standing',endPosture:'standing',keyframes:[
    {durationMs:700,holdMs:300,targets:neutral()},
    {durationMs:1200,targets:[...trunk(),...approach]},
    {durationMs:1200,holdMs:1400,targets:[...trunk(),...peak]},
    {durationMs:1200,targets:[...trunk(),...approach]},
    {durationMs:1200,holdMs:300,targets:neutral()},
  ]};
}
function cervical(motion:'flexion'|'rotation',degrees:number,name:string):ComposedMotion {
  const neck = (value:number) => [...neutral(),...['flexion','rotation','lateralTilt','protraction'].map(field=>target('Neck',field,field===motion?value:0))];
  return {name,startFrom:'neutral',stance:'planted',startPosture:'standing',endPosture:'standing',keyframes:[
    {durationMs:500,targets:neck(0)},
    {durationMs:900,holdMs:1400,targets:neck(degrees)},
    {durationMs:900,targets:neck(0)},
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
  'shoulder-clearing':(side:Side)=>standing(`Shoulder clearing · ${side}`,[...arm(side,65,-20,70,110),...arm(opposite(side))],[...arm(side,90,30,70,130),...arm(opposite(side))]),
  'ue-pattern1':(side:Side)=>standing(`Upper extremity pattern 1 · ${side}`,[...lowerApproach(side),...arm(opposite(side))],[...lower(side),...arm(opposite(side))]),
  'ue-pattern2':(side:Side)=>standing(`Upper extremity pattern 2 · ${side}`,[...upperApproach(side),...arm(opposite(side))],[...upper(side),...arm(opposite(side))]),
  'cervical-flexion':(_side:Side)=>cervical('flexion',50,'Cervical flexion'),
  'cervical-extension':(_side:Side)=>cervical('flexion',-60,'Cervical extension'),
  'cervical-rotation':(side:Side)=>cervical('rotation',side==='R'?-80:80,`Cervical rotation · ${side}`),
} satisfies Record<string,(side:Side)=>ComposedMotion>;

export const UPPER_ASSESSMENT_NOTES:Record<keyof typeof UPPER_ASSESSMENT_MOTIONS,string[]> = {
  'shoulder-mobility':['Editable over/under approach, with the selected side overhead. The fists remain separated; this is not a completed mobility endpoint. Thumb placement, hand-length scoring and skin contact require review.'],
  'shoulder-clearing':['Editable shoulder-clearing approach. Opposite-shoulder palm contact and pain response require review.'],
  'ue-pattern1':['Editable reach behind the low back, short of the opposite scapular target. Palm direction and skin contact require refinement; joint angles alone do not establish landmark contact.'],
  'ue-pattern2':['Editable reach behind the head, short of the opposite scapular target. Palm direction and skin contact require refinement; joint angles alone do not establish landmark contact.'],
  'cervical-flexion':['Neck motion is commanded with the trunk neutral. Chin-to-sternum contact and mouth closure are not measured.'],
  'cervical-extension':['Neck motion is commanded with the trunk neutral. The face-to-horizontal criterion is not measured.'],
  'cervical-rotation':['The selected side is assessed and returns to neutral. Chin-to-clavicle alignment and feet-together placement require review.'],
};
