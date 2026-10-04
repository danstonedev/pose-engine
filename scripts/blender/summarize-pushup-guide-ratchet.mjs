import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const load=name=>{const bytes=readFileSync(new URL('../../../../remaining-batches/'+name,import.meta.url));return {path:'remaining-batches/'+name,sha256:hash(bytes),data:JSON.parse(bytes)};};
const rates=load('pushup-pop-rates-2.json'),policy=load('pushup-contact-policy-1.json');
const report={schemaVersion:1,date:'2026-10-02',scope:'Two legacy male120Hz upper-arm one-frame angular-speed ratchets only. No production movement, physical/contact/clinical limit or historical fixture changed.',
 policy:'User requested appropriate strictness while preserving approved motion; root authorized using the existing NOT_MET measured4-significant-figure ledger and existing1% allowance for these two newly attributed results only.',
 oldFixture:{L_UpperArm:policy.data.historicalFixture.arm.L_UpperArm.pop,R_UpperArm:policy.data.historicalFixture.arm.R_UpperArm.pop},
 ledger:{L_UpperArm:.2317,R_UpperArm:.2518},
 attribution:{reason:'buildPushUp now declares explicit floorPalmSupports. Its prepared12Hz contact guide changes the angular-speed profile compared with the historical unplanted fixture.',counterfactual:policy.data.cases,
 evidence:{path:policy.path,sha256:policy.sha256,sourceStable:policy.data.sourceStable},
 measurementScope:'Hand depth/lowSlide are wrist landmark metrics from the existing test, not independently measured skin or force.'},
 rateEvidence:{path:rates.path,sha256:rates.sha256,sourceStable:rates.data.sourceStable,cases:rates.data.cases.map(({around,...summary})=>summary),
 interpretation:'The120Hz4083.333ms event is not a persistent fixed-angle snap when sampled at240/480Hz. Angular-speed corners and smaller rate-sensitive peaks remain; this is not a claim of continuous acceleration or physical acceptance.',
 invalidEarlierArtifact:'pushup-pop-rates-1.json requested sampleHz240/480 but the public option caps120; it is not independent multi-rate evidence. Report2 uses explicit frameTimesMs.'},
 followUp:'Improve prepared guide angular-speed smoothness through future authored/contact trajectory work without sacrificing stable palms. Keep this limitation in the canonical master.',
 scriptSha256:hash(readFileSync(new URL(import.meta.url)))};
writeFileSync(new URL('../../docs/evidence/pushup-guide-ratchet-2026-10-02.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log('Wrote push-up guide ratchet evidence');
