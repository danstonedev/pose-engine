/**
 * GAIT TEMPLATE GATE — the "walk composed as 2 keyframes" regression test.
 *
 * Field report (simMOVE): typing "walk" produced a 2-keyframe looping plan —
 * far too thin for a believable gait cycle — because locomotion had no authored
 * anchor after the clip fallback was removed. The `walk` template is the fix.
 * This gate proves, headlessly on the real rig, that the authored cycle is a
 * NON-DEGENERATE, physiologically-shaped gait — and that a thin 2-keyframe
 * "walk" sketch is REJECTED by the same validators, so the degenerate shape
 * can never again pass as a walk.
 *
 * The walk template is authored IN PLACE (treadmill convention): the looping
 * trajectory wraps `elapsed % total` over ABSOLUTE root translates, so a
 * travel-bearing looping walk would teleport backward at every seam. In-place
 * gait keeps the loop seamless; the natural-progression truth lives in the
 * joint series and the feet: the stance foot sweeps BACKWARD relative to the
 * world (the treadmill belt) while the swing foot advances FORWARD (+Z, the
 * body's facing) with clearance — the exact opposite pattern is a moonwalk.
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
import {
  MIN_KEYFRAME_MS,
  resolveComposedMotion,
  type ComposedMotion,
} from '../services/motionSequence';
import {
  exportKinematics,
  sampleComposedMotion,
  type MotionRecording,
} from '../services/motionRecording';
import { MOVEMENT_TEMPLATES, templateToComposedMotion } from '../services/movementTemplates';
import {
  buildSignatureFromExport,
  driverKeysOf,
  scoreAgainstSignature,
} from '../services/movementSignature';
import { checkCoordination, type CoordinationSourceExport } from '../services/movementCoordination';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRestPos: THREE.Vector3;
let rootRestQuat: THREE.Quaternion;

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
  rootRestPos = root.position.clone();
  rootRestQuat = root.quaternion.clone();
});

function resetToAnatomic(): void {
  applyAnatomicPose(root, variantCfg);
  root.position.copy(rootRestPos);
  root.quaternion.copy(rootRestQuat);
  root.updateMatrixWorld(true);
}

const walkTemplate = () => MOVEMENT_TEMPLATES.find((t) => t.id === 'walk')!;

function sampleMotion(motion: ComposedMotion): MotionRecording {
  resetToAnatomic();
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status).toBe('ok');
  return sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 60,
  });
}

/** The joint.motion angle series from an export, or fail loudly. */
function seriesOf(ex: ReturnType<typeof exportKinematics>, key: string): number[] {
  const s = ex.series[key];
  expect(s, `${key} present in export`).toBeDefined();
  return s!;
}

/** World position of a tracked bone at the frame nearest tMs. */
function worldAt(rec: MotionRecording, bone: string, tMs: number): [number, number, number] {
  let best = rec.frames[0]!;
  for (const f of rec.frames) if (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  const p = best.worldTracks?.[bone];
  expect(p, `${bone} tracked @${tMs}ms`).toBeDefined();
  return p!;
}

/** REPRESENTATIVE of the field-reported degenerate plan: "walk" as just two
 *  alternating swing sketches. This is the shape the gate must REJECT. */
const THIN_TWO_KEYFRAME_WALK: ComposedMotion = {
  name: 'walk',
  startFrom: 'neutral',
  stance: 'planted',
  loop: true,
  keyframes: [
    {
      durationMs: 600,
      targets: [
        { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 25 },
        { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 30 },
        { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: -5 },
        { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 15 },
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: -15 },
      ],
    },
    {
      durationMs: 600,
      targets: [
        { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 25 },
        { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 30 },
        { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: -5 },
        { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 15 },
        { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: -15 },
      ],
    },
  ],
};

describe('walk template — plan-level non-degeneracy', () => {
  it('authors a full 8-phase looping cycle commanding hips, knees, ankles and both arms', () => {
    const t = walkTemplate();
    expect(t).toBeDefined();
    expect(t.loop).toBe(true);
    expect(t.stance).toBe('planted');
    expect(t.phases.length).toBeGreaterThanOrEqual(8);

    const motion = templateToComposedMotion(t);
    expect(motion.loop).toBe(true);
    expect(motion.keyframes.length).toBeGreaterThanOrEqual(8);

    const commanded = new Set(driverKeysOf(motion));
    for (const key of [
      'R_UpLeg.hipFlexion',
      'L_UpLeg.hipFlexion',
      'R_Leg.kneeFlexion',
      'L_Leg.kneeFlexion',
      'R_Foot.ankleFlexion',
      'L_Foot.ankleFlexion',
      'R_UpperArm.shoulderFlexion',
      'L_UpperArm.shoulderFlexion',
    ]) {
      expect(commanded.has(key), `walk commands ${key}`).toBe(true);
    }
  });

  it('resolves ok at natural cadence with no velocity-governor timing adjustment', () => {
    const resolved = resolveComposedMotion(templateToComposedMotion(walkTemplate()), variantCfg);
    expect(resolved.status).toBe('ok');
    for (const kf of resolved.keyframes) {
      expect(kf.durationMs).toBeGreaterThanOrEqual(MIN_KEYFRAME_MS);
      expect(kf.timingAdjusted ?? false, 'authored cadence survives the governor').toBe(false);
    }
  });
});

describe('walk template — sampled gait kinematics on the real rig', () => {
  it('per-joint amplitudes match normal free gait (hip 30/−10, knee 5–60, ankle rockers)', () => {
    const rec = sampleMotion(templateToComposedMotion(walkTemplate()));
    const ex = exportKinematics(rec) as unknown as CoordinationSourceExport &
      ReturnType<typeof exportKinematics>;

    for (const side of ['R', 'L'] as const) {
      const hip = seriesOf(ex, `${side}_UpLeg.hipFlexion`);
      const knee = seriesOf(ex, `${side}_Leg.kneeFlexion`);
      const ankle = seriesOf(ex, `${side}_Foot.ankleFlexion`);

      // Hip: ~30° flexion at initial contact → ~−10° extension at terminal stance.
      expect(Math.max(...hip), `${side} hip peak`).toBeGreaterThan(24);
      expect(Math.max(...hip), `${side} hip peak`).toBeLessThan(38);
      expect(Math.min(...hip), `${side} hip extension trough`).toBeLessThan(-4);

      // Knee: ~60° peak flexion in initial swing, near-extension at contact —
      // the excursion the 2-keyframe sketch never had.
      expect(Math.max(...knee), `${side} knee swing peak`).toBeGreaterThan(52);
      expect(Math.max(...knee), `${side} knee swing peak`).toBeLessThan(70);
      expect(Math.max(...knee) - Math.min(...knee), `${side} knee excursion`).toBeGreaterThan(45);

      // Ankle rockers: real dorsiflexion over the stance foot AND push-off
      // plantarflexion.
      expect(Math.max(...ankle), `${side} ankle dorsiflexion`).toBeGreaterThan(3);
      expect(Math.min(...ankle), `${side} ankle push-off plantarflexion`).toBeLessThan(-9);
    }
  });

  it('cross-body coordination is reciprocal gait (arms with the contralateral leg)', () => {
    const rec = sampleMotion(templateToComposedMotion(walkTemplate()));
    const ex = exportKinematics(rec) as unknown as CoordinationSourceExport;

    const result = checkCoordination(ex, {
      name: 'walk reciprocity',
      together: [
        // Each hip peaks (initial contact) WITH the CONTRALATERAL arm's forward swing.
        { a: 'R_UpLeg.hipFlexion', b: 'L_UpperArm.shoulderFlexion', label: 'R leg with L arm' },
        { a: 'L_UpLeg.hipFlexion', b: 'R_UpperArm.shoulderFlexion', label: 'L leg with R arm' },
      ],
      apart: [
        // …and APART from the IPSILATERAL arm (which swings on the other step).
        { a: 'R_UpLeg.hipFlexion', b: 'R_UpperArm.shoulderFlexion', label: 'R leg vs R arm' },
        { a: 'L_UpLeg.hipFlexion', b: 'L_UpperArm.shoulderFlexion', label: 'L leg vs L arm' },
      ],
      ratios: [
        // Knee excursion (~55°) vs hip excursion (~40°) ≈ 1.375.
        { a: 'R_Leg.kneeFlexion', b: 'R_UpLeg.hipFlexion', ratio: 1.375 },
        { a: 'L_Leg.kneeFlexion', b: 'L_UpLeg.hipFlexion', ratio: 1.375 },
      ],
      order: [
        // Pre-swing push-off (ankle plantarflexion trough) precedes the swing
        // knee-flexion peak — the stance-to-swing hand-off, per side.
        {
          earlier: 'R_Foot.ankleFlexion',
          earlierAt: 'trough',
          later: 'R_Leg.kneeFlexion',
          laterAt: 'peak',
        },
      ],
    });
    expect(result.reasons.join('; ')).toBe('');
    expect(result.accepted).toBe(true);
  });

  it('is in place with treadmill-true foot motion: no root drift, stance sweeps back, swing advances +Z with clearance', () => {
    const rec = sampleMotion(templateToComposedMotion(walkTemplate()));

    // IN PLACE: the pelvis never drifts horizontally (no moonwalk, no creep) —
    // the loop seam is teleport-free by construction.
    const hipsStart = worldAt(rec, 'Hips', 0);
    const hipsEnd = worldAt(rec, 'Hips', rec.frames[rec.frames.length - 1]!.tMs);
    const hipsDriftXZ = Math.hypot(hipsEnd[0] - hipsStart[0], hipsEnd[2] - hipsStart[2]);
    expect(hipsDriftXZ, 'net pelvis horizontal drift').toBeLessThan(0.05);

    // RIGHT STANCE (contact settle ~200ms → terminal stance ~800ms): the stance
    // foot sweeps BACKWARD relative to the world — the treadmill belt. The
    // opposite sign (stance foot gliding forward) is the moonwalk.
    const stanceFrom = worldAt(rec, 'R_Foot', 220);
    const stanceTo = worldAt(rec, 'R_Foot', 780);
    expect(stanceTo[2] - stanceFrom[2], 'stance foot sweeps backward (−Z)').toBeLessThan(-0.1);
    // …and it stays grounded while loaded (no float): tiny vertical envelope.
    expect(Math.abs(stanceTo[1] - stanceFrom[1]), 'stance foot stays low').toBeLessThan(0.08);

    // RIGHT SWING (pre-swing ~1000ms → terminal swing ~1600ms): the foot
    // advances FORWARD (+Z, the body's facing) with real clearance.
    const swingFrom = worldAt(rec, 'R_Foot', 1020);
    const swingTo = worldAt(rec, 'R_Foot', 1580);
    expect(swingTo[2] - swingFrom[2], 'swing foot advances (+Z)').toBeGreaterThan(0.1);
    let swingPeakY = -Infinity;
    let stanceMinY = Infinity;
    for (const f of rec.frames) {
      const p = f.worldTracks?.['R_Foot'];
      if (!p) continue;
      if (f.tMs >= 1000 && f.tMs <= 1600) swingPeakY = Math.max(swingPeakY, p[1]);
      if (f.tMs >= 200 && f.tMs <= 800) stanceMinY = Math.min(stanceMinY, p[1]);
    }
    expect(swingPeakY - stanceMinY, 'swing foot clearance').toBeGreaterThan(0.05);
  });
});

describe('walk template — the 2-keyframe degenerate walk is rejected', () => {
  it('a thin 2-keyframe "walk" fails the authored gait signature (the regression can never pass again)', () => {
    const authored = templateToComposedMotion(walkTemplate());
    const authoredRec = sampleMotion(authored);
    const drivers = driverKeysOf(authored);
    const signature = buildSignatureFromExport(exportKinematics(authoredRec), {
      joints: drivers,
    });
    // The reference itself is substantial: all 10 commanded joint.motions are
    // primary movers (hips, knees, ankle rockers, shoulder swing AND the elbow
    // follow-through carry) — this also guards against a vacuous signature.
    expect(signature.primary.length).toBe(10);

    const thinRec = sampleMotion(THIN_TWO_KEYFRAME_WALK);
    const thinEx = exportKinematics(thinRec);
    const score = scoreAgainstSignature(thinEx, signature, {}, { joints: drivers });
    expect(score.accepted, `thin walk must be rejected: ${score.reasons.join('; ')}`).toBe(false);

    // The rejection is for the RIGHT reasons: the sketch never moves the ankles
    // (no rockers, no push-off) and its knees never reach swing flexion.
    const byKey = new Map(score.joints.map((j) => [j.key, j]));
    expect(byKey.get('R_Foot.ankleFlexion')?.status).toBe('missing');
    expect(byKey.get('L_Foot.ankleFlexion')?.status).toBe('missing');
    const thinKnee = seriesOf(thinEx, 'R_Leg.kneeFlexion');
    expect(Math.max(...thinKnee), 'thin walk knee never reaches swing flexion').toBeLessThan(40);

    // …and the same reciprocity critic that PASSES the authored walk fails the
    // sketch's missing ankle work.
    const thinCoord = checkCoordination(thinEx as unknown as CoordinationSourceExport, {
      order: [
        {
          earlier: 'R_Foot.ankleFlexion',
          earlierAt: 'trough',
          later: 'R_Leg.kneeFlexion',
          laterAt: 'peak',
        },
      ],
    });
    expect(thinCoord.accepted).toBe(false);
  });
});
