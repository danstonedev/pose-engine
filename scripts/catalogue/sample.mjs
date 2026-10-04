// Executed through Vitest/Vite so the production TypeScript engine is loaded.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../../src/anatomy/bodyVariants.ts';
import { applyAnatomicPose } from '../../src/services/anatomicPose.ts';
import { captureJointAngleRestReference } from '../../src/services/jointAngles.ts';
import { sampleComposedMotion, authoredToTrajectoryTimeMap } from '../../src/services/motionRecording.ts';
import { resolveComposedMotion } from '../../src/services/motionSequence.ts';
import { applyCustomPose, serializeCustomPose } from '../../src/services/poseRig.ts';
import { createStageTwistOverlay } from '../../src/services/stageTwistOverlay.ts';
import { isRomClampActive } from '../../src/services/poseRomClamp.ts';
import { contextKey, identity } from './gate.mjs';

function accumulate(store, id, bone) {
  // angleTo assumes unit rotations. Imported Float32 quaternions can otherwise
  // accumulate a false excursion/path even when every component is unchanged.
  const q = bone.quaternion.clone().normalize(), wq = bone.getWorldQuaternion(new THREE.Quaternion()).normalize(), p = bone.getWorldPosition(new THREE.Vector3());
  const state = store[id] ??= { q, wq, p, previousQ:q, previousP:p, metrics:{ localRotationExcursionDeg:0, worldRotationExcursionDeg:0, worldPositionExcursionM:0, worldHorizontalPositionExcursionM:0, localAngularPathDeg:0, worldPositionPathM:0 } };
  const m = state.metrics;
  m.localRotationExcursionDeg = Math.max(m.localRotationExcursionDeg, THREE.MathUtils.radToDeg(q.angleTo(state.q)));
  m.worldRotationExcursionDeg = Math.max(m.worldRotationExcursionDeg, THREE.MathUtils.radToDeg(wq.angleTo(state.wq)));
  m.worldPositionExcursionM = Math.max(m.worldPositionExcursionM, p.distanceTo(state.p));
  m.worldHorizontalPositionExcursionM = Math.max(m.worldHorizontalPositionExcursionM, Math.hypot(p.x-state.p.x,p.z-state.p.z));
  m.localAngularPathDeg += THREE.MathUtils.radToDeg(q.angleTo(state.previousQ));
  m.worldPositionPathM += p.distanceTo(state.previousP);
  state.previousQ = q; state.previousP = p;
}
const metricsOf = store => Object.fromEntries(Object.entries(store).map(([id, state]) => [id, state.metrics]));

/** The sampler itself is synchronous. Limit the override to that call, leaving
 * async asset loading and the caller's nullable host override untouched. */
function withBrowserDefaultClamp(sample) {
  const keys = ['__enableRomClamp','__disableRomClamp'];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis,key));
  if (previous.some(descriptor => descriptor && !descriptor.configurable)) throw Error('Cannot scope catalogue sampling over a nonconfigurable ROM debug override');
  try {
    keys.forEach((key,index) => Object.defineProperty(globalThis,key,{value:index===1,writable:true,configurable:true}));
    if (isRomClampActive()) throw Error('Catalogue authored playback requires browser-default ROM clamp OFF');
    return sample();
  } finally {
    keys.forEach((key,index) => previous[index] ? Object.defineProperty(globalThis,key,previous[index]) : delete globalThis[key]);
  }
}

export async function sampleContext(data, context, engineRoot, sampleHz = 30) {
  if (!Number.isFinite(sampleHz) || sampleHz < 30 || sampleHz > 240) throw Error('Sampling must be 30–240 Hz');
  const definition = data.definitions[context.definitionId], cfg = BODY_VARIANTS[context.variant];
  const bytes = readFileSync(resolve(engineRoot, `models/painmap3D_${context.variant}.runtime.glb`));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const root = gltf.scene; root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root,cfg); root.updateMatrixWorld(true);
  let skinned; root.traverse(node => { if (!skinned && node.isSkinnedMesh) skinned = node; });
  if (!skinned) throw Error('Production rig has no skinned mesh');
  const skeleton = skinned.skeleton, inventory = data.rigs[context.variant];
  const bones = inventory.bones.map(item => ({id:item.id,bone:skeleton.bones.find(bone=>bone.name===item.raw)}));
  if (bones.some(item=>!item.bone) || bones.length !== skeleton.bones.length) throw Error('The complete actual rig must match the catalogue');
  const rest = captureJointAngleRestReference(skeleton,cfg), twist = createStageTwistOverlay(); twist.reset(skeleton,cfg);
  const full = {}, phases = {}, phaseWindows = {}; let frameCount = 0, totalMs = 0, phaseIndex = 0;
  const read = phase => { root.updateMatrixWorld(true); for (const {id,bone} of bones) { accumulate(full,id,bone); if (phase !== null) accumulate(phases[phase] ??= {},id,bone); } frameCount++; };
  if (context.group === 'rig-animation') {
    const clip = gltf.animations.find(clip=>`rig-animation:${clip.name}`===context.id);
    if (!clip) throw Error('Embedded clip missing');
    const mixer = new THREE.AnimationMixer(root); mixer.clipAction(clip).setLoop(THREE.LoopOnce,1).play();
    for(let t=0;t<=clip.duration+1/sampleHz;t+=1/sampleHz){mixer.setTime(Math.min(t,clip.duration));twist.beforeRender(clip);read(null);twist.afterRender();}
    mixer.stopAllAction();totalMs=clip.duration*1000;
  } else {
    if (!definition.motions?.length) throw Error('No reconstructible composed trajectory; this context cannot be qualified');
    // Playback keeps one grounded rest frame. Carry the previous recording as
    // explicit continuation state, never as a new anatomical/root baseline.
    const rootRestPos=root.position.clone(),rootRestQuat=root.quaternion.clone(),rootRestScale=root.scale.clone();
    const baselinePose=serializeCustomPose(skeleton,cfg,context.variant);
    let previous=null;
    for(const authored of definition.motions){
      root.position.copy(rootRestPos);root.quaternion.copy(rootRestQuat);root.scale.copy(rootRestScale);
      applyCustomPose(skeleton,cfg,baselinePose);root.updateMatrixWorld(true);
      const currentRoot=previous?{quat:previous.root.orientQuat,translateM:previous.root.translateM}:undefined;
      const currentAngles=previous?Object.fromEntries(Object.entries(previous.angles).flatMap(([joint,channels])=>Object.entries(channels).filter(([,value])=>Number.isFinite(value)).map(([channel,value])=>[`${joint}.${channel}`,value]))):undefined;
      const motion=resolveComposedMotion(authored,cfg,previous?{currentAngles,currentRoot}:undefined);
      const recording=withBrowserDefaultClamp(()=>sampleComposedMotion(motion,{baselinePose,variantCfg:cfg,rest,skeletonHarness:{root,skinned},sampleHz,...(previous?{currentPose:previous.pose,currentRoot}: {})}));
      if(!recording.frames.length) throw Error(`Authored chapter refused: ${authored.name}`);
      const durationMs=recording.frames.at(-1)?.tMs ?? 0, map=authoredToTrajectoryTimeMap(motion,durationMs);
      let authoredMs=0;const windows=authored.keyframes.map((frame,index)=>{
        const start=map.toTrajectory(authoredMs);authoredMs+=(frame.durationMs??0)+(frame.holdMs??0);const end=map.toTrajectory(authoredMs);
        const phase=String(phaseIndex+index);phaseWindows[phase]={startMs:totalMs+start,endMs:totalMs+end};return {start,end,phase};
      });
      for(const frame of recording.frames){
        root.position.copy(rootRestPos).add(new THREE.Vector3().fromArray(frame.root.translateM));root.quaternion.copy(rootRestQuat).multiply(new THREE.Quaternion().fromArray(frame.root.orientQuat));applyCustomPose(skeleton,cfg,frame.pose);
        const phase=windows.find(window=>frame.tMs>=window.start-1e-3&&frame.tMs<=window.end+1e-3)?.phase;
        twist.sampleWithTwist(()=>read(phase ?? null));
        // Clinical channels are measured by the production sampler, separately from bone angles.
        for(const [joint,channels] of Object.entries(frame.angles)) if(full[joint]) for(const [channel,value] of Object.entries(channels)){
          const m=full[joint].metrics;const minKey=`clinical.${channel}.minDeg`,maxKey=`clinical.${channel}.maxDeg`;
          m[minKey]=Math.min(m[minKey]??Infinity,value);m[maxKey]=Math.max(m[maxKey]??-Infinity,value);
        }
      }
      previous=recording.frames.at(-1);
      totalMs+=durationMs;phaseIndex+=authored.keyframes.length;
    }
  }
  root.traverse(node=>{node.geometry?.dispose();if(Array.isArray(node.material))node.material.forEach(material=>material.dispose());else node.material?.dispose();});
  return {version:1,context:contextKey(context),identity:identity(data,context),rigSha256:inventory.sha256,sampleHz,frameCount,durationMs:totalMs,complete:true,metrics:metricsOf(full),phaseMetrics:Object.fromEntries(Object.entries(phases).map(([phase,store])=>[phase,metricsOf(store)])),phaseWindows,
    romClamp:context.group==='rig-animation'?{requested:'embedded-clip',effective:null}:{requested:'browser-default-off',effective:false,scope:'Global authored FK clamp only; explicit patient and contact projections remain active.'},
    scope:'Production GLB skeleton and render-time twist; complete default trajectory. Bone excursion is relative to the first sample in its window. Skin, contact, physics, loop delivery and clinical appropriateness require separate evidence.'};
}
