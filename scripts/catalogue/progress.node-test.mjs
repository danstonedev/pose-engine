import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareIssues, evaluateProgress, preservationErrors, sampledContexts } from './progress.mjs';
import { digest, identity, makeBaseline, observationKey, contextKey } from './gate.mjs';
import { migrateProgram } from './reconcile.mjs';

const report = (...failures) => ({ errors: [{ context: '["hip","male","left"]', failures }] });
test('existing gaps remain visible and allow progress without claiming acceptance', () => {
  const result=compareIssues(report('missing blender evidence'),report('missing blender evidence'));
  assert.equal(result.pass,true);assert.equal(result.remainingIssues,1);assert.equal(result.improvedIssues,0);
});
test('partial numerical improvement passes without changing its bound', () => {
  const result=compareIssues(report('Head: excursion=20 outside 0..10'),report('Head: excursion=15 outside 0..10'));
  assert.equal(result.pass,true);assert.equal(result.improvedIssues,1);assert.equal(result.remainingIssues,1);
});
test('worsened measurements block even when another issue was fixed', () => {
  assert.equal(compareIssues(report('Head: excursion=20 outside 0..10','missing simmove evidence'),report('Head: excursion=25 outside 0..10')).pass,false);
});
test('new failures cannot be offset by improvements elsewhere', () => {
  assert.equal(compareIssues(report('missing simmove evidence'),report('missing blender evidence')).pass,false);
});
test('negative and scientific notation metrics retain numerical severity', () => {
  assert.equal(compareIssues(report('Head: position=-2e-3 outside 0..inf'),report('Head: position=-3e-3 outside 0..inf')).pass,false);
});
test('duplicate metric failures cannot hide the worse observation', () => {
  assert.equal(compareIssues(report('Head: excursion=20 outside 0..10'),report('Head: excursion=15 outside 0..10','Head: excursion=25 outside 0..10')).pass,false);
});
test('corrupt retained context evidence remains blocking', () => {
  assert.equal(compareIssues(report('evidence hash differs: review.json'),report('evidence hash differs: review.json')).pass,false);
});
test('global integrity errors remain blocking, including previously malformed evidence', () => {
  assert.equal(compareIssues({errors:['changed or escaped artifact: source.md']},{errors:['changed or escaped artifact: source.md']}).pass,false);
});
function fixture() {
  const definition={motions:[{name:'fixture',keyframes:[]}],targets:[],phases:[],contacts:[]},id=digest(definition);
  const data={schemaVersion:2,rigs:{male:{sha256:'rig',bones:['Hips','Spine_Lower','Spine_Mid','Spine_Upper','Neck_Lower','Neck','Head'].map(id=>({id,raw:id}))}},hashes:{'pose-engine/src/services/solver.ts':'base'},definitions:{[id]:definition},contexts:[{id:'hip',variant:'male',side:'left',available:true,definitionId:id}]};
  data.enforcement={baseline:makeBaseline(data)};data.contexts[0].identity=identity(data,data.contexts[0]);data.program=migrateProgram(undefined,data.contexts);
  return {data,tracking:{}};
}
test('shared source edits do not invent new qualification gaps on historical unreviewed contexts', () => {
  const base=fixture(),current=structuredClone(base);current.data.hashes['pose-engine/src/services/solver.ts']='changed';current.data.contexts[0].identity=identity(current.data,current.data.contexts[0]);
  const result=evaluateProgress(current,base,{baselineDigest:digest(base.data.enforcement.baseline)});
  assert.equal(result.pass,true,JSON.stringify(result.errors));assert.ok(result.remainingIssues>0);
});
test('previously fresh observations becoming stale are a new failure', () => {
  const base=fixture(),context=base.data.contexts[0];
  base.tracking[observationKey(context)]={context:contextKey(context),identity:context.identity,rigSha256:'rig',sampleHz:30,frameCount:31,complete:true,metrics:{}};
  const current=structuredClone(base);current.data.hashes['pose-engine/src/services/solver.ts']='changed';current.data.contexts[0].identity=identity(current.data,current.data.contexts[0]);
  assert.equal(evaluateProgress(current,base,{baselineDigest:digest(base.data.enforcement.baseline)}).pass,false);
  assert.equal(sampledContexts(current).length,1);
});
test('new available context needs its own qualification', () => {
  const base=fixture(),current=structuredClone(base);current.data.contexts.push({...current.data.contexts[0],side:'right'});
  assert.equal(evaluateProgress(current,base,{baselineDigest:digest(base.data.enforcement.baseline)}).pass,false);
});
test('baseline rewrite, dropped records and relaxed bounds cannot hide issues', () => {
  const base=fixture();base.tracking.joint={rules:[{metric:'angle',max:10}],nativeRequired:true};
  const current=structuredClone(base);current.tracking.joint.rules[0].max=20;
  assert.match(preservationErrors(base,current).join('\n'),/relaxed/);
  delete current.tracking.joint;assert.match(preservationErrors(base,current).join('\n'),/dropped/);
  current.data.enforcement.baseline.sources={};assert.match(preservationErrors(base,current).join('\n'),/Frozen/);
});
