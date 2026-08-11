/**
 * THE SPINE REGIONS LAND ON THE RANGE THE PANEL SHOWS.
 *
 * `Spine_Upper` (thoracic) and `Neck` (cervical) are not single bones. Their
 * registry row and readout describe a REGION, reported as the SUM of the two
 * segments it spans. A drag hands the CONTROL bone a target, which is then
 * spread across both — so bounding the control bone bounds a different quantity
 * than the one displayed.
 *
 * Rig-measured before the fix, driving each control 120° past its range:
 *
 *     Spine_Lower  ±120  →  60.0 / −25.0   range −25..60   exact (single bone)
 *     Spine_Upper  ±120  →  43.8 / −20.5   range −25..40   3.8° over
 *     Neck         ±120  →  59.7 / −39.9   range −60..50   9.7° over
 *
 * The cervical spine reached 59.7° against a stated 50° limit. `Spine_Lower`
 * was exact precisely because nothing is distributed for it, which is what
 * pointed at the distribution rather than at the clamp.
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
import {
  REGION_CURVE_CHAINS,
  clampRegionCurveToRom,
} from '../services/poseRegionCurveRomClamp';
import { getRomFieldDefinition } from '../services/romRegistry';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const RAD = Math.PI / 180;
/** Readback tolerance: the clamp lands the sum on the bound, but the readout
 *  re-decomposes two recomposed quaternions to get there. */
const TOL = 1.5;

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

/** Drive a region control `deg` about `axis` through the shared clamp, exactly
 *  as a ring drag does, and read back what the ROM panel would show. */
function driveRegion(key: string, field: 'flexion' | 'lateralTilt', deg: number): number {
  for (const [b, q] of anatomic) b.quaternion.copy(q);
  root.updateMatrixWorld(true);
  const chain = REGION_CURVE_CHAINS[key];
  const segs = chain.keys.map((k) => byKey.get(k)!);
  const rests = chain.keys.map((k) => {
    const r = rest.localQuats[k]!;
    return new THREE.Quaternion(r[0], r[1], r[2], r[3]);
  });
  const axis = field === 'flexion' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const target = rests[chain.control]
    .clone()
    .multiply(new THREE.Quaternion().setFromAxisAngle(axis, deg * RAD));
  clampRegionCurveToRom(key, segs, rests, chain.control, target, rest);
  root.updateMatrixWorld(true);
  const joints = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest).joints[key] as
    | Record<string, number>
    | undefined;
  return joints?.[field] ?? NaN;
}

describe('a region control cannot be driven past the range the panel reports', () => {
  for (const key of ['Spine_Upper', 'Neck'] as const) {
    for (const field of ['flexion', 'lateralTilt'] as const) {
      it(`${key}.${field} stops inside the registry range`, () => {
        const { min, max } = getRomFieldDefinition(key, field)!.range;
        for (const drive of [120, -120, 200, -200]) {
          const landed = driveRegion(key, field, drive);
          expect(landed, `${key}.${field} driven ${drive}°`).toBeGreaterThanOrEqual(min - TOL);
          expect(landed, `${key}.${field} driven ${drive}°`).toBeLessThanOrEqual(max + TOL);
        }
      });
    }
  }

  it('actually REACHES the limit — not merely stays under it', () => {
    // A clamp that scaled everything to zero would satisfy the bounds above and
    // be useless. The neck's flexion limit is the one that overshot worst.
    const { max, min } = getRomFieldDefinition('Neck', 'flexion')!.range;
    expect(driveRegion('Neck', 'flexion', 120)).toBeGreaterThan(max - 5);
    expect(driveRegion('Neck', 'flexion', -120)).toBeLessThan(min + 5);
  });

  it('leaves a within-range drive alone', () => {
    // The clamp must be inert where the user spends their time.
    const landed = driveRegion('Spine_Upper', 'flexion', 20);
    expect(landed).toBeGreaterThan(10);
    expect(landed).toBeLessThan(getRomFieldDefinition('Spine_Upper', 'flexion')!.range.max);
  });
});
