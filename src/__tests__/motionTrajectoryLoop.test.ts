/**
 * LOOP-SEAM GATE — proves the seamless periodic loop trajectory fixes the
 * measured per-cycle "hitch" and locks it against regression.
 *
 * The bug: looping playback reused the OPEN trajectory (start pose as knot 0,
 * both ends STOPS) and wrapped `rawMs % total`, so every cycle snapped the body
 * back through the start/standing pose (~30° jump for gait) and stalled to zero
 * velocity at the seam. {@link buildLoopTrajectory} instead builds a periodic
 * ring over the keyframe poses only, with a velocity-continuous wrap.
 *
 * Both are measured here on the real male rig: the OLD open+wrap is shown to
 * have a large discontinuous seam; the NEW loop is shown to be continuous in
 * BOTH pose and velocity, and to never pass back through the standing pose.
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
import { resolveComposedMotion, buildSequencePoses } from '../services/motionSequence';
import { buildComposedTrajectory, buildLoopTrajectory } from '../services/motionTrajectory';
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

/** Max single-joint rotation angle (deg) between two poses. */
function poseDelta(a: CustomPose, b: CustomPose): number {
  let max = 0;
  const keys = new Set([...Object.keys(a.bones ?? {}), ...Object.keys(b.bones ?? {})]);
  for (const k of keys) {
    const qa = a.bones?.[k] ?? [0, 0, 0, 1];
    const qb = b.bones?.[k] ?? [0, 0, 0, 1];
    const _a = new THREE.Quaternion(qa[0], qa[1], qa[2], qa[3]);
    const _b = new THREE.Quaternion(qb[0], qb[1], qb[2], qb[3]);
    max = Math.max(max, (2 * Math.acos(Math.min(1, Math.abs(_a.dot(_b))))) * (180 / Math.PI));
  }
  return max;
}

function walkBuilt() {
  const t = MOVEMENT_TEMPLATES.find((x) => x.id === 'walk')!;
  const resolved = resolveComposedMotion(templateToComposedMotion(t), variantCfg);
  expect(resolved.status).toBe('ok');
  return buildSequencePoses(baselinePose, resolved, variantCfg, rest, {
    currentPose: null,
    currentRoot: null,
  });
}

describe('loop-seam fix — the walk cycle loops seamlessly', () => {
  it('OLD open+wrap playback has a large discontinuous seam (documents the bug)', () => {
    const built = walkBuilt();
    const { trajectory } = buildComposedTrajectory(built, {
      startPose: baselinePose,
      startQuat: [0, 0, 0, 1],
      startTranslate: [0, 0, 0],
      timeScale: 1,
    });
    const total = trajectory.totalMs;
    // rawMs % total wraps pose(total⁻) → pose(0). pose(0) is the STANDING start
    // knot; the last stride pose is ~30° away → a visible snap every cycle.
    const seam = poseDelta(trajectory.sampleAt(total - 1).pose, trajectory.sampleAt(0).pose);
    expect(seam).toBeGreaterThan(20);
    // …and the start knot really is (near) the standing baseline.
    expect(poseDelta(trajectory.sampleAt(0).pose, baselinePose)).toBeLessThan(2);
  });

  it('NEW loop trajectory is C0- and C1-continuous across the wrap (no snap, no stall)', () => {
    const built = walkBuilt();
    const { trajectory: loop } = buildLoopTrajectory(built, { timeScale: 1 });
    const period = loop.totalMs;
    expect(period).toBeCloseTo(1600, 0);

    // Sample densely across TWO periods; the frame-to-frame pose delta at the
    // wrap must be no worse than the interior motion (continuity in pose AND
    // velocity — a stall would read as a near-zero delta dip, a snap as a spike).
    const dt = 1000 / 120; // 120 Hz
    const deltas: { t: number; d: number }[] = [];
    for (let t = 0; t < 2 * period; t += dt) {
      deltas.push({ t, d: poseDelta(loop.sampleAt(t).pose, loop.sampleAt(t + dt).pose) });
    }
    const interior = deltas.map((x) => x.d).sort((a, b) => a - b);
    const median = interior[Math.floor(interior.length / 2)]!;

    // The wrap crossings sit at t ≈ period and 2·period. Their deltas must be
    // within a small band of the median step — neither a spike (snap) nor a dip
    // to ~0 (stall).
    for (const wrapT of [period, 2 * period]) {
      const near = deltas.find((x) => Math.abs(x.t - wrapT) < dt)!;
      expect(near.d, `wrap step @${wrapT}ms vs median ${median.toFixed(2)}°`).toBeLessThan(median * 2);
      expect(near.d, `wrap not stalled @${wrapT}ms`).toBeGreaterThan(median * 0.4);
    }

    // Whole-loop max step is bounded — no discontinuity anywhere in the cycle.
    const maxStep = Math.max(...deltas.map((x) => x.d));
    expect(maxStep, 'max per-frame step across two loops').toBeLessThan(median * 2.5);
  });

  it('the loop never passes back through the standing pose', () => {
    const built = walkBuilt();
    const { trajectory: loop } = buildLoopTrajectory(built, { timeScale: 1 });
    const period = loop.totalMs;
    let minToStanding = Infinity;
    for (let t = 0; t < period; t += period / 240) {
      minToStanding = Math.min(minToStanding, poseDelta(loop.sampleAt(t).pose, baselinePose));
    }
    // Every phase of a gait cycle is well away from a neutral, arms-down stand.
    expect(minToStanding, 'closest the loop gets to standing').toBeGreaterThan(15);
  });

  it('enterAtMs points at the last keyframe phase (smooth first wrap from the first pass)', () => {
    const built = walkBuilt();
    const { enterAtMs, trajectory: loop } = buildLoopTrajectory(built, { timeScale: 1 });
    // The last keyframe sits one wrap-segment before the 1600 ms period end. The
    // wrap segment is the walk's (Perry re-timed, wave 4.2) initial-contact
    // interval — derive it from the authored template so the gate follows the
    // authored cadence instead of pinning a metronomic 8×200 ms (was 1400).
    const walk = MOVEMENT_TEMPLATES.find((x) => x.id === 'walk')!;
    const periodMs = walk.phases.reduce((s, p) => s + p.durationMs + (p.holdMs ?? 0), 0);
    expect(enterAtMs).toBeCloseTo(periodMs - walk.phases[0]!.durationMs, 0); // 1600 − 168 = 1432
    // Entering there and stepping forward crosses the wrap into the first
    // keyframe with no snap.
    const step = poseDelta(loop.sampleAt(enterAtMs).pose, loop.sampleAt(enterAtMs + 1000 / 120).pose);
    expect(step).toBeLessThan(6);
  });

  it('timeScale scales the period without breaking continuity', () => {
    const built = walkBuilt();
    const fast = buildLoopTrajectory(built, { timeScale: 1.5 });
    const slow = buildLoopTrajectory(built, { timeScale: 0.4 });
    expect(fast.trajectory.totalMs).toBeCloseTo(1600 / 1.5, 0);
    expect(slow.trajectory.totalMs).toBeCloseTo(1600 / 0.4, 0);
    // Still continuous at the (rescaled) wrap.
    const p = fast.trajectory.totalMs;
    const dt = 1000 / 120;
    const wrapStep = poseDelta(fast.trajectory.sampleAt(p - dt / 2).pose, fast.trajectory.sampleAt(p + dt / 2).pose);
    expect(wrapStep).toBeLessThan(8);
  });
});
