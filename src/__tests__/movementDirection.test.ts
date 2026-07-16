/**
 * DIRECTION GATE (simMOVE Phase 0) — the permanent regression that pins the
 * semantic direction vocabulary and the reversal validator to what the REAL
 * male rig actually does. Same headless harness as fullBodyMotion.test.ts
 * (GLB parse → applyAnatomicPose → captureJointAngleRestReference → build →
 * apply pose + root transform → measure), asserting MEASURED WORLD POSITIONS —
 * never the plan's own translate field — so a flipped sign fails here.
 *
 * TRAVEL uses the mesh's PHYSICAL WORLD FACING, measured directly on the male
 * rig (toes point +Z; a forward arm-raise / hip flexion / trunk flexion all
 * carry the limb toward +Z): the mannequin FACES +Z, so "walk forward" moves
 * the root toward +Z. (jointAngles.ts's clinical readout labels anterior as −Z;
 * that is a separate MEASUREMENT-frame convention, NOT the physical facing, and
 * is deliberately not used for travel — conflating the two was the reversal bug.)
 *   forward / faces = +Z, backward = −Z
 *   superior / up   = +Y, inferior / down = −Y
 *   subject's LEFT  = +X, subject's RIGHT = −X
 * The side-lying roll sign is pinned EMPIRICALLY below, not assumed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import {
  buildSequencePoses,
  resolveComposedMotion,
  describeSemanticMotionVocabulary,
  TRAVEL_DIRECTIONS,
  SEMANTIC_POSTURES,
  postureRootOrient,
  SIDELYING_LEFT_ROLL_DEG,
  type ComposedMotion,
  type SequenceKeyframe,
} from '../services/motionSequence';
import {
  sampleComposedMotion,
  exportKinematics,
  type MotionRecording,
} from '../services/motionRecording';
import {
  validateMovementDirection,
  measureNetRootTravel,
} from '../services/movementDirection';
import {
  captureFloorReference,
  pinRootToFloor,
  rotateRestReferenceByRoot,
  type FloorReference,
} from '../services/rootMotion';
import { BODY_VARIANTS, normalizeBoneNameForVariant } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let floor: FloorReference;
const anatomicLocals = new Map<THREE.Bone, THREE.Quaternion>();
const lookup = new Map<string, THREE.Bone>();

function resetToAnatomic(): void {
  for (const [bone, q] of anatomicLocals) bone.quaternion.copy(q);
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.updateMatrixWorld(true);
}

function worldPos(key: string): THREE.Vector3 {
  return lookup.get(key)!.getWorldPosition(new THREE.Vector3());
}

/** Play a resolved+built motion the stage way and leave the rig at the last
 *  keyframe. Returns the built plan's final root quaternion for orient checks. */
function playToLast(m: ComposedMotion): { finalRootQuat: THREE.Quaternion } {
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, `resolve ${m.name}: ${resolved.reason ?? ''}`).toBe('ok');
  const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest, { currentPose: null });
  let finalRootQuat = new THREE.Quaternion();
  for (let i = 0; i < built.poses.length; i += 1) {
    applyCustomPose(skinned.skeleton, variantCfg, built.poses[i]!);
    const rs = built.roots[i]!;
    root.quaternion.set(rs.quat[0], rs.quat[1], rs.quat[2], rs.quat[3]);
    root.position.set(rs.translateM[0], rs.translateM[1], rs.translateM[2]);
    root.updateMatrixWorld(true);
    if (rs.stance === 'planted') pinRootToFloor(root, skinned.skeleton, variantCfg, floor);
    root.updateMatrixWorld(true);
    finalRootQuat = new THREE.Quaternion(rs.quat[0], rs.quat[1], rs.quat[2], rs.quat[3]);
  }
  return { finalRootQuat };
}

/** Sample a motion offline on the real rig into a recording (the honest
 *  frame-by-frame world track the validator consumes). */
function sample(m: ComposedMotion): MotionRecording {
  resetToAnatomic();
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, `resolve ${m.name}`).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 30,
  });
}

/** One-keyframe motion carrying just a root/semantic directive (plus a no-op
 *  neck target so an all-zero keyframe is never empty). */
function directiveMotion(name: string, kf: Partial<SequenceKeyframe>): ComposedMotion {
  return {
    name,
    keyframes: [
      {
        durationMs: 600,
        targets: [{ joint: 'Neck', motion: 'flexion', targetDegrees: 0 }],
        ...kf,
      } as SequenceKeyframe,
    ],
  };
}

/** Pitch/roll (deg) of a root orientation quaternion, YXZ order (the inverse of
 *  rootOrientQuat's composition). */
function pitchRollDeg(q: THREE.Quaternion): { pitch: number; roll: number } {
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  return { pitch: (e.x * 180) / Math.PI, roll: (e.z * 180) / Math.PI };
}

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.parse(arrayBuffer, '', resolve as never, reject);
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
  for (const bone of skinned.skeleton.bones) anatomicLocals.set(bone, bone.quaternion.clone());
  for (const bone of skinned.skeleton.bones) {
    const n = normalizeBoneNameForVariant(bone.name, variantCfg.boneNameMap);
    if (!n.canonical) continue;
    const p = n.side === 'Left' ? 'L_' : n.side === 'Right' ? 'R_' : '';
    lookup.set(`${p}${n.canonical}`, bone);
  }
  floor = captureFloorReference(skinned.skeleton, variantCfg);
});

describe('semantic travel → correct signed world motion (measured on the rig)', () => {
  const TRAVEL_M = 0.4;

  it("'forward' moves the body the way it FACES (+Z) — INCREASES Hips world-Z", () => {
    resetToAnatomic();
    // Rig-anchored facing: the toes point the way the body faces. Assert forward
    // travel moves the root the SAME Z way the toes point (not a hardcoded sign),
    // so this fails if the mapping is flipped OR the mesh facing were different.
    const toes = worldPos('L_Toes').z;
    const ankle = worldPos('L_Foot').z;
    const facingSignZ = Math.sign(toes - ankle); // +1 on this rig (faces +Z)
    const z0 = worldPos('Hips').z;
    playToLast(directiveMotion('forward', { travel: { direction: 'forward', meters: TRAVEL_M } }));
    const dz = worldPos('Hips').z - z0;
    expect(Math.abs(dz)).toBeGreaterThan(0.3);
    expect(Math.sign(dz)).toBe(facingSignZ);
  });

  it("'backward' moves AWAY from facing (−Z) — DECREASES Hips world-Z", () => {
    resetToAnatomic();
    const facingSignZ = Math.sign(worldPos('L_Toes').z - worldPos('L_Foot').z);
    const z0 = worldPos('Hips').z;
    playToLast(directiveMotion('backward', { travel: { direction: 'backward', meters: TRAVEL_M } }));
    const dz = worldPos('Hips').z - z0;
    expect(Math.abs(dz)).toBeGreaterThan(0.3);
    expect(Math.sign(dz)).toBe(-facingSignZ);
  });

  it("'left' INCREASES Hips world-X (subject-left = +X)", () => {
    resetToAnatomic();
    const x0 = worldPos('Hips').x;
    playToLast(directiveMotion('left', { travel: { direction: 'left', meters: TRAVEL_M } }));
    expect(worldPos('Hips').x).toBeGreaterThan(x0 + 0.3);
  });

  it("'right' DECREASES Hips world-X (subject-right = −X)", () => {
    resetToAnatomic();
    const x0 = worldPos('Hips').x;
    playToLast(directiveMotion('right', { travel: { direction: 'right', meters: TRAVEL_M } }));
    expect(worldPos('Hips').x).toBeLessThan(x0 - 0.3);
  });

  it("'up' INCREASES Hips world-Y (superior = +Y)", () => {
    resetToAnatomic();
    const y0 = worldPos('Hips').y;
    playToLast(directiveMotion('up', { travel: { direction: 'up', meters: TRAVEL_M } }));
    expect(worldPos('Hips').y).toBeGreaterThan(y0 + 0.3);
  });

  it("'down' DECREASES Hips world-Y (inferior = −Y)", () => {
    resetToAnatomic();
    const y0 = worldPos('Hips').y;
    playToLast(directiveMotion('down', { travel: { direction: 'down', meters: TRAVEL_M } }));
    expect(worldPos('Hips').y).toBeLessThan(y0 - 0.3);
  });

  it('opposite directions move the body to opposite sides of rest', () => {
    resetToAnatomic();
    const z0 = worldPos('Hips').z;
    playToLast(directiveMotion('fwd', { travel: { direction: 'forward', meters: TRAVEL_M } }));
    const fwdZ = worldPos('Hips').z;
    resetToAnatomic();
    playToLast(directiveMotion('bwd', { travel: { direction: 'backward', meters: TRAVEL_M } }));
    const bwdZ = worldPos('Hips').z;
    expect(fwdZ).toBeGreaterThan(z0); // forward = +Z (physical facing)
    expect(bwdZ).toBeLessThan(z0); // backward = −Z
    expect(Math.sign(fwdZ - z0)).not.toBe(Math.sign(bwdZ - z0));
  });
});

describe('semantic posture → correct signed reorientation (pinned to the rig)', () => {
  it('supine vs prone produce OPPOSITE pitch (and opposite head Z on the rig)', () => {
    resetToAnatomic();
    const supine = playToLast(directiveMotion('supine', { posture: 'supine' }));
    const supineHeadZ = worldPos('Head').z;
    const supinePitch = pitchRollDeg(supine.finalRootQuat).pitch;

    resetToAnatomic();
    const prone = playToLast(directiveMotion('prone', { posture: 'prone' }));
    const proneHeadZ = worldPos('Head').z;
    const pronePitch = pitchRollDeg(prone.finalRootQuat).pitch;

    // Mapping: supine → pitch −90, prone → +90 (the authoritative posture map).
    expect(supinePitch).toBeCloseTo(-90, 1);
    expect(pronePitch).toBeCloseTo(90, 1);
    // …and the RIG bears it out: the head lands on opposite sides along the
    // body's long axis. (Fails if the pitch signs were swapped.)
    expect(Math.sign(supineHeadZ)).not.toBe(Math.sign(proneHeadZ));
    // Body is horizontal in both (head near floor level, well below standing).
    expect(worldPos('Head').y).toBeLessThan(0.35);
  });

  it('sidelying-left vs sidelying-right produce OPPOSITE roll — left side vs right side DOWN', () => {
    // PINNED EMPIRICALLY: sidelying-left lays the subject's LEFT side toward the
    // floor, so the LEFT arm ends BELOW the right; sidelying-right mirrors it.
    resetToAnatomic();
    const sll = playToLast(directiveMotion('sll', { posture: 'sidelying-left' }));
    const sllRoll = pitchRollDeg(sll.finalRootQuat).roll;
    const sllLeftY = worldPos('L_UpperArm').y;
    const sllRightY = worldPos('R_UpperArm').y;

    resetToAnatomic();
    const slr = playToLast(directiveMotion('slr', { posture: 'sidelying-right' }));
    const slrRoll = pitchRollDeg(slr.finalRootQuat).roll;
    const slrLeftY = worldPos('L_UpperArm').y;
    const slrRightY = worldPos('R_UpperArm').y;

    // sidelying-left: LEFT shoulder below RIGHT.
    expect(sllLeftY).toBeLessThan(sllRightY - 0.1);
    // sidelying-right: RIGHT shoulder below LEFT (the mirror).
    expect(slrRightY).toBeLessThan(slrLeftY - 0.1);
    // Literal roll signs, grounded in the world-Y guards above (left shoulder
    // physically below right IS sidelying-left) — not the mapping constant. This
    // pins the sign non-self-referentially so a flipped SIDELYING_LEFT_ROLL_DEG
    // can't slip through by also flipping the assertion it's compared against.
    expect(sllRoll).toBeLessThan(0); // sidelying-left rolls negative on the rig
    expect(slrRoll).toBeGreaterThan(0); // sidelying-right rolls positive (mirror)
    // Opposite roll signs, magnitude the pinned ±90.
    expect(Math.sign(sllRoll)).not.toBe(Math.sign(slrRoll));
    expect(Math.abs(sllRoll)).toBeCloseTo(90, 1);
    expect(sllRoll).toBeCloseTo(SIDELYING_LEFT_ROLL_DEG, 1);
    // The mapping constant matches the pinned rig behavior.
    expect(postureRootOrient('sidelying-left').rollDeg).toBe(SIDELYING_LEFT_ROLL_DEG);
    expect(postureRootOrient('sidelying-right').rollDeg).toBe(-SIDELYING_LEFT_ROLL_DEG);
  });
});

describe('precedence — explicit raw root overrides the semantic sugar', () => {
  it('a raw root.translateM WINS over travel sugar on the same keyframe', () => {
    // Semantic says forward (+Z 0.4); the raw translate says backward (−Z 0.5).
    // Raw wins, so the body moves −Z despite the 'forward' sugar.
    resetToAnatomic();
    const z0 = worldPos('Hips').z;
    playToLast(
      directiveMotion('raw-wins', {
        travel: { direction: 'forward', meters: 0.4 },
        root: { translateM: [0, 0, -0.5] },
      }),
    );
    expect(worldPos('Hips').z).toBeLessThan(z0 - 0.4); // −Z (raw), not +Z (sugar)
  });

  it('a raw root.orient WINS over posture sugar; travel sugar still fills translate', () => {
    // posture 'supine' would pitch −90; the raw orient pins upright (pitch 0).
    // The travel sugar has no raw counterpart, so it still applies.
    resetToAnatomic();
    const y0 = worldPos('Head').y;
    const z0 = worldPos('Hips').z;
    const { finalRootQuat } = playToLast(
      directiveMotion('mixed', {
        posture: 'supine',
        travel: { direction: 'forward', meters: 0.4 },
        root: { orient: { pitchDeg: 0 } },
      }),
    );
    // Orient stayed upright (raw won) — head near standing height, pitch ~0.
    expect(pitchRollDeg(finalRootQuat).pitch).toBeCloseTo(0, 1);
    expect(worldPos('Head').y).toBeGreaterThan(y0 - 0.2);
    // Travel sugar (no raw translate) still moved the body forward (+Z).
    expect(worldPos('Hips').z).toBeGreaterThan(z0 + 0.3);
  });
});

describe('deterministic direction validator', () => {
  it('CLEARS a correct forward motion (sampled recording + kinematic export)', () => {
    const rec = sample(directiveMotion('go forward', { travel: { direction: 'forward', meters: 0.4 } }));
    // Net root travel is forward = +Z (physical facing).
    const net = measureNetRootTravel(rec)!;
    expect(net[2]).toBeGreaterThan(0.3);

    const recResult = validateMovementDirection(rec, { travel: 'forward' });
    expect(recResult.ok).toBe(true);
    expect(recResult.reversed).toBe(false);
    expect(recResult.suggestedTranslateM).toBeUndefined();

    const ex = exportKinematics(rec);
    const exResult = validateMovementDirection(ex, { travel: 'forward' });
    expect(exResult.ok).toBe(true);
    expect(exResult.reversed).toBe(false);
  });

  it('FLAGS a deliberately reversed raw root (intent forward, but translateM −Z) and suggests the flip', () => {
    // The reversal bug incarnate: the plan MEANT forward (the body faces +Z) but
    // authored −Z (which sends the avatar backward). Sample it, validate vs intent.
    const reversedTranslate: [number, number, number] = [0, 0, -0.4];
    const rec = sample(
      directiveMotion('reversed forward', { root: { translateM: reversedTranslate } }),
    );
    // The body really went −Z (backward) — the wrong way for 'forward'.
    expect(measureNetRootTravel(rec)![2]).toBeLessThan(-0.3);

    const result = validateMovementDirection(
      rec,
      { travel: 'forward', authoredTranslateM: reversedTranslate },
    );
    expect(result.ok).toBe(false);
    expect(result.reversed).toBe(true);
    expect(result.travel[0]!.status).toBe('reversed');
    // The auto-flip: the corrected translate has its Z sign flipped to +Z (forward).
    expect(result.suggestedTranslateM).toBeDefined();
    expect(result.suggestedTranslateM![2]).toBeCloseTo(0.4, 6);
    // Applying the suggestion would clear the check (net travel would be +Z).
    const corrected = validateMovementDirection(
      { netRootTranslateM: [0, 0, 0.4] },
      { travel: 'forward' },
    );
    expect(corrected.ok).toBe(true);
  });

  it("flags 'left' intent that actually travelled right, and clears a true left", () => {
    const wentRight = sample(directiveMotion('mislabeled', { travel: { direction: 'right', meters: 0.4 } }));
    const bad = validateMovementDirection(wentRight, { travel: 'left' });
    expect(bad.ok).toBe(false);
    expect(bad.reversed).toBe(true);
    expect(bad.travel[0]!.axis).toBe('x');

    const wentLeft = sample(directiveMotion('true-left', { travel: { direction: 'left', meters: 0.4 } }));
    expect(validateMovementDirection(wentLeft, { travel: 'left' }).ok).toBe(true);
  });

  it('validates ending posture orientation against intent (supine clears, prone flags)', () => {
    const rec = sample(directiveMotion('lie supine', { posture: 'supine' }));
    const ok = validateMovementDirection(rec, { posture: 'supine' });
    expect(ok.posture?.status).toBe('ok');
    expect(ok.ok).toBe(true);

    const wrong = validateMovementDirection(rec, { posture: 'prone' });
    expect(wrong.posture?.status).toBe('wrong');
    expect(wrong.ok).toBe(false);
  });

  it('reports insufficient (not reversed) travel when the body barely moved', () => {
    const rec = sample(directiveMotion('tiny', { travel: { direction: 'forward', meters: 0.005 } }));
    const res = validateMovementDirection(rec, { travel: 'forward' }, { minMeters: 0.05 });
    expect(res.travel[0]!.status).toBe('insufficient');
    expect(res.reversed).toBe(false);
    expect(res.ok).toBe(false);
  });

  it('empty evidence and no-intent are handled without throwing', () => {
    expect(validateMovementDirection({ frames: [] }, { travel: 'forward' }).ok).toBe(false);
    const noIntent = validateMovementDirection({ netRootTranslateM: [0, 0, -0.4] }, {});
    expect(noIntent.ok).toBe(true);
    expect(noIntent.travel).toHaveLength(0);
  });
});

describe('host-facing semantic vocabulary helper', () => {
  it('describes the enums + prompt text without ever exposing an axis sign', () => {
    const vocab = describeSemanticMotionVocabulary();
    expect(vocab.travelDirections).toEqual(TRAVEL_DIRECTIONS);
    expect(vocab.postures).toEqual(SEMANTIC_POSTURES);
    expect(vocab.travelDirections).toContain('forward');
    expect(vocab.postures).toContain('sidelying-left');
    // The whole point: the model is handed NAMES, never a signed axis to get
    // backwards — the prose must not hand the LLM a signed coordinate.
    expect(vocab.promptText).toMatch(/forward/);
    expect(vocab.promptText).not.toMatch(/[+-][XYZ]\b/);
    expect(vocab.promptText).not.toMatch(/\b[XYZ]-?axis\b/);
  });
});
