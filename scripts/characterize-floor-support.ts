import {readFileSync,writeFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {BODY_VARIANTS} from '../src/anatomy/bodyVariants';
import {applyAnatomicPose} from '../src/services/anatomicPose';
import {applyCustomPose,serializeCustomPose} from '../src/services/poseRig';
import {captureJointAngleRestReference} from '../src/services/jointAngles';
import {resolveComposedMotion} from '../src/services/motionSequence';
import {sampleComposedMotion, authoredToTrajectoryTimeMap} from '../src/services/motionRecording';
import {BODY_ASSESSMENT_MOTIONS} from '../src/services/assessmentBodyMotions';
import {buildPushUp} from '../src/services/movementPostures';
const [output,variantFilter='male',motionFilter='flexion-clearing']=process.argv.slice(2);
if(!output)throw Error('Expected fresh output filename, variant or all, movement or all');
const results=[];
for(const variant of ['female','male','neutral'] as const){
 if(variantFilter!=='all'&&variantFilter!==variant)continue;
 const cfg=BODY_VARIANTS[variant],bytes=readFileSync(new URL('../models/painmap3D_'+variant+'.runtime.glb',import.meta.url));
 const loader=new GLTFLoader();loader.setMeshoptDecoder(MeshoptDecoder);
 const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const root=gltf.scene;root.scale.setScalar(cfg.pose.rootScale);let skinned:THREE.SkinnedMesh;root.traverse(o=>{if(!skinned&&(o as THREE.SkinnedMesh).isSkinnedMesh)skinned=o as THREE.SkinnedMesh;});
 root.updateMatrixWorld(true);applyAnatomicPose(root,cfg);root.updateMatrixWorld(true);
 const baseline=serializeCustomPose(skinned!.skeleton,cfg,variant),rest=captureJointAngleRestReference(skinned!.skeleton,cfg),rootPosition=root.position.clone(),rootQuaternion=root.quaternion.clone();
 for(const id of ['flexion-clearing','extension-clearing','trunk-stability-push-up','push-up']){
  if(motionFilter!=='all'&&motionFilter!==id)continue;
  root.position.copy(rootPosition);root.quaternion.copy(rootQuaternion);applyCustomPose(skinned!.skeleton,cfg,baseline);root.updateMatrixWorld(true);
  const motion=id==='push-up'?buildPushUp({reps:1}):BODY_ASSESSMENT_MOTIONS[id]('R'),resolved=resolveComposedMotion(motion,cfg);
  if(resolved.status!=='ok')throw Error('Refused '+id);
  const recording=sampleComposedMotion(resolved,{baselinePose:baseline,variantCfg:cfg,rest,skeletonHarness:{root,skinned:skinned!},sampleHz:30,trackedBones:['Hips','Head','Spine_Upper',...['L','R'].flatMap(s=>['UpLeg','Leg','Foot','Toes','UpperArm','Forearm','Hand','Mid1','Index1','Pinky1'].map(k=>s+'_'+k))]});
  const setupMs=resolved.startAtSetup?0:authoredToTrajectoryTimeMap(resolved,recording.frames.at(-1)!.tMs).toTrajectory(resolved.keyframes[0].durationMs),frames=recording.frames.filter(f=>f.tMs>=setupMs-.01),first=frames[0],v=(f:typeof first,key:string)=>new THREE.Vector3().fromArray(f.worldTracks![key]!);
  const contacts=['L_Leg','R_Leg','L_Toes','R_Toes','L_Hand','R_Hand','L_Mid1','R_Mid1'];
  const drift=Object.fromEntries(contacts.map(key=>[key,Math.max(...frames.map(f=>Math.hypot(v(f,key).x-v(first,key).x,v(f,key).z-v(first,key).z)))]));
  const samples=frames.map(f=>({timeMs:f.tMs,root:f.root,angles:f.angles,tracks:f.worldTracks,palmNormals:Object.fromEntries(['L','R'].map(side=>[side,v(f,side+'_Mid1').sub(v(f,side+'_Hand')).cross(v(f,side+'_Index1').sub(v(f,side+'_Pinky1'))).normalize().multiplyScalar(side==='L'?1:-1).toArray()]))}));
  results.push({variant,id,setupMs,durationMs:recording.frames.at(-1)!.tMs,drift,samples});console.log(JSON.stringify({variant,id,drift,setup:samples[0],target:samples[Math.floor(samples.length/2)]}));
 }
}
writeFileSync(output,JSON.stringify({at:new Date().toISOString(),scope:'Source kinematics, bone landmarks and palm orientation; not native force acceptance.',results},null,2),{flag:'wx'});
