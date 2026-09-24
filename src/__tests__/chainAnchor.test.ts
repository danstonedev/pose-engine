/**
 * CHAIN ANCHOR — a chained segment plays its authored root plan from where the
 * previous segment left the body (movementChain.anchorResolvedAt).
 *
 * Authored root translates are written about the motion's own start: the walk's
 * APA shift and heading pivot, the step turn's weight shifts. Read in the rest
 * frame, a chained segment's first keyframe pulled the root back to the rest
 * origin. Measured on 2d8f5e6 (and 5c1c9ac, whose chain runner is the same):
 *   - a 90° step turn chained after the travel walk slid the whole body back to
 *     where the walk began, the pelvis 1.44 / 1.39 m (male / female), both feet
 *     with it;
 *   - the figure-eight's second half entered 1.52 m from the origin, the ride
 *     along its heading undid part of that pull and the rest dragged its planted
 *     R foot 0.64 m off its line, flung back at release: R_Leg 1144 / 1099°/s
 *     at 120 Hz (5c1c9ac 770), where the same half alone peaks at 450 / 443;
 *   - that half's gait then graded its hip 0.33 within ±1 SD (5c1c9ac 0.52).
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
import { buildFigureEightWalk, buildTravelWalk, buildTurnInPlace } from '../services/movementLocomotion';
import { anchorResolvedAt, sampleMotionChain } from '../services/movementChain';
import { runGaitBiomechChecks } from '../services/gaitBiomechCheck';
import type { GateFrame } from '../services/validityGate';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

type Variant = 'male' | 'female';
interface Rig {
  variant: Variant;
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  rest: JointAngleRestReference;
  baselinePose: CustomPose;
  pos0: THREE.Vector3;
  quat0: THREE.Quaternion;
  local0: THREE.Quaternion[];
}
const rigs = new Map<Variant, Rig>();

async function loadRig(variant: Variant): Promise<Rig> {
  const variantCfg = BODY_VARIANTS[variant];
  const buf = readFileSync(fileURLToPath(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url)));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  const root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  let skinned: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  const sk = skinned! as THREE.SkinnedMesh;
  return {
    variant,
    root,
    skinned: sk,
    rest: captureJointAngleRestReference(sk.skeleton, variantCfg),
    baselinePose: serializeCustomPose(sk.skeleton, variantCfg, variant),
    pos0: root.position.clone(),
    quat0: root.quaternion.clone(),
    local0: sk.skeleton.bones.map((b) => b.quaternion.clone()),
  };
}

function reset(r: Rig): void {
  r.skinned.skeleton.bones.forEach((b, i) => b.quaternion.copy(r.local0[i]!));
  r.root.position.copy(r.pos0);
  r.root.quaternion.copy(r.quat0);
  r.root.updateMatrixWorld(true);
}

function options(r: Rig, sampleHz: number) {
  return {
    baselinePose: r.baselinePose,
    variantCfg: BODY_VARIANTS[r.variant],
    rest: r.rest,
    skeletonHarness: { root: r.root, skinned: r.skinned },
    sampleHz,
  };
}

function chain(r: Rig, motions: ComposedMotion[], sampleHz: number) {
  reset(r);
  const segs = sampleMotionChain(motions, options(r, sampleHz));
  expect(segs.every((s) => s.status === 'ok')).toBe(true);
  return segs;
}

function alone(r: Rig, motion: ComposedMotion, sampleHz: number): MotionRecording {
  reset(r);
  return sampleComposedMotion(resolveComposedMotion(motion, BODY_VARIANTS[r.variant]), options(r, sampleHz));
}

function geoDeg(a: readonly number[], b: readonly number[]): number {
  const dot = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** Peak angular speed (°/s) of one bone across a recording. */
function peakSpeed(rec: MotionRecording, bone: string): number {
  let peak = 0;
  for (let i = 1; i < rec.frames.length; i += 1) {
    const a = rec.frames[i - 1]!;
    const b = rec.frames[i]!;
    const dt = (b.tMs - a.tMs) / 1000;
    const qa = a.pose.bones?.[bone];
    const qb = b.pose.bones?.[bone];
    if (!(dt > 0) || !qa || !qb) continue;
    peak = Math.max(peak, geoDeg(qa, qb) / dt);
  }
  return peak;
}

const horizontal = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);

beforeAll(async () => {
  for (const v of ['male', 'female'] as const) rigs.set(v, await loadRig(v));
}, 120_000);

describe('anchorResolvedAt', () => {
  it('moves only authored translates, in X and Z, and is the identity at the origin', () => {
    const resolved = resolveComposedMotion(buildTurnInPlace({ degrees: 90 }), BODY_VARIANTS.male);
    expect(anchorResolvedAt(resolved, 0, 0)).toBe(resolved);
    const moved = anchorResolvedAt(resolved, 1.5, -0.25);
    expect(moved.keyframes).toHaveLength(resolved.keyframes.length);
    resolved.keyframes.forEach((kf, i) => {
      const t = kf.root?.translateM;
      const m = moved.keyframes[i]!.root?.translateM;
      if (!t) {
        expect(m).toBeUndefined();
        return;
      }
      expect(m).toEqual([t[0] + 1.5, t[1], t[2] - 0.25]);
    });
    // The input is never mutated.
    expect(resolveComposedMotion(buildTurnInPlace({ degrees: 90 }), BODY_VARIANTS.male).keyframes).toEqual(resolved.keyframes);
  });
});

describe.each(['male', 'female'] as const)('a chained segment plays from where the body was left (%s)', (variant) => {
  it('a step turn chained after the walk pivots where the walk ended (2d8f5e6: slid 1.44 / 1.39 m back)', () => {
    const r = rigs.get(variant)!;
    const [walk, turn] = chain(r, [buildTravelWalk(), buildTurnInPlace({ degrees: 90 })], 30);
    const walkEnd = walk!.recording.frames[walk!.recording.frames.length - 1]!.worldTracks!.Hips!;
    let farthest = 0;
    for (const f of turn!.recording.frames) farthest = Math.max(farthest, horizontal(f.worldTracks!.Hips!, walkEnd));
    // A step turn shifts its weight over each stance foot by 3 cm and pivots on
    // it; nothing in it travels. Measured 0.029 m on both rigs.
    expect(farthest, 'the pelvis stays over the spot the walk left it on').toBeLessThan(0.15);
  });

  it("the figure-eight's second half moves its legs as it does alone (2d8f5e6: R_Leg 1144 / 1099°/s)", () => {
    const r = rigs.get(variant)!;
    const [, second] = chain(r, [...buildFigureEightWalk()], 120);
    const chained = peakSpeed(second!.recording, 'R_Leg');
    const single = peakSpeed(alone(r, buildFigureEightWalk()[1]!, 120), 'R_Leg');
    // No worse than 5c1c9ac, which also whipped it (769.9°/s on both rigs), and
    // within a tenth of the same half alone (chained 479 / 478 against 450 / 443).
    expect(chained).toBeLessThanOrEqual(769.9);
    expect(chained / single).toBeLessThan(1.1);
    // Its planted R foot holds its ground through the stance the half opens on
    // (2d8f5e6 dragged it 0.64 m; measured 3.4 / 3.1 cm — the heading pivot's
    // offset, authored for a half that pivots from rest, which a chained half
    // entering at its heading does not).
    const stanceEndMs = 1157;
    const frames = second!.recording.frames.filter((f) => f.tMs <= stanceEndMs);
    let slide = 0;
    for (const f of frames) slide = Math.max(slide, horizontal(f.worldTracks!.R_Foot!, frames[0]!.worldTracks!.R_Foot!));
    expect(slide, 'the R foot stays planted until it lifts').toBeLessThan(0.05);
  });

  it("grades the chained half's hip against its own gait (2d8f5e6: 0.33; 5c1c9ac 0.52)", () => {
    const r = rigs.get(variant)!;
    for (const hz of [30, 120]) {
      const [, second] = chain(r, [...buildFigureEightWalk()], hz);
      const resolved = resolveComposedMotion(second!.motion, BODY_VARIANTS[variant]);
      const { checks } = runGaitBiomechChecks(resolved, second!.recording.frames as unknown as GateFrame[]);
      const hip = checks.find((c) => c.id === 'normative-hipFlexion')!;
      expect(hip.measured as number, `${hz} Hz`).toBeGreaterThanOrEqual(0.52);
      expect(hip.pass, `${hz} Hz`).toBe(true);
    }
  });
});
