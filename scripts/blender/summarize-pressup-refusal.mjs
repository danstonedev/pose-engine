import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=['services/pressupPatientSupport.ts','services/motionSequence.ts','services/pressupPalmLayout.ts','services/motionRecording.ts','ExamStage3D.svelte'];
const report={schemaVersion:1,date:'2026-10-02',scope:'Known impossible endpoint refusal for prepared full press-up only; not a general contact feasibility validator.',
 requirement:'Retain approved default motion and clinical limits. Refuse explicit patient elbow intervals that exclude the existing authored extension endpoint before playback or sampling mutates the rig.',
 endpointBandDeg:{min:-.05,max:12},flags:['proneSkinSupport','pronePalmAnchorFit'],
 behavior:{resolver:'Returns existing refused status with readable reason.',sampler:'Returns zero frames and optional refusalReason, including runtime-only patient constraints.',stage:'Checks effective stage/resolved constraints before taking over the pose; uses existing refused outcome.',planner:'Shares the same existing endpoint incompatibility check.'},
 testEvidence:[{path:'remaining-batches/pressup-patient-refusal-tests-2.log',result:'9/9 pass; all three actual bodies, resolver and runtime-only sampler refusals preserve all rig transforms; default and endpoint-compatible requests resolve unchanged.',sha256:hash(readFileSync(new URL('../../../../remaining-batches/pressup-patient-refusal-tests-2.log',import.meta.url)))},
 {path:'remaining-batches/pressup-patient-refusal-tests-1.log',result:'24/24 floor support tests pass, plus initial10 refusal tests. The brittle source-order assertion was then removed; readable reason retested in tests-2.',sha256:hash(readFileSync(new URL('../../../../remaining-batches/pressup-patient-refusal-tests-1.log',import.meta.url)))}],
 diagnosticOnly:'The existing constrained partial-reach regression explicitly disables the full-endpoint layout flag and asserts nonempty playback. It verifies patient bounds and repeatability, not support acceptance or public delivery.',
 limitations:['Passing the interval check does not establish skin/contact/native feasibility.','Historical unsupported patient playback and failed parity artifacts remain unchanged.','Actual browser refusal/unchanged-stage evidence is recorded separately by verify-pressup-host-parity.mjs.'],
 source:Object.fromEntries(paths.map(p=>[p,hash(readFileSync(new URL('../../src/'+p,import.meta.url)))])),scriptSha256:hash(readFileSync(new URL(import.meta.url)))};
writeFileSync(new URL('../../docs/evidence/pressup-patient-refusal-2026-10-02.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log('Wrote compact refusal evidence');
