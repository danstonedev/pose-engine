import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { digest, identity, referenceIdentity, makeBaseline, contextKey, jointKey, reviewKey, observationKey, evaluateCatalogue, checkRules, sourceHash, readMaster, checkSnapshotSources } from './gate.mjs';
import { migrateProgram } from './reconcile.mjs';

const ids=['Hips','Spine_Lower','Spine_Mid','Spine_Upper','Neck_Lower','Neck','Head','bone:twist'];
const zero={localRotationExcursionDeg:0,worldRotationExcursionDeg:0,worldPositionExcursionM:0,localAngularPathDeg:0,worldPositionPathM:0};
function fixture(){
  const definition={motions:[{name:'fixture',keyframes:[{durationMs:1000,targets:[]}]}],targets:[],phases:[],contacts:[]},definitionId=digest(definition);
  const old={id:'historical',variant:'male',side:'left',available:true,definitionId},context={...old,id:'candidate'};
  const data={schemaVersion:2,rigs:{male:{sha256:'fixture-rig',bones:ids.map(id=>({id,raw:id}))}},hashes:{'pose-engine/src/services/solver.ts':'fixture'},definitions:{[definitionId]:definition},contexts:[old]};
  const baseline=makeBaseline(data),baselineDigest=digest(baseline);data.enforcement={baseline};data.contexts.push(context);
  for(const item of data.contexts)item.identity=identity(data,item);
  const root=mkdtempSync(resolve(tmpdir(),'catalogue-gate-')),tracking={},currentIdentity=identity(data,context);
  writeFileSync(resolve(root,'fixture.blend'),'test fixture, not a Blender review');
  const artifact={path:'fixture.blend',sha256:digest(readFileSync(resolve(root,'fixture.blend')))};
  const comparison={kind:'reference-comparison',result:'pass',context:contextKey(context),identity:currentIdentity,referenceId:'fixture-reference',criterionId:'fixture-comparison',claimIds:['fixture-claim'],reviewer:'unit-test',method:'qualitative',scope:'Synthetic fixture only',comparison:{expected:'Synthetic protocol',observed:'Synthetic gate case',limitations:'No real movement approval'},artifacts:[artifact]};
  const comparisonBytes=JSON.stringify(comparison);writeFileSync(resolve(root,'reference-comparison.json'),comparisonBytes);
  const comparisonArtifact={path:'reference-comparison.json',sha256:digest(comparisonBytes)};
  data.program=migrateProgram(undefined,data.contexts);
  data.program.references.push({id:'fixture-reference',type:'protocol',title:'Synthetic gate reference',status:'verified',provenance:{locator:'Synthetic fixture; no clinical claims'},scope:{motionIds:['candidate'],bodies:[],sides:[],phases:[],paths:[],joints:[]},claims:[{id:'fixture-claim',description:'Synthetic coordination comparison',kind:'protocol',joints:[],phases:[],limitations:'Gate regression only'}],conditions:'Synthetic fixture only',limitations:'No real movement approval',verification:{method:'Synthetic test verifier',evidence:[artifact]},gaps:[]});
  comparison.referenceIdentity=referenceIdentity(data.program.references[0]);
  const currentComparisonBytes=JSON.stringify(comparison);writeFileSync(resolve(root,'reference-comparison.json'),currentComparisonBytes);comparisonArtifact.sha256=digest(currentComparisonBytes);
  const coverage=data.program.coverage.find(item=>item.motionId==='candidate');coverage.referenceIds=['fixture-reference'];coverage.referenceStatus='partial';
  const reports=['blender','roundtrip','skin-contact','native','simlab','simmove'].map(stage=>{
    const path=`${stage}.json`,manifest={stage,result:'pass',context:contextKey(context),identity:currentIdentity,scope:'All fixture phases; synthetic gate test only',reviewer:'unit-test',toolVersion:'fixture',phases:['setup','transitions','hold','return','loop'],artifacts:[{kind:'editable-project',path:'fixture.blend',sha256:digest(readFileSync(resolve(root,'fixture.blend')))}]};
    const bytes=JSON.stringify(manifest);writeFileSync(resolve(root,path),bytes);return{stage,path,sha256:digest(bytes)};
  });
  tracking[reviewKey(context)]={identity:currentIdentity,nativeRequired:true,reports,referenceAcceptance:{referenceIds:['fixture-reference'],criteria:[{id:'fixture-comparison',description:'Compare synthetic protocol',referenceId:'fixture-reference',claimIds:['fixture-claim'],result:'pass',evidence:[comparisonArtifact]}],reviewer:'unit-test',limitations:'Synthetic gate check only'}};
  tracking[observationKey(context)]={context:contextKey(context),identity:currentIdentity,rigSha256:'fixture-rig',sampleHz:30,frameCount:31,complete:true,metrics:Object.fromEntries(ids.map(id=>[id,{...zero}]))};
  for(const id of ids)tracking[jointKey(context,id)]={identity:currentIdentity,requiredRole:'held',status:'verified',note:'Explicit stabilization',evidence:'synthetic manifest fixture',rules:[{metric:'localRotationExcursionDeg',max:1}]};
  const evaluate=extra=>evaluateCatalogue(data,tracking,{engineRoot:root,baselineDigest,...extra});
  const clean=()=>{const rel=relative(tmpdir(),root);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true});};
  return{data,context,tracking,root,evaluate,clean};
}
function rejected(name,mutate,pattern){test(name,()=>{const f=fixture();try{mutate(f);const result=f.evaluate();assert.equal(result.pass,false);assert.match(JSON.stringify(result.errors),pattern);}finally{f.clean();}});}
test('complete scoped fixture passes, historical motion remains explicitly unreviewed',()=>{const f=fixture();try{const result=f.evaluate();assert.equal(result.pass,true,JSON.stringify(result.errors));assert.equal(result.changedContexts,1);assert.equal(result.historicalContexts,1);}finally{f.clean();}});
rejected('new movement requires a context review',f=>delete f.tracking[reviewKey(f.context)],/missing or stale context review/);
rejected('head cannot disappear from whole-body requirements',f=>delete f.tracking[jointKey(f.context,'Head')],/Head: missing required role/);
rejected('twist helpers require roles too',f=>delete f.tracking[jointKey(f.context,'bone:twist')],/bone:twist: missing required role/);
rejected('verified dropdown with evidence prose does not satisfy measurements',f=>delete f.tracking[observationKey(f.context)],/actual-rig trajectory observations/);
rejected('held role requires a measured excursion ceiling',f=>f.tracking[jointKey(f.context,'Head')].rules=[],/stabilization requires/);
rejected('derived role requires an identified controller owner',f=>f.tracking[jointKey(f.context,'Head')].requiredRole='derived',/derived controller owner/);
rejected('contact role requires positional bounds',f=>f.tracking[jointKey(f.context,'Head')].requiredRole='contact',/world-position constraint/);
rejected('observed trajectory must satisfy declared constraints',f=>f.tracking[observationKey(f.context)].metrics.Head.localRotationExcursionDeg=12,/outside/);
rejected('old-rig observations are rejected',f=>f.tracking[observationKey(f.context)].rigSha256='old',/actual-rig trajectory observations/);
rejected('incomplete samples are rejected',f=>f.tracking[observationKey(f.context)].frameCount=1,/actual-rig trajectory observations/);
rejected('nonfinite sampling rates are rejected',f=>f.tracking[observationKey(f.context)].sampleHz=undefined,/actual-rig trajectory observations/);
rejected('full spine segment coverage is mandatory',f=>f.data.rigs.male.bones=f.data.rigs.male.bones.filter(b=>b.id!=='Neck_Lower'),/Full axial chain omitted/);
rejected('refresh cannot rewrite the frozen historical baseline',f=>f.data.enforcement.baseline=makeBaseline(f.data),/baseline.*rewritten/);
rejected('missing host evidence is rejected',f=>f.tracking[reviewKey(f.context)].reports=f.tracking[reviewKey(f.context)].reports.filter(r=>r.stage!=='simmove'),/missing simmove evidence/);
rejected('native applicability cannot be omitted',f=>delete f.tracking[reviewKey(f.context)].nativeRequired,/native applicability/);
rejected('production gate requires reference comparison as well as motion evidence',f=>delete f.tracking[reviewKey(f.context)].referenceAcceptance,/missing referenceAcceptance/);
function editComparison(f, mutate) {
  const path=resolve(f.root,'reference-comparison.json'),manifest=JSON.parse(readFileSync(path,'utf8'));mutate(manifest);
  const bytes=JSON.stringify(manifest);writeFileSync(path,bytes);
  f.tracking[reviewKey(f.context)].referenceAcceptance.criteria[0].evidence[0].sha256=digest(bytes);
}
rejected('rehashed reference evidence cannot claim a different context',f=>editComparison(f,manifest=>manifest.context='["other","male","left"]'),/different reference\/criterion\/context/);
rejected('comparison evidence becomes stale when its scientific reference changes',f=>f.data.program.references[0].claims[0].description='Revised supported claim',/different reference\/criterion\/context/);
rejected('reference comparison requires retained underlying captures or data',f=>editComparison(f,manifest=>manifest.artifacts=[]),/retained underlying/);
rejected('quantitative comparisons evaluate measured values against justified bounds',f=>editComparison(f,manifest=>{
  manifest.method='quantitative';manifest.measurements=[{metric:'fixture-angle',value:10,min:0,max:1,units:'degrees',thresholdBasis:'Synthetic fixture range',claimIds:['fixture-claim']}];
}),/outside 0\.\.1/);
rejected('production gate rejects unresolved scoped blocking defects',f=>{
  const scope={motionIds:['candidate'],bodies:[],sides:[],phases:[],paths:[],joints:[]},artifact={path:'fixture.blend',sha256:digest(readFileSync(resolve(f.root,'fixture.blend')))};
  f.data.program.sources.push({id:'s',title:'Synthetic finding source',origin:'test',status:'inspected',snapshot:artifact,scope:'Fixture only'});
  f.data.program.findings.push({id:'finding',sourceId:'s',locator:'fixture',summary:'Synthetic failure',disposition:'linked',defectIds:['defect'],reason:'',evidence:[]});
  f.data.program.defects.push({id:'defect',title:'Synthetic unresolved failure',category:'coordination',severity:'high',status:'open',scope,findingIds:['finding'],owner:'test',expected:'Fix the fixture',acceptance:['Current comparison passes'],nextAction:'Fix fixture',dependencies:[],blocking:true,closures:[]});
  f.data.program.coverage.find(item=>item.motionId==='candidate').defectIds=['defect'];
},/unresolved blocking defect defect/);
rejected('hash-changed artifacts are rejected',f=>writeFileSync(resolve(f.root,'fixture.blend'),'modified'),/changed.*artifact/);
rejected('external evidence paths are rejected',f=>f.tracking[reviewKey(f.context)].reports[0].path='../outside.json',/outside repository or missing/);
rejected('phase failures cannot be hidden by full-motion approval',f=>f.tracking[jointKey(f.context,'Head','0')]={identity:f.context.identity,status:'issue',rules:[]},/phase 0: unresolved/);
test('fresh CI observations override a passing stored summary',()=>{const f=fixture();try{const observed=structuredClone(f.tracking[observationKey(f.context)]);observed.metrics.Head.localRotationExcursionDeg=25;assert.equal(f.evaluate({freshObservations:{[contextKey(f.context)]:observed}}).pass,false);}finally{f.clean();}});
test('bounds must be finite, meaningful and available in measured metrics',()=>{
  assert.ok(checkRules([{metric:'missing',min:1}],{}).length);
  assert.ok(checkRules([{metric:'a',min:2,max:1}],{a:1}).length);
  assert.ok(checkRules([{metric:'a',max:Infinity}],{a:1}).length);
  assert.deepEqual(checkRules([{metric:'a',min:0,max:1}],{a:0.5}),[]);
});
test('text source identities survive Windows and Linux line endings',()=>assert.equal(sourceHash(Buffer.from('a\r\nb\r\n')),sourceHash(Buffer.from('a\nb\n'))));
test('committed inventory contains every actual skin bone and detects source drift',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const {data}=readMaster(root);assert.deepEqual(checkSnapshotSources(data,{engine:root}),[]);
  data.rigs.male.bones.pop();assert.match(checkSnapshotSources(data,{engine:root}).join('\n'),/Incomplete actual male skeleton/);
  data.hashes['pose-engine/src/services/poseRig.ts']='stale';assert.match(checkSnapshotSources(data,{engine:root}).join('\n'),/stale source inventory/);
});
