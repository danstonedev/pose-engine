/**
 * A HINGE MUST NOT OFFER A VARUS/VALGUS RING.
 *
 * `clampHinge` allows ±5° of frontal play on a knee (±10 on an elbow) as PLAY —
 * a real elbow has a carrying angle, a hard zero-lock looks robotic — and not
 * as a range to pose within. So the frontal ring can move essentially nothing.
 *
 * Dragging it did far worse than nothing. Rig-measured through the REAL gizmo,
 * an ordinary rotate gesture on the frontal ring of a knee at 90°, 120° and
 * 135° of flexion ended at −15.0° every time — the hyperextension floor — with
 * single-sample bone jumps of 43°, 114° and 79°.
 *
 * Driving the frontal axis swings the shin toward the swing-twist
 * decomposition's pole, where flexion stops being recoverable; the clamp then
 * reads a flexion it should not trust and bounds it to the wrong end of the
 * range. Full flexion becomes full extension — the reported snap, knees
 * specifically.
 *
 * This is the reason it is knees specifically: ball joints have wide frontal
 * ranges and no such ring-vs-reality mismatch, and the wrist's odd ring was
 * already hidden. The hinge is the joint whose offered controls and whose
 * actual freedom disagreed.
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
  computeDrivingRingMap,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { hingeOffAxisTolerance, isHingeJoint } from '../services/poseRomClamp';
import { hiddenRingsForJoint } from '../services/poseGizmoHelpers';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let rings: ReturnType<typeof computeDrivingRingMap>;

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
  const root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  buildBoneByPoseKey(skinned.skeleton, variantCfg);
  rings = computeDrivingRingMap(rest);
});

const HINGES = ['L_Leg', 'R_Leg', 'L_Forearm', 'R_Forearm'] as const;

describe('hinge joints', () => {
  it('are exactly the knees and elbows', () => {
    // Pinned so a strategy changing kind shows up here rather than silently
    // changing which rings the UI offers.
    for (const k of HINGES) expect(isHingeJoint(k), k).toBe(true);
    for (const k of ['L_UpLeg', 'L_UpperArm', 'L_Hand', 'Spine_Lower', 'Hips'])
      expect(isHingeJoint(k), k).toBe(false);
  });

  it('allow only a few degrees off-axis — play, not a posing range', () => {
    // The number that makes the ring a lie: 5° on a knee.
    const knee = hingeOffAxisTolerance('L_Leg')!;
    expect(knee.abduction).toEqual({ min: -5, max: 5 });
    const elbow = hingeOffAxisTolerance('L_Forearm')!;
    expect(Math.abs(elbow.abduction.max)).toBeLessThanOrEqual(10);
    expect(hingeOffAxisTolerance('L_UpLeg'), 'ball joints have no such table').toBeNull();
  });

  it('hide their frontal ring, on every hinge', () => {
    for (const k of HINGES) {
      const frontal = rings[k]?.frontal?.ring;
      expect(frontal, `${k} has a frontal ring to hide`).toBeTruthy();
      expect(hiddenRingsForJoint(k, rings[k], isHingeJoint), k).toContain(frontal);
    }
  });

  it('keep their flexion ring — the one axis a hinge really has', () => {
    for (const k of HINGES) {
      const sagittal = rings[k]?.sagittal?.ring;
      expect(sagittal, `${k} has a sagittal ring`).toBeTruthy();
      expect(hiddenRingsForJoint(k, rings[k], isHingeJoint), k).not.toContain(sagittal);
    }
  });
});

describe('the rule leaves every other joint alone', () => {
  it('still hides the wrist pro/sup ring, and nothing else there', () => {
    for (const k of ['L_Hand', 'R_Hand'] as const) {
      const proSup = rings[k]?.transverse?.ring;
      expect(hiddenRingsForJoint(k, rings[k], isHingeJoint)).toEqual([proSup]);
    }
  });

  it('hides nothing on ball joints, the spine or the pelvis', () => {
    for (const k of ['L_UpLeg', 'R_UpperArm', 'Spine_Lower', 'Spine_Upper', 'Neck', 'Hips'])
      expect(hiddenRingsForJoint(k, rings[k], isHingeJoint), k).toEqual([]);
  });

  it('is safe on an unknown or ringless key', () => {
    expect(hiddenRingsForJoint(null, undefined, isHingeJoint)).toEqual([]);
    expect(hiddenRingsForJoint('Nonsense', rings.Nonsense, isHingeJoint)).toEqual([]);
  });
});
