/**
 * BALANCE MEASUREMENT — the effect of gravity on movement, made measurable.
 *
 * The pose/measure system knew every joint angle but nothing about whether a
 * movement keeps the body's mass over its feet. This proves the foundation the
 * balance controller builds on:
 *
 *  1. Pure geometry — base of support from footprints, signed margin of stability
 *     (COM projection inside/outside the support polygon).
 *  2. On the rig — a quiet upright stance is balanced (COM over the base, positive
 *     margin near the base centre).
 *  3. THE PHYSICS THAT MOTIVATES A CONTROLLER — a forward hip-hinge drives the COM
 *     forward toward/over the toe edge (margin collapses): un-corrected, the body
 *     is toppling. A real body shifts the hips back to hold the COM in; that is
 *     the adjustment the controller will make.
 *  4. Single-leg stance shrinks the base to one foot — a smaller margin, the
 *     balance challenge the movement is named for.
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
  computeBodyCoM,
  computeBalanceState,
  computeBalanceTimeline,
  baseOfSupport,
  marginOfStability,
  type FootContactXZ,
} from '../services/centerOfMass';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
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

function sample(templateId: string, control?: number): MotionRecording {
  const m: ComposedMotion = templateToComposedMotion(
    MOVEMENT_TEMPLATES.find((t) => t.id === templateId)!,
  );
  if (control != null) m.modifiers = { ...(m.modifiers ?? {}), balanceControl: control };
  return sampleMotion(m);
}

// ── 1. Pure geometry ─────────────────────────────────────────────────────────

describe('base of support + margin of stability (geometry)', () => {
  // Two feet ~20 cm apart, toes forward (+z), both flat on the floor (y = 0).
  const twoFeet: FootContactXZ[] = [
    { key: 'L_Foot', ankle: [0.1, 0], toe: [0.1, 0.12], ankleY: 0, contact: true },
    { key: 'R_Foot', ankle: [-0.1, 0], toe: [-0.1, 0.12], ankleY: 0, contact: true },
  ];

  it('a COM over the base centre is stable; far outside is not', () => {
    const base = baseOfSupport(twoFeet, 0);
    expect(base.airborne).toBe(false);
    expect(base.contacts).toHaveLength(2);
    // Polygon has real area (a stance is not a line).
    expect(base.polygon.length).toBeGreaterThanOrEqual(4);

    const center = base.center;
    const inside = marginOfStability([center[0], center[1]], base)!;
    expect(inside).toBeGreaterThan(0); // over the base → stable
    // A COM half a metre to the side is well outside the footprint → negative.
    const outside = marginOfStability([center[0] + 0.5, center[1]], base)!;
    expect(outside).toBeLessThan(0);
    // Margin is a signed distance: the far point's magnitude ≈ how far out it is.
    expect(outside).toBeLessThan(-0.3);
  });

  it('lifting one foot shrinks the base and the margin', () => {
    const twoBase = baseOfSupport(twoFeet, 0);
    const oneBase = baseOfSupport(
      twoFeet.map((f) => (f.key === 'R_Foot' ? { ...f, contact: false } : f)),
      0,
    );
    expect(oneBase.contacts).toEqual(['L_Foot']);
    // Same COM (over the two-foot centre) is much closer to the edge of a
    // single-foot base — the single-leg balance challenge.
    const com: [number, number] = [twoBase.center[0], twoBase.center[1]];
    expect(marginOfStability(com, oneBase)!).toBeLessThan(marginOfStability(com, twoBase)!);
  });

  it('reports airborne when no foot bears weight', () => {
    const base = baseOfSupport(
      twoFeet.map((f) => ({ ...f, contact: false })),
      0,
    );
    expect(base.airborne).toBe(true);
    expect(marginOfStability([0, 0], base)).toBeNull();
  });
});

// ── 2. Quiet stance on the rig ───────────────────────────────────────────────

describe('balance on the rig', () => {
  it('a quiet upright stance keeps the COM over the base (positive margin)', () => {
    resetHarness();
    const state = computeBalanceState(skinned.skeleton, variantCfg);
    expect(state.base.airborne).toBe(false);
    expect(state.base.contacts.length).toBeGreaterThanOrEqual(1);
    // Standing: COM projects inside the footprint with real clearance.
    expect(state.balanced).toBe(true);
    expect(state.marginM!).toBeGreaterThan(0.02);
    // COM is roughly over the base centre (within a few cm), not off to a side.
    const dx = state.comGround[0] - state.base.center[0];
    const dz = state.comGround[1] - state.base.center[1];
    expect(Math.hypot(dx, dz)).toBeLessThan(0.06);
    // Sanity: COM height is a believable fraction of standing height.
    const com = computeBodyCoM(skinned.skeleton, variantCfg);
    expect(com.massCovered).toBeCloseTo(1, 2);
  });
});

// ── 3. Foot-rooted planting keeps a folding body balanced (the fix, end to end) ─

describe('a forward hip-hinge stays balanced over planted feet', () => {
  it('folds the COM to the toe edge (a real balance demand) but keeps it ON the base', () => {
    resetHarness();
    const neutral = computeBalanceState(skinned.skeleton, variantCfg);

    const rec = sample('forward-hip-hinge');
    const timeline = computeBalanceTimeline(rec);

    // Grounded throughout — never airborne.
    expect(timeline.airborneFraction).toBe(0);

    // The COM really travels forward (+z) as the trunk folds over the feet — a
    // genuine deep hinge, not a stiff bow.
    const comZ = timeline.frames.map((f) => f.comGround[1]);
    const maxComZ = Math.max(...comZ);
    expect(maxComZ).toBeGreaterThan(neutral.comGround[1] + 0.05);

    // The deep fold brings the COM to the toe edge (the real balance demand of a
    // toe-touch), but closed-chain foot-rooting places the pelvis over PLANTED
    // feet, so the COM stays ON the base — near the edge, not toppling. Contrast
    // the pelvis-rooted FK, whose feet swing forward and whose COM sails ~57 cm
    // off the base (before/after proven in plantStanceFoot.test.ts).
    expect(timeline.minMarginM!).toBeLessThan(neutral.marginM!); // challenged (near the edge)…
    expect(timeline.minMarginM!).toBeGreaterThan(-0.05); // …but not toppling off the base

    // eslint-disable-next-line no-console
    console.log(
      `hinge: neutral margin ${(neutral.marginM! * 100).toFixed(1)}cm → min margin ${(
        timeline.minMarginM! * 100
      ).toFixed(1)}cm; COM forward Δ ${((maxComZ - neutral.comGround[1]) * 100).toFixed(1)}cm`,
    );
  });
});

// ── 4. Single-leg stance narrows the base ────────────────────────────────────

describe('single-leg stance narrows the base of support', () => {
  it('reaches a one-foot base during the hold', () => {
    resetHarness();
    const neutral = computeBalanceState(skinned.skeleton, variantCfg);

    const rec = sample('single-leg-stance');
    const timeline = computeBalanceTimeline(rec);

    // At least one frame stands on a single foot (the lifted-leg hold).
    const oneFoot = timeline.frames.filter((f) => f.contacts.length === 1);
    expect(oneFoot.length).toBeGreaterThan(0);

    // The single-foot base is a tighter balance than quiet two-foot stance.
    const minOneFoot = Math.min(...oneFoot.map((f) => f.marginM ?? Infinity));
    expect(minOneFoot).toBeLessThan(neutral.marginM!);

    // eslint-disable-next-line no-console
    console.log(
      `single-leg: two-foot margin ${(neutral.marginM! * 100).toFixed(1)}cm → one-foot min ${(
        minOneFoot * 100
      ).toFixed(1)}cm (${oneFoot.length}/${timeline.frames.length} frames on one foot)`,
    );
  });
});

// ── 5. Foot-rooting OWNS balance; the old balanceControl lever is parked ──────

describe('foot-rooted planting owns balance (the balanceControl modifier is parked)', () => {
  it('a sampled squat stays grounded with its COM near the base (planted, not toppling)', () => {
    const tl = computeBalanceTimeline(sample('squat'));
    expect(tl.airborneFraction).toBe(0);
    // The pelvis drops over PLANTED feet, so the COM stays near the base through
    // the descent. (A pelvis-rooted squat swings the feet out — no stable base at
    // all; the deepest frame is a genuinely near-edge COM, hence the tolerance.)
    expect(tl.minMarginM!).toBeGreaterThan(-0.12);
  });

  it('is deterministic and unaffected by the parked balanceControl modifier', () => {
    // Balance now emerges from CORRECT closed-chain kinematics (foot-rooting), not
    // a pelvis-shifting IK controller — so the old balanceControl lever is parked:
    // two samples are byte-identical, and setting the modifier changes nothing.
    const a = sample('squat');
    const b = sample('squat');
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames)); // deterministic
    const asked = sample('squat', 1);
    expect(JSON.stringify(asked.frames)).toBe(JSON.stringify(a.frames)); // modifier inert
  });

  it('single-leg stance stays a genuine one-foot balance challenge (not auto-corrected)', () => {
    // Single-leg leaves the bearing leg untouched, so its stance foot never drifts
    // — foot-rooting is a no-op and the narrow one-foot base is preserved. The COM
    // sits off the stance foot: the balance demand the movement is named for, left
    // honest (a future balance-strategy lever owns it, not a silent correction).
    const tl = computeBalanceTimeline(sample('single-leg-stance'));
    const oneFoot = tl.frames.filter((f) => f.contacts.length === 1);
    expect(oneFoot.length).toBeGreaterThan(0);
    expect(Math.min(...oneFoot.map((f) => f.marginM ?? Infinity))).toBeLessThan(0);
  });
});

// ── 6. Cyclic motions are never re-rooted or balance-adjusted ────────────────

describe('cyclic (looping) motions are never re-rooted or balance-adjusted', () => {
  it('the in-place walk (planted + looping) is byte-identical with balanceControl set', () => {
    // The in-place walk is planted and non-travelling, so without the loop gate
    // foot-rooted planting would engage and re-root it onto a single stance foot —
    // freezing the gait. It LOOPS (cyclic, not quasi-static), so useFootRoot skips
    // it; and the parked balanceControl modifier is inert. Either way, setting
    // balanceControl leaves the recording untouched.
    const walk = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);
    expect(walk.loop).toBe(true);
    const plain = sampleMotion(walk);
    const controlled = sampleMotion({ ...walk, modifiers: { ...walk.modifiers, balanceControl: 1 } });
    expect(JSON.stringify(controlled.frames)).toBe(JSON.stringify(plain.frames));
  });
});
