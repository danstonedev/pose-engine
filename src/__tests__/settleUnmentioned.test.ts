/**
 * SETTLE-UNMENTIONED-DRIVERS (SEAM-6) — superseded-motion residuals. A walk
 * interrupted mid-swing leaves hip ~+25-30° / elbow ~+25° in the pose; a
 * following `startFrom:'current'` motion that only targets the trunk used to
 * inherit and HOLD those residuals frozen for its whole duration. Now the
 * un-targeted drivers ease from their live values to the motion's implicit
 * baseline over ~UNMENTIONED_SETTLE_MS — C0 at the seam (the ease starts FROM
 * the live value), so deliberate continuations (sampleMotionChain /
 * asContinuation) still measure ~0° seams, and `holdUnmentioned: true` keeps
 * the frozen carryover for callers that genuinely want it.
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
import { sampleComposedMotion, type MotionRecording, type RecordedFrame } from '../services/motionRecording';
import { sampleMotionChain } from '../services/movementChain';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let interrupt: RecordedFrame; // the walk frame at ~40% — the superseded pose

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

  // "Interrupt a walk mid-swing": sample the walk one-shot and take the frame
  // at ~40% of the pass — a mid-gait pose with hip + elbow well off baseline.
  const walk = templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!);
  const rec = sampleComposedMotion(resolveComposedMotion(walk, variantCfg), harness());
  const cut = 0.4 * rec.frames[rec.frames.length - 1]!.tMs;
  interrupt = rec.frames.reduce((best, f) =>
    Math.abs(f.tMs - cut) < Math.abs(best.tMs - cut) ? f : best,
  );
  resetToAnatomic();
});

function harness() {
  return { baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 60 };
}
function resetToAnatomic(): void {
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
}

/** The trunk-only follow-up: a 'current' motion that never targets the legs or
 *  arms — exactly the SEAM-6 scenario (residuals used to freeze through it). */
function trunkOnly(extra?: Partial<ComposedMotion>): ComposedMotion {
  return {
    name: 'trunk-lean',
    startFrom: 'current',
    stance: 'planted',
    keyframes: [
      {
        durationMs: 400,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', targetDegrees: 18 },
          { joint: 'Spine_Upper', motion: 'flexion', targetDegrees: 12 },
        ],
      },
      {
        durationMs: 400,
        holdMs: 200,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', targetDegrees: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', targetDegrees: 0 },
        ],
      },
    ],
    ...extra,
  };
}

function flatten(angles: Record<string, Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [j, set] of Object.entries(angles))
    for (const [m, v] of Object.entries(set)) if (Number.isFinite(v)) out[`${j}.${m}`] = v;
  return out;
}

/** Sample a motion CONTINUING from the interrupted-walk pose (the stage's
 *  supersession path: currentPose/currentRoot threaded, angles seeded). */
function sampleFromInterrupt(m: ComposedMotion): MotionRecording {
  resetToAnatomic();
  return sampleComposedMotion(
    resolveComposedMotion(m, variantCfg, { currentAngles: flatten(interrupt.angles) }),
    {
      ...harness(),
      currentPose: interrupt.pose,
      currentRoot: { quat: interrupt.root.orientQuat, translateM: interrupt.root.translateM },
    },
  );
}

function angleAt(rec: MotionRecording, tMs: number, joint: string, motion: string): number {
  const f = rec.frames.reduce((best, x) =>
    Math.abs(x.tMs - tMs) < Math.abs(best.tMs - tMs) ? x : best,
  );
  return f.angles[joint]?.[motion] ?? 0;
}

describe('SEAM-6 — un-targeted drivers settle instead of freezing', () => {
  it('the interrupted walk leaves real residuals (the scenario is non-vacuous)', () => {
    expect(Math.abs(interrupt.angles['L_UpLeg']?.['hipFlexion'] ?? 0)).toBeGreaterThan(10);
    expect(Math.abs(interrupt.angles['R_Forearm']?.['elbowFlexion'] ?? 0)).toBeGreaterThan(10);
  });

  it('hip + elbow residuals decay to < 3° within 700 ms of the trunk-only motion (was frozen throughout)', () => {
    const rec = sampleFromInterrupt(trunkOnly());
    // C0 at the seam: frame 0 IS the live (interrupted) pose — no snap.
    expect(
      Math.abs(angleAt(rec, 0, 'L_UpLeg', 'hipFlexion') - (interrupt.angles['L_UpLeg']?.['hipFlexion'] ?? 0)),
      'seam continuity (hip)',
    ).toBeLessThan(3);
    // The residuals wash out within 700 ms (the ~500 ms settle + trajectory ease).
    expect(Math.abs(angleAt(rec, 700, 'L_UpLeg', 'hipFlexion')), 'hip residual @700ms').toBeLessThan(3);
    expect(Math.abs(angleAt(rec, 700, 'R_UpLeg', 'hipFlexion')), 'hip residual @700ms').toBeLessThan(3);
    expect(Math.abs(angleAt(rec, 700, 'R_Forearm', 'elbowFlexion')), 'elbow residual @700ms').toBeLessThan(3);
    expect(Math.abs(angleAt(rec, 700, 'L_Forearm', 'elbowFlexion')), 'elbow residual @700ms').toBeLessThan(3);
    // And the motion itself still plays: the trunk actually leans.
    expect(angleAt(rec, 400, 'Spine_Lower', 'flexion')).toBeGreaterThan(8);
  });

  it('holdUnmentioned: true keeps the frozen carryover (the deliberate opt-out)', () => {
    const rec = sampleFromInterrupt(trunkOnly({ holdUnmentioned: true }));
    const liveHip = interrupt.angles['L_UpLeg']?.['hipFlexion'] ?? 0;
    expect(Math.abs(angleAt(rec, 700, 'L_UpLeg', 'hipFlexion') - liveHip)).toBeLessThan(5);
    expect(Math.abs(angleAt(rec, 700, 'L_UpLeg', 'hipFlexion'))).toBeGreaterThan(10);
  });

  it('an asContinuation chain seam still measures ~0° at the handoff frame', () => {
    resetToAnatomic();
    // Raise-and-hold leaves the arm at 90°; the chained trunk-only 'current'
    // segment must (a) enter seam-exact and (b) settle the arm home by its end.
    const raiseAndHold: ComposedMotion = {
      name: 'raise + hold',
      startFrom: 'neutral',
      keyframes: [
        { durationMs: 800, holdMs: 200, targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90 }] },
      ],
    };
    const segs = sampleMotionChain([raiseAndHold, trunkOnly()], harness());
    expect(segs).toHaveLength(2);
    expect(segs[1]!.status).toBe('ok');
    // The seam is C0 BY CONSTRUCTION: the settle starts FROM the live value.
    expect(segs[1]!.seamDiscontinuityDeg, 'chain seam at handoff').toBeLessThan(0.5);
    const armAtSeam = segs[1]!.recording.frames[0]!.angles['R_UpperArm']?.['shoulderFlexion'] ?? 0;
    expect(armAtSeam, 'arm still up at the handoff frame').toBeGreaterThan(80);
    // …and the un-targeted arm settles home through the segment (SEAM-6).
    const last = segs[1]!.recording.frames[segs[1]!.recording.frames.length - 1]!;
    expect(Math.abs(last.angles['R_UpperArm']?.['shoulderFlexion'] ?? 0)).toBeLessThan(3);
  });
});
