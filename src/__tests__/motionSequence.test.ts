/**
 * Generative motion composition (motionSequence.ts).
 *
 * Two layers under test, mirroring movementCommand.test.ts:
 *
 * 1. `resolveComposedMotion` — pure validation + clamping + timing: limits,
 *    the realistic-velocity duration floor, scenario-constraint integration,
 *    and per-target refusal granularity (refused targets dropped + reported,
 *    siblings survive; whole-motion refusal only for invalid shape or when
 *    nothing survives).
 *
 * 2. `buildSequencePoses` — verified against the REAL male runtime rig with
 *    the exact stage boot order: GLB parse (meshopt) → applyAnatomicPose →
 *    captureJointAngleRestReference → apply each keyframe pose →
 *    computeJointAngles, asserting the MEASURED angle lands within ±2.5° of
 *    the CLAMPED target at each keyframe AND that joints a keyframe doesn't
 *    mention persist from the previous keyframe.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import {
  clearRomScenarioConstraints,
  setRomScenarioConstraints,
} from '../services/romConstraints';
import { measureCommandMotion } from '../services/movementCommand';
import {
  MAX_ANGULAR_VELOCITY_DEG_S,
  MAX_KEYFRAMES,
  MAX_TARGETS_PER_KEYFRAME,
  MIN_KEYFRAME_MS,
  buildSequencePoses,
  resolveComposedMotion,
  type ComposedMotion,
  type SequenceKeyframe,
} from '../services/motionSequence';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;

const kf = (
  targets: { joint: string; motion: string; deg: number }[],
  durationMs: number,
  holdMs?: number,
): SequenceKeyframe => ({
  targets: targets.map((t) => ({ joint: t.joint, motion: t.motion, targetDegrees: t.deg })),
  durationMs,
  ...(holdMs != null ? { holdMs } : {}),
});

/** The spec's 3-keyframe 'guarded overhead reach' (right arm). */
const guardedOverheadReach = (): ComposedMotion => ({
  name: 'guarded overhead reach',
  keyframes: [
    kf(
      [
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', deg: 45 },
        { joint: 'R_Forearm', motion: 'elbowFlexion', deg: 30 },
      ],
      600,
    ),
    kf(
      [
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', deg: 110 },
        { joint: 'R_Forearm', motion: 'elbowFlexion', deg: 10 },
        { joint: 'Spine_Lower', motion: 'flexion', deg: -5 },
      ],
      800,
      400,
    ),
    kf(
      [
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', deg: 5 },
        { joint: 'R_Forearm', motion: 'elbowFlexion', deg: 0 },
        { joint: 'Spine_Lower', motion: 'flexion', deg: 0 },
      ],
      900,
    ),
  ],
});

afterEach(() => {
  clearRomScenarioConstraints();
});

// ── 1. resolveComposedMotion (pure) ─────────────────────────────────────────

describe('resolveComposedMotion', () => {
  it('resolves the guarded overhead reach fully complied, timing kept', () => {
    const r = resolveComposedMotion(guardedOverheadReach(), variantCfg);
    expect(r.status).toBe('ok');
    expect(r.keyframes).toHaveLength(3);
    expect(r.outcomes).toHaveLength(8);
    expect(r.outcomes.every((o) => o.status === 'complied')).toBe(true);
    // Requested durations already respect the velocity bound → untouched.
    expect(r.keyframes.map((k) => k.durationMs)).toEqual([600, 800, 900]);
    expect(r.keyframes.map((k) => k.holdMs)).toEqual([0, 400, 0]);
    expect(r.keyframes.some((k) => k.timingAdjusted)).toBe(false);
  });

  it('raises an unrealistic duration to the velocity floor (90° in 200ms)', () => {
    const r = resolveComposedMotion(
      { keyframes: [kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 90 }], 200)] },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    const k = r.keyframes[0]!;
    // 90° at 240°/s needs 375ms.
    expect(k.durationMs).toBe(Math.ceil((90 / MAX_ANGULAR_VELOCITY_DEG_S) * 1000));
    expect(k.durationMs).toBe(375);
    expect(k.timingAdjusted).toBe(true);
  });

  it('measures each keyframe delta from the PREVIOUS keyframe, not neutral', () => {
    // kf1 knee 0→90 (needs 375ms); kf2 90→100 (Δ10° — 150ms floor suffices).
    const r = resolveComposedMotion(
      {
        keyframes: [
          kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 90 }], 1000),
          kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 100 }], 10),
        ],
      },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.keyframes[0]!.durationMs).toBe(1000);
    expect(r.keyframes[1]!.durationMs).toBe(MIN_KEYFRAME_MS);
    expect(r.keyframes[1]!.timingAdjusted).toBe(true);
  });

  it('enforces the minimum keyframe duration even for tiny travels', () => {
    const r = resolveComposedMotion(
      { keyframes: [kf([{ joint: 'R_Foot', motion: 'ankleFlexion', deg: 5 }], 10)] },
      variantCfg,
    );
    expect(r.keyframes[0]!.durationMs).toBe(MIN_KEYFRAME_MS);
    expect(r.keyframes[0]!.timingAdjusted).toBe(true);
  });

  it('clamps through scenario constraints and reports modified + limitedBy', () => {
    setRomScenarioConstraints({
      R_UpperArm: { shoulderFlexion: { availableRange: { min: -20, max: 70 } } },
    });
    const r = resolveComposedMotion(guardedOverheadReach(), variantCfg);
    expect(r.status).toBe('ok');
    const kf2Shoulder = r.outcomes.find(
      (o) => o.keyframe === 1 && o.joint === 'R_UpperArm' && o.motion === 'shoulderFlexion',
    )!;
    expect(kf2Shoulder.status).toBe('modified');
    expect(kf2Shoulder.clampedDegrees).toBe(70);
    expect(kf2Shoulder.limitedBy).toBe('scenario-constraint');
    // The playable keyframe carries the CLAMPED value.
    const t = r.keyframes[1]!.targets.find(
      (x) => x.joint === 'R_UpperArm' && x.motion === 'shoulderFlexion',
    )!;
    expect(t.clampedDegrees).toBe(70);
  });

  it('drops a refused (bogus) target but keeps its valid siblings', () => {
    const r = resolveComposedMotion(
      {
        keyframes: [
          kf(
            [
              { joint: 'R_Foot', motion: 'wingFlap', deg: 10 },
              { joint: 'R_Leg', motion: 'kneeFlexion', deg: 30 },
            ],
            600,
          ),
        ],
      },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.keyframes[0]!.targets).toEqual([
      { joint: 'R_Leg', motion: 'kneeFlexion', clampedDegrees: 30 },
    ]);
    const refused = r.outcomes.find((o) => o.motion === 'wingFlap')!;
    expect(refused.status).toBe('refused');
    expect(refused.reason).toBe('unknown-motion');
  });

  it('refuses the WHOLE motion only when zero targets survive anywhere', () => {
    const r = resolveComposedMotion(
      {
        keyframes: [
          kf([{ joint: 'R_Foot', motion: 'wingFlap', deg: 10 }], 500),
          kf([{ joint: 'L_Forearm', motion: 'elbowDeviation', deg: 10 }], 500),
        ],
      },
      variantCfg,
    );
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('no-achievable-targets');
    // Every refused target still reported.
    expect(r.outcomes).toHaveLength(2);
    expect(r.outcomes.every((o) => o.status === 'refused')).toBe(true);
  });

  it(`refuses more than ${MAX_KEYFRAMES} keyframes`, () => {
    const frames = Array.from({ length: 13 }, () =>
      kf([{ joint: 'R_Foot', motion: 'ankleFlexion', deg: 5 }], 300),
    );
    const r = resolveComposedMotion({ keyframes: frames }, variantCfg);
    expect(r.status).toBe('refused');
    expect(r.reason).toContain('too-many-keyframes');
  });

  it(`refuses a keyframe with more than ${MAX_TARGETS_PER_KEYFRAME} targets`, () => {
    const targets = [
      'L_Foot',
      'R_Foot',
      'L_Leg',
      'R_Leg',
      'L_UpLeg',
      'R_UpLeg',
      'L_Forearm',
      'R_Forearm',
      'Spine_Lower',
    ].map((joint) => ({
      joint,
      motion: joint === 'Spine_Lower' ? 'flexion' : 'ankleFlexion',
      deg: 5,
    }));
    const r = resolveComposedMotion({ keyframes: [kf(targets, 500)] }, variantCfg);
    expect(r.status).toBe('refused');
    expect(r.reason).toContain('too many targets');
  });

  it('refuses malformed shapes (no keyframes / empty targets / bad duration)', () => {
    expect(resolveComposedMotion({ keyframes: [] }, variantCfg).status).toBe('refused');
    expect(
      resolveComposedMotion({ keyframes: [{ targets: [], durationMs: 500 }] }, variantCfg).status,
    ).toBe('refused');
    expect(
      resolveComposedMotion(
        { keyframes: [kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 30 }], Number.NaN)] },
        variantCfg,
      ).status,
    ).toBe('refused');
    expect(
      resolveComposedMotion(
        {
          keyframes: [
            { targets: [{ joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 30 }], durationMs: 500, holdMs: -1 },
          ],
        },
        variantCfg,
      ).status,
    ).toBe('refused');
  });

  it('carries name / loop / modifiers through', () => {
    const r = resolveComposedMotion(
      {
        name: 'sway test',
        loop: true,
        modifiers: { guarding: 0.5, timeScale: 0.8 },
        keyframes: [kf([{ joint: 'Neck', motion: 'rotation', deg: 30 }], 500)],
      },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.name).toBe('sway test');
    expect(r.loop).toBe(true);
    expect(r.modifiers).toEqual({ guarding: 0.5, timeScale: 0.8 });
  });
});

// ── 2. buildSequencePoses against the REAL male runtime rig ─────────────────

const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let anatomicLocals: Map<THREE.Bone, THREE.Quaternion>;

function resetToAnatomic(): void {
  for (const [bone, q] of anatomicLocals) bone.quaternion.copy(q);
  root.updateMatrixWorld(true);
}

function applyAndMeasure(pose: CustomPose) {
  const applied = applyCustomPose(skinned.skeleton, variantCfg, pose);
  expect(applied).toBeGreaterThan(0);
  root.updateMatrixWorld(true);
  return computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
}

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.parse(arrayBuffer, '', resolve, reject);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  expect(skinned).toBeDefined();

  // The exact ExamStage3D boot order: anatomic pose FIRST, then rest-reference
  // capture, then the baseline-pose serialization every command builds from.
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  anatomicLocals = new Map();
  for (const bone of skinned.skeleton.bones) anatomicLocals.set(bone, bone.quaternion.clone());
});

describe('buildSequencePoses on the real male rig', () => {
  const TOL = 2.5;

  it('guarded overhead reach: every keyframe measures within ±2.5° of its clamped targets', () => {
    resetToAnatomic();
    const resolved = resolveComposedMotion(guardedOverheadReach(), variantCfg);
    expect(resolved.status).toBe('ok');
    const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest);
    expect(built.poses).toHaveLength(3);
    expect(built.durationsMs).toEqual([600, 800, 900]);
    expect(built.holdsMs).toEqual([0, 400, 0]);
    expect(built.loop).toBe(false);

    for (const [ki, pose] of built.poses.entries()) {
      const report = applyAndMeasure(pose);
      for (const t of resolved.keyframes[ki]!.targets) {
        const measured = measureCommandMotion(report, t.joint, t.motion)!;
        expect(
          Math.abs(measured - t.clampedDegrees),
          `kf${ki} ${t.joint}.${t.motion}: measured ${measured} vs clamped ${t.clampedDegrees}`,
        ).toBeLessThan(TOL);
      }
      // Joints the sequence never mentions stay parked at every keyframe.
      expect(Math.abs(measureCommandMotion(report, 'R_Leg', 'kneeFlexion')!)).toBeLessThan(1);
      expect(Math.abs(report.joints.L_Foot.ankleFlexion)).toBeLessThan(1);
      // kf1 doesn't mention the trunk → it stays at the baseline 0° there.
      if (ki === 0) {
        expect(Math.abs(measureCommandMotion(report, 'Spine_Lower', 'flexion')!)).toBeLessThan(1);
      }
    }
  });

  it('unmentioned joints PERSIST across keyframes (kf1 knee 30 survives kf2 ankle-only)', () => {
    resetToAnatomic();
    const resolved = resolveComposedMotion(
      {
        keyframes: [
          kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 30 }], 500),
          kf([{ joint: 'R_Foot', motion: 'ankleFlexion', deg: -12 }], 500),
          kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 60 }], 500),
        ],
      },
      variantCfg,
    );
    expect(resolved.status).toBe('ok');
    const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest);

    // kf2: the knee override from kf1 survives verbatim while the ankle moves.
    expect(built.poses[1]!.bones.R_Leg).toEqual(built.poses[0]!.bones.R_Leg);
    const kf2 = applyAndMeasure(built.poses[1]!);
    expect(Math.abs(measureCommandMotion(kf2, 'R_Leg', 'kneeFlexion')! - 30)).toBeLessThan(TOL);
    expect(Math.abs(measureCommandMotion(kf2, 'R_Foot', 'ankleFlexion')! - -12)).toBeLessThan(TOL);

    // kf3: re-commanding the knee REPLACES its angle (absolute, not additive)
    // while the ankle from kf2 persists.
    const kf3 = applyAndMeasure(built.poses[2]!);
    expect(Math.abs(measureCommandMotion(kf3, 'R_Leg', 'kneeFlexion')! - 60)).toBeLessThan(TOL);
    expect(Math.abs(measureCommandMotion(kf3, 'R_Foot', 'ankleFlexion')! - -12)).toBeLessThan(TOL);
  });

  it('scenario constraint caps kf2 of the overhead reach at 70° and the rig lands there', () => {
    resetToAnatomic();
    setRomScenarioConstraints({
      R_UpperArm: { shoulderFlexion: { availableRange: { min: -20, max: 70 } } },
    });
    const resolved = resolveComposedMotion(guardedOverheadReach(), variantCfg);
    expect(resolved.status).toBe('ok');
    const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest);
    const report = applyAndMeasure(built.poses[1]!);
    const measured = measureCommandMotion(report, 'R_UpperArm', 'shoulderFlexion')!;
    expect(Math.abs(measured - 70)).toBeLessThan(TOL);
    // …and the outcome the AI narrates from says modified/scenario-constraint.
    const o = resolved.outcomes.find(
      (x) => x.keyframe === 1 && x.joint === 'R_UpperArm' && x.motion === 'shoulderFlexion',
    )!;
    expect(o.status).toBe('modified');
    expect(o.limitedBy).toBe('scenario-constraint');
  });

  it('a keyframe that survives a dropped sibling still builds and measures true', () => {
    resetToAnatomic();
    const resolved = resolveComposedMotion(
      {
        keyframes: [
          kf(
            [
              { joint: 'R_Foot', motion: 'wingFlap', deg: 10 },
              { joint: 'R_Leg', motion: 'kneeFlexion', deg: 30 },
            ],
            600,
          ),
        ],
      },
      variantCfg,
    );
    expect(resolved.status).toBe('ok');
    const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest);
    const report = applyAndMeasure(built.poses[0]!);
    expect(Math.abs(measureCommandMotion(report, 'R_Leg', 'kneeFlexion')! - 30)).toBeLessThan(TOL);
  });
});
