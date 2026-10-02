// The neck and arm FMS/SFMA assessment motions, played on both body models —
// moved from simMOVE with the motions (src/screen/assessment-upper-motions.test.ts).
// simMOVE loaded the rig through its lower-body physics bridge; the same scaled,
// anatomically posed rig and its canonical bone map are built here directly.
import {beforeAll,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {Quaternion,Vector3,type Object3D,type SkinnedMesh} from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {BODY_VARIANTS} from '../anatomy/bodyVariants';
import {applyAnatomicPose} from '../services/anatomicPose';
import {captureJointAngleRestReference,computeJointAngles} from '../services/jointAngles';
import {applyCustomPose,buildBoneByPoseKey,serializeCustomPose} from '../services/poseRig';
import {buildSequencePoses,resolveComposedMotion} from '../services/motionSequence';
import {sampleComposedMotion} from '../services/motionRecording';
import {createArmTorsoContact} from '../services/armTorsoContact';
import {armHeadContact} from './helpers/armHeadContact';
import {createStageTwistOverlay} from '../services/stageTwistOverlay';
import {UPPER_ASSESSMENT_MOTIONS,UPPER_ASSESSMENT_NOTES} from '../services/assessmentUpperMotions';

function prepareRig(root:Object3D,variant:'female'|'male'|'neutral'){
 const cfg=BODY_VARIANTS[variant];root.scale.setScalar(cfg.pose.rootScale);
 let skin:SkinnedMesh|undefined;root.traverse(object=>{if(!skin&&(object as SkinnedMesh).isSkinnedMesh)skin=object as SkinnedMesh;});
 root.updateMatrixWorld(true);applyAnatomicPose(root,cfg);root.updateMatrixWorld(true);
 return {root,skin:skin!,cfg,bones:buildBoneByPoseKey(skin!.skeleton,cfg)};
}

describe.each(['female','male','neutral'] as const)('upper assessment sources on actual %s rig',variant=>{
 let bridge:ReturnType<typeof prepareRig>,rest:ReturnType<typeof captureJointAngleRestReference>,neutral:ReturnType<typeof serializeCustomPose>;
 beforeAll(async()=>{
  const bytes=readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`,import.meta.url));
  const loader=new GLTFLoader();loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  bridge=prepareRig(gltf.scene,variant);neutral=serializeCustomPose(bridge.skin.skeleton,bridge.cfg,variant);rest=captureJointAngleRestReference(bridge.skin.skeleton,bridge.cfg);
 });
 const world=(key:string)=>bridge.bones.get(key)!.getWorldPosition(new Vector3());
 function apply(pose:typeof neutral){applyCustomPose(bridge.skin.skeleton,bridge.cfg,pose);bridge.root.updateMatrixWorld(true);}

 it.each(Object.entries(UPPER_ASSESSMENT_MOTIONS))('%s resolves complete bounded routes on both sides', (id,create)=>{
  for(const side of ['R','L'] as const){
   const motion=create(side),resolved=resolveComposedMotion(motion);expect(resolved.status).toBe('ok');
   expect(resolved.outcomes.filter(outcome=>outcome.status!=='complied')).toEqual([]);
   expect(UPPER_ASSESSMENT_NOTES[id as keyof typeof UPPER_ASSESSMENT_MOTIONS].length).toBeGreaterThan(0);
   const built=buildSequencePoses(neutral,resolved,bridge.cfg,rest),peak=motion.keyframes.findIndex(frame=>frame.holdMs===1400);
   expect(peak).toBeGreaterThan(0);expect(peak).toBeLessThan(motion.keyframes.length-1);
   expect(built.poses.length).toBe(motion.keyframes.length);
   for(const [key,quat]of Object.entries(built.poses[0].bones)){
    expect(new Quaternion().fromArray(quat).normalize().angleTo(new Quaternion().fromArray(built.poses.at(-1)!.bones[key]).normalize()),`${key} returns to setup`).toBeLessThan(1e-6);
   }
   apply(neutral);const ankleL=world('L_Foot'),ankleR=world('R_Foot');
   for(const pose of built.poses){
    apply(pose);expect(world('L_Foot').distanceTo(ankleL)).toBeLessThan(1e-6);expect(world('R_Foot').distanceTo(ankleR)).toBeLessThan(1e-6);
    for(const key of ['Hips','Spine_Lower','Spine_Upper'])expect(pose.bones[key]).toEqual(neutral.bones[key]);
    for(const quat of Object.values(pose.bones))expect(quat.every(Number.isFinite)).toBe(true);
   }
   apply(built.poses[peak]);
   const wrist=world(`${side}_Hand`),elbow=world(`${side}_Forearm`),shoulder=world(`${side}_UpperArm`),torso=world('Spine_Upper');
   if(id==='ue-pattern1'){
    // Geometric guardrails for a low-back approach; not a claim of scapular
    // contact or of validated deformable-skin clearance.
    expect(wrist.z).toBeLessThan(torso.z-.16);expect(elbow.z).toBeLessThan(wrist.z-.06);
    expect(wrist.y).toBeLessThan(shoulder.y-.20);expect(Math.abs(wrist.x)).toBeLessThan(.12);
   }
   if(id==='ue-pattern2'||id==='shoulder-mobility'){
    expect(elbow.y).toBeGreaterThan(shoulder.y+.20);expect(wrist.y).toBeLessThan(elbow.y-.10);
    expect(wrist.z).toBeLessThan(torso.z-.13);
    // The elbow sits beside the head; the hand descends toward the midline
    // with its palm facing the back rather than reaching across the neck.
    expect(Math.abs(elbow.x)).toBeGreaterThan(.10);expect(Math.abs(elbow.x)).toBeLessThan(.24);
    expect(Math.abs(wrist.x)).toBeLessThan(.09);
    const palm=world(`${side}_Mid1`).sub(wrist).cross(world(`${side}_Pinky1`).sub(world(`${side}_Index1`))).normalize().multiplyScalar(side==='R'?1:-1);
    expect(palm.z).toBeGreaterThan(.9);
    if(id==='ue-pattern2')expect(world(`${side}_Mid3`).y).toBeLessThan(shoulder.y-.03);
    if(id==='shoulder-mobility'){
     const lower=world(`${side==='R'?'L':'R'}_Hand`);expect(lower.z).toBeLessThan(torso.z-.16);expect(lower.y).toBeLessThan(wrist.y-.20);
     const report=computeJointAngles(bridge.skin.skeleton,bridge.cfg,variant,rest);
     expect(report.joints[`${side}_Index1`].fingerFlexion).toBeGreaterThan(130);
    }
   }
   if(id==='shoulder-clearing'){
    expect(wrist.distanceTo(world(`${side==='R'?'L':'R'}_UpperArm`))).toBeLessThan(.25);
    expect(elbow.y).toBeGreaterThan(shoulder.y-.015);expect(elbow.z).toBeGreaterThan(torso.z+.22);
   }
   if(id.startsWith('cervical')){
    const report=computeJointAngles(bridge.skin.skeleton,bridge.cfg,variant,rest),field=id==='cervical-rotation'?'rotation':'flexion',expected=id==='cervical-flexion'?50:id==='cervical-extension'?-60:side==='R'?-80:80;
    expect(report.joints.Neck[field]).toBeCloseTo(expected,1);
    for(const key of ['R_UpperArm','L_UpperArm','R_Forearm','L_Forearm'])expect(built.poses[peak].bones[key]).toEqual(built.poses[0].bones[key]);
   }
  }
 });
 it.each(['ue-pattern1','shoulder-mobility'] as const)('%s raises the lower wrist on both sides without moving the trunk',id=>{
  for(const side of ['R','L'] as const){
   const lowerSide=id==='ue-pattern1'?side:side==='L'?'R':'L';
   const motion=UPPER_ASSESSMENT_MOTIONS[id](side);
   const held=(candidate:typeof motion)=>{
    bridge.root.position.set(0,0,0);bridge.root.quaternion.identity();apply(neutral);
    const recording=sampleComposedMotion(resolveComposedMotion(candidate),{
     baselinePose:neutral,variantCfg:bridge.cfg,rest,skeletonHarness:{root:bridge.root,skinned:bridge.skin},sampleHz:6,
    });
    // Measure the display path, including shared hand policy and root support.
    const frame=recording.frames.find(f=>f.tMs>=4100)!;
    bridge.root.position.fromArray(frame.root.translateM);bridge.root.quaternion.fromArray(frame.root.orientQuat);apply(frame.pose);
    return {pose:frame.pose,wrist:world(`${lowerSide}_Hand`),middle:world(`${lowerSide}_Mid3`)};
   };
   const current=held(motion);
   // Fixed shipped baseline; compare achieved geometry rather than asserting
   // the new recipe's angle constants or claiming an anatomical endpoint.
   const previous:Record<string,number>={shoulderFlexion:-60,shoulderAbduction:0,shoulderRotation:70,elbowFlexion:100,protraction:-15,forearmRotation:-60,wristFlexion:10,wristDeviation:20};
   for(const t of motion.keyframes[2].targets!)if(t.joint.startsWith(`${lowerSide}_`)&&t.motion in previous)t.targetDegrees=previous[t.motion];
   const previousHold=held(motion);
   expect(current.wrist.y-previousHold.wrist.y).toBeGreaterThan(.03);
   if(id==='ue-pattern1'){
    expect(current.middle.y-previousHold.middle.y).toBeGreaterThan(.07);
    expect(current.middle.y).toBeGreaterThan(current.wrist.y+.005);
   }
   for(const key of ['Hips','Spine_Lower','Spine_Upper'])expect(new Quaternion().fromArray(current.pose.bones[key]).normalize().angleTo(new Quaternion().fromArray(neutral.bones[key]).normalize())).toBeLessThan(1e-6);
  }
 });
 it('samples the coordinated over/under route with finite geometry and a completed return',()=>{
  apply(neutral);const position=bridge.root.position.clone(),rotation=bridge.root.quaternion.clone();
  const recording=sampleComposedMotion(resolveComposedMotion(UPPER_ASSESSMENT_MOTIONS['shoulder-mobility']('R')),{
   baselinePose:neutral,variantCfg:bridge.cfg,rest,skeletonHarness:{root:bridge.root,skinned:bridge.skin},sampleHz:6,
  });
  expect(recording.frames.length).toBeGreaterThan(30);
  for(const frame of recording.frames){
   expect(frame.root.translateM.every(Number.isFinite)).toBe(true);expect(frame.root.orientQuat.every(Number.isFinite)).toBe(true);
   for(const point of Object.values(frame.worldTracks??{}))expect(point.every(Number.isFinite)).toBe(true);
  }
  const first=recording.frames.find(frame=>frame.tMs>=700)!,last=recording.frames.at(-1)!;
  for(const side of ['R','L'])expect(new Vector3().fromArray(first.worldTracks![`${side}_Hand`]).distanceTo(new Vector3().fromArray(last.worldTracks![`${side}_Hand`]))).toBeLessThan(.005);
  bridge.root.position.copy(position);bridge.root.quaternion.copy(rotation);apply(neutral);
 });

 it.each((['ue-pattern1','ue-pattern2','shoulder-mobility'] as const).flatMap(id=>(['R','L'] as const).map(side=>({id,side}))))('$id/$side keeps arm skin clear of the torso and head throughout the route',async({id,side})=>{
   bridge.root.position.set(0,0,0);bridge.root.quaternion.identity();apply(neutral);
   const twist=createStageTwistOverlay();twist.reset(bridge.skin.skeleton,bridge.cfg);
   const recording=sampleComposedMotion(resolveComposedMotion(UPPER_ASSESSMENT_MOTIONS[id](side)),{
    baselinePose:neutral,variantCfg:bridge.cfg,rest,skeletonHarness:{root:bridge.root,skinned:bridge.skin},sampleHz:60,
   });
   const first=recording.frames[0]!;
   bridge.root.position.fromArray(first.root.translateM);bridge.root.quaternion.fromArray(first.root.orientQuat);apply(first.pose);
   const torso=createArmTorsoContact(bridge.root)!;
   const head=armHeadContact(bridge.root,bridge.bones.get('Neck_Lower')!);
   const sides=id==='shoulder-mobility'?['L','R'] as const:[side];
   for(const [i,f]of recording.frames.entries()){
    bridge.root.position.fromArray(f.root.translateM);bridge.root.quaternion.fromArray(f.root.orientQuat);apply(f.pose);
    torso.refresh();
    for(const s of sides){
     // Existing envelope tolerance: 3 mm. This is a collision regression,
     // not proof of skin contact at an SFMA landmark or an FMS score.
     expect(torso.inspect(s).penetrationM,`${side}/${s} torso at ${f.tMs}`).toBeLessThan(.003);
     expect(head(s),`${side}/${s} head at ${f.tMs}`).toBeLessThan(.003);
     expect(f.shoulders![s].girdleProxy.elevationDeg!).toBeLessThanOrEqual(120.001);
    }
    twist.sampleWithTwist(()=>{
     torso.refresh();
     for(const s of sides){
      expect(torso.inspect(s).penetrationM,`${side}/${s} rendered torso at ${f.tMs}`).toBeLessThan(.003);
      expect(head(s),`${side}/${s} rendered head at ${f.tMs}`).toBeLessThan(.003);
     }
    });
    if(i%60===0)await new Promise(resolve=>setTimeout(resolve,0));
   }
   apply(neutral);
 },60000); // Two-arm, every-frame skin sweeps can exceed 30 seconds on CI.
});

it('retains explicit target limits when an authored reach is restricted',()=>{
 const resolved=resolveComposedMotion(UPPER_ASSESSMENT_MOTIONS['ue-pattern1']('R'),undefined,{constraints:{R_UpperArm:{shoulderRotation:{availableRange:{min:-90,max:30}}}}});
 expect(resolved.status).toBe('ok');expect(resolved.outcomes.some(outcome=>outcome.joint==='R_UpperArm'&&outcome.motion==='shoulderRotation'&&outcome.status==='modified'&&outcome.clampedDegrees===30)).toBe(true);
});
