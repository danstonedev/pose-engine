import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadRigOf, type Rig } from './plantReleaseRig';
import { applyCustomPose } from '../services/poseRig';
import { setRomClampEnabled } from '../services/poseRomClamp';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { computeBalanceTimeline } from '../services/centerOfMass';
import { buildSquat, MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import type { RomScenarioConstraints } from '../services/romConstraints';

const template = (id: string) => templateToComposedMotion(MOVEMENT_TEMPLATES.find(t => t.id === id)!);
const feet = ['L_Foot', 'R_Foot'] as const;
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((n, i) => n - b[i]!));
const maxDrift = (rec: MotionRecording) => Math.max(...rec.frames.flatMap(f => feet.map(k =>
  distance(f.worldTracks![k]!, rec.frames[0]!.worldTracks![k]!))));
function sample(r: Rig, motion: ComposedMotion, constraints?: RomScenarioConstraints,
  contacts?: Parameters<typeof sampleComposedMotion>[1]['contacts']) {
  r.root.position.copy(r.rootRest0); r.root.quaternion.copy(r.rootQuat0);
  r.root.scale.setScalar(r.variantCfg.pose.rootScale);
  applyCustomPose(r.skinned.skeleton, r.variantCfg, r.baselinePose);
  r.root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(motion, r.variantCfg, { constraints });
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, { baselinePose: r.baselinePose, variantCfg: r.variantCfg,
    rest: r.rest, skeletonHarness: { root: r.root, skinned: r.skinned }, sampleHz: 60, constraints, ...(contacts ? { contacts } : {}) });
}

afterEach(() => setRomClampEnabled(null));
for (const variant of ['male', 'female'] as const) describe(`${variant}: fixed bilateral support`, () => {
  let rig: Rig;
  beforeAll(async () => { rig = await loadRigOf(variant); }, 60_000);

  for (const [label, create, maxFootM, minDepthM] of [
    ['squat builder', () => buildSquat(), .0007, .50],
    ['raw squat', () => template('squat'), .0007, .50],
    ['raw hip hinge', () => template('forward-hip-hinge'), .003, .02],
  ] as const) for (const clampEnabled of [true, false]) {
    it(`${label}: both ankles stay fixed without changing root placement (calibration clamp ${clampEnabled})`, () => {
      setRomClampEnabled(clampEnabled);
      const motion = create();
      expect(motion.contacts?.map(c => c.foot)).toEqual(feet);
      const before = sample(rig, { ...motion, contacts: undefined });
      const after = sample(rig, motion);
      expect(maxDrift(after)).toBeLessThan(maxFootM);
      expect(maxDrift(after)).toBeLessThan(maxDrift(before) / 5);
      expect(computeBalanceTimeline(after).minMarginM).toBeGreaterThan(0);
      const first = after.frames[0]!.worldTracks!;
      expect(first.Hips![1] - Math.min(...after.frames.map(f => f.worldTracks!.Hips![1]))).toBeGreaterThan(minDepthM);
      for (const [i, frame] of after.frames.entries()) {
        const old = before.frames[i]!;
        expect(distance(frame.root.translateM, old.root.translateM), 'support correction must preserve root placement').toBeLessThan(1e-7);
        expect(distance(frame.root.orientQuat, old.root.orientQuat), 'support correction must preserve root rotation').toBeLessThan(1e-7);
        expect(distance(frame.pose.bones.Hips!, old.pose.bones.Hips!), 'pelvic articulation remains authored').toBeLessThan(1e-7);
        for (const key of ['L_Toes', 'R_Toes']) expect(frame.worldTracks![key]![1] - first[key]![1]).toBeGreaterThan(-.0003);
        for (const side of ['L', 'R']) {
          expect(frame.angles[`${side}_UpLeg`]!.hipFlexion!).toBeLessThanOrEqual(120.05);
          expect(frame.angles[`${side}_Leg`]!.kneeFlexion!).toBeLessThanOrEqual(135.05);
        }
      }
      for (const side of ['L', 'R']) expect(Math.abs(after.frames.at(-1)!.angles[`${side}_UpLeg`]!.hipFlexion!)).toBeLessThan(.1);
    });
  }

  it('uses the articulated-pelvis frame at the normative hip limit, even with calibration clamping off', () => {
    setRomClampEnabled(false);
    const rec = sample(rig, buildSquat({ dorsiflexionCapDeg: 26 }));
    for (const f of rec.frames) for (const side of ['L', 'R']) {
      // This target cannot hold both ankles exactly at the current root/depth.
      // Contact IK must keep the real residual instead of granting ~124 deg hip.
      expect(f.angles[`${side}_UpLeg`]!.hipFlexion!).toBeLessThanOrEqual(120.05);
    }
  });

  it('an identity heading profile cannot override the live root/pelvis clamp reference', () => {
    setRomClampEnabled(false);
    const motion = buildSquat({ dorsiflexionCapDeg: 26 });
    const plain = sample(rig, motion);
    const withProfile = sample(rig, { ...motion,
      headingProfileMs: [{ tMs: 0, headingDeg: 0 }, { tMs: 3000, headingDeg: 0 }],
    });
    expect(withProfile.frames).toEqual(plain.frames);
    for (const f of withProfile.frames) for (const side of ['L', 'R']) {
      expect(f.angles[`${side}_UpLeg`]!.hipFlexion!).toBeLessThanOrEqual(120.05);
    }
  });

  it('uses effective contact overrides for both placement eligibility and the final solve', () => {
    const motion = buildSquat();
    const declared = sample(rig, motion);
    const viaOverride = sample(rig, { ...motion, contacts: undefined }, undefined, motion.contacts);
    expect(viaOverride.frames).toEqual(declared.frames);
    const noContacts = sample(rig, { ...motion, contacts: undefined });
    const suppressed = sample(rig, motion, undefined, []);
    expect(suppressed.frames).toEqual(noContacts.frames);
  });

  it('keeps explicit patient bounds through the final contact solve with calibration clamping off', () => {
    setRomClampEnabled(false);
    const constraints: RomScenarioConstraints = Object.fromEntries(['L', 'R'].flatMap(s => [
      [s + '_UpLeg', { hipFlexion: { availableRange: { max: 90 } } }],
      [s + '_Leg', { kneeFlexion: { availableRange: { max: 100 } } }],
      [s + '_Foot', { ankleFlexion: { availableRange: { max: 20 } } }],
    ]));
    const rec = sample(rig, buildSquat(), constraints);
    for (const f of rec.frames) for (const side of ['L', 'R']) {
      expect(f.angles[`${side}_UpLeg`]!.hipFlexion!).toBeLessThanOrEqual(90.05);
      expect(f.angles[`${side}_Leg`]!.kneeFlexion!).toBeLessThanOrEqual(100.05);
      expect(f.angles[`${side}_Foot`]!.ankleFlexion!).toBeLessThanOrEqual(20.05);
    }
  });
});
