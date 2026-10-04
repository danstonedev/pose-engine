import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleContext } from '../../scripts/catalogue/sample.mjs';
import { isRomClampActive } from '../services/poseRomClamp';
import { readMaster, requiredContexts, contextKey, evaluateCatalogue, assertGate } from '../../scripts/catalogue/gate.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
it('measures the entire actual rig and rechecks all qualified trajectories', async()=>{
  const {data,tracking}=readMaster(root);
  const pin=JSON.parse(readFileSync(resolve(root,'scripts/catalogue/baseline-pin.json'),'utf8'));
  if(process.env.MOVEMENT_CATALOGUE_MODE==='check'){
    assertGate(evaluateCatalogue(data,tracking,{engineRoot:root,baselineDigest:pin.sha256}));
    const freshObservations:Record<string,unknown>={};
    for(const context of requiredContexts(data,tracking)) freshObservations[contextKey(context)]=await sampleContext(data,context,root);
    assertGate(evaluateCatalogue(data,tracking,{engineRoot:root,baselineDigest:pin.sha256,freshObservations}));
  }else{
    const context=data.contexts.find((context:any)=>context.id==='joint:shoulder-flexion'&&context.variant==='male'&&context.side==='left');
    const beforeMode=isRomClampActive();
    const beforeGlobals=['__enableRomClamp','__disableRomClamp'].map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
    const measured=await sampleContext(data,context,root);
    expect(measured.romClamp).toMatchObject({requested:'browser-default-off',effective:false});
    expect(isRomClampActive()).toBe(beforeMode);
    expect(['__enableRomClamp','__disableRomClamp'].map(key=>Object.getOwnPropertyDescriptor(globalThis,key))).toEqual(beforeGlobals);
    expect(Object.keys(measured.metrics).sort()).toEqual(data.rigs.male.bones.map((bone:any)=>bone.id).sort());
    expect(measured.frameCount).toBeGreaterThan(30);
    expect(measured.metrics.L_UpperArm.localRotationExcursionDeg).toBeGreaterThan(30);
    // The actual male Head rest quaternion is Float32 and slightly nonunit.
    // A held head must not acquire a false angular excursion or path length.
    expect(measured.metrics.Head.localRotationExcursionDeg).toBeLessThan(.01);
    expect(measured.metrics.Head.localAngularPathDeg).toBeLessThan(.01);
    for(const id of data.axialChain) expect(Number.isFinite(measured.metrics[id].localRotationExcursionDeg)).toBe(true);
  }
},180_000);
