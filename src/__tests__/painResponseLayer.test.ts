import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { buildBoneByPoseKey } from '../services/poseRig';
import { captureJointAngleRestReference, measureFingerFlexion } from '../services/jointAngles';
import { createPainResponseLayer, loadPainFaceData } from '../services/painResponseLayer';
import { PAIN_RESPONSE_PATTERNS, painResponseAt } from '../services/painResponse';
import { SkinContact } from '../services/skinContact';
import type { StageSceneContext } from '../services/stageSceneLayer';

describe.each(['male','female','neutral'] as const)('%s production pain response',variant=>{
  it('deforms the matching face, tightens both free hands, preserves the assessed limb and restores skin/bones exactly',async()=>{
    const bytes=readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`,import.meta.url));
    const {scene:root}=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
    applyAnatomicPose(root,BODY_VARIANTS[variant]);root.updateMatrixWorld(true);
    const skins:THREE.SkinnedMesh[]=[];root.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh)skins.push(o as THREE.SkinnedMesh);});
    const bones=buildBoneByPoseKey(skins[0].skeleton,BODY_VARIANTS[variant]);
    const rest=captureJointAngleRestReference(skins[0].skeleton,BODY_VARIANTS[variant]);
    const context:StageSceneContext={
      THREE,modelRoot:root,skinnedMesh:skins[0],bone:(key:string)=>bones.get(key)??null,
      scene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(),renderer:{} as THREE.WebGLRenderer,
      floorY:0,requestRender:()=>{},glideView:()=>{},onUserView:()=>()=>{},
    };
    const originals=skins.map(s=>s.geometry), positions=skins.map(s=>Array.from(s.geometry.getAttribute('position').array));
    const baseBones=new Map([...bones].map(([key,bone])=>[key,bone.quaternion.clone()]));
    const baseline=['L','R'].map(s=>measureFingerFlexion(bones,`${s}_Index1`,rest)!);
    const response=createPainResponseLayer(context,variant,await loadPainFaceData(variant));
    const contact=new SkinContact(root);
    expect(response.faceAvailable).toBe(variant!=='neutral');
    const strong=painResponseAt({intensity:10,expression:1,timeMs:1600,onsetMs:600,releaseMs:3000});
    for(let repeat=0;repeat<3;repeat++) {
      response.apply(strong,['L','R']);
      for(const key of ['Hips','Spine_Lower','Spine_Upper','Neck','Head','L_UpLeg','R_UpLeg']) expect(bones.get(key)!.quaternion.equals(baseBones.get(key)!)).toBe(true);
      for(const [i,side] of ['L','R'].entries()) {const curl=measureFingerFlexion(bones,`${side}_Index1`,rest)!;expect(curl,side).toBeGreaterThan(baseline[i]+10);expect(curl).toBeLessThanOrEqual(160);}
      if(variant!=='neutral') expect(skins.some((s,i)=>Array.from(s.geometry.getAttribute('position').array).some((x,v)=>x!==positions[i][v]))).toBe(true);
      contact.update();contact.finish();response.restore();contact.restore();
      skins.forEach((s,i)=>expect(Array.from(s.geometry.getAttribute('position').array)).toEqual(positions[i]));
      for(const [key,bone] of bones) expect(bone.quaternion.equals(baseBones.get(key)!)).toBe(true);
    }
    response.apply(strong,[]);
    for(const side of ['L','R']) expect(measureFingerFlexion(bones,`${side}_Index1`,rest)).toBe(baseline[side==='L'?0:1]);
    response.restore();
    // Every pattern leaves the unselected hand and whole axial/leg chains untouched.
    for(const pattern of PAIN_RESPONSE_PATTERNS) {
      const limitedMax=baseline[0]+8;
      response.apply(painResponseAt({intensity:10,expression:1,pattern:pattern.id,timeMs:900,onsetMs:600,releaseMs:3000}),['L'],{L_Index1:{fingerFlexion:{availableRange:{min:0,max:limitedMax}}}});
      expect(measureFingerFlexion(bones,'L_Index1',rest)).toBeLessThanOrEqual(limitedMax+1e-6);
      expect(measureFingerFlexion(bones,'R_Index1',rest)).toBe(baseline[1]);
      for(const key of ['Hips','Spine_Lower','Spine_Mid','Spine_Upper','Neck','Head','L_UpLeg','R_UpLeg']) expect(bones.get(key)!.quaternion.equals(baseBones.get(key)!)).toBe(true);
      response.restore();
      skins.forEach((s,i)=>expect(Array.from(s.geometry.getAttribute('position').array)).toEqual(positions[i]));
      for(const [key,bone] of bones) expect(bone.quaternion.equals(baseBones.get(key)!)).toBe(true);
    }
    contact.dispose();response.dispose();skins.forEach((s,i)=>expect(s.geometry).toBe(originals[i]));
  });
});
