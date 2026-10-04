/** Read-only source/asset/contact diagnostic on a retained trunk push-up recipe.
 * vite-node THIS <baseline-review-folder> <baseline-recipe.json> <fresh-report.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { captureJointAngleRestReference } from '../../src/services/jointAngles';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../../src/services/poseRig';
import { resolveComposedMotion, type ComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';

const [reviewDir, recipePath, output] = process.argv.slice(2);
if (!output) throw Error('Baseline review, retained recipe and fresh output required');
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(readFileSync(resolve(reviewDir,'manifest.json'),'utf8'));
const recipe=JSON.parse(readFileSync(recipePath,'utf8')) as ComposedMotion;
setRomClampEnabled(false);
const sourcePaths=['src/services/motionRecording.ts','src/services/handContactPose.ts','src/services/shoulderComplex.ts',
  'src/services/shoulderPose.ts','src/services/footContact.ts','src/services/poseRig.ts','src/services/poseRomClamp.ts'];
const identity=()=>Object.fromEntries(sourcePaths.map(p=>{try{return[p,hash(readFileSync(new URL('../../'+p,import.meta.url)))];}catch{return[p,'missing'];}}));
const sourceBefore=identity();
const report:any={version:1,kind:'plank-shoulder-origin-asymmetry-diagnostic',baselineSourceDigest:manifest.sourceDigest,
  manifestSha256:hash(readFileSync(resolve(reviewDir,'manifest.json'))),recipeSha256:hash(readFileSync(recipePath)),
  currentSourceHashes:sourceBefore,romClamp:false,
  scope:'All101actual bones, rest asset and anatomic rest, prepared setup/top/return authored FK without hand contact versus current full contact and exact retained export. No runtime/master mutation. The FK diagnostic substitutes kneeling vertical-only grounding and removes palm contacts; its root Y is not a candidate support claim. Root-relative shoulder/clavicle geometry and local quaternions isolate arm/contact ownership.',cases:[]};
const load=async(bytes:Buffer)=>(await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
for(const variant of ['male','female','neutral'] as const){
 const cfg=BODY_VARIANTS[variant];
 const bytes=readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`,import.meta.url));
 const sourceCase=manifest.cases.find((c:any)=>c.variant===variant);
 if(hash(bytes)!==sourceCase.sourceModelSha256)throw Error('Current production asset differs from retained review');
 const root=await load(bytes);root.scale.setScalar(cfg.pose.rootScale);root.updateMatrixWorld(true);
 let skin!:THREE.SkinnedMesh;root.traverse(o=>{if(!skin&&(o as THREE.SkinnedMesh).isSkinnedMesh)skin=o as THREE.SkinnedMesh;});
 const skeleton=skin.skeleton,bones=buildBoneByPoseKey(skeleton,cfg);
 const inspect=(actor:THREE.Object3D, allBones:THREE.Bone[], mapping:Map<any,THREE.Bone>)=>{
  actor.updateMatrixWorld(true);
  const inverse=actor.matrixWorld.clone().invert();
  const map=Object.fromEntries(allBones.map(b=>[b.name,{parent:b.parent?.name,localPosition:b.position.toArray(),
    localQuaternion:b.quaternion.toArray(),worldQuaternion:b.getWorldQuaternion(new THREE.Quaternion()).toArray(),
    worldPositionM:b.getWorldPosition(new THREE.Vector3()).toArray(),
    rootFramePositionM:b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse).multiplyScalar(cfg.pose.rootScale).toArray()}]));
  const pair=(key:string)=>{const l=mapping.get('L_'+key),r=mapping.get('R_'+key);if(!l||!r)return null;
    const a=l.getWorldPosition(new THREE.Vector3()),b=r.getWorldPosition(new THREE.Vector3());
    return{L:map[l.name],R:map[r.name],worldDifferenceM:a.clone().sub(b).toArray(),
      rootFrameDifferenceM:new THREE.Vector3().fromArray(map[l.name].rootFramePositionM).sub(new THREE.Vector3().fromArray(map[r.name].rootFramePositionM)).toArray()};};
  return{rootPositionM:actor.position.toArray(),rootQuaternion:actor.quaternion.toArray(),boneCount:allBones.length,bones:map,
    pairs:{shoulder:pair('Shoulder'),upperArmOrigin:pair('UpperArm'),forearm:pair('Forearm'),hand:pair('Hand')}};
 };
 const assetRest=inspect(root,skeleton.bones,bones);
 applyAnatomicPose(root,cfg);root.updateMatrixWorld(true);
 const anatomicalRest=inspect(root,skeleton.bones,bones);
 const rest=captureJointAngleRestReference(skeleton,cfg),baselinePose=serializeCustomPose(skeleton,cfg,variant);
 const rootRestPosition=root.position.clone(),rootRestQuaternion=root.quaternion.clone();
 const rows:any[]=[];
 for(const mode of ['authored-fk-no-hand-contact','generic-grounding-reach-only','full-contact','full-contact-skin-surface'] as const){
  root.position.copy(rootRestPosition);root.quaternion.copy(rootRestQuaternion);applyCustomPose(skeleton,cfg,baselinePose);root.updateMatrixWorld(true);
  const authored=structuredClone(recipe);
  if(mode==='authored-fk-no-hand-contact'){
    authored.contacts=[];authored.fixedGroundSupports=[];
    for(const frame of authored.keyframes)frame.groundingPosture='kneeling';
  }
  if(mode==='generic-grounding-reach-only')authored.contacts=[];
  if(mode==='full-contact-skin-surface')for(const c of authored.contacts??[])if(c.palmSupport)c.palmSupport.surface='skin';
  const recording=sampleComposedMotion(resolveComposedMotion(authored,cfg),{baselinePose,variantCfg:cfg,rest,
    skeletonHarness:{root,skinned:skin},frameTimesMs:[0,2500,5600]});
  for(const frame of recording.frames){
   root.position.fromArray(frame.root.translateM);root.quaternion.fromArray(frame.root.orientQuat);applyCustomPose(skeleton,cfg,frame.pose);
   rows.push({mode,tMs:frame.tMs,angles:frame.angles,...inspect(root,skeleton.bones,bones)});
  }
 }
 const glbBytes=readFileSync(resolve(reviewDir,sourceCase.file));if(hash(glbBytes)!==sourceCase.glbSha256)throw Error('Retained export changed');
 const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(glbBytes.buffer.slice(glbBytes.byteOffset,glbBytes.byteOffset+glbBytes.byteLength),'');
 let oldSkin!:THREE.SkinnedMesh;gltf.scene.traverse(o=>{if(!oldSkin&&(o as THREE.SkinnedMesh).isSkinnedMesh)oldSkin=o as THREE.SkinnedMesh;});
 const oldRoot=gltf.scene.getObjectByName('ENGINE_ModelRoot')??gltf.scene,oldBones=oldSkin.skeleton.bones;
 const oldMap=buildBoneByPoseKey(oldSkin.skeleton,cfg);const mixer=new THREE.AnimationMixer(gltf.scene);mixer.clipAction(gltf.animations[0]).play();
 const parity:any[]=[];
 for(const tMs of [0,2500,5600]){
  mixer.setTime(tMs/1000);gltf.scene.updateMatrixWorld(true);
  const retained=inspect(oldRoot,oldBones,oldMap);rows.push({mode:'retained-original-full-contact',tMs,...retained});
  const current=rows.find(x=>x.mode==='full-contact'&&x.tMs===tMs);
  const maxima=Object.keys(current.bones).map(name=>({name,errorM:new THREE.Vector3().fromArray(current.bones[name].worldPositionM).distanceTo(new THREE.Vector3().fromArray(retained.bones[name].worldPositionM))})).sort((a,b)=>b.errorM-a.errorM);
  parity.push({tMs,maxBoneWorldErrorM:maxima[0].errorM,witness:maxima[0].name,upperArmOriginDeltaM:
    new THREE.Vector3().fromArray(current.pairs.upperArmOrigin.worldDifferenceM).distanceTo(new THREE.Vector3().fromArray(retained.pairs.upperArmOrigin.worldDifferenceM))});
 }
 report.cases.push({variant,assetSha256:hash(bytes),assetRest,anatomicalRest,restReference:rest,frames:rows,retainedParity:parity});
 console.log(JSON.stringify({variant,restUpperOrigin:anatomicalRest.pairs.upperArmOrigin.worldDifferenceM,
   frames:rows.map(x=>({mode:x.mode,tMs:x.tMs,upperOrigin:x.pairs.upperArmOrigin.worldDifferenceM,clavicle:x.pairs.shoulder?.worldDifferenceM,
     localClavicleQ:x.pairs.shoulder&&[x.pairs.shoulder.L.localQuaternion,x.pairs.shoulder.R.localQuaternion]})),retainedParity:parity}));
}
report.currentSourceStable=JSON.stringify(sourceBefore)===JSON.stringify(identity());if(!report.currentSourceStable)throw Error('Runtime changed during diagnostic');
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
