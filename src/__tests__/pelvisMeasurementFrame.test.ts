/**
 * THE PELVIS MEASUREMENT FRAME — the prerequisite for an independent pelvis.
 *
 * WHY THIS FILE EXISTS BEFORE ANY PELVIS MOTION DOES. The engine declares a full
 * three-plane pelvis channel set (`Hips.anteriorTilt` / `lateralTilt` /
 * `rotation`, romRegistry ±30/±20/±30) and measures HARD ZEROS on a walk: 152
 * frames, peak-to-peak 0.000000° / 0.000000° / 0.000035°. What pelvic rotation
 * the walk appears to have is faked as MODEL-ROOT yaw and then cancelled back
 * out of the readout by rotateRestReferenceByRoot, so it is invisible to the
 * clinical measurement by construction.
 *
 * Moving that motion onto the Hips BONE is not a one-line change, because the
 * engine has two families of readout and only one of them is pelvis-safe:
 *
 *   • PARENT-LOCAL readouts (hip, knee, lumbar) are measured from bone.quaternion
 *     against a parent that IS the pelvis, so they are already implicitly
 *     pelvis-relative and exactly invariant. Verified below.
 *   • WORLD-FRAME machinery (the ROM clamp, the shoulder elevation readout) has
 *     no idea the pelvis moved. A pelvis-only rotation makes an UNTOUCHED knee
 *     read 8.31° of abduction against a ±5° band, and clampBoneToRom then
 *     rewrites the shin by 5.43° — and clamping defaults ON in node/SSR, so the
 *     offline sampler and this very test suite would eat it first.
 *
 * rotateRestReferenceByRoot cannot help: it takes a ROOT quaternion, and the
 * pelvis sits below the root. So the fix is its pelvis sibling, and these are
 * the gates for it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { clampBoneToRom } from '../services/poseRomClamp';
import { rotateRestReferenceByPelvis } from '../services/rootMotion';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
const RAD = Math.PI / 180;

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let lookup: Map<string, THREE.Bone>;
let anatomic: Map<THREE.Bone, THREE.Quaternion>;

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
  lookup = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  anatomic = new Map();
  for (const b of skinned.skeleton.bones) anatomic.set(b, b.quaternion.clone());
}, 60_000);

/** Angle between two bone quaternions, in degrees, NORMALIZED first.
 *  THREE's `angleTo` is 2·acos(|dot|), so a quaternion carrying the float32
 *  round-off of its GLB storage reads ~0.02° against ITSELF — enough to make an
 *  exact "did not move" assertion look like a 0.02° drift. Measured, not
 *  assumed: a control that never called the clamp reported the same 0.02°. */
function angleDeg(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return (a.clone().normalize().angleTo(b.clone().normalize()) * 180) / Math.PI;
}

function resetToAnatomic(): void {
  for (const [b, q] of anatomic) b.quaternion.copy(q);
  root.updateMatrixWorld(true);
}

/** Rotate ONLY the pelvis (Hips bone) by the given body-frame euler, leaving
 *  every limb joint at anatomic rest. */
function tiltPelvis(xDeg: number, yDeg: number, zDeg: number): void {
  resetToAnatomic();
  const hips = lookup.get('Hips')!;
  hips.quaternion
    .copy(anatomic.get(hips)!)
    .premultiply(
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(xDeg * RAD, yDeg * RAD, zDeg * RAD, 'YXZ'),
      ),
    );
  root.updateMatrixWorld(true);
}

/** The rest reference a pelvis-aware consumer should be handed. */
function pelvisAwareRest(): JointAngleRestReference {
  return rotateRestReferenceByPelvis(rest, skinned.skeleton, variantCfg);
}

describe('a rotating pelvis and the PARENT-LOCAL readouts', () => {
  it('leaves hip, knee and lumbar angles exactly invariant — they are already pelvis-relative', () => {
    // This is the half of the risk map that turned out to be FINE, and it is
    // worth pinning: L/R_UpLeg and Spine_Lower are measured from bone.quaternion
    // against a parent that IS the pelvis. If a later refactor moved them to a
    // world-frame readout, this would catch it.
    resetToAnatomic();
    const before = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
    tiltPelvis(25, 20, 0);
    const after = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
    for (const [joint, fields] of [
      ['L_UpLeg', ['hipFlexion', 'hipAbduction', 'hipRotation']],
      ['R_UpLeg', ['hipFlexion', 'hipAbduction', 'hipRotation']],
      ['L_Leg', ['kneeFlexion']],
      ['Spine_Lower', ['flexion', 'lateralTilt', 'rotation']],
    ] as const)
      for (const f of fields)
        expect(
          Math.abs((after.joints[joint]?.[f] ?? 0) - (before.joints[joint]?.[f] ?? 0)),
          `${joint}.${f} is pelvis-invariant`,
        ).toBeLessThan(0.01);
  });
});

describe('a rotating pelvis and the WORLD-FRAME machinery', () => {
  it('CORRUPTS the ROM clamp when the rest reference is not pelvis-aware — an untouched knee is rewritten', () => {
    // The counterfactual, kept as a live gate so the fix cannot be quietly
    // reverted: with the UN-rotated reference the clamp reads a knee nobody
    // touched as out of band and rewrites it.
    tiltPelvis(25, 20, 0);
    const knee = lookup.get('L_Leg')!;
    const beforeQ = knee.quaternion.clone();
    const rewrote = clampBoneToRom(knee, 'L_Leg', rest);
    const moved = angleDeg(beforeQ, knee.quaternion);
    // eslint-disable-next-line no-console
    console.log(`stale reference: clamp rewrote the untouched knee? ${rewrote} (${moved.toFixed(2)}°)`);
    expect(rewrote, 'the stale-reference clamp fires on an untouched knee').toBe(true);
    expect(moved, 'and moves it measurably').toBeGreaterThan(1);
  });

  it('does NOT corrupt the clamp once the reference is pelvis-aware', () => {
    tiltPelvis(25, 20, 0);
    const knee = lookup.get('L_Leg')!;
    const beforeQ = knee.quaternion.clone();
    const rewrote = clampBoneToRom(knee, 'L_Leg', pelvisAwareRest());
    const moved = angleDeg(beforeQ, knee.quaternion);
    // eslint-disable-next-line no-console
    console.log(`pelvis-aware: clamp rewrote the untouched knee? ${rewrote} (${moved.toFixed(4)}°)`);
    expect(rewrote, 'an untouched knee is left alone').toBe(false);
    expect(moved, 'bit-for-bit untouched').toBeLessThan(0.001);
  });

  it('does NOT invent shoulder rotation once the reference is pelvis-aware', () => {
    // Same defect, different consumer: upperArmWorldAngles is world-frame, so a
    // pelvis-only rotation read as ~32° of shoulderRotation from an arm that
    // never moved.
    resetToAnatomic();
    const before = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
    tiltPelvis(25, 20, 0);
    const stale = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest);
    const aware = computeJointAngles(skinned.skeleton, variantCfg, 'male', pelvisAwareRest());
    const d = (r: typeof before, f: string) =>
      Math.abs((r.joints.L_UpperArm?.[f] ?? 0) - (before.joints.L_UpperArm?.[f] ?? 0));
    // eslint-disable-next-line no-console
    console.log(
      `shoulderRotation drift — stale ${d(stale, 'shoulderRotation').toFixed(2)}° · ` +
        `pelvis-aware ${d(aware, 'shoulderRotation').toFixed(2)}°`,
    );
    expect(d(stale, 'shoulderRotation'), 'the stale reference invents twist').toBeGreaterThan(5);
    for (const f of ['shoulderFlexion', 'shoulderAbduction', 'shoulderRotation'])
      expect(d(aware, f), `pelvis-aware L_UpperArm.${f} stays put`).toBeLessThan(1.5);
  });

  it('still MEASURES the pelvis itself — the pelvis-aware frame must not cancel its own subject', () => {
    // The trap in the fix: rotateRestReferenceByRoot cancels root yaw out of the
    // readout, which is why the walk's faked pelvic rotation is invisible. The
    // pelvis sibling must rotate the frame for everything BELOW the pelvis while
    // leaving the pelvis's own reference alone, or it reproduces exactly the
    // defect it exists to remove.
    tiltPelvis(12, 8, -6);
    const r = computeJointAngles(skinned.skeleton, variantCfg, 'male', pelvisAwareRest());
    const hips = r.joints.Hips!;
    // eslint-disable-next-line no-console
    console.log(
      `pelvis reads: tilt ${hips.anteriorTilt?.toFixed(1)}° · obliquity ${hips.lateralTilt?.toFixed(1)}° · rotation ${hips.rotation?.toFixed(1)}°`,
    );
    const magnitude =
      Math.abs(hips.anteriorTilt ?? 0) + Math.abs(hips.lateralTilt ?? 0) + Math.abs(hips.rotation ?? 0);
    expect(magnitude, 'the pelvis still reports its own motion').toBeGreaterThan(15);
  });
});
