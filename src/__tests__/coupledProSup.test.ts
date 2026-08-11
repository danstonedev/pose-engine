/**
 * PRO/SUP REACHES THE RANGE THE PANEL PUBLISHES.
 *
 * Forearm rotation is the radius crossing over the ulna along the whole
 * forearm, and the hand goes with it. The registry publishes ±90 in two places
 * (`forearmRotation` on each elbow, `proSup` on each wrist) and
 * `computeJointAngles` reports ONE quantity into both, summing the forearm's
 * axial twist and the hand's.
 *
 * A gizmo that writes only the grabbed bone cannot reach that, and cannot even
 * get halfway honestly: the forearm's clamp strategy is a HINGE, whose
 * `rotationRange` is ±45 of long-axis PLAY around elbow flexion — not a pro/sup
 * range. Writing pro/sup onto the forearm alone runs into that play limit and
 * stops at 45 against a panel quoting −90..90.
 *
 * This lived inside `stagePosingLayer` since the feature was written; the other
 * host's copy of that layer never had it, so four ROM rows were capped at half
 * their published range on every model there. These tests pin the shared
 * version so neither host can lose it again.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey, readAxialTwist } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import {
  PROSUP_KEYS,
  PROSUP_SEG_LIMIT_RAD,
  applyCoupledProSup,
} from '../services/poseProSupRomClamp';
import { getRomFieldDefinition } from '../services/romRegistry';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const DEG = 180 / Math.PI;
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let byKey: Map<string, THREE.Bone>;
let anatomic: Map<THREE.Bone, THREE.Quaternion>;

beforeAll(async () => {
  const buf = readFileSync(
    fileURLToPath(new URL('../../models/painmap3D_male.runtime.glb', import.meta.url)),
  );
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
  byKey = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  anatomic = new Map();
  for (const b of skinned.skeleton.bones) anatomic.set(b, b.quaternion.clone());
});

const reset = () => {
  for (const [b, q] of anatomic) b.quaternion.copy(q);
  root.updateMatrixWorld(true);
};

/** The target a Y-ring drag of `deg` produces for `key`: its rest local twisted
 *  about the bone's own long axis, which is +Y for every bone in this rig. */
function twistTarget(key: string, deg: number): THREE.Quaternion {
  const r = rest.localQuats[key]!;
  return new THREE.Quaternion(r[0], r[1], r[2], r[3]).multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg / DEG),
  );
}

/** What the ROM panel reports for the pair, from the shared readout. */
function reported(side: 'L' | 'R') {
  root.updateMatrixWorld(true);
  const j = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest).joints;
  return {
    forearmRotation: j[`${side}_Forearm`]?.forearmRotation ?? NaN,
    proSup: j[`${side}_Hand`]?.proSup ?? NaN,
  };
}

describe('a pro/sup drag writes BOTH segments', () => {
  it('refuses any key that is not a forearm or hand, so it can gate a branch chain', () => {
    reset();
    for (const k of ['L_UpperArm', 'L_Leg', 'Spine_Lower', 'Hips', null, undefined]) {
      expect(applyCoupledProSup(k, twistTarget('L_Forearm', 30), byKey, rest), String(k)).toBe(false);
    }
    for (const k of PROSUP_KEYS) {
      expect(applyCoupledProSup(k, twistTarget(k, 30), byKey, rest), k).toBe(true);
    }
  });

  it('splits the twist across forearm AND hand, not onto one of them', () => {
    for (const side of ['L', 'R'] as const) {
      reset();
      applyCoupledProSup(`${side}_Forearm`, twistTarget(`${side}_Forearm`, 40), byKey, rest);
      root.updateMatrixWorld(true);
      const rf = rest.localQuats[`${side}_Forearm`]!;
      const rh = rest.localQuats[`${side}_Hand`]!;
      const fTwist =
        readAxialTwist(byKey.get(`${side}_Forearm`)!.quaternion, new THREE.Quaternion(rf[0], rf[1], rf[2], rf[3])) * DEG;
      const hTwist =
        readAxialTwist(byKey.get(`${side}_Hand`)!.quaternion, new THREE.Quaternion(rh[0], rh[1], rh[2], rh[3])) * DEG;
      expect(Math.abs(fTwist), `${side} forearm carries half`).toBeGreaterThan(5);
      expect(Math.abs(hTwist), `${side} hand carries half`).toBeGreaterThan(5);
      // 1:1 — the same twist on each, which is what sums to the reported total.
      expect(hTwist).toBeCloseTo(fTwist, 1);
    }
  });

  it('reaches the ±90 the registry publishes, which one segment cannot', () => {
    // THE defect this exists for. Driven onto the forearm alone, the hinge's
    // ±45 long-axis PLAY caps it at 45 against a panel quoting −90..90.
    const range = getRomFieldDefinition('L_Forearm', 'forearmRotation')!.range;
    expect(range).toEqual({ min: -90, max: 90 });
    for (const side of ['L', 'R'] as const) {
      for (const drive of [200, -200]) {
        reset();
        applyCoupledProSup(`${side}_Forearm`, twistTarget(`${side}_Forearm`, drive), byKey, rest);
        const r = reported(side);
        expect(Math.abs(r.forearmRotation), `${side} driven ${drive}° reaches the range`).toBeGreaterThan(80);
        expect(Math.abs(r.forearmRotation), `${side} stays inside it`).toBeLessThanOrEqual(91);
      }
    }
  });

  it('caps each SEGMENT at half, so neither wrings against the other', () => {
    reset();
    applyCoupledProSup('R_Forearm', twistTarget('R_Forearm', 200), byKey, rest);
    const rf = rest.localQuats.R_Forearm!;
    const seg =
      Math.abs(
        readAxialTwist(byKey.get('R_Forearm')!.quaternion, new THREE.Quaternion(rf[0], rf[1], rf[2], rf[3])),
      );
    expect(seg).toBeLessThanOrEqual(PROSUP_SEG_LIMIT_RAD + 1e-6);
    expect(PROSUP_SEG_LIMIT_RAD * DEG).toBeCloseTo(45, 6);
  });

  it('works the same grabbed from the HAND as from the forearm', () => {
    // Both are pro/sup handles; which one the user grabbed must not change the
    // result, or the same motion has two different limits.
    reset();
    applyCoupledProSup('R_Forearm', twistTarget('R_Forearm', 200), byKey, rest);
    const fromForearm = reported('R').forearmRotation;
    reset();
    applyCoupledProSup('R_Hand', twistTarget('R_Hand', 200), byKey, rest);
    const fromHand = reported('R').forearmRotation;
    expect(Math.abs(fromHand)).toBeGreaterThan(80);
    expect(Math.sign(fromHand)).toBe(Math.sign(fromForearm));
  });

  it('leaves a within-range drive where it was put', () => {
    reset();
    applyCoupledProSup('R_Forearm', twistTarget('R_Forearm', 40), byKey, rest);
    const r = reported('R');
    expect(Math.abs(r.forearmRotation)).toBeGreaterThan(20);
    expect(Math.abs(r.forearmRotation)).toBeLessThan(80);
  });
});
