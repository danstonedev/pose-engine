/**
 * UNIFIED VALIDITY GATE (Workstream A) — the animation-craft plausibility gates.
 *
 * Two contracts, one gate:
 *   1. Every SHIPPED template/builder, resolved + rig-sampled, passes the gate
 *      (overall !== 'fail'). Where a real template trips a check the gate must
 *      surface it HONESTLY (a warn, not a silent pass) — the in-place walk/run
 *      slide their planted feet by treadmill convention (foot-skate WARN), and a
 *      floor-pinned quasi-static template runs its CoM a little behind its
 *      RECONSTRUCTED base (com-in-base WARN). Neither is a topple; both are the
 *      auditable signal the gate exists to give.
 *   2. Injected COUNTERFACTUALS — a dragged planted foot, a keyframe teleport, a
 *      foot below the floor, a CoM shoved off its base — each flip the matching
 *      check to a hard FAIL (and only that check). The injected frames are
 *      DISCARDED after (mutated clones, never the shared recording).
 *
 * Rig harness: the same headless GLB sampler the other gate tests use
 * (load → resolve → sampleComposedMotion → world-space frames).
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
import { resolveComposedMotion, type ComposedMotion, type ResolvedComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { captureFloorReference } from '../services/rootMotion';
import {
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
  buildTravelWalk,
  buildTravelRun,
  buildRun,
  buildTurnInPlace,
  buildJump,
  buildSingleLegHop,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import {
  assessValidity,
  DEFAULT_VALIDITY_THRESHOLDS,
  type GateFrame,
  type ValidityCheck,
} from '../services/validityGate';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;
let floorY = 0;

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
  floorY = captureFloorReference(skinned.skeleton, variantCfg).floorY;
});

/** Reset the harness to origin (the sampler captures the current root as rest). */
function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

function sample(m: ComposedMotion): { resolved: ResolvedComposedMotion; rec: MotionRecording } {
  resetHarness();
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  });
  return { resolved, rec };
}

/** Deep-clone the sampled frames into a mutable GateFrame[] (so a counterfactual
 *  never scribbles on the shared recording). */
function cloneFrames(rec: MotionRecording): GateFrame[] {
  return rec.frames.map((f) => ({
    tMs: f.tMs,
    root: { translateM: [...f.root.translateM] as [number, number, number] },
    worldTracks: Object.fromEntries(
      Object.entries(f.worldTracks ?? {}).map(([k, p]) => [k, [...p] as [number, number, number]]),
    ),
  }));
}

const checkById = (checks: ValidityCheck[], id: string): ValidityCheck | undefined =>
  checks.find((c) => c.id === id);

// ── The template T() shorthand + the required sweep set ──────────────────────

const T = (id: string): ComposedMotion =>
  templateToComposedMotion(MOVEMENT_TEMPLATES.find((t) => t.id === id)!);

const SWEEP: { label: string; motion: ComposedMotion }[] = [
  { label: 'walk (in-place template)', motion: T('walk') },
  { label: 'sit-to-stand (template)', motion: T('sit-to-stand') },
  { label: 'buildTravelWalk', motion: buildTravelWalk() },
  { label: 'buildTravelWalk(turn90)', motion: buildTravelWalk({ turnDeg: 90 }) },
  { label: 'buildRun', motion: buildRun() },
  { label: 'buildTravelRun', motion: buildTravelRun() },
  { label: 'buildTurnInPlace', motion: buildTurnInPlace() },
  { label: 'buildJump', motion: buildJump() },
  { label: 'buildSingleLegHop', motion: buildSingleLegHop() },
];

// ── 1. All shipped templates pass ────────────────────────────────────────────

describe('validity gate — every shipped template resolves + rig-samples to a non-fail verdict', () => {
  for (const { label, motion } of SWEEP) {
    it(`${label} → overall !== 'fail'`, () => {
      const { resolved, rec } = sample(motion);
      const report = assessValidity(resolved, rec.frames, { floorY });
      // The ROM-clamp invariant, penetration, and seam-jerk must PASS outright
      // for every shipped motion — those are hard correctness checks.
      expect(checkById(report.checks, 'rom-violation')!.pass, 'ROM invariant holds').toBe(true);
      expect(checkById(report.checks, 'penetration')!.pass, 'no floor penetration').toBe(true);
      expect(checkById(report.checks, 'seam-jerk')!.pass, 'no velocity discontinuity').toBe(true);
      // Any foot-skate on a shipped clip is only ever a WARN (in-place slide),
      // never a fail — a travelling gait keeps its planted foot fixed.
      const skate = checkById(report.checks, 'foot-skate');
      if (skate && !skate.pass) expect(skate.severity, `${label} skate is in-place warn`).toBe('warn');
      // Likewise a quasi-static template's CoM warn is never a hard fail.
      const com = checkById(report.checks, 'com-in-base');
      if (com && !com.pass) expect(com.severity, `${label} com warn`).toBe('warn');
      expect(report.overall, `${label} verdict`).not.toBe('fail');
      expect(report.score).toBeGreaterThan(0.5);
    });
  }

  it('a travelling gait keeps its planted foot world-fixed (foot-skate PASSES as a fail-severity check)', () => {
    const { resolved, rec } = sample(buildTravelWalk());
    const report = assessValidity(resolved, rec.frames, { floorY });
    const skate = checkById(report.checks, 'foot-skate')!;
    expect(skate.severity, 'travel ⇒ fail-severity foot-skate').toBe('fail');
    expect(skate.pass, 'and it passes — the planted foot holds').toBe(true);
    expect(skate.measured).toBeLessThanOrEqual(DEFAULT_VALIDITY_THRESHOLDS.footSkateRatioMax);
  });

  it('the in-place walk template skates by treadmill convention — reported as a WARN, not a fail', () => {
    const { resolved, rec } = sample(T('walk'));
    const report = assessValidity(resolved, rec.frames, { floorY });
    const skate = checkById(report.checks, 'foot-skate')!;
    expect(skate.severity, 'in-place ⇒ warn').toBe('warn');
    expect(skate.pass, 'and it does slide (a real, surfaced finding)').toBe(false);
    expect(report.overall).toBe('warn');
  });

  it('dynamic motions SKIP the static CoM-in-base check; quasi-static ones run it', () => {
    const walk = assessValidity(...sampleFor(buildTravelWalk()));
    expect(walk.skipped.some((s) => s.startsWith('com-in-base'))).toBe(true);
    expect(checkById(walk.checks, 'com-in-base')).toBeUndefined();

    const sts = assessValidity(...sampleFor(T('sit-to-stand')));
    expect(checkById(sts.checks, 'com-in-base'), 'sit-to-stand is quasi-static').toBeDefined();
  });
});

/** Sample + package the assessValidity args for a motion (frames + floor). */
function sampleFor(m: ComposedMotion): [ResolvedComposedMotion, GateFrame[], { floorY: number }] {
  const { resolved, rec } = sample(m);
  return [resolved, rec.frames as unknown as GateFrame[], { floorY }];
}

// ── 2. Counterfactuals fail (then the injected input is discarded) ───────────

describe('validity gate — injected counterfactuals are caught', () => {
  it('a foot DRAGGED during contact → foot-skate FAIL', () => {
    const { resolved, rec } = sample(buildTravelWalk()); // travels ⇒ fail-severity skate
    const clean = assessValidity(resolved, rec.frames, { floorY });
    expect(clean.overall).not.toBe('fail'); // baseline is clean

    // Inject: sweep the RIGHT foot across the floor at ~1.8 m/s (well past the
    // 0.75 m/s plant threshold) while leaving its height untouched, so every
    // planted-contact frame reads as sliding. A constant-velocity ramp has zero
    // 2nd difference, so ONLY foot-skate should trip (seam-jerk stays clean).
    const frames = cloneFrames(rec);
    const dragPerFrame = 0.03; // m/frame @ 60 Hz ⇒ 1.8 m/s
    frames.forEach((f, i) => {
      const p = f.worldTracks!.R_Foot!;
      f.worldTracks!.R_Foot = [p[0] + dragPerFrame * i, p[1], p[2]];
    });
    const report = assessValidity(resolved, frames, { floorY });
    const skate = checkById(report.checks, 'foot-skate')!;
    expect(skate.pass, 'drag detected').toBe(false);
    expect(skate.severity).toBe('fail');
    expect(skate.measured, 'nearly all contact frames slide').toBeGreaterThan(0.5);
    expect(report.overall).toBe('fail');
    // Only foot-skate flipped — the drag is a clean single-check counterfactual.
    expect(checkById(report.checks, 'seam-jerk')!.pass).toBe(true);
    expect(checkById(report.checks, 'penetration')!.pass).toBe(true);
  });

  it('a keyframe TELEPORT → seam-jerk FAIL', () => {
    const { resolved, rec } = sample(buildTravelWalk());
    const frames = cloneFrames(rec);
    // Jump the root +2 m at a single mid frame (out and back) — the classic
    // one-frame teleport spike a smooth trajectory can never produce.
    const mid = Math.floor(frames.length / 2);
    const r = frames[mid]!.root!.translateM;
    frames[mid]!.root!.translateM = [r[0] + 2, r[1], r[2]];
    const report = assessValidity(resolved, frames, { floorY });
    const seam = checkById(report.checks, 'seam-jerk')!;
    expect(seam.pass, 'teleport detected').toBe(false);
    expect(seam.measured, 'far past any human velocity discontinuity').toBeGreaterThan(
      DEFAULT_VALIDITY_THRESHOLDS.seamJerkMaxMs,
    );
    expect(report.overall).toBe('fail');
  });

  it('a foot authored BELOW the floor → penetration FAIL', () => {
    const { resolved, rec } = sample(buildTravelWalk());
    const frames = cloneFrames(rec);
    // Sink the LEFT foot 10 cm under the floor across a mid block (far past the
    // 2 cm ankle tolerance; the third-rocker toe dip is only ~3.5 cm).
    const lo = Math.floor(frames.length * 0.4);
    const hi = Math.floor(frames.length * 0.5);
    for (let i = lo; i < hi; i += 1) {
      const p = frames[i]!.worldTracks!.L_Foot!;
      frames[i]!.worldTracks!.L_Foot = [p[0], floorY - 0.1, p[2]];
    }
    const report = assessValidity(resolved, frames, { floorY });
    const pen = checkById(report.checks, 'penetration')!;
    expect(pen.pass, 'penetration detected').toBe(false);
    expect(pen.severity).toBe('fail');
    expect(pen.measured, 'measured ~10 cm below the floor').toBeGreaterThan(0.08);
    expect(pen.note).toContain('L_Foot');
    expect(report.overall).toBe('fail');
  });

  it('a CoM SHOVED off its base → com-in-base FAIL (on a quasi-static motion)', () => {
    // forward-hip-hinge is quasi-static AND passes com-in-base clean — the ideal
    // pass→fail demonstration.
    const { resolved, rec } = sample(T('forward-hip-hinge'));
    const clean = assessValidity(resolved, rec.frames, { floorY });
    expect(checkById(clean.checks, 'com-in-base')!.pass, 'baseline CoM is over the base').toBe(true);

    const frames = cloneFrames(rec);
    for (const f of frames) {
      const c = f.worldTracks!.CoM!;
      f.worldTracks!.CoM = [c[0] + 0.6, c[1], c[2]]; // shove 60 cm to the side
    }
    const report = assessValidity(resolved, frames, { floorY });
    const com = checkById(report.checks, 'com-in-base')!;
    expect(com.pass, 'topple detected').toBe(false);
    expect(com.severity, 'a gross excursion is a hard fail').toBe('fail');
    expect(com.measured, 'CoM far outside the base').toBeLessThan(-DEFAULT_VALIDITY_THRESHOLDS.comBaseGrossM);
    expect(report.overall).toBe('fail');
  });

  it('a RESOLVED target out of its ROM band → rom-violation FAIL (structural, a real bug)', () => {
    const { resolved } = sample(T('squat'));
    // Corrupt a resolved knee target to 200° (band max 140°) — resolution should
    // have clamped this, so a violation on the RESOLVED output is a real bug.
    const bad: ResolvedComposedMotion = {
      ...resolved,
      keyframes: resolved.keyframes.map((kf, i) =>
        i === 0
          ? { ...kf, targets: [...kf.targets, { joint: 'R_Leg', motion: 'kneeFlexion', clampedDegrees: 200 }] }
          : kf,
      ),
    };
    const report = assessValidity(bad); // structural mode — no frames needed
    const rom = checkById(report.checks, 'rom-violation')!;
    expect(rom.pass).toBe(false);
    expect(rom.measured, '60° past the 140° band').toBeGreaterThan(55);
    expect(rom.note).toContain('R_Leg.kneeFlexion');
    expect(report.overall).toBe('fail');
  });
});

// ── 3. Rig-free / structural mode + report contract ──────────────────────────

describe('validity gate — structural (rig-free) mode + report contract', () => {
  it('runs the structural checks without frames and never throws', () => {
    const { resolved } = sample(T('sit-to-stand'));
    const report = assessValidity(resolved); // no frames
    // ROM invariant ran; the four geometric checks are recorded as skipped.
    expect(checkById(report.checks, 'rom-violation')).toBeDefined();
    expect(checkById(report.checks, 'foot-skate')).toBeUndefined();
    expect(report.skipped.some((s) => s.includes('structural mode'))).toBe(true);
    expect(report.overall).toBe('pass');
    expect(report.score).toBe(1);
  });

  it('a refused / empty resolution grades vacuously clean (nothing plays)', () => {
    const empty: ResolvedComposedMotion = {
      status: 'refused',
      keyframes: [],
      outcomes: [],
      loop: false,
      startFrom: 'neutral',
      reps: 1,
    };
    const report = assessValidity(empty);
    expect(report.overall).toBe('pass');
    expect(report.checks).toHaveLength(0);
  });

  it('records the biomech extension point in `skipped` when no hook is given', () => {
    const [resolved, frames, opts] = sampleFor(buildTravelWalk());
    const report = assessValidity(resolved, frames, opts);
    expect(report.skipped.some((s) => s.startsWith('biomech'))).toBe(true);
  });

  it('folds a supplied biomech hook into the same report (the integration seam)', () => {
    const [resolved, frames, opts] = sampleFor(buildTravelWalk());
    // A stand-in hook (the real normativeGait checks plug in here at integration).
    const report = assessValidity(resolved, frames, {
      ...opts,
      runBiomechChecks: () => [
        { id: 'froude', pass: true, severity: 'warn', measured: 0.25, threshold: 0.4, unit: 'dimensionless', note: 'stub' },
      ],
    });
    expect(checkById(report.checks, 'froude'), 'hook result folded in').toBeDefined();
    expect(report.skipped.some((s) => s.startsWith('biomech'))).toBe(false);
  });

  it('every emitted check carries the full auditable shape, and the report is deterministic', () => {
    const [resolved, frames, opts] = sampleFor(T('sit-to-stand'));
    const a = assessValidity(resolved, frames, opts);
    const b = assessValidity(resolved, frames, opts);
    expect(a).toEqual(b); // pure ⇒ byte-identical
    for (const c of a.checks) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.pass).toBe('boolean');
      expect(['fail', 'warn']).toContain(c.severity);
      expect(Number.isFinite(c.measured)).toBe(true);
      expect(Number.isFinite(c.threshold)).toBe(true);
      expect(typeof c.unit).toBe('string');
      expect(c.note.length).toBeGreaterThan(0);
    }
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(1);
  });
});
