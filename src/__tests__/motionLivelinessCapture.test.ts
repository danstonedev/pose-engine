import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {BODY_VARIANTS} from '../anatomy/bodyVariants';
import {applyAnatomicPose} from '../services/anatomicPose';
import {buildBoneByPoseKey} from '../services/poseRig';
import {createMotionLiveliness} from '../services/stageMotionLiveliness';
import {createBreathState} from '../services/stageBreath';

describe('public capture preserves rendered motion liveliness while sampling the driven pose',()=>{
 for(const variant of ['male','female','neutral'] as const)it(`${variant}: nested and failed reads restore all real rig transforms and overlay ownership`,async()=>{
  const bytes=readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`,import.meta.url));
  const root=(await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene,cfg=BODY_VARIANTS[variant];
  root.scale.setScalar(cfg.pose.rootScale);applyAnatomicPose(root,cfg);root.updateMatrixWorld(true);
  let skin:THREE.SkinnedMesh|undefined;root.traverse(node=>{if(!skin&&(node as THREE.SkinnedMesh).isSkinnedMesh)skin=node as THREE.SkinnedMesh;});
  const bones=buildBoneByPoseKey(skin!.skeleton,cfg),live=createMotionLiveliness(),breath=createBreathState();
  const state=()=>skin!.skeleton.bones.map(b=>({local:b.quaternion.toArray(),world:b.matrixWorld.toArray()}));
  const clean=state();live.apply(.8,.4,bones,root,breath,new THREE.Vector3(1,0,0),new THREE.Vector3(0,0,1));const shown=state(),phase=breath.phase,onset=live.onsetSec;
  expect(shown).not.toEqual(clean);
  const read=()=>live.sampleClean(bones,root,()=>state());
  expect(read()).toEqual(clean);expect(state()).toEqual(shown);
  expect(live.sampleClean(bones,root,()=>read())).toEqual(clean);expect(state()).toEqual(shown);
  expect(()=>live.sampleClean(bones,root,()=>{expect(state()).toEqual(clean);throw Error('capture failed');})).toThrow('capture failed');
  expect(state()).toEqual(shown);expect(breath.phase).toBe(phase);expect(live.onsetSec).toBe(onset);
  // A later ordinary render lift must still know which bones it owns.
  expect(live.undo(bones,root)).toBe(true);expect(state()).toEqual(clean);expect(live.undo(bones,root)).toBe(false);
  live.apply(.1,.4,bones,root,breath,new THREE.Vector3(1,0,0),new THREE.Vector3(0,0,1));
  const upper=bones.get('Spine_Upper')!,commanded=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),.2);upper.quaternion.copy(commanded);root.updateMatrixWorld(true);
  live.sampleClean(bones,root,()=>expect(upper.quaternion.toArray()).toEqual(commanded.toArray()));
  expect(upper.quaternion.toArray()).toEqual(commanded.toArray());
 });
});
