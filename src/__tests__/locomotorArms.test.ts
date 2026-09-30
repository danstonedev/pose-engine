import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Quaternion, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { applyCustomPose, serializeCustomPose, buildBoneByPoseKey } from '../services/poseRig';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { buildTravelWalk, buildRun, buildTurnInPlace } from '../services/movementLocomotion';
import { applyFault } from '../services/movementFaults';
import { scaleArmSwing, applyAsymmetry, spinalGaitCoordination } from '../services/gaitModifiers';
import { MOVEMENT_TEMPLATES } from '../services/movementTemplates.data';
import { templateToComposedMotion } from '../services/movementTemplateMotion';
import { measureLimbClearance } from '../services/limbClearance';
import { clearLocomotorArms } from '../services/locomotorArmClearance';
import { buildComposedCommandPose } from '../services/movementCommand';
import { armLegSkinContact } from './helpers/armLegSkinContact';

const rawWalk = () => templateToComposedMotion(MOVEMENT_TEMPLATES.find(t => t.id === 'walk')!);
const cases: [string, () => ComposedMotion][] = [
  ['walk', () => buildTravelWalk()], ['slow', () => buildTravelWalk({speed:.6})], ['fast', () => buildTravelWalk({speed:1.5})],
  ['in-place', () => spinalGaitCoordination(rawWalk())],
  ['reduced', () => scaleArmSwing(buildTravelWalk(), .2)],
  ['unilateral', () => applyAsymmetry(buildTravelWalk(), {side:'left',armSwing:0})],
  ['run', () => buildRun({speed:1.6})], ['turn-left', () => buildTurnInPlace()], ['turn-right', () => buildTurnInPlace({degrees:-180})],
  ['march', () => templateToComposedMotion(MOVEMENT_TEMPLATES.find(t => t.id === 'high-knee-march')!)],
  ...(['left','right'] as const).flatMap(side => (['trendelenburg','compensated-trendelenburg','hip-hike','circumduction','knee-valgus','scissoring'] as const)
    .map(fault => [`${fault}-${side}`, () => applyFault(buildTravelWalk(),fault,side,20)] as [string,()=>ComposedMotion])),
];
describe.each(['female','male','neutral'] as const)('%s shared locomotor arm motion', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: Object3D, skin: SkinnedMesh;
  let rest: ReturnType<typeof captureJointAngleRestReference>, baseline: ReturnType<typeof serializeCustomPose>;
  let inspect: ReturnType<typeof armLegSkinContact>;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`,import.meta.url));
    root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
    root.scale.setScalar(cfg.pose.rootScale); applyAnatomicPose(root,cfg); root.updateMatrixWorld(true);
    root.traverse(o => { if (!skin && (o as SkinnedMesh).isSkinnedMesh) skin=o as SkinnedMesh; });
    rest=captureJointAngleRestReference(skin.skeleton,cfg); baseline=serializeCustomPose(skin.skeleton,cfg,variant); inspect=armLegSkinContact(root);
  });
  const reset = () => { root.position.set(0,0,0); root.quaternion.identity(); applyCustomPose(skin.skeleton,cfg,baseline); root.updateMatrixWorld(true); };
  const sample = (m: ComposedMotion) => { reset(); return sampleComposedMotion(resolveComposedMotion(m,cfg),{baselinePose:baseline,variantCfg:cfg,rest,skeletonHarness:{root,skinned:skin},sampleHz:60,loopCycle:!!m.loop}); };
  it.each(cases)('%s keeps hands and forearms clear through the actual post-contact path', (name, build) => {
    const rec=sample(build());
    const clearance=measureLimbClearance(rec.frames.map(f=>f.worldTracks!));
    expect(clearance.untracked).toEqual([]);
    expect(clearance.worstM, `${name}: ${clearance.findings[0]?.pair}`).toBeGreaterThan(-.001);
    let skinBurial=0, armStep=0;
    for(let i=0;i<rec.frames.length;i++){
      const f=rec.frames[i]!;
      if(i>0)for(const side of ['L','R']) armStep=Math.max(armStep,new Quaternion().fromArray(f.pose.bones[`${side}_UpperArm`]!).angleTo(new Quaternion().fromArray(rec.frames[i-1]!.pose.bones[`${side}_UpperArm`]!))*180/Math.PI);
      if(i%2)continue;
      root.position.fromArray(f.root.translateM);root.quaternion.fromArray(f.root.orientQuat);applyCustomPose(skin.skeleton,cfg,f.pose);root.updateMatrixWorld(true);
      skinBurial=Math.max(skinBurial,inspect());
    }
    console.log(JSON.stringify({variant,name,clearanceM:clearance.worstM,skinBurial,armStep}));
    expect(skinBurial,'independent arm/leg skin hulls').toBeLessThan(.003);
    expect(armStep,'continuous upper-arm motion at 60 Hz').toBeLessThan(8);
  },30000);
  it('zero swing stops elbow pumping before and after coordination',()=>{
    for(const m of [spinalGaitCoordination(scaleArmSwing(rawWalk(),0)),scaleArmSwing(spinalGaitCoordination(rawWalk()),0)]){
      const rec=sample(m);
      for(const side of ['L','R'])for(const [joint,field]of [['Forearm','elbowFlexion'],['Forearm','forearmRotation'],['Hand','wristFlexion'],['Shoulder','protraction']]){
        const values=rec.frames.map(f=>f.angles[`${side}_${joint}`]![field]!);
        expect(Math.max(...values)-Math.min(...values),`${joint}.${field}`).toBeLessThan(.1);
      }
    }
  });
  it('does not gain shoulder range to clear a thigh',()=>{
    reset();
    const pose=buildComposedCommandPose(baseline,'L_UpperArm',[{motion:'shoulderAbduction',degrees:-14}],cfg,baseline,rest)!;
    applyCustomPose(skin.skeleton,cfg,pose);root.updateMatrixWorld(true);
    const constraints={L_UpperArm:{shoulderAbduction:{availableRange:{max:-14}}}};
    clearLocomotorArms(buildBoneByPoseKey(skin.skeleton,cfg),rest,new Quaternion(),constraints);
    expect(computeJointAngles(skin.skeleton,cfg,variant,rest).joints.L_UpperArm!.shoulderAbduction).toBeLessThanOrEqual(-13.99);
  });
});
