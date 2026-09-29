import {beforeAll,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {getBodyVariant} from '../anatomy/bodyVariants';
import {applyAnatomicPose} from '../services/anatomicPose';
import {applyCustomPose,serializeCustomPose,buildBoneByPoseKey,buildIKChainContext,blendCustomPose,hashCustomPose} from '../services/poseRig';
import {captureIndependentShoulderReference,applyIndependentShoulderTargets,inspectIndependentShoulder,independentShoulderVariant,migrateLegacyShoulderPose,migrateLegacyShoulderClip,type SegmentQuaternion} from '../services/independentShoulderRig';
import {buildComposedCommandPose} from '../services/movementCommand';
import {resolveComposedMotion} from '../services/motionSequence';
import {sampleComposedMotion,compactRecording} from '../services/motionRecording';
import {captureJointAngleRestReference} from '../services/jointAngles';
const rotation=(axis:number,degrees:number):SegmentQuaternion=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().setComponent(axis,1),degrees*Math.PI/180).toArray();
const angular=(a:SegmentQuaternion,b:SegmentQuaternion)=>new THREE.Quaternion(...a).normalize().angleTo(new THREE.Quaternion(...b).normalize());
for(const variant of ['male','female','neutral'] as const)describe(`${variant} independent shoulder rig`,()=>{
 const cfg=independentShoulderVariant(variant),legacyCfg=getBodyVariant(variant);
 let root:THREE.Object3D,skin:THREE.SkinnedMesh,legacyRoot:THREE.Object3D,legacySkin:THREE.SkinnedMesh,ref:ReturnType<typeof captureIndependentShoulderReference>,neutral:ReturnType<typeof serializeCustomPose>,legacyNeutral:ReturnType<typeof serializeCustomPose>,clips:THREE.AnimationClip[];
 beforeAll(async()=>{
  for(const v2 of [false,true]){const bytes=readFileSync(`models/painmap3D_${variant}.${v2?'shoulder-v2':'runtime'}.glb`),gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');let sm:THREE.SkinnedMesh=null!;gltf.scene.traverse(n=>{if((n as THREE.SkinnedMesh).isSkinnedMesh&&(!sm||((n as THREE.SkinnedMesh).material as THREE.Material).name==='Std_Skin_Body'))sm=n as THREE.SkinnedMesh;});applyAnatomicPose(gltf.scene,v2?cfg:legacyCfg);gltf.scene.updateMatrixWorld(true);if(v2){root=gltf.scene;skin=sm;}else{legacyRoot=gltf.scene;legacySkin=sm;clips=gltf.animations;}}
  ref=captureIndependentShoulderReference(skin.skeleton,cfg);neutral=serializeCustomPose(skin.skeleton,cfg,variant);legacyNeutral=serializeCustomPose(legacySkin.skeleton,legacyCfg,variant);
 });
 const reset=()=>{root.quaternion.identity();root.position.set(0,0,0);applyCustomPose(skin.skeleton,cfg,neutral);root.updateMatrixWorld(true);};
 it('retains all legacy neutral joint origins and appends two mapped skin bones',()=>{
  reset();expect(skin.skeleton.bones).toHaveLength(103);const old=buildBoneByPoseKey(legacySkin.skeleton,legacyCfg);
  for(const [key,bone] of old)expect(ref.bones.get(key)!.getWorldPosition(new THREE.Vector3()).distanceTo(bone.getWorldPosition(new THREE.Vector3())),key).toBeLessThan(2e-6);
  expect(neutral.rigVersion).toBe('shoulder-v2-engineering-1');expect(neutral.schemaVersion).not.toBe(legacyNeutral.schemaVersion);
 });
 for(const side of ['L','R'] as const){
  it(`${side}: independent SC and AC, derived ST, distinct GH/HT and deterministic priority`,()=>{
   reset();const SC=rotation(2,18),AC=rotation(0,22),GH=rotation(1,48),result=applyIndependentShoulderTargets(ref,side,{GH,AC,SC,ST:rotation(1,10),HT:rotation(2,140)});
   expect(angular(result.rotations.SC.quaternion,SC)).toBeLessThan(1e-7);expect(angular(result.rotations.AC.quaternion,AC)).toBeLessThan(1e-7);expect(angular(result.rotations.GH.quaternion,GH)).toBeLessThan(1e-7);
   expect(result.closureErrorDeg).toBeLessThan(1e-5);expect(result.residualsDeg.ST).toBeGreaterThan(5);expect(result.residualsDeg.HT).toBeGreaterThan(5);
   const other=inspectIndependentShoulder(ref,side==='L'?'R':'L');expect(other.rotations.AC.rotationMagnitudeDeg).toBeLessThan(1e-5);
   const q=serializeCustomPose(skin.skeleton,cfg,variant);reset();applyIndependentShoulderTargets(ref,side,{SC,AC,GH,HT:rotation(2,140),ST:rotation(1,10)});expect(hashCustomPose(serializeCustomPose(skin.skeleton,cfg,variant))).toBe(hashCustomPose(q));
  });
  it(`${side}: derived targets solve without double-counting and are invariant to root/trunk motion`,()=>{
   reset();const ST=rotation(2,36),HT=rotation(0,120);const a=applyIndependentShoulderTargets(ref,side,{SC:rotation(1,13),ST,HT});expect(a.residualsDeg.ST).toBeLessThan(1e-5);expect(a.residualsDeg.HT).toBeLessThan(1e-5);
   root.quaternion.setFromEuler(new THREE.Euler(.3,.7,-.2));ref.bones.get('Spine_Upper')!.quaternion.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(.1,.2,.3)));root.updateMatrixWorld(true);const b=inspectIndependentShoulder(ref,side);
   for(const key of ['SC','AC','ST','GH','HT'] as const)expect(angular(a.rotations[key].quaternion,b.rotations[key].quaternion)).toBeLessThan(1e-7);
  });
  it(`${side}: hand IK names its segments and includes the independent scapula`,()=>{
   reset();const full=buildIKChainContext(skin,ref.bones.get(`${side}_Hand`)!,3,cfg)!;expect(full.canonicalKeys).toEqual([`${side}_Hand`,`${side}_Forearm`,`${side}_UpperArm`,`${side}_Scapula`,`${side}_Shoulder`]);
   expect(buildIKChainContext(skin,ref.bones.get(`${side}_Hand`)!,2,cfg)!.canonicalKeys).toEqual([`${side}_Hand`,`${side}_Forearm`,`${side}_UpperArm`]);
  });
  it(`${side}: the scapula deforms a posterior skin patch and leaves the opposite shoulder fixed`,()=>{
   reset();const before:THREE.Vector3[]=[];skin.skeleton.update();for(let i=0;i<skin.geometry.getAttribute('position').count;i++)before.push(skin.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(skin.matrixWorld));
   const other=ref.bones.get(`${side==='L'?'R':'L'}_UpperArm`)!.getWorldPosition(new THREE.Vector3());applyIndependentShoulderTargets(ref,side,{AC:rotation(1,20)});root.updateMatrixWorld(true);skin.skeleton.update();
   const scapIndex=skin.skeleton.bones.indexOf(ref.bones.get(`${side}_Scapula`)!);let moved=0;
   const ids=skin.geometry.getAttribute('skinIndex'),weights=skin.geometry.getAttribute('skinWeight');
   for(let i=0;i<before.length;i++){let w=0;for(let k=0;k<4;k++)if(ids.getComponent(i,k)===scapIndex)w+=weights.getComponent(i,k);if(w>.01&&skin.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(skin.matrixWorld).distanceTo(before[i])>.0001)moved++;}
   expect(moved).toBeGreaterThan(10);expect(ref.bones.get(`${side==='L'?'R':'L'}_UpperArm`)!.getWorldPosition(new THREE.Vector3()).distanceTo(other)).toBeLessThan(1e-8);
  });
 }
 it('migrates legacy overhead and combined rotation poses with unchanged world transforms',()=>{
  for(const elevation of [0,70,160]){
   reset();applyCustomPose(legacySkin.skeleton,legacyCfg,legacyNeutral);const rest=captureJointAngleRestReference(legacySkin.skeleton,legacyCfg);
   const pose=buildComposedCommandPose(legacyNeutral,'R_UpperArm',[{motion:'shoulderFlexion',degrees:elevation},{motion:'shoulderRotation',degrees:35}],legacyCfg,legacyNeutral,rest)!;
   applyCustomPose(legacySkin.skeleton,legacyCfg,pose);legacyRoot.updateMatrixWorld(true);applyCustomPose(skin.skeleton,cfg,migrateLegacyShoulderPose(pose,ref));root.updateMatrixWorld(true);
   for(const [key,bone] of buildBoneByPoseKey(legacySkin.skeleton,legacyCfg)){const actual=ref.bones.get(key)!;expect(actual.getWorldPosition(new THREE.Vector3()).distanceTo(bone.getWorldPosition(new THREE.Vector3())),key).toBeLessThan(2e-6);expect(actual.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(bone.getWorldQuaternion(new THREE.Quaternion()).normalize()),key).toBeLessThan(1e-6);}
  }
 });
 it('rejects incompatible poses and invalid commands atomically, and preserves rig identity through interpolation',()=>{
  reset();expect(()=>applyCustomPose(skin.skeleton,cfg,legacyNeutral)).toThrow(/migration/);expect(()=>applyCustomPose(legacySkin.skeleton,legacyCfg,neutral)).toThrow(/migration/);
  expect(()=>blendCustomPose(legacyNeutral,neutral,.5)).toThrow(/rig versions/);const before=serializeCustomPose(skin.skeleton,cfg,variant);expect(()=>applyIndependentShoulderTargets(ref,'R',{SC:rotation(0,10),AC:[NaN,0,0,1]})).toThrow();expect(serializeCustomPose(skin.skeleton,cfg,variant)).toEqual(before);
  const mid=blendCustomPose(neutral,before,.5)!;expect(mid.rigVersion).toBe(neutral.rigVersion);expect(mid.schemaVersion).toBe(neutral.schemaVersion);
 });
 it('retains independent transforms and asset identity through sequence sampling and compact replay',()=>{
  reset();const rest=captureJointAngleRestReference(skin.skeleton,cfg);applyIndependentShoulderTargets(ref,'R',{AC:rotation(1,15),SC:rotation(2,-10)});const current=serializeCustomPose(skin.skeleton,cfg,variant);
  const resolved=resolveComposedMotion({startFrom:'current',holdUnmentioned:true,stance:'floating',keyframes:[{durationMs:900,targets:[{joint:'R_Forearm',motion:'elbowFlexion',targetDegrees:45}]}]},cfg);
  const rec=sampleComposedMotion(resolved,{baselinePose:neutral,currentPose:current,variantCfg:cfg,rest,skeletonHarness:{root,skinned:skin},sampleHz:30});
  const compact=compactRecording(rec,6);expect(compact.frames.length).toBeGreaterThan(20);
  for(const f of compact.frames){expect(f.pose.rigVersion).toBe(current.rigVersion);expect(f.pose.rigAssetSha256).toBe(current.rigAssetSha256);expect(angular(f.pose.bones.R_Scapula,current.bones.R_Scapula)).toBeLessThan(.002);applyCustomPose(skin.skeleton,cfg,f.pose);}
  expect(()=>applyCustomPose(skin.skeleton,cfg,{...current,rigAssetSha256:'other'})).toThrow(/identity/);
 });
 it('migrates external legacy clips without mutating them',()=>{
  reset();const source=clips[0],original=JSON.stringify(source.toJSON()),converted=migrateLegacyShoulderClip(source,ref);expect(JSON.stringify(source.toJSON())).toBe(original);expect(converted.tracks.length).toBe(source.tracks.length+4);
  const a=new THREE.AnimationMixer(legacyRoot),b=new THREE.AnimationMixer(root);a.clipAction(source).play();b.clipAction(converted).play();a.setTime(source.duration*.5);b.setTime(source.duration*.5);legacyRoot.updateMatrixWorld(true);root.updateMatrixWorld(true);
  for(const side of ['L','R'])expect(ref.bones.get(`${side}_Hand`)!.getWorldPosition(new THREE.Vector3()).distanceTo(buildBoneByPoseKey(legacySkin.skeleton,legacyCfg).get(`${side}_Hand`)!.getWorldPosition(new THREE.Vector3()))).toBeLessThan(2e-6);
  a.stopAllAction();b.stopAllAction();
 });
});
