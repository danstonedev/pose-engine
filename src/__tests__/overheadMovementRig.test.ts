import {armHeadContact} from './helpers/armHeadContact';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { applyCustomPose, serializeCustomPose, buildBoneByPoseKey } from '../services/poseRig';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';

import {buildJump} from '../services/movementLocomotion';
import {composeScreenMotion,positionFor} from '../services/movementScreen';
import {computeBalanceTimeline} from '../services/centerOfMass';

describe.each(['female','male','neutral'] as const)('%s overhead movement geometry', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: Object3D, skin: SkinnedMesh;
  let rest: ReturnType<typeof captureJointAngleRestReference>, baseline: ReturnType<typeof serializeCustomPose>;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`,import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root,cfg); root.updateMatrixWorld(true);
    root.traverse(o => { if (!skin && (o as SkinnedMesh).isSkinnedMesh) skin=o as SkinnedMesh; });
    rest=captureJointAngleRestReference(skin.skeleton,cfg); baseline=serializeCustomPose(skin.skeleton,cfg,variant);
  });
  const reset = () => { root.position.set(0,0,0); root.quaternion.identity(); applyCustomPose(skin.skeleton,cfg,baseline); root.updateMatrixWorld(true); };
  const sample = (m: ComposedMotion) => { reset(); return sampleComposedMotion(resolveComposedMotion(m,cfg),{baselinePose:baseline,variantCfg:cfg,rest,skeletonHarness:{root,skinned:skin},sampleHz:60,loopCycle:!!m.loop}); };

  const checkHeadClearance = (rec: ReturnType<typeof sample>) => {
    const neck=buildBoneByPoseKey(skin.skeleton,cfg).get('Neck')!;
    let burial=0;
    for(const frame of rec.frames.filter((_,i)=>i%4===0)){
      root.position.fromArray(frame.root.translateM);root.quaternion.fromArray(frame.root.orientQuat);
      applyCustomPose(skin.skeleton,cfg,frame.pose);root.updateMatrixWorld(true);
      // Rebuild in the current head pose; this helper's hull is intentionally
      // static and must not be reused after the trunk or root moves.
      const inspect=armHeadContact(root,neck);
      for(const side of ['L','R'] as const)burial=Math.max(burial,inspect(side));
    }
    expect(burial,'arm skin does not bury into the head').toBeLessThan(.003);
  };
  it.each(['deep-squat','overhead-deep-squat'])('%s sets its stance before descent and retains flat feet', id => {
    const motion=composeScreenMotion(positionFor(id),'R',null,id)!;
    const resolved=resolveComposedMotion(motion,cfg);
    expect(resolved.outcomes.filter(o=>o.status==='refused'),'whole body has no dropped targets').toEqual([]);
    const rec=sample(motion);
    checkHeadClearance(rec);
    const setup=rec.frames.find(f=>f.tMs>=900)!;
    const supported=rec.frames.filter(f=>f.tMs>=900);
    const gap=Math.abs(setup.worldTracks!.L_Foot![0]-setup.worldTracks!.R_Foot![0]);
    expect(gap,'shoulder-width ankle spacing').toBeGreaterThan(.35);
    expect(gap).toBeLessThan(.52);
    let drift=0,toeDrop=0,margin=computeBalanceTimeline(rec).minMarginM,capacity=Infinity;
    for(const f of supported)for(const side of ['L','R'] as const){
      const foot=side+'_Foot',toe=side+'_Toes',w=f.worldTracks!,ref=setup.worldTracks!;
      drift=Math.max(drift,Math.hypot(...w[foot]!.map((v,i)=>v-ref[foot]![i]!)));
      toeDrop=Math.min(toeDrop,w[toe]![1]-ref[toe]![1]);
      expect(w[side+'_Hand']![1]-w.Head![1],'straight overhead arms').toBeGreaterThan(.3);
      capacity=Math.min(capacity,f.shoulders![side]!.capacity.marginDeg!);
      if(id==='deep-squat') for(const digit of ['Index1','Mid1','Ring1','Pinky1'])
        expect(f.angles[side+'_'+digit]!.fingerFlexion,'every finger retains the dowel grip').toBeGreaterThan(95);
    }
    console.log(JSON.stringify({variant,id,gap,drift,toeDrop,margin,capacity}));
    expect(drift,'fixed support after setup').toBeLessThan(.025);
    expect(toeDrop,'toes stay above the standing floor').toBeGreaterThan(-.005);
    expect(margin,'mass stays over the base').toBeGreaterThan(0);
    expect(capacity,'combined shoulder stays inside the proxy budget').toBeGreaterThan(0);
    const deepest=rec.frames.reduce((a,b)=>a.worldTracks!.Hips![1]<b.worldTracks!.Hips![1]?a:b);
    expect(setup.worldTracks!.Hips![1]-deepest.worldTracks!.Hips![1]).toBeGreaterThan(.4);
    expect(Math.abs(rec.frames.at(-1)!.worldTracks!.Hips![1]-setup.worldTracks!.Hips![1])).toBeLessThan(.005);
  });
  it('jump raises the girdles with the arms and releases them on landing',()=>{
    const rec=sample(buildJump());
    checkHeadClearance(rec);
    const apex=rec.frames.reduce((a,b)=>a.worldTracks!.Hips![1]>b.worldTracks!.Hips![1]?a:b);
    for(const side of ['L','R'] as const){
      expect(apex.angles[side+'_Shoulder']!.upRotation).toBeGreaterThan(30);
      expect(apex.shoulders![side]!.capacity.marginDeg).toBeGreaterThan(5);
      expect(apex.worldTracks![side+'_Hand']![1]-apex.worldTracks!.Head![1]).toBeGreaterThan(.3);
      const last=rec.frames.at(-1)!;
      expect(Math.abs(last.angles[side+'_Shoulder']!.upRotation!)).toBeLessThan(.1);
      expect(Math.abs(last.angles[side+'_UpperArm']!.shoulderRotation!)).toBeLessThan(.1);
    }
    expect(apex.worldTracks!.L_Foot![1]-rec.frames[0]!.worldTracks!.L_Foot![1]).toBeGreaterThan(.3);
  });
  it('setup support remains independent of playback pace and sample frequency',()=>{
    for(const hz of [30,120])for(const speed of [1,1.5]){
      reset();const motion=composeScreenMotion(positionFor('deep-squat'),'R',null,'deep-squat')!;
      motion.modifiers={timeScale:speed};
      const rec=sampleComposedMotion(resolveComposedMotion(motion,cfg),{baselinePose:baseline,variantCfg:cfg,rest,skeletonHarness:{root,skinned:skin},sampleHz:hz});
      const last=rec.frames.at(-1)!;
      expect(Math.abs(last.worldTracks!.L_Foot![0]-last.worldTracks!.R_Foot![0])).toBeGreaterThan(.35);
      expect(computeBalanceTimeline(rec).minMarginM).toBeGreaterThan(0);
    }
  });

});
