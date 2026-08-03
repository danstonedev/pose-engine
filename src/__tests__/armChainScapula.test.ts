/**
 * The hand's IK chain reaches the scapula, and the scapula stays in range.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The rig's lineage above the hand is
 *   R_Hand → R_Forearm → R_Upperarm → R_Clavicle [R_Shoulder] → Spine02
 * and the hand handle solved `chainParentCount: 2` — Hand, Forearm, UpperArm.
 * The clavicle was the very next parent and was excluded, so dragging a hand
 * produced GLENOHUMERAL motion only: no scapular upward rotation, no
 * protraction. Real overhead elevation is roughly 2:1 glenohumeral to
 * scapulothoracic, so the last third of the range had nowhere to come from and
 * the shoulder hit its limit in a position no shoulder can make.
 *
 * The LEG is the control that makes this a gap rather than a design choice: its
 * chain already reaches the most proximal segment that has a handle. The arm's
 * did not.
 *
 * ── Why the chain change needed the clamp first ─────────────────────────────
 *
 * CCD will rotate every bone in the chain toward the target. Adding the
 * clavicle to a chain where the clavicle had no ROM strategy would have let the
 * solver swing the shoulder girdle anywhere it liked — a worse artifact than
 * the one being fixed. `poseRomClamp` gained L_/R_Shoulder in the same change,
 * and this file measures that the bound actually holds during a solve.
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
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { RomScenarioConstraints } from '../services/romConstraints';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let byKey: Map<string, THREE.Bone>;
let handles: ReturnType<typeof resolvePoseHandles>;

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
});

function chainOf(canonicalKey: string): string[] {
  const handle = handles.find((h) => h.config.canonicalKey === canonicalKey)!;
  const ctx = buildIKChainContext(
    skinned,
    handle.bone,
    handle.config.chainParentCount ?? 2,
    variantCfg,
  )!;
  return ctx.canonicalKeys.map((k, i) => k ?? ctx.bones[i].name);
}

/** Canonical key of the bone directly above one, or its raw name. */
function parentKeyOf(canonicalKey: string): string {
  const inverse = new Map<THREE.Bone, string>();
  for (const [k, b] of byKey) inverse.set(b, k);
  const parent = byKey.get(canonicalKey)!.parent as THREE.Bone;
  return inverse.get(parent) ?? parent.name;
}

/** Restore the whole arm after a solve, so cases stay independent. */
function withArmRestored(side: 'L' | 'R', run: () => void): void {
  const keys = [`${side}_Hand`, `${side}_Forearm`, `${side}_UpperArm`, `${side}_Shoulder`];
  const saved = keys.map((k) => byKey.get(k)!.quaternion.clone());
  try {
    run();
  } finally {
    keys.forEach((k, i) => byKey.get(k)!.quaternion.copy(saved[i]));
    skinned.skeleton.bones[0].parent?.updateMatrixWorld(true);
  }
}

describe('the hand chain reaches the scapula', () => {
  it.each(['L', 'R'] as const)('%s_Hand solves through the clavicle', (side) => {
    expect(chainOf(`${side}_Hand`)).toEqual([
      `${side}_Hand`,
      `${side}_Forearm`,
      `${side}_UpperArm`,
      `${side}_Shoulder`,
    ]);
  });

  it('stops at the girdle, where the limb ends and the trunk begins', () => {
    // Each chain now reaches its limb's most proximal segment. What sits above
    // is no longer part of the limb: above the thigh is the pelvis (the root,
    // no handle), and above the scapula is the SPINE — a trunk control with its
    // own handles, which a hand drag should not be reaching into.
    expect(parentKeyOf(chainOf('R_Foot').at(-1)!)).toBe('CC_Base_Pelvis');
    expect(parentKeyOf(chainOf('R_Hand').at(-1)!)).toBe('Spine_Upper');
    // The gap this closes: before, the bone above the arm chain was the
    // scapula, which is unambiguously part of the shoulder.
    expect(chainOf('R_Hand')).toContain('R_Shoulder');
  });
});

describe('the solver keeps the scapula inside its clinical range', () => {
  it.each(['L', 'R'] as const)('%s: an unreachable overhead target does not fling it', (side) => {
    // Without a clamp strategy on the clavicle, CCD reaching for a target it
    // cannot hit would keep winding the girdle. The target here is deliberately
    // far out of reach.
    withArmRestored(side, () => {
      const handle = handles.find((h) => h.config.canonicalKey === `${side}_Hand`)!;
      const ctx = buildIKChainContext(skinned, handle.bone, 3, variantCfg)!;
      solveIKChain(ctx, new THREE.Vector3(side === 'L' ? 2 : -2, 4, 0), { rest });
      byKey.get(`${side}_Shoulder`)!.updateMatrixWorld(true);

      const report = inspectClinicalAngles(byKey.get(`${side}_Shoulder`)!, `${side}_Shoulder`, rest)!;
      // Registry: upRotation -5..60, scapularTilt -10..40, protraction -30..30.
      // Half a degree of slack for the quaternion round-trip, nothing more.
      expect(report.raw.abduction).toBeLessThanOrEqual(60 + 0.5);
      expect(report.raw.abduction).toBeGreaterThanOrEqual(-5 - 0.5);
      expect(report.anatomicFlexion).toBeLessThanOrEqual(40 + 0.5);
      expect(report.anatomicFlexion).toBeGreaterThanOrEqual(-10 - 0.5);
      expect(Math.abs(report.raw.rotation)).toBeLessThanOrEqual(30 + 0.5);
    });
  });

  it('actually moves the scapula, rather than clamping it to nothing', () => {
    // The other failure mode: a clamp so tight the new chain link contributes
    // zero would leave the behaviour exactly as it was, silently.
    withArmRestored('R', () => {
      const before = inspectClinicalAngles(byKey.get('R_Shoulder')!, 'R_Shoulder', rest)!;
      const handle = handles.find((h) => h.config.canonicalKey === 'R_Hand')!;
      const ctx = buildIKChainContext(skinned, handle.bone, 3, variantCfg)!;
      solveIKChain(ctx, new THREE.Vector3(-0.3, 2.1, 0.1), { rest });
      byKey.get('R_Shoulder')!.updateMatrixWorld(true);
      const after = inspectClinicalAngles(byKey.get('R_Shoulder')!, 'R_Shoulder', rest)!;

      const moved =
        Math.abs(after.raw.abduction - before.raw.abduction) +
        Math.abs(after.anatomicFlexion - before.anatomicFlexion) +
        Math.abs(after.raw.rotation - before.raw.rotation);
      expect(moved).toBeGreaterThan(1);
    });
  });
});

describe('per-patient ROM constraints reach the drag paths', () => {
  it('narrows a chain joint during an IK solve', () => {
    // Previously impossible: `solveIKChain` had nowhere to put constraints, so
    // a hand DRAG clamped to normative ROM while the same joint rotated by
    // gizmo honoured the patient's — the same limb bounded two different ways
    // depending on which control was used.
    const ELBOW_CAP = 40;
    const constraints: RomScenarioConstraints = {
      R_Forearm: { elbowFlexion: { availableRange: { max: ELBOW_CAP } } },
    };

    const flexAfterSolve = (c: RomScenarioConstraints | null) => {
      let value = Number.NaN;
      withArmRestored('R', () => {
        const handle = handles.find((h) => h.config.canonicalKey === 'R_Hand')!;
        const ctx = buildIKChainContext(skinned, handle.bone, 3, variantCfg)!;
        // A target close to the shoulder forces the elbow to bend hard.
        solveIKChain(ctx, new THREE.Vector3(-0.12, 1.45, 0.05), { rest, constraints: c });
        byKey.get('R_Forearm')!.updateMatrixWorld(true);
        value = inspectClinicalAngles(byKey.get('R_Forearm')!, 'R_Forearm', rest)!.anatomicFlexion;
      });
      return value;
    };

    const normative = flexAfterSolve(null);
    const capped = flexAfterSolve(constraints);

    // Unconstrained, this target drives the elbow past 110 degrees — so the
    // comparison below is against a solve that genuinely wanted to exceed the
    // cap, not one that happened to stay under it.
    expect(normative).toBeGreaterThan(100);
    // Constrained, it lands NEAR the cap rather than exactly on it, and that
    // residual is the engine's, not the constraint's: a hinge is clamped in
    // WORLD terms, and CCD walks from the effector upward, so the forearm is
    // clamped before its own parents move in the same pass. Clamping the same
    // bone directly (no solve) hits 40.00 exactly. A few degrees of overshoot
    // is the pre-existing property; ~70 degrees of overshoot would mean the
    // constraint never arrived.
    expect(capped).toBeLessThan(ELBOW_CAP + 6);
    expect(normative - capped).toBeGreaterThan(60);
  });
});
