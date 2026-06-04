/**
 * Clinical joint-angle measurement.
 *
 * Computes the angles a clinician expects (elbow flexion, shoulder
 * abduction, hip rotation, etc.) from the live three.js skeleton. All
 * measurements are made relative to the parent bone's frame (so e.g.
 * shoulder flexion stays meaningful when the trunk has been rotated),
 * except the Hips readout which is in world frame so an anteriorly
 * tilted pelvis registers as such no matter the camera.
 *
 * Body axis convention at anatomic position (matches `applyAnatomicPose`
 * in PainBody3D — verified by inspecting the worldDir vectors in
 * bodyVariants.ts):
 *
 *   superior  (head-up) = +Y
 *   anterior  (forward) = -Z
 *   subject's left      = +X     (subject's right = -X)
 *
 *   sagittal  plane = YZ      (normal +X)
 *   coronal   plane = XY      (normal +Z)
 *   transverse plane = XZ     (normal +Y)
 *
 * Sign convention (the side most worth recording):
 *   + flexion, + abduction (away from midline), + internal rotation,
 *   + lateral lean toward subject's left, + neck rotation toward subject's left
 *   (the negative direction is extension / adduction / external rotation /
 *    lean-right / look-right). The display layer can label them.
 *
 * Side handling: right-side joints are mirrored before reporting so a
 * symmetric pose reads symmetric numbers (right-leg flexion is positive
 * for hip flexion; right-arm abduction is positive for true abduction).
 *
 * The math is intentionally allocation-light — caller can poll on every
 * render frame in pose mode without GC pressure (it reuses module-level
 * scratch quaternions / vectors).
 */
import * as THREE from 'three';
import {
  normalizeBoneNameForVariant,
  type BodyVariantConfig,
} from '../anatomy/bodyVariants';

// ── Public types ───────────────────────────────────────────────────────────

/** Per-joint angle record. Keys are stable canonical names that match the
 *  ones display layers can label (e.g. 'elbowFlexion'). All values in
 *  degrees, signed per the convention above. */
export interface JointAngleSet {
  [angleName: string]: number;
}

/** Full clinical-angle report for one pose. Snapshot-able. */
export interface JointAngleReport {
  /** ISO timestamp of when the report was computed. */
  at: string;
  /** Body variant the report was computed against (so reviewer-side display
   *  knows which canonical-key set to expect). */
  variant: string;
  /** Per-joint angles, keyed by canonical bone key. */
  joints: Record<string, JointAngleSet>;
}

/** Snapshot of every rig bone's rest pose (post-applyAnatomicPose) in both
 *  world and parent-local space. Treat this as the "0° baseline" — every
 *  reported angle is measured as a delta from this reference, so the live
 *  anatomic position reads 0 everywhere (and the readouts only move when
 *  the user actually poses the model away from rest). */
export interface JointAngleRestReference {
  /** Rest world quaternion of the Hips bone — defines the pelvis "0,0,0"
   *  for the world-frame readout (option a). */
  pelvisWorldQuat: [number, number, number, number];
  /** Rest local quaternion per canonical bone key (used as the joint's
   *  parent-relative zero for everything except Hips). */
  localQuats: Record<string, [number, number, number, number]>;
  /** Rest world quaternion per canonical bone key. Used by the ROM-clamp
   *  module to decompose rotations in a canonical (world-aligned) frame
   *  where every bone's rest long axis aligns with `(0,-1,0)` regardless
   *  of how the GLB binds the bone-local frame. */
  worldQuats: Record<string, [number, number, number, number]>;
}

// ── Constants + scratch state ──────────────────────────────────────────────

const DEG = 180 / Math.PI;

/** Body axes in WORLD space at anatomic. */
const BODY_UP = new THREE.Vector3(0, 1, 0); // superior
const BODY_ANTERIOR = new THREE.Vector3(0, 0, -1); // forward
const BODY_LEFT = new THREE.Vector3(1, 0, 0); // subject's left

/** Module-level scratch — recycled across calls to avoid GC. */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e1 = new THREE.Euler();

// ── Math helpers ───────────────────────────────────────────────────────────

/** Swing-twist decomposition.
 *
 * Given a quaternion `q` and a unit axis `twistAxis`, splits q into a
 * twist (rotation about `twistAxis`) and a swing (rotation perpendicular
 * to it). q == swing * twist.
 *
 * Convention: `twistAxis` lives in the *rotated* frame, so for a bone the
 * twist is rotation about the bone's own long axis (its child direction).
 *
 * Out-params: outSwing and outTwist are mutated in place.
 */
export function swingTwistDecompose(
  q: THREE.Quaternion,
  twistAxis: THREE.Vector3,
  outSwing: THREE.Quaternion,
  outTwist: THREE.Quaternion,
): void {
  // Project the rotation axis of q onto twistAxis.
  const projection = twistAxis.x * q.x + twistAxis.y * q.y + twistAxis.z * q.z;
  outTwist.set(twistAxis.x * projection, twistAxis.y * projection, twistAxis.z * projection, q.w);
  outTwist.normalize();
  // swing = q * twist^-1
  outSwing.copy(q).multiply(_q1.copy(outTwist).invert());
}

/** Convert a quaternion to its rotation axis × angle (signed) in radians,
 *  about the given reference axis. Positive when the rotation is right-
 *  handed about `axis`. Useful for reading a twist value. */
export function signedAngleAboutAxis(q: THREE.Quaternion, axis: THREE.Vector3): number {
  // Quaternion q = [sin(θ/2)·n, cos(θ/2)] where n is the rotation axis.
  // angle = 2·atan2(|qv|, qw); sign comes from dot(qv, axis).
  const qvLen = Math.hypot(q.x, q.y, q.z);
  if (qvLen < 1e-9) return 0;
  let angle = 2 * Math.atan2(qvLen, q.w);
  if (angle > Math.PI) angle -= 2 * Math.PI; // shortest path
  const sign = Math.sign(q.x * axis.x + q.y * axis.y + q.z * axis.z) || 1;
  return angle * sign;
}

/** Angle (radians, 0..π) between two unit-ish vectors via clamped acos. */
function angleBetween(a: THREE.Vector3, b: THREE.Vector3): number {
  const an = _v3.copy(a).normalize();
  const bn = _v4.copy(b).normalize();
  return Math.acos(Math.max(-1, Math.min(1, an.dot(bn))));
}

// ── Skeleton plumbing ──────────────────────────────────────────────────────

/** Build a canonical-key → bone lookup the same way poseRig does. */
function buildLookup(
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

/** Capture the skeleton's CURRENT pose as the rest reference. Call this
 *  once per model load, *after* applyAnatomicPose has been applied so the
 *  recorded rest matches the canvas's "anatomic" baseline. Every subsequent
 *  computeJointAngles call reads deltas off this snapshot. */
export function captureJointAngleRestReference(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
): JointAngleRestReference {
  // Make sure world matrices reflect any pending pose work before we read.
  for (const bone of skeleton.bones) bone.updateMatrixWorld(false);
  const lookup = buildLookup(skeleton, variantCfg);
  const localQuats: Record<string, [number, number, number, number]> = {};
  const worldQuats: Record<string, [number, number, number, number]> = {};
  for (const [key, bone] of lookup) {
    const q = bone.quaternion;
    localQuats[key] = [q.x, q.y, q.z, q.w];
    const wq = bone.getWorldQuaternion(_q1);
    worldQuats[key] = [wq.x, wq.y, wq.z, wq.w];
  }
  let pelvisWorldQuat: [number, number, number, number] = [0, 0, 0, 1];
  const hips = lookup.get('Hips');
  if (hips) {
    const wq = hips.getWorldQuaternion(_q1);
    pelvisWorldQuat = [wq.x, wq.y, wq.z, wq.w];
  }
  return { pelvisWorldQuat, localQuats, worldQuats };
}

/** Empty rest reference (every joint reads as if rest = identity). Used
 *  as a fallback when the live skeleton hasn't initialized yet. */
function emptyRestReference(): JointAngleRestReference {
  return { pelvisWorldQuat: [0, 0, 0, 1], localQuats: {}, worldQuats: {} };
}

/** Pick a bone's first child bone (skeletal child preferred) — used to
 *  define the long axis for swing-twist + the parent/child vector for
 *  hinge angles. */
function firstChildBone(bone: THREE.Bone): THREE.Bone | null {
  const child =
    bone.children.find((c): c is THREE.Bone => (c as THREE.Bone).isBone === true) ??
    (bone.children[0] as THREE.Bone | undefined);
  return child ?? null;
}

/** World-space bone direction = world(child position) − world(this position),
 *  normalized. Returns a *new* Vector3 the caller can store. */
function boneWorldDirection(bone: THREE.Bone): THREE.Vector3 | null {
  const child = firstChildBone(bone);
  if (!child) return null;
  const here = bone.getWorldPosition(new THREE.Vector3());
  const there = child.getWorldPosition(new THREE.Vector3());
  const dir = there.sub(here);
  if (dir.lengthSq() < 1e-10) return null;
  return dir.normalize();
}

// ── Per-joint computations ─────────────────────────────────────────────────

/** HINGE angle (elbow / knee). 0° at full extension, positive = flexion,
 *  ~180° at full bend. Returns degrees.
 *
 *  parentVec  = from upstream joint to this joint (e.g. shoulder→elbow)
 *  childVec   = from this joint to next joint   (e.g. elbow→wrist)
 *
 *  At anatomic position both vectors point in the same direction (down for
 *  the arm), so the angle between them is 0° (extension). Bending the joint
 *  rotates childVec until it's anti-parallel to parentVec (180°, the
 *  geometric maximum even though the body can't reach it). Flexion is
 *  therefore the unsigned angle between the two vectors directly. */
function hingeFlexionDeg(parentVec: THREE.Vector3, childVec: THREE.Vector3): number {
  return angleBetween(parentVec, childVec) * DEG;
}

/** Common shape: the three clinical motion axes for a joint. */
export interface SwingTwistDeg {
  flexion: number;
  abduction: number;
  rotation: number;
}

/** Compose `dQ = current · rest⁻¹` — the rotation that takes a bone from
 *  its rest orientation to its current one, expressed in the same frame
 *  both quaternions live in (world for pelvis, parent-local for everyone
 *  else). Caller passes restArr; we build _q1 (current), _q2 (delta). */
export function deltaFromRest(
  currentQ: THREE.Quaternion,
  restArr: [number, number, number, number] | undefined,
  outDelta: THREE.Quaternion,
): void {
  if (!restArr) {
    outDelta.copy(currentQ);
    return;
  }
  _q1.set(restArr[0], restArr[1], restArr[2], restArr[3]).invert();
  outDelta.copy(currentQ).multiply(_q1);
}

/** Map a body-frame Euler delta (YXZ order, in world or trunk-aligned
 *  parent space) into the clinical sign convention.
 *
 *  Right-hand rule analysis on our body axes (superior +Y, anterior -Z,
 *  subject's left +X):
 *    - rotation about +X by +θ takes +Y toward +Z = top tips POSTERIORLY
 *      ⇒ anteriorTilt is positive when delta.x is NEGATIVE.
 *    - rotation about +Z by +θ takes +X toward +Y = subject's left RISES
 *      ⇒ lateralTilt = +delta.z directly.
 *    - rotation about +Y by +θ takes -Z (anterior) toward -X (subject's
 *      right) = body faces RIGHT ⇒ rotation positive when delta.y is
 *      NEGATIVE.
 */
export function decomposeBodyDelta(deltaQ: THREE.Quaternion): SwingTwistDeg {
  _e1.setFromQuaternion(deltaQ, 'YXZ');
  return {
    flexion: -_e1.x * DEG, // X-axis: anterior tilt / forward flexion
    abduction: _e1.z * DEG, // Z-axis: lateral tilt / side-bend
    rotation: -_e1.y * DEG, // Y-axis: axial rotation
  };
}

/** BALL-JOINT swing-twist angles (shoulder / hip). Decomposes the local
 *  delta-from-rest into swing (long-axis re-aim) and twist (rotation about
 *  the long axis), then projects swing onto sagittal vs coronal axes.
 *
 *  `mirror` flips abduction + rotation signs so right-side joints read with
 *  the same clinical convention as the left (positive abduction = away
 *  from midline; positive rotation = internal). */
export function ballJointAngles(
  deltaQ: THREE.Quaternion,
  longAxis: THREE.Vector3,
  mirror: boolean,
): SwingTwistDeg {
  // Decompose the rest→current delta into swing + twist about the long axis.
  swingTwistDecompose(deltaQ, longAxis, _q2, _q3);

  // Apply the swing to the long axis → current direction in parent frame.
  _v1.copy(longAxis).applyQuaternion(_q2);

  // From the swung direction:
  //   flexion (sagittal)   = rotation in the YZ-plane toward anterior (-Z)
  //   abduction (coronal)  = swing out of the YZ-plane toward lateral (+X)
  // (Negation pairs match the body-frame sign convention used elsewhere.)
  const flexionRad = Math.atan2(-_v1.z, -_v1.y);
  const abductionRad = Math.atan2(_v1.x, Math.hypot(_v1.y, _v1.z));
  const twistRad = signedAngleAboutAxis(_q3, longAxis);

  const flexion = flexionRad * DEG;
  let abduction = abductionRad * DEG;
  let rotation = twistRad * DEG;
  if (mirror) {
    abduction = -abduction;
    rotation = -rotation;
  }
  return { flexion, abduction, rotation };
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Long axis in every limb-root bone's local frame. Our convention: the
 *  bone's child sits at local -Y, so the long axis points down at rest. */
export const REST_DOWN_LOCAL = new THREE.Vector3(0, -1, 0);

/** Compute every supported clinical joint angle for the current skeleton
 *  pose. Each angle is the delta from the captured rest reference, so the
 *  live anatomic position reads 0,0,0 across the panel. Cheap to call
 *  (~17 joints × constant-time math, no allocations outside the result). */
export function computeJointAngles(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  variantId: string,
  rest: JointAngleRestReference = emptyRestReference(),
): JointAngleReport {
  const lookup = buildLookup(skeleton, variantCfg);
  const joints: Record<string, JointAngleSet> = {};

  // Ensure parent-chain world matrices are up-to-date for hinge calculations.
  for (const bone of skeleton.bones) bone.updateMatrixWorld(false);

  const delta = new THREE.Quaternion();

  // ── Pelvis (world frame) ─────────────────────────────────────────────
  const hips = lookup.get('Hips');
  if (hips) {
    hips.getWorldQuaternion(_q3);
    deltaFromRest(_q3, rest.pelvisWorldQuat, delta);
    const a = decomposeBodyDelta(delta);
    joints.Hips = {
      anteriorTilt: a.flexion,
      lateralTilt: a.abduction,
      rotation: a.rotation,
    };
  }

  // ── Spine / Head / Shoulders (parent-local delta from rest) ──────────
  for (const key of ['Spine_Mid', 'Head', 'L_Shoulder', 'R_Shoulder'] as const) {
    const bone = lookup.get(key);
    if (!bone) continue;
    deltaFromRest(bone.quaternion, rest.localQuats[key], delta);
    const a = decomposeBodyDelta(delta);
    joints[key] = {
      flexion: a.flexion,
      lateralTilt: a.abduction,
      rotation: a.rotation,
    };
  }

  // ── Limb root: UpperArm / UpLeg (3-axis swing-twist on delta) ────────
  for (const [key, mirror] of [
    ['L_UpperArm', false],
    ['R_UpperArm', true],
    ['L_UpLeg', false],
    ['R_UpLeg', true],
  ] as const) {
    const bone = lookup.get(key);
    if (!bone) continue;
    deltaFromRest(bone.quaternion, rest.localQuats[key], delta);
    const a = ballJointAngles(delta, REST_DOWN_LOCAL, mirror);
    if (key.endsWith('UpperArm')) {
      joints[key] = {
        shoulderFlexion: a.flexion,
        shoulderAbduction: a.abduction,
        shoulderRotation: a.rotation,
      };
    } else {
      joints[key] = {
        hipFlexion: a.flexion,
        hipAbduction: a.abduction,
        hipRotation: a.rotation,
      };
    }
  }

  // ── Hinges: Forearm (elbow), Leg (knee) ──────────────────────────────
  // Hinge angle is geometric (parent-vs-child world direction), not a
  // delta-from-rest decomposition — so the rest-reference doesn't apply.
  // At anatomic the parent and child point co-linearly so the angle is
  // ~0° regardless of bind quaternions.
  for (const [parentKey, childKey, jointKey, label] of [
    ['L_UpperArm', 'L_Forearm', 'L_Forearm', 'elbowFlexion'],
    ['R_UpperArm', 'R_Forearm', 'R_Forearm', 'elbowFlexion'],
    ['L_UpLeg', 'L_Leg', 'L_Leg', 'kneeFlexion'],
    ['R_UpLeg', 'R_Leg', 'R_Leg', 'kneeFlexion'],
  ] as const) {
    const parent = lookup.get(parentKey);
    const child = lookup.get(childKey);
    if (!parent || !child) continue;
    const parentDir = boneWorldDirection(parent);
    const childDir = boneWorldDirection(child);
    if (!parentDir || !childDir) continue;
    joints[jointKey] = { [label]: hingeFlexionDeg(parentDir, childDir) };
  }

  // ── Hand / Foot (2-axis parent-local delta) ──────────────────────────
  for (const [key, isHand, mirror] of [
    ['L_Hand', true, false],
    ['R_Hand', true, true],
    ['L_Foot', false, false],
    ['R_Foot', false, true],
  ] as const) {
    const bone = lookup.get(key);
    if (!bone) continue;
    deltaFromRest(bone.quaternion, rest.localQuats[key], delta);
    const a = decomposeBodyDelta(delta);
    let abduction = a.abduction;
    if (mirror) abduction = -abduction;
    joints[key] = isHand
      ? { wristFlexion: a.flexion, wristDeviation: abduction }
      : { ankleFlexion: a.flexion, ankleInversion: abduction };
  }

  return {
    at: new Date().toISOString(),
    variant: variantId,
    joints,
  };
}

/** Stable hash of a joint-angle report (for cache keys / change detection).
 *  Rounds to 0.1° so floating-point jitter doesn't bust the hash. */
export function hashJointAngleReport(report: JointAngleReport | null | undefined): string {
  if (!report) return 'none';
  const keys = Object.keys(report.joints).sort();
  if (keys.length === 0) return 'empty';
  let h = 0x811c9dc5;
  for (const key of keys) {
    const set = report.joints[key];
    const angleKeys = Object.keys(set).sort();
    let segment = `${key}:`;
    for (const a of angleKeys) segment += `${a}=${(set[a] ?? 0).toFixed(1)};`;
    for (let i = 0; i < segment.length; i += 1) {
      h ^= segment.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
  }
  return h.toString(16);
}

/** Empty report stub for type-safe defaults. */
export function emptyJointAngleReport(variantId = ''): JointAngleReport {
  return { at: new Date(0).toISOString(), variant: variantId, joints: {} };
}
