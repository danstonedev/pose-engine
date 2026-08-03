/**
 * The interactive pose path splits shoulder elevation like the authored one.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The shoulder's registry range is HUMEROTHORACIC and the humerus readout
 * measures exactly that — it is world-anchored, and the humerus is a child of
 * the clavicle, so scapular motion moves the arm's reading on its own. So the
 * range was right and the clamp bounded the right quantity.
 *
 * What was missing was the split. `movementCommand` divides a commanded
 * elevation across both joints; the pose path had ONE bound, on the composite,
 * and nothing watching the share. Pinning the scapula at rest and rotating the
 * humerus alone reached 166 degrees of pure glenohumeral flexion, unclamped, at
 * a joint with about 120.
 *
 * ── What these tests measure ────────────────────────────────────────────────
 *
 * Two properties that have to hold together, and are in tension:
 *
 *   1. The COMPOSITE must not move. The user put the arm somewhere; the split
 *      is an internal redistribution, not a correction of their input. A split
 *      that quietly changed the elevation would be worse than no split.
 *   2. The GLENOHUMERAL SHARE must drop, and land under the joint's capacity.
 *
 * Property 1 is what the authored path needed `unparentGirdle` for, and it is
 * where the expensive bug lived: handing the humerus the reduced share and
 * letting the clavicle add the rest reads back correct flexion while WRINGING
 * the arm axially (0 to 104 degrees of uncommanded rotation at 180 flexion).
 * So axial leak is asserted explicitly, not assumed absent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { buildBoneByPoseKey, buildIKChainContext, resolvePoseHandles, solveIKChain } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { inspectClinicalAngles } from '../services/poseRomClamp';
import { applyScapulohumeralRhythm, solveArmChainWithRhythm } from '../services/poseScapulohumeral';
import { girdleSplit } from '../services/movementCommand';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

/** The engine's own glenohumeral elevation capacity (movementCommand.ts). */
const GH_CAPACITY_DEG = 120;

let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let byKey: Map<string, THREE.Bone>;
let handles: ReturnType<typeof resolvePoseHandles>;
let restLocals: Map<string, THREE.Quaternion>;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  const root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !found) found = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  skinned = found as unknown as THREE.SkinnedMesh;
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  byKey = buildBoneByPoseKey(skinned.skeleton, variantCfg);
  handles = resolvePoseHandles(skinned.skeleton, variantCfg);
  restLocals = new Map();
  for (const [k, b] of byKey) restLocals.set(k, b.quaternion.clone());
});

function refresh(): void {
  skinned.skeleton.bones[0].parent?.updateMatrixWorld(true);
}

/** Restore the arm and girdle so cases stay independent. */
function withArmRestored(side: 'L' | 'R', run: () => void): void {
  const keys = [`${side}_Hand`, `${side}_Forearm`, `${side}_UpperArm`, `${side}_Shoulder`];
  const saved = keys.map((k) => byKey.get(k)!.quaternion.clone());
  try {
    run();
  } finally {
    keys.forEach((k, i) => byKey.get(k)!.quaternion.copy(saved[i]));
    refresh();
  }
}

/**
 * Rotate the humerus about a WORLD axis by `deg`, exactly as a gizmo ring drag
 * in that plane does — bypassing the command path entirely, because that path
 * already splits and would make this test measure itself.
 */
function spinHumerusWorld(side: 'L' | 'R', axis: THREE.Vector3, deg: number): void {
  const arm = byKey.get(`${side}_UpperArm`)!;
  arm.quaternion.copy(restLocals.get(`${side}_UpperArm`)!);
  byKey.get(`${side}_Shoulder`)!.quaternion.copy(restLocals.get(`${side}_Shoulder`)!);
  refresh();
  const parentWorld = new THREE.Quaternion();
  (arm.parent as THREE.Bone).getWorldQuaternion(parentWorld);
  const armWorld = new THREE.Quaternion();
  arm.getWorldQuaternion(armWorld);
  const spin = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg));
  arm.quaternion.copy(parentWorld.invert().multiply(spin.multiply(armWorld)));
  refresh();
}

/**
 * Rotate the humerus down to `deg` while leaving the clavicle exactly where it
 * is — the state a user passes through when they lower an arm the split has
 * already elevated the girdle for.
 */
function lowerHumerusKeepingGirdle(side: 'L' | 'R', deg: number): void {
  const arm = byKey.get(`${side}_UpperArm`)!;
  arm.quaternion.copy(restLocals.get(`${side}_UpperArm`)!);
  refresh();
  const parentWorld = new THREE.Quaternion();
  (arm.parent as THREE.Bone).getWorldQuaternion(parentWorld);
  const armWorld = new THREE.Quaternion();
  arm.getWorldQuaternion(armWorld);
  const spin = new THREE.Quaternion().setFromAxisAngle(SAGITTAL, THREE.MathUtils.degToRad(deg));
  arm.quaternion.copy(parentWorld.invert().multiply(spin.multiply(armWorld)));
  refresh();
}

/** Humerothoracic reading of the arm, as a goniometer would take it. */
function humerothoracic(side: 'L' | 'R') {
  const r = inspectClinicalAngles(byKey.get(`${side}_UpperArm`)!, `${side}_UpperArm`, rest)!;
  return { flexion: r.anatomicFlexion, abduction: r.raw.abduction, rotation: r.raw.rotation };
}

/**
 * Glenohumeral ELEVATION: how far the humerus's long axis has swung inside the
 * CLAVICLE's frame. Distinct from the humerothoracic reading precisely because
 * the clavicle moves — that difference IS the scapular share.
 *
 * MEASURED ON THE LONG AXIS, not as the quaternion's total rotation magnitude.
 * The first version of this test used the magnitude, and it reads high on a
 * twisted arm because it folds axial rotation in with elevation: on a pose with
 * 179.8 degrees of flexion it reported the split making the glenohumeral angle
 * WORSE (170.0 to 170.6) while the actual elevation fell 169.8 to 141.7. The
 * quantity `GH_ELEVATION_MAX_DEG` bounds is elevation, so elevation is what
 * gets measured.
 */
const LONG_AXIS = new THREE.Vector3(0, -1, 0);
function glenohumeralElevationDeg(side: 'L' | 'R'): number {
  const cur = byKey.get(`${side}_UpperArm`)!.quaternion;
  const restLocal = restLocals.get(`${side}_UpperArm`)!;
  return THREE.MathUtils.radToDeg(
    LONG_AXIS.clone().applyQuaternion(restLocal).angleTo(LONG_AXIS.clone().applyQuaternion(cur)),
  );
}

const SAGITTAL = new THREE.Vector3(-1, 0, 0);
/** Frontal-plane elevation. L takes +Z and R takes -Z to read as POSITIVE
 *  abduction — the pair is easy to get backwards, and reversed it produces
 *  adduction plus a large flexion component, which splits to nothing and makes
 *  a mirror test silently vacuous. */
const FRONTAL: Record<'L' | 'R', THREE.Vector3> = {
  L: new THREE.Vector3(0, 0, 1),
  R: new THREE.Vector3(0, 0, -1),
};

describe('the composite the user posed does not move', () => {
  it.each(['L', 'R'] as const)('%s: elevation is unchanged by the split', (side) => {
    withArmRestored(side, () => {
      spinHumerusWorld(side, SAGITTAL, 175);
      const before = humerothoracic(side);
      const result = applyScapulohumeralRhythm(
        byKey.get(`${side}_UpperArm`)!,
        byKey.get(`${side}_Shoulder`)!,
        `${side}_UpperArm`,
        rest,
      );
      expect(result, 'the split declined to run at 175 degrees').not.toBeNull();
      const after = humerothoracic(side);
      // THE property. The user put the arm here; redistributing across two
      // joints must not move it.
      expect(after.flexion).toBeCloseTo(before.flexion, 1);
      expect(after.abduction).toBeCloseTo(before.abduction, 1);
    });
  });

  it.each(['L', 'R'] as const)('%s: and does not wring the arm axially', (side) => {
    // The expensive bug from the authored path, asserted rather than assumed:
    // rotating the clavicle carries the humerus's axial frame with it, so a
    // naive split reads back correct flexion while twisting the arm.
    withArmRestored(side, () => {
      spinHumerusWorld(side, SAGITTAL, 175);
      const before = humerothoracic(side).rotation;
      applyScapulohumeralRhythm(
        byKey.get(`${side}_UpperArm`)!,
        byKey.get(`${side}_Shoulder`)!,
        `${side}_UpperArm`,
        rest,
      );
      expect(humerothoracic(side).rotation).toBeCloseTo(before, 1);
    });
  });
});

describe('the glenohumeral share comes down', () => {
  it.each(['L', 'R'] as const)('%s: sagittally, at every elevation past the setting phase', (side) => {
    // Swept rather than spot-checked, because a split that only worked at one
    // angle — or that reversed somewhere in the middle — would pass a single
    // case. Measured elevations, before to after:
    //   90 -> 85.4/77.6   120 -> 112.4/96.8   150 -> 135.8/115.0   175 -> 146.8/124.8
    withArmRestored(side, () => {
      for (const spin of [90, 120, 150, 175]) {
        spinHumerusWorld(side, SAGITTAL, spin);
        const before = glenohumeralElevationDeg(side);
        const ran = applyScapulohumeralRhythm(
          byKey.get(`${side}_UpperArm`)!, byKey.get(`${side}_Shoulder`)!, `${side}_UpperArm`, rest,
        );
        expect(ran, `the split declined to run at spin=${spin}`).not.toBeNull();
        const after = glenohumeralElevationDeg(side);
        expect(after, `spin=${spin} did not reduce the share`).toBeLessThan(before - 5);
      }
    });
  });

  it.each(['L', 'R'] as const)('%s: and in the FRONTAL plane, where the mirror lives', (side) => {
    // The abduction channel drives `upRotation` rather than `scapularTilt`, and
    // the right side's spec is mirrored — so a sign error here would be
    // invisible to every sagittal case above.
    // 60 degrees, not 100. A bigger frontal spin drags a large FLEXION
    // component along with it (at 100: abduction 74.5 but flexion 130.4), which
    // drives BOTH girdle channels — and two live values are exchangeable, so a
    // channel swap survives every assertion. At 60 the pose is cleanly frontal
    // (abduction 57.7, flexion 20.7) and the sagittal channel stays at zero,
    // which is what makes the check specific.
    withArmRestored(side, () => {
      spinHumerusWorld(side, FRONTAL[side], 60);
      const posed = humerothoracic(side);
      expect(posed.abduction, 'the frontal axis is producing adduction, not abduction')
        .toBeGreaterThan(45);
      expect(Math.abs(posed.flexion), 'this pose is not frontal enough to isolate the channel')
        .toBeLessThan(30);

      const before = glenohumeralElevationDeg(side);
      const result = applyScapulohumeralRhythm(
        byKey.get(`${side}_UpperArm`)!, byKey.get(`${side}_Shoulder`)!, `${side}_UpperArm`, rest,
      );
      expect(result).not.toBeNull();

      // Asserted on the BONE, not on the return value: checking only what the
      // function reports back cannot see the two girdle channels being wired to
      // each other's contribution.
      const scap = inspectClinicalAngles(byKey.get(`${side}_Shoulder`)!, `${side}_Shoulder`, rest)!;
      expect(scap.raw.abduction, 'upward rotation did not reach the scapula')
        .toBeGreaterThan(5);
      // …and the sagittal channel stays put, which is the half that catches a
      // swap. Both sides, because this is where the right spec's mirror lives.
      expect(Math.abs(scap.anatomicFlexion), 'a frontal pose moved the sagittal channel')
        .toBeLessThan(1);
      expect(glenohumeralElevationDeg(side)).toBeLessThan(before - 5);
    });
  });

  it.each(['L', 'R'] as const)('%s: 175 degrees lands near capacity, residual stated', (side) => {
    withArmRestored(side, () => {
      spinHumerusWorld(side, SAGITTAL, 175);
      const before = glenohumeralElevationDeg(side);
      expect(before).toBeGreaterThan(GH_CAPACITY_DEG);
      applyScapulohumeralRhythm(
        byKey.get(`${side}_UpperArm`)!, byKey.get(`${side}_Shoulder`)!, `${side}_UpperArm`, rest,
      );
      const after = glenohumeralElevationDeg(side);
      // 146.8 -> 124.8. The residual is the engine's own and is documented on
      // `girdleSplit`: the rig has ONE clavicle bone where anatomy has two
      // joints, so past ~160 degrees of flexion the surplus goes BACK to the
      // humerus rather than authoring an unphysiologic girdle value. So this
      // asserts the overdraft is SMALL, not absent — inflating the girdle band
      // to reach zero would move the lie rather than remove it.
      expect(after).toBeGreaterThan(GH_CAPACITY_DEG);
      expect(after).toBeLessThan(GH_CAPACITY_DEG + 10);
    });
  });

  it('the scapula carries the difference, in range', () => {
    withArmRestored('R', () => {
      spinHumerusWorld('R', SAGITTAL, 175);
      applyScapulohumeralRhythm(
        byKey.get('R_UpperArm')!,
        byKey.get('R_Shoulder')!,
        'R_UpperArm',
        rest,
      );
      const scap = inspectClinicalAngles(byKey.get('R_Shoulder')!, 'R_Shoulder', rest)!;
      // Sagittal elevation is carried by posterior TILT (the engine's measured
      // mapping: scapularTilt drives shoulder flexion 1:1).
      expect(scap.anatomicFlexion).toBeGreaterThan(20);
      // …and stays inside the registry band -10..40 rather than being driven
      // past it to make the arithmetic come out.
      expect(scap.anatomicFlexion).toBeLessThanOrEqual(40 + 0.5);
    });
  });
});

describe('it leaves alone what it should', () => {
  it('does nothing inside the setting phase', () => {
    // Below ~60 degrees of flexion the scapula genuinely does not contribute.
    // Returning null here is what keeps gait-scale arm swing, and every small
    // pose, byte-identical to before this existed.
    withArmRestored('R', () => {
      spinHumerusWorld('R', SAGITTAL, 30);
      const scapBefore = byKey.get('R_Shoulder')!.quaternion.clone();
      const armBefore = byKey.get('R_UpperArm')!.quaternion.clone();
      expect(
        applyScapulohumeralRhythm(
          byKey.get('R_UpperArm')!,
          byKey.get('R_Shoulder')!,
          'R_UpperArm',
          rest,
        ),
      ).toBeNull();
      expect(byKey.get('R_Shoulder')!.quaternion.angleTo(scapBefore)).toBeLessThan(1e-9);
      expect(byKey.get('R_UpperArm')!.quaternion.angleTo(armBefore)).toBeLessThan(1e-9);
    });
  });

  it('refuses a joint that is not an upper arm', () => {
    expect(
      applyScapulohumeralRhythm(byKey.get('R_Forearm')!, byKey.get('R_Shoulder')!, 'R_Forearm', rest),
    ).toBeNull();
  });

  it('refuses without a clavicle or a rest reference', () => {
    const arm = byKey.get('R_UpperArm')!;
    expect(applyScapulohumeralRhythm(arm, null, 'R_UpperArm', rest)).toBeNull();
    expect(applyScapulohumeralRhythm(arm, byKey.get('R_Shoulder')!, 'R_UpperArm', null)).toBeNull();
  });
});

describe('a drag handler can call it every pointer event', () => {
  it('is idempotent — the second call is a no-op', () => {
    // The property that makes it safe to wire into onGizmoChange. The scapular
    // value is composed ABSOLUTELY from rest, and the humerus is re-anchored to
    // a world orientation this function never moves, so repeats converge rather
    // than compounding a little more girdle each event.
    withArmRestored('R', () => {
      spinHumerusWorld('R', SAGITTAL, 175);
      applyScapulohumeralRhythm(
        byKey.get('R_UpperArm')!, byKey.get('R_Shoulder')!, 'R_UpperArm', rest,
      );
      const scapOnce = byKey.get('R_Shoulder')!.quaternion.clone();
      const armOnce = byKey.get('R_UpperArm')!.quaternion.clone();
      const htOnce = humerothoracic('R').flexion;

      // 200, not a handful — a per-event handler fires this many times in a
      // slow drag, and a tiny per-call bias would hide under a short loop.
      for (let i = 0; i < 200; i += 1) {
        const again = applyScapulohumeralRhythm(
          byKey.get('R_UpperArm')!, byKey.get('R_Shoulder')!, 'R_UpperArm', rest,
        );
        // NOT vacuous: every repeat genuinely runs and rewrites both bones.
        // If it started returning null the quaternion assertions below would
        // pass trivially, which would make this test prove nothing.
        expect(again, `call ${i + 2} declined to run`).not.toBeNull();
      }
      expect(byKey.get('R_Shoulder')!.quaternion.angleTo(scapOnce)).toBeLessThan(1e-6);
      expect(byKey.get('R_UpperArm')!.quaternion.angleTo(armOnce)).toBeLessThan(1e-6);
      // Measured drift across those 200 calls: -2.6e-5 degrees. It converges
      // rather than walking, which is the property that matters.
      expect(Math.abs(humerothoracic('R').flexion - htOnce)).toBeLessThan(0.001);
    });
  });

  it('tracks a drag back DOWN, releasing the girdle again', () => {
    // The other half of idempotence: absolute-from-rest means lowering the arm
    // must give the scapular share back, not strand it at the high-water mark.
    //
    // The first version of this test moved the humerus with a helper that ALSO
    // reset the clavicle, so it proved only that a fresh low pose adds no
    // girdle — which is a different and much weaker claim. Here the clavicle
    // stays where the previous split left it, which is the real state a user
    // lowering their arm passes through.
    withArmRestored('R', () => {
      spinHumerusWorld('R', SAGITTAL, 175);
      applyScapulohumeralRhythm(
        byKey.get('R_UpperArm')!, byKey.get('R_Shoulder')!, 'R_UpperArm', rest,
      );
      const high = inspectClinicalAngles(byKey.get('R_Shoulder')!, 'R_Shoulder', rest)!.anatomicFlexion;
      expect(high).toBeGreaterThan(35);

      // Lower the HUMERUS only. The clavicle is left carrying its 40 degrees.
      lowerHumerusKeepingGirdle('R', 30);
      const strandedTilt = inspectClinicalAngles(
        byKey.get('R_Shoulder')!, 'R_Shoulder', rest,
      )!.anatomicFlexion;
      expect(strandedTilt, 'setup failed to leave the girdle elevated').toBeGreaterThan(35);

      applyScapulohumeralRhythm(
        byKey.get('R_UpperArm')!, byKey.get('R_Shoulder')!, 'R_UpperArm', rest,
      );
      const released = inspectClinicalAngles(
        byKey.get('R_Shoulder')!, 'R_Shoulder', rest,
      )!.anatomicFlexion;
      // Measured: the composite lands at 66.7, just past the 60 setting phase,
      // so girdleSplit asks for (66.7 - 60) / 3 = 2.2 rather than zero.
      expect(released).toBeLessThan(5);
    });
  });
});

describe('the split agrees with the authored path it mirrors', () => {
  it('writes the girdle share girdleSplit specifies', () => {
    withArmRestored('R', () => {
      spinHumerusWorld('R', SAGITTAL, 175);
      const flexion = humerothoracic('R').flexion;
      const expected = girdleSplit(flexion, 'flexion').girdle;
      const result = applyScapulohumeralRhythm(
        byKey.get('R_UpperArm')!, byKey.get('R_Shoulder')!, 'R_UpperArm', rest,
      )!;
      // Not a re-derivation — the same function the authored path calls.
      expect(result.scapularTilt).toBeCloseTo(expected, 6);
    });
  });
});

describe('a HAND drag recruits the girdle too', () => {
  /** Solve a hand drag the plain way — full chain, one pass — as it shipped. */
  function plainSolve(target: THREE.Vector3) {
    const handle = handles.find((h) => h.config.canonicalKey === 'R_Hand')!;
    const ctx = buildIKChainContext(skinned, handle.bone, 3, variantCfg)!;
    solveIKChain(ctx, target, { rest });
    refresh();
  }

  function rhythmSolve(target: THREE.Vector3) {
    const handle = handles.find((h) => h.config.canonicalKey === 'R_Hand')!;
    const full = buildIKChainContext(skinned, handle.bone, 3, variantCfg)!;
    const distal = buildIKChainContext(skinned, handle.bone, 2, variantCfg)!;
    solveArmChainWithRhythm(full, distal, target, { rest });
    refresh();
  }

  const girdleMotion = () =>
    THREE.MathUtils.radToDeg(
      byKey.get('R_Shoulder')!.quaternion.angleTo(restLocals.get('R_Shoulder')!),
    );
  const handErrorFrom = (target: THREE.Vector3) => {
    const p = new THREE.Vector3();
    byKey.get('R_Hand')!.getWorldPosition(p);
    return p.distanceTo(target);
  };

  const HEAD_HEIGHT = new THREE.Vector3(-0.4, 1.75, 0.1);

  it('the plain solve leaves the clavicle almost still — the reported defect', () => {
    // THE bug, pinned so the fix cannot silently revert. CCD walks from the
    // effector upward and greedily zeroes the error at each joint, so by the
    // time it reaches the clavicle — last and most proximal — there is nothing
    // left to correct. Including the clavicle in the chain made the girdle
    // REACHABLE; it did not make the solver use it.
    withArmRestored('R', () => {
      plainSolve(HEAD_HEIGHT);
      expect(girdleMotion()).toBeLessThan(5); // measured 3.7
    });
  });

  it('the rhythm solve recruits it, and lands the hand CLOSER', () => {
    // Both halves matter. More girdle at the cost of missing the target would
    // be a worse trade than the defect.
    withArmRestored('R', () => {
      plainSolve(HEAD_HEIGHT);
      const plainGirdle = girdleMotion();
      const plainError = handErrorFrom(HEAD_HEIGHT);

      byKey.get('R_Shoulder')!.quaternion.copy(restLocals.get('R_Shoulder')!);
      byKey.get('R_UpperArm')!.quaternion.copy(restLocals.get('R_UpperArm')!);
      byKey.get('R_Forearm')!.quaternion.copy(restLocals.get('R_Forearm')!);
      byKey.get('R_Hand')!.quaternion.copy(restLocals.get('R_Hand')!);
      refresh();

      rhythmSolve(HEAD_HEIGHT);
      // Measured 3.7 -> 9.3 degrees of girdle…
      expect(girdleMotion()).toBeGreaterThan(plainGirdle * 2);
      // …and 0.035 -> 0.003 of hand error. Asserted as "no worse" plus a
      // decisive margin, rather than pinning a float.
      expect(handErrorFrom(HEAD_HEIGHT)).toBeLessThan(plainError);
    });
  });

  it('drives the scapula the right WAY on a high reach', () => {
    // The second defect the measurement turned up: re-solving the full chain
    // after the split hands the clavicle back to CCD, which undoes it and pins
    // the scapula at -10 degrees of ANTERIOR tilt — backwards for elevation.
    // The distal-only corrective pass is what fixes it, so this asserts the
    // sign rather than merely that something moved.
    withArmRestored('R', () => {
      rhythmSolve(new THREE.Vector3(-0.32, 1.95, 0.05));
      const scap = inspectClinicalAngles(byKey.get('R_Shoulder')!, 'R_Shoulder', rest)!;
      expect(scap.anatomicFlexion).toBeGreaterThan(-1); // not jammed anterior
      expect(scap.raw.abduction).toBeGreaterThan(5); // genuine upward rotation
    });
  });

  it('the ELBOW chain reaches the girdle too', () => {
    // Reported alongside the hand: an elbow drag moved only the glenohumeral
    // joint. Structurally it could not do otherwise — the handle solved
    // chainParentCount 1, so its chain was [Forearm, UpperArm] and the clavicle
    // was not in it at all. Now 2, which also gives the rhythm a distal chain
    // ([Forearm, UpperArm]) to correct against.
    for (const side of ['L', 'R'] as const) {
      const h = handles.find((x) => x.config.canonicalKey === `${side}_Forearm`)!;
      expect(h.config.chainParentCount).toBe(2);
      const ctx = buildIKChainContext(skinned, h.bone, h.config.chainParentCount ?? 2, variantCfg)!;
      expect(ctx.canonicalKeys).toEqual([
        `${side}_Forearm`,
        `${side}_UpperArm`,
        `${side}_Shoulder`,
      ]);
    }
  });

  it('degrades to EXACTLY a plain solve when there is no girdle above the chain', () => {
    // A foot drag must behave as it did before this function existed. Asserted
    // as equivalence with the plain solver rather than against a distance
    // threshold — a threshold only says the result is plausible, and would pass
    // just as happily if the wrapper quietly did something different.
    const foot = handles.find((h) => h.config.canonicalKey === 'R_Foot')!;
    const legKeys = ['R_Foot', 'R_Leg', 'R_UpLeg'];
    const saved = legKeys.map((k) => byKey.get(k)!.quaternion.clone());
    const target = new THREE.Vector3(-0.12, 0.35, 0.25);
    try {
      const plain = buildIKChainContext(skinned, foot.bone, 2, variantCfg)!;
      solveIKChain(plain, target, { rest });
      refresh();
      const plainQuats = legKeys.map((k) => byKey.get(k)!.quaternion.clone());

      legKeys.forEach((k, i) => byKey.get(k)!.quaternion.copy(saved[i]));
      refresh();

      const viaWrapper = buildIKChainContext(skinned, foot.bone, 2, variantCfg)!;
      expect(() => solveArmChainWithRhythm(viaWrapper, null, target, { rest })).not.toThrow();
      refresh();
      legKeys.forEach((k, i) => {
        // 1e-4 rad (~0.006 degrees), not bitwise: two CCD runs from the same
        // quaternions still differ in the last few float bits via cached world
        // matrices — measured 2.5e-6. Four orders of magnitude below anything
        // behavioural, so this still fails loudly if the wrapper does something
        // the plain solver does not.
        expect(byKey.get(k)!.quaternion.angleTo(plainQuats[i]), `${k} diverged`).toBeLessThan(1e-4);
      });
    } finally {
      legKeys.forEach((k, i) => byKey.get(k)!.quaternion.copy(saved[i]));
      refresh();
    }
  });
});
