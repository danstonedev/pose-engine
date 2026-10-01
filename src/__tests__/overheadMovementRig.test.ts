import {armHeadContact} from './helpers/armHeadContact';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Line3, Vector3, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { applyCustomPose, serializeCustomPose, buildBoneByPoseKey } from '../services/poseRig';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';

import {buildJump} from '../services/movementLocomotion';
import {composeScreenMotion,positionFor,SCREEN_KIT} from '../services/movementScreen';
import {computeBalanceTimeline} from '../services/centerOfMass';
import { bilateralFootSetupMs } from '../services/motionSupport';
import { overheadDowelPlacement } from '../services/overheadDowel';
import { withStandingStance } from '../services/stanceTransition';

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
    const readyAt=bilateralFootSetupMs(resolved)!;
    expect(readyAt).toBeGreaterThan(3000);
    const setup=rec.frames.find(f=>f.tMs>=readyAt)!;
    const supported=rec.frames.filter(f=>f.tMs>=readyAt);
    const leftSwing=rec.frames.filter(f=>f.tMs>=900&&f.tMs<1800);
    const rightSwing=rec.frames.filter(f=>f.tMs>=2150&&f.tMs<3050);
    const floor=rec.frames[0]!.worldTracks!;
    expect(Math.max(...leftSwing.map(f=>f.worldTracks!.L_Foot![1]-floor.L_Foot![1]))).toBeGreaterThan(.035);
    expect(Math.max(...rightSwing.map(f=>f.worldTracks!.R_Foot![1]-floor.R_Foot![1]))).toBeGreaterThan(.035);
    expect(Math.max(...leftSwing.map(f=>Math.abs(f.worldTracks!.R_Foot![0]-floor.R_Foot![0])))).toBeLessThan(.02);
    expect(Math.max(...leftSwing.map(f=>Math.abs(f.worldTracks!.R_Foot![1]-floor.R_Foot![1]))),
      'right support foot stays on the floor while left steps').toBeLessThan(.012);
    const leftPlant=rec.frames.find(f=>f.tMs>=1800)!;
    expect(Math.max(...rightSwing.map(f=>Math.abs(f.worldTracks!.L_Foot![0]-leftPlant.worldTracks!.L_Foot![0])))).toBeLessThan(.025);
    expect(Math.max(...rightSwing.map(f=>Math.abs(f.worldTracks!.L_Foot![1]-floor.L_Foot![1]))),
      'left support foot keeps its sole near the floor while right steps').toBeLessThan(.015);
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
    }
    expect(drift,'fixed support after setup').toBeLessThan(.025);
    expect(toeDrop,'toes stay above the standing floor').toBeGreaterThan(-.005);
    expect(margin,'mass stays over the base').toBeGreaterThan(0);
    expect(capacity,'combined shoulder stays inside the proxy budget').toBeGreaterThan(0);
    expect(Math.abs(setup.worldTracks!.L_Foot![1]-floor.L_Foot![1])).toBeLessThan(.012);
    expect(Math.abs(setup.worldTracks!.R_Foot![1]-floor.R_Foot![1])).toBeLessThan(.012);
    const deepest=rec.frames.reduce((a,b)=>a.worldTracks!.Hips![1]<b.worldTracks!.Hips![1]?a:b);
    expect(Math.abs(deepest.worldTracks!.Hips![0]),'pelvis stays centered during the loaded squat').toBeLessThan(.02);
    expect(Math.abs(deepest.angles.L_Leg!.kneeRotation!-deepest.angles.R_Leg!.kneeRotation!),
      'neutral squat does not invent unilateral tibial rotation').toBeLessThan(2);
    expect(Math.abs(deepest.root.orientQuat[1]),'root does not yaw toward the lower ankle').toBeLessThan(.02);
    expect(setup.worldTracks!.Hips![1]-deepest.worldTracks!.Hips![1]).toBeGreaterThan(.4);
    expect(Math.abs(rec.frames.at(-1)!.worldTracks!.Hips![1]-setup.worldTracks!.Hips![1])).toBeLessThan(.005);
  }, 30000); // Full-motion skin hull inspection takes 9-11 seconds on CI runners.
  it('fits the dowel against both palms without burying it in the fingers', () => {
    const rec=sample(composeScreenMotion(positionFor('deep-squat'),'R',null,'deep-squat')!);
    const bones=buildBoneByPoseKey(skin.skeleton,cfg);
    const readyAt=bilateralFootSetupMs(resolveComposedMotion(composeScreenMotion(positionFor('deep-squat'),'R',null,'deep-squat')!,cfg))!;
    const supported=rec.frames.filter(f=>f.tMs>=readyAt);
    const deepest=supported.reduce((a,b)=>a.worldTracks!.Hips![1]<b.worldTracks!.Hips![1]?a:b);
    for(const frame of [supported[0]!,deepest,supported.at(-1)!]){
      root.position.fromArray(frame.root.translateM);root.quaternion.fromArray(frame.root.orientQuat);
      applyCustomPose(skin.skeleton,cfg,frame.pose);root.updateMatrixWorld(true);
      const bar=overheadDowelPlacement(key=>bones.get(key)??null,SCREEN_KIT.dowel.lengthM,SCREEN_KIT.dowel.radiusM);
      expect(bar,`a compatible bilateral grip exists at ${frame.tMs}`).not.toBeNull();
      const line=new Line3(bar!.from,bar!.to),point=new Vector3(),nearest=new Vector3();
      const gaps: Record<string,number>={};
      root.traverse(object=>{
        const mesh=object as SkinnedMesh;if(!mesh.isSkinnedMesh)return;
        const indices=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
        for(let i=0;i<indices.count;i++){
          let max=0,name='';
          for(let j=0;j<4;j++){const weight=weights.getComponent(i,j);if(weight>max){max=weight;name=mesh.skeleton.bones[indices.getComponent(i,j)]!.name;}}
          const match=/_([LR])_(Hand|Thumb\d|Index\d|Mid\d|Ring\d|Pinky\d)$/.exec(name);
          if(!match)continue;
          mesh.getVertexPosition(i,point).applyMatrix4(mesh.matrixWorld);
          const gap=point.distanceTo(line.closestPointToPoint(point,true,nearest))-SCREEN_KIT.dowel.radiusM;
          const key=match[1]+(match[2]==='Hand'?'palm':'digits');
          gaps[key]=Math.min(gaps[key]??Infinity,gap);
        }
      });
      for(const side of ['L','R']){
        expect(gaps[side+'palm'],`${side} palm penetration`).toBeGreaterThan(-.003);
        expect(gaps[side+'palm'],`${side} palm contact`).toBeLessThan(.014);
        expect(gaps[side+'digits'],`${side} digit penetration`).toBeGreaterThan(-.006);
        expect(gaps[side+'digits'],`${side} digit contact`).toBeLessThan(.014);
      }
    }
  });
  it('keeps a requested staggered stance planted through the squat', () => {
    const source=composeScreenMotion(positionFor('deep-squat'),'R',null,'deep-squat')!;
    const motion=withStandingStance(source,{widthCm:36,leftForwardCm:8,rightForwardCm:-5},variant);
    const resolved=resolveComposedMotion(motion,cfg),rec=sample(motion);
    const frames=rec.frames.filter(f=>f.tMs>=bilateralFootSetupMs(resolved)!);
    const ready=frames[0]!.worldTracks!;
    expect(Math.abs(ready.L_Foot![0]-ready.R_Foot![0])).toBeCloseTo(.36,1);
    expect(ready.L_Foot![2]-ready.R_Foot![2]).toBeCloseTo(.13,1);
    for(const frame of frames)for(const side of ['L','R'])
      expect(new Vector3().fromArray(frame.worldTracks![side+'_Foot']!).distanceTo(new Vector3().fromArray(ready[side+'_Foot']!))).toBeLessThan(.025);
  });
  it('places a patient-specific staggered squat stance before the planted descent', () => {
    const source = composeScreenMotion(positionFor('deep-squat'), 'R', null, 'deep-squat')!;
    const narrow = sample(withStandingStance(source, { widthCm: 30, leftForwardCm: 8, rightForwardCm: -5 }, variant));
    const wide = sample(withStandingStance(source, { widthCm: 50, leftForwardCm: 8, rightForwardCm: -5 }, variant));
    const placed = (rec: ReturnType<typeof sample>) => rec.frames.find(f => f.tMs >= 3700)!.worldTracks!;
    const narrowFeet = placed(narrow), wideFeet = placed(wide);
    const width = (feet: typeof narrowFeet) => Math.abs(feet.L_Foot![0] - feet.R_Foot![0]);
    expect(Math.abs(width(narrowFeet) - .30), '30 cm requested width').toBeLessThan(.045);
    expect(Math.abs(width(wideFeet) - .50), '50 cm requested width').toBeLessThan(.045);
    expect(width(wideFeet) - width(narrowFeet)).toBeGreaterThan(.10);
    expect(Math.abs(narrowFeet.L_Foot![2] - narrowFeet.R_Foot![2] - .13), '13 cm requested fore/aft stagger').toBeLessThan(.05);
    const supported = narrow.frames.filter(f => f.tMs >= 3700);
    const drift = Math.max(...supported.flatMap(f => (['L_Foot', 'R_Foot'] as const).map(key =>
      Math.hypot(...f.worldTracks![key]!.map((v, i) => v - narrowFeet[key]![i]!)))));
    expect(drift).toBeLessThan(.035);
  }, 30000);
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
