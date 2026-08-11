/**
 * A HINGE KEEPS ITS VARUS/VALGUS RING.
 *
 * It was briefly hidden. Dragging a knee's frontal ring on a FLEXED knee
 * collapsed it to full extension — rig-measured, 90°, 120° and 135° of flexion
 * all ended on the −15° hyperextension floor with single-sample bone jumps of
 * 43°, 114° and 79° — and removing the control removed the gesture.
 *
 * The cause was the ring-drag MODEL, not the ring. The old plane-intersection
 * bearing lost its footing near its degenerate view and fed the clamp an
 * orientation past the swing-twist decomposition's pole, where flexion is not
 * recoverable. With closest-approach tracking the same drag is well behaved,
 * so hiding the ring became pure loss: the knee has a real, if small, frontal
 * range that the ROM panel reports, and no way to reach it.
 *
 * These are the measurements that justify keeping it.
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
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { clampBoneToRom, hingeOffAxisTolerance, isHingeJoint } from '../services/poseRomClamp';
import { hiddenRingsForJoint } from '../services/poseGizmoHelpers';
import { PoseRotateRingGizmo } from '../services/poseRotateRings';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let byKey: Map<string, THREE.Bone>;
let anatomic: Map<THREE.Bone, THREE.Quaternion>;
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
  rings = computeDrivingRingMap(rest);
});

const angles = () => computeJointAngles(skinned.skeleton, variantCfg, 'male', rest).joints.L_Leg!;

/** Flex the knee, then drag its FRONTAL ring through the real gizmo, clamping
 *  every sample exactly as the host does. */
function dragFrontalRing(flexDeg: number) {
  for (const [b, q] of anatomic) b.quaternion.copy(q);
  const knee = byKey.get('L_Leg')!;
  knee.quaternion
    .copy(anatomic.get(knee)!)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -flexDeg * RAD));
  root.updateMatrixWorld(true);

  const wantAxis = (rings.L_Leg?.frontal?.ring ?? 'z').toUpperCase() as 'X' | 'Y' | 'Z';
  const centre = knee.getWorldPosition(new THREE.Vector3());
  const frame = knee.getWorldQuaternion(new THREE.Quaternion());
  const cam = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100);
  cam.position.set(centre.x + 0.9, centre.y + 0.25, centre.z + 1.4);
  cam.lookAt(centre);
  cam.updateMatrixWorld(true);
  const gizmo = new PoseRotateRingGizmo();
  gizmo.update(cam, centre, frame, true);
  gizmo.group.updateMatrixWorld(true);

  const rc = new THREE.Raycaster();
  let drag: ReturnType<PoseRotateRingGizmo['beginDrag']> = null;
  let start = new THREE.Vector2();
  for (let d = 0; d < 360 && !drag; d += 3) {
    const t = d / DEG;
    const p = new THREE.Vector2(Math.cos(t) * 0.16 * 0.62, Math.sin(t) * 0.16);
    rc.setFromCamera(p, cam);
    const cand = gizmo.beginDrag(rc, {
      centerWorld: centre,
      frameQuat: frame,
      boneLocalQuat: knee.quaternion,
      parentWorldQuat: (knee.parent as THREE.Bone).getWorldQuaternion(new THREE.Quaternion()),
    });
    if (cand?.axis === wantAxis) {
      drag = cand;
      start = p;
    }
  }
  if (!drag) return null;

  const tang = new THREE.Vector2(-start.y, start.x).normalize();
  let worstStep = 0;
  let prev = knee.quaternion.clone();
  for (let i = 1; i <= 120; i += 1) {
    const f = (0.2 * i) / 120;
    rc.setFromCamera(new THREE.Vector2(start.x + tang.x * f, start.y + tang.y * f), cam);
    knee.quaternion.copy(drag.update(rc));
    clampBoneToRom(knee, 'L_Leg', rest);
    root.updateMatrixWorld(true);
    worstStep = Math.max(worstStep, prev.angleTo(knee.quaternion) * DEG);
    prev = knee.quaternion.clone();
  }
  gizmo.dispose();
  const a = angles();
  return { worstStep, flexion: a.kneeFlexion!, deviation: a.kneeDeviation! };
}

describe('the knee’s frontal ring is offered, and is safe to use', () => {
  it('is not hidden', () => {
    const frontal = rings.L_Leg?.frontal?.ring;
    expect(frontal, 'the knee has a frontal ring').toBeTruthy();
    expect(hiddenRingsForJoint('L_Leg', rings.L_Leg)).toEqual([]);
    expect(hiddenRingsForJoint('L_Forearm', rings.L_Forearm)).toEqual([]);
  });

  it('PRESERVES flexion while it is dragged — the collapse is gone', () => {
    // The regression this file exists for. Each of these ended at −15.0 under
    // the old drag model; they now hold the flexion the user posed.
    for (const flex of [90, 120, 135]) {
      const r = dragFrontalRing(flex)!;
      expect(r, `${flex}° knee is grabbable on its frontal ring`).not.toBeNull();
      expect(r.flexion, `${flex}° flexion must survive a frontal drag`).toBeGreaterThan(flex - 5);
      expect(r.flexion).toBeLessThan(flex + 5);
    }
  });

  it('bounds deviation to the hinge tolerance, and moves smoothly getting there', () => {
    const tol = hingeOffAxisTolerance('L_Leg')!;
    const r = dragFrontalRing(120)!;
    expect(Math.abs(r.deviation), 'deviation stops at the tolerance').toBeLessThanOrEqual(
      Math.max(Math.abs(tol.abduction.min), Math.abs(tol.abduction.max)) + 1,
    );
    expect(r.worstStep, 'and no sample jumps').toBeLessThan(10);
  });

  it('still classes knees and elbows as hinges', () => {
    // The predicate stays — the clamp's tolerances are still derived from it,
    // and `hingeOffAxisTolerance` above is what makes the bound assertable.
    for (const k of ['L_Leg', 'R_Leg', 'L_Forearm', 'R_Forearm']) expect(isHingeJoint(k), k).toBe(true);
    for (const k of ['L_UpLeg', 'L_Hand', 'Hips']) expect(isHingeJoint(k), k).toBe(false);
  });
});

describe('the one ring that is still hidden', () => {
  it('is the wrist’s pro/sup, which the forearm already owns', () => {
    for (const k of ['L_Hand', 'R_Hand'] as const)
      expect(hiddenRingsForJoint(k, rings[k])).toEqual([rings[k]?.transverse?.ring]);
  });

  it('and nothing else, on any other joint', () => {
    for (const k of ['L_Leg', 'L_UpLeg', 'R_UpperArm', 'Spine_Lower', 'Neck', 'Hips'])
      expect(hiddenRingsForJoint(k, rings[k]), k).toEqual([]);
  });
});
