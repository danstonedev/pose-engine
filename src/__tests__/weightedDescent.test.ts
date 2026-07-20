/**
 * GRAVITY-SHAPED GROUNDED DESCENTS — weighted lowers (Wave 3, item 3.3).
 *
 * The audit's "grounded weight" finding: sit-down / floor get-downs eased
 * SYMMETRICALLY into their bottoms — peak descent speed mid-span, braking into
 * the stop — a hydraulic lower, not bodyweight caught. For a motion flagged
 * `weightedDescent`, the sampler/stage pre-pass now re-times each
 * monotone-descending span of the grounded root-Y toward a gravity-consistent
 * profile (slow early, fast late, arrested by the existing grounding), root-Y
 * ONLY. Gates:
 *
 *  1. GRAVITY SHAPE — the flagged sit-down's descent speed is monotone
 *     non-decreasing until the final arrest window and ARRIVES at the seat at
 *     (essentially) its top speed; the unflagged baseline provably brakes
 *     before the bottom (the hydraulic ease this item removes).
 *  2. ROOT-Y-ONLY CONTRACT — flagged vs unflagged sit-down: every pose, every
 *     measured angle, the root orientation and the horizontal root path are
 *     byte-identical; only root-Y moves, bounded by the hover/dip band.
 *  3. GROUNDING — the pinned feet never visibly leave or clip the floor.
 *  4. BYTE-IDENTITY + DETERMINISM — unflagged motions (the clinical squat — a
 *     controlled eccentric, deliberately NOT flagged) carry no flag and sample
 *     deterministically; a flagged motion with no qualifying descent span (the
 *     plank get-down, whose drop is a grounding-switch step) is byte-identical
 *     to its unflagged twin; flagged sampling is deterministic.
 *  5. EXCLUSIONS — even when flagged: airborne, loops, gait/travel, calibrated
 *     verticals, and declared IK contacts are refused by the gate.
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
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  buildTravelWalk,
  buildSitDown,
  buildLieDown,
  buildGetDownToPlank,
  buildGetDownToQuadruped,
} from '../services/movementTemplates';
import {
  applyWeightedDescent,
  deriveWeightedDescent,
  weightedDescentApplies,
  WEIGHTED_DESCENT_MAX_DIP_M,
  WEIGHTED_DESCENT_MAX_HOVER_M,
} from '../services/rootMotion';
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

/** Strip the opt-in flag — the pre-item baseline of the same motion. */
const unflag = (m: ComposedMotion): ComposedMotion => {
  const bare = { ...m };
  delete bare.weightedDescent;
  return bare;
};

const rootY = (rec: MotionRecording): number[] => rec.frames.map((f) => f.root.translateM[1]);

/** Descent-speed series (m/s, + = down) between consecutive frames. */
function descentSpeeds(rec: MotionRecording): number[] {
  const y = rootY(rec);
  const v: number[] = [0];
  for (let i = 1; i < y.length; i += 1) {
    const dt = (rec.frames[i]!.tMs - rec.frames[i - 1]!.tMs) / 1000;
    v.push(dt > 0 ? (y[i - 1]! - y[i]!) / dt : 0);
  }
  return v;
}

/** [startIdx, endIdx] of the main descent: from 1 cm below the start height to
 *  the first frame at the bottom (within 1 mm of the global minimum). */
function descentRange(rec: MotionRecording): [number, number] {
  const y = rootY(rec);
  const minY = Math.min(...y);
  const start = y.findIndex((v) => v <= y[0]! - 0.01);
  const end = y.findIndex((v) => v <= minY + 1e-3);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return [start, end];
}

// ── 1. Gravity shape: the flagged sit-down accelerates until the catch ──────

/** Arrest window (ms) before the bottom — the catch itself (the seat/floor pin
 *  plus the authored settle) is excluded from the monotonicity check. */
const ARREST_MS = 80;
/** Running-max tolerance (m/s): descent speed may never fall more than this
 *  below its running maximum before the arrest window. */
const MONO_TOL_MS = 0.03;

interface DescentShape {
  /** Worst drop of speed below its running max before the arrest window. */
  worstBrakeMs: number;
  /** Mean speed over the last 3 approach samples ÷ peak approach speed. */
  terminalRatio: number;
  /** Running max minus the LAST approach sample's speed (m/s) — how much
   *  speed the descent has given back by the end of the approach. */
  lastApproachDeficitMs: number;
  /** Normalized time (0..1 of the descent) of the overall peak speed. */
  peakAtU: number;
}

function shapeOf(rec: MotionRecording): DescentShape {
  const [start, end] = descentRange(rec);
  const v = descentSpeeds(rec);
  const tEnd = rec.frames[end]!.tMs;
  let approachEnd = start;
  for (let i = start; i <= end; i += 1) {
    if (rec.frames[i]!.tMs <= tEnd - ARREST_MS) approachEnd = i;
  }
  let runningMax = 0;
  let worstBrakeMs = 0;
  let peakV = 0;
  let peakAtU = 0;
  for (let i = start + 1; i <= approachEnd; i += 1) {
    worstBrakeMs = Math.max(worstBrakeMs, runningMax - v[i]!);
    runningMax = Math.max(runningMax, v[i]!);
  }
  for (let i = start + 1; i <= end; i += 1) {
    if (v[i]! > peakV) {
      peakV = v[i]!;
      peakAtU =
        (rec.frames[i]!.tMs - rec.frames[start]!.tMs) / (tEnd - rec.frames[start]!.tMs);
    }
  }
  const tail = v.slice(Math.max(start + 1, approachEnd - 2), approachEnd + 1);
  const tailMean = tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
  return {
    worstBrakeMs,
    terminalRatio: tailMean / Math.max(1e-6, runningMax),
    lastApproachDeficitMs: runningMax - v[approachEnd]!,
    peakAtU,
  };
}

describe('gravity-shaped sit-down: the descent accelerates until the catch', () => {
  it('flagged: speed is monotone non-decreasing to the arrest window and arrives at top speed; the baseline brakes', () => {
    const flagged = shapeOf(sampleMotion(buildSitDown()));
    // Monotone non-decreasing until the final arrest window: the descent never
    // gives back speed on the way down — gravity does not brake.
    expect(flagged.worstBrakeMs, 'flagged descent never brakes before the catch').toBeLessThan(MONO_TOL_MS);
    // The approach ARRIVES at (essentially) its top speed — the floor/seat pin
    // provides the arrest, not a pre-bottom deceleration.
    expect(flagged.terminalRatio, 'flagged descent arrives at top speed').toBeGreaterThan(0.95);
    // Peak descent speed lands in the LAST third of the descent.
    expect(flagged.peakAtU, 'flagged peak speed in the last third').toBeGreaterThan(2 / 3);

    const bare = shapeOf(sampleMotion(unflag(buildSitDown())));
    // The pre-item hydraulic signature, reproduced: the symmetric ease brakes
    // measurably before the bottom (speed falls well off its running max) and
    // the approach ends noticeably slower than its peak.
    expect(bare.worstBrakeMs, 'baseline provably brakes mid-descent').toBeGreaterThan(MONO_TOL_MS);
    expect(bare.terminalRatio, 'baseline approaches the seat decelerating').toBeLessThan(0.93);
    expect(
      bare.lastApproachDeficitMs,
      'baseline gives back ≥5 cm/s of speed before the bottom',
    ).toBeGreaterThan(0.05);
    expect(
      flagged.lastApproachDeficitMs,
      'flagged approach never falls off its running max',
    ).toBeLessThan(0.01);
  });
});

// ── 2. Root-Y-only contract + 3. grounding ──────────────────────────────────

describe('root-parameter-only contract (goniometry untouched)', () => {
  it('flagged vs unflagged sit-down differ ONLY in root-Y, inside the hover/dip band', () => {
    const flagged = sampleMotion(buildSitDown());
    const bare = sampleMotion(unflag(buildSitDown()));
    expect(flagged.frames.length).toBe(bare.frames.length);
    for (let i = 0; i < flagged.frames.length; i += 1) {
      const f = flagged.frames[i]!;
      const b = bare.frames[i]!;
      // Poses byte-identical, MEASURED angles equal to far below goniometric
      // resolution (a shifted root-Y re-rounds world matrices at ~1e-12 deg —
      // float noise, not a joint change).
      expect(f.pose).toEqual(b.pose);
      for (const [joint, motions] of Object.entries(f.angles)) {
        for (const [motion, deg] of Object.entries(motions)) {
          const other = b.angles[joint]?.[motion];
          if (Number.isFinite(deg) && Number.isFinite(other)) {
            expect(Math.abs(deg - (other as number)), `frame ${i} ${joint}.${motion}`).toBeLessThan(1e-6);
          }
        }
      }
      // Root orientation and horizontal path identical; only Y may move, and
      // only within the apply-time hover/dip clamps.
      expect(f.root.orientQuat).toEqual(b.root.orientQuat);
      expect(f.root.translateM[0]).toBeCloseTo(b.root.translateM[0], 9);
      expect(f.root.translateM[2]).toBeCloseTo(b.root.translateM[2], 9);
      const dy = f.root.translateM[1] - b.root.translateM[1];
      expect(dy, `frame ${i} hover bound`).toBeLessThanOrEqual(WEIGHTED_DESCENT_MAX_HOVER_M + 1e-6);
      expect(dy, `frame ${i} dip bound`).toBeGreaterThanOrEqual(-WEIGHTED_DESCENT_MAX_DIP_M - 1e-6);
    }
  });

  it('the lie-down and quadruped get-down crouches honor the same band', () => {
    for (const build of [buildLieDown, buildGetDownToQuadruped]) {
      const flagged = sampleMotion(build());
      const bare = sampleMotion(unflag(build()));
      expect(flagged.frames.length).toBe(bare.frames.length);
      for (let i = 0; i < flagged.frames.length; i += 1) {
        const f = flagged.frames[i]!;
        const b = bare.frames[i]!;
        expect(f.pose).toEqual(b.pose);
        const dy = f.root.translateM[1] - b.root.translateM[1];
        expect(dy, `${build.name} frame ${i} hover`).toBeLessThanOrEqual(WEIGHTED_DESCENT_MAX_HOVER_M + 1e-6);
        expect(dy, `${build.name} frame ${i} dip`).toBeGreaterThanOrEqual(-WEIGHTED_DESCENT_MAX_DIP_M - 1e-6);
      }
    }
  });

  it('grounding: the sit-down feet never visibly leave or clip the floor', () => {
    const rec = sampleMotion(buildSitDown());
    const footAt = (i: number): number =>
      Math.min(
        rec.frames[i]!.worldTracks?.L_Foot?.[1] ?? Infinity,
        rec.frames[i]!.worldTracks?.R_Foot?.[1] ?? Infinity,
        rec.frames[i]!.worldTracks?.L_Toes?.[1] ?? Infinity,
        rec.frames[i]!.worldTracks?.R_Toes?.[1] ?? Infinity,
      );
    const rest0 = footAt(0);
    for (let i = 0; i < rec.frames.length; i += 1) {
      // Never hover more than the reshape's bounded band above the standing
      // contact level; never clip deeper than the seated grounding already
      // settles (the pelvis-pin's known ~2 cm co-lift tolerance).
      expect(footAt(i), `frame ${i} hover`).toBeLessThan(rest0 + WEIGHTED_DESCENT_MAX_HOVER_M + 0.01);
      expect(footAt(i), `frame ${i} clip`).toBeGreaterThan(rest0 - 0.025);
    }
  });
});

// ── 4. Byte-identity + determinism ──────────────────────────────────────────

describe('unflagged motions are byte-identical; sampling is deterministic', () => {
  it('the clinical squat stays UNFLAGGED — a controlled eccentric keeps its authored tempo', () => {
    const squat = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'squat')!);
    expect(squat.weightedDescent).toBeUndefined();
    const resolved = resolveComposedMotion(squat, variantCfg);
    expect(resolved.status).toBe('ok');
    expect(resolved.weightedDescent).toBeUndefined();
    expect(weightedDescentApplies(resolved)).toBe(false);
    // Deterministic: two samples of the unflagged squat are deep-equal.
    expect(sampleMotion(squat)).toEqual(sampleMotion(squat));
  });

  it('a flagged motion with no qualifying descent span is byte-identical to its unflagged twin', () => {
    // The plank get-down's root-Y drop is a grounding-switch STEP (feet→toes
    // pin swap), which the span detector refuses to reshape — the flag must be
    // a strict identity for it.
    const flagged = sampleMotion(buildGetDownToPlank());
    const bare = sampleMotion(unflag(buildGetDownToPlank()));
    expect(flagged.frames).toEqual(bare.frames);
  });

  it('flagged sampling is deterministic (two builds deep-equal)', () => {
    expect(sampleMotion(buildSitDown())).toEqual(sampleMotion(buildSitDown()));
  });
});

// ── 5. Exclusions ───────────────────────────────────────────────────────────

describe('exclusions: the gate refuses everything outside the grounded one-shot class', () => {
  const planted = { stance: 'planted' as const };

  it('unflagged, refused, and empty motions never apply', () => {
    expect(weightedDescentApplies({ status: 'ok', keyframes: [planted] })).toBe(false);
    expect(
      weightedDescentApplies({ status: 'refused', weightedDescent: true, keyframes: [planted] }),
    ).toBe(false);
    expect(weightedDescentApplies({ status: 'ok', weightedDescent: true, keyframes: [] })).toBe(false);
  });

  it('airborne, loops, gait/travel, calibrated verticals and IK contacts are hard-excluded', () => {
    const base = { status: 'ok', weightedDescent: true as const };
    expect(
      weightedDescentApplies({ ...base, keyframes: [planted, { stance: 'floating' }] }),
      'airborne (ballistic arcs own their vertical)',
    ).toBe(false);
    expect(weightedDescentApplies({ ...base, loop: true, keyframes: [planted] }), 'loops').toBe(false);
    expect(
      weightedDescentApplies({ ...base, footDrivenTravel: true, keyframes: [planted] }),
      'foot-driven travel gait',
    ).toBe(false);
    expect(
      weightedDescentApplies({ ...base, verticalCalibrationCm: 5, keyframes: [planted] }),
      'calibrated vertical owns root-Y',
    ).toBe(false);
    expect(
      weightedDescentApplies({ ...base, contacts: [{ foot: 'L_Foot' }], keyframes: [planted] }),
      'declared IK contacts',
    ).toBe(false);
    expect(
      weightedDescentApplies({ ...base, keyframes: [{ stance: 'floating' }] }),
      'nothing planted',
    ).toBe(false);
    expect(weightedDescentApplies({ ...base, keyframes: [planted] }), 'the admitted class').toBe(true);
  });

  it('the travel walk is excluded even if flagged (its calibrated+smoothed vertical is deliberate)', () => {
    const walk = resolveComposedMotion(buildTravelWalk(), variantCfg);
    expect(walk.status).toBe('ok');
    expect(weightedDescentApplies({ ...walk, weightedDescent: true })).toBe(false);
  });
});

// ── Derivation unit gates (synthetic arcs — no rig needed) ──────────────────

describe('deriveWeightedDescent / applyWeightedDescent primitives', () => {
  /** Symmetric smoothstep descent 0 → −0.4 m over 0..1000 ms, then a hold —
   *  the "hydraulic lower" archetype. */
  const easeArc = (tMs: number): number => {
    const u = Math.min(1, tMs / 1000);
    const s = u * u * (3 - 2 * u);
    return -0.4 * s;
  };

  it('reshapes a symmetric ease into a monotone-accelerating profile with the same endpoints', () => {
    const reshape = deriveWeightedDescent(easeArc, 1500);
    expect(reshape).not.toBeNull();
    expect(reshape!.spans.length).toBe(1);
    const span = reshape!.spans[0]!;
    // Endpoints preserved (C0 with the untouched frames around the span).
    expect(span.y[0]!).toBeCloseTo(easeArc(span.fromMs), 3);
    expect(span.y[span.y.length - 1]!).toBeCloseTo(easeArc(span.toMs), 3);
    // The table is monotone-descending with non-decreasing per-step speed
    // (concave): gravity never gives speed back.
    let prevStep = 0;
    for (let i = 1; i < span.y.length; i += 1) {
      const step = span.y[i - 1]! - span.y[i]!;
      expect(step).toBeGreaterThanOrEqual(-1e-9);
      expect(step).toBeGreaterThanOrEqual(prevStep - 1e-6);
      prevStep = step;
    }
    // And it never digs below the source arc at derive time (floored at the pin).
    const n = span.y.length - 1;
    for (let i = 0; i <= n; i += 1) {
      const t = span.fromMs + ((span.toMs - span.fromMs) * i) / n;
      expect(span.y[i]!).toBeGreaterThanOrEqual(easeArc(t) - 1e-9);
    }
  });

  it('identity outside spans, for null reshapes, and clamped inside', () => {
    const reshape = deriveWeightedDescent(easeArc, 1500);
    expect(applyWeightedDescent(0.123, null, 500)).toBe(0.123);
    expect(applyWeightedDescent(0.123, reshape, 1400)).toBe(0.123); // in the hold
    // Inside the span the result stays within the hover/dip band of the live pin.
    for (const t of [200, 400, 600, 800]) {
      const live = easeArc(t);
      const out = applyWeightedDescent(live, reshape, t);
      expect(out - live).toBeLessThanOrEqual(WEIGHTED_DESCENT_MAX_HOVER_M + 1e-9);
      expect(out - live).toBeGreaterThanOrEqual(-WEIGHTED_DESCENT_MAX_DIP_M - 1e-9);
    }
  });

  it('refuses rises, sub-threshold drops, and grounding-switch steps', () => {
    expect(deriveWeightedDescent((t) => 0.4 * (t / 1000), 1000), 'a rise').toBeNull();
    expect(deriveWeightedDescent((t) => -0.05 * (t / 1000), 1000), 'a 5 cm bob').toBeNull();
    // A pure step (instant grounding switch) has no descent to re-time.
    expect(
      deriveWeightedDescent((t) => (t < 500 ? 0 : -0.4), 1000),
      'a discontinuity',
    ).toBeNull();
  });
});
