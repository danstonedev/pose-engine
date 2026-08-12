/**
 * PRO/SUP MOVES PRO/SUP AND NOTHING ELSE.
 *
 * Two defects, both from the writer disagreeing with the readout about what a
 * segment's "twist" is.
 *
 * 1. THE FRAME. `computeJointAngles` measures `forearmRotation` with a
 *    long-axis swing-twist (`ballJointAngles`) and the wrist with a body-frame
 *    YXZ Euler (`decomposeBodyDelta`, flexion off z, deviation off x). Those
 *    two decompositions are not the same split: holding a swing-twist's swing
 *    fixed while its twist changes DOES move the Euler x and z. So writing the
 *    hand's half with `setAxialTwist` — which preserves the swing — published
 *    wrist motion nobody made. Measured on this rig, a wrist at 40° flexion and
 *    15° deviation lost up to 30° of deviation to a drag on the pro/sup ring
 *    alone.
 *
 *    There is a second half to that trap worth stating plainly, because it cost
 *    a wrong first fix: the readout's `deltaFromRest` is `current · rest⁻¹` (a
 *    LEFT delta, in the parent's frame) while `readAxialTwist` uses
 *    `rest⁻¹ · current` (a body delta). Those are conjugate — same angle,
 *    different axes — so decomposing "about +Y" means two different things in
 *    them. Getting the Euler order right but the delta convention wrong still
 *    left several degrees of leak.
 *
 * 2. THE SEED. The writer read the desired split out of the grabbed bone alone,
 *    which is only right while the pair is already even. A loaded pose, an IK
 *    solve, or a clamp can leave the two segments holding different shares, and
 *    then the first frame of the drag flattened both to the grabbed one's
 *    share — the pose jumped before the cursor moved.
 *
 * The tests below measure the panel, not the bones: what is being defended is
 * the number the clinician reads.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import {
  buildBoneByPoseKey,
  readAxialTwist,
  readBodyEulerTwist,
  setAxialTwist,
  setBodyEulerTwist,
} from '../services/poseRig';
import {
  captureJointAngleRestReference,
  computeJointAngles,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { clampBoneToRom } from '../services/poseRomClamp';
import {
  PROSUP_TOTAL_LIMIT_RAD,
  applyCoupledProSup,
  beginCoupledProSup,
} from '../services/poseProSupRomClamp';
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

const reset = (): void => {
  for (const [b, q] of anatomic) b.quaternion.copy(q);
  root.updateMatrixWorld(true);
};

const restOf = (key: string): THREE.Quaternion => {
  const r = rest.localQuats[key]!;
  return new THREE.Quaternion(r[0], r[1], r[2], r[3]);
};

/** What the panel prints for one arm. */
function panel(side: 'L' | 'R') {
  root.updateMatrixWorld(true);
  const j = computeJointAngles(skinned.skeleton, variantCfg, 'male', rest).joints;
  return {
    wristFlexion: j[`${side}_Hand`]?.wristFlexion ?? NaN,
    wristDeviation: j[`${side}_Hand`]?.wristDeviation ?? NaN,
    proSup: j[`${side}_Hand`]?.proSup ?? NaN,
    elbowFlexion: j[`${side}_Forearm`]?.elbowFlexion ?? NaN,
  };
}

/** Put a wrist at a flexed, deviated posture — the state that exposes the frame
 *  disagreement. The leak grows with swing, so a test posed at rest sees only
 *  the small constant residual and would call the bug fixed while it was not. */
function poseWrist(side: 'L' | 'R', flexDeg: number, devDeg: number): void {
  const r = restOf(`${side}_Hand`);
  byKey
    .get(`${side}_Hand`)!
    .quaternion.copy(r)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), flexDeg / DEG))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), devDeg / DEG));
  root.updateMatrixWorld(true);
}

/** The target a Y-ring drag produces: the bone's CURRENT local, turned about
 *  its own long axis. Seeding from rest instead would discard the posture the
 *  drag started from, which no real drag does. */
const dragTarget = (key: string, deg: number): THREE.Quaternion =>
  byKey
    .get(key)!
    .quaternion.clone()
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg / DEG));

describe('a pro/sup drag does not move the wrist', () => {
  const POSTURES = [
    [30, 0],
    [0, 20],
    [40, 15],
    [-35, -10],
  ] as const;

  it('leaves wrist flexion and deviation EXACTLY where they were', () => {
    // Exact, not approximate: the writer preserves the Euler x and z components
    // the readout reads, so the only movement left is float noise. The old
    // writer moved deviation by up to 30° here.
    for (const side of ['L', 'R'] as const) {
      for (const [f, d] of POSTURES) {
        for (const drive of [45, 90, 200, -200]) {
          reset();
          poseWrist(side, f, d);
          const before = panel(side);
          applyCoupledProSup(
            `${side}_Forearm`,
            dragTarget(`${side}_Forearm`, drive),
            byKey,
            rest,
          );
          const after = panel(side);
          const label = `${side} wrist(${f},${d}) drive ${drive}`;
          expect(after.wristFlexion, `${label} flexion`).toBeCloseTo(before.wristFlexion, 6);
          expect(after.wristDeviation, `${label} deviation`).toBeCloseTo(before.wristDeviation, 6);
        }
      }
    }
  });

  it('still drives pro/sup to the published ±90 from that same posture', () => {
    // Holding flex/dev still is only worth anything if the twist itself arrives.
    for (const side of ['L', 'R'] as const) {
      for (const drive of [200, -200]) {
        reset();
        poseWrist(side, 40, 15);
        applyCoupledProSup(`${side}_Forearm`, dragTarget(`${side}_Forearm`, drive), byKey, rest);
        const p = panel(side);
        expect(Math.abs(p.proSup), `${side} ${drive} reaches`).toBeGreaterThan(89);
        expect(Math.abs(p.proSup), `${side} ${drive} stays inside`).toBeLessThanOrEqual(90.001);
      }
    }
  });

  it('holds the wrist when the HAND is the grabbed bone too', () => {
    // Grabbed, the hand takes the full target and is ROM-clamped FIRST, so its
    // flex/dev is whatever the clamp allows — the baseline here has to include
    // that clamp, or it measures the clamp's work and calls it leakage. What is
    // under test is only the twist overwrite that follows.
    for (const side of ['L', 'R'] as const) {
      reset();
      poseWrist(side, 40, 15);
      const target = dragTarget(`${side}_Hand`, 90);
      const hand = byKey.get(`${side}_Hand`)!;
      const saved = hand.quaternion.clone();
      hand.quaternion.copy(target);
      clampBoneToRom(hand, `${side}_Hand`, rest, null);
      const clampedOnly = panel(side);
      hand.quaternion.copy(saved);
      applyCoupledProSup(`${side}_Hand`, target, byKey, rest);
      const after = panel(side);
      expect(after.wristFlexion, `${side} flexion`).toBeCloseTo(clampedOnly.wristFlexion, 6);
      expect(after.wristDeviation, `${side} deviation`).toBeCloseTo(clampedOnly.wristDeviation, 6);
    }
  });
});

describe('the two twist frames', () => {
  it('does NOT agree with the swing-twist read, even at zero swing', () => {
    // Worth pinning, because "they must agree at rest" is the intuitive guess
    // and it is false — it cost a wrong first fix. The gap here is the DELTA
    // CONVENTION, not the swing: at zero swing `setAxialTwist` leaves
    // `q = rest · Ry(θ)`, whose LEFT delta `q · rest⁻¹` is a rotation of θ about
    // `rest · Y`, not about Y. Its Euler y therefore is not θ unless the rest
    // quaternion happens to be identity, which no real bone's is.
    //
    // The one that matters is whichever the panel reads, and the panel reads
    // the left delta — so `readBodyEulerTwist` is the hand's measure and the
    // disagreement below is the swing-twist read being in the wrong frame.
    reset();
    const r = restOf('L_Hand');
    const hand = byKey.get('L_Hand')!;
    setAxialTwist(hand, r, 10 / DEG);
    expect(readAxialTwist(hand.quaternion, r) * DEG).toBeCloseTo(10, 4);
    expect(Math.abs(readBodyEulerTwist(hand.quaternion, r) * DEG - 10)).toBeGreaterThan(0.1);
  });

  it('makes the panel print exactly what the Euler writer was given', () => {
    // The claim that justifies using it for the hand: write θ, read θ back off
    // the same decomposition `computeJointAngles` uses.
    reset();
    poseWrist('L', 40, 15);
    const r = restOf('L_Hand');
    for (const deg of [0, 12, 45, -45]) {
      setBodyEulerTwist(byKey.get('L_Hand')!, r, deg / DEG);
      expect(readBodyEulerTwist(byKey.get('L_Hand')!.quaternion, r) * DEG).toBeCloseTo(deg, 6);
    }
  });

  it('disagree once the joint carries swing — which is the whole bug', () => {
    // If this ever stops being true the two writers have become the same
    // function and the distinction above is dead weight. It is true because a
    // rotation about an axis in the XZ plane is not in general expressible as
    // Rx·Rz, so the Euler x and z cannot be blind to the twist.
    reset();
    poseWrist('L', 40, 15);
    const r = restOf('L_Hand');
    const hand = byKey.get('L_Hand')!;
    const swingTwist = hand.quaternion.clone();
    setAxialTwist(hand, r, 45 / DEG);
    const viaSwing = readBodyEulerTwist(hand.quaternion, r) * DEG;
    hand.quaternion.copy(swingTwist);
    setBodyEulerTwist(hand, r, 45 / DEG);
    const viaEuler = readBodyEulerTwist(hand.quaternion, r) * DEG;
    expect(viaEuler).toBeCloseTo(45, 6);
    expect(Math.abs(viaEuler - viaSwing)).toBeGreaterThan(1);
  });

  it('round-trips: setBodyEulerTwist is the inverse of readBodyEulerTwist', () => {
    reset();
    poseWrist('R', -35, -10);
    const r = restOf('R_Hand');
    const hand = byKey.get('R_Hand')!;
    for (const deg of [0, 12, 45, -45]) {
      setBodyEulerTwist(hand, r, deg / DEG);
      expect(readBodyEulerTwist(hand.quaternion, r) * DEG).toBeCloseTo(deg, 6);
    }
  });
});

describe('grabbing the pro/sup ring does not move the pose', () => {
  /** Leave the pair holding UNEVEN shares of the same total, the way a loaded
   *  pose or a clamp can. */
  function skewSplit(side: 'L' | 'R', forearmDeg: number, handDeg: number): void {
    setAxialTwist(byKey.get(`${side}_Forearm`)!, restOf(`${side}_Forearm`), forearmDeg / DEG);
    setBodyEulerTwist(byKey.get(`${side}_Hand`)!, restOf(`${side}_Hand`), handDeg / DEG);
    root.updateMatrixWorld(true);
  }

  it('holds the reported pro/sup steady through a zero-movement grab', () => {
    // THE defect. Pair at 10 + 40; grab the forearm; the first frame used to
    // write 10 to both and drop the reading from 50 to 20.
    for (const side of ['L', 'R'] as const) {
      for (const [f, h] of [
        [10, 40],
        [40, 10],
        [-5, 35],
        [0, 45],
      ] as const) {
        for (const grabbed of ['Forearm', 'Hand'] as const) {
          reset();
          skewSplit(side, f, h);
          const before = panel(side);
          const key = `${side}_${grabbed}`;
          const session = beginCoupledProSup(key, byKey, rest);
          expect(session, `${key} session`).not.toBeNull();
          // Zero movement: the target IS the current local.
          applyCoupledProSup(key, byKey.get(key)!.quaternion.clone(), byKey, rest, { session });
          // Not exact, and the residual is worth naming: the FOREARM's writer
          // (`setAxialTwist`, a body delta) and its readout (`ballJointAngles`,
          // a left delta) are conjugate, so writing θ there does not make the
          // panel print θ to the bit. Measured at ~0.002° for this grab and
          // ≤0.7° at a 45° twist on a bent elbow. The hand's half is exact; the
          // forearm's is not, and closing it means changing the semantics of a
          // helper the twist rig also uses — out of scope here, but this is the
          // number that would go to zero if it were done.
          expect(panel(side).proSup, `${side} ${f}+${h} grabbed ${grabbed}`).toBeCloseTo(
            before.proSup,
            1,
          );
        }
      }
    }
  });

  it('moves the total by twice the ring angle, the gain it always had', () => {
    // The doubling is not incidental — it is what lets a ±45 ring reach ±90.
    for (const side of ['L', 'R'] as const) {
      for (const d of [10, 25, -20]) {
        reset();
        skewSplit(side, 5, 15);
        const before = panel(side);
        const session = beginCoupledProSup(`${side}_Forearm`, byKey, rest);
        applyCoupledProSup(`${side}_Forearm`, dragTarget(`${side}_Forearm`, d), byKey, rest, {
          session,
        });
        const moved = panel(side).proSup - before.proSup;
        expect(Math.abs(moved), `${side} drag ${d}`).toBeCloseTo(Math.abs(2 * d), 1);
      }
    }
  });

  it('is unchanged from the old behaviour when the pair is already even', () => {
    // The session only rewrites the uneven case. An even pair — which is what
    // this writer itself always leaves behind — must land in exactly the same
    // place with the session as without, or this is a silent retune.
    for (const side of ['L', 'R'] as const) {
      for (const d of [20, 60, -40]) {
        reset();
        skewSplit(side, 12, 12);
        const session = beginCoupledProSup(`${side}_Forearm`, byKey, rest);
        const withSession = (() => {
          applyCoupledProSup(`${side}_Forearm`, dragTarget(`${side}_Forearm`, d), byKey, rest, {
            session,
          });
          return panel(side).proSup;
        })();
        reset();
        skewSplit(side, 12, 12);
        applyCoupledProSup(`${side}_Forearm`, dragTarget(`${side}_Forearm`, d), byKey, rest);
        expect(withSession, `${side} drag ${d}`).toBeCloseTo(panel(side).proSup, 4);
      }
    }
  });

  it('still bounds the pair at ±90 when seeded from an uneven split', () => {
    for (const side of ['L', 'R'] as const) {
      for (const d of [400, -400]) {
        reset();
        skewSplit(side, 40, 10);
        const session = beginCoupledProSup(`${side}_Forearm`, byKey, rest);
        applyCoupledProSup(`${side}_Forearm`, dragTarget(`${side}_Forearm`, d), byKey, rest, {
          session,
        });
        expect(Math.abs(panel(side).proSup), `${side} drive ${d}`).toBeLessThanOrEqual(90.001);
      }
    }
    expect(PROSUP_TOTAL_LIMIT_RAD * DEG).toBeCloseTo(90, 6);
  });

  it('refuses a session for a key it does not drive', () => {
    reset();
    for (const k of ['L_UpperArm', 'Spine_Lower', 'Hips', null, undefined]) {
      expect(beginCoupledProSup(k, byKey, rest), String(k)).toBeNull();
    }
  });
});

describe('the engine drag path captures the session', () => {
  // Source assertions: the wiring lives inside a pointer-event closure in a
  // module that needs a WebGL stage to construct. The math above is unit
  // tested; what these defend is that the drag path actually FEEDS it, because
  // omitting the session is silent — the writer falls back to the old
  // behaviour and the jump comes straight back.
  const LAYER = readFileSync(
    fileURLToPath(new URL('../services/stagePosingLayer.ts', import.meta.url)),
    'utf-8',
  );

  it('captures at pointer-down, in the same branch that begins the ring drag', () => {
    expect(LAYER).toMatch(
      /ringDrag = drag;\n\s*proSupDrag = beginCoupledProSup\(\s*selected\.key,\s*stageCtx\.motionCapBones,\s*stageCtx\.restRef,?\s*\);/,
    );
  });

  it('threads it into every apply call', () => {
    const calls = LAYER.match(/applyCoupledProSup\([\s\S]*?\n\s{6}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, c).toMatch(/session: proSupDrag/);
  });

  it('clears it everywhere the ring drag is cleared', () => {
    // A stale session outlives its drag and seeds the NEXT one from a total
    // that is no longer current — the same jump, one grab later.
    const clears = LAYER.match(/ringDrag = null;/g) ?? [];
    const paired = LAYER.match(/ringDrag = null;\n\s*proSupDrag = null;/g) ?? [];
    expect(clears.length).toBeGreaterThan(0);
    expect(paired.length, 'every ringDrag reset must reset proSupDrag').toBe(clears.length);
  });
});
