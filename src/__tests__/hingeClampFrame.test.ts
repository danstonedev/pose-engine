/**
 * A HINGE'S CLAMP MUST MEASURE WHAT THE READOUT MEASURES.
 *
 * Knee flexion is the thigh-to-shin angle; elbow flexion is the humerus-to-
 * forearm angle. `computeJointAngles` computes exactly that, geometrically,
 * from the parent's and the child's world DIRECTIONS — so it is invariant to
 * everything above the joint, which is what makes it a clinical number.
 *
 * `clampHinge` used to read a WORLD-frame delta instead
 * (`computeCanonicalDelta` against `rest.worldQuats`), which folds in every
 * rotation of every ancestor. The two therefore disagreed by the entire hip
 * angle, and the clamp acted on ITS number:
 *
 *   hip   0° → readout 90.8°, clamp 90.0°   (agree)
 *   hip  90° → readout 90.8°, clamp  0.0°   (90.8° apart)
 *
 * Reported as: park a knee at full flexion, then make another movement, and the
 * leg snaps to full extension. With the hip flexed far enough the clamp decides
 * the knee is past its −15° hyperextension floor and rewrites the shin —
 * straightening a knee the user deliberately bent, without the user touching it.
 *
 * `pelvisMeasurementFrame.test.ts` documents the same defect from the other end
 * ("a pelvis-only rotation makes an UNTOUCHED knee read 8.31° of abduction …
 * and clampBoneToRom then rewrites the shin by 5.43°") and worked around it by
 * rotating the rest reference. Measuring in the parent frame removes the need
 * for that workaround on hinges: they become ancestor-invariant by construction.
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
import { clampBoneToRom, inspectClinicalAngles } from '../services/poseRomClamp';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const RAD = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);

describe('the hinge clamp is invariant to everything above the joint', () => {
  let root: THREE.Object3D;
  let skinned: THREE.SkinnedMesh;
  let rest: JointAngleRestReference;
  let bones: Map<string, THREE.Bone>;
  const restLocal = new Map<string, THREE.Quaternion>();

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
    bones = buildBoneByPoseKey(skinned.skeleton, variantCfg);
    for (const k of ['L_Leg', 'L_UpLeg', 'R_Forearm', 'R_UpperArm'])
      restLocal.set(k, bones.get(k)!.quaternion.clone());
  });

  /** Set a bone to its rest local rotated by `deg` about X. */
  function setLocal(key: string, deg: number): void {
    bones
      .get(key)!
      .quaternion.copy(restLocal.get(key)!)
      .multiply(new THREE.Quaternion().setFromAxisAngle(X, deg * RAD));
    root.updateMatrixWorld(true);
  }

  for (const [hinge, parent, label] of [
    ['L_Leg', 'L_UpLeg', 'knee under a moving hip'],
    ['R_Forearm', 'R_UpperArm', 'elbow under a moving shoulder'],
  ] as const) {
    it(`reads a constant angle for the ${label}`, () => {
      // The hinge is held at ONE local angle throughout, so its true clinical
      // flexion is constant by construction — the two segments never move
      // relative to each other. Only the parent sweeps.
      const readings: number[] = [];
      for (let parentDeg = 0; parentDeg <= 90; parentDeg += 15) {
        setLocal(hinge, -90);
        setLocal(parent, parentDeg);
        readings.push(inspectClinicalAngles(bones.get(hinge)!, hinge, rest)!.anatomicFlexion);
      }
      const spread = Math.max(...readings) - Math.min(...readings);
      expect(spread, `${hinge} clamp angle must not track ${parent} (saw ${readings.map((r) => r.toFixed(1)).join(', ')})`).toBeLessThan(0.5);
    });

    it(`clamps the ${label} to the same place regardless of the parent`, () => {
      // The user-visible failure, stated as the property that actually matters.
      //
      // Not "the clamp never fires" — driving a hinge by a raw axis rotation
      // carries genuine off-axis content, and bounding that is the clamp doing
      // its job. What must NOT happen is the clamp reaching a DIFFERENT verdict
      // about the same thigh-to-shin angle because something above it moved.
      const settled: THREE.Quaternion[] = [];
      for (const parentDeg of [0, 45, 90]) {
        setLocal(hinge, -90);
        setLocal(parent, parentDeg);
        clampBoneToRom(bones.get(hinge)!, hinge, rest);
        settled.push(bones.get(hinge)!.quaternion.clone());
      }
      // Threshold is 0.05°, not 0. The clamp is now a pure function of
      // `bone.quaternion` — driven from a synthetic two-bone chain it is
      // bit-identical — but on the real rig the rest locals are not identity,
      // so the delta is a conjugation and carries double-precision noise in the
      // last couple of bits. `acos(dot)` has an infinite derivative at dot = 1,
      // which amplifies that into ~0.02°. That is the METRIC's conditioning,
      // not frame dependence: the pre-fix number here was the full hip angle.
      for (let i = 1; i < settled.length; i += 1) {
        const apart =
          (2 * Math.acos(Math.min(1, Math.abs(settled[0].dot(settled[i])))) * 180) / Math.PI;
        expect(apart, `${hinge} settled differently once ${parent} moved`).toBeLessThan(0.05);
      }
    });
  }

  it('agrees with the READOUT, which is the number the panel shows', () => {
    // Both are "the angle between the two segments", so they must not drift
    // apart as the parent moves. A small constant offset is expected: the
    // readout is a geometric angle between bone directions, the clamp a
    // quaternion decomposition.
    const gaps: number[] = [];
    for (let hipDeg = 0; hipDeg <= 90; hipDeg += 15) {
      setLocal('L_Leg', -90);
      setLocal('L_UpLeg', hipDeg);
      const readout =
        computeJointAngles(skinned.skeleton, variantCfg, 'male', rest).joints.L_Leg?.kneeFlexion ??
        NaN;
      const clamp = inspectClinicalAngles(bones.get('L_Leg')!, 'L_Leg', rest)!.anatomicFlexion;
      gaps.push(clamp - readout);
    }
    const drift = Math.max(...gaps) - Math.min(...gaps);
    expect(drift, `clamp-vs-readout gap must not depend on the hip (saw ${gaps.map((g) => g.toFixed(1)).join(', ')})`).toBeLessThan(0.5);
  });
});
