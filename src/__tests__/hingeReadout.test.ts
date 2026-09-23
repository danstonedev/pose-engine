/**
 * THE HINGE READOUT IS ONE SIGNED ANGLE, CONTINUOUS THROUGH STRAIGHT.
 *
 * elbowFlexion / kneeFlexion used to be the unsigned 3D angle between the
 * parent and child directions, signed by the child's rotation AWAY FROM REST.
 * Rest is not straight on these rigs — the male elbow rests 0.88° flexed, the
 * female 1.41°, the knees 0.82° and 0.23° — so the size was measured from
 * straight and the sign from rest, and the reading flipped as a limb left rest:
 *   • the male elbow read −0.888° at rest (true +0.883°), outside its own
 *     0..150° ROM range, so the ROM panel classified it 'outside';
 *   • the first flexion jumped it to +0.89° — DDx's chair stand read
 *     −0.888 → +0.958 in one 120 Hz frame while the forearm turned 0.07°;
 *   • a knee straightened 0.5° from rest (still 0.33° flexed) read −0.33°;
 *     DDx's walk right knee read +0.826 → −0.821 for 0.005° of motion;
 *   • a varus/valgus tilt read as flexion;
 *   • a turned body took its sign from a rest turned with it, whose world
 *     frame no longer names body-left — the rig's heading-90 walk read its
 *     right knee's 60.9° peak as −60.9°, and a body lying supine or prone
 *     read every left knee flexion negative.
 * The readout is now the signed angle in the hinge plane, about the hinge axis
 * as the PARENT carries it (jointAngles.hingeFlexionDeg), and the stage's knee
 * cap reads that same number (measureHingeFlexion) instead of its own unsigned
 * segment angle.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey, serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  measureHingeFlexion,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { clampBoneToRom } from '../services/poseRomClamp';
import { rootOrientQuat, rotateRestReferenceByPelvis, rotateRestReferenceByRoot } from '../services/rootMotion';
import { classifyRomValue, getRomFieldDefinition } from '../services/romRegistry';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { buildSitDown } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const RAD = Math.PI / 180;
const HINGES = [
  ['L_Forearm', 'elbowFlexion', 'elbowDeviation'],
  ['R_Forearm', 'elbowFlexion', 'elbowDeviation'],
  ['L_Leg', 'kneeFlexion', 'kneeDeviation'],
  ['R_Leg', 'kneeFlexion', 'kneeDeviation'],
] as const;
/** The rest bend of each hinge, measured in its plane on the rig (deg). */
const REST_BEND: Record<'male' | 'female', Record<string, number>> = {
  male: { L_Forearm: 0.883, R_Forearm: 0.883, L_Leg: 0.825, R_Leg: 0.825 },
  female: { L_Forearm: 1.414, R_Forearm: 1.414, L_Leg: 0.229, R_Leg: 0.229 },
};

interface Rig {
  variant: 'male' | 'female';
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  rest: JointAngleRestReference;
  bones: Map<string, THREE.Bone>;
  restLocal: Map<string, THREE.Quaternion>;
  baselinePose: CustomPose;
}
const rigs: Rig[] = [];

beforeAll(async () => {
  for (const variant of ['male', 'female'] as const) {
    const variantCfg = BODY_VARIANTS[variant];
    const buf = readFileSync(
      fileURLToPath(new URL(`../../models/painmap3D_${variant}.runtime.glb`, import.meta.url)),
    );
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
      const l = new GLTFLoader();
      l.setMeshoptDecoder(MeshoptDecoder);
      l.parse(ab, '', res as never, rej);
    });
    const root = gltf.scene;
    root.scale.setScalar(variantCfg.pose.rootScale);
    let skinned: THREE.SkinnedMesh | null = null;
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
    });
    root.updateMatrixWorld(true);
    applyAnatomicPose(root, variantCfg);
    root.updateMatrixWorld(true);
    const rest = captureJointAngleRestReference(skinned!.skeleton, variantCfg);
    const bones = buildBoneByPoseKey(skinned!.skeleton, variantCfg);
    const restLocal = new Map<string, THREE.Quaternion>();
    for (const b of skinned!.skeleton.bones) restLocal.set(b.name, b.quaternion.clone());
    const baselinePose = serializeCustomPose(skinned!.skeleton, variantCfg, variant);
    rigs.push({ variant, root, skinned: skinned!, rest, bones, restLocal, baselinePose });
  }
});

function toRest(rig: Rig): void {
  for (const b of rig.skinned.skeleton.bones) b.quaternion.copy(rig.restLocal.get(b.name)!);
  rig.root.updateMatrixWorld(true);
}
/** Rest × a rotation about the hinge bone's own local axis — the construction
 *  movementCommand uses for a hinge command (local +X flexes the elbow and, the
 *  other way, the knee; +Y twists the forearm; +Z tilts it out of plane). */
function setHinge(rig: Rig, key: string, axis: THREE.Vector3, deg: number): void {
  const bone = rig.bones.get(key)!;
  bone.quaternion.copy(rig.restLocal.get(bone.name)!).multiply(new THREE.Quaternion().setFromAxisAngle(axis, deg * RAD));
  rig.root.updateMatrixWorld(true);
}
const angles = (rig: Rig) => computeJointAngles(rig.skinned.skeleton, BODY_VARIANTS[rig.variant], rig.variant, rig.rest).joints;
/** Commanded flexion (deg) → the local-X rotation that produces it (the knee
 *  flexes the other way about its local X — movementCommand negates it too). */
const flexAxisDeg = (key: string, flexDeg: number) => (key.endsWith('Leg') ? -flexDeg : flexDeg);
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

describe('the hinge readout at rest', () => {
  it('reads each hinge’s own small bend, as flexion, inside its ROM range — and the clamp leaves rest alone', () => {
    for (const rig of rigs) {
      toRest(rig);
      const a = angles(rig);
      for (const [key, field] of HINGES) {
        const value = a[key]![field]!;
        // 2504a7e: male elbows −0.888, female −1.416 (the knees happened to be right).
        expect(value, `${rig.variant} ${key}.${field} at rest`).toBeCloseTo(REST_BEND[rig.variant][key]!, 2);
        const def = getRomFieldDefinition(key, field)!;
        expect(classifyRomValue(value, def).status, `${rig.variant} ${key}.${field} = ${value.toFixed(3)} on the ROM panel`).not.toBe('outside');
        expect(clampBoneToRom(rig.bones.get(key)!, key, rig.rest), `${rig.variant} ${key}: the clamp does not move the rest pose`).toBe(false);
      }
    }
  });
});

describe('the hinge readout through straight', () => {
  it('reads the rest bend plus the commanded flexion, one-for-one, from 3° of extension to 3° of flexion', () => {
    // The old reading stepped by twice the rest bend where the command crossed
    // rest (male elbow −0.888° at 0°, +1.386° at +0.5°; 1.77° off at worst) and
    // read a knee 0.33° flexed as −0.33°.
    for (const rig of rigs) {
      for (const [key, field] of HINGES) {
        let worst = 0;
        let at = 0;
        for (let deg = -3; deg <= 3 + 1e-9; deg += 0.05) {
          toRest(rig);
          setHinge(rig, key, X, flexAxisDeg(key, deg));
          const off = Math.abs(angles(rig)[key]![field]! - (REST_BEND[rig.variant][key]! + deg));
          if (off > worst) [worst, at] = [off, deg];
        }
        expect(worst, `${rig.variant} ${key}.${field}: worst |reading − (rest bend + command)|, at ${at.toFixed(2)}°`).toBeLessThan(0.005);
      }
    }
  });

  it('the first flexion out of rest moves the reading by that much, not by twice the rest bend', () => {
    for (const rig of rigs) {
      for (const [key, field] of HINGES) {
        toRest(rig);
        const before = angles(rig)[key]![field]!;
        setHinge(rig, key, X, flexAxisDeg(key, 0.07));
        const after = angles(rig)[key]![field]!;
        // 2504a7e, male elbow: −0.888 → +0.958 for this 0.07°.
        expect(after - before, `${rig.variant} ${key}.${field}: ${before.toFixed(3)} → ${after.toFixed(3)}`).toBeCloseTo(0.07, 3);
      }
    }
  });

  it('a varus/valgus tilt reads as deviation, not as flexion', () => {
    for (const rig of rigs) {
      for (const [key, field, deviation] of HINGES) {
        toRest(rig);
        setHinge(rig, key, Z, 5);
        const a = angles(rig)[key]!;
        // 2504a7e: the unsigned 3D angle took the tilt (male elbow −4.98°).
        expect(a[field], `${rig.variant} ${key}.${field} under a 5° frontal tilt`).toBeCloseTo(REST_BEND[rig.variant][key]!, 1);
        expect(Math.abs(a[deviation]!), `${rig.variant} ${key}.${deviation}`).toBeCloseTo(5, 1);
      }
    }
  });

  it('pronation leaves elbow flexion alone: the axis rides the upper arm, not the forearm', () => {
    for (const rig of rigs) {
      for (const key of ['L_Forearm', 'R_Forearm']) {
        for (const twist of [-40, 40]) {
          toRest(rig);
          const bone = rig.bones.get(key)!;
          bone.quaternion
            .copy(rig.restLocal.get(bone.name)!)
            .multiply(new THREE.Quaternion().setFromAxisAngle(X, 30 * RAD))
            .multiply(new THREE.Quaternion().setFromAxisAngle(Y, twist * RAD));
          rig.root.updateMatrixWorld(true);
          expect(angles(rig)[key]!.elbowFlexion, `${rig.variant} ${key} at 30° with ${twist}° of twist`).toBeCloseTo(
            REST_BEND[rig.variant][key]! + 30,
            2,
          );
        }
      }
    }
  });
});

describe('the hinge readout on a turned body', () => {
  it('reads the same flexion whichever way the body faces or lies', () => {
    // A walk, a turn or a body laid on a plinth measures against a rest turned
    // with the root, as the sampler and the stage do (rotateRestReferenceByRoot,
    // then ByPelvis), whose world quats no longer name body-left. 2504a7e signed
    // the hinges from them: the male elbow flexed 30° at 45° of heading read
    // −30.88°, the rig's heading-90 walk read its right knee's 60.9° peak as
    // −60.9°, and a host's supine and prone bodies read every left knee flexion
    // negative. Picking the plane from them as well — the rotated copies
    // dropping `hingeAxes` — read that elbow 0.10°.
    const turns: [string, THREE.Quaternion][] = [
      ...[45, 90, 180, -90].map((yawDeg): [string, THREE.Quaternion] => [`${yawDeg}° of heading`, rootOrientQuat({ yawDeg })]),
      ['supine', rootOrientQuat({ pitchDeg: -90, yawDeg: 55 })],
      ['prone', rootOrientQuat({ pitchDeg: 90, yawDeg: 235 })],
      ['lying on the left side', rootOrientQuat({ rollDeg: -90, yawDeg: 20 })],
      ['lying on the right side', rootOrientQuat({ rollDeg: 90, yawDeg: -20 })],
    ];
    for (const rig of rigs) {
      const variantCfg = BODY_VARIANTS[rig.variant];
      const rootRest = rig.root.quaternion.clone();
      for (const [label, turn] of turns) {
        for (const [key, field] of HINGES) {
          const deg = key.endsWith('Leg') ? 60 : 30;
          toRest(rig);
          rig.root.quaternion.copy(turn).multiply(rootRest);
          setHinge(rig, key, X, flexAxisDeg(key, deg));
          const rest = rotateRestReferenceByPelvis(rotateRestReferenceByRoot(rig.rest, turn), rig.skinned.skeleton, variantCfg);
          const value = computeJointAngles(rig.skinned.skeleton, variantCfg, rig.variant, rest).joints[key]![field]!;
          expect(value, `${rig.variant} ${key}.${field} flexed ${deg}°, ${label}`).toBeCloseTo(REST_BEND[rig.variant][key]! + deg, 2);
        }
      }
      rig.root.quaternion.copy(rootRest);
      toRest(rig);
    }
  });
});

describe('one hinge, measured alone', () => {
  it('measureHingeFlexion is the readout’s own number, and the stage’s knee cap reads it', () => {
    for (const rig of rigs) {
      for (const [key, field] of HINGES) {
        const parent = rig.bones.get(key.endsWith('Leg') ? `${key[0]}_UpLeg` : `${key[0]}_UpperArm`)!;
        for (const [axis, deg] of [[X, 40], [X, -10], [Z, 5], [Y, 30]] as const) {
          toRest(rig);
          setHinge(rig, key, axis, deg);
          expect(measureHingeFlexion(parent, rig.bones.get(key)!, key, rig.rest)).toBe(angles(rig)[key]![field]);
        }
      }
      expect(measureHingeFlexion(rig.bones.get('L_Leg')!, rig.bones.get('L_Foot')!, 'L_Foot', rig.rest)).toBeNull();
    }
    // The L2 knee cap (named clips) compares a knee to a flexion max. It used
    // its own unsigned thigh↔calf angle, which read this knee, hyperextended to
    // −9.18°, as +9.18°, and one reading 10.83° with the knee's full 5° of
    // varus as 11.93° (male rig).
    const knee = rigs.find((r) => r.variant === 'male')!;
    toRest(knee);
    setHinge(knee, 'L_Leg', X, flexAxisDeg('L_Leg', -10));
    expect(measureHingeFlexion(knee.bones.get('L_UpLeg')!, knee.bones.get('L_Leg')!, 'L_Leg', knee.rest)).toBeCloseTo(
      REST_BEND.male.L_Leg! - 10,
      2,
    );
    const stage = readFileSync(fileURLToPath(new URL('../ExamStage3D.svelte', import.meta.url)), 'utf8');
    expect(stage).toContain('const F0 = measureHingeFlexion(leg.hipBone, leg.kneeBone, leg.kneeKey, restRef);');
    expect(stage).not.toMatch(/Math\.acos\(Math\.max\(-1, Math\.min\(1, _capThighDir/);
  });
});

describe('the hinge readout on a recorded motion', () => {
  it('arms folding over a sit-down from rest: the elbow reading moves no faster than the forearm turns', () => {
    // The DDx chair stand's shape (arms folded on every keyframe, from rest),
    // sampled as a host records it. 2504a7e: the reading stepped 1.78° more
    // than the forearm turned, in one 120 Hz frame at 83 ms (5c1c9ac: 175 ms).
    const rig = rigs.find((r) => r.variant === 'male')!;
    toRest(rig);
    const folded: ComposedMotion = {
      ...buildSitDown(),
      keyframes: buildSitDown().keyframes.map((kf) => ({
        ...kf,
        targets: [
          ...(kf.targets ?? []),
          ...(['L', 'R'] as const).flatMap((side) => [
            { joint: `${side}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: 25 },
            { joint: `${side}_UpperArm`, motion: 'shoulderRotation', targetDegrees: 45 },
            { joint: `${side}_Forearm`, motion: 'elbowFlexion', targetDegrees: 110 },
          ]),
        ],
      })),
    };
    const resolved = resolveComposedMotion(folded, BODY_VARIANTS.male);
    expect(resolved.status).toBe('ok');
    const rec = sampleComposedMotion(resolved, {
      baselinePose: rig.baselinePose,
      variantCfg: BODY_VARIANTS.male,
      rest: rig.rest,
      skeletonHarness: { root: rig.root, skinned: rig.skinned },
      sampleHz: 120,
    });
    const geoDeg = (a: number[], b: number[]) =>
      (2 * Math.acos(Math.min(1, Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!))) * 180) / Math.PI;
    for (const key of ['L_Forearm', 'R_Forearm']) {
      let worst = 0;
      let at = 0;
      for (let i = 1; i < rec.frames.length && rec.frames[i]!.tMs <= 400; i += 1) {
        const [a, b] = [rec.frames[i - 1]!, rec.frames[i]!];
        const moved = Math.abs(b.angles[key]!.elbowFlexion! - a.angles[key]!.elbowFlexion!);
        const turned = geoDeg(a.pose.bones[key]!, b.pose.bones[key]!);
        if (moved - turned > worst) [worst, at] = [moved - turned, b.tMs];
      }
      expect(worst, `${key}: reading change beyond the forearm's own turn, worst at ${at.toFixed(1)} ms`).toBeLessThan(0.05);
    }
  });
});
