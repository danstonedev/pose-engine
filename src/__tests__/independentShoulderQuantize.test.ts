import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const modelDirectory=fileURLToPath(new URL('../../models/',import.meta.url));
import {NodeIO} from '@gltf-transform/core';
import {EXTMeshoptCompression,KHRMeshQuantization} from '@gltf-transform/extensions';
import {quantize} from '@gltf-transform/functions';
import {MeshoptEncoder,MeshoptDecoder as CodecDecoder} from 'meshoptimizer';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {independentShoulderVariant,captureIndependentShoulderReference,applyIndependentShoulderTargets} from '../services/independentShoulderRig';
import {applyAnatomicPose} from '../services/anatomicPose';
const io=new NodeIO().registerExtensions([EXTMeshoptCompression,KHRMeshQuantization]).registerDependencies({'meshopt.decoder':CodecDecoder,'meshopt.encoder':MeshoptEncoder});
for(const variant of ['male','female','neutral'] as const)it(`${variant}: shoulder skin survives host quantization within 1 mm at neutral and articulated poses`,async()=>{
 await MeshoptEncoder.ready;const path=`${modelDirectory}painmap3D_${variant}.shoulder-v2.glb`,original=readFileSync(path),doc=await io.read(path);await doc.transform(quantize({quantizePosition:14,quantizeNormal:10,quantizeTexcoord:12,quantizeWeight:8,quantizeColor:8}));doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});const compressed=await io.writeBinary(doc);
 const rigs=[];
 for(const bytes of [original,compressed]){const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,'');const cfg=independentShoulderVariant(variant);applyAnatomicPose(gltf.scene,cfg);gltf.scene.updateMatrixWorld(true);let skin:THREE.SkinnedMesh=null!;gltf.scene.traverse(n=>{const s=n as THREE.SkinnedMesh;if(s.isSkinnedMesh&&(s.material as THREE.Material).name==='Std_Skin_Body')skin=s;});rigs.push({root:gltf.scene,skin,ref:captureIndependentShoulderReference(skin.skeleton,cfg)});}
 let worst=0;
 for(const elevation of [0,30,70]){
  for(const rig of rigs){for(const side of ['L','R'] as const)applyIndependentShoulderTargets(rig.ref,side,{SC:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),elevation*.3*Math.PI/180).toArray(),AC:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),elevation*.5*Math.PI/180).toArray(),GH:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),elevation*Math.PI/180).toArray()});rig.root.updateMatrixWorld(true);rig.skin.skeleton.update();}
  expect(rigs[0].skin.geometry.getAttribute('position').count).toBe(rigs[1].skin.geometry.getAttribute('position').count);
  for(let v=0;v<rigs[0].skin.geometry.getAttribute('position').count;v++){const points=rigs.map(r=>r.skin.getVertexPosition(v,new THREE.Vector3()).applyMatrix4(r.skin.matrixWorld));worst=Math.max(worst,points[0].distanceTo(points[1]));}
 }
 expect(worst).toBeLessThan(.001);console.log(`${variant} max quantized articulated skin displacement ${worst*1000} mm`);
});
