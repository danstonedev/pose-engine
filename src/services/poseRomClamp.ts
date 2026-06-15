/**
 * Range-of-motion clamp for pose-mode bone manipulations.
 *
 * Reads a bone's current quaternion, decomposes it into clinical angles
 * via the same math `jointAngles.ts` uses for the readout, looks up
 * per-joint ROM in `romRegistry.ts`, and — only when an angle is out of
 * range — recomposes a clamped quaternion and writes it back. Hinges
 * (elbow / knee) additionally lock abduction + rotation to zero so the
 * forearm / shin can't swing sideways or twist along its long axis.
 *
 * The forward decomposition is shared with `jointAngles.ts`; the inverse
 * (angles → quaternion) is the new piece, implemented per-strategy:
 *
 *   - Pelvis (world-frame Euler)            : Hips
 *   - Body-frame Euler (parent-local Euler) : Spine_Mid, Head, Hands, Feet
 *   - Ball joint (swing + twist)            : L/R UpperArm, L/R UpLeg
 *   - Hinge (1-DOF flexion only)            : L/R Forearm, L/R Leg
 *
 * All clamps are relative to the captured `JointAngleRestReference` —
 * "180° shoulder flexion" means 180° from the rig's anatomic baseline,
 * the same convention the joint-angle readout panel uses.
 */
import * as THREE from 'three';
import {
  REST_DOWN_LOCAL,
  ballJointAngles,
  decomposeBodyDelta,
  deltaFromRest,
  type JointAngleRestReference,
} from './jointAngles';
import { getRomFieldDefinition, type RomRangeDeg } from './romRegistry';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const EPS = 1e-4;

// ── Scratch (reused across calls; never recursive) ────────────────────
const _qDelta = new THREE.Quaternion();
const _qSwing = new THREE.Quaternion();
const _qTwist = new THREE.Quaternion();
const _qRest = new THREE.Quaternion();
const _qParentWorld = new THREE.Quaternion();
const _qBoneWorld = new THREE.Quaternion();
const _qNewWorld = new THREE.Quaternion();
const _qOut = new THREE.Quaternion();
const _vSwung = new THREE.Vector3();
const _euler = new THREE.Euler();

// ── Strategy table ────────────────────────────────────────────────────

interface BodyEulerStrategy {
  kind: 'body-euler';
  /** ROM field-key for flexion (X-axis). */
  flexionField: string;
  /** ROM field-key for abduction / lateral tilt (Z-axis). */
  abductionField: string;
  /** ROM field-key for rotation about Y-axis, or null to lock at 0. */
  rotationField: string | null;
  /** Mirror right-side joints so they share the left-side sign convention. */
  mirror: boolean;
  /** Sign mapping the raw swing decomposition's flexion into the joint's
   *  CLINICAL flexion — the same convention the readout (`jointAngles.ts`)
   *  and the ROM registry use. The ankle readout writes `-a.flexion`
   *  (dorsi positive), so feet need `-1`; spine/head/hand map directly
   *  (`+1`). Without this the registry's dorsi/plantar bounds clamp the
   *  wrong pole (plantar stops at the dorsi limit and vice-versa). */
  flexionSign?: 1 | -1;
  /** Sign mapping the (mirror-applied) raw abduction into the joint's
   *  CLINICAL frontal-plane value (e.g. ankle inversion). The ankle readout
   *  writes `-abduction`, so feet need `-1`; everything else maps directly. */
  abductionSign?: 1 | -1;
  /** Which raw decomposition axis feeds the FLEXION field: 'x' (sagittal,
   *  default) or 'z' (frontal). The wrist inherits the forearm's twisted
   *  frame, so its flexion reads from local-Z and deviation from local-X —
   *  the same axis swap the readout pins (flex=Z, dev=X). */
  flexionAxis?: 'x' | 'z';
  /** Which raw axis feeds the ABDUCTION/deviation field: 'z' (default) or 'x'.
   *  Must differ from `flexionAxis`. */
  abductionAxis?: 'x' | 'z';
}

interface BallJointStrategy {
  kind: 'ball-joint';
  flexionField: string;
  abductionField: string;
  rotationField: string;
  mirror: boolean;
  /** Sign that maps the swing-twist "anterior=positive" decomposition
   *  into the joint's clinical flexion. Default +1. Some rig bindings
   *  invert the long axis at rest, so anatomic forward swing reads as
   *  -flex from the decomposition — `flexionSign: -1` corrects that.
   *  Calibrated per joint via `__romDebug` against the live rig. */
  flexionSign?: 1 | -1;
}

interface HingeStrategy {
  kind: 'hinge';
  /** ROM field-key for the hinge's primary DOF. */
  flexionField: string;
  /** Off-axis swing tolerance (medial-lateral wobble). Real elbows / knees
   *  have a small carrying angle and slight valgus/varus play, so a hard
   *  zero-lock looks robotic. */
  abductionRange: RomRangeDeg;
  /** Long-axis twist tolerance. Forearms pronate / supinate; knees have
   *  some tibial rotation when flexed. */
  rotationRange: RomRangeDeg;
  /** Sign that maps swing-twist's "anterior = positive" convention into
   *  the joint's clinical flexion. +1 for elbows (anatomic flex swings the
   *  forearm forward); -1 for knees (anatomic flex swings the lower leg
   *  posteriorly toward the butt). */
  flexionSign: 1 | -1;
}

interface PelvisStrategy {
  kind: 'pelvis';
  flexionField: string;
  abductionField: string;
  rotationField: string;
}

type ClampStrategy =
  | BodyEulerStrategy
  | BallJointStrategy
  | HingeStrategy
  | PelvisStrategy;

const STRATEGIES: Record<string, ClampStrategy> = {
  Hips: {
    kind: 'pelvis',
    flexionField: 'anteriorTilt',
    abductionField: 'lateralTilt',
    rotationField: 'rotation',
  },
  // Thoracic (T-spine) + Cervical (C-spine) regional ROM. Keyed by the region
  // CONTROL bone (Spine_Upper / Neck) — these are the canonical keys the
  // readout reports the regional total under AND the registry rows. The region
  // curve distributes the bend across two segments, so the clamp is applied to
  // the control's target orientation (the regional total) before distribution.
  // Body-euler shares the readout's parent-local frame, so the signs must match
  // the readout (flexion = -a.flexion, lateralTilt = -a.abduction); the flexion
  // range is asymmetric (thoracic -25/40, cervical -60/50) so the flip matters.
  Spine_Upper: {
    kind: 'body-euler',
    flexionField: 'flexion',
    abductionField: 'lateralTilt',
    rotationField: 'rotation',
    mirror: false,
    flexionSign: -1,
    abductionSign: -1,
  },
  Neck: {
    kind: 'body-euler',
    flexionField: 'flexion',
    abductionField: 'lateralTilt',
    rotationField: 'rotation',
    mirror: false,
    flexionSign: -1,
    abductionSign: -1,
  },
  L_UpperArm: {
    kind: 'ball-joint',
    flexionField: 'shoulderFlexion',
    abductionField: 'shoulderAbduction',
    rotationField: 'shoulderRotation',
    mirror: false,
  },
  R_UpperArm: {
    kind: 'ball-joint',
    flexionField: 'shoulderFlexion',
    abductionField: 'shoulderAbduction',
    rotationField: 'shoulderRotation',
    mirror: true,
  },
  L_UpLeg: {
    kind: 'ball-joint',
    flexionField: 'hipFlexion',
    abductionField: 'hipAbduction',
    rotationField: 'hipRotation',
    mirror: false,
  },
  R_UpLeg: {
    kind: 'ball-joint',
    flexionField: 'hipFlexion',
    abductionField: 'hipAbduction',
    rotationField: 'hipRotation',
    mirror: true,
  },
  L_Forearm: {
    kind: 'hinge',
    flexionField: 'elbowFlexion',
    abductionRange: { min: -10, max: 10 },
    rotationRange: { min: -45, max: 45 },
    flexionSign: 1,
  },
  R_Forearm: {
    kind: 'hinge',
    flexionField: 'elbowFlexion',
    abductionRange: { min: -10, max: 10 },
    rotationRange: { min: -45, max: 45 },
    flexionSign: 1,
  },
  L_Leg: {
    kind: 'hinge',
    flexionField: 'kneeFlexion',
    abductionRange: { min: -5, max: 5 },
    rotationRange: { min: -15, max: 15 },
    flexionSign: -1,
  },
  R_Leg: {
    kind: 'hinge',
    flexionField: 'kneeFlexion',
    abductionRange: { min: -5, max: 5 },
    rotationRange: { min: -15, max: 15 },
    flexionSign: -1,
  },
  // Wrist inherits the forearm's twisted frame, so the readout reads flexion
  // from local-Z (a.abduction) and radial/ulnar deviation from local-X
  // (a.flexion) — the flexionAxis/abductionAxis swap. Without it the clamp
  // constrained flex with the deviation range (±~25°) and vice-versa. NOTE: the
  // wrist readout signs are flagged PROVISIONAL in jointAngles.ts — the axis
  // mapping + magnitudes are now correct; verify flex/ext + radial/ulnar poles
  // live and flip a sign here if a direction reads inverted.
  L_Hand: {
    kind: 'body-euler',
    flexionField: 'wristFlexion',
    abductionField: 'wristDeviation',
    rotationField: null,
    mirror: false,
    flexionAxis: 'z',
    abductionAxis: 'x',
  },
  R_Hand: {
    kind: 'body-euler',
    flexionField: 'wristFlexion',
    abductionField: 'wristDeviation',
    rotationField: null,
    mirror: true,
    flexionAxis: 'z',
    abductionAxis: 'x',
  },
  L_Foot: {
    kind: 'body-euler',
    flexionField: 'ankleFlexion',
    abductionField: 'ankleInversion',
    rotationField: null,
    mirror: false,
    // Readout writes ankleFlexion = -a.flexion (dorsi +) and
    // ankleInversion = -abduction, so the clamp must flip both to land the
    // registry's dorsi/plantar + inv/ev bounds on the correct pole.
    flexionSign: -1,
    abductionSign: -1,
  },
  R_Foot: {
    kind: 'body-euler',
    flexionField: 'ankleFlexion',
    abductionField: 'ankleInversion',
    rotationField: null,
    mirror: true,
    flexionSign: -1,
    abductionSign: -1,
  },
};

// ── Calibration toggle ────────────────────────────────────────────────

/** Resolve whether ROM clamping should run right now. The browser default
 *  is OFF (calibration mode); tests / SSR default to ON so the math is
 *  exercised. Either side can be overridden by setting `__enableRomClamp`
 *  or `__disableRomClamp` on the global. */
function isClampActive(): boolean {
  const g = globalThis as
    | { __enableRomClamp?: boolean; __disableRomClamp?: boolean }
    | undefined;
  if (g && g.__enableRomClamp === true) return true;
  if (g && g.__disableRomClamp === true) return false;
  // Default differs by context.
  return typeof window === 'undefined';
}

/** True if clamping is currently active (after applying overrides). The
 *  console-side debug helpers surface this so users can verify the toggle
 *  is reflecting their override. */
export function isRomClampActive(): boolean {
  return isClampActive();
}

// ── Public API ────────────────────────────────────────────────────────

/** Clamp a bone's current quaternion into its joint's clinical ROM (and
 *  for hinges, lock the off-axis DOFs). Returns true if the quaternion
 *  was modified. Safe to call when no rest reference is available — it
 *  will skip with `false`.
 *
 *  Calibration mode (default in browser): clamping is OFF until each
 *  joint's orientation has been verified. Set `window.__enableRomClamp
 *  = true` to turn it on. In a non-browser context (vitest) clamping
 *  defaults to ON so unit tests still validate the math. The
 *  `__disableRomClamp` flag remains supported as an explicit override
 *  in either direction. */
export function clampBoneToRom(
  bone: THREE.Bone,
  canonicalKey: string | null | undefined,
  rest: JointAngleRestReference | null | undefined,
): boolean {
  if (!bone || !canonicalKey || !rest) return false;
  if (!isClampActive()) return false;
  const strategy = STRATEGIES[canonicalKey];
  if (!strategy) return false;

  switch (strategy.kind) {
    case 'pelvis':
      return clampPelvis(bone, canonicalKey, strategy, rest);
    case 'body-euler':
      return clampBodyEuler(bone, canonicalKey, strategy, rest);
    case 'ball-joint':
      return clampBallJoint(bone, canonicalKey, strategy, rest);
    case 'hinge':
      return clampHinge(bone, canonicalKey, strategy, rest);
  }
}

/** True if the canonical key has a clamp strategy. Cheap lookup so callers
 *  can skip the work entirely for unknown bones. */
export function hasClampStrategy(canonicalKey: string | null | undefined): boolean {
  return !!canonicalKey && canonicalKey in STRATEGIES;
}

// ── Strategy implementations ──────────────────────────────────────────

function clampBodyEuler(
  bone: THREE.Bone,
  canonicalKey: string,
  strategy: BodyEulerStrategy,
  rest: JointAngleRestReference,
): boolean {
  const restArr = rest.localQuats[canonicalKey];
  deltaFromRest(bone.quaternion, restArr, _qDelta);
  const angles = decomposeBodyDelta(_qDelta);

  const flexRange = lookupRange(canonicalKey, strategy.flexionField);
  const abdRange = lookupRange(canonicalKey, strategy.abductionField);
  const rotRange = strategy.rotationField
    ? lookupRange(canonicalKey, strategy.rotationField)
    : ZERO_RANGE;

  // Map the raw decomposition (X = flexion, Z = abduction) into each clinical
  // field, then clamp, then invert exactly back to raw for recomposition. This
  // is the precise inverse of the per-joint readout in jointAngles.ts:
  //   - flexionAxis/abductionAxis pick which raw axis feeds each field. Most
  //     joints map flexion←X, abduction←Z; the WRIST inherits the forearm's
  //     twisted frame so flexion←Z, deviation←X.
  //   - flexionSign/abductionSign bring each field into the readout's clinical
  //     convention (feet/spine flip flexion; feet/spine flip the frontal axis).
  //   - mirror flips ONLY the abduction-field source for right-side joints
  //     (foot inversion, wrist deviation) — flexion is never mirrored, matching
  //     the readout.
  const fAxis = strategy.flexionAxis ?? 'x';
  const aAxis = strategy.abductionAxis ?? 'z';
  const pick = (ax: 'x' | 'z') => (ax === 'x' ? angles.flexion : angles.abduction);
  const fSign = strategy.flexionSign ?? 1;
  const aSign = strategy.abductionSign ?? 1;
  const aMirror = strategy.mirror ? -1 : 1;

  const clinFlex = fSign * pick(fAxis);
  const clinAbd = aSign * aMirror * pick(aAxis);

  const clampedFlex = clampValue(clinFlex, flexRange);
  const clampedAbd = clampValue(clinAbd, abdRange);
  const clampedRot = clampValue(angles.rotation, rotRange);

  if (
    approxEqual(clampedFlex, clinFlex) &&
    approxEqual(clampedAbd, clinAbd) &&
    approxEqual(clampedRot, angles.rotation)
  ) {
    return false;
  }

  // Invert back to raw X/Z components (fAxis ≠ aAxis, so each is set once).
  const fRaw = clampedFlex * fSign;
  const aRaw = clampedAbd * aSign * aMirror;
  let rawX = 0;
  let rawZ = 0;
  if (fAxis === 'x') rawX = fRaw;
  else rawZ = fRaw;
  if (aAxis === 'x') rawX = aRaw;
  else rawZ = aRaw;

  recomposeBodyEuler(rawX, rawZ, clampedRot, _qDelta);
  applyDeltaToLocal(bone, restArr, _qDelta);
  return true;
}

function clampBallJoint(
  bone: THREE.Bone,
  canonicalKey: string,
  strategy: BallJointStrategy,
  rest: JointAngleRestReference,
): boolean {
  const restWorldArr = rest.worldQuats[canonicalKey];
  if (!restWorldArr) return false;
  // Decompose in a world-aligned canonical frame so the rest long axis is
  // (0,-1,0) and the body axes (anterior=-Z, lateral=±X) are consistent
  // regardless of how the GLB binds the bone-local frame.
  bone.updateWorldMatrix(true, false);
  bone.getWorldQuaternion(_qBoneWorld);
  computeCanonicalDelta(_qBoneWorld, restWorldArr, _qDelta);
  const angles = ballJointAngles(_qDelta, REST_DOWN_LOCAL, strategy.mirror);

  const flexSign = strategy.flexionSign ?? 1;
  const anatomicFlex = angles.flexion * flexSign;

  const flexRange = lookupRange(canonicalKey, strategy.flexionField);
  const abdRange = lookupRange(canonicalKey, strategy.abductionField);
  const rotRange = lookupRange(canonicalKey, strategy.rotationField);

  const clampedAnatomicFlex = clampValue(anatomicFlex, flexRange);
  const clampedAbd = clampValue(angles.abduction, abdRange);
  const clampedRot = clampValue(angles.rotation, rotRange);

  if (
    approxEqual(clampedAnatomicFlex, anatomicFlex) &&
    approxEqual(clampedAbd, angles.abduction) &&
    approxEqual(clampedRot, angles.rotation)
  ) {
    return false;
  }

  const flexOut = clampedAnatomicFlex * flexSign;
  recomposeBallJoint(flexOut, clampedAbd, clampedRot, strategy.mirror, _qDelta);
  writeCanonicalDeltaToBone(bone, restWorldArr, _qDelta);
  return true;
}

function clampHinge(
  bone: THREE.Bone,
  canonicalKey: string,
  strategy: HingeStrategy,
  rest: JointAngleRestReference,
): boolean {
  const restWorldArr = rest.worldQuats[canonicalKey];
  if (!restWorldArr) return false;
  bone.updateWorldMatrix(true, false);
  bone.getWorldQuaternion(_qBoneWorld);
  computeCanonicalDelta(_qBoneWorld, restWorldArr, _qDelta);
  // Reuse ball-joint decomposition: flexion = swing toward anterior,
  // abduction + rotation are the constrained off-axis DOFs.
  const angles = ballJointAngles(_qDelta, REST_DOWN_LOCAL, false);

  // Convert the swing-twist "anterior = positive" reading into the joint's
  // clinical flexion (knee anatomic flex is posterior, so its sign is -1).
  const anatomicFlex = angles.flexion * strategy.flexionSign;

  const flexRange = lookupRange(canonicalKey, strategy.flexionField);
  const clampedAnatomicFlex = clampValue(anatomicFlex, flexRange);
  const clampedAbd = clampValue(angles.abduction, strategy.abductionRange);
  const clampedRot = clampValue(angles.rotation, strategy.rotationRange);

  if (
    approxEqual(clampedAnatomicFlex, anatomicFlex) &&
    approxEqual(clampedAbd, angles.abduction) &&
    approxEqual(clampedRot, angles.rotation)
  ) {
    return false;
  }

  const flexOut = clampedAnatomicFlex * strategy.flexionSign;
  recomposeBallJoint(flexOut, clampedAbd, clampedRot, false, _qDelta);
  writeCanonicalDeltaToBone(bone, restWorldArr, _qDelta);
  return true;
}

function clampPelvis(
  bone: THREE.Bone,
  canonicalKey: string,
  strategy: PelvisStrategy,
  rest: JointAngleRestReference,
): boolean {
  bone.updateWorldMatrix(true, false);
  bone.getWorldQuaternion(_qBoneWorld);
  deltaFromRest(_qBoneWorld, rest.pelvisWorldQuat, _qDelta);
  const angles = decomposeBodyDelta(_qDelta);

  const flexRange = lookupRange(canonicalKey, strategy.flexionField);
  const abdRange = lookupRange(canonicalKey, strategy.abductionField);
  const rotRange = lookupRange(canonicalKey, strategy.rotationField);

  const clampedFlex = clampValue(angles.flexion, flexRange);
  const clampedAbd = clampValue(angles.abduction, abdRange);
  const clampedRot = clampValue(angles.rotation, rotRange);

  if (
    approxEqual(clampedFlex, angles.flexion) &&
    approxEqual(clampedAbd, angles.abduction) &&
    approxEqual(clampedRot, angles.rotation)
  ) {
    return false;
  }

  recomposeBodyEuler(clampedFlex, clampedAbd, clampedRot, _qDelta);
  // newWorld = delta · restWorld
  const r = rest.pelvisWorldQuat;
  _qRest.set(r[0], r[1], r[2], r[3]);
  _qNewWorld.copy(_qDelta).multiply(_qRest);
  // newLocal = parentWorld⁻¹ · newWorld (or = newWorld when parent is the
  // scene root with identity rotation, the common case for Hips).
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qParentWorld);
    bone.quaternion.copy(_qParentWorld.invert()).multiply(_qNewWorld);
  } else {
    bone.quaternion.copy(_qNewWorld);
  }
  return true;
}

// ── Recomposition helpers (the new math) ──────────────────────────────

/** Inverse of `decomposeBodyDelta`. Given clinical (flex, abd, rot)
 *  degrees, build the body-frame Euler delta quaternion. */
function recomposeBodyEuler(
  flexionDeg: number,
  abductionDeg: number,
  rotationDeg: number,
  out: THREE.Quaternion,
): void {
  // Forward (jointAngles.ts:268-275):
  //   euler = setFromQuaternion(delta, 'YXZ')
  //   flexion   = -euler.x · DEG
  //   abduction =  euler.z · DEG
  //   rotation  = -euler.y · DEG
  // Inverse: solve euler components, build the YXZ Euler, recompose quat.
  _euler.set(-flexionDeg * RAD, -rotationDeg * RAD, abductionDeg * RAD, 'YXZ');
  out.setFromEuler(_euler);
}

/** Inverse of `ballJointAngles`. Given clinical (flex, abd, rot) degrees
 *  for a long-axis-down bone, build the parent-local delta quaternion.
 *  `mirror` matches the forward convention for right-side bones. */
function recomposeBallJoint(
  flexionDeg: number,
  abductionDeg: number,
  rotationDeg: number,
  mirror: boolean,
  out: THREE.Quaternion,
): void {
  // Undo right-side mirroring on the inputs so the math runs in left-side
  // space (forward decomp flips abduction + rotation when mirror=true).
  let abd = abductionDeg;
  let rot = rotationDeg;
  if (mirror) {
    abd = -abd;
    rot = -rot;
  }

  // Forward (jointAngles.ts:299-301):
  //   flexionRad   = atan2(-swung.z, -swung.y)
  //   abductionRad = atan2( swung.x, hypot(swung.y, swung.z))
  // Inverse: pick a unit vector consistent with both, then recompose swing.
  const flexRad = flexionDeg * RAD;
  const abdRad = abd * RAD;
  const cosAbd = Math.cos(abdRad);
  // |swung| = 1 since swing is a rotation of the unit longAxis.
  _vSwung.set(Math.sin(abdRad), -Math.cos(flexRad) * cosAbd, -Math.sin(flexRad) * cosAbd);
  _qSwing.setFromUnitVectors(REST_DOWN_LOCAL, _vSwung);

  // Twist about REST_DOWN_LOCAL by `rot` degrees. signedAngleAboutAxis
  // returns the signed rotation about the axis, so reversing is straight
  // axis-angle.
  _qTwist.setFromAxisAngle(REST_DOWN_LOCAL, rot * RAD);

  // delta = swing · twist (forward: q = swing * twist).
  out.copy(_qSwing).multiply(_qTwist);
}

// ── Misc helpers ──────────────────────────────────────────────────────

const ZERO_RANGE: RomRangeDeg = { min: 0, max: 0 };

function lookupRange(canonicalKey: string, fieldKey: string): RomRangeDeg {
  const def = getRomFieldDefinition(canonicalKey, fieldKey);
  return def ? def.range : ZERO_RANGE;
}

function clampValue(value: number, range: RomRangeDeg): number {
  if (!Number.isFinite(value)) return 0;
  if (value < range.min) return range.min;
  if (value > range.max) return range.max;
  return value;
}

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

/** Set bone.quaternion to (delta · rest), matching the forward convention
 *  `delta = current · rest⁻¹`. Used by the body-Euler strategies, which
 *  still operate in the bone's parent-local frame. */
function applyDeltaToLocal(
  bone: THREE.Bone,
  restArr: [number, number, number, number] | undefined,
  delta: THREE.Quaternion,
): void {
  if (!restArr) {
    bone.quaternion.copy(delta);
    return;
  }
  _qRest.set(restArr[0], restArr[1], restArr[2], restArr[3]);
  _qOut.copy(delta).multiply(_qRest);
  bone.quaternion.copy(_qOut);
}

/** Compute the rotation from rest to current expressed in a canonical
 *  world-aligned frame: `delta = restWorld⁻¹ · currentWorld`. With this
 *  framing, the bone's rest long axis sits at the canonical `(0,-1,0)`
 *  for every bone in the rig, so the swing-twist decomposition uses one
 *  axis convention regardless of how the GLB binds the bone-local frame. */
function computeCanonicalDelta(
  currentWorld: THREE.Quaternion,
  restWorldArr: [number, number, number, number],
  out: THREE.Quaternion,
): void {
  _qRest.set(restWorldArr[0], restWorldArr[1], restWorldArr[2], restWorldArr[3]).invert();
  out.copy(_qRest).multiply(currentWorld);
}

/** Inverse of `computeCanonicalDelta`: given a clamped delta in the
 *  canonical frame, produce the new bone-local quaternion. The new world
 *  quat is `restWorld · delta`; convert through the parent's current
 *  world transform to get back to bone-local. */
function writeCanonicalDeltaToBone(
  bone: THREE.Bone,
  restWorldArr: [number, number, number, number],
  deltaCanonical: THREE.Quaternion,
): void {
  _qRest.set(restWorldArr[0], restWorldArr[1], restWorldArr[2], restWorldArr[3]);
  _qNewWorld.copy(_qRest).multiply(deltaCanonical);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qParentWorld);
    bone.quaternion.copy(_qParentWorld.invert()).multiply(_qNewWorld);
  } else {
    bone.quaternion.copy(_qNewWorld);
  }
}

export type { JointAngleRestReference };

// ── Diagnostic / introspection ────────────────────────────────────────

export interface ClinicalAnglesReport {
  /** Strategy class the joint goes through. */
  strategy: 'pelvis' | 'body-euler' | 'ball-joint' | 'hinge';
  /** Raw decomposition output in the swing-twist convention (anterior =
   *  positive flexion across all joints). For hinges this is what the
   *  internal decomposition reads BEFORE the flexionSign remap. */
  raw: { flexion: number; abduction: number; rotation: number };
  /** Flexion in the joint's clinical convention (after `flexionSign`).
   *  For hinges the knee is `-raw.flexion`; for everything else this
   *  equals `raw.flexion`. */
  anatomicFlexion: number;
  /** ROM ranges the clamp would apply for each axis (or `null` for an
   *  axis the joint type doesn't expose). */
  ranges: {
    flexion: RomRangeDeg | null;
    abduction: RomRangeDeg | null;
    rotation: RomRangeDeg | null;
  };
}

/** Decompose a bone's current quaternion into clinical angles using the
 *  same math the clamp would apply, but without writing back. Returns
 *  null when the canonical key has no clamp strategy. Useful for
 *  console-driven verification of every joint's orientation. */
export function inspectClinicalAngles(
  bone: THREE.Bone,
  canonicalKey: string | null | undefined,
  rest: JointAngleRestReference | null | undefined,
): ClinicalAnglesReport | null {
  if (!bone || !canonicalKey || !rest) return null;
  const strategy = STRATEGIES[canonicalKey];
  if (!strategy) return null;

  let raw: { flexion: number; abduction: number; rotation: number };
  let anatomicFlexion: number;
  let flexRange: RomRangeDeg | null = null;
  let abdRange: RomRangeDeg | null = null;
  let rotRange: RomRangeDeg | null = null;

  if (strategy.kind === 'pelvis') {
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(_qBoneWorld);
    deltaFromRest(_qBoneWorld, rest.pelvisWorldQuat, _qDelta);
    const a = decomposeBodyDelta(_qDelta);
    raw = { flexion: a.flexion, abduction: a.abduction, rotation: a.rotation };
    anatomicFlexion = a.flexion;
    flexRange = lookupRange(canonicalKey, strategy.flexionField);
    abdRange = lookupRange(canonicalKey, strategy.abductionField);
    rotRange = lookupRange(canonicalKey, strategy.rotationField);
  } else if (strategy.kind === 'body-euler') {
    deltaFromRest(bone.quaternion, rest.localQuats[canonicalKey], _qDelta);
    const a = decomposeBodyDelta(_qDelta);
    let abd = a.abduction;
    if (strategy.mirror) abd = -abd;
    abd *= strategy.abductionSign ?? 1;
    raw = { flexion: a.flexion, abduction: abd, rotation: a.rotation };
    anatomicFlexion = (strategy.flexionSign ?? 1) * a.flexion;
    flexRange = lookupRange(canonicalKey, strategy.flexionField);
    abdRange = lookupRange(canonicalKey, strategy.abductionField);
    rotRange = strategy.rotationField
      ? lookupRange(canonicalKey, strategy.rotationField)
      : null;
  } else if (strategy.kind === 'ball-joint') {
    const restWorldArr = rest.worldQuats[canonicalKey];
    if (!restWorldArr) return null;
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(_qBoneWorld);
    computeCanonicalDelta(_qBoneWorld, restWorldArr, _qDelta);
    const a = ballJointAngles(_qDelta, REST_DOWN_LOCAL, strategy.mirror);
    raw = { flexion: a.flexion, abduction: a.abduction, rotation: a.rotation };
    anatomicFlexion = a.flexion * (strategy.flexionSign ?? 1);
    flexRange = lookupRange(canonicalKey, strategy.flexionField);
    abdRange = lookupRange(canonicalKey, strategy.abductionField);
    rotRange = lookupRange(canonicalKey, strategy.rotationField);
  } else {
    // hinge
    const restWorldArr = rest.worldQuats[canonicalKey];
    if (!restWorldArr) return null;
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(_qBoneWorld);
    computeCanonicalDelta(_qBoneWorld, restWorldArr, _qDelta);
    const a = ballJointAngles(_qDelta, REST_DOWN_LOCAL, false);
    raw = { flexion: a.flexion, abduction: a.abduction, rotation: a.rotation };
    anatomicFlexion = a.flexion * strategy.flexionSign;
    flexRange = lookupRange(canonicalKey, strategy.flexionField);
    abdRange = strategy.abductionRange;
    rotRange = strategy.rotationRange;
  }

  return { strategy: strategy.kind, raw, anatomicFlexion, ranges: { flexion: flexRange, abduction: abdRange, rotation: rotRange } };
}

/** All canonical keys with a clamp strategy, in a stable order. */
export function listClampedJoints(): string[] {
  return Object.keys(STRATEGIES);
}
