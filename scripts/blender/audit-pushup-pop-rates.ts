import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { loadHandRig, HAND_CASES } from '../../src/__tests__/handPlantCases';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { resolveComposedMotion } from '../../src/services/motionSequence';
const out=process.argv[2];if(!out)throw Error('Fresh output required');
const names=['rootMotion','motionRecording','motionSequence','motionTrajectory','poseRomClamp','jointAngles','footContact'];
const hashes=()=>Object.fromEntries(names.map(n=>[n,createHash('sha256').update(readFileSync(new URL('../../src/services/'+n+'.ts',import.meta.url))).digest('hex')]));
const report:any={scope:'Legacy standing-to-push-up, male. Rate-scaled local angular increments and wrist displacement around historical120Hz pop; this does not establish contact/clinical acceptance.',sourceBefore:hashes(),cases:[]};
let durationMs:number|undefined;
for(const hz of [120,240,480]){
 const rig=await loadHandRig('male'),cfg=BODY_VARIANTS.male;
 const resolved=resolveComposedMotion(HAND_CASES['push-up']!.make() as any,cfg);
 const frameTimesMs=durationMs===undefined?undefined:Array.from({length:Math.ceil(durationMs*hz/1000)+1},(_,i)=>Math.min(durationMs!,i*1000/hz));
 const rec=sampleComposedMotion(resolved,{baselinePose:rig.baselinePose,variantCfg:cfg,rest:rig.rest,skeletonHarness:{root:rig.root,skinned:rig.skinned},sampleHz:120,frameTimesMs});
 durationMs=rec.frames.at(-1)!.tMs;
 for(const bone of ['L_UpperArm','R_UpperArm']){
  const turns=[0,...rec.frames.slice(1).map((f,i)=>new THREE.Quaternion().fromArray(rec.frames[i]!.pose.bones[bone]!).normalize().angleTo(new THREE.Quaternion().fromArray(f.pose.bones[bone]!).normalize())*180/Math.PI)];
  const pop=turns.map((v,i)=>i?v-Math.max(turns[i-1]??0,turns[i+1]??0):0);
  const band=rec.frames.map((f,i)=>({f,i})).filter(x=>x.f.tMs>4000&&x.f.tMs<4200);
  const index=band.reduce((best,x)=>pop[x.i]!>pop[best]!?x.i:best,band[0]!.i);
  const globalIndex=pop.indexOf(Math.max(...pop));
  report.cases.push({hz,bone,frames:rec.frames.length,globalPopDeg:Math.max(...pop),globalAt:rec.frames[globalIndex]!.tMs,bandPopDeg:pop[index],at:rec.frames[index]!.tMs,
   around:rec.frames.map((f,i)=>({f,i})).filter(x=>Math.abs(x.f.tMs-rec.frames[index]!.tMs)<=30).map(({f,i})=>({tMs:f.tMs,turnDeg:turns[i],speedDegSec:turns[i]!*hz,q:f.pose.bones[bone],wrist:f.worldTracks?.[bone[0]+'_Hand'],root:f.root,grounding:f.grounding}))});
 }
}
report.sourceAfter=hashes();report.sourceStable=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report.cases.map(({around,...rest}:any)=>rest)));
