import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
// <config> <fresh output> [host|all] [variant|all] [flexion-clearing|trunk-stability-push-up]
const [configArg,outArg,hostFilter='all',bodyFilter='all',movement='flexion-clearing']=process.argv.slice(2);
if(!configArg||!outArg)throw Error('Configuration and fresh output required');
if(!['flexion-clearing','trunk-stability-push-up'].includes(movement))throw Error('Unsupported review motion');
const configPath=resolve(configArg),configBytes=await readFile(configPath),config=JSON.parse(configBytes),out=resolve(outArg);await mkdir(out);
const sha=b=>createHash('sha256').update(b).digest('hex');
const identity=async root=>Object.fromEntries(await Promise.all((await readdir(join(root,'src'),{recursive:true})).map(String).filter(n=>!n.includes('__tests__')&&/\.(?:[cm]?ts|svelte|[cm]?js)$/.test(n)).sort().map(async n=>[n.replaceAll('\\','/'),sha(await readFile(join(root,'src',n)))])));
const {chromium}=await import(pathToFileURL(resolve(dirname(configPath),config.playwrightModule)).href);
const report={createdAt:new Date().toISOString(),scope:'Actual ExamStage compiled by the named host, current authoritative source, independent sampled rig. Breathing/sway OFF. Sparse setup/approach/peak/hold/return parity at .01deg/.1mm. Diagnostic camera and mount, not product UI, clinical or native acceptance.',configSha256:sha(configBytes),scriptSha256:sha(await readFile(new URL(import.meta.url))),before:{},cases:[]};
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{for(const [host,cfg] of Object.entries(config.hosts)){
 if(hostFilter!=='all'&&host!==hostFilter)continue;
 const sourceRoot=resolve(dirname(configPath),cfg.sourceRoot);report.before[host]=await identity(sourceRoot);
 for(const variant of ['male','female','neutral']){
  if(bodyFilter!=='all'&&variant!==bodyFilter)continue;
  const context=await browser.newContext({viewport:{width:1200,height:880}}),page=await context.newPage(),row={host,variant,errors:[],consoleErrors:[],failedRequests:[],samples:[]};report.cases.push(row);
  page.on('pageerror',e=>row.errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')row.consoleErrors.push(m.text());});page.on('requestfailed',r=>row.failedRequests.push({url:r.url(),failure:r.failure()}));
  try{
   await page.route('**/__flexion-stage-parity',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;background:#141b1d"><div id="stage"></div></body></html>'}));await page.goto(cfg.origin+'/__flexion-stage-parity');
   await page.evaluate(async({engine,variant,modelResolver})=>{
    const boot=await(await fetch(engine+'/src/services/sceneBoot.ts')).text(),compiled=await(await fetch(engine+'/src/ExamStage3D.svelte')).text();
    const svelteUrl=compiled.match(/from ["']([^"']*\/svelte\.js(?:\?[^"']*)?)["']/)?.[1],loaderUrl=boot.match(/from ["']([^"']*\/three_examples_jsm_loaders_GLTFLoader__js\.js(?:\?[^"']*)?)["']/)?.[1],decoderUrl=boot.match(/from ["']([^"']*\/three_examples_jsm_libs_meshopt_decoder__module__js\.js(?:\?[^"']*)?)["']/)?.[1];
    if(!svelteUrl||!loaderUrl||!decoderUrl)throw Error('Compiled host dependency URLs missing');
    const [{mount},{default:Stage}]=await Promise.all([import(svelteUrl),import(engine+'/src/ExamStage3D.svelte')]);
    const modelUrl=modelResolver?(variant==='neutral'?(await import(engine+'/models/painmap3D_neutral.runtime.glb?url')).default:(await import(modelResolver)).resolveMannequinModelUrl(variant)):'/models/painmap3D_'+variant+'.runtime.glb';
    const res=await fetch(modelUrl),bytes=await res.arrayBuffer();if(!res.ok||new DataView(bytes).getUint32(0,true)!==0x46546c67)throw Error('Actual host asset is not GLB');
    const a=window.audit={ready:false,engine,variant,modelUrl,loaderUrl,decoderUrl,svelteUrl,assetSha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')};
    a.stage=mount(Stage,{target:document.querySelector('#stage'),props:{variant,modelUrl,idleLiveliness:0,height:'860px',sceneLayer:ctx=>{a.context=ctx;return{onModelLoaded:()=>a.ready=true,beforeRender:()=>{if(!ctx.skinnedMesh)return;if(a.view){ctx.camera.position.copy(a.view.position);ctx.camera.lookAt(a.view.target);ctx.camera.updateMatrixWorld();}a.renderState={breathExpansionM:ctx.breathExpansionM,bones:ctx.skinnedMesh.skeleton.bones.map(b=>({name:b.name,local:b.quaternion.toArray(),worldPosition:b.getWorldPosition(new ctx.THREE.Vector3()).toArray()}))};}};}}});
   },{...cfg,variant});
   await page.waitForFunction(()=>window.audit?.ready&&window.audit.stage.captureFrame(),undefined,{timeout:60000});
   row.setup=await page.evaluate(async(movement)=>{
    const a=window.audit,mod=p=>import(a.engine+'/src/'+p+'.ts');
    const [{BODY_VARIANTS},{applyAnatomicPose},{serializeCustomPose},{captureJointAngleRestReference},{resolveComposedMotion},{sampleComposedMotion},{BODY_ASSESSMENT_MOTIONS},{isRomClampActive},{GLTFLoader},{MeshoptDecoder}]=await Promise.all([mod('anatomy/bodyVariants'),mod('services/anatomicPose'),mod('services/poseRig'),mod('services/jointAngles'),mod('services/motionSequence'),mod('services/motionRecording'),mod('services/assessmentBodyMotions'),mod('services/poseRomClamp'),import(a.loaderUrl),import(a.decoderUrl)]);
    a.stage.setMotionOverlays({liveliness:0,balanceSway:0,guarding:0,pelvisShiftCm:0});
    const root=(await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(a.modelUrl)).scene,cfg=BODY_VARIANTS[a.variant];root.scale.copy(a.context.modelRoot.scale);applyAnatomicPose(root,cfg);root.position.copy(a.context.modelRoot.position);root.quaternion.copy(a.context.modelRoot.quaternion);root.updateMatrixWorld(true);
    let skinned;root.traverse(n=>{if(!skinned&&n.isSkinnedMesh)skinned=n;});
    const baselinePose=serializeCustomPose(skinned.skeleton,cfg,a.variant),rest=captureJointAngleRestReference(skinned.skeleton,cfg),authored=BODY_ASSESSMENT_MOTIONS[movement]('R'),resolved=resolveComposedMotion(authored,cfg);
    if(resolved.status!=='ok')throw Error('Motion refused: '+resolved.reason);
    a.times=movement==='trunk-stability-push-up'?[0,1000,1750,2500,3300,4100,4850,5600]:[0,1000,1800,2600,3500,4400,5100,5800];a.expected=sampleComposedMotion(resolved,{baselinePose,variantCfg:cfg,rest,skeletonHarness:{root,skinned},frameTimesMs:a.times,sampleHz:60});
    const box=new a.context.THREE.Box3();for(const f of a.expected.frames)for(const p of Object.values(f.worldTracks))box.expandByPoint(new a.context.THREE.Vector3().fromArray(p));box.expandByScalar(.18);const target=box.getCenter(new a.context.THREE.Vector3()),size=box.getSize(new a.context.THREE.Vector3()),distance=size.length()/(2*Math.tan(a.context.camera.fov*Math.PI/360))*1.12;a.view={target,position:target.clone().add(new a.context.THREE.Vector3(2,1.2,3).normalize().multiplyScalar(distance))};
    a.realNow=performance.now.bind(performance);a.now=a.realNow();a.startAt=a.now;Object.defineProperty(performance,'now',{configurable:true,value:()=>a.now});a.settled=false;a.running=a.stage.applyComposedMotion(resolved).then(v=>{a.settled=true;a.outcome=v;});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return{modelUrl:a.modelUrl,assetSha256:a.assetSha256,romClampEnabled:isRomClampActive(),authored,resolved,times:a.times,sourceSkeletonBoneCount:skinned.skeleton.bones.length,camera:{target:target.toArray(),position:a.view.position.toArray()}};
   },movement);
   for(const tMs of row.setup.times){
    const sample=await page.evaluate(async tMs=>{
     const a=window.audit;a.now=a.startAt+tMs;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const actual=a.stage.captureFrame(),expected=a.expected.frames.find(f=>f.tMs===tMs),Q=a.context.THREE.Quaternion,V=a.context.THREE.Vector3,angle=(p,q)=>new Q().fromArray(p).normalize().angleTo(new Q().fromArray(q).normalize())*180/Math.PI;
     const bones=Object.entries(expected.pose.bones).map(([key,v])=>({key,differenceDeg:angle(v,actual.pose.bones[key])})),tracks=Object.entries(expected.worldTracks).map(([key,v])=>({key,differenceM:new V().fromArray(v).distanceTo(new V().fromArray(actual.worldTracks[key]))}));
     return{tMs,maxBoneDifference:bones.sort((a,b)=>b.differenceDeg-a.differenceDeg)[0],maxTrackDifference:tracks.sort((a,b)=>b.differenceM-a.differenceM)[0],rootDifferenceDeg:angle(expected.root.orientQuat,actual.root.orientQuat),rootDifferenceM:new V().fromArray(expected.root.translateM).distanceTo(new V().fromArray(actual.root.translateM)),expected,actual,renderState:a.renderState,settled:a.settled};
    },tMs);row.samples.push(sample);await page.screenshot({path:join(out,`${host}-${variant}-${tMs}.png`)});
   }
   row.engineAssetSha256=sha(await readFile(join(sourceRoot,'models',`painmap3D_${variant}.runtime.glb`)));assert.equal(row.setup.assetSha256,row.engineAssetSha256,'Served model identity');assert.equal(row.setup.romClampEnabled,false);
   for(const s of row.samples){assert.equal(s.renderState.breathExpansionM,0,'Breathing must be OFF');assert.equal(s.renderState.bones.length,row.setup.sourceSkeletonBoneCount);assert.ok(s.maxBoneDifference.differenceDeg<.01,`Bone parity ${s.tMs}: ${JSON.stringify(s.maxBoneDifference)}`);assert.ok(s.maxTrackDifference.differenceM<.0001,`Track parity ${s.tMs}: ${JSON.stringify(s.maxTrackDifference)}`);assert.ok(s.rootDifferenceDeg<.01,`Root rotation ${s.tMs}: ${s.rootDifferenceDeg}`);assert.ok(s.rootDifferenceM<.0001,`Root translation ${s.tMs}: ${s.rootDifferenceM}`);}
   assert.equal(row.errors.length,0,'Browser errors');row.pass=true;
  }catch(e){row.failure=String(e);row.pass=false;process.exitCode=1;await page.screenshot({path:join(out,`${host}-${variant}-failure.png`)}).catch(()=>{});}
  console.log(JSON.stringify({host,variant,pass:row.pass,failure:row.failure,maxBoneDifferenceDeg:Math.max(...row.samples.map(s=>s.maxBoneDifference.differenceDeg)),maxTrackDifferenceM:Math.max(...row.samples.map(s=>s.maxTrackDifference.differenceM)),maxRootDifferenceDeg:Math.max(...row.samples.map(s=>s.rootDifferenceDeg))}));await writeFile(join(out,'results.json'),JSON.stringify(report,null,2));await context.close();
 }
}}finally{await browser.close();report.after=Object.fromEntries(await Promise.all(Object.keys(report.before).map(async h=>[h,await identity(resolve(dirname(configPath),config.hosts[h].sourceRoot))])));report.runtimeStable=JSON.stringify(report.before)===JSON.stringify(report.after);if(!report.runtimeStable||!report.cases.length)process.exitCode=1;await writeFile(join(out,'results.json'),JSON.stringify(report,null,2));}
