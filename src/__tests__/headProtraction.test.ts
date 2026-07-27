/**
 * HEAD PROTRACTION / RETRACTION — the forward-head channel this rig had none of.
 *
 * WHY THIS EXISTS. Reported alongside the flat spine and scapular channels, but
 * it was a different kind of gap: those were unauthored, this one **did not
 * exist**. The `Neck` registry row carried flexion/lateralTilt/rotation only, and
 * there is no `Head` row at all — so there was nothing to be flat.
 *
 * IT WAS ALSO MISDIAGNOSED, and the correction is the interesting part. It was
 * first called unrepresentable on this rig — an asset problem needing a new bone.
 * It is not. The chain is:
 *
 *     CC_Base_Spine02 → CC_Base_NeckTwist01 → CC_Base_NeckTwist02 → CC_Base_Head
 *
 * Two stacked cervical segments, which is exactly the minimum the motion needs,
 * because protraction is not a rotation of the neck — it is a TRANSLATION of the
 * head, produced by flexing the lower cervical while extending the upper. What
 * actually blocked it was the authoring path: the `Neck` handle is a CURVE
 * control that bends both segments the same way, and a curve cannot make an
 * opposite-sign pair.
 *
 * The measurement falls out cleanly once that is seen. Sum and half-difference of
 * the two segments are an orthogonal pair: flexion is the sum, protraction the
 * difference. Most of this file gates that orthogonality, because it is the
 * property that makes the channel trustworthy rather than merely present — and
 * the property that would silently rot if cervical flexion ever stopped being
 * split evenly across both bones.
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
import { buildComposedCommandPose } from '../services/movementCommand';
import { getRomFieldDefinition } from '../services/romRegistry';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

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
}, 60_000);

/** Command a set of Neck motions together and read the whole neck back. */
const drive = (targets: { motion: string; degrees: number }[]) => {
  const pose = buildComposedCommandPose(baselinePose, 'Neck', targets, variantCfg, null, rest);
  expect(pose, 'the neck builds').not.toBeNull();
  applyCustomPose(skinned.skeleton, variantCfg, pose!);
  root.updateMatrixWorld(true);
  const j = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest).joints;
  return {
    flexion: j.Neck?.flexion ?? NaN,
    protraction: j.Neck?.protraction ?? NaN,
    lateralTilt: j.Neck?.lateralTilt ?? NaN,
    rotation: j.Neck?.rotation ?? NaN,
    headWorld: (() => {
      const b = skinned.skeleton.bones.find((x) => x.name === 'CC_Base_Head')!;
      const v = new THREE.Vector3();
      b.getWorldPosition(v);
      return v;
    })(),
  };
};

describe('the channel exists at all', () => {
  it('is a registered ROM field with a band', () => {
    const f = getRomFieldDefinition('Neck', 'protraction');
    expect(f, 'Neck.protraction is in the registry').toBeDefined();
    expect(f!.range.min).toBe(-20);
    expect(f!.range.max).toBe(20);
  });
});

describe('commanded == measured', () => {
  it('reads back its own command across the band, both directions', () => {
    for (const deg of [-20, -12, -5, 5, 12, 20]) {
      const r = drive([{ motion: 'protraction', degrees: deg }]);
      expect(r.protraction, `protraction ${deg}`).toBeCloseTo(deg, 1);
    }
  });

  it('cervical flexion still reads back exactly — splitting it across both segments did not move it', () => {
    // The regression risk of this change. Flexion used to hinge entirely at the
    // upper segment; it is now half on each. The readout sums both, so the number
    // must be identical — and if it ever is not, the orthogonality below is a lie.
    for (const deg of [-30, -10, 10, 25, 45]) {
      const r = drive([{ motion: 'flexion', degrees: deg }]);
      expect(r.flexion, `flexion ${deg}`).toBeCloseTo(deg, 1);
    }
  });
});

describe('the two sagittal cervical channels are ORTHOGONAL', () => {
  it('pure flexion produces NO protraction', () => {
    for (const deg of [-30, -10, 25, 45]) {
      const r = drive([{ motion: 'flexion', degrees: deg }]);
      expect(Math.abs(r.protraction), `flexion ${deg} leaks no protraction`).toBeLessThan(0.5);
    }
  });

  it('pure protraction produces NO flexion — the head translates, it does not pitch', () => {
    // This is the whole anatomical claim. Lower cervical flexes, upper extends,
    // and the two cancel in the sum: the head moves FORWARD while staying level.
    for (const deg of [-20, -8, 8, 20]) {
      const r = drive([{ motion: 'protraction', degrees: deg }]);
      expect(Math.abs(r.flexion), `protraction ${deg} leaks no flexion`).toBeLessThan(0.5);
    }
  });

  it('commanded TOGETHER, each still reads its own value', () => {
    // The real test of orthogonality: not that each is clean alone, but that a
    // forward head carried on a flexed neck reports both, separately and right.
    for (const [f, p] of [
      [20, 15],
      [-15, 10],
      [30, -12],
      [-25, -18],
    ] as const) {
      const r = drive([
        { motion: 'flexion', degrees: f },
        { motion: 'protraction', degrees: p },
      ]);
      expect(r.flexion, `flexion ${f} beside protraction ${p}`).toBeCloseTo(f, 1);
      expect(r.protraction, `protraction ${p} beside flexion ${f}`).toBeCloseTo(p, 1);
    }
  });

  it('does not disturb the frontal or transverse cervical channels', () => {
    const r = drive([{ motion: 'protraction', degrees: 20 }]);
    expect(Math.abs(r.lateralTilt), 'no lateral leak').toBeLessThan(0.5);
    expect(Math.abs(r.rotation), 'no axial leak').toBeLessThan(0.5);
  });
});

describe('it actually translates the head', () => {
  it('protraction carries the head FORWARD and retraction carries it BACK', () => {
    // A channel that reports correctly while moving nothing would pass every gate
    // above. This one measures the rig: where the head bone actually ends up.
    const neutral = drive([{ motion: 'protraction', degrees: 0 }]).headWorld.clone();
    const pro = drive([{ motion: 'protraction', degrees: 20 }]).headWorld.clone();
    const ret = drive([{ motion: 'protraction', degrees: -20 }]).headWorld.clone();
    // +Z is anterior in this rig's world frame (the travel builders drive forward
    // along +Z, and the shoulder specs pin flexion to it).
    const proCm = (pro.z - neutral.z) * 100;
    const retCm = (ret.z - neutral.z) * 100;
    // eslint-disable-next-line no-console
    console.log(
      `head Z vs neutral — protraction 20° ${proCm.toFixed(2)} cm · retraction 20° ${retCm.toFixed(2)} cm`,
    );
    expect(proCm, 'protraction moves the head anteriorly').toBeGreaterThan(1);
    expect(retCm, 'retraction moves the head posteriorly').toBeLessThan(-1);
  });

  it('and keeps it LEVEL while doing so', () => {
    // The head should translate, not tip. Measured on the head bone's own world
    // pitch rather than on the neck readout, so it cannot be satisfied by the
    // decomposition agreeing with itself.
    const pitchOf = (deg: number) => {
      drive([{ motion: 'protraction', degrees: deg }]);
      const b = skinned.skeleton.bones.find((x) => x.name === 'CC_Base_Head')!;
      const q = new THREE.Quaternion();
      b.getWorldQuaternion(q);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      return THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)));
    };
    const base = pitchOf(0);
    for (const deg of [-20, 20]) {
      const tipped = Math.abs(pitchOf(deg) - base);
      // eslint-disable-next-line no-console
      console.log(`head pitch change at protraction ${deg}° — ${tipped.toFixed(2)}°`);
      expect(tipped, `protraction ${deg} keeps the head level`).toBeLessThan(6);
    }
  });
});
