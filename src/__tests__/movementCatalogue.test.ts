import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleContext } from '../../scripts/catalogue/sample.mjs';
import { readMaster, contextKey, assertGate } from '../../scripts/catalogue/gate.mjs';
import { loadComparisonBase, evaluateProgress, sampledContexts } from '../../scripts/catalogue/progress.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
it('measures the entire actual rig and rechecks all qualified trajectories', async()=>{
  const {data,tracking}=readMaster(root);
  const pin=JSON.parse(readFileSync(resolve(root,'scripts/catalogue/baseline-pin.json'),'utf8'));
  if(process.env.MOVEMENT_CATALOGUE_MODE==='check'){
    const current={data,tracking};
    const base=loadComparisonBase(root,process.env.MOVEMENT_CATALOGUE_HOST?resolve(root,'..'):undefined);
    const freshObservations:Record<string,unknown>={};
    for(const context of sampledContexts(current)) freshObservations[contextKey(context)]=await sampleContext(data,context,root);
    assertGate(evaluateProgress(current,base,{engineRoot:root,baselineDigest:pin.sha256,freshObservations}));
  }else{
    const context=data.contexts.find((context:any)=>context.id==='joint:shoulder-flexion'&&context.variant==='male'&&context.side==='left');
    const measured=await sampleContext(data,context,root);
    expect(Object.keys(measured.metrics).sort()).toEqual(data.rigs.male.bones.map((bone:any)=>bone.id).sort());
    expect(measured.frameCount).toBeGreaterThan(30);
    expect(measured.metrics.L_UpperArm.localRotationExcursionDeg).toBeGreaterThan(30);
    for(const id of data.axialChain) expect(Number.isFinite(measured.metrics[id].localRotationExcursionDeg)).toBe(true);
  }
},180_000);
