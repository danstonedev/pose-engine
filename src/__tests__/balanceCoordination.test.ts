/**
 * BALANCE COORDINATION — COM-driven postural control (Wave 2, item 2.1).
 *
 * The universal author-time generalization of Wave 1's hand-authored
 * counterbalance: for a motion flagged `balanceAssist`, the sampler/stage
 * pre-pass measures each resolved keyframe's COM-vs-base-of-support offset on
 * the rig and ADDS capped, ROM-clamped re-centering targets (stance-hip shift,
 * lifted-leg adduction, trunk list/counterlean, stance-side arm). Gates:
 *
 *  1. RESIDUAL CORRECTION — a de-tuned copy of a template with its authored
 *     counterbalance stripped stands OFF its one-foot base (the Wave-0 defect);
 *     balanceCoordination alone flips the balance-hold margin positive.
 *  2. CONSUMERS — the flagged templates (single-leg stance, kick) hold their
 *     steady single-support phases at a real margin; the endpoint reach, which
 *     already balances by its authored hinge, is returned IDENTICAL (the
 *     residual contract: never lean an already-stable pose).
 *  3. DETERMINISM — the pre-pass is a pure function: two samples byte-identical.
 *  4. EXCLUSIONS — even when flagged, gait/travel, loops, airborne, lying and
 *     grounding-posture motions are untouched (returned by reference).
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
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { computeBalanceTimeline, type BalanceTimeline } from '../services/centerOfMass';
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  buildTravelWalk,
  buildSingleLegHop,
} from '../services/movementTemplates';
import { balanceCoordination, balanceAssistApplies } from '../services/balanceCoordination';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;

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
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
}

function sampleMotion(m: ComposedMotion): MotionRecording {
  resetHarness();
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  });
}

function template(id: string): ComposedMotion {
  return templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === id)!);
}

/** Margin of the frame nearest `tMs`, meters (throws if unsupported there). */
function marginAt(tl: BalanceTimeline, tMs: number): number {
  let best = tl.frames[0]!;
  for (const f of tl.frames) if (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  expect(best.marginM, `margin at ${tMs}ms`).not.toBeNull();
  return best.marginM!;
}

function minOneFoot(tl: BalanceTimeline): number {
  const oneFoot = tl.frames.filter((f) => f.contacts.length === 1);
  expect(oneFoot.length).toBeGreaterThan(0);
  return Math.min(...oneFoot.map((f) => f.marginM ?? Infinity));
}

// ── 1. Residual correction: the transform alone rescues a stripped template ──

/** Strip Wave 1's authored counterbalance channels from a motion — the
 *  "de-tuned copy without authored counterbalance" of the roadmap gate.
 *  Keyframes left empty by the strip are dropped (a keyframe needs a target). */
const COUNTERBALANCE_KEYS = new Set([
  'L_UpLeg.hipAbduction',
  'R_UpLeg.hipAbduction',
  'Spine_Lower.lateralTilt',
  'Spine_Upper.lateralTilt',
  'L_UpperArm.shoulderAbduction',
]);
function stripCounterbalance(m: ComposedMotion): ComposedMotion {
  return {
    ...m,
    keyframes: m.keyframes
      .map((kf) => ({
        ...kf,
        targets: (kf.targets ?? []).filter((t) => !COUNTERBALANCE_KEYS.has(`${t.joint}.${t.motion}`)),
      }))
      .filter((kf) => (kf.targets?.length ?? 0) > 0 || kf.root || kf.travel || kf.posture || kf.stance),
  };
}

describe('balanceCoordination flips a counterbalance-free single-leg stance onto its base', () => {
  it('unassisted the stripped copy topples; assisted it holds a positive margin', () => {
    const bare = stripCounterbalance({ ...template('single-leg-stance'), balanceAssist: false });
    const tlBare = computeBalanceTimeline(sampleMotion(bare));
    // The pre-Wave-1 defect, reproduced: the COM stands ~4 cm OFF the one-foot
    // base for the whole balance hold.
    expect(minOneFoot(tlBare)).toBeLessThan(-0.03);
    expect(marginAt(tlBare, 1500)).toBeLessThan(-0.03); // mid-hold, toppling

    const tlAssisted = computeBalanceTimeline(sampleMotion({ ...bare, balanceAssist: true }));
    // balanceCoordination ALONE (no authored counterbalance anywhere) flips the
    // balance hold positive: the measured COM is leaned back over the foot.
    expect(marginAt(tlAssisted, 1500)).toBeGreaterThan(0.005); // mid-hold, ON the base
    // Whole-motion: the only sub-zero excursion left is the weight-TRANSFER
    // transient (double→single). Without an authored early (peakAt) shift the
    // corrections tween in across the whole lift, so the transient dips ~1.7 cm
    // (rig-measured — vs −4.2 cm SUSTAINED unassisted); the flagged REAL
    // template, whose de-tuned authored shift still peaks early, grazes zero
    // instead (gated below). Anticipatory transfer timing is Wave 3 (3.1).
    expect(minOneFoot(tlAssisted)).toBeGreaterThan(-0.025);
    expect(tlAssisted.balancedFraction).toBeGreaterThan(tlBare.balancedFraction + 0.3);
  });
});

// ── 2. Consumers: flagged templates hold their base ──────────────────────────

describe('balanceAssist consumers (single-leg stance, kick, endpoint reach)', () => {
  it('single-leg stance: steady one-foot hold at a real margin; transfer grazes zero at worst', () => {
    const tl = computeBalanceTimeline(sampleMotion(template('single-leg-stance')));
    expect(tl.airborneFraction).toBe(0);
    // Mid-hold (t=1500ms of the 1500ms hold): comfortably ON the one-foot base
    // (rig-measured ~+4.0 cm; Wave 1's authored-only best was +1.3 cm).
    expect(marginAt(tl, 1500)).toBeGreaterThan(0.03);
    // Whole one-foot phase: only the transfer instants graze zero.
    expect(minOneFoot(tl)).toBeGreaterThan(-0.005);
    expect(tl.balancedFraction).toBeGreaterThan(0.95);
  });

  it('kick: the strike is thrown from a re-centered single-leg stance', () => {
    const tl = computeBalanceTimeline(sampleMotion(template('kick')));
    expect(tl.airborneFraction).toBe(0);
    // Strike settle+hold (t≈950-1050ms): a real positive margin (rig ~+3.3 cm;
    // Wave 1's authored-only best was +0.1 cm).
    expect(marginAt(tl, 1000)).toBeGreaterThan(0.02);
    // Wind-up settle (t≈450ms) is also on-base.
    expect(marginAt(tl, 450)).toBeGreaterThan(0.01);
    expect(tl.minMarginM!).toBeGreaterThan(-0.005);
    expect(tl.balancedFraction).toBeGreaterThan(0.95);
  });

  it('endpoint reach: already balanced by its authored hinge — the assist is IDENTITY', () => {
    resetHarness();
    const resolved = resolveComposedMotion(template('endpoint-reach'), variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.balanceAssist).toBe(true);
    // The residual contract: every keyframe measures ≥ the safe margin, so the
    // transform returns the resolved motion UNTOUCHED (same reference).
    const out = balanceCoordination(resolved, {
      root,
      skinned,
      variantCfg,
      baselinePose,
      rest,
    });
    expect(out).toBe(resolved);
    // And the sampled margins stay exactly as Wave 1 authored them.
    const tl = computeBalanceTimeline(sampleMotion(template('endpoint-reach')));
    expect(tl.minMarginM!).toBeGreaterThan(0.04);
    expect(tl.balancedFraction).toBeGreaterThan(0.99);
  });
});

// ── 3. Determinism ───────────────────────────────────────────────────────────

describe('balanceCoordination is deterministic (build-time, no hidden state)', () => {
  it('two assisted samples are byte-identical', () => {
    const a = sampleMotion(template('kick'));
    const b = sampleMotion(template('kick'));
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
  });
});

// ── 4. Hard exclusions (even when flagged) ───────────────────────────────────

describe('balanceAssist hard exclusions', () => {
  const applies = (m: ComposedMotion): boolean => {
    const resolved = resolveComposedMotion(m, variantCfg);
    expect(resolved.status).toBe('ok');
    return balanceAssistApplies(resolved);
  };

  it('unflagged motions are never touched', () => {
    expect(applies(template('squat'))).toBe(false);
    expect(applies({ ...template('single-leg-stance'), balanceAssist: false })).toBe(false);
  });

  it('a flagged looping gait is excluded and sampled untouched (byte-identical)', () => {
    const walk = template('walk');
    expect(walk.loop).toBe(true);
    expect(applies({ ...walk, balanceAssist: true })).toBe(false);
    const plain = sampleMotion(walk);
    const flagged = sampleMotion({ ...walk, balanceAssist: true });
    expect(JSON.stringify(flagged.frames)).toBe(JSON.stringify(plain.frames));
  });

  it('a flagged foot-driven travelling gait is excluded', () => {
    expect(applies({ ...buildTravelWalk(), balanceAssist: true })).toBe(false);
  });

  it('a flagged airborne motion (hop — floating keyframes) is excluded', () => {
    expect(applies({ ...buildSingleLegHop({ stance: 'L' }), balanceAssist: true })).toBe(false);
  });

  it('flagged lying and grounding-posture motions are excluded', () => {
    const lie: ComposedMotion = {
      name: 'lie-down',
      balanceAssist: true,
      stance: 'planted',
      keyframes: [
        { targets: [{ joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 10 }], durationMs: 600, posture: 'supine' },
      ],
    };
    expect(applies(lie)).toBe(false);
    const sit: ComposedMotion = {
      name: 'sit',
      balanceAssist: true,
      stance: 'planted',
      keyframes: [
        {
          targets: [
            { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 85 },
            { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 85 },
          ],
          durationMs: 800,
          groundingPosture: 'sitting',
        },
      ],
    };
    expect(applies(sit)).toBe(false);
  });
});
