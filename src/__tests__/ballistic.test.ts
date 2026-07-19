/**
 * Gravity-true ballistic arcs. A floating (airborne) phase is a projectile: its
 * vertical must follow a CONSTANT-g parabola (not the old eased linear-lerp hang),
 * and its airtime must SCALE with apex height (t = 2√(2h/g)). This exercises both
 * the trajectory's parabola reshape and the builders' height-derived flight timing.
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
import { buildJump, ballisticFlightMs, GRAVITY_M_S2 } from '../services/movementTemplates';
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

const HZ = 120;
const sampleJump = (heightM: number) =>
  sampleComposedMotion(resolveComposedMotion(buildJump({ heightM }), variantCfg), {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: HZ,
  });

/** The pelvis (root-bone) world Y per frame — a clean proxy for the root arc:
 *  leg tuck/extend moves the feet, not the hips. */
const hipsY = (rec: ReturnType<typeof sampleComposedMotion>): number[] =>
  rec.frames.map((f) => f.worldTracks!.Hips![1]);

/** Feet clearance per frame: how high the LOWER foot is above the lowest contact. */
const lowerFootClear = (rec: ReturnType<typeof sampleComposedMotion>): number[] => {
  const l = rec.frames.map((f) => f.worldTracks!.L_Foot![1]);
  const r = rec.frames.map((f) => f.worldTracks!.R_Foot![1]);
  const floor = Math.min(...l, ...r);
  return l.map((ly, i) => Math.min(ly, r[i]!) - floor);
};

describe('buildJump — gravity-true ballistic vertical', () => {
  it('the airborne pelvis follows a constant-g parabola (constant negative 2nd difference)', () => {
    const rec = sampleJump(0.5);
    const y = hipsY(rec);
    const clear = lowerFootClear(rec);
    // Airborne window: contiguous frames where BOTH feet are clearly off the floor.
    const airborne: number[] = [];
    for (let i = 0; i < clear.length; i += 1) if (clear[i]! > 0.04) airborne.push(i);
    expect(airborne.length, 'a real flight window').toBeGreaterThan(12);
    const i0 = airborne[0]!;
    const i1 = airborne[airborne.length - 1]!;
    // Second difference of pelvis Y across the flight = vertical acceleration × dt².
    // A projectile has it CONSTANT and negative; the old linear-lerp+hang did not.
    const d2: number[] = [];
    for (let i = i0 + 1; i < i1; i += 1) d2.push(y[i + 1]! - 2 * y[i]! + y[i - 1]!);
    const mean = d2.reduce((a, b) => a + b, 0) / d2.length;
    expect(mean, 'downward acceleration (concave-down arc)').toBeLessThan(0);
    // Constancy: the spread of the 2nd difference is small vs its magnitude — i.e.
    // it's one parabola, not a lerp-up/hang/lerp-down with acceleration spikes.
    const maxDev = Math.max(...d2.map((v) => Math.abs(v - mean)));
    // eslint-disable-next-line no-console
    console.log(`jump 0.5m: flight ${airborne.length} frames, mean d²y=${mean.toExponential(2)}, maxDev/|mean|=${(maxDev / Math.abs(mean)).toFixed(2)}`);
    expect(maxDev / Math.abs(mean), 'the arc is a single constant-g parabola').toBeLessThan(0.6);

    // The implied acceleration (d²y/dt²) is in the right ballpark for gravity.
    const dt = 1 / HZ;
    const accel = Math.abs(mean) / (dt * dt);
    expect(accel, 'implied vertical acceleration ≈ g').toBeGreaterThan(0.5 * GRAVITY_M_S2);
    expect(accel, 'implied vertical acceleration ≈ g').toBeLessThan(2.0 * GRAVITY_M_S2);
  });

  it('airtime scales with apex height (a taller jump hangs longer)', () => {
    const flightFrames = (h: number): number => {
      const clear = lowerFootClear(sampleJump(h));
      return clear.filter((c) => c > 0.04).length;
    };
    const lo = flightFrames(0.25);
    const hi = flightFrames(0.6);
    expect(hi, 'taller jump is airborne longer').toBeGreaterThan(lo);
    // t ∝ √h, so t(0.6)/t(0.25) ≈ √(0.6/0.25) ≈ 1.55 — allow a generous band
    // (foot-clearance thresholding + settle add a roughly constant tare to both).
    const ratio = hi / lo;
    // eslint-disable-next-line no-console
    console.log(`airtime frames: 0.25m→${lo}, 0.6m→${hi}, ratio ${ratio.toFixed(2)} (√ratio target 1.55)`);
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(2.0);
  });

  it('ballisticFlightMs matches the projectile formula 2√(2h/g)', () => {
    for (const h of [0.1, 0.4, 0.7]) {
      const expected = Math.round(2 * Math.sqrt((2 * h) / GRAVITY_M_S2) * 1000);
      expect(ballisticFlightMs(h)).toBe(expected);
    }
    // Monotonic in height.
    expect(ballisticFlightMs(0.6)).toBeGreaterThan(ballisticFlightMs(0.2));
  });
});
