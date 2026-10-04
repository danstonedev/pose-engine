/** Bounded in-memory trunk push-up skin candidate; no production recipe edits.
 * vite-node THIS <retained-recipe.json> <fresh-report.json> [scan]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants';
import { applyAnatomicPose } from '../../src/services/anatomicPose';
import { captureJointAngleRestReference, isShoulderFieldMasked } from '../../src/services/jointAngles';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../../src/services/poseRig';
import { resolveComposedMotion, type ComposedMotion } from '../../src/services/motionSequence';
import { sampleComposedMotion } from '../../src/services/motionRecording';
import { setRomClampEnabled } from '../../src/services/poseRomClamp';
import { getEffectiveRomRange } from '../../src/services/romConstraints';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay';

const [recipePath, output, mode] = process.argv.slice(2);
if (!output) throw Error('Retained recipe and fresh report required');
const repository=fileURLToPath(new URL('../../',import.meta.url));
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const paths=execFileSync('git',['-c',`safe.directory=${repository.replaceAll('\\','/').replace(/\/$/,'')}`,'ls-files','--cached','--others','--exclude-standard','src','models','package-lock.json'],{cwd:repository,encoding:'utf8'}).split('\n').filter(Boolean).sort();
const source=()=>sha(paths.map(path=>`${path}:${sha(readFileSync(resolve(repository,path)))}`).join('\n'));
const digest=source(),recipe=JSON.parse(readFileSync(recipePath,'utf8')) as ComposedMotion;
setRomClampEnabled(false);
const report:any={version:1,kind:'bounded-plank-skin-candidate-probe',sourceDigest:digest,recipeSha256:sha(readFileSync(recipePath)),
  romClamp:false,clinicalContactClamp:'Existing explicit bounded hand/contact projections remain active.',
  criteriaBeforeRun:{supportPlaneY:0,skinToleranceM:.002,palmDriftToleranceM:.002,
    boundToleranceDeg:.05,thresholdBasis:'Root request uses existing2mm support/contact and.05degree clinical readback allowance. No gates changed.',
    scanScope:mode==='scan'?'Seven exact clocks only; not dense acceptance.':'Complete30Hzmotion includingterminal sample; all evaluated production skin vertices.'},
  scope:'In-memory trunk recipe with supportPlaneY0,plankSkinSupporttrue and both measured skin palm supports. Setup anchors and layout fields remain original. Full default30Hz cycle or labelled sparse pitch scan; no runtime/master change, native dynamics or clinical signoff.',cases:[]};
const region=(name:string)=>{
 const side=name.includes('_L_')?'L':name.includes('_R_')?'R':'center';
 for(const [part,label] of [['Toe','toes'],['Foot','foot'],['Calf','calf'],['Knee','knee'],['Thigh','thigh'],['Forearm','forearm'],['Upperarm','upperarm'],['Head','head'],['Neck','neck']] as const)if(name.includes(part))return`${side} ${label}`;
 if(/Hand|Thumb|Index|Mid|Ring|Pinky/.test(name))return`${side} palm/fingers`;
 return'torso/other';
};
for(const variant of ['male','female','neutral'] as const){
 const bytes=readFileSync(resolve(repository,`models/painmap3D_${variant}.runtime.glb`));
 const root=(await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
 const cfg=BODY_VARIANTS[variant];root.scale.setScalar(cfg.pose.rootScale);applyAnatomicPose(root,cfg);root.updateMatrixWorld(true);
 const skins:THREE.SkinnedMesh[]=[];root.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh)skins.push(o as THREE.SkinnedMesh);});
 const skin=skins[0]!,skeleton=skin.skeleton,bones=buildBoneByPoseKey(skeleton,cfg);
 const rest=captureJointAngleRestReference(skeleton,cfg),baselinePose=serializeCustomPose(skeleton,cfg,variant);
 const rootRestP=root.position.clone(),rootRestQ=root.quaternion.clone(),rootRestScale=root.scale.clone();
 const twist=createStageTwistOverlay();twist.reset(skeleton,cfg);
 const memberships=skins.map(s=>{const idx=s.geometry.getAttribute('skinIndex'),weight=s.geometry.getAttribute('skinWeight');return Array.from({length:idx.count},(_,i)=>{let max=0;for(let k=1;k<weight.itemSize;k++)if(weight.getComponent(i,k)>weight.getComponent(i,max))max=k;return region(s.skeleton.bones[idx.getComponent(i,max)]!.name);});});
 const pitches=mode==='scan'?[75,75.5,76,76.5,77,77.5,78]:[76];
 let originalAnchor:Record<string,number[]>|undefined;
 for(const pitch of pitches){
  root.position.copy(rootRestP);root.quaternion.copy(rootRestQ);root.scale.copy(rootRestScale);applyCustomPose(skeleton,cfg,baselinePose);root.updateMatrixWorld(true);
  const authored=structuredClone(recipe);authored.supportPlaneY=0;authored.plankSkinSupport=true;
  for(const contact of authored.contacts??[])if(contact.palmSupport)contact.palmSupport.surface='skin';
  authored.keyframes[1]!.root={...authored.keyframes[1]!.root,orient:{pitchDeg:pitch}};
  const recording=sampleComposedMotion(resolveComposedMotion(authored,cfg),{baselinePose,variantCfg:cfg,rest,skeletonHarness:{root,skinned:skin},sampleHz:30,
    ...(mode==='scan'?{frameTimesMs:[0,1000,1750,2500,4100,4850,5600]}:{})});
  if(!recording.frames.length)throw Error(`Candidate refused: ${recording.refusalReason}`);
  const frames:any[]=[],extrema:any={},breaches:any[]=[];
  const anchor:Record<string,number[]>={},orientation:Record<string,number[]>={};
  for(const frame of recording.frames){
   root.position.copy(rootRestP).add(new THREE.Vector3().fromArray(frame.root.translateM));root.quaternion.copy(rootRestQ).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));applyCustomPose(skeleton,cfg,frame.pose);
   const measured=twist.sampleWithTwist(()=>{
    root.updateMatrixWorld(true);const minima:Record<string,number>={},witnesses:Record<string,any>={},p=new THREE.Vector3();
    skins.forEach((s,index)=>{s.skeleton.update();for(let vertex=0;vertex<memberships[index]!.length;vertex++){
     s.getVertexPosition(vertex,p).applyMatrix4(s.matrixWorld);const key=memberships[index]![vertex]!;
     if(p.y<(minima[key]??Infinity)){minima[key]=p.y;witnesses[key]={mesh:s.name,vertex,worldPositionM:p.toArray()};}
    }});
    return{minima,witnesses,positions:Object.fromEntries([...bones].map(([key,b])=>[key,b.getWorldPosition(new THREE.Vector3()).toArray()])),
      locals:Object.fromEntries(skeleton.bones.map(b=>[b.name,b.quaternion.toArray()])),
      hands:Object.fromEntries(['L','R'].map(side=>{const b=bones.get(side+'_Hand')!;return[side,{p:b.getWorldPosition(new THREE.Vector3()).toArray(),q:b.getWorldQuaternion(new THREE.Quaternion()).toArray()}];}))};
   });
   const drift:any={};
   for(const side of ['L','R']){
    const h=measured.hands[side]!;anchor[side]??=h.p;orientation[side]??=h.q;
    drift[side]={positionM:new THREE.Vector3().fromArray(h.p).distanceTo(new THREE.Vector3().fromArray(anchor[side]!)),
      orientationRadians:new THREE.Quaternion().fromArray(h.q).angleTo(new THREE.Quaternion().fromArray(orientation[side]!))};
   }
   for(const [joint,set] of Object.entries(frame.angles))for(const [field,value] of Object.entries(set as Record<string,number>)){
    const key=joint+'.'+field,range=getEffectiveRomRange(null,joint,field);
    const e=extrema[key]??={min:value,max:value,minTMs:frame.tMs,maxTMs:frame.tMs,range,maskedFrames:0};
    if(value<e.min){e.min=value;e.minTMs=frame.tMs;}if(value>e.max){e.max=value;e.maxTMs=frame.tMs;}
    const masked=isShoulderFieldMasked(joint,field,set);if(masked)e.maskedFrames++;
    if(range&&!masked&&(value<range.min-.05||value>range.max+.05))breaches.push({tMs:frame.tMs,joint,field,value,range});
   }
   const left=new THREE.Vector3().fromArray(measured.positions.L_UpperArm!),right=new THREE.Vector3().fromArray(measured.positions.R_UpperArm!);
   frames.push({tMs:frame.tMs,root:frame.root,angles:frame.angles,...measured,palmDrift:drift,upperOriginDifferenceM:left.sub(right).toArray()});
  }
  originalAnchor??=structuredClone(anchor);
  const worst=Object.fromEntries([...new Set(frames.flatMap(f=>Object.keys(f.minima)))].map(key=>[key,frames.reduce((best,f)=>f.minima[key]<(best?.clearanceM??Infinity)?{clearanceM:f.minima[key],tMs:f.tMs,witness:f.witnesses[key]}:best,null)]));
  const firstSkinFailure=frames.flatMap(f=>Object.entries(f.minima).filter(([,y])=>(y as number)<-.002).map(([key,y])=>({tMs:f.tMs,region:key,clearanceM:y,witness:f.witnesses[key]})))[0]??null;
  const peak=frames.reduce((best,f)=>Math.abs(f.tMs-2500)<Math.abs(best.tMs-2500)?f:best,frames[0]);
  const first=frames[0]!,last=frames.at(-1)!;
  const rootLoopPositionErrorM=new THREE.Vector3().fromArray(first.root.translateM).distanceTo(new THREE.Vector3().fromArray(last.root.translateM));
  const rootLoopAngleErrorRadians=new THREE.Quaternion().fromArray(first.root.orientQuat).angleTo(new THREE.Quaternion().fromArray(last.root.orientQuat));
  const row={variant,pitch,assetSha256:sha(bytes),sampleCount:frames.length,anchor,
    scanAnchorXZDifferenceM:Object.fromEntries(['L','R'].map(side=>[side,Math.hypot(anchor[side]![0]-originalAnchor![side]![0],anchor[side]![2]-originalAnchor![side]![2])])),
    worstSkin:worst,firstSkinFailure,clinicalExtrema:extrema,clinicalBreaches:breaches,
    firstClinicalBreach:breaches[0]??null,maxPalmDriftM:Math.max(...frames.flatMap(f=>['L','R'].map(side=>f.palmDrift[side].positionM))),
    maxPalmOrientationDriftRadians:Math.max(...frames.flatMap(f=>['L','R'].map(side=>f.palmDrift[side].orientationRadians))),
    rootLoopPositionErrorM,rootLoopAngleErrorRadians,
    peak:{tMs:peak.tMs,girdles:{L:peak.angles.L_Shoulder,R:peak.angles.R_Shoulder},elbows:{L:peak.angles.L_Forearm,R:peak.angles.R_Forearm},upperOriginDifferenceM:peak.upperOriginDifferenceM},frames};
  report.cases.push(row);
  console.log(JSON.stringify({variant,pitch,sampleCount:frames.length,firstSkinFailure:row.firstSkinFailure,firstClinicalBreach:row.firstClinicalBreach,maxPalmDriftM:row.maxPalmDriftM,peak:row.peak,rootLoopPositionErrorM}));
 }
}
report.sourceStable=digest===source();if(!report.sourceStable)throw Error('Runtime changed during candidate probe');
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
