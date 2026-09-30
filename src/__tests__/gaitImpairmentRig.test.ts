import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import { applyAnatomicPose } from '../services/anatomicPose';
import { captureJointAngleRestReference, computeJointAngles } from '../services/jointAngles';
import { applyCustomPose, buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { buildTravelWalk } from '../services/movementLocomotion';
import { applyFault, type CompensatoryFault } from '../services/movementFaults';
import { constrainGaitLegPose, gaitLegClearance, gaitLegPoints } from '../services/gaitLegClearance';
import { buildComposedCommandPose } from '../services/movementCommand';
import { legSkinContact } from './helpers/legSkinContact';
import { buildComposedTrajectory, buildLoopTrajectory } from '../services/motionTrajectory';

describe.each(['female', 'male', 'neutral'] as const)('%s impaired walking on the production rig', variant => {
  const cfg = BODY_VARIANTS[variant];
  let root: Object3D, skin: SkinnedMesh;
  let rest: ReturnType<typeof captureJointAngleRestReference>, baseline: ReturnType<typeof serializeCustomPose>;
  let bones: ReturnType<typeof buildBoneByPoseKey>, inspectSkin: ReturnType<typeof legSkinContact>;
  beforeAll(async () => {
    const bytes = readFileSync(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url));
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    root = gltf.scene; root.scale.setScalar(cfg.pose.rootScale);
    applyAnatomicPose(root, cfg); root.updateMatrixWorld(true);
    root.traverse(o => { if (!skin && (o as SkinnedMesh).isSkinnedMesh) skin = o as SkinnedMesh; });
    rest = captureJointAngleRestReference(skin.skeleton, cfg);
    baseline = serializeCustomPose(skin.skeleton, cfg, variant);
    bones = buildBoneByPoseKey(skin.skeleton, cfg);
    inspectSkin = legSkinContact(root, bones);
  });
  const reset = () => { root.position.set(0, 0, 0); root.quaternion.identity(); applyCustomPose(skin.skeleton, cfg, baseline); root.updateMatrixWorld(true); };
  it.each([.5, 2])('keeps clearance on the correct foot through paced repeats and loop entry at speed %s', timeScale => {
    reset();
    const pose = buildComposedCommandPose(baseline, 'L_UpLeg', [{motion:'hipAbduction',degrees:-18}], cfg, baseline, rest)!;
    expect(gaitLegClearance(pose, rest.gaitLegFrames!)).toBeLessThan(0);
    const built = {
      poses: [pose, pose], durationsMs: [200, 600], holdsMs: [100, 100],
      roots: [0,1].map(() => ({quat:[0,0,0,1] as [number,number,number,number],translateM:[0,0,0] as [number,number,number]})),
      gaitClearance: {frames:rest.gaitLegFrames!,windows:[{foot:'R_Foot',fromMs:0,toMs:400}],durationsMs:[200,600],holdsMs:[100,100]},
    };
    const open = buildComposedTrajectory(built,{startPose:pose,startQuat:[0,0,0,1],startTranslate:[0,0,0],timeScale,reps:3}).trajectory;
    const loop = buildLoopTrajectory(built,{timeScale}).trajectory;
    const expectSameRotation = (actual: number[], expected: number[]) => expect(
      new Quaternion().fromArray(actual).normalize().angleTo(new Quaternion().fromArray(expected).normalize())
    ).toBeLessThan(1e-6);
    for (let rep=0;rep<3;rep++) {
      const active = open.sampleAt((rep*1000+250)/timeScale);
      expect(gaitLegClearance(active.pose,rest.gaitLegFrames!)).toBeGreaterThanOrEqual(0);
      expectSameRotation(active.pose.bones.R_UpLeg!,pose.bones.R_UpLeg!);
      expectSameRotation(open.sampleAt((rep*1000+650)/timeScale).pose.bones.L_UpLeg!,pose.bones.L_UpLeg!);
      // A periodic loop starts at the first arrival, 200 ms into the authored clock.
      expect(gaitLegClearance(loop.sampleAt((rep*1000+50)/timeScale).pose,rest.gaitLegFrames!)).toBeGreaterThanOrEqual(0);
      expectSameRotation(loop.sampleAt((rep*1000+450)/timeScale).pose.bones.L_UpLeg!,pose.bones.L_UpLeg!);
    }
  });
  it('does not gain patient hip ROM to resolve a collision', () => {
    reset();
    const pose = buildComposedCommandPose(baseline, 'L_UpLeg', [{motion:'hipAbduction',degrees:-18}], cfg, baseline, rest)!;
    const before = structuredClone(pose);
    const constraints = {L_UpLeg:{hipAbduction:{availableRange:{max:-15}}}};
    const clear = constrainGaitLegPose(pose, rest.gaitLegFrames!, 'L', constraints);
    applyCustomPose(skin.skeleton, cfg, clear); root.updateMatrixWorld(true);
    expect(computeJointAngles(skin.skeleton,cfg,variant,rest).joints.L_UpLeg!.hipAbduction).toBeLessThanOrEqual(-14.99);
    expect(gaitLegClearance(clear, rest.gaitLegFrames!), 'unreachable clearance remains measurable').toBeLessThan(0);
    expect(pose).toEqual(before);
    const resolved = resolveComposedMotion(applyFault(buildTravelWalk(),'scissoring'),cfg,{constraints});
    expect(resolved.constraints).toEqual(constraints);
  });
  const cases = (['trendelenburg', 'hip-hike', 'knee-valgus', 'scissoring'] as CompensatoryFault[])
    .flatMap(fault => (['left', 'right'] as const).flatMap(side => [undefined, fault === 'trendelenburg' || fault === 'hip-hike' ? 20 : 25].map(degrees => ({ fault, side, degrees }))));
  it.each(cases)('$fault / $side / $degrees retains leg clearance through contact solving and returns to standing', ({ fault, side, degrees }) => {
    reset();
    const motion = applyFault(buildTravelWalk({ asymmetry: false }), fault, side, degrees);
    const resolved = resolveComposedMotion(motion, cfg);
    const rec = sampleComposedMotion(resolved, { baselinePose: baseline, variantCfg: cfg, rest, skeletonHarness: { root, skinned: skin }, sampleHz: 60 });
    let maxPenetration = 0, maxStep = 0, maxLean = 0, skinAt = '', stepAt = '';
    for (let i = 0; i < rec.frames.length; i++) {
      const f = rec.frames[i]!;
      root.position.fromArray(f.root.translateM); root.quaternion.fromArray(f.root.orientQuat);
      applyCustomPose(skin.skeleton, cfg, f.pose); root.updateMatrixWorld(true);
      const b = f.worldTracks!;
      const hipWidth = new Vector3().fromArray(b.L_UpLeg!).distanceTo(new Vector3().fromArray(b.R_UpLeg!));
      const kneeDistance = new Vector3().fromArray(b.L_Leg!).distanceTo(new Vector3().fromArray(b.R_Leg!));
      expect(kneeDistance / hipWidth, `knee separation at ${f.tMs} ms`).toBeGreaterThan(.55);
      const head = b.Head!, pelvis = b.Hips!;
      maxLean = Math.max(maxLean, Math.abs(Math.atan2(head[0] - pelvis[0], head[1] - pelvis[1]) * 180 / Math.PI));
      // Independent scene FK must agree with the clearance model after IK.
      const l = gaitLegPoints(f.pose, rest.gaitLegFrames!, 'L'), r = gaitLegPoints(f.pose, rest.gaitLegFrames!, 'R');
      expect(new Vector3().fromArray(l[1]).distanceTo(new Vector3().fromArray(r[1]))).toBeCloseTo(kneeDistance, 5);
      {
        const contact = inspectSkin();
        if (contact.penetrationM > maxPenetration) { maxPenetration = contact.penetrationM; skinAt = `${f.tMs} ${contact.pair}`; }
      }
      if (i > 0) for (const key of ['L_UpLeg', 'R_UpLeg']) {
        const step = new Quaternion().fromArray(f.pose.bones[key]!).angleTo(new Quaternion().fromArray(rec.frames[i - 1]!.pose.bones[key]!)) * 180 / Math.PI;
        if (step > maxStep) { maxStep = step; stepAt = `${f.tMs} ${key}`; }
      }
    }
    console.log(JSON.stringify({variant,fault,side,degrees,maxPenetration,skinAt,maxStep,stepAt,maxLean}));
    expect(maxPenetration, `opposite-leg skin envelopes ${skinAt}`).toBeLessThan(.003);
    expect(maxStep, `no discontinuous hip clearance correction at 60 Hz ${stepAt}`).toBeLessThan(8);
    if (fault === 'trendelenburg' || fault === 'hip-hike') expect(maxLean).toBeLessThan(5);
    const end = rec.frames.at(-1)!.worldTracks!;
    expect(end.L_Foot![0] - end.R_Foot![0], 'feet settle on their own sides').toBeGreaterThan(.1 * cfg.pose.rootScale);
  }, 30000);
});
