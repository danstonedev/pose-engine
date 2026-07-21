/**
 * SPLINE-VELOCITY-CAP GATE (SEAM-8, pipeline-diagnostics R4).
 *
 * The velocity governor caps each keyframe's AVERAGE angular velocity (delta ÷
 * duration ≤ class cap). But playback is not piecewise-linear: the trajectory is
 * a SQUAD (quaternion) spline under a C¹ time-warp, which rounds the corner
 * between knots — so the INSTANTANEOUS angular velocity between two knots can
 * ride above the segment average (the spline "carries momentum" through a
 * waypoint). A pathological knot layout (the SEAM-4 near-180° tangent blow-up)
 * could turn that benign rounding into a wild overshoot.
 *
 * This gate samples the shipped GAIT / TURN / RUN trajectories densely on the
 * rig-built spline (the raw SQUAD path BEFORE the foot-plant IK — the IK's plant
 * pops are SEAM-3's concern, not the spline's) and asserts no bone's
 * instantaneous angular velocity exceeds its keyframe's class cap by more than
 * {@link SPLINE_VEL_TOLERANCE}.
 *
 * TOLERANCE — 1.3×, documented. Measured peak on the shipped family at its
 * canonical (pace-1) construction is only ~1.10× (buildTravelWalk's stance-knee
 * at mid-swing, where SQUAD rounds the velocity peak); the run and turn sit far
 * below their higher class caps (~0.55× / ~0.81×). 1.3× keeps ~20% headroom over
 * that benign corner-rounding while still catching a real overshoot — a
 * synthetic reversal zig-zag measures ~1.5× and is caught (counterfactual
 * below). The overshoot is benign, so nothing is damped; only the tolerance is
 * set. PACE: measured at pace 1 — paceGait's cadence (`timeScale`) rescales the
 * whole trajectory AFTER the governor floors on the authored clock, so a paced
 * gait's average intentionally rides above the deliberate cap (a documented
 * paceGait property, not spline overshoot); the canonical trajectory isolates
 * the spline's own contribution.
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
import {
  resolveComposedMotion,
  buildSequencePoses,
  VELOCITY_CLASS_CAPS,
  type ComposedMotion,
} from '../services/motionSequence';
import { buildComposedTrajectory, buildLoopTrajectory } from '../services/motionRecording';
import {
  buildTravelWalk,
  buildTravelRun,
  buildRun,
  buildTurnInPlace,
  MOVEMENT_TEMPLATES,
  templateToComposedMotion,
} from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

/** Instantaneous / class-cap ratio the spline may reach (documented above). */
const SPLINE_VEL_TOLERANCE = 1.3;
/** Dense sample step, ms, on the raw spline. */
const SAMPLE_DT_MS = 2;
/** Half-window (ms) either side of a keyframe boundary within which the LOOSER
 *  of the adjacent class caps applies — so a velocity-class transition (run's
 *  ballistic↔functional) is never flagged by boundary mis-binning. */
const BOUNDARY_BOUND_MS = 25;

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

type Q = [number, number, number, number];
/** Geodesic angle (deg) between two unit quaternions (double-cover aware). */
const geoDeg = (a: Q, b: Q): number => {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return (2 * Math.acos(dot) * 180) / Math.PI;
};

interface Peak {
  ratio: number;
  bone: string;
  tMs: number;
  velDegS: number;
  capDegS: number;
}

/** Densely sample the RAW spline of a motion and return the worst
 *  instantaneous-velocity / class-cap ratio over every bone. */
function peakSplineRatio(motion: ComposedMotion): Peak {
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status).toBe('ok');
  const ts = Math.min(1.5, Math.max(0.4, resolved.modifiers?.timeScale ?? 1));
  const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest, {
    currentPose: null,
    currentRoot: null,
  });
  const traj =
    resolved.loop === true
      ? buildLoopTrajectory(built, { timeScale: ts }).trajectory
      : buildComposedTrajectory(built, {
          startPose: baselinePose,
          startQuat: [0, 0, 0, 1],
          startTranslate: [0, 0, 0],
          timeScale: ts,
          reps: resolved.reps,
          cyclicEnds: resolved.footDrivenTravel === true && resolved.settleEnds !== true,
          flowIn: resolved.flowIn === true,
        }).trajectory;
  // Keyframe arrival times (trajectory ms) + each keyframe's class cap.
  const arrive: number[] = [];
  const caps: number[] = [];
  let cur = 0;
  for (const kf of resolved.keyframes) {
    cur += (kf.durationMs + kf.holdMs) / ts;
    arrive.push(cur);
    caps.push(VELOCITY_CLASS_CAPS[kf.velocityClass ?? 'deliberate']);
  }
  const maxCap = Math.max(...caps);
  const capAt = (t: number): number => {
    let c = 0;
    for (let k = 0; k < arrive.length; k += 1) {
      const lo = (k === 0 ? 0 : arrive[k - 1]!) - BOUNDARY_BOUND_MS;
      const hi = arrive[k]! + BOUNDARY_BOUND_MS;
      if (t >= lo && t <= hi) c = Math.max(c, caps[k]!);
    }
    return c || maxCap;
  };
  const total = traj.totalMs;
  let worst: Peak = { ratio: 0, bone: '', tMs: 0, velDegS: 0, capDegS: maxCap };
  for (let t = 0; t + SAMPLE_DT_MS <= total + 1e-6; t += SAMPLE_DT_MS) {
    const p0 = traj.sampleAt(t).pose.bones;
    const p1 = traj.sampleAt(t + SAMPLE_DT_MS).pose.bones;
    const cap = capAt(t + SAMPLE_DT_MS / 2);
    for (const bone of Object.keys(p1)) {
      const a = p0[bone];
      const b = p1[bone];
      if (!a || !b) continue;
      const velDegS = geoDeg(a, b) / (SAMPLE_DT_MS / 1000);
      const ratio = velDegS / cap;
      if (ratio > worst.ratio) worst = { ratio, bone, tMs: t, velDegS, capDegS: cap };
    }
  }
  return worst;
}

/** The shipped gait/turn/run trajectories (canonical, pace-1 construction). */
function shippedLocomotion(): { label: string; motion: ComposedMotion }[] {
  const walk = MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!;
  return [
    { label: 'walk template (in-place loop)', motion: templateToComposedMotion(walk) },
    { label: 'buildTravelWalk', motion: buildTravelWalk() },
    { label: 'buildTravelWalk(turn90)', motion: buildTravelWalk({ turnDeg: 90 }) },
    { label: 'buildTurnInPlace(180)', motion: buildTurnInPlace() },
    { label: 'buildTurnInPlace(90)', motion: buildTurnInPlace({ degrees: 90 }) },
    { label: 'buildRun (loop)', motion: buildRun() },
    { label: 'buildTravelRun', motion: buildTravelRun() },
  ];
}

describe('spline-velocity-cap gate — the SQUAD path never wildly overshoots the class cap (SEAM-8)', () => {
  it(`every shipped gait/turn/run bone stays ≤ ${SPLINE_VEL_TOLERANCE}× its class cap`, () => {
    const rows: string[] = [];
    const violators: string[] = [];
    for (const { label, motion } of shippedLocomotion()) {
      const p = peakSplineRatio(motion);
      rows.push(`${label}: peak ${p.ratio.toFixed(3)}× (${p.bone} ${p.velDegS.toFixed(0)}°/s vs cap ${p.capDegS})`);
      if (p.ratio > SPLINE_VEL_TOLERANCE) violators.push(rows[rows.length - 1]!);
    }
    // eslint-disable-next-line no-console
    console.log('SEAM-8 spline peaks:\n' + rows.join('\n'));
    expect(violators, `spline overshoot > ${SPLINE_VEL_TOLERANCE}×:\n${violators.join('\n')}`).toEqual([]);
  });

  it('COUNTERFACTUAL — the same measurement CATCHES a genuinely overshooting spline', () => {
    // A reversal zig-zag: each 55° arm swing reverses at the next knot; SQUAD
    // rounds every corner and carries momentum THROUGH it, so the instantaneous
    // velocity rides ~1.5× the deliberate cap mid-segment — a real overshoot the
    // shipped gaits (≤ 1.1×) never reach. The wrist target opts the plan out of
    // the relaxedHands background adds. Proves the gate is not vacuous.
    const zz = (deg: number, durationMs: number) => ({
      durationMs,
      targets: [
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: deg },
        { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 5 },
      ],
    });
    const zigzag: ComposedMotion = {
      name: 'counterfactual reversal zig-zag',
      keyframes: [zz(0, 300), zz(55, 250), zz(0, 250), zz(55, 250), zz(0, 300)],
    };
    const p = peakSplineRatio(zigzag);
    expect(p.ratio, `zig-zag peak ${p.ratio.toFixed(3)}×`).toBeGreaterThan(SPLINE_VEL_TOLERANCE);
  });
});
