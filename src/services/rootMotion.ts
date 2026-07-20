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
  /** About the vertical axis: turn in place. */
  yawDeg?: number;
  /** RAW world quaternion [x,y,z,w] — used DIRECTLY when present, bypassing the
   *  pitch/roll/yaw Euler (which gimbal-locks at supine/prone ±90° and applies roll in
   *  the BODY frame, so it can't express a log-roll about the world long axis). This is
   *  the primitive for arbitrary reorientations: log-rolls, twists, tumbles — any axis
   *  the Euler triple can't reach. Normalized on use. */
  quat?: [number, number, number, number];
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
  // RAW quaternion wins — the arbitrary-orientation primitive (log-rolls, twists) the
  // Euler triple can't express. Normalized so an un-normalized authored quat is safe.
  if (orient?.quat) {
    const [x, y, z, w] = orient.quat;
    return _q.set(x, y, z, w).normalize().clone();
  }
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
  /** The ground-plane world-Y (the lowest foot contact's rest-Y) — the level a
   *  NON-foot contact (a hand in a push-up, a knee in quadruped) is grounded to,
   *  and the datum a seat height is measured up from. */
  floorY: number;
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
  const feet = Object.values(restY);
  const floorY = feet.length ? Math.min(...feet) : 0;
  return { restY, floorY };
}

/** One grounding contact: a bone that should meet a support plane at `targetY`.
 *  'vertical' contributes to the whole-body max-lift Y pin; 'reach' is a secondary
 *  contact left for a per-limb IK reach (Tier B). */
export interface GroundContact {
  bone: string;
  targetY: number;
  mode?: 'vertical' | 'reach';
}

/** Height (m) the PELVIS BONE grounds to above the floor when seated — a normal
 *  chair seat (~0.45 m) plus the pelvis centre's rise above the ischial contact
 *  (~0.15 m). Chosen so the seated pelvis matches the foot-grounded seated flex
 *  (hip ~85° / knee ~95°) → the feet→pelvis grounding switch stays seam-free. */
export const SEAT_HEIGHT_M = 0.59;

/** Resolve the canonical pose key → live bone map once (any bone, not just feet). */
function boneByCanonicalKey(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
): Map<string, THREE.Bone> {
  const out = new Map<string, THREE.Bone>();
  for (const bone of skeleton.bones) {
    const norm = normalizeBoneNameForVariant(bone.name, variantCfg.boneNameMap);
    if (!norm.canonical) continue;
    const side = norm.side === 'Left' ? 'L_' : norm.side === 'Right' ? 'R_' : '';
    out.set(`${side}${norm.canonical}`, bone);
  }
  return out;
}

/**
 * The ordered contact set that grounds a named grounding posture, resolved against
 * the captured {@link FloorReference}. 'standing' (and any unknown) → the feet at
 * their rest-Y (identical to {@link pinRootToFloor}). 'sitting' → the PELVIS at seat
 * height (a chair/bed under the measured pelvis) — NOT a foot-grounded squat — with
 * the feet at the floor as a co-lift reference. Phase-3 postures (kneeling/quadruped/
 * plank) extend this table.
 */
export function groundingContactsFor(posture: string, floor: FloorReference): GroundContact[] {
  switch (posture) {
    case 'sitting':
      return [
        { bone: 'Hips', targetY: floor.floorY + SEAT_HEIGHT_M, mode: 'vertical' },
      ];
    case 'plank':
      // PLANK / PUSH-UP: the body is a straight prone-frame line held on the TOES
      // (behind) and the HANDS (front). The toes are the PRIMARY vertical pin (they
      // set the whole-body height, exactly like the feet do standing); each hand is
      // a REACH contact left for the per-arm hand-plant IK, so it stays planted on
      // the floor as the chest lowers (the arm folds — the push-up). floorY is the
      // ground plane for BOTH ends.
      return [
        { bone: 'L_Toes', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'R_Toes', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'L_Hand', targetY: floor.floorY, mode: 'reach' },
        { bone: 'R_Hand', targetY: floor.floorY, mode: 'reach' },
      ];
    // QUADRUPED (hands-and-knees): trunk horizontal, held on the SHINS (the knee bone
    // `Leg`) behind and the HANDS in front. The knees are the primary vertical pin
    // (max-lift picks the lower, so a raised knee simply lifts — bird-dog); each planted
    // hand is a reach contact for the hand-plant IK. The `-hand-L` / `-hand-R` variants
    // ground only ONE hand, freeing the other arm to reach out (bird-dog).
    case 'quadruped':
      return [
        { bone: 'L_Leg', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'R_Leg', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'L_Hand', targetY: floor.floorY, mode: 'reach' },
        { bone: 'R_Hand', targetY: floor.floorY, mode: 'reach' },
      ];
    case 'quadruped-hand-L':
      return [
        { bone: 'L_Leg', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'R_Leg', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'L_Hand', targetY: floor.floorY, mode: 'reach' },
      ];
    case 'quadruped-hand-R':
      return [
        { bone: 'L_Leg', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'R_Leg', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'R_Hand', targetY: floor.floorY, mode: 'reach' },
      ];
    // KNEELING (upright on the knees): torso vertical (identity orient), the SHINS on
    // the floor bearing the body — the pelvis rides at thigh height, no hands. Just the
    // knee vertical pin (a tall quadruped without the front support).
    case 'kneeling':
      return [
        { bone: 'L_Leg', targetY: floor.floorY, mode: 'vertical' },
        { bone: 'R_Leg', targetY: floor.floorY, mode: 'vertical' },
      ];
    default:
      return Object.entries(floor.restY).map(([bone, targetY]) => ({ bone, targetY, mode: 'vertical' }));
  }
}

/**
 * Vertical whole-body pin over an EXPLICIT contact list with EXPLICIT targets — the
 * generalisation of {@link pinRootToFloor} to non-foot contacts (a seated pelvis, a
 * planted hand). Lifts the root so the DEEPEST-penetrating 'vertical' contact meets
 * its target-Y, exactly as the feet-only pin does; orientation-agnostic (moves
 * `root.position.y` only). Returns the Y shift; no-op (0) when no vertical contact
 * resolves.
 */
export function pinContactsToFloor(
  root: THREE.Object3D,
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  contacts: GroundContact[],
): number {
  root.updateMatrixWorld(true);
  const bones = boneByCanonicalKey(skeleton, variantCfg);
  let lift = -Infinity;
  for (const c of contacts) {
    if (c.mode === 'reach') continue;
    const bone = bones.get(c.bone);
    if (!bone || !Number.isFinite(c.targetY)) continue;
    lift = Math.max(lift, c.targetY - bone.getWorldPosition(_fp).y);
  }
  if (!Number.isFinite(lift)) return 0;
  root.position.y += lift;
  root.updateMatrixWorld(true);
  return lift;
}

// ── Closed-chain foot-rooted planting (feet stay planted, body folds over them) ─

/** Full rest WORLD frame (position + orientation) of each ankle (Foot) bone,
 *  captured at anatomic stance — the target a foot-rooted plant restores the
 *  stance foot to. Call after applyAnatomicPose with world matrices current. */
export interface FootFrameReference {
  restFrame: Record<string, THREE.Matrix4>;
}

export function captureFootFrames(
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
): FootFrameReference {
  const restFrame: Record<string, THREE.Matrix4> = {};
  for (const { key, bone } of contactBones(skeleton, variantCfg)) {
    if (key.endsWith('Foot')) restFrame[key] = bone.matrixWorld.clone();
  }
  return { restFrame };
}

const _mInv = new THREE.Matrix4();
const _mT = new THREE.Matrix4();
const _fp2 = new THREE.Vector3();

/**
 * Positional drift (meters) of the LOWEST foot from its rest world frame — how
 * far a pelvis-rooted FK has swung the stance foot off its planted position.
 * ~0 when the stance foot is already planted (a single-leg stance leaves the
 * bearing leg untouched), large for a squat / hip-hinge / sit-to-stand whose
 * feet swing forward. This is the signal for WHETHER a foot-rooted re-plant
 * ({@link plantStanceFoot}) does real work: below a small epsilon the body is
 * already correctly grounded and re-rooting is a pure no-op (worse, its tiny
 * measurement-frame rotation only adds noise), so the caller should skip it.
 * Returns null when no foot frame resolves. Caller must have updated world
 * matrices; picks the SAME lowest foot as {@link plantStanceFoot}.
 */
export function stanceFootDrift(
  root: THREE.Object3D,
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  frames: FootFrameReference,
): number | null {
  root.updateMatrixWorld(true);
  let stanceKey: string | null = null;
  let stanceBone: THREE.Bone | null = null;
  let minY = Infinity;
  for (const { key, bone } of contactBones(skeleton, variantCfg)) {
    if (!key.endsWith('Foot') || !frames.restFrame[key]) continue;
    const y = bone.getWorldPosition(_fp).y;
    if (y < minY) {
      minY = y;
      stanceKey = key;
      stanceBone = bone;
    }
  }
  if (!stanceKey || !stanceBone) return null;
  _fp2.setFromMatrixPosition(frames.restFrame[stanceKey]!);
  return stanceBone.getWorldPosition(_fp).distanceTo(_fp2);
}

/**
 * CLOSED-CHAIN foot-rooted planting — the fix for planted movements whose feet
 * swing forward. A keyframe's pelvis-rooted FK treats the pelvis as the chain
 * root, so the stance leg's authored hip/knee flexion swings the FOOT forward
 * (a leg-raise), not the pelvis over a planted foot. This RE-ROOTS the whole
 * rigid body so the STANCE foot returns to its rest world frame — planted flat
 * at its standing position — turning the leg-swing into the real closed-chain
 * movement: a hip-hinge folds the trunk over planted feet (hips travel back,
 * pelvis stays at hip height), a squat drops the pelvis over planted feet, and
 * the COM lands over the base by construction (balance for free).
 *
 * Every authored JOINT angle is UNTOUCHED — this is a rigid transform of the
 * whole body, so only the pelvis PLACEMENT changes (exactly what a fixed foot
 * determines). The stance foot is the LOWEST ankle (single-leg → the
 * weight-bearing foot; a symmetric bilateral stance → either, both land
 * planted). Supersedes the vertical-only {@link pinRootToFloor} for the
 * quasi-static planted set (it grounds vertically too). Mutates `root` and
 * refreshes world matrices. Returns the planted foot key, or null when none
 * resolve.
 */
export function plantStanceFoot(
  root: THREE.Object3D,
  skeleton: THREE.Skeleton,
  variantCfg: BodyVariantConfig,
  frames: FootFrameReference,
): string | null {
  root.updateMatrixWorld(true);
  let stanceKey: string | null = null;
  let stanceBone: THREE.Bone | null = null;
  let minY = Infinity;
  for (const { key, bone } of contactBones(skeleton, variantCfg)) {
    if (!key.endsWith('Foot') || !frames.restFrame[key]) continue;
    const y = bone.getWorldPosition(_fp).y;
    if (y < minY) {
      minY = y;
      stanceKey = key;
      stanceBone = bone;
    }
  }
  if (!stanceKey || !stanceBone) return null;
  // T = restFrame · currentFrame⁻¹ maps the stance foot from where the FK left
  // it back onto its rest frame; applied to the whole body, it re-roots at the
  // foot (feet planted, pelvis placed by the chain).
  _mInv.copy(stanceBone.matrixWorld).invert();
  _mT.copy(frames.restFrame[stanceKey]).multiply(_mInv);
  root.applyMatrix4(_mT);
  root.updateMatrixWorld(true);
  return stanceKey;
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
 *  excursion: `root.y ← mean + gain·(root.y − mean)`. gain 1 = identity.
 *  When `smoothed` is present, the calibration instead REPLACES root.y with a
 *  phase-indexed, temporally-smoothed target arc (see deriveVerticalCalibration
 *  `smooth`) — this rounds the sharp double-support valley of the raw floor-pin
 *  into a believable sinusoid-like glide, so applyVerticalCalibration needs the
 *  cycle phase. */
export interface VerticalCalibration {
  meanY: number;
  gain: number;
  /** Phase-indexed smoothed target model-root Y, one sample per phase bucket over
   *  [0,1). Present ⇒ apply returns the lerped table value for the given phase;
   *  absent ⇒ the pointwise mean/gain amplitude scale. */
  smoothed?: number[];
  /** Max metres the smoothed target may sit ABOVE the live floor-pin. The smoothed
   *  arc rounds the double-support valley by raising the pelvis, but raising it above
   *  the pin makes a planted stance leg OVER-reach (foot lifts/slides via the foot-plant
   *  IK). Clamping the rise bounds that over-reach: `min(smoothed, pin + maxRiseM)`.
   *  Undefined ⇒ no clamp (e.g. the contact-free in-place walk). */
  maxRiseM?: number;
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
 *
 * With `smooth`, additionally low-pass the periodic arc (circular moving-average)
 * before the amplitude scale and return the smoothed, mean-preserving target arc
 * as a phase table. The raw floor-pin drops abruptly into double support (a sharp
 * V-valley) and climbs out slowly — a sawtooth that reads as a "sudden drop"; the
 * smoothing rounds it into a symmetric glide while preserving the mean grounding.
 */
export function deriveVerticalCalibration(
  groundedRootYAtPhase: (u01: number) => number,
  targetM: number,
  steps = 48,
  smooth = false,
  maxRiseM?: number,
): VerticalCalibration {
  const raw: number[] = [];
  let sum = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < steps; i += 1) {
    const y = groundedRootYAtPhase(i / steps);
    raw.push(y);
    sum += y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const meanY = sum / Math.max(1, steps);
  const p2p = hi - lo;
  // Clamp so a request can only calm the vault or amplify it within a believable
  // band — never invert or explode it; a degenerate flat arc stays identity.
  const gain = p2p > 1e-4 ? Math.max(0.1, Math.min(1.6, targetM / p2p)) : 1;
  if (!smooth || steps < 4) return { meanY, gain };
  // Circular moving-average over ±~1/12 of the cycle (the arc is periodic, so wrap
  // the window), then amplitude-scale the SMOOTHED arc about its mean to the target.
  const win = Math.max(1, Math.round(steps / 12));
  const sm: number[] = new Array(steps);
  let smSum = 0;
  let smLo = Infinity;
  let smHi = -Infinity;
  for (let i = 0; i < steps; i += 1) {
    let acc = 0;
    for (let k = -win; k <= win; k += 1) acc += raw[(((i + k) % steps) + steps) % steps]!;
    const v = acc / (2 * win + 1);
    sm[i] = v;
    smSum += v;
    if (v < smLo) smLo = v;
    if (v > smHi) smHi = v;
  }
  const smMean = smSum / steps;
  const smP2p = smHi - smLo;
  const smGain = smP2p > 1e-4 ? Math.max(0.1, Math.min(1.6, targetM / smP2p)) : 1;
  const smoothed = sm.map((v) => smMean + smGain * (v - smMean));
  return { meanY: smMean, gain: smGain, smoothed, maxRiseM };
}

/** Apply a vertical calibration to a grounded root-Y. When the calibration carries
 *  a smoothed phase table and `u01` (cycle phase) is given, returns the lerped
 *  smoothed target (temporal smoothing) — clamped so it never rises more than
 *  `maxRiseM` above the live pin `y` (keeps a planted stance leg from over-reaching);
 *  otherwise the pointwise amplitude scale. */
export function applyVerticalCalibration(y: number, cal: VerticalCalibration, u01?: number): number {
  if (cal.smoothed && cal.smoothed.length > 0 && u01 != null) {
    const N = cal.smoothed.length;
    const x = (((u01 % 1) + 1) % 1) * N;
    const i0 = Math.floor(x) % N;
    const i1 = (i0 + 1) % N;
    const f = x - Math.floor(x);
    const s = cal.smoothed[i0]! * (1 - f) + cal.smoothed[i1]! * f;
    return cal.maxRiseM != null ? Math.min(s, y + cal.maxRiseM) : s;
  }
  return cal.gain === 1 ? y : cal.meanY + cal.gain * (y - cal.meanY);
}

// ── Foot-driven forward travel (root motion FROM foot placement) ──────────────

/** A precomputed forward-travel (world +Z) offset curve over one motion, sampled
 *  at `stepMs` and lerped in between. */
export interface FootDrivenTravel {
  totalMs: number;
  /** Forward (+Z) root offset, meters, at absolute time tMs. */
  zAt(tMs: number): number;
}

/** The world Z (forward) of each foot at a phase — what the derivation reads. */
export interface FeetZ {
  rz: number;
  lz: number;
  /** World Y of each foot (to pick the planted/lower one). */
  ry: number;
  ly: number;
}

/**
 * Derive a forward-travel curve that keeps the PLANTED foot world-fixed — the
 * industry "root motion from foot placement" done right, and the fix for the
 * travel walk's foot-slide.
 *
 * The gait FK sweeps the stance foot backward in body space; a real walk keeps
 * that foot planted and moves the BODY forward by the same amount. So instead of
 * authoring an independent stride (which never matches the FK and drags the foot),
 * we MEASURE the FK foot sweep and advance the root to cancel it: each frame, the
 * lower (weight-bearing) foot is the planted one, and the root steps forward by
 * exactly that foot's backward body-space motion since the previous frame — so it
 * does not move in the world. At a handoff (the lower foot changes, i.e. the new
 * foot has landed) the root makes no advance that frame, then tracks the new foot.
 * No foot-lock IK, no capture timing to get wrong: the stance foot is fixed by
 * construction, the swing foot rides the body forward, and the stride EMERGES from
 * the authored hip/knee ROM (so a paced walk's bigger swing travels farther too).
 *
 * `sampleFeetAtPhase(tMs)` poses the rig at tMs (FK + floor-pin, NO travel) and
 * returns the feet world Z/Y. Sampled in time order over `steps`; returns a
 * piecewise-linear lookup. Vertical grounding stays with the floor-pin — this only
 * owns the forward axis.
 */
export function deriveFootDrivenTravel(
  sampleFeetAtPhase: (tMs: number) => FeetZ,
  totalMs: number,
  steps = 120,
): FootDrivenTravel {
  const n = Math.max(2, steps);
  const dt = totalMs / (n - 1);
  const z = new Array<number>(n).fill(0);
  let prev = sampleFeetAtPhase(0);
  let planted: 'R' | 'L' = prev.ry <= prev.ly ? 'R' : 'L';
  for (let i = 1; i < n; i += 1) {
    const cur = sampleFeetAtPhase(i * dt);
    const lower: 'R' | 'L' = cur.ry <= cur.ly ? 'R' : 'L';
    if (lower === planted) {
      // Advance the root by the planted foot's backward body-space step, so its
      // world position does not change.
      const back = planted === 'R' ? prev.rz - cur.rz : prev.lz - cur.lz;
      z[i] = z[i - 1]! + back;
    } else {
      // Handoff: the new foot just landed — no advance this frame, then track it.
      z[i] = z[i - 1]!;
      planted = lower;
    }
    prev = cur;
  }
  return {
    totalMs,
    zAt(tMs: number): number {
      if (tMs <= 0) return z[0]!;
      if (tMs >= totalMs) return z[n - 1]!;
      const u = tMs / dt;
      const k = Math.min(n - 2, Math.floor(u));
      return z[k]! + (z[k + 1]! - z[k]!) * (u - k);
    },
  };
}
