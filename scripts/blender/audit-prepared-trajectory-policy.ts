import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadHandRig} from '../../src/__tests__/handPlantCases';
import {BODY_VARIANTS} from '../../src/anatomy/bodyVariants';
import {applyCustomPose} from '../../src/services/poseRig';
import {BODY_ASSESSMENT_MOTIONS} from '../../src/services/assessmentBodyMotions';
import {resolveComposedMotion} from '../../src/services/motionSequence';
import {sampleComposedMotion} from '../../src/services/motionRecording';
import {setRomClampEnabled} from '../../src/services/poseRomClamp';
import * as Trajectory from '../../src/services/motionTrajectory';
import * as Frozen from './captured-motion-trajectory-exact-1';
const out=process.argv[2];if(!out)throw Error('Fresh output required');
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const names=['motionTrajectory','motionRecording','poseRomClamp','handContactPose','footContact'];
const identities=()=>Object.fromEntries(names.map(n=>[n,hash(readFileSync(new URL('../../src/services/'+n+'.ts',import.meta.url),'utf8'))]));
const report:any={sourceBefore:identities(),frozenSha256:hash(readFileSync(new URL('./captured-motion-trajectory-exact-1.ts',import.meta.url),'utf8')),romClamp:'off',cases:[]};
setRomClampEnabled(false);
const current=Trajectory.buildComposedTrajectory;let historical=false;
Object.defineProperty(Trajectory,'buildComposedTrajectory',{configurable:true,value:(...args:Parameters<typeof current>)=>(historical?Frozen.buildComposedTrajectory:current)(...args)});
for(const variant of ['male','female','neutral'] as const){
  const rig=await loadHandRig(variant as any),cfg=BODY_VARIANTS[variant];
  const sample=()=>{rig.root.position.copy(rig.rootRest0);rig.root.quaternion.copy(rig.rootQuat0);applyCustomPose(rig.skinned.skeleton,cfg,rig.baselinePose);rig.root.updateMatrixWorld(true);return sampleComposedMotion(resolveComposedMotion(BODY_ASSESSMENT_MOTIONS['extension-clearing']('R'),cfg),{baselinePose:rig.baselinePose,variantCfg:cfg,rest:rig.rest,skeletonHarness:{root:rig.root,skinned:rig.skinned},sampleHz:60});};
  historical=true;const before=sample();historical=false;const after=sample();
  const original=JSON.stringify(before.frames),candidate=JSON.stringify(after.frames),same=original===candidate;
  const result={variant,frames:before.frames.length,same,originalSha256:hash(original),candidateSha256:hash(candidate)};report.cases.push(result);console.log(JSON.stringify(result));
}
report.sourceAfter=identities();report.sourceStable=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});if(report.cases.some((r:any)=>!r.same))process.exitCode=1;
