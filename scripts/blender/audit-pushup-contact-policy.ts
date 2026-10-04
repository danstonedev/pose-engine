import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadHandRig,HAND_CASES,measureHandCase } from '../../src/__tests__/handPlantCases';
const out=process.argv[2];if(!out)throw Error('Fresh report path required');
const names=['movementPostures','floorPalmSupports','footContact','handContactPose','motionTrajectory','poseRomClamp'];
const hashes=()=>Object.fromEntries(names.map(n=>[n,createHash('sha256').update(readFileSync(new URL('../../src/services/'+n+'.ts',import.meta.url))).digest('hex')]));
const sourceBefore=hashes(),make=HAND_CASES['push-up']!.make,cases=[];
try { for(const explicitPalms of [true,false]){
 HAND_CASES['push-up']!.make=()=>{const motion=make() as any;return explicitPalms?motion:{...motion,contacts:undefined};};
 const rig=await loadHandRig('male');cases.push({explicitPalms,hz:120,measure:measureHandCase(rig,'push-up',120)});
}}finally{HAND_CASES['push-up']!.make=make;}
const fixture=JSON.parse(readFileSync(new URL('../../src/__tests__/fixtures/handPlant.5c1c9ac.json',import.meta.url),'utf8'))['push-up'].male['120'];
const sourceAfter=hashes();const report={scope:'Diagnostic only: current standing-to-push-up recipe vs same recipe with explicit floorPalmSupports removed, allowing preexisting handReach behavior. No production edit or acceptance threshold change.',sourceBefore,sourceAfter,sourceStable:JSON.stringify(sourceBefore)===JSON.stringify(sourceAfter),cases,historicalFixture:fixture};
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
