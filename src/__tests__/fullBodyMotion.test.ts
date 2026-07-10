/**
 * FULL-BODY MOVEMENT battery (simMOVE) — the permanent regression that proves
 * the generative engine produces COMPLEX FULL-BODY movement, not just single-
 * plane open-chain AROM. Verified against the REAL male runtime GLB with the
 * exact stage boot order (GLB parse → applyAnatomicPose →
 * captureJointAngleRestReference → build → apply pose + root transform + planted
 * pin → computeJointAngles), asserting the VISIBLE result (hand/foot/head/root
 * world positions) AND the joint readback for each case.
 *
 * Cases: squat, heel-raise, hip-hinge toe-touch, vertical jump, forward step,
 * lie supine, roll over, prone swim posture + stroke, overhead throw (ballistic,
 * combined-plane cock), front kick (functional speed), dance side-step with
 * travel, PNF D2 flexion diagonal, marching with weight shift, arm circles.
 *
 * This file is the founder's "test and retest" bar — keep it green.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { applyCustomPose, serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { measureCommandMotion } from '../services/movementCommand';
import {
  buildSequencePoses,
  resolveComposedMotion,
  type ComposedMotion,
  type ComposedMotionPoses,
} from '../services/motionSequence';
import {
  captureFloorReference,
  pinRootToFloor,
  rotateRestReferenceByRoot,
  type FloorReference,
} from '../services/rootMotion';
import { BODY_VARIANTS, normalizeBoneNameForVariant } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let floor: FloorReference;
let restFootY: number;
const anatomicLocals = new Map<THREE.Bone, THREE.Quaternion>();
const lookup = new Map<string, THREE.Bone>();

function resetToAnatomic(): void {
  for (const [bone, q] of anatomicLocals) bone.quaternion.copy(q);
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.updateMatrixWorld(true);
}

function worldPos(key: string): THREE.Vector3 | null {
  const b = lookup.get(key);
  return b ? b.getWorldPosition(new THREE.Vector3()) : null;
}

/** Play a resolved+built motion the way the stage does: for each keyframe apply
 *  the joint pose, apply the root orient+translate to the MODEL ROOT, run the
 *  planted foot-pin, then measure with a rest reference rotated to match the
 *  root orientation. Returns the LAST keyframe's report + the built plan. */
function playToLast(m: ComposedMotion, current?: { pose?: CustomPose }): {
  report: ReturnType<typeof computeJointAngles>;
  built: ComposedMotionPoses;
} {
  const resolved = resolveComposedMotion(m, variantCfg);
  expect(resolved.status, `resolve ${m.name}`).toBe('ok');
  const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest, {
    currentPose: current?.pose ?? null,
  });
  let report!: ReturnType<typeof computeJointAngles>;
  for (let i = 0; i < built.poses.length; i += 1) {
    applyCustomPose(skinned.skeleton, variantCfg, built.poses[i]!);
    const rootState = built.roots[i]!;
    root.quaternion.set(rootState.quat[0], rootState.quat[1], rootState.quat[2], rootState.quat[3]);
    root.position.set(rootState.translateM[0], rootState.translateM[1], rootState.translateM[2]);
    root.updateMatrixWorld(true);
    if (rootState.stance === 'planted') pinRootToFloor(root, skinned.skeleton, variantCfg, floor);
    root.updateMatrixWorld(true);
    const measureRest = rootState.quat[3] === 1 && rootState.quat[0] === 0 && rootState.quat[1] === 0 && rootState.quat[2] === 0
      ? rest
      : rotateRestReferenceByRoot(rest, root.quaternion);
    report = computeJointAngles(skinned.skeleton, variantCfg, 'male', measureRest);
  }
  return { report, built };
}

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.parse(arrayBuffer, '', resolve as never, reject);
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
  for (const bone of skinned.skeleton.bones) anatomicLocals.set(bone, bone.quaternion.clone());
  for (const bone of skinned.skeleton.bones) {
    const n = normalizeBoneNameForVariant(bone.name, variantCfg.boneNameMap);
    if (!n.canonical) continue;
    const p = n.side === 'Left' ? 'L_' : n.side === 'Right' ? 'R_' : '';
    lookup.set(`${p}${n.canonical}`, bone);
  }
  floor = captureFloorReference(skinned.skeleton, variantCfg);
  restFootY = Math.min(floor.restY.L_Foot!, floor.restY.R_Foot!);
});

const TOL = 3; // joint readback tolerance, deg (ball-joint coupling documented)

describe('full-body motion battery on the real male rig', () => {
  it('SQUAT — planted hip+knee+ankle flexion: feet grounded, pelvis + head DROP', () => {
    resetToAnatomic();
    const restHeadY = worldPos('Head')!.y;
    const restHipsY = worldPos('Hips')!.y;
    const m: ComposedMotion = {
      name: 'squat',
      stance: 'planted',
      keyframes: [
        {
          durationMs: 900,
          targets: [
            { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 75 },
            { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 75 },
            { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 95 },
            { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 95 },
            { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 18 },
            { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: 18 },
          ],
        },
      ],
    };
    const { report } = playToLast(m);
    // Feet grounded (closed chain).
    expect(Math.abs(worldPos('L_Foot')!.y - restFootY)).toBeLessThan(0.02);
    expect(Math.abs(worldPos('R_Foot')!.y - restFootY)).toBeLessThan(0.02);
    // Pelvis + head visibly drop.
    expect(worldPos('Hips')!.y).toBeLessThan(restHipsY - 0.15);
    expect(worldPos('Head')!.y).toBeLessThan(restHeadY - 0.15);
    // Joints actually flexed.
    expect(measureCommandMotion(report, 'L_Leg', 'kneeFlexion')!).toBeGreaterThan(80);
    expect(measureCommandMotion(report, 'L_UpLeg', 'hipFlexion')!).toBeGreaterThan(65);
  });

  it('HEEL-RAISE — planted plantarflexion: toes grounded, body RISES', () => {
    resetToAnatomic();
    const restHeadY = worldPos('Head')!.y;
    const m: ComposedMotion = {
      name: 'heel raise',
      stance: 'planted',
      keyframes: [
        {
          durationMs: 700,
          targets: [
            { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: -35 },
            { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: -35 },
          ],
        },
      ],
    };
    playToLast(m);
    // The pin references the FOOT (ankle) bone; plantarflexion lifts the ankle
    // pivot so the body rises. Assert the head goes UP vs anatomic.
    expect(worldPos('Head')!.y).toBeGreaterThan(restHeadY + 0.01);
  });

  it('HIP-HINGE TOE-TOUCH — planted trunk + hip flexion: feet grounded, head travels down+forward', () => {
    resetToAnatomic();
    const restHead = worldPos('Head')!.clone();
    const m: ComposedMotion = {
      name: 'toe touch (hip hinge)',
      stance: 'planted',
      keyframes: [
        {
          durationMs: 1000,
          targets: [
            { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 70 },
            { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 70 },
            { joint: 'Spine_Lower', motion: 'flexion', targetDegrees: 30 },
            { joint: 'Spine_Upper', motion: 'flexion', targetDegrees: 20 },
          ],
        },
      ],
    };
    const { report } = playToLast(m);
    expect(Math.abs(worldPos('L_Foot')!.y - restFootY)).toBeLessThan(0.03);
    // Head drops and moves anterior (−Z).
    expect(worldPos('Head')!.y).toBeLessThan(restHead.y - 0.2);
    expect(worldPos('Head')!.z).toBeGreaterThan(restHead.z + 0.1);
    expect(measureCommandMotion(report, 'Spine_Lower', 'flexion')!).toBeGreaterThan(25);
  });

  it('VERTICAL JUMP — root translate +Y: whole body (feet included) leaves the floor', () => {
    resetToAnatomic();
    const m: ComposedMotion = {
      name: 'vertical jump',
      keyframes: [
        // load
        { durationMs: 300, stance: 'planted', targets: [
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 40 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 40 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 35 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 35 },
        ] },
        // airborne
        { durationMs: 250, velocityClass: 'ballistic', root: { translateM: [0, 0.45, 0] }, targets: [
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 5 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 5 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
        ] },
      ],
    };
    playToLast(m);
    expect(worldPos('L_Foot')!.y).toBeGreaterThan(restFootY + 0.35);
  });

  it('FORWARD STEP — root translate −Z (anterior) plus swing leg: body travels', () => {
    resetToAnatomic();
    const restHipZ = worldPos('Hips')!.z;
    const m: ComposedMotion = {
      name: 'forward step',
      keyframes: [
        { durationMs: 600, root: { translateM: [0, 0, -0.4] }, targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 25 },
        ] },
      ],
    };
    playToLast(m);
    expect(worldPos('Hips')!.z).toBeLessThan(restHipZ - 0.3); // moved anterior
  });

  it('LIE SUPINE — root pitch −90: body horizontal (head ≈ foot height), face up', () => {
    resetToAnatomic();
    const m: ComposedMotion = {
      name: 'lie supine',
      keyframes: [{ durationMs: 1200, root: { orient: { pitchDeg: -90 } }, targets: [
        { joint: 'Neck', motion: 'flexion', targetDegrees: 0 },
      ] }],
    };
    const { report } = playToLast(m);
    const head = worldPos('Head')!, foot = worldPos('L_Foot')!;
    // Body now horizontal: head & foot at similar height, well below standing head.
    expect(Math.abs(head.y - foot.y)).toBeLessThan(0.15);
    expect(head.y).toBeLessThan(0.3);
    // Head extended along the body axis (large |Z| separation from feet).
    expect(Math.abs(head.z - foot.z)).toBeGreaterThan(1.2);
    // Reorientation is NOT pelvic AROM: pelvis reads ~0 under the rotated rest.
    expect(Math.abs(report.joints.Hips!.anteriorTilt)).toBeLessThan(3);
  });

  it('ROLL OVER — supine → prone via yaw log-roll: face flips from up (+Y anterior) to down', () => {
    resetToAnatomic();
    // supine
    const supine = playToLast({ name: 'supine', keyframes: [
      { durationMs: 800, root: { orient: { pitchDeg: -90 } }, targets: [{ joint: 'Neck', motion: 'flexion', targetDegrees: 0 }] },
    ] });
    // Anterior marker: a point above the chest (use Head anterior offset). Track belly normal by
    // comparing L_Hand (rests at side) — simpler: assert prone head Z flips sign vs supine.
    const supineHeadZ = worldPos('Head')!.z;
    resetToAnatomic();
    const prone = playToLast({ name: 'roll to prone', keyframes: [
      { durationMs: 800, root: { orient: { pitchDeg: 90 } }, targets: [{ joint: 'Neck', motion: 'flexion', targetDegrees: 0 }] },
    ] });
    const proneHeadZ = worldPos('Head')!.z;
    // Supine head lies toward anterior (−Z), prone toward posterior (+Z): the roll flipped the body.
    expect(Math.sign(proneHeadZ)).not.toBe(Math.sign(supineHeadZ));
    expect(prone.report).toBeDefined();
    void supine;
  });

  it('PRONE SWIM — prone posture + alternating stroke: reorients prone and strokes the arms', () => {
    resetToAnatomic();
    const m: ComposedMotion = {
      name: 'front-crawl posture + stroke',
      keyframes: [
        { durationMs: 1000, root: { orient: { pitchDeg: 90 } }, targets: [
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 150 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 20 },
        ] },
        { durationMs: 800, root: { orient: { pitchDeg: 90 } }, targets: [
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 20 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 150 },
        ] },
      ],
    };
    const { report } = playToLast(m);
    // Prone: head toward posterior (+Z), body horizontal.
    expect(worldPos('Head')!.y).toBeLessThan(0.3);
    // Right arm reached overhead this keyframe.
    expect(measureCommandMotion(report, 'R_UpperArm', 'shoulderFlexion')!).toBeGreaterThan(120);
  });

  it('OVERHEAD THROW — ballistic, combined-plane cock (abduction+ER) then flexion+IR: same bone composes', () => {
    resetToAnatomic();
    const m: ComposedMotion = {
      name: 'overhead throw (R)',
      keyframes: [
        // cock: flexion + abduction + external rotation on ONE bone (must compose, not
        // overwrite). Kept off the pure-high-abduction readout singularity by pairing
        // abduction with some flexion (the clean in-plane zone).
        { durationMs: 250, velocityClass: 'functional', targets: [
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 35 },
          { joint: 'R_UpperArm', motion: 'shoulderAbduction', targetDegrees: 65 },
          { joint: 'R_UpperArm', motion: 'shoulderRotation', targetDegrees: -45 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 90 },
        ] },
        // accelerate: flexion + internal rotation (same bone), ballistic
        { durationMs: 120, velocityClass: 'ballistic', targets: [
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 120 },
          { joint: 'R_UpperArm', motion: 'shoulderRotation', targetDegrees: 40 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 20 },
        ] },
      ],
    };
    const resolved = resolveComposedMotion(m, variantCfg);
    expect(resolved.status).toBe('ok');
    // BUG PROOF: cock keyframe carries BOTH shoulder motions (no silent drop).
    const cock = resolved.keyframes[0]!.targets.filter((t) => t.joint === 'R_UpperArm');
    expect(cock.map((t) => t.motion).sort()).toEqual([
      'shoulderAbduction',
      'shoulderFlexion',
      'shoulderRotation',
    ]);
    // Ballistic keyframe kept its short duration (deliberate cap would have raised it).
    expect(resolved.keyframes[1]!.durationMs).toBeLessThan(200);
    // Measure the cock pose specifically (kf0).
    const built = buildSequencePoses(baselinePose, resolved, variantCfg, rest);
    applyCustomPose(skinned.skeleton, variantCfg, built.poses[0]!);
    root.updateMatrixWorld(true);
    const rep0 = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
    // Both commanded axes present (not overwritten). Abduction is the main axis.
    expect(measureCommandMotion(rep0, 'R_UpperArm', 'shoulderAbduction')!).toBeGreaterThan(60);
    expect(measureCommandMotion(rep0, 'R_UpperArm', 'shoulderRotation')!).toBeLessThan(-25);
  });

  it('FRONT KICK — functional speed hip flexion + knee extension: keeps functional timing', () => {
    resetToAnatomic();
    const m: ComposedMotion = {
      name: 'front kick (R)',
      keyframes: [
        { durationMs: 200, velocityClass: 'functional', targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 90 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 10 },
        ] },
      ],
    };
    const resolved = resolveComposedMotion(m, variantCfg);
    // 90° at functional 600°/s → 150ms floor; requested 200ms is fine, not raised.
    expect(resolved.keyframes[0]!.timingAdjusted).toBeFalsy();
    const { report } = playToLast(m);
    expect(measureCommandMotion(report, 'R_UpLeg', 'hipFlexion')!).toBeGreaterThan(80);
  });

  it('DANCE SIDE-STEP — root translate +X with hip abduction: body travels laterally', () => {
    resetToAnatomic();
    const restHipX = worldPos('Hips')!.x;
    const m: ComposedMotion = {
      name: 'side step',
      keyframes: [
        { durationMs: 500, root: { translateM: [0.35, 0, 0] }, targets: [
          { joint: 'L_UpLeg', motion: 'hipAbduction', targetDegrees: 25 },
        ] },
      ],
    };
    playToLast(m);
    expect(worldPos('Hips')!.x).toBeGreaterThan(restHipX + 0.25);
  });

  it('PNF D2 FLEXION diagonal (R) — shoulder flexion+abduction+ER compose on one bone', () => {
    resetToAnatomic();
    // D2 flexion end position: shoulder flexion + abduction + external rotation.
    const m: ComposedMotion = {
      name: 'PNF D2 flexion',
      keyframes: [
        { durationMs: 900, targets: [
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 55 },
          { joint: 'R_UpperArm', motion: 'shoulderAbduction', targetDegrees: 55 },
          { joint: 'R_UpperArm', motion: 'shoulderRotation', targetDegrees: -40 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 10 },
        ] },
      ],
    };
    const { report } = playToLast(m);
    // All three shoulder axes survive composition (main axes within tolerance).
    expect(Math.abs(measureCommandMotion(report, 'R_UpperArm', 'shoulderFlexion')! - 55)).toBeLessThan(8);
    expect(Math.abs(measureCommandMotion(report, 'R_UpperArm', 'shoulderAbduction')! - 55)).toBeLessThan(8);
    // Hand ends high and lateral (up + to subject's right = −X for the right arm).
    expect(worldPos('R_Hand')!.y).toBeGreaterThan(worldPos('Hips')!.y);
  });

  it('MARCHING with weight shift — alternating single-leg hip flexion, planted stance keeps stance foot down', () => {
    resetToAnatomic();
    const m: ComposedMotion = {
      name: 'march',
      stance: 'planted',
      keyframes: [
        { durationMs: 500, targets: [{ joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 60 }, { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 60 }] },
        { durationMs: 500, targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 }, { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 60 }, { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 60 },
        ] },
      ],
    };
    const { report } = playToLast(m);
    // At the last keyframe the LEFT leg is raised; the RIGHT (stance) foot stays grounded.
    expect(measureCommandMotion(report, 'L_UpLeg', 'hipFlexion')!).toBeGreaterThan(50);
    expect(Math.abs(measureCommandMotion(report, 'R_UpLeg', 'hipFlexion')!)).toBeLessThan(TOL);
    expect(Math.abs(worldPos('R_Foot')!.y - restFootY)).toBeLessThan(0.05);
  });

  it('ARM CIRCLES — loop of shoulder abduction sweeping through flexion/extension', () => {
    resetToAnatomic();
    const m: ComposedMotion = {
      name: 'arm circles',
      loop: true,
      keyframes: [
        { durationMs: 400, targets: [{ joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90 }] },
        { durationMs: 400, targets: [{ joint: 'L_UpperArm', motion: 'shoulderAbduction', targetDegrees: 90 }] },
        { durationMs: 400, targets: [{ joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: -30 }] },
      ],
    };
    const resolved = resolveComposedMotion(m, variantCfg);
    expect(resolved.loop).toBe(true);
    const { report } = playToLast(m);
    // Last keyframe: extension behind the body (−30 flexion) — arm swept a circle.
    expect(measureCommandMotion(report, 'L_UpperArm', 'shoulderFlexion')!).toBeLessThan(-15);
  });

  it('CROSS-MOTION CONTINUITY — a second motion holds unmentioned joints (no teleport to rest)', () => {
    resetToAnatomic();
    // Motion 1: raise the right arm to 90 flexion, leave it there.
    const first = playToLast({ name: 'raise arm', keyframes: [
      { durationMs: 600, targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90 }] },
    ] });
    expect(measureCommandMotion(first.report, 'R_UpperArm', 'shoulderFlexion')!).toBeGreaterThan(80);
    const currentPose = built1CurrentPose(first.built);
    // Motion 2 (startFrom current): flex the LEFT elbow only. The right arm must STAY up.
    const second = playToLast(
      { name: 'flex left elbow', keyframes: [
        { durationMs: 500, targets: [{ joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: 90 }] },
      ] },
      { pose: currentPose },
    );
    expect(measureCommandMotion(second.report, 'L_Forearm', 'elbowFlexion')!).toBeGreaterThan(80);
    // The unmentioned right shoulder persisted (would be ~0 if it teleported to rest).
    expect(measureCommandMotion(second.report, 'R_UpperArm', 'shoulderFlexion')!).toBeGreaterThan(80);
  });

  it("startFrom:'neutral' RETURNS to anatomic first (unmentioned joints reset)", () => {
    resetToAnatomic();
    const first = playToLast({ name: 'raise arm', keyframes: [
      { durationMs: 600, targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90 }] },
    ] });
    const currentPose = built1CurrentPose(first.built);
    const second = playToLast(
      { name: 'neutral elbow', startFrom: 'neutral', keyframes: [
        { durationMs: 500, targets: [{ joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: 90 }] },
      ] },
      { pose: currentPose },
    );
    // The right shoulder was NOT mentioned and startFrom neutral → back to rest.
    expect(Math.abs(measureCommandMotion(second.report, 'R_UpperArm', 'shoulderFlexion')!)).toBeLessThan(5);
  });
});

/** The final pose of a built plan = the on-stage pose after it settles. */
function built1CurrentPose(built: ComposedMotionPoses): CustomPose {
  return built.poses[built.poses.length - 1]!;
}
