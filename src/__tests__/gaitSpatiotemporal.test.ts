/**
 * MEASURED SPATIOTEMPORAL GATE — the walk's cadence, step length, speed, walk
 * ratio and Froude number, measured on the rig and graded against the engine's
 * OWN normative bands (services/normativeGait).
 *
 * WHY THIS EXISTS. `normativeGait` bundles `CADENCE_SPM`, `SPEED_MPS`,
 * `STRIDE_M`, `STEP_WIDTH_M` and `walkRatio()` as ground truth, but before this
 * file `SPEED_MPS`, `STEP_WIDTH_M` and `walkRatio` had ZERO callers anywhere in
 * the engine — a repo-wide grep found them only in `normativeGait.test.ts`,
 * asserted equal to themselves as literals. The walk's cadence sat a third below
 * its own band (~75 steps/min against [100, 120]) through a fully green suite,
 * because nothing measured the body and compared it to the numbers the engine
 * ships. Proportion is the most visible property of a gait; it needs a gate.
 *
 * TWO MEASUREMENT TRAPS this file is written to avoid — both of them produced
 * wrong conclusions during the work that led here, so they are encoded as
 * structure rather than left as advice:
 *
 *  1. MEASURE THE STEADY CYCLE, NOT THE WHOLE CLIP. `buildTravelWalk` is
 *     initiation → step-off → one gait cycle → braking step → settle. The
 *     step-off is a LONGER step than the gait it settles into (0.893 m vs
 *     0.805 m) and its hip peaks 37.9° against an authored 30°, because the R
 *     foot's contact window opens at t=0 and pins that foot while the authored
 *     pose still has it reaching forward to first contact; the leg IK reconciles
 *     the two by over-flexing the hip. Averaging or peak-picking across the full
 *     clip therefore reports a ~11% phantom over-stride that steady gait does
 *     not have.
 *  2. NORMALIZE FOR STATURE. The bands are ABSOLUTE, quoted for average adult
 *     stature (hip height ~0.90 m). This rig's hip height is ~1.08 m. Under
 *     dynamic similarity — geometrically similar walkers compared at equal
 *     Froude number [Alexander; Vaughan & O'Malley] — the spatiotemporals scale
 *     with leg length L as: step/stride ∝ L, cadence ∝ 1/√L (a taller walker
 *     takes SLOWER steps), speed ∝ √L, and walk ratio = step/cadence ∝ L^1.5.
 *     Comparing a 1.08 m-legged mannequin against unscaled bands reads a
 *     perfectly normal walk as a 7–15% over-stride. Froude is dimensionless and
 *     needs no scaling — it is the check that does not depend on this reasoning.
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
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { captureFloorReference } from '../services/rootMotion';
import { buildTravelWalk, MOVEMENT_TEMPLATES } from '../services/movementTemplates';
import {
  CADENCE_SPM,
  SPEED_MPS,
  STRIDE_M,
  WALK_RATIO_M_PER_SPM,
  walkRatio,
  type NormativeBand,
} from '../services/normativeGait';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

/** Hip height (m) the absolute normative bands are quoted for — average adult
 *  stature. The scaling below is a RATIO, so only this reference matters, not
 *  the absolute anthropometry behind it. */
const REFERENCE_LEG_M = 0.9;

/** Scale an absolute band by L^exponent for a rig of leg length `legM`. */
function scaleBand(band: NormativeBand, legM: number, exponent: number): [number, number] {
  const k = (legM / REFERENCE_LEG_M) ** exponent;
  return [band[0] * k, band[1] * k];
}

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
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
  floorY = captureFloorReference(skinned.skeleton, variantCfg).floorY;
});

interface Measured {
  legM: number;
  cadenceSpm: number;
  stepM: number;
  strideM: number;
  speedMps: number;
  ratio: number;
  froude: number;
  entryStepM: number;
}

/** Measure the walk's steady-cycle spatiotemporals on the rig. */
function measureWalk(): Measured {
  const motion = buildTravelWalk();
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 120,
  });
  const frames = rec.frames;

  // Cumulative resolved keyframe boundaries. buildTravelWalk's layout is
  // [0] initiation · [1] step-off · [2..8] the gait cycle · [9] braking step ·
  // [10] settle — so the STEADY window is the end of [2] to the end of [8],
  // which excludes both the long entry step and the braking one.
  const ends: number[] = [];
  let acc = 0;
  for (const k of resolved.keyframes) {
    acc += k.durationMs + (k.holdMs ?? 0);
    ends.push(acc);
  }
  const steadyFrom = ends[2]!;
  const steadyTo = ends[8]!;

  const legM = frames[0]!.worldTracks!.Hips![1]! - floorY;

  /** Peak antero-posterior ankle separation in a window = step length. */
  const peakSeparation = (t0: number, t1: number): number => {
    let sep = 0;
    for (const f of frames) {
      if (f.tMs < t0 || f.tMs > t1) continue;
      const r = f.worldTracks!.R_Foot!;
      const l = f.worldTracks!.L_Foot!;
      sep = Math.max(sep, Math.abs(r[2]! - l[2]!));
    }
    return sep;
  };

  // Cadence comes from the TEMPLATE's authored cycle (two steps per cycle), not
  // from the travel builder's clip — the clip carries entry and exit keyframes
  // that are not part of the repeating rhythm.
  const cycleMs = MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!.phases.reduce(
    (s, p) => s + p.durationMs + (p.holdMs ?? 0),
    0,
  );
  const cadenceSpm = (2 / (cycleMs / 1000)) * 60;

  const stepM = peakSeparation(steadyFrom, steadyTo);
  const speedMps = stepM * (cadenceSpm / 60);
  return {
    legM,
    cadenceSpm,
    stepM,
    strideM: stepM * 2,
    speedMps,
    ratio: walkRatio(stepM, cadenceSpm),
    froude: (speedMps * speedMps) / (9.81 * legM),
    entryStepM: peakSeparation(ends[0]!, ends[1]!),
  };
}

describe('the travel walk’s MEASURED spatiotemporals sit in the engine’s normative bands', () => {
  let m: Measured;
  beforeAll(() => {
    m = measureWalk();
    // eslint-disable-next-line no-console
    console.log(
      `walk (steady cycle, leg ${m.legM.toFixed(3)} m): cadence ${m.cadenceSpm.toFixed(1)} spm · ` +
        `step ${m.stepM.toFixed(3)} m · stride ${m.strideM.toFixed(3)} m · ` +
        `speed ${m.speedMps.toFixed(3)} m/s · walkRatio ${m.ratio.toFixed(5)} · ` +
        `Froude ${m.froude.toFixed(3)}`,
    );
  });

  it('Froude number is a comfortable WALK — the one check that needs no stature scaling', () => {
    // Dimensionless, so the absolute bands' stature assumption cannot distort it.
    // Comfortable human walking is Fr ≈ 0.15–0.25; the walk→run transition is
    // ≈ 0.5 (normativeGait's regime note). Below ~0.1 is a deliberate slow gait —
    // which is what the 1600 ms cycle used to produce (Fr ≈ 0.13).
    expect(m.froude).toBeGreaterThan(0.12);
    expect(m.froude).toBeLessThan(0.3);
  });

  it('cadence is in band — the property that was a third low and ungated', () => {
    const band = scaleBand(CADENCE_SPM, m.legM, -0.5); // cadence ∝ 1/√L
    expect(m.cadenceSpm).toBeGreaterThanOrEqual(band[0]);
    expect(m.cadenceSpm).toBeLessThanOrEqual(band[1]);
    // Also inside the UNSCALED band, so this gate does not rest on the scaling
    // argument alone. (Scaling only widens the tolerance for a tall rig; cadence
    // happens to clear both.)
    expect(m.cadenceSpm).toBeGreaterThanOrEqual(CADENCE_SPM[0]);
    expect(m.cadenceSpm).toBeLessThanOrEqual(CADENCE_SPM[1]);
  });

  it('speed, stride and walk ratio are in band once scaled for the rig’s stature', () => {
    const speedBand = scaleBand(SPEED_MPS, m.legM, 0.5); // speed ∝ √L
    const strideBand = scaleBand(STRIDE_M, m.legM, 1); // stride ∝ L
    const ratioBand = scaleBand(WALK_RATIO_M_PER_SPM, m.legM, 1.5); // step/cadence ∝ L^1.5
    expect(m.speedMps, `speed vs ${speedBand}`).toBeGreaterThanOrEqual(speedBand[0]);
    expect(m.speedMps, `speed vs ${speedBand}`).toBeLessThanOrEqual(speedBand[1]);
    expect(m.strideM, `stride vs ${strideBand}`).toBeGreaterThanOrEqual(strideBand[0]);
    expect(m.strideM, `stride vs ${strideBand}`).toBeLessThanOrEqual(strideBand[1]);
    expect(m.ratio, `walk ratio vs ${ratioBand}`).toBeGreaterThanOrEqual(ratioBand[0]);
    expect(m.ratio, `walk ratio vs ${ratioBand}`).toBeLessThanOrEqual(ratioBand[1]);
  });

  it('the ENTRY step is longer than the steady step — measure the cycle, not the clip', () => {
    // Pins trap #1 so it cannot silently mislead a future measurement: the
    // step-off overshoots, so any spatiotemporal taken across the whole clip
    // reads high. If this ever stops being true the entry has been fixed and the
    // windowing in `measureWalk` can be simplified — that is a real improvement,
    // and this assertion is where it will announce itself.
    expect(m.entryStepM).toBeGreaterThan(m.stepM);
    // …and the inflation is bounded: the entry is a long step, not a lunge.
    expect(m.entryStepM / m.stepM).toBeLessThan(1.25);
  });
});
