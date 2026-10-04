import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateProgram, reconcileProgram, retentionErrors, trackingRetentionErrors } from './reconcile.mjs';
import { digest, identity, makeBaseline, reviewKey, evaluateCatalogue } from './gate.mjs';
const contexts=[{id:'motion-a',variant:'male',side:'left',available:true},{id:'motion-b',variant:'female',side:'right',available:true}];
test('migration creates explicit unknown coverage without granting acceptance',()=>{
  const program=migrateProgram(undefined,contexts);
  assert.equal(program.coverage.length,2);
  assert.ok(program.coverage.every(item=>item.defectReview==='pending'&&item.referenceStatus==='missing'));
  assert.deepEqual(migrateProgram(program,contexts),program);
});
test('repeated reconciliation is idempotent and preserves edited records',()=>{
  const input={defects:[{id:'d',title:'Known defect',scope:{motionIds:['motion-a']}}],references:[{id:'r',scope:{motionIds:['motion-a']}}]};
  const first=reconcileProgram(undefined,input,contexts),second=reconcileProgram(first.program,input,contexts);
  assert.deepEqual(second.program,first.program);
  assert.equal(second.added.defects,0);assert.deepEqual(second.conflicts,[]);
  first.program.defects[0].title='Reviewed finding';
  const conflict=reconcileProgram(first.program,input,contexts);
  assert.equal(conflict.program.defects[0].title,'Reviewed finding');assert.equal(conflict.conflicts.length,1);
});
test('duplicate source finding IDs cannot be imported',()=>assert.throws(()=>reconcileProgram(undefined,{findings:[{id:'f'},{id:'f'}]},contexts),/duplicate/));
test('repeat imports preserve reviewed coverage when its reference links are unchanged',()=>{
  const input={references:[{id:'r',scope:{motionIds:['motion-a']}}]};
  const first=reconcileProgram(undefined,input,contexts);first.program.coverage[0].referenceStatus='linked';
  assert.equal(reconcileProgram(first.program,input,contexts).program.coverage[0].referenceStatus,'linked');
});
test('coverage maps exact scopes and never promotes a citation to linked acceptance',()=>{
  const result=reconcileProgram(undefined,{references:[{id:'r',scope:{motionIds:['motion-a'],bodies:['female']}}]},contexts);
  assert.deepEqual(result.program.coverage[0].referenceIds,[]);
  const matched=reconcileProgram(result.program,{references:[{id:'r2',scope:{motionIds:['motion-a'],bodies:['male']}}]},contexts);
  assert.equal(matched.program.coverage[0].referenceStatus,'partial');
});
test('retention rejects removed records and rewritten source provenance',()=>{
  const before=migrateProgram(undefined,contexts);before.sources.push({id:'s',snapshot:{path:'old',sha256:'old'}});before.findings.push({id:'f',sourceId:'s',locator:'line 2'});
  const after=structuredClone(before);after.coverage.pop();after.findings[0].locator='line 3';after.sources[0].snapshot={path:'new',sha256:'new'};
  assert.equal(retentionErrors(before,after).length,3);
  after.coverage=before.coverage;after.findings=before.findings;after.sources[0].revisions=[before.sources[0].snapshot];
  assert.deepEqual(retentionErrors(before,after),[]);
});

test('tracking retention preserves reviews, observations and joint notes without freezing edits',()=>{
  const before={
    '["motion-a","male","left","$review"]':{identity:'old',reports:[]},
    '["motion-a","male","left","$observation"]':{identity:'old',complete:false},
    '["motion-a","male","left","all","Head"]':{status:'issue',note:'Keep the reported defect'}
  };
  const after=structuredClone(before);
  after['["motion-a","male","left","$review"]']={identity:'current',reports:[{stage:'blender'}]};
  after['["motion-a","male","left","all","Head"]'].status='in-progress';
  assert.deepEqual(trackingRetentionErrors(before,after),[]);
  for(const key of Object.keys(before)) {
    const dropped=structuredClone(after);delete dropped[key];
    assert.match(trackingRetentionErrors(before,dropped).join('\n'),/Tracking record was dropped/);
    for(const malformed of [null,false,'',0,[]]) {
      const replaced=structuredClone(after);replaced[key]=malformed;
      assert.match(trackingRetentionErrors(before,replaced).join('\n'),/Tracking record became malformed/);
    }
  }
});

test('previous-master retention prevents removing a historic review to restore exemption',()=>{
  const definition={motions:[],targets:[],phases:[],contacts:[]},definitionId=digest(definition);
  const context={id:'historical',variant:'male',side:'left',available:true,definitionId};
  const bones=['Hips','Spine_Lower','Spine_Mid','Spine_Upper','Neck_Lower','Neck','Head'].map(id=>({id,raw:id}));
  const data={schemaVersion:2,contexts:[context],rigs:{male:{sha256:'synthetic-rig',bones}},hashes:{},definitions:{[definitionId]:definition}};
  const baseline=makeBaseline(data),baselineDigest=digest(baseline);
  data.enforcement={baseline};context.identity=identity(data,context);data.program=migrateProgram(undefined,data.contexts);
  const previous={[reviewKey(context)]:{identity:context.identity}};
  const removed={};
  const before=evaluateCatalogue(data,previous,{baselineDigest});
  const after=evaluateCatalogue(data,removed,{baselineDigest});
  assert.equal(before.reviewedContexts,1);assert.equal(before.pass,false);
  assert.equal(after.reviewedContexts,0);assert.equal(after.pass,true);
  assert.match(trackingRetentionErrors(previous,removed).join('\n'),/Tracking record was dropped/);
  for(const malformed of [null,false,'']) {
    const downgraded={[reviewKey(context)]:malformed};
    assert.equal(evaluateCatalogue(data,downgraded,{baselineDigest}).reviewedContexts,0);
    assert.ok(trackingRetentionErrors(previous,downgraded).length);
  }
  // Normal edits remain permitted, but an object with missing/reset identity
  // stays a required review and fails acceptance through the existing gate.
  const retained={[reviewKey(context)]:{}};
  assert.deepEqual(trackingRetentionErrors(previous,retained),[]);
  const unresolved=evaluateCatalogue(data,retained,{baselineDigest});
  assert.equal(unresolved.reviewedContexts,1);assert.equal(unresolved.pass,false);
});
