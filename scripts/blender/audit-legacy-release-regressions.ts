/** Read-only diagnosis of legacy release gates; runtime overrides stay in this process. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { loadHandRig, HAND_CASES } from '../../src/__tests__/handPlantCases';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyCustomPose } from '../../src/services/poseRig';
import { buildSquat } from '../../src/services/movementTemplates';
import { buildTravelWalk } from '../../src/services/movementLocomotion';
import { resolveComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import * as Root from '../../src/services/rootMotion';

const out = process.argv[2]; if (!out) throw Error('Fresh output required');
const names = ['rootMotion','motionRecording','motionSequence','motionTrajectory','poseRomClamp','jointAngles'];
const hashes = () => Object.fromEntries(names.map(n => [n, createHash('sha256').update(readFileSync(new URL('../../src/services/'+n+'.ts',import.meta.url))).digest('hex')]));
const report:any = {sourceBefore:hashes(), scope:'Actual unchanged recipes. Raw and normalized quaternion measurement; process-local removal of gait metadata only for differential diagnosis.', cases:[]};
let dropGait = false;
for (const key of ['rotateRestReferenceByRoot','rotateRestReferenceByPelvis'] as const) {
  const fn = Root[key]; Object.defineProperty(Root,key,{configurable:true,value:(...args:any[])=>{
    const value = (fn as any)(...args); return dropGait ? {...value,gaitLegFrames:undefined}:value;
  }});
}
for (const variant of ['male','female'] as const) {
  const rig = await loadHandRig(variant), cfg=BODY_VARIANTS[variant];
  const sample = (motion:any,hz:number) => {
    rig.root.position.copy(rig.rootRest0); rig.root.quaternion.copy(rig.rootQuat0);
    applyCustomPose(rig.skinned.skeleton,cfg,rig.baselinePose); rig.root.updateMatrixWorld(true);
    return sampleComposedMotion(resolveComposedMotion(motion,cfg),{baselinePose:rig.baselinePose,variantCfg:cfg,rest:rig.rest,skeletonHarness:{root:rig.root,skinned:rig.skinned},sampleHz:hz});
  };
  if (variant==='male') {
    const squat=sample(buildSquat(),60), base=new THREE.Quaternion().fromArray(squat.frames[0]!.pose.bones.Head!);
    report.cases.push({variant,case:'squat Head',frames:squat.frames.length,base:base.toArray(),norm:base.length(),maxRawDeg:Math.max(...squat.frames.map(f=>base.angleTo(new THREE.Quaternion().fromArray(f.pose.bones.Head!))*180/Math.PI)),maxNormalizedDeg:Math.max(...squat.frames.map(f=>base.clone().normalize().angleTo(new THREE.Quaternion().fromArray(f.pose.bones.Head!).normalize())*180/Math.PI)),maxComponentChange:Math.max(...squat.frames.flatMap(f=>f.pose.bones.Head!.map((v,i)=>Math.abs(v-base.toArray()[i]!))))});
    const pushup=sample(HAND_CASES['push-up']!.make(),120);
    for(const bone of ['L_UpperArm','R_UpperArm']) {
      const turns=(normalize:boolean)=>[0,...pushup.frames.slice(1).map((f,i)=>{const a=new THREE.Quaternion().fromArray(pushup.frames[i]!.pose.bones[bone]!),b=new THREE.Quaternion().fromArray(f.pose.bones[bone]!);if(normalize){a.normalize();b.normalize();}return a.angleTo(b)*180/Math.PI;})];
      const raw=turns(false),normal=turns(true),pop=(v:number[])=>v.map((n,i)=>i?n-Math.max(v[i-1]??0,v[i+1]??0):0);
      const rp=pop(raw),np=pop(normal),index=rp.indexOf(Math.max(...rp));
      report.cases.push({variant,case:'push-up',bone,rawPopDeg:Math.max(...rp),normalizedPopDeg:Math.max(...np),rawMaxAt:pushup.frames[index]!.tMs,around:[index-1,index,index+1].map(i=>({time:pushup.frames[i]!.tMs,q:pushup.frames[i]!.pose.bones[bone],raw:raw[i],normalized:normal[i]}))});
    }
  } else {
    const motion=buildTravelWalk();
    dropGait=false; const current=sample(motion,30);
    dropGait=true; const omitted=sample(motion,30); dropGait=false;
    let maxDeg=0,maxPositionM=0,worst:any=null;
    for(let i=0;i<current.frames.length;i++)for(const key of Object.keys(current.frames[i]!.pose.bones)){
      const a=current.frames[i]!.pose.bones[key]!,b=omitted.frames[i]!.pose.bones[key]!;
      const d=new THREE.Quaternion().fromArray(a).normalize().angleTo(new THREE.Quaternion().fromArray(b).normalize())*180/Math.PI;
      if(d>maxDeg){maxDeg=d;worst={time:current.frames[i]!.tMs,key};}
      const p=current.frames[i]!.worldTracks?.[key],q=omitted.frames[i]!.worldTracks?.[key]; if(p&&q)maxPositionM=Math.max(maxPositionM,Math.hypot(...p.map((v,j)=>v-q[j]!)));
    }
    report.cases.push({variant,case:'walk',counterfactual:'omit gait metadata from rebased rest',frames:current.frames.length,maxDeg,maxPositionM,worst});
  }
}
report.sourceAfter=hashes();report.sourceStable=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report.cases));
