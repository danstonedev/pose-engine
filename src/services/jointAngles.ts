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
import { ROM_JOINT_ROWS, type RomPlane } from './romRegistry';

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

// ── Gizmo ring ↔ clinical motion mapping ─────────────────────────────────────

/** Gizmo space per joint. The primary UpperArm gizmo is world-aligned (so its
 *  rings are the body axes); every other joint's gizmo rotates the bone about its
 *  LOCAL axes. MUST match how the scene sets `tc.setSpace` + the ring `frameQuat`. */
export function gizmoSpaceForJoint(key: string): 'world' | 'local' {
  return key.endsWith('UpperArm') ? 'world' : 'local';
}

/** The gizmo ring (x = red, y = green, z = blue) that drives a clinical motion,
 *  plus whether the single-ring mapping is only approximate (swing-twist ball
 *  joints, where one local ring doesn't cleanly isolate one motion off-neutral). */
export interface DrivingRing {
  ring: 'x' | 'y' | 'z';
  approximate: boolean;
}
/** Per joint key → per clinical plane → the ring that actually drives it. */
export type DrivingRingMap = Record<string, Partial<Record<RomPlane, DrivingRing>>>;

/** Body-frame rotation AXIS (normal) for each plane of motion: flexion sweeps the
 *  sagittal plane ABOUT the medio-lateral axis (+X); abduction the frontal plane
 *  about the A-P axis (+Z); rotation the transverse plane about the longitudinal
 *  axis (+Y). */
const PLANE_BODY_NORMAL: Record<RomPlane, THREE.Vector3> = {
  sagittal: new THREE.Vector3(1, 0, 0),
  frontal: new THREE.Vector3(0, 0, 1),
  transverse: new THREE.Vector3(0, 1, 0),
};
const RING_LOCAL_AXES: { ring: 'x' | 'y' | 'z'; v: THREE.Vector3 }[] = [
  { ring: 'x', v: new THREE.Vector3(1, 0, 0) },
  { ring: 'y', v: new THREE.Vector3(0, 1, 0) },
  { ring: 'z', v: new THREE.Vector3(0, 0, 1) },
];

/** Swing-twist ball joints (shoulder/hip) couple flexion/abduction/rotation, so a
 *  single local ring only approximately isolates one clinical motion off neutral.
 *  Hinges (elbow/knee) have a clean per-axis mapping, so they are NOT approximate. */
function jointIsApproximate(key: string): boolean {
  return key.endsWith('UpperArm') || key.endsWith('UpLeg');
}

const _drv = new THREE.Vector3();
const _drvQ = new THREE.Quaternion();

/** For every ROM joint + plane, the gizmo ring that actually drives that motion —
 *  derived from the bone's REST world frame, so it's correct even when a bone's
 *  local frame is rotated relative to the body (e.g. the forearm's baked 90° twist
 *  makes ring Z, not X, the flexion ring). For a world-space gizmo (UpperArm) the
 *  rings are the body axes directly. Compute once per model load (after the rest
 *  reference is captured) and hand to the angle panel. */
export function computeDrivingRingMap(rest: JointAngleRestReference): DrivingRingMap {
  const map: DrivingRingMap = {};
  for (const joint of ROM_JOINT_ROWS) {
    const key = joint.canonicalKey;
    // Wrist: its flex/dev measurement is manually swapped to match the hand's
    // inherited (twisted) frame — flex = local-Z, dev = local-X, pro/sup = local-Y
    // — which world-geometry nearest-axis can't infer. Pin the rings explicitly so
    // the chip colours match the actual rings + the measurement.
    if (key === 'L_Hand' || key === 'R_Hand') {
      map[key] = {
        sagittal: { ring: 'z', approximate: false }, // flexion
        frontal: { ring: 'x', approximate: false }, // deviation
        transverse: { ring: 'y', approximate: false }, // pro/sup (hand twist)
      };
      continue;
    }
    const space = gizmoSpaceForJoint(key);
    const worldArr = rest.worldQuats[key];
    const approximate = jointIsApproximate(key);
    const perPlane: Partial<Record<RomPlane, DrivingRing>> = {};
    for (const f of joint.fields) {
      if (perPlane[f.plane]) continue; // one ring per plane
      const normal = PLANE_BODY_NORMAL[f.plane];
      if (space === 'world' || !worldArr) {
        perPlane[f.plane] = {
          ring: f.plane === 'sagittal' ? 'x' : f.plane === 'frontal' ? 'z' : 'y',
          approximate,
        };
        continue;
      }
      _drvQ.set(worldArr[0], worldArr[1], worldArr[2], worldArr[3]);
      let bestAbs = -Infinity;
      let bestRing: 'x' | 'y' | 'z' = 'x';
      for (const { ring, v } of RING_LOCAL_AXES) {
        const d = Math.abs(_drv.copy(v).applyQuaternion(_drvQ).dot(normal));
        if (d > bestAbs) {
          bestAbs = d;
          bestRing = ring;
        }
      }
      perPlane[f.plane] = { ring: bestRing, approximate };
    }
    map[key] = perPlane;
  }
  return map;
}

/** Empty rest reference (every joint reads as if rest = identity). Used
 *  as a fallback when the live skeleton hasn't initialized yet. */
function emptyRestReference(): JointAngleRestReference {
  return { pelvisWorldQuat: [0, 0, 0, 1], localQuats: {}, worldQuats: {} };
}

/** The bone-LOCAL axis (unit) whose rest-world direction is nearest the body's
 *  medio-lateral axis (subject-left +X), oriented to point toward +left. Used to
 *  sign the otherwise-unsigned geometric hinge magnitude (flexion vs extension). */
export function localAxisTowardBodyLeft(
  worldArr: [number, number, number, number] | undefined,
): THREE.Vector3 {
  if (!worldArr) return new THREE.Vector3(1, 0, 0);
  _drvQ.set(worldArr[0], worldArr[1], worldArr[2], worldArr[3]);
  let bestAbs = -Infinity;
  let best = RING_LOCAL_AXES[0].v;
  let sign = 1;
  for (const { v } of RING_LOCAL_AXES) {
    const d = _drv.copy(v).applyQuaternion(_drvQ).dot(BODY_LEFT);
    if (Math.abs(d) > bestAbs) {
      bestAbs = Math.abs(d);
      best = v;
      sign = d >= 0 ? 1 : -1;
    }
  }
  return best.clone().multiplyScalar(sign);
}

/** World-space bone direction = world(next meaningfully-offset descendant) −
 *  world(this position), normalized. Descends past zero-length helper / "share" /
 *  twist bones that the CC rig parks exactly on a joint (e.g. R_Calf's first
 *  child is `R_KneeShareBone` sitting on the knee), which would otherwise yield a
 *  zero-length vector and break the hinge angle. Returns a *new* Vector3. */
function boneWorldDirection(bone: THREE.Bone): THREE.Vector3 | null {
  const here = bone.getWorldPosition(new THREE.Vector3());
  // Breadth-first to the NEAREST descendant with a meaningful offset. The CC rig
  // parks zero-length helper/"share" bones (e.g. R_KneeShareBone) ON the joint,
  // and they can be the FIRST child while the real continuation (the foot) is a
  // sibling — so we must scan across siblings, not just descend the first child.
  const queue: THREE.Object3D[] = [...bone.children];
  let guard = 0;
  while (queue.length > 0 && guard < 64) {
    guard += 1;
    const node = queue.shift() as THREE.Object3D;
    const dir = node.getWorldPosition(new THREE.Vector3()).sub(here);
    if (dir.lengthSq() >= 1e-8) return dir.normalize();
    for (const c of node.children) queue.push(c);
  }
  return null;
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
      anteriorTilt: -a.flexion, // flip (pelvis tilt)
      lateralTilt: a.abduction, // good as-is
      rotation: -a.rotation, // transverse flip (pelvis)
    };
  }

  // ── Spine / neck / head (parent-local body-frame Euler delta from rest) ─
  // Each segment measures relative to its parent (segmental). Signs follow the
  // verified Spine_Mid/Head convention; the new segments (Lower/Upper/Neck) are
  // PROVISIONAL — verify live and adjust latSign per segment if needed.
  for (const [key, latSign] of [
    ['Spine_Lower', -1],
    ['Spine_Mid', -1],
    ['Spine_Upper', -1],
    ['Neck_Lower', -1],
    ['Neck', -1],
    ['Head', -1],
  ] as const) {
    const bone = lookup.get(key);
    if (!bone) continue;
    deltaFromRest(bone.quaternion, rest.localQuats[key], delta);
    const a = decomposeBodyDelta(delta);
    joints[key] = {
      flexion: -a.flexion, // + = forward flexion
      lateralTilt: a.abduction * latSign,
      rotation: -a.rotation, // transverse flip
    };
  }

  // Regional readouts = sum of each region's two segments, so a single readout
  // reflects the whole span its one curve control bends. The folded-in segment
  // then has no standalone row. Thoracic = Spine01+Spine02; Cervical = both neck.
  const addRegion = (target: string, a: string, b: string) => {
    const ja = joints[a];
    const jb = joints[b];
    if (!ja || !jb) return;
    joints[target] = {
      flexion: (ja.flexion ?? 0) + (jb.flexion ?? 0),
      lateralTilt: (ja.lateralTilt ?? 0) + (jb.lateralTilt ?? 0),
      rotation: (ja.rotation ?? 0) + (jb.rotation ?? 0),
    };
  };
  addRegion('Spine_Upper', 'Spine_Mid', 'Spine_Upper'); // Thoracic
  addRegion('Neck', 'Neck_Lower', 'Neck'); // Cervical
  delete joints['Spine_Mid'];
  delete joints['Neck_Lower'];

  // ── Scapula / shoulder girdle (the 'Shoulder' canonical = clavicle bone) ──
  // Girdle motions from the clavicle's body-frame Euler delta (verified live):
  //   upRotation   ← frontal  (Z) component  (Up/Down)
  //   scapularTilt ← sagittal (X) component  (Post/Ant tilt)
  //   protraction  ← transverse (Y) component (Pro/Ret)
  // Right side mirrors upRotation + protraction so symmetric motion reads alike.
  for (const [key, mirror] of [['L_Shoulder', false], ['R_Shoulder', true]] as const) {
    const bone = lookup.get(key);
    if (!bone) continue;
    deltaFromRest(bone.quaternion, rest.localQuats[key], delta);
    const a = decomposeBodyDelta(delta);
    joints[key] = {
      upRotation: mirror ? -a.abduction : a.abduction, // frontal
      scapularTilt: a.flexion, // anterior/posterior scapular tilt (sagittal)
      protraction: mirror ? -a.rotation : a.rotation, // transverse
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
        shoulderRotation: -a.rotation, // transverse flip (shoulder; hip stays)
      };
    } else {
      joints[key] = {
        hipFlexion: -a.flexion, // + = hip flexion (flip; shoulder stays as-is)
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
  // Flexion is geometric; the secondary axes (axial twist = forearm pro/sup or
  // tibial rotation, and frontal deviation = elbow/knee varus-valgus) come from a
  // swing-twist of the bone's local delta-from-rest. SIGNS PROVISIONAL — verify.
  // flexSign signs the unsigned geometric magnitude per the joint's flexion sense
  // (knee flexes posteriorly, elbow anteriorly — opposite about the medio-lateral
  // axis), so red one way reads +Flex and the other −Ext. PROVISIONAL — verify.
  for (const [parentKey, jointKey, flexLabel, twistLabel, devLabel, mirror, flexSign, twistSign] of [
    ['L_UpperArm', 'L_Forearm', 'elbowFlexion', 'forearmRotation', 'elbowDeviation', false, -1, 1],
    ['R_UpperArm', 'R_Forearm', 'elbowFlexion', 'forearmRotation', 'elbowDeviation', true, -1, 1],
    ['L_UpLeg', 'L_Leg', 'kneeFlexion', 'kneeRotation', 'kneeDeviation', false, 1, -1],
    ['R_UpLeg', 'R_Leg', 'kneeFlexion', 'kneeRotation', 'kneeDeviation', true, 1, -1],
  ] as const) {
    const parent = lookup.get(parentKey);
    const bone = lookup.get(jointKey); // the forearm / leg bone (also the hinge child)
    if (!parent || !bone) continue;
    const parentDir = boneWorldDirection(parent);
    const childDir = boneWorldDirection(bone);
    const mag = parentDir && childDir ? hingeFlexionDeg(parentDir, childDir) : 0;
    deltaFromRest(bone.quaternion, rest.localQuats[jointKey], delta);
    // Sign the magnitude by the rotation sense about the medio-lateral axis.
    const hingeAxis = localAxisTowardBodyLeft(rest.worldQuats[jointKey]);
    const dir = signedAngleAboutAxis(delta, hingeAxis) >= 0 ? 1 : -1;
    const a = ballJointAngles(delta, REST_DOWN_LOCAL, mirror);
    joints[jointKey] = {
      [flexLabel]: mag * dir * flexSign, // signed: + flexion, − (hyper)extension
      [twistLabel]: a.rotation * twistSign, // axial twist (knee tibial-rot flipped; forearm stays)
      [devLabel]: a.abduction, // frontal-plane deviation (var/valg)
    };
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
    let rotation = a.rotation;
    if (mirror) {
      abduction = -abduction;
      rotation = -rotation;
    }
    if (isHand) {
      // Wrist: the hand inherits the forearm's rotated frame, so flexion is the
      // local-Z component and deviation the local-X component (blue↔red switch).
      // Pro/sup TOTAL = forearm (radioulnar) twist + hand (wrist) twist — the two
      // share the rotation, so the total is written to BOTH the elbow and wrist
      // rows. Signs/mirror PROVISIONAL — verify.
      const forearmKey = key.replace('Hand', 'Forearm');
      const total = (joints[forearmKey]?.forearmRotation ?? 0) + rotation;
      if (joints[forearmKey]) joints[forearmKey].forearmRotation = total;
      joints[key] = {
        wristFlexion: a.abduction,
        proSup: total,
        wristDeviation: mirror ? -a.flexion : a.flexion,
      };
    } else {
      joints[key] = { ankleFlexion: -a.flexion, ankleInversion: -abduction, ankleAbduction: rotation }; // ankle F/E flip; inv/ev flip
    }
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
