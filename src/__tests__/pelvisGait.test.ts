/**
 * PELVIC KINEMATICS IN GAIT — measured on the rig, against normative bands.
 *
 * Until this file existed the engine measured HARD ZEROS on all three pelvic
 * channels through a whole walk (152 frames: 0.000000° / 0.000000° / 0.000035°)
 * while shipping a `normativeGait.PELVIC_OBLIQUITY_NORMAL_DEG` constant whose
 * own docstring admitted "the rig has NO pelvic-list DOF today… obliquity is
 * NOT yet measurable". The transverse channel was worse than absent: it was
 * FAKED as model-root yaw, which the measurement frame removes by design, so
 * the fake cancelled itself out of its own readout.
 *
 * THE SIGN OF THE OBLIQUITY IS THE POINT. Pelvic drop is CONTRALATERAL — the
 * pelvis falls on the SWING side, controlled eccentrically by the STANCE hip
 * abductors. That single sign is the entire diagnostic content of the channel:
 * get it backwards and a normal walk reads as the compensated Trendelenburg
 * pattern the measurement exists to distinguish. So it is gated by phase here,
 * not merely by amplitude.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { buildTravelWalk } from '../services/movementLocomotion';
import { PELVIC_OBLIQUITY_NORMAL_DEG } from '../services/normativeGait';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rec: MotionRecording;

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
  const resolved = resolveComposedMotion(buildTravelWalk(), variantCfg);
  expect(resolved.status).toBe('ok');
  rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 120,
  });
}, 120_000);

/** Steady window — drop the standing entry and the termination, same discipline
 *  as the walk's own spatiotemporal gate. */
const steady = () => rec.frames.slice(Math.floor(rec.frames.length * 0.25), Math.floor(rec.frames.length * 0.8));

const series = (field: string): number[] =>
  steady().map((f) => (f.angles.Hips?.[field] as number | undefined) ?? 0);

const p2p = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

describe('the walk moves its pelvis, and the movement is measurable', () => {
  it('reports NON-ZERO excursion on all three planes — the defect this replaces', () => {
    const rows = (['anteriorTilt', 'lateralTilt', 'rotation'] as const).map((f) => {
      const s = series(f);
      return { f, p2p: p2p(s), min: Math.min(...s), max: Math.max(...s) };
    });
    for (const r of rows)
      // eslint-disable-next-line no-console
      console.log(`Hips.${r.f.padEnd(13)} p2p ${r.p2p.toFixed(2)}°  [${r.min.toFixed(2)}, ${r.max.toFixed(2)}]`);
    for (const r of rows)
      expect(r.p2p, `Hips.${r.f} actually moves`).toBeGreaterThan(0.5);
  });

  it('pelvic OBLIQUITY sits in the normative band (~4-6° peak, Trendelenburg exceeds it)', () => {
    const s = series('lateralTilt');
    const peak = Math.max(...s.map(Math.abs));
    // eslint-disable-next-line no-console
    console.log(`peak obliquity ${peak.toFixed(2)}° (normative reference ${PELVIC_OBLIQUITY_NORMAL_DEG}°)`);
    expect(peak, 'obliquity is present').toBeGreaterThan(2);
    expect(peak, 'and does not reach the Trendelenburg range').toBeLessThanOrEqual(
      PELVIC_OBLIQUITY_NORMAL_DEG + 1,
    );
  });

  it('the pelvis DROPS ON THE SWING SIDE — contralateral, which is the whole diagnostic content', () => {
    // Sign convention: lateralTilt + = toward subject-LEFT (romRegistry).
    // hipFlexion(L) > hipFlexion(R) ⇒ the LEFT limb is swinging ⇒ the pelvis
    // should drop on the LEFT ⇒ lateralTilt positive. Correlate the two series
    // rather than sampling one instant, so a lucky frame cannot pass it.
    const f = steady();
    const hipDiff = f.map(
      (fr) =>
        ((fr.angles.L_UpLeg?.hipFlexion as number) ?? 0) -
        ((fr.angles.R_UpLeg?.hipFlexion as number) ?? 0),
    );
    const obl = series('lateralTilt');
    const n = hipDiff.length;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const mh = mean(hipDiff);
    const mo = mean(obl);
    let num = 0;
    let dh = 0;
    let dobl = 0;
    for (let i = 0; i < n; i += 1) {
      num += (hipDiff[i]! - mh) * (obl[i]! - mo);
      dh += (hipDiff[i]! - mh) ** 2;
      dobl += (obl[i]! - mo) ** 2;
    }
    const r = num / Math.sqrt(dh * dobl);
    // eslint-disable-next-line no-console
    console.log(`obliquity vs swing-side correlation r = ${r.toFixed(3)} (contralateral drop ⇒ strongly positive)`);
    expect(r, 'pelvic drop is phase-locked to the SWING limb').toBeGreaterThan(0.9);
  });

  it('pelvic ROTATION is on the BONE now, not the root — and the root no longer yaws', () => {
    // The old fake wrote pelvic rotation to root.orient.yawDeg, where the
    // measurement frame removed it again. If a future change puts it back, the
    // pelvic readout goes quiet and this catches it from the other side.
    const rot = series('rotation');
    expect(p2p(rot), 'the pelvis rotates').toBeGreaterThan(2);
    const rootYaw = steady().map((f) => {
      const q = f.root.orientQuat;
      return q ? Math.abs(2 * Math.atan2(q[1], q[3]) * (180 / Math.PI)) : 0;
    });
    // eslint-disable-next-line no-console
    console.log(
      `pelvic rotation p2p ${p2p(rot).toFixed(2)}° · residual root yaw ${Math.max(...rootYaw).toFixed(2)}°`,
    );
    expect(Math.max(...rootYaw), 'a straight walk does not yaw its root').toBeLessThan(1);
  });

  it('every pelvic channel stays inside its ROM band', () => {
    for (const [f, lim] of [
      ['anteriorTilt', 30],
      ['lateralTilt', 20],
      ['rotation', 30],
    ] as const) {
      const peak = Math.max(...series(f).map(Math.abs));
      expect(peak, `Hips.${f} within ROM`).toBeLessThanOrEqual(lim);
    }
  });
});
