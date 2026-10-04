import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { digest, identity, referenceIdentity, makeBaseline, contextKey, jointKey, reviewKey, observationKey, evaluateCatalogue, checkRules, sourceHash, readMaster, checkSnapshotSources, runtimeSources, requiredContexts } from './gate.mjs';
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
test('contact can declare measured horizontal anchoring separately from the required skin review',()=>{
  const f=fixture();try {
    Object.assign(f.tracking[jointKey(f.context,'Hips')],{requiredRole:'contact',rules:[{metric:'worldHorizontalPositionExcursionM',max:.001}]});
    f.tracking[observationKey(f.context)].metrics.Hips.worldHorizontalPositionExcursionM=0;
    assert.equal(f.evaluate().pass,true,JSON.stringify(f.evaluate().errors));
    f.tracking[observationKey(f.context)].metrics.Hips.worldHorizontalPositionExcursionM=.002;
    assert.equal(f.evaluate().pass,false);
    f.tracking[observationKey(f.context)].metrics.Hips.worldHorizontalPositionExcursionM=0;
    f.tracking[reviewKey(f.context)].reports=f.tracking[reviewKey(f.context)].reports.filter(report=>report.stage!=='skin-contact');
    assert.match(JSON.stringify(f.evaluate().errors),/missing skin-contact evidence/);
  }finally{f.clean();}
});
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

function deliveryFixture() {
  const f=fixture(), review=f.tracking[reviewKey(f.context)];
  delete f.tracking[reviewKey(f.context)];
  f.data.hashes['pose-engine/src/services/solver.ts']='changed shared implementation';
  for(const context of f.data.contexts) context.identity=identity(f.data,context);
  for(const record of Object.values(f.tracking)) record.identity=f.context.identity;
  for(const id of ids) f.tracking[jointKey(f.context,id)].status='todo';
  const reports=review.reports.filter(report=>report.stage!=='native');
  for(const report of reports) {
    const manifest=JSON.parse(readFileSync(resolve(f.root,report.path),'utf8'));manifest.identity=f.context.identity;
    const bytes=JSON.stringify(manifest);writeFileSync(resolve(f.root,report.path),bytes);report.sha256=digest(bytes);
  }
  f.data.program.workUnits.push({id:'native-follow-up',title:'Native remains open',owner:'fixture',branch:'fixture',nextAction:'Verify physics separately',status:'ready',
    scope:{motionIds:['candidate'],bodies:[],sides:[],phases:[],paths:[],joints:[]},defectIds:[],referenceIds:[],files:[],dependsOn:[]});
  const sharedIdentity=digest(runtimeSources(f.data.hashes)), artifact={path:'fixture.blend',sha256:digest(readFileSync(resolve(f.root,'fixture.blend')))};
  const regression={kind:'authored-playback-regression',identity:sharedIdentity,result:'pass',reviewer:'fixture',scope:'Exact synthetic release scope',limitations:'No clinical or native qualification',
    contexts:[contextKey(f.context)],checks:['clinical-patient-bounds','contact-continuity','shared-runtime-regression'].map(id=>({id,result:'pass',scope:'Synthetic test only',observed:'Fixture constraints pass',evidence:[artifact]})),artifacts:[artifact]};
  const bytes=JSON.stringify(regression);writeFileSync(resolve(f.root,'delivery-regression.json'),bytes);
  f.data.enforcement.delivery={version:1,mode:'authored-playback',qualification:'unqualified',identity:sharedIdentity,reviewer:'fixture',scope:'One authored context; shared changes remain visible',limitations:'No whole-programme acceptance',
    native:{status:'deferred',reason:'Separate native qualification remains open',workUnitIds:['native-follow-up']},openDefectIds:[],
    contexts:[{context:contextKey(f.context),identity:f.context.identity,limitations:'Not clinically qualified',reports}],regression:{path:'delivery-regression.json',sha256:digest(bytes)}};
  return f;
}
function deliveryRejected(name,mutate,pattern){test(name,()=>{const f=deliveryFixture();try{mutate(f);const result=f.evaluate();assert.equal(result.pass,false);assert.match(JSON.stringify(result.errors),pattern);}finally{f.clean();}});}
test('explicit current authored delivery preserves shared impact without granting qualification',()=>{
  const f=deliveryFixture();try {
    const result=f.evaluate();assert.equal(result.pass,true,JSON.stringify(result.errors));
    assert.equal(result.changedContexts,2);assert.equal(result.deliveryContexts,1);assert.equal(result.reviewedContexts,0);
    assert.equal(result.unqualifiedAffectedContexts,1);assert.equal(result.historicalContexts,0);
    assert.deepEqual(requiredContexts(f.data,f.tracking).map(contextKey),[contextKey(f.context)]);
    assert.equal(f.data.enforcement.delivery.native.status,'deferred');
  } finally { f.clean(); }
});
deliveryRejected('delivery cannot omit a directly changed or newly enabled context',f=>f.data.enforcement.delivery.contexts=[],/omits directly changed or newly available/);
deliveryRejected('delivery cannot omit a newly changed existing definition',f=>{
  const definition={motions:[{name:'changed historical'}]},definitionId=digest(definition);
  f.data.definitions[definitionId]=definition;f.data.contexts[0].definitionId=definitionId;f.data.contexts[0].identity=identity(f.data,f.data.contexts[0]);
},/omits directly changed or newly available.*historical/);
deliveryRejected('delivery scope cannot contain duplicates',f=>f.data.enforcement.delivery.contexts.push(f.data.enforcement.delivery.contexts[0]),/Duplicate delivery context/);
deliveryRejected('delivery cannot reuse evidence after shared source changes',f=>f.data.enforcement.delivery.identity='old',/stale shared-source identity/);
deliveryRejected('delivery does not bypass baseline retention',f=>f.data.enforcement.baseline=makeBaseline(f.data),/baseline.*rewritten/);
deliveryRejected('delivery keeps current all-bone measurements',f=>delete f.tracking[observationKey(f.context)].metrics.Head,/Head: missing or nonfinite/);
deliveryRejected('delivery keeps current declared contact and role constraints',f=>f.tracking[observationKey(f.context)].metrics.Head.localRotationExcursionDeg=5,/outside/);
function deferDrivenConstraint(f) {
  Object.assign(f.tracking[jointKey(f.context,'Head')], {requiredRole:'driven',rules:[],constraintStatus:'unqualified',
    constraintReason:'No reference-supported excursion range has been established; this fixture claims delivery only.'});
}
test('delivery retains explicitly unqualified driven intent without inventing a numeric threshold',()=>{
  const f=deliveryFixture();try {deferDrivenConstraint(f);assert.equal(f.evaluate().pass,true,JSON.stringify(f.evaluate().errors));}finally{f.clean();}
});
deliveryRejected('omitting driven constraints still needs an explicit unqualified status',f=>{deferDrivenConstraint(f);delete f.tracking[jointKey(f.context,'Head')].constraintStatus;},/missing measured trajectory constraints/);
deliveryRejected('omitting driven constraints still needs the reason',f=>{deferDrivenConstraint(f);f.tracking[jointKey(f.context,'Head')].constraintReason=' ';},/missing measured trajectory constraints/);
deliveryRejected('unqualified intent cannot bypass a declared failing constraint',f=>{deferDrivenConstraint(f);f.tracking[jointKey(f.context,'Head')].rules=[{metric:'localRotationExcursionDeg',min:1}];},/outside/);
deliveryRejected('unqualified intent cannot bypass a held promise',f=>{deferDrivenConstraint(f);f.tracking[jointKey(f.context,'Head')].requiredRole='held';},/stabilization requires/);
deliveryRejected('unqualified intent cannot bypass a contact promise',f=>{deferDrivenConstraint(f);f.tracking[jointKey(f.context,'Head')].requiredRole='contact';},/world-position constraint/);
rejected('full qualification still needs driven numeric constraints',f=>deferDrivenConstraint(f),/missing measured trajectory constraints/);
deliveryRejected('delivery requires both host evidence',f=>f.data.enforcement.delivery.contexts[0].reports=f.data.enforcement.delivery.contexts[0].reports.filter(r=>r.stage!=='simlab'),/missing simlab evidence/);
deliveryRejected('delivery cannot call deferred native work inapplicable',f=>f.data.enforcement.delivery.native.status='not-applicable',/native qualification.*deferred/);
deliveryRejected('delivery cannot invent a native follow-up owner',f=>f.data.enforcement.delivery.native.workUnitIds=['missing'],/existing open work unit/);
deliveryRejected('delivery native follow-up must cover the actual context',f=>f.data.program.workUnits[0].scope.motionIds=['historical'],/native owner does not cover/);
deliveryRejected('delivery cannot claim clinical qualification',f=>f.data.enforcement.delivery.qualification='qualified',/unqualified status/);
deliveryRejected('delivery rejects changed retained evidence bytes',f=>writeFileSync(resolve(f.root,'fixture.blend'),'changed'),/changed.*artifact/);
deliveryRejected('delivery fails malformed regression checks clearly',f=>{
  const path=resolve(f.root,'delivery-regression.json'),manifest=JSON.parse(readFileSync(path,'utf8'));manifest.checks={};
  const bytes=JSON.stringify(manifest);writeFileSync(path,bytes);f.data.enforcement.delivery.regression.sha256=digest(bytes);
},/passing scoped clinical-patient-bounds/);
deliveryRejected('an existing qualification cannot be downgraded to delivery',f=>{
  f.tracking[reviewKey(f.context)]={identity:f.context.identity,reports:f.data.enforcement.delivery.contexts[0].reports};
},/missing referenceAcceptance|native applicability/);
test('delivery uses fresh resampled values rather than trusting stored passing observations',()=>{
  const f=deliveryFixture();try { const fresh=structuredClone(f.tracking[observationKey(f.context)]);fresh.metrics.Head.localRotationExcursionDeg=20;
    assert.equal(f.evaluate({freshObservations:{[contextKey(f.context)]:fresh}}).pass,false);
  } finally { f.clean(); }
});
test('acknowledged open defects remain open and cannot gain closure through delivery',()=>{
  const f=deliveryFixture();try {
    const scope={motionIds:['candidate'],bodies:[],sides:[],phases:[],paths:[],joints:[]},artifact={path:'fixture.blend',sha256:digest(readFileSync(resolve(f.root,'fixture.blend')))};
    f.data.program.sources.push({id:'s',title:'Synthetic source',origin:'test',status:'inspected',snapshot:artifact,scope:'Fixture'});
    f.data.program.findings.push({id:'finding',sourceId:'s',locator:'fixture',summary:'Native follow-up',disposition:'linked',defectIds:['defect'],reason:'',evidence:[]});
    const defect={id:'defect',title:'Unqualified native result',category:'coordination',severity:'high',status:'open',scope,findingIds:['finding'],owner:'test',expected:'Verify physics',acceptance:['Native qualification'],nextAction:'Native follow-up',dependencies:[],blocking:true,closures:[]};
    f.data.program.defects.push(defect);f.data.program.coverage.find(item=>item.motionId==='candidate').defectIds=['defect'];
    assert.match(JSON.stringify(f.evaluate().errors),/omits applicable unresolved defect/);
    f.data.enforcement.delivery.openDefectIds=['defect'];
    assert.equal(f.evaluate().pass,true,JSON.stringify(f.evaluate().errors));assert.equal(defect.status,'open');assert.deepEqual(defect.closures,[]);
    defect.status='closed';assert.equal(f.evaluate().pass,false);
  } finally { f.clean(); }
});
test('committed inventory contains every actual skin bone and detects source drift',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const {data}=readMaster(root);assert.deepEqual(checkSnapshotSources(data,{engine:root}),[]);
  data.rigs.male.bones.pop();assert.match(checkSnapshotSources(data,{engine:root}).join('\n'),/Incomplete actual male skeleton/);
  data.hashes['pose-engine/src/services/poseRig.ts']='stale';assert.match(checkSnapshotSources(data,{engine:root}).join('\n'),/stale source inventory/);
});
