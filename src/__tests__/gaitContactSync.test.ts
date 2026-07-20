/**
 * PACED-GAIT CONTACT SYNC + RELEASE GATE (SEAM-2 / SEAM-3).
 *
 * SEAM-2 — contact windows must live on the TRAJECTORY clock at every pace.
 * `buildTravelWalk` authors its foot-plant `contacts` and `gaitStanceWindowsMs`
 * in AUTHORED keyframe ms; a paced walk (speed ≠ 1 → paceGait sets
 * `modifiers.timeScale` = √speed) re-times the trajectory by 1/timeScale. The
 * stance windows were always scaled into trajectory time but the contacts were
 * applied raw, so every paced walk pinned each foot 1/timeScale out of phase —
 * the "planted" foot slid 23–58 cm inside its own stance window and popped
 * ~50 cm/frame at release (diagnostics SEAM-2; the old gates only sampled
 * speed 1.0, which is why it shipped). Both now flow through ONE shared factor
 * ({@link authoredToTrajectoryTimeScale}), and this gate samples the paces the
 * old suite never did.
 *
 * SEAM-3 — releasing a plant must be continuous, even at speed 1. Dropping the
 * IK pin the frame a stance window ends snapped the released foot ~20 cm (and
 * the leg joints ~17°/frame) back to its FK pose at every toe-off. The release
 * now ramps the IK correction 1→0 over PLANT_RELEASE_BLEND_MS
 * (solveFootPlantWeighted), so the 150 ms after each window end must show no
 * per-frame position/rotation jump anywhere near the old pop class.
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
import { resolveComposedMotion, type ResolvedComposedMotion } from '../services/motionSequence';
import {
  authoredToTrajectoryTimeScale,
  sampleComposedMotion,
  scaleStanceWindowsMs,
  type MotionRecording,
} from '../services/motionRecording';
import { measureContactSlide, PLANT_RELEASE_BLEND_MS } from '../services/footContact';
import { buildTravelWalk } from '../services/movementTemplates';
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

/** The sampler captures the current root as its rest — reset between samples. */
function resetHarness(): void {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
}

interface Sampled {
  rec: MotionRecording;
  resolved: ResolvedComposedMotion;
  /** Recording duration = trajectory total, ms. */
  totalMs: number;
  /** The shared authored-ms → trajectory-ms factor for this pace. */
  scale: number;
}

const cache = new Map<number, Sampled>();

function sampleTravel(speed: number): Sampled {
  const hit = cache.get(speed);
  if (hit) return hit;
  resetHarness();
  const resolved = resolveComposedMotion(
    buildTravelWalk(speed === 1 ? {} : { speed }),
    variantCfg,
  );
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz: 120,
  });
  const totalMs = rec.frames[rec.frames.length - 1]!.tMs;
  const out: Sampled = {
    rec,
    resolved,
    totalMs,
    scale: authoredToTrajectoryTimeScale(resolved, totalMs),
  };
  cache.set(speed, out);
  return out;
}

/** The paces under test — 1.0 (the only pace the old gates sampled) plus the
 *  paced speeds the SEAM-2 desync shipped at. */
const SPEEDS = [0.8, 1.0, 1.2] as const;

const dist2 = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(b[0] - a[0], b[2] - a[2]);

describe('SEAM-2 — the planted foot stays put inside every contact window, at every pace', () => {
  for (const speed of SPEEDS) {
    it(`speed ${speed}: in-window XZ drift of the pinned foot < 4 cm (was 23–58 cm when paced)`, () => {
      const { rec, resolved, scale } = sampleTravel(speed);
      // Non-vacuous pacing: at speed ≠ 1 the authored and trajectory clocks
      // genuinely diverge (timeScale = √speed), so measuring with RAW authored
      // windows here would re-open the shipped hole.
      if (speed !== 1) expect(Math.abs(scale - 1), 'paced clock diverges').toBeGreaterThan(0.04);
      for (const [i, c] of resolved.contacts!.entries()) {
        const fromMs = c.fromMs! * scale;
        const toMs = c.toMs! * scale;
        const slide = measureContactSlide(rec, c.foot, fromMs, toMs);
        // eslint-disable-next-line no-console
        console.log(
          `speed ${speed} window ${i} (${c.foot} ${fromMs.toFixed(0)}–${toMs.toFixed(0)} ms): drift ${(slide.horizontalM * 100).toFixed(2)} cm over ${slide.frames} frames`,
        );
        expect(slide.frames, `window ${i} sampled`).toBeGreaterThan(10);
        expect(slide.horizontalM, `speed ${speed} window ${i} (${c.foot}) drift`).toBeLessThan(0.04);
      }
    });
  }
});

describe('SEAM-3 — plant release is continuous: no toe-off pop after any window, at every pace', () => {
  for (const speed of SPEEDS) {
    it(`speed ${speed}: 150 ms post-release — foot moves < 8 cm/frame and leg joints < 10°/frame (was ~20–50 cm + 17°/frame)`, () => {
      const { rec, resolved, totalMs, scale } = sampleTravel(speed);
      const frameMs = 1000 / rec.sampleHz;
      let checkedWindows = 0;
      for (const [i, c] of resolved.contacts!.entries()) {
        const toMs = c.toMs! * scale;
        // A terminal window releases with the motion's end — nothing to pop into.
        if (toMs >= totalMs - PLANT_RELEASE_BLEND_MS) continue;
        const side = c.foot.startsWith('L') ? 'L' : 'R';
        const legJoints: [string, string][] = [
          [`${side}_UpLeg`, 'hipFlexion'],
          [`${side}_Leg`, 'kneeFlexion'],
          [`${side}_Foot`, 'ankleFlexion'],
        ];
        // Start one frame BEFORE the release so the pinned→releasing boundary
        // frame pair is included, then cover the whole ramp + its hand-off to FK.
        const span = rec.frames.filter(
          (f) => f.tMs >= toMs - frameMs - 1e-3 && f.tMs <= toMs + 150 + 1e-3,
        );
        expect(span.length, `window ${i} release span sampled`).toBeGreaterThan(10);
        let maxStepM = 0;
        let maxRotDeg = 0;
        for (let k = 1; k < span.length; k += 1) {
          maxStepM = Math.max(
            maxStepM,
            dist2(span[k - 1]!.worldTracks![c.foot]!, span[k]!.worldTracks![c.foot]!),
          );
          for (const [j, m] of legJoints) {
            const a = span[k - 1]!.angles[j]?.[m];
            const b = span[k]!.angles[j]?.[m];
            if (typeof a === 'number' && typeof b === 'number') {
              maxRotDeg = Math.max(maxRotDeg, Math.abs(b - a));
            }
          }
        }
        checkedWindows += 1;
        // eslint-disable-next-line no-console
        console.log(
          `speed ${speed} release ${i} (${c.foot} @${toMs.toFixed(0)} ms): max ${(maxStepM * 100).toFixed(2)} cm/frame, ${maxRotDeg.toFixed(2)}°/frame @120 Hz`,
        );
        expect(maxStepM, `speed ${speed} release ${i} (${c.foot}) position step`).toBeLessThan(0.08);
        expect(maxRotDeg, `speed ${speed} release ${i} (${c.foot}) rotation step`).toBeLessThan(10);
      }
      // The walk has two mid-motion releases (R at the half-cycle, L into the
      // braking step) — the gate must actually have covered them.
      expect(checkedWindows, 'mid-motion releases covered').toBeGreaterThanOrEqual(2);
    });
  }
});

describe('authoredToTrajectoryTimeScale / scaleStanceWindowsMs — the one shared time-base helper', () => {
  const kfs = [
    { durationMs: 400, holdMs: 100 },
    { durationMs: 500 },
  ];

  it('is identity at timeScale 1 (trajectory total == authored total) and degenerate inputs', () => {
    expect(authoredToTrajectoryTimeScale({ keyframes: kfs }, 1000)).toBe(1);
    expect(authoredToTrajectoryTimeScale({ keyframes: [] }, 1234)).toBe(1);
    expect(authoredToTrajectoryTimeScale({ keyframes: kfs }, 0)).toBe(1);
  });

  it('maps authored → trajectory by totalMs/authoredMs, honouring reps (non-loop) and ignoring reps for loops', () => {
    // A timeScale-1.25 trajectory runs at authored/1.25 = 800 ms.
    expect(authoredToTrajectoryTimeScale({ keyframes: kfs }, 800)).toBeCloseTo(0.8, 12);
    expect(authoredToTrajectoryTimeScale({ keyframes: kfs, reps: 2 }, 1600)).toBeCloseTo(0.8, 12);
    expect(authoredToTrajectoryTimeScale({ keyframes: kfs, loop: true, reps: 2 }, 800)).toBeCloseTo(0.8, 12);
  });

  it('scales window times by the factor and carries every other field through', () => {
    const windows = [
      { foot: 'R_Foot', fromMs: 0, toMs: 500, travelLock: true },
      { foot: 'L_Foot', fromMs: 500, toMs: 1000 },
    ];
    const scaled = scaleStanceWindowsMs(windows, 0.8)!;
    expect(scaled).toEqual([
      { foot: 'R_Foot', fromMs: 0, toMs: 400, travelLock: true },
      { foot: 'L_Foot', fromMs: 400, toMs: 800 },
    ]);
    expect(scaleStanceWindowsMs(undefined, 0.8)).toBeUndefined();
    expect(scaleStanceWindowsMs([], 0.8)).toBeUndefined();
  });
});
