import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {BODY_VARIANTS} from '../../src/anatomy/bodyVariants';
import {buildFootPlant} from '../../src/services/footContact';
import {setRomClampEnabled} from '../../src/services/poseRomClamp';
import {computeJointAngles} from '../../src/services/jointAngles';
import {solveHandContactPose} from './captured-hand-solver-posture-cone-cauchy';
const [prefix,output]=process.argv.slice(2);
if(!prefix||!output)throw Error('Supply saved witness prefix and fresh output');
setRomClampEnabled(false);
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const sources=()=>Object.fromEntries(['handContactPose','poseRomClamp','footContact'].map(n=>[n,hash(readFileSync(new URL(`../../src/services/${n}.ts`,import.meta.url)))]));
const report:any={sourceBefore:sources(),scriptSha256:hash(readFileSync(new URL(import.meta.url))),solverSha256:hash(readFileSync(new URL('./captured-hand-solver-posture-cone-cauchy.ts',import.meta.url))),scope:'Offline conditional paired cone plus projected Cauchy candidate, same objective,40-step safety cap,damping and clinical bounds. Actual objective cost chooses among candidates.',cases:[]};
const bytes=readFileSync(new URL('../../models/painmap3D_male.runtime.glb',import.meta.url));
report.assetSha256=hash(bytes);
const root=(await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
let skin!:THREE.SkinnedMesh;root.traverse(n=>{if(!skin&&(n as THREE.SkinnedMesh).isSkinnedMesh)skin=n as THREE.SkinnedMesh;});
for(const delta of[0,-5e-8,5e-8]){
  const input=readFileSync(`${prefix}.male.${delta}.witness.json`),capture=JSON.parse(input.toString('utf8'));
  for(const [ordinal,w]of capture.witnesses.entries()){
    if(ordinal!==Number(process.argv[4]??0))continue;
    for(const entry of w.objects){const node=entry.path.reduce((n:THREE.Object3D,i:number)=>n.children[i]!,root);if(node.name!==entry.name)throw Error('Hierarchy mismatch');node.position.fromArray(entry.position);node.quaternion.fromArray(entry.quaternion);node.scale.fromArray(entry.scale);node.matrixAutoUpdate=entry.matrixAutoUpdate;node.matrix.fromArray(entry.matrix);}
    root.updateMatrixWorld(true);const solver=buildFootPlant(skin,w.canonicalKeys[0],BODY_VARIANTS.male)!;
    (globalThis as any).__hierarchyAudit=[];
    const result=solveHandContactPose(solver,new THREE.Vector3().fromArray(w.target),new THREE.Quaternion().fromArray(w.orientation),w.rest,w.constraints,w.elbowDirection?new THREE.Vector3().fromArray(w.elbowDirection):undefined,w.minimumElbowY,w.elbowFlexionRadians,w.posturePrior?.map((q:number[])=>new THREE.Quaternion().fromArray(q)));
    const nnls=(globalThis as any).__hierarchyAudit;
    const after=solver.ctx.bones.map(b=>b.quaternion.toArray());
    const base=report.cases.find((x:any)=>x.delta===0&&x.ordinal===ordinal);
    const differenceFromBase=base?Math.max(...after.map((q,i)=>{const d=new THREE.Quaternion().fromArray(q).normalize().conjugate().multiply(new THREE.Quaternion().fromArray(base.after[i]).normalize());return 2*Math.atan2(Math.hypot(d.x,d.y,d.z),Math.abs(d.w))*180/Math.PI;})):null;
    const measured=computeJointAngles(skin.skeleton,BODY_VARIANTS.male,'male',w.rest).joints;
    const elbowClearanceFromBoundM=w.minimumElbowY==null?null:solver.ctx.bones[1]!.getWorldPosition(new THREE.Vector3()).y-w.minimumElbowY;
    const row={measured,elbowClearanceFromBoundM,after,differenceFromBase,delta,ordinal,tMs:w.tMs,invocation:w.invocation,inputSha256:hash(input),exactSavedOutput:JSON.stringify(after)===JSON.stringify(w.after),result,nnls};
    report.cases.push(row);console.log(JSON.stringify({delta,ordinal,tMs:w.tMs,exactSavedOutput:row.exactSavedOutput,result,differenceFromBase,elbowClearanceFromBoundM,elbow:measured.L_Forearm,wrist:measured.L_Hand,subproblems:nnls.length,secondaryAccepted:nnls.filter((v:any)=>v.secondaryAccepted).length,maximumPrimaryIncrease:Math.max(0,...nnls.map((v:any)=>v.primaryAfterSecondary-v.primaryBeforeSecondary)),maximumLinearLeak:Math.max(0,...nnls.map((v:any)=>v.linearPrimaryLeak))}));
  }
}
report.sourceAfter=sources();report.sourceStable=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
