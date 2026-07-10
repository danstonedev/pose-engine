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
  MAX_KEYFRAME_MS,
  MAX_TARGETS_PER_KEYFRAME,
  MIN_KEYFRAME_MS,
  buildSequencePoses,
  resolveComposedMotion,
  type ComposedMotion,
  type SequenceKeyframe,
} from '../services/motionSequence';
import { rootOrientQuatTuple } from '../services/rootMotion';
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

  it('caps an unbounded durationMs at MAX_KEYFRAME_MS and flags timingAdjusted (H1 stage-DoS guard)', () => {
    // 1e12 ms would freeze a host's serialized command chain forever.
    const r = resolveComposedMotion(
      { keyframes: [kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 90 }], 1e12)] },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(MAX_KEYFRAME_MS).toBe(10_000);
    expect(r.keyframes[0]!.durationMs).toBe(MAX_KEYFRAME_MS);
    expect(r.keyframes[0]!.timingAdjusted).toBe(true);
  });

  it('velocity floor still wins over a too-short request but never exceeds the cap', () => {
    // 90° in 200ms → floor raises to 375ms; well under the cap, so the floor rules.
    const r = resolveComposedMotion(
      { keyframes: [kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 90 }], 200)] },
      variantCfg,
    );
    expect(r.keyframes[0]!.durationMs).toBe(375);
    expect(r.keyframes[0]!.durationMs).toBeLessThanOrEqual(MAX_KEYFRAME_MS);
    expect(r.keyframes[0]!.timingAdjusted).toBe(true);
    // A sane in-range request is untouched (no over-eager capping).
    const ok = resolveComposedMotion(
      { keyframes: [kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 90 }], 2000, 500)] },
      variantCfg,
    );
    expect(ok.keyframes[0]!.durationMs).toBe(2000);
    expect(ok.keyframes[0]!.holdMs).toBe(500);
    expect(ok.keyframes[0]!.timingAdjusted).toBeUndefined();
  });

  it('clamps holdMs engine-side to MAX_KEYFRAME_MS (H1)', () => {
    const r = resolveComposedMotion(
      { keyframes: [kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 90 }], 1000, 1e12)] },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.keyframes[0]!.holdMs).toBe(MAX_KEYFRAME_MS);
    expect(r.keyframes[0]!.timingAdjusted).toBe(true);
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

  // A legitimate full-body keyframe: 2 hips + 2 knees + 2 ankles + trunk×2 +
  // 2 elbows + 2 shoulders (12), plus the neck as the 13th (overflow).
  const fullBodyTargets = [
    ['L_UpLeg', 'hipFlexion'],
    ['R_UpLeg', 'hipFlexion'],
    ['L_Leg', 'kneeFlexion'],
    ['R_Leg', 'kneeFlexion'],
    ['L_Foot', 'ankleFlexion'],
    ['R_Foot', 'ankleFlexion'],
    ['Spine_Lower', 'flexion'],
    ['Spine_Upper', 'flexion'],
    ['L_Forearm', 'elbowFlexion'],
    ['R_Forearm', 'elbowFlexion'],
    ['L_UpperArm', 'shoulderFlexion'],
    ['R_UpperArm', 'shoulderFlexion'],
    ['Neck', 'flexion'],
  ].map(([joint, motion]) => ({ joint: joint!, motion: motion!, deg: 5 }));

  it(`a keyframe with exactly ${MAX_TARGETS_PER_KEYFRAME} targets resolves clean`, () => {
    expect(MAX_TARGETS_PER_KEYFRAME).toBe(12);
    const r = resolveComposedMotion(
      { keyframes: [kf(fullBodyTargets.slice(0, 12), 500)] },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.keyframes[0]!.targets).toHaveLength(12);
    expect(r.outcomes).toHaveLength(12);
    expect(r.outcomes.every((o) => o.status !== 'refused')).toBe(true);
  });

  it(`overflow past ${MAX_TARGETS_PER_KEYFRAME} targets is NON-FATAL: first 12 play, the rest refuse as 'target-limit'`, () => {
    const r = resolveComposedMotion({ keyframes: [kf(fullBodyTargets, 500)] }, variantCfg);
    expect(r.status).toBe('ok'); // the keyframe/plan is never refused for overflow alone
    // Deterministic order as received: the first 12 survive…
    expect(r.keyframes[0]!.targets.map((t) => t.joint)).toEqual(
      fullBodyTargets.slice(0, 12).map((t) => t.joint),
    );
    // …and the 13th (the neck) is refused-with-reason, still fully reported.
    expect(r.outcomes).toHaveLength(13);
    const dropped = r.outcomes.filter((o) => o.reason === 'target-limit');
    expect(dropped).toEqual([
      {
        keyframe: 0,
        joint: 'Neck',
        motion: 'flexion',
        status: 'refused',
        requestedDegrees: 5,
        reason: 'target-limit',
      },
    ]);
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

  it('accepts a ROOT-ONLY keyframe (lie supine: zero targets, root.orient pitch −90)', () => {
    const r = resolveComposedMotion(
      {
        name: 'lie down on your back',
        keyframes: [{ durationMs: 1500, root: { orient: { pitchDeg: -90 } } }],
      },
      variantCfg,
    );
    expect(r.status).toBe('ok');
    expect(r.keyframes).toHaveLength(1);
    expect(r.keyframes[0]!.targets).toEqual([]);
    expect(r.keyframes[0]!.root).toEqual({ orient: { pitchDeg: -90 } });
    expect(r.outcomes).toEqual([]);
  });

  it('accepts a STANCE-ONLY keyframe; a keyframe with nothing at all still refuses', () => {
    const ok = resolveComposedMotion(
      { keyframes: [{ durationMs: 500, stance: 'planted' }] },
      variantCfg,
    );
    expect(ok.status).toBe('ok');
    expect(ok.keyframes[0]!.stance).toBe('planted');
    // Neither targets nor root nor stance → invalid, with the updated message.
    const bad = resolveComposedMotion({ keyframes: [{ durationMs: 500 }] }, variantCfg);
    expect(bad.status).toBe('refused');
    expect(bad.reason).toBe('keyframe 0: needs at least one target, root, or stance change');
  });

  it('a root directive keeps the MOTION alive even when every joint target is refused', () => {
    const r = resolveComposedMotion(
      {
        keyframes: [
          {
            targets: [{ joint: 'R_Foot', motion: 'wingFlap', targetDegrees: 10 }],
            durationMs: 800,
            root: { orient: { pitchDeg: -90 } },
          },
        ],
      },
      variantCfg,
    );
    expect(r.status).toBe('ok'); // posture still plays; the bogus target is reported
    expect(r.keyframes[0]!.targets).toEqual([]);
    expect(r.outcomes[0]!.status).toBe('refused');
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

  it('ROOT-ONLY keyframe on the rig: body goes horizontal (supine) while joints hold', () => {
    resetToAnatomic();
    const resolved = resolveComposedMotion(
      {
        name: 'lie down on your back',
        keyframes: [
          kf([{ joint: 'R_Leg', motion: 'kneeFlexion', deg: 30 }], 500),
          { durationMs: 1500, root: { orient: { pitchDeg: -90 } } },
        ],
      },
      variantCfg,
    );
    expect(resolved.status).toBe('ok');
    const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest);
    expect(built.poses).toHaveLength(2);
    // The target-less keyframe carries the previous JOINT pose forward verbatim…
    expect(built.poses[1]).toEqual(built.poses[0]);
    // …and applies its root directive (kf1 had none → identity carried in).
    expect(built.roots[0]!.quat).toEqual([0, 0, 0, 1]);
    expect(built.roots[1]!.quat).toEqual(rootOrientQuatTuple({ pitchDeg: -90 }));
    expect(built.durationsMs).toEqual([500, 1500]);

    // Joints hold: the knee from kf1 still measures 30° at the supine keyframe.
    const report = applyAndMeasure(built.poses[1]!);
    expect(Math.abs(measureCommandMotion(report, 'R_Leg', 'kneeFlexion')! - 30)).toBeLessThan(TOL);

    // The body actually goes HORIZONTAL: applying the keyframe's root
    // orientation to the model root drops the head from standing height to
    // ~floor level (the engine's documented supine convention).
    const head = skinned.skeleton.bones.find((b) => /head/i.test(b.name));
    expect(head).toBeDefined();
    const p = new THREE.Vector3();
    const standingY = head!.getWorldPosition(p).y;
    const savedQuat = root.quaternion.clone();
    try {
      const [qx, qy, qz, qw] = built.roots[1]!.quat;
      root.quaternion.set(qx, qy, qz, qw);
      root.updateMatrixWorld(true);
      const supineY = head!.getWorldPosition(p).y;
      expect(standingY).toBeGreaterThan(1); // sanity: the head starts at standing height
      expect(supineY).toBeLessThan(standingY * 0.3); // supine: head near floor level
    } finally {
      root.quaternion.copy(savedQuat);
      root.updateMatrixWorld(true);
    }
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
