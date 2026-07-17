/**
 * INTRA-PHASE TIMING GATE (simMOVE Phase 2b) — proves expandPeakTiming realizes a
 * within-phase LEAD (the ankle dorsiflexing ahead of the knee inside one squat
 * descent) on the real rig, closing the "everything in a keyframe peaks in
 * lockstep" gap the Phase-2 diagnostic measured — while leaving a plan that sets
 * no peakAt byte-identical, and preserving every joint's final amplitude.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { expandPeakTiming, resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, exportKinematics } from '../services/motionRecording';
import { checkCoordination, type CoordinationSourceExport } from '../services/movementCoordination';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
});

function exportOf(m: ComposedMotion): CoordinationSourceExport & { summary: ReturnType<typeof exportKinematics>['summary'] } {
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, `resolve ${m.name}`).toBe('ok');
  const rec = sampleComposedMotion(resolved, { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60 });
  return exportKinematics(rec);
}

/** A planted bilateral squat descent+return; ankle leads when `lead` is set. */
function squat(lead: boolean): ComposedMotion {
  const ankle = (side: string) => ({ joint: `${side}_Foot`, motion: 'ankleFlexion', targetDegrees: 20, ...(lead ? { peakAt: 0.7 } : {}) });
  return {
    name: lead ? 'squat (ankle leads)' : 'squat (lockstep)',
    stance: 'planted',
    startFrom: 'neutral',
    keyframes: [
      {
        durationMs: 1000,
        holdMs: 200,
        targets: [
          ankle('L'), ankle('R'),
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 120 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 120 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 100 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 100 },
        ],
      },
      {
        durationMs: 1000,
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
        ],
      },
    ],
  };
}

const ANKLE_LEADS_KNEE = {
  name: 'ankle-leads-knee',
  order: [{ earlier: 'L_Foot.ankleFlexion', later: 'L_Leg.kneeFlexion', by: 'peak' as const, minLeadFrac: 0.05 }],
};

describe('expandPeakTiming realizes an intra-phase lead', () => {
  it('with peakAt, the ankle peaks BEFORE the knee (lead the critic confirms)', () => {
    const ex = exportOf(expandPeakTiming(squat(true)));
    expect(checkCoordination(ex, ANKLE_LEADS_KNEE).accepted, 'ankle should lead knee').toBe(true);
  });

  it('WITHOUT peakAt the same movement is lockstep — no lead', () => {
    const ex = exportOf(expandPeakTiming(squat(false)));
    // Lockstep: ankle and knee peak together, so the "ankle leads" order fails.
    expect(checkCoordination(ex, ANKLE_LEADS_KNEE).accepted).toBe(false);
  });

  it('preserves every joint final amplitude both sides, and returns to neutral', () => {
    const ex = exportOf(expandPeakTiming(squat(true)));
    for (const side of ['L', 'R']) {
      const knee = ex.summary.joints[`${side}_Leg.kneeFlexion`]!;
      const hip = ex.summary.joints[`${side}_UpLeg.hipFlexion`]!;
      const ankle = ex.summary.joints[`${side}_Foot.ankleFlexion`]!;
      expect(knee.peakDeg).toBeGreaterThan(115); // reaches ~120
      expect(knee.peakDeg).toBeLessThan(125); // no overshoot corruption
      expect(hip.peakDeg).toBeGreaterThan(95);
      expect(ankle.peakDeg).toBeGreaterThan(18);
      expect(knee.minDeg).toBeLessThan(5); // returns toward 0 on the ascent
    }
  });
});

describe('directives ride the split correctly (red-team fixes)', () => {
  it('per-keyframe stance rides ALL sub-keyframes (planted stays planted through the lead)', () => {
    const m: ComposedMotion = {
      name: 'planted-lead',
      startFrom: 'neutral',
      keyframes: [
        {
          durationMs: 1000,
          stance: 'planted',
          targets: [
            { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 20, peakAt: 0.6 },
            { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 120 },
          ],
        },
      ],
    };
    const expanded = expandPeakTiming(m);
    expect(expanded.keyframes.length).toBeGreaterThan(1); // it did split
    expect(expanded.keyframes.every((k) => k.stance === 'planted')).toBe(true);
  });

  it('a keyframe carrying a whole-body directive is NOT expanded (posture preserved)', () => {
    const m: ComposedMotion = {
      startFrom: 'neutral',
      keyframes: [
        { durationMs: 1000, posture: 'supine', targets: [{ joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90, peakAt: 0.5 }] },
      ],
    };
    const e = expandPeakTiming(m);
    expect(e.keyframes.length).toBe(1);
    expect(e.keyframes[0]!.posture).toBe('supine');
  });

  it('expansion is budgeted against MAX_KEYFRAMES — stays valid instead of refusing', () => {
    // 8 keyframes each wanting 2 sub-frames = 16 > 12; must stay ≤ 12 and resolve ok.
    const many: ComposedMotion = {
      startFrom: 'neutral',
      keyframes: Array.from({ length: 8 }, (_, i) => ({
        durationMs: 400,
        targets: [
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: i % 2 ? 40 : 0, peakAt: 0.5 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: i % 2 ? 30 : 0 },
        ],
      })),
    };
    const expanded = expandPeakTiming(many);
    expect(expanded.keyframes.length).toBeLessThanOrEqual(12);
    expect(resolveComposedMotion(expanded, variantCfg).status).toBe('ok');
  });
});

describe('template leads are realized through resolveComposedMotion (runtime wiring)', () => {
  const templateExport = (id: string): CoordinationSourceExport => {
    const t = MOVEMENT_TEMPLATES.find((x) => x.id === id)!;
    // NOTE: no explicit expandPeakTiming call — resolveComposedMotion now runs it.
    const resolved = resolveComposedMotion(templateToComposedMotion(t), variantCfg);
    expect(resolved.status, `resolve ${id}`).toBe('ok');
    const rec = sampleComposedMotion(resolved, {
      baselinePose,
      variantCfg,
      rest,
      skeletonHarness: { root, skinned },
      sampleHz: 60,
    });
    return exportKinematics(rec);
  };

  it('squat template: the ankle now LEADS the knee in the descent (no explicit expand call)', () => {
    const ex = templateExport('squat');
    for (const side of ['L', 'R']) {
      const res = checkCoordination(ex, {
        name: `${side} ankle leads knee`,
        order: [
          {
            earlier: `${side}_Foot.ankleFlexion`,
            later: `${side}_Leg.kneeFlexion`,
            by: 'peak',
            minLeadFrac: 0.05,
          },
        ],
      });
      expect(res.accepted, `${side}: ${res.reasons.join('; ')}`).toBe(true);
    }
  });

  it('hip-hinge template: the hip LEADS the thoracic spine into the reach', () => {
    const res = checkCoordination(templateExport('forward-hip-hinge'), {
      name: 'hip leads thoracic',
      order: [
        { earlier: 'L_UpLeg.hipFlexion', later: 'Spine_Upper.flexion', by: 'peak', minLeadFrac: 0.05 },
      ],
    });
    expect(res.accepted, res.reasons.join('; ')).toBe(true);
  });

  it('a template WITHOUT leads is not expanded (walk keeps its authored keyframe count)', () => {
    const walk = MOVEMENT_TEMPLATES.find((x) => x.id === 'walk')!;
    const authored = templateToComposedMotion(walk);
    // resolveComposedMotion runs expandPeakTiming, but with no peakAt it is a
    // no-op — the resolved keyframe count equals the authored phase count.
    const resolved = resolveComposedMotion(authored, variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.keyframes.length).toBe(walk.phases.length);
  });
});

describe('expandPeakTiming is byte-identical when no peakAt is set (back-compat)', () => {
  it('preserves targets, durations, holdMs and stance on pass-through', () => {
    const plain = squat(false); // has holdMs:200 on keyframe 0, motion-level stance
    const expanded = expandPeakTiming(plain);
    expect(expanded.keyframes.length).toBe(plain.keyframes.length);
    for (let i = 0; i < plain.keyframes.length; i += 1) {
      expect(expanded.keyframes[i]!.durationMs).toBe(plain.keyframes[i]!.durationMs);
      expect(expanded.keyframes[i]!.holdMs).toBe(plain.keyframes[i]!.holdMs);
      expect(expanded.keyframes[i]!.stance).toBe(plain.keyframes[i]!.stance);
      const a = (plain.keyframes[i]!.targets ?? []).map((t) => `${t.joint}.${t.motion}=${t.targetDegrees}`);
      const b = (expanded.keyframes[i]!.targets ?? []).map((t) => `${t.joint}.${t.motion}=${t.targetDegrees}`);
      expect(b).toEqual(a);
    }
  });
});
