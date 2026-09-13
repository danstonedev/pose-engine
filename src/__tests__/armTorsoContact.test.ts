import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { buildBoneByPoseKey, buildIKChainContext, serializeCustomPose, applyCustomPose } from '../services/poseRig';
import { solveArmChainWithRhythm } from '../services/poseScapulohumeral';
import { createArmTorsoContact } from '../services/armTorsoContact';

describe.each(['male','female'] as const)('%s arm/torso diagnostic', variant => {
  const cfg=BODY_VARIANTS[variant];
  let root: THREE.Object3D, skin: THREE.SkinnedMesh;
  let bones: ReturnType<typeof buildBoneByPoseKey>;
  let baseline: ReturnType<typeof serializeCustomPose>;
  let rest: ReturnType<typeof captureJointAngleRestReference>;
  let contact: NonNullable<ReturnType<typeof createArmTorsoContact>>;
  let rootQuat: THREE.Quaternion, rootPosition: THREE.Vector3;
  beforeAll(async()=>{
    const b=readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`,import.meta.url));
    const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
    root=gltf.scene;root.scale.setScalar(cfg.pose.rootScale);
    root.traverse(o=>{if(!skin&&(o as THREE.SkinnedMesh).isSkinnedMesh)skin=o as THREE.SkinnedMesh;});
    applyAnatomicPose(root,cfg);root.updateMatrixWorld(true);
    bones=buildBoneByPoseKey(skin.skeleton,cfg);
    baseline=serializeCustomPose(skin.skeleton,cfg,variant);
    rest=captureJointAngleRestReference(skin.skeleton,cfg);
    rootQuat=root.quaternion.clone();rootPosition=root.position.clone();
    contact=createArmTorsoContact(root)!;
  });
  beforeEach(()=>{
    root.quaternion.copy(rootQuat);root.position.copy(rootPosition);
    applyCustomPose(skin.skeleton,cfg,baseline);root.updateMatrixWorld(true);contact.refresh();
  });
  function crossBody(side:'L'|'R'){
    const hand=bones.get(`${side}_Hand`)!;
    const target=new THREE.Vector3(side==='L'?-.13:.13,1.58,.02);
    solveArmChainWithRhythm(buildIKChainContext(skin,hand,3,cfg)!,buildIKChainContext(skin,hand,2,cfg)!,target,{rest,recoverStalledReach:true});
    root.updateMatrixWorld(true);
    return hand.getWorldPosition(new THREE.Vector3()).distanceTo(target);
  }
  it.each(['L','R'] as const)('%s: excludes the neutral shoulder attachment seam',side=>{
    const report=contact.inspect(side);
    expect(report.samples).toBeGreaterThan(500);
    expect(report.penetratingPoints).toBe(0);
  });
  it.each(['L','R'] as const)('%s: a zero-error endpoint still fails torso contact',side=>{
    expect(crossBody(side)).toBeLessThan(.001);
    const report=contact.inspect(side);
    expect(report.penetrationM).toBeGreaterThan(.005);
    expect(report.penetratingPoints).toBeGreaterThan(5);
    expect(report.worstPoint).not.toBeNull();
  });
  it('the refreshed envelope follows a turned and translated body',()=>{
    crossBody('R');const before=contact.inspect('R').penetrationM;
    root.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2));
    root.position.x+=.5;root.updateMatrixWorld(true);contact.refresh();
    expect(contact.inspect('R').penetrationM).toBeCloseTo(before,6);
  });
});

it('reports an unavailable body model instead of silently passing contact',()=>{
  expect(createArmTorsoContact(new THREE.Group())).toBeNull();
});
