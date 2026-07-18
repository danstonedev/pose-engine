/**
 * Root motion (simMOVE full-body layer) — whole-body posture + travel applied
 * to the MODEL ROOT (the Object3D above the skeleton), NOT to any joint. This
 * is what turns the goniometry rig into a movement rig: it can now lie down,
 * roll, jump, step, and stand as a closed chain, all WITHOUT touching a single
 * clinical joint readout.
 *
 * Two free (UN-clamped) primitives + one closed-chain approximation:
 *   - ORIENT: reorient the whole body in the world (pitch = supine/prone,
 *     roll = side-lying, yaw = log-roll). Distinct from pelvic-tilt AROM — it
 *     rides the model root, so the Hips-relative and world-frame joint readouts
 *     stay valid once the rest reference is rotated by the same amount
 *     ({@link rotateRestReferenceByRoot}).
 *   - TRANSLATE: move the model root in meters from the anatomic stance origin
 *     (Y = jump, X/Z = step / travel / transfer).
 *   - PLANTED foot-pin ({@link pinRootToFloor}): the cheap closed-chain trick —
 *     after a keyframe's JOINT pose is applied, drop the root so the lower foot
 *     returns to floor level. Hip+knee+ankle flexion then reads as a SQUAT
 *     (pelvis drops, feet grounded); plantarflexion as a heel raise; trunk+hip
 *     flexion as a real hip-hinge toe-touch.
 *
 * Pure THREE on plain data / live skeletons — no Svelte, no DOM — so the
 * headless battery (fullBodyMotion.test.ts) exercises the SAME code the stage
 * does.
 */
import * as THREE from 'three';
import { normalizeBoneNameForVariant, type BodyVariantConfig } from '../anatomy/bodyVariants';
import type { JointAngleRestReference } from './jointAngles';

const RAD = Math.PI / 180;

/** Free whole-body reorientation of the model root. Degrees. */
export interface RootOrient {
  /** About the medio-lateral axis: −90 = supine (face up), +90 = prone. */
  pitchDeg?: number;
  /** About the anterior-posterior axis: ±90 = side-lying. */
  rollDeg?: number;
  /** About the vertical axis: log-roll / turn in place. */
  yawDeg?: number;
}

/** Whole-body root transform for one keyframe (posture + travel). */
export interface RootTransform {
  orient?: RootOrient;
  /** Meters from the anatomic stance origin, in WORLD space:
   *  [x (subject-left+), y (up+), z (+ = the way the body faces / forward)].
   *  The mesh physically faces world +Z (measured), so +z travels forward. (The
   *  clinical joint-angle readout in jointAngles.ts labels this axis the other
   *  way — a measurement-frame naming choice, not the physical facing; never use
   *  that label to choose a travel sign. Prefer the semantic `travel` vocabulary
   *  in motionSequence over a raw signed axis.) */
  translateM?: [number, number, number];
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

/**
 * World quaternion for a root orientation. pitch about body-X (medio-lateral),
 * yaw about body-Y (vertical), roll about body-Z (A-P), composed YXZ — the same
 * order the joint-angle readouts decompose with. Verified on the rig: pitch −90
 * lays the body supine (head & feet at floor level, belly up); +90 prone; roll
 * ±90 side-lying; yaw turns in place.
 */
export function rootOrientQuat(orient: RootOrient | undefined): THREE.Quaternion {
  _e.set((orient?.pitchDeg ?? 0) * RAD, (orient?.yawDeg ?? 0) * RAD, (orient?.rollDeg ?? 0) * RAD, 'YXZ');
  return _q.setFromEuler(_e).clone();
}

/** Same as {@link rootOrientQuat} but as a serializable [x,y,z,w] tuple. */
export function rootOrientQuatTuple(orient: RootOrient | undefined): [number, number, number, number] {
  const q = rootOrientQuat(orient);
  return [q.x, q.y, q.z, q.w];
}

/**
 * A copy of `rest` with every WORLD-frame reference (pelvis + per-bone world
 * quaternions and long-axis directions) pre-rotated by the root orientation.
 * Parent-local readouts (spine / limbs) are untouched — they are unaffected by
 * a root transform. Feed this to `computeJointAngles` whenever the model root
 * carries an orientation, so a reoriented body reads its joints relative to its
 * OWN (reoriented) torso: a body lying supine at rest reads 0° everywhere, and
 * a shoulder flexed under supine still reads its true flexion.
 */
export function rotateRestReferenceByRoot(
  rest: JointAngleRestReference,
  rootWorldQuat: THREE.Quaternion,
): JointAngleRestReference {
  const rot4 = (a: [number, number, number, number]): [number, number, number, number] => {
    const q = new THREE.Quaternion(a[0], a[1], a[2], a[3]).premultiply(rootWorldQuat);
    return [q.x, q.y, q.z, q.w];
  };
  const rot3 = (a: [number, number, number]): [number, number, number] => {
    const v = new THREE.Vector3(a[0], a[1], a[2]).applyQuaternion(rootWorldQuat);
    return [v.x, v.y, v.z];
  };
  const worldQuats: Record<string, [number, number, number, number]> = {};
  for (const k in rest.worldQuats) worldQuats[k] = rot4(rest.worldQuats[k]!);
  let worldDirs: Record<string, [number, number, number]> | undefined;
  if (rest.worldDirs) {
    worldDirs = {};
    for (const k in rest.worldDirs) worldDirs[k] = rot3(rest.worldDirs[k]!);
  }
  return {
    pelvisWorldQuat: rot4(rest.pelvisWorldQuat),
    localQuats: rest.localQuats,
    worldQuats,
    ...(worldDirs ? { worldDirs } : {}),
  };
}

/** Canonical bones that can touch the floor (heel/ankle + forefoot). */
const CONTACT_KEYS = ['L_Foot', 'R_Foot', 'L_Toes', 'R_Toes'] as const;

function contactBones(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
): { key: string; bone: THREE.Bone }[] {
  const wanted = new Set<string>(CONTACT_KEYS);
  const out: { key: string; bone: THREE.Bone }[] = [];
  for (const bone of skeleton.bones) {
    const norm = normalizeBoneNameForVariant(bone.name, variantCfg.boneNameMap);
    if (!norm.canonical) continue;
    const side = norm.side === 'Left' ? 'L_' : norm.side === 'Right' ? 'R_' : '';
    const key = `${side}${norm.canonical}`;
    if (wanted.has(key)) out.push({ key, bone });
  }
  return out;
}

/** Per-contact rest world-Y — the floor reference each ground-contact bone
 *  returns to under a PLANTED stance. Captured once at anatomic rest. */
export interface FloorReference {
  restY: Record<string, number>;
}

const _fp = new THREE.Vector3();

/** Capture the rest world-Y of every ground-contact bone (heel/ankle +
 *  forefoot) — the planted-stance floor reference. Call after applyAnatomicPose
 *  with world matrices current. */
export function captureFloorReference(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
): FloorReference {
  const restY: Record<string, number> = {};
  for (const { key, bone } of contactBones(skeleton, variantCfg)) {
    restY[key] = bone.getWorldPosition(_fp).y;
  }
  return { restY };
}

/** Lowest foot (ankle) world-Y at the current pose. Caller must have updated
 *  world matrices. Returns null when no foot bone resolves. */
export function lowestFootWorldY(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
): number | null {
  let min = Infinity;
  for (const { key, bone } of contactBones(skeleton, variantCfg)) {
    if (key.endsWith('Foot')) min = Math.min(min, bone.getWorldPosition(_fp).y);
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * PLANTED stance: after a keyframe's joint pose is applied, shift the model root
 * along Y so the DEEPEST-penetrating ground-contact bone returns to its floor
 * level (`floor.restY`). This is the cheap closed-chain approximation:
 *   - hip+knee+ankle flexion → SQUAT (the foot is the deepest contact; the body
 *     sinks so it stays grounded, pelvis + head drop);
 *   - plantarflexion → HEEL RAISE (the toe swings down to become the deepest
 *     contact; the body rises so the toe stays grounded, heel lifts);
 *   - trunk+hip flexion → real hip-hinge toe-touch.
 * Taking the deepest contact (max required lift) keeps whichever part is lowest
 * exactly on the floor and lets the rest sit at or above it.
 *
 * Mutates `root.position.y` and refreshes world matrices. Returns the Y shift
 * applied. No-op (returns 0) if no contact bone is found.
 */
export function pinRootToFloor(
  root: THREE.Object3D,
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  floor: FloorReference,
): number {
  root.updateMatrixWorld(true);
  let lift = -Infinity;
  for (const { key, bone } of contactBones(skeleton, variantCfg)) {
    const restY = floor.restY[key];
    if (restY == null) continue;
    lift = Math.max(lift, restY - bone.getWorldPosition(_fp).y);
  }
  if (!Number.isFinite(lift)) return 0;
  root.position.y += lift;
  root.updateMatrixWorld(true);
  return lift;
}

// ── Calibrated gait vertical (mean-preserving reshape) ───────────────────────

/** A calibration that reshapes an emergent grounded pelvis arc to a target
 *  excursion: `root.y ← mean + gain·(root.y − mean)`. gain 1 = identity. */
export interface VerticalCalibration {
  meanY: number;
  gain: number;
}

/** Identity — leaves the grounded root untouched. */
export const NO_VERTICAL_CALIBRATION: VerticalCalibration = { meanY: 0, gain: 1 };

/**
 * Derive a MEAN-PRESERVING vertical calibration from the emergent grounded
 * pelvis arc. `groundedRootYAtPhase(u)` must return the floor-pinned model-root
 * Y at cycle phase u∈[0,1) (the caller poses the rig + floor-pins + reads
 * root.position.y). Samples `steps` phases, then scales the arc's peak-to-peak to
 * `targetM` about its mean — so the mean (grounding) is preserved and only the
 * extremes deviate from the floor by (1−gain)·½·excursion. The SAME function is
 * used by the offline sampler and the live stage, so they cannot diverge.
 */
export function deriveVerticalCalibration(
  groundedRootYAtPhase: (u01: number) => number,
  targetM: number,
  steps = 48,
): VerticalCalibration {
  let sum = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < steps; i += 1) {
    const y = groundedRootYAtPhase(i / steps);
    sum += y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const meanY = sum / Math.max(1, steps);
  const p2p = hi - lo;
  // Clamp so a request can only calm the vault or amplify it within a believable
  // band — never invert or explode it; a degenerate flat arc stays identity.
  const gain = p2p > 1e-4 ? Math.max(0.1, Math.min(1.6, targetM / p2p)) : 1;
  return { meanY, gain };
}

/** Apply a vertical calibration to a grounded root-Y. */
export function applyVerticalCalibration(y: number, cal: VerticalCalibration): number {
  return cal.gain === 1 ? y : cal.meanY + cal.gain * (y - cal.meanY);
}
