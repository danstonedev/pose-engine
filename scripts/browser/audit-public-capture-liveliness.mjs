import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [outArg,origin='http://127.0.0.1:5199']=process.argv.slice(2);if(!outArg)throw Error('Fresh evidence directory required');
const out=resolve(outArg);await mkdir(out);const sha=b=>createHash('sha256').update(b).digest('hex');
const files=['src/ExamStage3D.svelte','src/services/stageMotionLiveliness.ts','src/services/stageIdleOverlay.ts'];
const identities=async()=>Object.fromEntries(await Promise.all(files.map(async name=>[name,sha(await readFile(name))])));
const {chromium}=await import(pathToFileURL(resolve('../.review.local/node_modules/playwright/index.mjs')).href);
const report={scope:'Actual shared ExamStage3D at known-working development host. Held arm command, idle0, explicit motion liveliness0 versus.4. Public capture compared with the same-frame continuous recording tap and actual rendered trunk. No motion/source edits.',origin,before:await identities(),cases:[]};
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{for(const amount of [0,.4]){
 const context=await browser.newContext({viewport:{width:1000,height:800}}),page=await context.newPage(),row={amount,errors:[]};report.cases.push(row);page.on('pageerror',e=>row.errors.push(String(e)));
 await page.route('**/__capture-liveliness',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="stage"></div></body></html>'}));await page.goto(origin+'/__capture-liveliness');
 await page.evaluate(async()=>{
  const engine='/pose-engine',url=engine+'/src/ExamStage3D.svelte',compiled=await(await fetch(url)).text(),svelteUrl=compiled.match(/from ["']([^"']*\/svelte\.js(?:\?[^"']*)?)["']/)?.[1];if(!svelteUrl)throw Error('Actual Svelte runtime missing');
  const [{mount},{default:Stage}]=await Promise.all([import(svelteUrl),import(url)]);const a=window.captureAudit={ready:false};
  a.stage=mount(Stage,{target:document.querySelector('#stage'),props:{variant:'male',modelUrl:'/models/painmap3D_male.runtime.glb',idleLiveliness:0,height:'760px',sceneLayer:ctx=>{a.context=ctx;return{onModelLoaded:()=>a.ready=true};}}});
 });
 await page.waitForFunction(()=>window.captureAudit?.ready&&window.captureAudit.stage.captureFrame(),{timeout:60000});
 row.result=await page.evaluate(async amount=>{
  const a=window.captureAudit,[{resolveComposedMotion},{BODY_VARIANTS}]=await Promise.all([import('/pose-engine/src/services/motionSequence.ts'),import('/pose-engine/src/anatomy/bodyVariants.ts')]);
  a.stage.setMotionOverlays({liveliness:amount,guarding:0,balanceSway:0,pelvisShiftCm:0});a.realNow=performance.now.bind(performance);a.now=a.realNow();a.start=a.now;Object.defineProperty(performance,'now',{configurable:true,value:()=>a.now});
  const motion={name:'Held capture liveliness witness',startFrom:'current',keyframes:[{durationMs:1000,holdMs:5000,targets:[{joint:'R_UpperArm',motion:'shoulderFlexion',targetDegrees:30}]}]};
  const resolved=resolveComposedMotion(motion,BODY_VARIANTS.male);a.running=a.stage.applyComposedMotion(resolved);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));a.stage.startRecording({sampleHz:60,name:'Same-frame clean tap'});
  for(let t=0;t<=2000;t+=100){a.now=a.start+t;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}
  const keys=['Spine_Lower','Spine_Upper'],rendered=()=>Object.fromEntries(keys.map(k=>[k,a.context.bone(k).quaternion.toArray()]));
  const renderedBefore=rendered(),captured=a.stage.captureFrame(),renderedAfter=rendered(),recording=a.stage.stopRecording(),tap=recording.frames.at(-2),stopFrame=recording.frames.at(-1),Q=a.context.THREE.Quaternion;
  const delta=(p,q)=>new Q().fromArray(p).normalize().angleTo(new Q().fromArray(q).normalize())*180/Math.PI;
  if(tap.tMs!==stopFrame.tMs)throw Error('The actual rAF tap and stop snapshot must share the same clock');
  const result={breathExpansionM:a.context.breathExpansionM,recordingFrames:recording.frames.length,tapTime:tap.tMs,captured,tap,stopFrame,renderedBefore,renderedAfter,differences:keys.map(key=>({key,publicVsTapDeg:delta(captured.pose.bones[key],tap.pose.bones[key]),stopVsTapDeg:delta(stopFrame.pose.bones[key],tap.pose.bones[key]),renderedVsTapDeg:delta(renderedBefore[key],tap.pose.bones[key]),renderedBeforeAfterDeg:delta(renderedBefore[key],renderedAfter[key]),publicEqualsRendered:JSON.stringify(captured.pose.bones[key])===JSON.stringify(renderedBefore[key])}))};
  a.stage.cancelActiveMovement();return result;
 },amount);
 await page.screenshot({path:join(out,`liveliness-${amount}.png`)});console.log(JSON.stringify({amount,breathExpansionM:row.result.breathExpansionM,differences:row.result.differences,errors:row.errors}));await context.close();
}}finally{await browser.close();report.after=await identities();report.sourceStable=JSON.stringify(report.before)===JSON.stringify(report.after);await writeFile(join(out,'results.json'),JSON.stringify(report,null,2));}
