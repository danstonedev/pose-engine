/**
 * ANKLE-PIVOT IDLE SWAY (Wave 5 · life-signals) — the audit's physicality
 * finding: "rest sway is lumbar angle-noise above a dead-still pelvis, not an
 * ankle-pivot inverted pendulum". The idle sway now carries an ankle-pivot
 * share: a whole-body roll/pitch about the ankle line (root rotation at floor
 * level) with each FOOT counter-rotated so the soles stay flat — the ankle
 * joint angle changes by the pivot angle and the pelvis/COM genuinely
 * translates ≈ tan(θ)·height (θ ≈ atan(shift/height)).
 *
 * Measured on the real runtime GLB by replicating the stage's exact
 * application (same axes, same premultiply, same conjugated foot
 * counter-rotation — the same pattern idleLiveliness.test.ts pins):
 *   • the ankle ANGLE (shank-vs-foot) change equals the pivot angle — the
 *     shank tilts while the foot's world orientation is byte-stable;
 *   • the pelvis lateral shift CORRELATES with the pivot angle and matches
 *     the inverted-pendulum atan(shift/height) relation;
 *   • head excursion stays bounded (an idle settle, not a lurch);
 *   • exact undo; clean mode (amount 0) is a true statue; deterministic.
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
  idleSwaySplit,
  IDLE_ANKLE_PIVOT_SHARE,
  IDLE_PIVOT_HEIGHT_M,
} from '../services/liveliness';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

// The stage's overlay axes (ExamStage3D _swayAxisAP / _swayAxisML).
const AXIS_AP = new THREE.Vector3(1, 0, 0);
const AXIS_ML = new THREE.Vector3(0, 0, 1);

describe('ankle-pivot idle sway — measured on the rig', () => {
  const variantCfg = BODY_VARIANTS.male;
  const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
  let root: THREE.Object3D;
  let skinned: THREE.SkinnedMesh;
  let bones: Map<string, THREE.Bone>;

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
    bones = buildBoneByPoseKey(skinned.skeleton, variantCfg) as Map<string, THREE.Bone>;
  });

  /** Replicate the stage's ANKLE-PIVOT application only (the sway share that
   *  pivots the whole body about the ankle line): premultiply the root by the
   *  roll/pitch delta and counter-rotate each foot by the conjugated inverse
   *  so its world orientation (the flat sole) is unchanged. Returns an undo. */
  function applyPivot(rollDeg: number, pitchDeg: number): () => void {
    const lFoot = bones.get('L_Foot')!;
    const rFoot = bones.get('R_Foot')!;
    const baseLFoot = lFoot.quaternion.clone();
    const baseRFoot = rFoot.quaternion.clone();
    const baseRootQ = root.quaternion.clone();
    const q = new THREE.Quaternion();
    const pivot = new THREE.Quaternion().setFromAxisAngle(AXIS_ML, (rollDeg * Math.PI) / 180);
    q.setFromAxisAngle(AXIS_AP, (pitchDeg * Math.PI) / 180);
    pivot.premultiply(q);
    root.quaternion.premultiply(pivot);
    root.updateMatrixWorld(true);
    const pivotInv = pivot.clone().invert();
    for (const foot of [lFoot, rFoot]) {
      const p = new THREE.Quaternion();
      foot.parent!.getWorldQuaternion(p);
      const m = p.clone().invert().multiply(pivotInv).multiply(p);
      foot.quaternion.premultiply(m);
    }
    root.updateMatrixWorld(true);
    return () => {
      lFoot.quaternion.copy(baseLFoot);
      rFoot.quaternion.copy(baseRFoot);
      root.quaternion.copy(baseRootQ);
      root.updateMatrixWorld(true);
    };
  }

  const worldQ = (name: string): THREE.Quaternion => {
    const q = new THREE.Quaternion();
    bones.get(name)!.getWorldQuaternion(q);
    return q;
  };
  const worldP = (name: string): THREE.Vector3 => {
    const p = new THREE.Vector3();
    bones.get(name)!.getWorldPosition(p);
    return p;
  };
  /** Angle (deg) between two orientations. */
  const angleBetween = (a: THREE.Quaternion, b: THREE.Quaternion): number =>
    (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;

  it('the ANKLE ANGLE changes by the pivot angle: the shank tilts, the foot world orientation stays byte-stable (soles flat)', () => {
    const pivotDeg = 0.78; // the full-amount pivot share (0.6 × 1.3°)
    const shankBefore = worldQ('L_Leg');
    const footBefore = worldQ('L_Foot');
    const undo = applyPivot(pivotDeg, 0);
    const shankAfter = worldQ('L_Leg');
    const footAfter = worldQ('L_Foot');
    undo();
    // The shank (everything above the ankle) tilts by the pivot…
    expect(angleBetween(shankBefore, shankAfter)).toBeCloseTo(pivotDeg, 3);
    // …the foot does not (a ≤0.005° quaternion round-off residual — <1% of
    // the pivot) — so the ankle joint angle changed by the pivot: an inverted
    // pendulum about the ankles, not a rigid statue tip.
    expect(angleBetween(footBefore, footAfter)).toBeLessThan(pivotDeg * 0.01);
  });

  it('pelvis shift and ankle angle CORRELATE on the inverted-pendulum relation θ ≈ atan(shift/height)', () => {
    const hipsRest = worldP('Hips');
    const hipsH = hipsRest.y; // pendulum arm to the pelvis (ankle ≈ floor level)
    let corr = 0;
    let samples = 0;
    for (let t = 0; t <= 30; t += 0.25) {
      const sway = idleSwaySplit(t, 1);
      const undo = applyPivot(sway.ankleRollDeg, sway.anklePitchDeg);
      const dx = worldP('Hips').x - hipsRest.x;
      undo();
      if (Math.abs(sway.ankleRollDeg) < 0.15) continue; // skip near-zero crossings
      // Rig convention: a +Z (AXIS_ML) roll tips the body toward −X, so the
      // pelvis moves OPPOSITE the signed roll — correlate with the sign flip.
      corr += dx * -sway.ankleRollDeg;
      samples += 1;
      // Magnitude: the pelvis rides the pendulum arm — tan(θ)·hipHeight,
      // within tolerance for the ~9 cm floor-vs-ankle pivot approximation.
      const expected = Math.tan((Math.abs(sway.ankleRollDeg) * Math.PI) / 180) * hipsH;
      expect(Math.abs(dx)).toBeGreaterThan(expected * 0.7);
      expect(Math.abs(dx)).toBeLessThan(expected * 1.3);
    }
    expect(samples).toBeGreaterThan(10);
    expect(corr, 'pelvis displacement follows the ankle angle').toBeGreaterThan(0);
  });

  it('the pelvis GENUINELY translates (no more dead pelvis) — and the module comShiftM export matches the atan(shift/height) contract', () => {
    const hipsRest = worldP('Hips');
    let xMin = Infinity;
    let xMax = -Infinity;
    for (let t = 0; t <= 30; t += 1 / 30) {
      const sway = idleSwaySplit(t, 1);
      const undo = applyPivot(sway.ankleRollDeg, sway.anklePitchDeg);
      const dx = worldP('Hips').x - hipsRest.x;
      undo();
      xMin = Math.min(xMin, dx);
      xMax = Math.max(xMax, dx);
    }
    const travelCm = (xMax - xMin) * 100;
    // eslint-disable-next-line no-console
    console.log(`ankle-pivot rig: pelvis lateral travel ${travelCm.toFixed(2)} cm over the sway (amount 1)`);
    expect(travelCm).toBeGreaterThan(1); // a real pelvis ride…
    expect(travelCm).toBeLessThan(6); // …that stays an idle settle
    // comShiftM is the module's stated pendulum prediction for the SAME angle:
    // θ = atan(comShiftM / IDLE_PIVOT_HEIGHT_M) exactly.
    for (const t of [0.4, 1.7, 3.3]) {
      const sway = idleSwaySplit(t, 1);
      expect(
        (Math.atan(sway.comShiftM / IDLE_PIVOT_HEIGHT_M) * 180) / Math.PI,
      ).toBeCloseTo(sway.ankleRollDeg, 9);
    }
  });

  it('HEAD excursion stays bounded at the shipped dial (0.4): the pivot share reads as life, not a wobble', () => {
    const headRest = worldP('Head');
    let worst = 0;
    for (let t = 0; t <= 30; t += 1 / 30) {
      const sway = idleSwaySplit(t, 0.4);
      const undo = applyPivot(sway.ankleRollDeg, sway.anklePitchDeg);
      worst = Math.max(worst, worldP('Head').distanceTo(headRest));
      undo();
    }
    expect(worst * 100, 'peak head excursion from the pivot alone (cm)').toBeLessThan(2);
    expect(worst * 100, 'but it IS a visible sway').toBeGreaterThan(0.15);
  });

  it('the split PARTITIONS the sway (shares sum to 1 — no amplitude added), amount 0 zeroes everything, deterministic', () => {
    for (const t of [0, 1.3, 7.7, 21.4]) {
      const sway = idleSwaySplit(t, 1);
      const whole = sway.ankleRollDeg / IDLE_ANKLE_PIVOT_SHARE;
      expect(sway.lumbarMlDeg).toBeCloseTo(whole * (1 - IDLE_ANKLE_PIVOT_SHARE), 9);
      expect(idleSwaySplit(t, 0)).toEqual({
        ankleRollDeg: 0,
        anklePitchDeg: 0,
        lumbarMlDeg: 0,
        lumbarApDeg: 0,
        comShiftM: 0,
      });
      expect(idleSwaySplit(t, 0.7)).toEqual(idleSwaySplit(t, 0.7));
    }
  });

  it('the undo is EXACT — root quat + both feet bit-identical after lift', () => {
    const baseRoot = root.quaternion.toArray();
    const baseL = bones.get('L_Foot')!.quaternion.toArray();
    const baseR = bones.get('R_Foot')!.quaternion.toArray();
    for (const t of [0.3, 2.9, 11.13]) {
      const sway = idleSwaySplit(t, 1);
      const undo = applyPivot(sway.ankleRollDeg, sway.anklePitchDeg);
      undo();
      expect(root.quaternion.toArray()).toEqual(baseRoot);
      expect(bones.get('L_Foot')!.quaternion.toArray()).toEqual(baseL);
      expect(bones.get('R_Foot')!.quaternion.toArray()).toEqual(baseR);
    }
  });
});
