import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadRigOf, type Rig } from './plantReleaseRig';
import { applyCustomPose, buildBoneByPoseKey } from '../services/poseRig';
import { computeJointAngles } from '../services/jointAngles';
import { buildComposedCommandPose } from '../services/movementCommand';
import { clampBoneToRom } from '../services/poseRomClamp';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording, type SampleComposedOptions } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import { computeBalanceTimeline } from '../services/centerOfMass';
import { inspectBodyControl, MAJOR_BODY_JOINTS } from '../services/movementControl';
import { buildSitDown, buildStandFromSit, buildSquat, MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { movementScreenMotion, movementScreenPattern } from '../services/movementScreen';

const template = (id: string) => templateToComposedMotion(MOVEMENT_TEMPLATES.find(t => t.id === id)!);
const feet = ['L_Foot', 'R_Foot'] as const;
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((n, i) => n - b[i]!));
function reset(r: Rig) {
  r.root.position.copy(r.rootRest0); r.root.quaternion.copy(r.rootQuat0);
  r.root.scale.setScalar(r.variantCfg.pose.rootScale);
  applyCustomPose(r.skinned.skeleton, r.variantCfg, r.baselinePose);
  r.root.updateMatrixWorld(true);
}
function options(r: Rig): SampleComposedOptions {
  return { baselinePose: r.baselinePose, variantCfg: r.variantCfg, rest: r.rest,
    skeletonHarness: { root: r.root, skinned: r.skinned }, sampleHz: 60 };
}
function sample(r: Rig, motion: ComposedMotion): MotionRecording {
  reset(r);
  const resolved = resolveComposedMotion(motion, r.variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, options(r));
}
function maxFootTravel(rec: MotionRecording) {
  return Math.max(...rec.frames.flatMap(f => feet.map(k => distance(f.worldTracks![k]!, rec.frames[0]!.worldTracks![k]!))));
}
function boneExcursion(rec: MotionRecording, key: string) {
  const base = new THREE.Quaternion().fromArray(rec.frames[0]!.pose.bones[key]!);
  return Math.max(...rec.frames.map(f => base.angleTo(new THREE.Quaternion().fromArray(f.pose.bones[key]!)) * 180 / Math.PI));
}

describe('functional recipes declare complete, inspectable responsibilities', () => {
  for (const motion of [buildSquat(), template('squat'), template('forward-hip-hinge'), template('sit-to-stand'), buildSitDown(), buildStandFromSit()]) {
    it(`${motion.name}: every phase assigns all 23 body joints and its drivers exist`, () => {
      for (const kf of motion.keyframes) {
        expect(Object.keys(kf.control!.joints).sort()).toEqual([...MAJOR_BODY_JOINTS].sort());
        expect(inspectBodyControl(kf.control!, kf.targets)).toEqual([]);
        expect(kf.control!.joints.Head.purpose).toContain('entry Head orientation');
      }
    });
  }
  it('keeps distinct thigh-assistance and relaxed-arm protocols without claiming solved hand contact', () => {
    expect(template('sit-to-stand').keyframes[2]!.targets!.find(t => t.joint === 'L_Hand' && t.motion === 'wristFlexion')!.targetDegrees).toBe(-24);
    expect(buildStandFromSit().keyframes[1]!.targets!.some(t => t.joint.endsWith('_Hand'))).toBe(false);
    for (const m of [template('sit-to-stand'), buildStandFromSit()]) {
      expect(m.contacts!.map(c => c.foot)).toEqual(feet);
      for (const kf of m.keyframes) expect(kf.control!.joints.L_Hand.role).not.toBe('contact');
    }
  });
});

for (const variant of ['male', 'female'] as const) describe(`${variant}: functional recipes on the real rig`, () => {
  let rig: Rig;
  beforeAll(async () => { rig = await loadRigOf(variant); });

  it('raw/default squat are identical, with actual pelvic, thoracic, cervical and shoulder participation', () => {
    const raw = sample(rig, template('squat')), built = sample(rig, buildSquat());
    expect(raw.frames).toEqual(built.frames);
    for (const key of ['Hips', 'Spine_Lower', 'Spine_Mid', 'Spine_Upper', 'Neck_Lower', 'Neck', 'L_Shoulder', 'R_Shoulder']) {
      expect(boneExcursion(built, key), key).toBeGreaterThan(1);
    }
    expect(boneExcursion(built, 'Head'), 'head holds its entry local orientation').toBeLessThan(.01);
    expect(computeBalanceTimeline(built).minMarginM).toBeGreaterThan(0);
    expect(maxFootTravel(built)).toBeLessThan(.03);
    expect(Math.abs(built.frames.at(-1)!.angles.Hips!.anteriorTilt!)).toBeLessThan(.01);
  });

  it('hip hinge shares the spine, reaches with the arms and stays over its feet', () => {
    const rec = sample(rig, template('forward-hip-hinge'));
    expect(computeBalanceTimeline(rec).minMarginM).toBeGreaterThan(0);
    expect(maxFootTravel(rec)).toBeLessThan(.03);
    for (const key of ['Hips', 'Spine_Lower', 'Spine_Mid', 'Spine_Upper', 'L_UpperArm', 'R_UpperArm', 'L_Shoulder', 'R_Shoulder']) {
      expect(boneExcursion(rec, key), key).toBeGreaterThan(1);
    }
  });

  it('the overhead squat preserves toe-floor clearance with articulated pelvis and weight-bearing dorsiflexion', () => {
    const pattern = movementScreenPattern('fms-repo-legacy-v1/deep-squat/deep-squat')!;
    const rec = sample(rig, movementScreenMotion(pattern, 'R', 'movement')!);
    for (const key of ['L_Toes', 'R_Toes']) {
      const initialY = rec.frames[0]!.worldTracks![key]![1]!;
      expect(Math.min(...rec.frames.map(f => f.worldTracks![key]![1]! - initialY)), key).toBeGreaterThan(-.005);
    }
    // Fixed sole orientation adjusts the ankle after the wider-stance leg IK.
    // It must still use weight-bearing range, beyond the 20-degree seated cap.
    const peakAnkle = Math.max(...rec.frames.map(f => f.angles.L_Foot!.ankleFlexion!));
    expect(peakAnkle).toBeGreaterThan(25);
    expect(peakAnkle).toBeLessThanOrEqual(35);
  });

  it('weight-bearing ankle clamp preserves 32 degrees, open-chain remains 20, and explicit restrictions still win', () => {
    for (const [context, max, expected] of [[false, undefined, 20], [true, undefined, 32], [true, 26, 26], [true, 12, 12]] as const) {
      reset(rig);
      const pose = buildComposedCommandPose(rig.baselinePose, 'L_Foot', [{ motion: 'ankleFlexion', degrees: 32 }], rig.variantCfg, rig.baselinePose, rig.rest)!;
      applyCustomPose(rig.skinned.skeleton, rig.variantCfg, pose);
      const foot = buildBoneByPoseKey(rig.skinned.skeleton, rig.variantCfg).get('L_Foot')!;
      const constraints = max == null ? undefined : { L_Foot: { ankleFlexion: { availableRange: { max } } } };
      clampBoneToRom(foot, 'L_Foot', rig.rest, constraints, true, { weightBearing: context });
      const measured = computeJointAngles(rig.skinned.skeleton, rig.variantCfg, variant, rig.rest).joints.L_Foot!.ankleFlexion!;
      expect(measured).toBeCloseTo(expected, 2);
    }
  });

  it('real sit-down to rise keeps the original feet, maintains a continuous seat handoff and finishes standing', () => {
    reset(rig);
    const chain = sampleMotionChain([buildSitDown(), buildStandFromSit()], options(rig));
    expect(chain.map(s => s.status)).toEqual(['ok', 'ok']);
    const down = chain[0]!.recording, up = chain[1]!.recording;
    expect(chain[1]!.seamRootTranslateM).toBeLessThan(.001);
    expect(chain[1]!.seamRootOrientDeg).toBeLessThan(.01);
    for (const rec of [down, up]) expect(maxFootTravel(rec), rec.name).toBeLessThan(.006);
    for (const k of feet) expect(distance(down.frames[0]!.worldTracks![k]!, up.frames.at(-1)!.worldTracks![k]!)).toBeLessThan(.006);
    const largestYStep = Math.max(...up.frames.slice(1).map((f, i) => Math.abs(f.root.translateM[1] - up.frames[i]!.root.translateM[1])));
    expect(largestYStep).toBeLessThan(.03);
    expect(computeBalanceTimeline(down).minMarginM, 'descent stays over the feet until seat support').toBeGreaterThan(0);
    expect(computeBalanceTimeline(up).minMarginM).toBeGreaterThan(0);
    expect(Math.max(...up.frames.map(f => f.angles.Hips!.anteriorTilt!))).toBeGreaterThan(17);
    expect(Math.abs(up.frames.at(-1)!.angles.Hips!.anteriorTilt!)).toBeLessThan(.01);
    expect(up.frames.at(-1)!.angles.L_Leg!.kneeFlexion!).toBeLessThan(1);
  });

  it('continued sagittal transfers reset independent shoulder protraction while holding Head entry orientation', () => {
    reset(rig);
    const carried = buildComposedCommandPose(rig.baselinePose, 'L_Shoulder', [{ motion: 'protraction', degrees: 25 }], rig.variantCfg, rig.baselinePose, rig.rest)!;
    carried.bones.Head = new THREE.Quaternion().fromArray(carried.bones.Head!).multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 20 * Math.PI / 180),
    ).toArray();
    const resolved = resolveComposedMotion(buildSitDown(), rig.variantCfg);
    const rec = sampleComposedMotion(resolved, { ...options(rig), currentPose: carried });
    const final = rec.frames.at(-1)!;
    expect(Math.abs(final.angles.L_Shoulder!.protraction!)).toBeLessThan(.01);
    expect(new THREE.Quaternion().fromArray(final.pose.bones.Head!).normalize().angleTo(new THREE.Quaternion().fromArray(carried.bones.Head!).normalize())).toBeLessThan(1e-6);
  });

  it('raw thigh-assisted setup and rise pins both feet through the seat transition', () => {
    const rec = sample(rig, template('sit-to-stand'));
    expect(maxFootTravel(rec)).toBeLessThan(.006);
    expect(computeBalanceTimeline(rec).minMarginM).toBeGreaterThan(0);
    expect(Math.max(...rec.frames.map(f => f.angles.Hips!.anteriorTilt!))).toBeGreaterThan(17);
  });
});
