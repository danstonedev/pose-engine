/**
 * COMPOSED RIG DERIVATIONS — first behavioral coverage.
 *
 * These four trajectory pre-passes (calibrated gait vertical, foot-driven
 * travel, medio-lateral shuttle, heel-strike accents) used to live inside
 * `ExamStage3D.svelte`, which no test can mount — so they were guarded only by
 * regexes over the component's source text. Extracted into
 * `services/stageComposedDerivations`, they run here against the REAL rig
 * (runtime GLB + anatomic pose + floor reference) and a REAL trajectory.
 *
 * What is pinned: each derivation's rig-unavailable identity (the strict
 * no-op every non-gait motion takes), the plants-gated vertical clamp
 * (DET-LOCK-01), that the shared pre-pass really poses the rig on the playback
 * root base, that a real travelling walk produces a forward-advancing travel
 * curve, and that the pelvis-shift tracker is cleared on every absolute root
 * write (the invariant the stage depends on for its shift bookkeeping).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference } from '../services/jointAngles';
import { captureFloorReference, NO_VERTICAL_CALIBRATION } from '../services/rootMotion';
import { GAIT_VERTICAL_MAX_RISE_M } from '../services/motionRecording';
import { resolveComposedMotion } from '../services/motionSequence';
import { buildComposedTrajectory } from '../services/motionTrajectory';
import { buildSequencePoses } from '../services/motionSequence';
import { buildTravelWalk } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import {
  createComposedDerivations,
  scaledHeadingAt,
  scaledStanceWindows,
  type StageRigContext,
  type StanceWindow,
} from '../services/stageComposedDerivations';
import type { PoseTrajectory } from '../services/motionTrajectory';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let floor: ReturnType<typeof captureFloorReference>;
let baselinePose: CustomPose;
let rootRestPos: THREE.Vector3;
let rootRestQuat: THREE.Quaternion;
/** Counts clearPelvisShiftBake() calls — the tracker-honesty invariant. */
let shiftClears = 0;

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
  captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  floor = captureFloorReference(skinned.skeleton, variantCfg);
  rootRestPos = root.position.clone();
  rootRestQuat = root.quaternion.clone();
});

/** A live context over the loaded rig (mirrors how the stage wires it: getters
 *  over the current refs). `present` toggles the rig-unavailable path. */
function makeCtx(present = true): StageRigContext {
  return {
    get root() {
      return present ? root : null;
    },
    get skinned() {
      return present ? skinned : null;
    },
    get variantCfg() {
      return present ? variantCfg : null;
    },
    get floor() {
      return present ? floor : null;
    },
    rootRestPos,
    rootRestQuat,
    clearPelvisShiftBake() {
      shiftClears++;
    },
  };
}

/** Build the real trajectory of a travelling walk (the gait every derivation
 *  is designed for). */
function travelWalkTrajectory(): { traj: PoseTrajectory; stance: StanceWindow[] | undefined } {
  const resolved = resolveComposedMotion(buildTravelWalk({}), variantCfg);
  expect(resolved.status).toBe('ok');
  const rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest);
  const { trajectory: traj } = buildComposedTrajectory(built, {
    startPose: baselinePose,
    startQuat: [0, 0, 0, 1],
    startTranslate: [0, 0, 0],
    timeScale: 1,
  });
  return { traj, stance: scaledStanceWindows(traj, resolved) };
}

/** Restore the rig to its captured rest between derivations (each one poses the
 *  rig transiently, exactly as it does on the live stage between frames). */
function resetRig(): void {
  root.position.copy(rootRestPos);
  root.quaternion.copy(rootRestQuat);
  root.updateMatrixWorld(true);
}

describe('composed rig derivations — the rig-unavailable identity', () => {
  it('every derivation is a strict no-op without a rig (the pre-boot / disposed path)', () => {
    const d = createComposedDerivations(makeCtx(false));
    const { traj, stance } = travelWalkTrajectory();
    resetRig();
    expect(d.verticalCalibration(traj, 5, true, true)).toEqual({
      table: NO_VERTICAL_CALIBRATION,
      cycleMs: 0,
    });
    expect(d.footDrivenTravel(traj, true, true, stance)).toBeNull();
    expect(d.lateralShuttle(traj, 4, true, stance)).toBeNull();
    expect(
      d.heelStrikeAccents(traj, true, stance, {
        table: NO_VERTICAL_CALIBRATION,
        cycleMs: 0,
        phaseOffsetMs: 0,
        rampMs: 0,
      }),
    ).toBeNull();
  });

  it('each derivation is OFF unless its own flag asks for it (no accidental enablement)', () => {
    const d = createComposedDerivations(makeCtx());
    const { traj, stance } = travelWalkTrajectory();
    resetRig();
    // vertical: no target ⇒ identity
    expect(d.verticalCalibration(traj, undefined, true, true).table).toBe(NO_VERTICAL_CALIBRATION);
    // vertical: target but nothing planted ⇒ identity
    expect(d.verticalCalibration(traj, 5, false, true).table).toBe(NO_VERTICAL_CALIBRATION);
    // travel: disabled, or nothing planted
    expect(d.footDrivenTravel(traj, false, true, stance)).toBeNull();
    expect(d.footDrivenTravel(traj, true, false, stance)).toBeNull();
    // shuttle: zero/absent amplitude
    expect(d.lateralShuttle(traj, undefined, true, stance)).toBeNull();
    expect(d.lateralShuttle(traj, 0, true, stance)).toBeNull();
    // heel strike: disabled, or no planned stance schedule
    const vcal = { table: NO_VERTICAL_CALIBRATION, cycleMs: 0, phaseOffsetMs: 0, rampMs: 0 };
    expect(d.heelStrikeAccents(traj, false, stance, vcal)).toBeNull();
    expect(d.heelStrikeAccents(traj, true, undefined, vcal)).toBeNull();
    expect(d.heelStrikeAccents(traj, true, [], vcal)).toBeNull();
  });
});

describe('composed rig derivations — on the real rig', () => {
  it('the shared pre-pass poses the rig on the playback root base (rest ∘ sample)', () => {
    const d = createComposedDerivations(makeCtx());
    const { traj } = travelWalkTrajectory();
    resetRig();
    const s = d.previewTrajectoryAt(traj, 0);
    // The root sits at rest + the sample's translate, and the orientation is
    // rest composed with the sample quat — the same base applyTrajectoryRoot uses.
    const expectQ = rootRestQuat
      .clone()
      .multiply(new THREE.Quaternion(s.rootQuat[0], s.rootQuat[1], s.rootQuat[2], s.rootQuat[3]));
    expect(root.quaternion.angleTo(expectQ)).toBeLessThan(1e-6);
    expect(root.position.x).toBeCloseTo(rootRestPos.x + s.rootTranslate[0], 6);
    expect(root.position.z).toBeCloseTo(rootRestPos.z + s.rootTranslate[2], 6);
    // Y is the floor pin's business when the sample is planted, so only assert
    // the un-pinned axis relationship above.
  });

  it('the pre-pass clears the pelvis-shift bake on EVERY absolute root write', () => {
    const d = createComposedDerivations(makeCtx());
    const { traj } = travelWalkTrajectory();
    resetRig();
    shiftClears = 0;
    d.previewTrajectoryAt(traj, 0);
    d.previewTrajectoryAt(traj, traj.totalMs / 2);
    expect(shiftClears).toBe(2);
  });

  it('a travelling walk derives a forward-advancing foot-driven travel curve', () => {
    const d = createComposedDerivations(makeCtx());
    const { traj, stance } = travelWalkTrajectory();
    resetRig();
    const travel = d.footDrivenTravel(traj, true, true, stance);
    expect(travel).not.toBeNull();
    // The body ends up ahead of where it started — travel advances forward.
    const zStart = travel!.zAt(0);
    const zEnd = travel!.zAt(traj.totalMs);
    expect(zEnd).toBeGreaterThan(zStart);
    // …and it is a real stride, not a rounding artifact.
    expect(Math.abs(zEnd - zStart)).toBeGreaterThan(0.1);
    // Straight-ahead gait rides the default +Z heading (the legacy path).
    expect(travel!.heading[1]).toBeCloseTo(1, 6);
  });

  it('the vertical calibration fits the requested excursion and is gated by plants (DET-LOCK-01)', () => {
    const d = createComposedDerivations(makeCtx());
    const { traj } = travelWalkTrajectory();
    resetRig();
    const withPlants = d.verticalCalibration(traj, 5, true, true);
    resetRig();
    const noPlants = d.verticalCalibration(traj, 5, true, false);
    // Both calibrate (non-identity table, cycle = the trajectory length)…
    expect(withPlants.cycleMs).toBe(traj.totalMs);
    expect(noPlants.cycleMs).toBe(traj.totalMs);
    expect(withPlants.table).not.toBe(NO_VERTICAL_CALIBRATION);
    expect(withPlants.table.smoothed?.length).toBeGreaterThan(0);
    // …and the plants gate is NOT a dead argument: the rise clamp rides on the
    // table (applied when the arc is applied, DET-LOCK-01) exactly when this
    // motion built foot plants, and is absent otherwise. Same shared constant
    // the offline sampler passes — one value, not a copy.
    expect(withPlants.table.maxRiseM).toBe(GAIT_VERTICAL_MAX_RISE_M);
    expect(noPlants.table.maxRiseM).toBeUndefined();
    // The FIT itself is unchanged by the gate (the clamp is an apply-time cap).
    expect(noPlants.table.gain).toBeCloseTo(withPlants.table.gain, 12);
    expect(noPlants.table.meanY).toBeCloseTo(withPlants.table.meanY, 12);
  });

  it('the lateral shuttle derives a bounded ±X ride at the requested amplitude', () => {
    const d = createComposedDerivations(makeCtx());
    const { traj, stance } = travelWalkTrajectory();
    resetRig();
    const shuttle = d.lateralShuttle(traj, 4, true, stance);
    expect(shuttle).not.toBeNull();
    // Sample the ride across the cycle: it stays inside the requested amplitude
    // (4 cm ⇒ 0.04 m) and actually moves (a dead table would read all zeros).
    let maxAbs = 0;
    for (let i = 0; i <= 20; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(shuttle!.xAt((i / 20) * traj.totalMs)));
    }
    expect(maxAbs).toBeLessThanOrEqual(0.04 + 1e-6);
    expect(maxAbs).toBeGreaterThan(0);
    // Straight-ahead gait rides the default world-+X lateral (the legacy path).
    expect(shuttle!.lateral[0]).toBeCloseTo(1, 6);
  });
});

describe('composed derivations — SEAM-2 authored→trajectory time scaling', () => {
  const timing = { keyframes: [{ durationMs: 500, holdMs: 0 }], loop: false, reps: 1 };

  it('scaledStanceWindows is undefined without a planned schedule', () => {
    const traj = { totalMs: 1000 } as PoseTrajectory;
    expect(scaledStanceWindows(traj, { ...timing })).toBeUndefined();
  });

  it('scaledStanceWindows re-times authored windows by the trajectory factor', () => {
    // Authored 500 ms of keyframes played over a 1000 ms trajectory ⇒ ×2.
    const traj = { totalMs: 1000 } as PoseTrajectory;
    const out = scaledStanceWindows(traj, {
      ...timing,
      gaitStanceWindowsMs: [{ foot: 'L_Foot', fromMs: 100, toMs: 200 }],
    });
    expect(out).toHaveLength(1);
    expect(out![0].fromMs).toBeCloseTo(200, 6);
    expect(out![0].toMs).toBeCloseTo(400, 6);
  });

  it('scaledHeadingAt is undefined for a constant heading (the legacy path)', () => {
    const traj = { totalMs: 1000 } as PoseTrajectory;
    expect(scaledHeadingAt(traj, { ...timing })).toBeUndefined();
    expect(
      scaledHeadingAt(traj, { ...timing, headingProfileMs: [{ tMs: 0, headingDeg: 0 }] }),
    ).toBeUndefined();
  });

  it('scaledHeadingAt maps trajectory time back through the SAME factor as the windows', () => {
    const traj = { totalMs: 1000 } as PoseTrajectory;
    const at = scaledHeadingAt(traj, {
      ...timing,
      headingProfileMs: [
        { tMs: 0, headingDeg: 0 },
        { tMs: 500, headingDeg: 90 },
      ],
    });
    expect(at).toBeDefined();
    // Authored 500 ms ⇒ trajectory 1000 ms: the authored end lands at the
    // trajectory end, so heading and stance phase stay locked together.
    expect(at!(0)).toBeCloseTo(0, 6);
    expect(at!(1000)).toBeCloseTo(90, 6);
    expect(at!(500)).toBeCloseTo(45, 6);
  });
});
