import * as THREE from 'three';
import {
  normalizeBoneNameForVariant,
  type BodyVariantConfig,
  type PoseRigConfig,
  type PoseRigHandle,
} from '../anatomy/bodyVariants';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';
import {
  localAxisTowardBodyLeft,
  swingTwistDecompose,
  signedAngleAboutAxis,
  type JointAngleRestReference,
} from './jointAngles';
import { clampBoneToRom } from './poseRomClamp';

/** Optional ROM-clamp metadata threaded through pose manipulators. When
 *  present, every bone write is clamped to clinical range-of-motion limits
 *  defined in `romRegistry.ts`. When omitted, the manipulators behave as
 *  before. */
export interface PoseClampOptions {
  rest: JointAngleRestReference | null | undefined;
  /** For FK swings: canonical key of the bone being moved. */
  canonicalKey?: string | null;
}

/** Maps canonical pose-rig keys (e.g. 'L_Hand') to the actual SkinnedMesh
 *  bone via the variant's bone-name map (currently CC-only). */
export function buildBoneByPoseKey(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
): Map<string, THREE.Bone> {
  const map = new Map<string, THREE.Bone>();
  for (const bone of skeleton.bones) {
    const norm = normalizeBoneNameForVariant(bone.name, variantCfg.boneNameMap);
    if (!norm.canonical) continue;
    const sidePrefix = norm.side === 'Left' ? 'L_' : norm.side === 'Right' ? 'R_' : '';
    map.set(`${sidePrefix}${norm.canonical}`, bone);
  }
  return map;
}

const _curveDelta = new THREE.Quaternion();
const _curveShare = new THREE.Quaternion();
const _curveInv = new THREE.Quaternion();

/** Distribute a control bone's local rotation evenly across a chain of segments
 *  so the chain bends as one smooth arc instead of kinking at a single joint
 *  (e.g. a "trunk curve" spreading a bend across lumbar→thoracic spine bones).
 *  `controlTarget` is the local quaternion a gizmo produced for the control
 *  segment; its delta-from-rest is split into `1/segments.length` slices and each
 *  segment is set to (its rest local) × that slice. Assumes the segments share a
 *  roughly common local frame, which holds for stacked spine/neck bones. */
export function distributeChainCurve(
  segments: THREE.Object3D[],
  restLocals: THREE.Quaternion[],
  controlIndex: number,
  controlTarget: THREE.Quaternion,
): void {
  if (segments.length === 0 || segments.length !== restLocals.length) return;
  _curveInv.copy(restLocals[controlIndex]).invert();
  _curveDelta.copy(_curveInv).multiply(controlTarget); // control's delta-from-rest
  _curveShare.identity().slerp(_curveDelta, 1 / segments.length);
  for (let i = 0; i < segments.length; i++) {
    segments[i].quaternion.copy(restLocals[i]).multiply(_curveShare);
  }
}

// Every rig bone's child sits at +Y, so a segment's axial twist (pronation/
// supination on the forearm + hand) is rotation about its own +Y long axis.
const _twAxis = new THREE.Vector3(0, 1, 0);
const _twDelta = new THREE.Quaternion();
const _twSwing = new THREE.Quaternion();
const _twTwist = new THREE.Quaternion();
const _twNew = new THREE.Quaternion();
const _twRestInv = new THREE.Quaternion();

/** Read a bone-local quaternion's axial twist (radians, right-handed about +Y)
 *  relative to its rest local — the pronation/supination measure that lives on
 *  the forearm and hand long axis. Swing (flexion / deviation) is discarded. */
export function readAxialTwist(local: THREE.Quaternion, restLocal: THREE.Quaternion): number {
  _twRestInv.copy(restLocal).invert();
  _twDelta.copy(_twRestInv).multiply(local);
  swingTwistDecompose(_twDelta, _twAxis, _twSwing, _twTwist);
  return signedAngleAboutAxis(_twTwist, _twAxis);
}

/** Set a bone's axial twist about +Y to `angleRad`, preserving its current
 *  swing (flexion / deviation) — the inverse of {@link readAxialTwist}. Used to
 *  drive coupled forearm↔hand pro/sup: write the same per-segment twist to both
 *  bones without disturbing elbow flexion or wrist flex/dev. */
export function setAxialTwist(
  bone: THREE.Object3D,
  restLocal: THREE.Quaternion,
  angleRad: number,
): void {
  _twRestInv.copy(restLocal).invert();
  _twDelta.copy(_twRestInv).multiply(bone.quaternion);
  swingTwistDecompose(_twDelta, _twAxis, _twSwing, _twTwist);
  _twNew.setFromAxisAngle(_twAxis, angleRad);
  _twDelta.copy(_twSwing).multiply(_twNew);
  bone.quaternion.copy(restLocal).multiply(_twDelta);
}

const _pinParent = new THREE.Quaternion();

/** Re-seat each bone's LOCAL rotation so its WORLD orientation equals the given
 *  rest world quaternion — keeps distal segments planted while an ancestor moves
 *  (e.g. the legs stay put during a pelvic tilt that rotates the body root).
 *  The caller must have refreshed the parents' world matrices first. */
export function pinBonesToRestWorld(
  bones: THREE.Object3D[],
  restWorlds: THREE.Quaternion[],
): void {
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    if (!b.parent || !restWorlds[i]) continue;
    b.parent.getWorldQuaternion(_pinParent);
    b.quaternion.copy(_pinParent.invert()).multiply(restWorlds[i]);
  }
}

/** Apply a stored custom pose by writing each entry's local quaternion (and
 *  optional local position) onto the matching bone. Skips entries whose bone
 *  can't be resolved (e.g. pose was saved against a different variant).
 *  Returns the number of bones successfully updated. */
export function applyCustomPose(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  pose: CustomPose | null | undefined,
): number {
  if (!pose || !pose.bones) return 0;
  const lookup = buildBoneByPoseKey(skeleton, variantCfg);
  let applied = 0;
  for (const [key, q] of Object.entries(pose.bones)) {
    const bone = lookup.get(key);
    if (!bone) continue;
    bone.quaternion.set(q[0], q[1], q[2], q[3]);
    applied += 1;
  }
  if (pose.positions) {
    for (const [key, p] of Object.entries(pose.positions)) {
      const bone = lookup.get(key);
      if (!bone) continue;
      bone.position.set(p[0], p[1], p[2]);
    }
  }
  if (applied > 0 && skeleton.bones[0]?.parent) {
    skeleton.bones[0].parent.updateMatrixWorld(true);
  }
  return applied;
}

/** Read the current local quaternions for every rig handle bone (plus any
 *  bones implicitly modified by IK chains — those are inferred from the
 *  effector's chainParentCount). */
export function serializeCustomPose(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  variantId: string,
): CustomPose {
  const lookup = buildBoneByPoseKey(skeleton, variantCfg);
  const bones: Record<string, [number, number, number, number]> = {};
  const positions: Record<string, [number, number, number]> = {};

  // Walk every canonicalized bone in the skeleton — not just rig handles —
  // because IK chains modify Forearm/Leg too, and FK Hips drives every child
  // implicitly via parent transform but its own quaternion captures the move.
  for (const [key, bone] of lookup) {
    const q = bone.quaternion;
    bones[key] = [q.x, q.y, q.z, q.w];
    const p = bone.position;
    positions[key] = [p.x, p.y, p.z];
  }

  return { variant: variantId, bones, positions, schemaVersion: POSE_SCHEMA_VERSION };
}

/** Stable short hash used as a cache key for poseMeasurementCache. We round
 *  each component to 4 decimal places so floating-point noise doesn't bust
 *  the cache on micro-movements. */
export function hashCustomPose(pose: CustomPose | null | undefined): string {
  if (!pose || !pose.bones) return 'none';
  const boneKeys = Object.keys(pose.bones).sort();
  const posKeys = pose.positions ? Object.keys(pose.positions).sort() : [];
  if (boneKeys.length === 0 && posKeys.length === 0) return 'empty';
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (const key of boneKeys) {
    const q = pose.bones[key];
    const segment = `${key}:${q[0].toFixed(4)},${q[1].toFixed(4)},${q[2].toFixed(4)},${q[3].toFixed(4)};`;
    for (let i = 0; i < segment.length; i += 1) {
      h ^= segment.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
  }
  for (const key of posKeys) {
    const p = pose.positions![key];
    const segment = `p${key}:${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)};`;
    for (let i = 0; i < segment.length; i += 1) {
      h ^= segment.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
  }
  return h.toString(16);
}

/** Returns true if the pose has any actual override beyond the bone defaults
 *  (i.e. at least one bone's quaternion differs from identity-ish). Cheap
 *  emptiness check for "do we need to apply this on load". */
export function isCustomPoseEmpty(pose: CustomPose | null | undefined): boolean {
  if (!pose || !pose.bones) return true;
  return Object.keys(pose.bones).length === 0;
}

// ── Pose interpolation (used by history-timeline morphing) ─────────────────

const tmpBlendQuatA = new THREE.Quaternion();
const tmpBlendQuatB = new THREE.Quaternion();
const tmpBlendQuatOut = new THREE.Quaternion();
const tmpBlendVecA = new THREE.Vector3();
const tmpBlendVecB = new THREE.Vector3();
const tmpBlendVecOut = new THREE.Vector3();

function clamp01(t: number): number {
  if (!Number.isFinite(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

function copyPose(pose: CustomPose): CustomPose {
  const bones: Record<string, [number, number, number, number]> = {};
  for (const [key, q] of Object.entries(pose.bones)) {
    bones[key] = [q[0], q[1], q[2], q[3]];
  }
  const positions: Record<string, [number, number, number]> | undefined = pose.positions
    ? Object.fromEntries(
        Object.entries(pose.positions).map(([k, p]) => [k, [p[0], p[1], p[2]]]),
      )
    : undefined;
  return {
    variant: pose.variant,
    bones,
    ...(positions ? { positions } : {}),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}

/** Interpolate between two CustomPoses at parameter `t ∈ [0, 1]`.
 *
 *  Slerps bone quaternions and lerps bone positions for keys present on both
 *  sides; bones present on only one side are held at that side's value across
 *  the entire transition (no jolt back to anatomic mid-morph). The result is
 *  always stamped with the current `POSE_SCHEMA_VERSION` so downstream
 *  consumers (PainBody3D's customPose load-gate) accept it.
 *
 *  Returns `null` when both inputs are null/undefined — callers can use that
 *  to mean "no override, fall back to the variant's anatomic baseline". When
 *  exactly one side is null we snap to the target side instead of trying to
 *  invent an intermediate baseline pose: `from -> null` yields `null`, and
 *  `null -> to` yields `to`. When the two sides have different variants the
 *  `to` pose is returned unmodified — cross-variant interpolation isn't
 *  meaningful since bone counts and rest orientations differ. */
export function blendCustomPose(
  from: CustomPose | null | undefined,
  to: CustomPose | null | undefined,
  t: number,
): CustomPose | null {
  return blendCustomPosePerBone(from, to, () => t);
}

/** Like {@link blendCustomPose}, but the interpolation parameter is resolved
 *  PER BONE via `tForBone(poseKey)` instead of a single shared scalar. This is
 *  the primitive behind proximal-to-distal onset staggering: hips/spine can be
 *  further along their arc than fingers/toes at the same instant. `tForBone`
 *  MUST return 1 for every key at the segment endpoint so the pose still
 *  arrives exactly on target (keyframe boundaries and measurement stay exact).
 *  Positions interpolate at their own bone key's parameter too. */
export function blendCustomPosePerBone(
  from: CustomPose | null | undefined,
  to: CustomPose | null | undefined,
  tForBone: (poseKey: string) => number,
): CustomPose | null {
  if (!from && !to) return null;
  if (!from) return copyPose(to as CustomPose);
  if (!to) return null;

  // Cross-variant interpolation isn't meaningful (bone counts and rest
  // orientations differ) — snap to `to` regardless of t.
  if (from.variant !== to.variant) return copyPose(to);

  // No t=0 / t=1 fast paths: the union loop below handles those naturally
  // (slerp(_, 0) = a, slerp(_, 1) = b) AND keeps single-sided bones present
  // at the endpoints. Returning copyPose(from) at t=0 would silently drop
  // any bone that only exists on the `to` side until t crossed 0.

  const blendedBones: Record<string, [number, number, number, number]> = {};
  const fromBones = from.bones ?? {};
  const toBones = to.bones ?? {};
  const boneKeys = new Set<string>([...Object.keys(fromBones), ...Object.keys(toBones)]);
  for (const key of boneKeys) {
    const a = fromBones[key];
    const b = toBones[key];
    if (a && b) {
      const clamped = clamp01(tForBone(key));
      tmpBlendQuatA.set(a[0], a[1], a[2], a[3]);
      tmpBlendQuatB.set(b[0], b[1], b[2], b[3]);
      tmpBlendQuatOut.copy(tmpBlendQuatA);
      tmpBlendQuatOut.slerp(tmpBlendQuatB, clamped);
      blendedBones[key] = [
        tmpBlendQuatOut.x,
        tmpBlendQuatOut.y,
        tmpBlendQuatOut.z,
        tmpBlendQuatOut.w,
      ];
    } else if (a) {
      blendedBones[key] = [a[0], a[1], a[2], a[3]];
    } else if (b) {
      blendedBones[key] = [b[0], b[1], b[2], b[3]];
    }
  }

  let blendedPositions: Record<string, [number, number, number]> | undefined;
  const fromPositions = from.positions;
  const toPositions = to.positions;
  if (fromPositions || toPositions) {
    blendedPositions = {};
    const positionKeys = new Set<string>([
      ...Object.keys(fromPositions ?? {}),
      ...Object.keys(toPositions ?? {}),
    ]);
    for (const key of positionKeys) {
      const a = fromPositions?.[key];
      const b = toPositions?.[key];
      if (a && b) {
        const clamped = clamp01(tForBone(key));
        tmpBlendVecA.set(a[0], a[1], a[2]);
        tmpBlendVecB.set(b[0], b[1], b[2]);
        tmpBlendVecOut.lerpVectors(tmpBlendVecA, tmpBlendVecB, clamped);
        blendedPositions[key] = [tmpBlendVecOut.x, tmpBlendVecOut.y, tmpBlendVecOut.z];
      } else if (a) {
        blendedPositions[key] = [a[0], a[1], a[2]];
      } else if (b) {
        blendedPositions[key] = [b[0], b[1], b[2]];
      }
    }
  }

  return {
    variant: to.variant,
    bones: blendedBones,
    ...(blendedPositions ? { positions: blendedPositions } : {}),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}

/** Interpolate between two poses while treating `null` as a concrete
 *  full-skeleton baseline pose for display purposes. Callers still decide
 *  whether the settled endpoint should remain that baseline or collapse back
 *  to semantic `null` once the transition completes. */
export function blendCustomPoseWithBaseline(
  from: CustomPose | null | undefined,
  to: CustomPose | null | undefined,
  baseline: CustomPose | null | undefined,
  t: number,
): CustomPose | null {
  const effectiveFrom = from ?? baseline ?? null;
  const effectiveTo = to ?? baseline ?? null;
  return blendCustomPose(effectiveFrom, effectiveTo, t);
}

// ── FK swing-to-target (hoisted from PainBody3D.applyWorldDirectionTargets) ─

const tmpBoneWorldPos = new THREE.Vector3();
const tmpChildWorldPos = new THREE.Vector3();
const tmpCurrentDir = new THREE.Vector3();
const tmpTargetDir = new THREE.Vector3();
const tmpSwingQuat = new THREE.Quaternion();
const tmpCurrentWorldQuat = new THREE.Quaternion();
const tmpParentWorldQuat = new THREE.Quaternion();
const tmpNewWorldQuat = new THREE.Quaternion();

/** Rotate a single bone so that its long-axis (bone → first child) points
 *  toward `targetWorldPos`. Pure FK; no parent stability concerns because
 *  we operate one bone at a time. Mirrors the math in
 *  PainBody3D.applyWorldDirectionTargets but for a single ad-hoc bone.
 *
 *  When `clamp` is supplied, the resulting quaternion is clamped to the
 *  joint's clinical ROM (and for hinges, locked to a single axis). */
export function swingBoneToWorldTarget(
  bone: THREE.Bone,
  targetWorldPos: THREE.Vector3,
  clamp?: PoseClampOptions,
): boolean {
  const childBone =
    bone.children.find((c): c is THREE.Bone => (c as THREE.Bone).isBone === true) ??
    bone.children[0];
  if (!childBone) return false;

  bone.updateWorldMatrix(true, false);
  childBone.updateWorldMatrix(true, false);
  bone.getWorldPosition(tmpBoneWorldPos);
  childBone.getWorldPosition(tmpChildWorldPos);

  tmpCurrentDir.copy(tmpChildWorldPos).sub(tmpBoneWorldPos);
  if (tmpCurrentDir.lengthSq() < 1e-10) return false;
  tmpCurrentDir.normalize();

  tmpTargetDir.copy(targetWorldPos).sub(tmpBoneWorldPos);
  if (tmpTargetDir.lengthSq() < 1e-10) return false;
  tmpTargetDir.normalize();

  tmpSwingQuat.setFromUnitVectors(tmpCurrentDir, tmpTargetDir);
  bone.getWorldQuaternion(tmpCurrentWorldQuat);
  tmpNewWorldQuat.copy(tmpSwingQuat).multiply(tmpCurrentWorldQuat);

  if (bone.parent) {
    bone.parent.getWorldQuaternion(tmpParentWorldQuat);
    tmpParentWorldQuat.invert();
    bone.quaternion.copy(tmpParentWorldQuat).multiply(tmpNewWorldQuat);
  } else {
    bone.quaternion.copy(tmpNewWorldQuat);
  }

  if (clamp?.rest && clamp.canonicalKey) {
    clampBoneToRom(bone, clamp.canonicalKey, clamp.rest);
  }

  bone.updateMatrixWorld(true);
  return true;
}

// ── Self-contained CCD IK chain ────────────────────────────────────────────

/** Pre-built IK chain context. The chain is `[effector, parent, parent.parent, …]`
 *  with `chainParentCount + 1` bones total. We don't use Three's CCDIKSolver
 *  because it requires injecting a fake target bone into `skeleton.bones`,
 *  which then crashes `Skeleton.update()` on the next render. Our own CCD
 *  pass operates on world-space matrices and writes back local quaternions
 *  without touching the skeleton's bone list. */
export interface IKChainContext {
  /** Bones from effector → root, top index is the root-most chain link. */
  bones: THREE.Bone[];
  /** Per-bone canonical pose key (parallel to `bones`); `null` for bones
   *  that aren't surfaced as rig handles. Used to look up ROM clamps. */
  canonicalKeys: (string | null)[];
}

export function buildIKChainContext(
  skinnedMesh: THREE.SkinnedMesh,
  effector: THREE.Bone,
  chainParentCount: number,
  variantCfg?: BodyVariantConfig,
): IKChainContext | null {
  const bones: THREE.Bone[] = [effector];
  let cursor: THREE.Object3D | null = effector.parent;
  while (cursor && bones.length <= chainParentCount && (cursor as THREE.Bone).isBone) {
    bones.push(cursor as THREE.Bone);
    cursor = cursor.parent;
  }
  if (bones.length < 2) return null;
  const canonicalKeys: (string | null)[] = bones.map(() => null);
  if (variantCfg) {
    const lookup = buildBoneByPoseKey(skinnedMesh.skeleton, variantCfg);
    const inverseLookup = new Map<THREE.Bone, string>();
    for (const [key, bone] of lookup) inverseLookup.set(bone, key);
    for (let i = 0; i < bones.length; i += 1) {
      canonicalKeys[i] = inverseLookup.get(bones[i]) ?? null;
    }
  }
  return { bones, canonicalKeys };
}

const _ikIterations = 4;
const _ikEffectorWorld = new THREE.Vector3();
const _ikJointWorld = new THREE.Vector3();
const _ikJointWorldQuat = new THREE.Quaternion();
const _ikJointParentWorldQuat = new THREE.Quaternion();
const _ikToEffector = new THREE.Vector3();
const _ikToTarget = new THREE.Vector3();
const _ikSwingWorldQuat = new THREE.Quaternion();
const _ikInvParentWorldQuat = new THREE.Quaternion();
const _ikNewWorldQuat = new THREE.Quaternion();

/** Run a single CCD pass: walk from the joint nearest the effector up to the
 *  root, rotating each joint so its child chain points more directly at the
 *  target. Mutates each chain bone's local quaternion.
 *
 *  When `clamp.rest` is supplied, each chain bone is clamped to its ROM
 *  after the per-iteration write. The chain naturally settles on a best-
 *  effort pose when the target is unreachable — clinically accurate, since
 *  a hand that can't reach where you're dragging it shouldn't reach there. */
const _hingeRest = new THREE.Quaternion();
const _hingeRestInv = new THREE.Quaternion();
const _hingeDelta = new THREE.Quaternion();
const _hingeTwist = new THREE.Quaternion();

/** Constrain a joint's local rotation to a HINGE: keep only the component of its
 *  delta-from-rest that twists about `axisLocal`, discarding off-axis swing. Used
 *  in IK so a knee/elbow flexes/extends to compensate rather than picking up
 *  varus/valgus or axial rotation. (Swing-twist decomposition about the axis.) */
function constrainLocalToHinge(
  joint: THREE.Bone,
  restLocal: THREE.Quaternion,
  axisLocal: THREE.Vector3,
): void {
  _hingeRestInv.copy(restLocal).invert();
  _hingeDelta.copy(_hingeRestInv).multiply(joint.quaternion); // delta from rest
  const d = _hingeDelta.x * axisLocal.x + _hingeDelta.y * axisLocal.y + _hingeDelta.z * axisLocal.z;
  _hingeTwist.set(axisLocal.x * d, axisLocal.y * d, axisLocal.z * d, _hingeDelta.w);
  if (_hingeTwist.lengthSq() < 1e-8) _hingeTwist.identity();
  else _hingeTwist.normalize();
  joint.quaternion.copy(restLocal).multiply(_hingeTwist);
}

export function solveIKChain(
  ctx: IKChainContext,
  targetWorldPos: THREE.Vector3,
  clamp?: {
    rest: JointAngleRestReference | null | undefined;
    hinges?: Set<string>;
    /** Rest reference used ONLY to pick each hinge's LOCAL axis (defaults to
     *  `rest`). Needed when `rest` is a ROOT-ROTATED reference (a heading-yawed
     *  travel gait): the ROM clamps must decompose against the rotated world
     *  frame, but `localAxisTowardBodyLeft` quantizes the rest-world quat
     *  against world +X — feeding it a yawed rest would pick the wrong local
     *  axis (body-left is no longer world +X). Local axes are rotation
     *  invariant, so the ORIGINAL rest always names the correct one. */
    hingeAxisRest?: JointAngleRestReference | null;
  },
): void {
  const { bones, canonicalKeys } = ctx;
  const effector = bones[0];

  for (let iter = 0; iter < _ikIterations; iter += 1) {
    // bones[1] is the joint closest to the effector (e.g. wrist's parent).
    // bones[bones.length-1] is the root of the chain (e.g. UpperArm).
    for (let i = 1; i < bones.length; i += 1) {
      const joint = bones[i];
      joint.updateWorldMatrix(true, false);
      effector.updateWorldMatrix(true, false);

      joint.getWorldPosition(_ikJointWorld);
      effector.getWorldPosition(_ikEffectorWorld);

      _ikToEffector.copy(_ikEffectorWorld).sub(_ikJointWorld);
      _ikToTarget.copy(targetWorldPos).sub(_ikJointWorld);
      if (_ikToEffector.lengthSq() < 1e-10 || _ikToTarget.lengthSq() < 1e-10) continue;
      _ikToEffector.normalize();
      _ikToTarget.normalize();

      _ikSwingWorldQuat.setFromUnitVectors(_ikToEffector, _ikToTarget);
      joint.getWorldQuaternion(_ikJointWorldQuat);
      _ikNewWorldQuat.copy(_ikSwingWorldQuat).multiply(_ikJointWorldQuat);

      if (joint.parent) {
        joint.parent.getWorldQuaternion(_ikJointParentWorldQuat);
        _ikInvParentWorldQuat.copy(_ikJointParentWorldQuat).invert();
        joint.quaternion.copy(_ikInvParentWorldQuat).multiply(_ikNewWorldQuat);
      } else {
        joint.quaternion.copy(_ikNewWorldQuat);
      }

      const canonicalKey = canonicalKeys[i];
      // Hinge joints (knee/elbow) compensate by flexion only — strip off-axis
      // swing the free CCD introduced before clamping to ROM.
      if (clamp?.rest && canonicalKey && clamp.hinges?.has(canonicalKey)) {
        const restArr = clamp.rest.localQuats[canonicalKey];
        if (restArr) {
          _hingeRest.set(restArr[0], restArr[1], restArr[2], restArr[3]);
          constrainLocalToHinge(
            joint,
            _hingeRest,
            localAxisTowardBodyLeft((clamp.hingeAxisRest ?? clamp.rest).worldQuats[canonicalKey]),
          );
        }
      }
      if (clamp?.rest && canonicalKey) {
        clampBoneToRom(joint, canonicalKey, clamp.rest);
      }
      joint.updateMatrixWorld(true);
    }
  }
}

/** No-op cleanup — the CCD pass never allocates per-context resources. */
export function disposeIKChainContext(_ctx: IKChainContext): void {
  // Intentionally empty.
}

// ── Helpers for the dragging UX ────────────────────────────────────────────

/** For each rig handle, resolve the actual Bone in the current skeleton.
 *  Handles whose canonical key isn't present in the variant (e.g. variant
 *  doesn't expose a Spine_Mid bone) are silently dropped. */
export interface ResolvedPoseHandle {
  config: PoseRigHandle;
  bone: THREE.Bone;
}

export function resolvePoseHandles(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  rig: PoseRigConfig = variantCfg.poseRig,
): ResolvedPoseHandle[] {
  const lookup = buildBoneByPoseKey(skeleton, variantCfg);
  const out: ResolvedPoseHandle[] = [];
  for (const config of rig.handles) {
    const bone = lookup.get(config.canonicalKey);
    if (!bone) continue;
    out.push({ config, bone });
  }
  return out;
}
