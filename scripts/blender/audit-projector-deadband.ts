import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {clampBoneToRom,clampMeasuredPatientHinge,inspectClinicalAngles} from '../../src/services/poseRomClamp';
import {clampBoneToRom as continuousClamp} from './captured-continuous-rom-clamp';
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const witnessBytes=readFileSync('../../remaining-batches/pressup-guide-sensitivity-12.json.neutral.0.witness.json');
const witness=JSON.parse(witnessBytes.toString()).witnesses[0];
const asset=readFileSync(new URL('../../models/painmap3D_neutral.runtime.glb',import.meta.url));
const root=(await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(asset.buffer.slice(asset.byteOffset,asset.byteOffset+asset.byteLength),'')).scene;
for(const e of witness.objects){const n=e.path.reduce((n:THREE.Object3D,i:number)=>n.children[i]!,root);n.position.fromArray(e.position);n.quaternion.fromArray(e.quaternion);n.scale.fromArray(e.scale);n.matrixAutoUpdate=e.matrixAutoUpdate;n.matrix.fromArray(e.matrix);}root.updateMatrixWorld(true);
const bones:THREE.Bone[]=witness.boneNames.map((n:string)=>root.getObjectByName(n));
const angle=(a:THREE.Quaternion,b:THREE.Quaternion)=>{let q=a.clone().normalize().conjugate().multiply(b.clone().normalize());return 2*Math.atan2(Math.hypot(q.x,q.y,q.z),Math.abs(q.w))*180/Math.PI;};
const restore=(q:number[][])=>{bones.forEach((b,i)=>b.quaternion.fromArray(q[i]!));root.updateMatrixWorld(true);};
const clone=()=>bones.map(b=>b.quaternion.clone());
const report:any={scope:'Exact saved1083ms guide output; same limits and projection ordering. Local quaternion-axis perturbations test projector continuity independently of solver.',assetSha256:digest(asset),witnessSha256:digest(witnessBytes),cases:[]};
for(const mode of ['deadband','continuous']){
const project=()=>{for(let i=bones.length-1;i>=0;i--){(mode==='deadband'?clampBoneToRom:continuousClamp)(bones[i],witness.canonicalKeys[i],witness.rest,witness.constraints,true);if(i+1<bones.length)clampMeasuredPatientHinge(bones[i+1]!,bones[i]!,witness.canonicalKeys[i],witness.rest,witness.constraints);}root.updateMatrixWorld(true);};
restore(witness.after);project();const first=clone();project();const base=clone(),baseArrays=base.map(q=>q.toArray()),p=bones[0]!.getWorldPosition(new THREE.Vector3());
const row:any={mode,idempotenceDeg:Math.max(...first.map((q,i)=>angle(q,base[i]!))),joint:inspectClinicalAngles(bones[3],'L_Shoulder',witness.rest,witness.constraints),probes:[]};
for(const stepDeg of [1e-9,1e-8,1e-7,1e-6,1e-5,1e-4,.001])for(let axis=0;axis<3;axis++)for(const sign of[-1,1]){
restore(baseArrays);bones[3]!.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().setComponent(axis,1),sign*stepDeg*Math.PI/180));project();const output=clone(),delta=bones[0]!.getWorldPosition(new THREE.Vector3()).sub(p);
row.probes.push({stepDeg,axis,sign,maximumTurnDeg:Math.max(...base.map((q,i)=>angle(q,output[i]!))),wristDisplacementM:delta.length(),wristSecantMPerRad:delta.length()/(stepDeg*Math.PI/180),rotation:inspectClinicalAngles(bones[3],'L_Shoulder',witness.rest,witness.constraints)?.raw.rotation});
}report.cases.push(row);
}
writeFileSync(process.argv[2]!,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report.cases.map((c:any)=>({mode:c.mode,idempotenceDeg:c.idempotenceDeg,worst:c.probes.toSorted((a:any,b:any)=>b.wristSecantMPerRad-a.wristSecantMPerRad)[0]})),null,2));

