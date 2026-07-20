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
import type { TrajectoryGroundingSwitch } from './motionTrajectory';

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

/** Stance-foot drift (m) above which a planted, in-place frame is re-rooted at
 *  the foot ({@link plantStanceFoot}). A squat/hinge/sit-to-stand swings the
 *  foot tens of cm off its rest frame (well above this); a single-leg stance
 *  leaves the bearing foot home (~0), so it stays on the cheap vertical pin and
 *  its measurement frame is never perturbed. ONE constant shared by the offline
 *  sampler (motionRecording), the live stage (ExamStage3D) and the balance
 *  pre-pass (balanceCoordination), so the three can never disagree on when the
 *  closed chain engages. */
export const FOOT_ROOT_DRIFT_M = 0.05;

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

// ── Grounding-switch root-Y crossfade (SEAM-4 / SEAM-5) ──────────────────────
// A grounding-posture change swaps the vertical pin (feet ↔ seat/knees/toes) at
// a single knot. Mid-transition the two pin solutions can disagree by tens of
// cm (measured: the get-down-to-quadruped step dropped the root 53 cm in one
// frame and swept the feet 0.5 m below the floor; stand-from-sit hopped
// 9.94 cm), so the discrete swap is a hard seam. The fix is a root-Y CROSSFADE
// between the OUTGOING and INCOMING pin solutions, anchored where the posture's
// authored keyframe sits:
//
//   • ENTERING a limb-grounded posture (feet → plank/quadruped/kneeling): the
//     incoming pin rests on limbs (toes/knees) that only land at the posture
//     keyframe — mid-transition it is wildly wrong (the 53 cm free-fall). So
//     the OUTGOING (feet) pin keeps governing through the transition segment
//     and the incoming pin crossfades in over the LAST ~200 ms into the
//     ARRIVAL keyframe — the knot that authors the posture, where the two
//     solutions are close by construction (templates land the posture's
//     contacts on the floor at that pose) — and fully owns it from arrival on.
//   • LEAVING a named posture (sitting/… → feet) — or ENTERING a seat-like
//     (pelvis-grounded, pose-independent) one like 'sitting': the incoming pin
//     is valid immediately (the tuned sit-down lowers onto the seat pin the
//     whole way), so only the residual step needs closing — the window is
//     centered on the SWAP knot, the posture span's boundary keyframe (the
//     stand-from-sit "swap keyframe").
//
// In both cases the named posture's pin owns exactly its authored span and each
// handoff is a monotone, eased ~200 ms blend. Derived once per motion from the
// trajectory's grounding switches; the offline sampler and the live stage share
// the derivation AND the per-frame applier below, so they cannot diverge
// (lockstep). No switches ⇒ no spans ⇒ every existing motion is byte-identical.

/** Crossfade window length (ms) for a grounding pin swap. */
export const GROUNDING_BLEND_MS = 200;

/** One root-Y override span around a grounding switch. Between `fromMs` and
 *  `rampFromMs` the OUTGOING grounding governs (w = 0); across
 *  [rampFromMs, rampToMs] the eased weight blends outgoing → incoming; at
 *  `toMs` (== rampToMs) the incoming grounding has fully taken over, matching
 *  the un-overridden path outside the span (C0 at both edges). */
export interface GroundingBlendSpan {
  fromMs: number;
  toMs: number;
  rampFromMs: number;
  rampToMs: number;
  fromPosture?: string;
  toPosture?: string;
  fromPlanted: boolean;
  toPlanted: boolean;
}

/** Monotone C¹ ease (smoothstep) for the crossfade weight. */
function groundingBlendEase(u: number): number {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
}

/** True when a posture's VERTICAL pin rests only on root-rigid bones (the
 *  pelvis) — a seat-height pin whose solution is pose-independent, so engaging
 *  it for the whole transition segment is valid (the tuned sit-down behaviour:
 *  the seat is a fixed platform the body lowers onto). A limb-grounded pin
 *  (toes/knees) instead depends on limbs that only land at the posture
 *  keyframe — mid-transition it is wildly wrong and must ramp in at arrival.
 *  The contact STRUCTURE is floor-independent, so a null floor reference
 *  serves the enumeration. */
function seatLikePosture(posture: string): boolean {
  return groundingContactsFor(posture, { restY: {}, floorY: 0 }).every(
    (c) => c.mode === 'reach' || c.bone === 'Hips',
  );
}

/**
 * Derive the root-Y override spans for a trajectory's grounding switches (see
 * the section doc for the anchoring rule). Pure and cheap — no rig sampling.
 * Windows are clamped so they never cross a neighbouring switch or the
 * trajectory ends; a window clamped to zero length degenerates to the legacy
 * discrete swap (no span emitted).
 */
export function deriveGroundingBlendSpans(
  switches: readonly TrajectoryGroundingSwitch[] | undefined,
  totalMs: number,
): GroundingBlendSpan[] {
  const spans: GroundingBlendSpan[] = [];
  if (!switches?.length) return spans;
  const half = GROUNDING_BLEND_MS / 2;
  for (let i = 0; i < switches.length; i += 1) {
    const s = switches[i]!;
    const prevEnd = spans.length ? spans[spans.length - 1]!.toMs : 0;
    const nextTMs = i + 1 < switches.length ? switches[i + 1]!.tMs : totalMs;
    const base = {
      ...(s.fromPosture ? { fromPosture: s.fromPosture } : {}),
      ...(s.toPosture ? { toPosture: s.toPosture } : {}),
      fromPlanted: s.fromPlanted,
      toPlanted: s.toPlanted,
    };
    if (s.toPosture && !seatLikePosture(s.toPosture)) {
      // ENTERING a limb-grounded posture: outgoing pin governs the transition
      // segment; the incoming pin crossfades in over the LAST ~200 ms into the
      // ARRIVAL keyframe, fully owning it from arrival on (its authored pose —
      // where the two solutions are close by construction — is never
      // overridden).
      const rampFrom = Math.max(s.tMs, s.arriveMs - GROUNDING_BLEND_MS, prevEnd);
      const rampTo = Math.min(s.arriveMs, nextTMs, totalMs);
      if (rampTo <= rampFrom + 1e-6) continue; // degenerate — keep the legacy swap
      spans.push({
        fromMs: Math.max(s.tMs, prevEnd),
        toMs: rampTo,
        rampFromMs: rampFrom,
        rampToMs: rampTo,
        ...base,
      });
    } else {
      // LEAVING a named posture to the feet — or ENTERING a seat-like (pelvis-
      // grounded, pose-independent) one: the incoming pin is valid immediately,
      // so only the residual step at the swap needs closing — crossfade
      // centered on the SWAP knot (the posture span's boundary keyframe).
      const rampFrom = Math.max(s.tMs - half, prevEnd, 0);
      const rampTo = Math.min(s.tMs + half, s.arriveMs, nextTMs);
      if (rampTo <= rampFrom + 1e-6) continue;
      spans.push({ fromMs: rampFrom, toMs: rampTo, rampFromMs: rampFrom, rampToMs: rampTo, ...base });
    }
  }
  return spans;
}

/** The active override at `tMs`, with its eased crossfade weight — or null
 *  outside every span (the caller takes its un-overridden grounding path). */
export function groundingBlendAt(
  spans: readonly GroundingBlendSpan[],
  tMs: number,
): { span: GroundingBlendSpan; w: number } | null {
  for (const span of spans) {
    if (tMs < span.fromMs - 1e-6 || tMs >= span.toMs - 1e-6) continue;
    const w =
      tMs <= span.rampFromMs
        ? 0
        : groundingBlendEase((tMs - span.rampFromMs) / (span.rampToMs - span.rampFromMs));
    return { span, w };
  }
  return null;
}

/**
 * Apply the blended grounded root-Y for an active override: evaluate BOTH
 * groundings' pin solutions from the same pre-pin state (the caller's
 * `applyPin` mutates root.position.y for one grounding), then set root-Y to the
 * eased crossfade of the two. Root-Y only — orientation, joints, and every
 * non-Y channel are untouched. Shared verbatim by the offline sampler and the
 * live stage (lockstep). Caller must have applied the frame's FK pose + raw
 * root transform with world matrices current.
 */
export function applyBlendedGroundingY(
  root: THREE.Object3D,
  blend: { span: GroundingBlendSpan; w: number },
  applyPin: (posture: string | undefined, planted: boolean) => void,
): void {
  const { span, w } = blend;
  const preY = root.position.y;
  applyPin(span.fromPosture, span.fromPlanted);
  const yFrom = root.position.y;
  let y = yFrom;
  if (w > 0) {
    root.position.y = preY;
    root.updateMatrixWorld(true);
    applyPin(span.toPosture, span.toPlanted);
    y = yFrom + (root.position.y - yFrom) * w;
  }
  root.position.y = y;
  root.updateMatrixWorld(true);
}

/** Ramp-in time (ms) for a newly-engaged hand-reach contact's IK weight —
 *  full-strength engagement snapped the arm at the grounding switch (SEAM-4);
 *  the eased weight folds the reach in instead. */
export const HAND_REACH_RAMP_MS = 150;

/**
 * The eased IK weight (0..1) for a hand-reach contact at `tMs`: 1 when the
 * reach has been active since before the motion's first switch (or the motion
 * never switches — every pre-posture behaviour, e.g. a push-up grounded 'plank'
 * throughout), ramping in over {@link HAND_REACH_RAMP_MS} from the switch that
 * (re)introduced this bone to the active reach set. Pure function of the
 * switch list + time, so the stage and the sampler stay in lockstep.
 */
export function handReachWeightAt(
  switches: readonly TrajectoryGroundingSwitch[] | undefined,
  bone: string,
  tMs: number,
  floor: FloorReference,
): number {
  if (!switches?.length) return 1;
  const hasReach = (posture: string | undefined): boolean =>
    posture != null &&
    groundingContactsFor(posture, floor).some((c) => c.mode === 'reach' && c.bone === bone);
  let engagedAt = -Infinity; // active since the start (or never toggled on)
  for (const s of switches) {
    if (s.tMs > tMs + 1e-6) break;
    const inFrom = hasReach(s.fromPosture);
    const inTo = hasReach(s.toPosture);
    if (inTo && !inFrom) engagedAt = s.tMs; // (re)introduced here — ramp from this switch
    else if (!inTo) engagedAt = -Infinity; // released — a later re-engage restarts the ramp
  }
  if (!Number.isFinite(engagedAt)) return 1;
  return groundingBlendEase((tMs - engagedAt) / HAND_REACH_RAMP_MS);
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

/** How long (ms) the applied vertical calibration BLENDS across a handoff
 *  instead of switching discretely (DET-LOCK-02). Two uses, one window: the
 *  loop-form table is ramped IN over this long at a looping motion's one-shot
 *  entry (standing pin → smoothed gait arc — phase 0⁻ of the loop table is the
 *  wrap segment, not the standing start), and any residual applied-vertical
 *  difference at the live first-pass → loop-clock handoff decays over the same
 *  window. Shared by the offline sampler and the live stage so the two blends
 *  can never diverge. */
export const VCAL_HANDOFF_BLEND_MS = 200;

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

/** A precomputed travel offset curve over one motion, sampled at fixed steps and
 *  lerped in between. The scalar offset rides ALONG the derivation's heading
 *  unit vector (`heading`): for the default heading 0 that is world +Z (the
 *  original forward-travel behaviour, and why the lookup keeps its `zAt` name). */
export interface FootDrivenTravel {
  totalMs: number;
  /** Travel offset ALONG THE HEADING, meters, at absolute time tMs. Heading 0
   *  ⇒ this is exactly the forward (+Z) root offset (back-compat). For a CURVED
   *  heading (`at` present) this is the along-path ARC LENGTH advanced. */
  zAt(tMs: number): number;
  /** Heading unit vector [x, z] the offset rides: root += offset·(x, z).
   *  [0, 1] (straight ahead, +Z) for the default heading 0 — applying it there
   *  is byte-identical to the old z-only ride. Ignored by appliers when the
   *  curved `at` lookup is present. */
  heading: [number, number];
  /** CURVED heading (roadmap 6.2): the accumulated world (x, z) travel offset
   *  at tMs — each derived per-step advance was applied along the heading AT
   *  THAT TIME (`headingDegAt`), so the path is an arc, not a line. Present
   *  ONLY when the derivation was given a per-time heading curve; appliers use
   *  it INSTEAD of `zAt`·`heading`. Absent for a constant heading — that path
   *  (and its application) stays byte-identical to before. */
  at?(tMs: number): [number, number];
}

/** One knot of a piecewise-linear travel-heading curve (degrees about the
 *  vertical axis, same convention as {@link FootDrivenTravel}'s headingDeg:
 *  0 = straight ahead +Z, + toward the subject's left). */
export interface HeadingProfilePoint {
  tMs: number;
  headingDeg: number;
}

/**
 * Piecewise-linear heading lookup over time-ordered profile points — the shared
 * "heading AT THIS TIME" primitive for a curved walk (roadmap 6.2). The gait
 * builder authors the SAME progression as per-keyframe root yaw; the sampler
 * and the live stage both build their lookup from the motion's profile with
 * this ONE function, so the derived travel/shuttle direction can never diverge
 * from the authored body orientation. Lookups clamp at the profile's ends.
 */
export function headingProfileLookup(
  points: readonly HeadingProfilePoint[],
): (tMs: number) => number {
  const pts = points.filter((p) => Number.isFinite(p.tMs) && Number.isFinite(p.headingDeg));
  if (pts.length === 0) return () => 0;
  return (tMs: number): number => {
    if (tMs <= pts[0]!.tMs) return pts[0]!.headingDeg;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (tMs <= b.tMs) {
        const span = b.tMs - a.tMs;
        if (span <= 0) return b.headingDeg;
        return a.headingDeg + ((b.headingDeg - a.headingDeg) * (tMs - a.tMs)) / span;
      }
    }
    return pts[pts.length - 1]!.headingDeg;
  };
}

/** The world Z (forward) of each foot at a phase — what the derivation reads. */
export interface FeetZ {
  rz: number;
  lz: number;
  /** World Y of each foot (to pick the planted/lower one). */
  ry: number;
  ly: number;
  /** World X of each foot — REQUIRED when a non-zero heading is derived (the
   *  planted foot's backward sweep is projected onto the heading unit vector);
   *  ignored for the default heading 0. */
  rx?: number;
  lx?: number;
  /** BOTH feet airborne at this sample (a run's ballistic FLIGHT gap — the
   *  trajectory sample was un-pinned). No grounded reference exists, so the
   *  forward-travel derivation HOLDS the last grounded advance through the gap
   *  and resumes at touchdown (the swing feet sweeping in body space mid-air
   *  must not advance — or retreat — the root). Omit/false for grounded gait:
   *  back-compat, the derivation is then byte-identical to before. */
  bothAirborne?: boolean;
}

/** The world X (medio-lateral) + Y of each foot at a phase — what the lateral
 *  shuttle derivation reads. A caller's single feet-sampling closure can serve
 *  both derivations by returning the union of this and {@link FeetZ}. */
export interface FeetLateral {
  rx: number;
  lx: number;
  /** World Y of each foot (to pick the planted/lower one). */
  ry: number;
  ly: number;
  /** World Z of each foot — REQUIRED when a non-zero heading is derived (the
   *  lateral coordinate is the projection onto the heading's perpendicular);
   *  ignored for the default heading 0. */
  rz?: number;
  lz?: number;
}

/** Vertical separation (m) one foot must rise above the other before the
 *  planted-foot decision hands off — hysteresis so near-tie foot heights (a
 *  standing entry, terminal double support) can't flutter the choice. Shared
 *  by the forward-travel and lateral-shuttle derivations. */
const FOOT_HANDOFF_HYSTERESIS_M = 0.008;

/** A planned single-stance window: `foot` bears weight over [fromMs, toMs].
 *  Shared by the travel + shuttle derivations (trajectory time base). */
export interface GaitStanceWindow {
  foot: string;
  fromMs: number;
  toMs: number;
  /** FORCE the forward-travel derivation onto this window's foot. The measured
   *  lower-foot heuristic is self-consistent through a steady cycle (its
   *  entry-reach cancellation is what keeps the pinned foot reachable), so
   *  travel normally ignores the schedule — but through an authored WEIGHT
   *  TRANSFER (a braking terminal step) the heuristic tracks the trailing
   *  push-off foot while the lead foot is still airborne and freezes the
   *  advance; a travel-locked window keeps it on the weight-bearing foot. The
   *  lateral shuttle uses every window regardless (it needs the full phase
   *  schedule). */
  travelLock?: boolean;
}

/** The stance side a planned window schedule dictates at tMs, or null when no
 *  (matching) window covers it — fall back to the measured feet. First match
 *  wins. `travelOnly` restricts to travel-locked windows. */
function scheduledStance(
  windows: GaitStanceWindow[] | undefined,
  tMs: number,
  travelOnly = false,
): 'R' | 'L' | null {
  if (!windows) return null;
  for (const w of windows) {
    if (travelOnly && w.travelLock !== true) continue;
    if (tMs >= w.fromMs && tMs <= w.toMs) return w.foot.startsWith('R') ? 'R' : 'L';
  }
  return null;
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
 *
 * `stanceWindows` (optional) supplies the builder's PLANNED stance schedule:
 * inside a window that foot is the planted one regardless of the measured
 * heights. The lower-foot heuristic reads the trailing push-off foot as
 * "planted" through a weight transfer (the lead foot is still airborne while
 * the trailing one is deepest), which follows the wrong foot through an
 * authored braking step; the schedule keeps the advance on the weight-bearing
 * foot. Outside every window — and without the option — the measured feet
 * decide (with hysteresis so near-tie spans can't flutter the choice).
 *
 * `headingDeg` (optional) rotates the travel direction about the vertical axis
 * (0 = straight ahead +Z; + toward subject-left, matching root yawDeg): the
 * planted foot's backward sweep is measured as its projection onto the heading
 * unit vector (sinH, cosH) — which needs the feet world X in {@link FeetZ} —
 * and the returned `heading` tells the applier which (x, z) ride the offset
 * takes. The caller authors the SAME heading as the body's root yaw, so the FK
 * sweep and the derived cancellation stay collinear. Heading 0 keeps the
 * legacy z-only measurement verbatim (byte-identical).
 * `headingDegAt` (optional, roadmap 6.2 — CURVED walking) generalises the
 * constant heading to a per-time heading CURVE (the caller's piecewise lookup
 * mirroring the authored yaw progression, see {@link headingProfileLookup}):
 * each per-step advance is measured against — and accumulated along — the
 * heading AT THAT SAMPLE, so the derived root path is an arc. The result then
 * carries the {@link FootDrivenTravel.at} (x, z) lookup, which appliers use
 * instead of `zAt`·`heading`. The residual the projection can't cancel (the
 * planted foot's PERPENDICULAR arc about the yawing root, rate ≈ foot-fore-aft
 * × turn-rate) integrates to ~0 over a symmetric stance window and is absorbed
 * per-frame by the foot-plant IK. When omitted, the constant-heading path runs
 * verbatim (byte-identical).
 * FLIGHT GAPS (a run): a sample whose {@link FeetZ.bothAirborne} is set has NO
 * planted foot — the derivation holds the last grounded advance through the
 * gap and treats the first grounded sample after it as a touchdown handoff
 * (no advance that frame, then track the landing foot). Samples that never
 * set the flag (every walking gait) take the exact pre-existing path.
 */
export function deriveFootDrivenTravel(
  sampleFeetAtPhase: (tMs: number) => FeetZ,
  totalMs: number,
  stanceWindows?: GaitStanceWindow[],
  steps = 120,
  headingDeg = 0,
  headingDegAt?: (tMs: number) => number,
): FootDrivenTravel {
  const n = Math.max(2, steps);
  const dt = totalMs / (n - 1);
  const z = new Array<number>(n).fill(0);
  // Heading unit vector (x, z): (0, 1) = straight ahead. Math.sin(0)/cos(0) are
  // exactly 0/1, so the heading-0 path stays byte-identical to the old +Z ride.
  const hx = Math.sin(headingDeg * RAD);
  const hz = Math.cos(headingDeg * RAD);
  // CURVED heading: accumulate the (x, z) PATH alongside the arc length, each
  // advance applied along the heading at its own sample time.
  const px = headingDegAt ? new Array<number>(n).fill(0) : null;
  const pz = headingDegAt ? new Array<number>(n).fill(0) : null;
  let prev = sampleFeetAtPhase(0);
  let planted: 'R' | 'L' = scheduledStance(stanceWindows, 0, true) ?? (prev.ry <= prev.ly ? 'R' : 'L');
  // Inside a FLIGHT gap (both feet airborne — a run's ballistic interval) the
  // advance is HELD; the first grounded sample after it is a touchdown handoff.
  let airborne = prev.bothAirborne === true;
  for (let i = 1; i < n; i += 1) {
    const cur = sampleFeetAtPhase(i * dt);
    // FLIGHT GAP: no foot is planted, so there is no grounded reference to
    // advance against — the swing legs sweeping in body space mid-air would
    // otherwise advance/retreat the root. Hold the last grounded advance.
    if (cur.bothAirborne === true) {
      z[i] = z[i - 1]!;
      if (px && pz) {
        px[i] = px[i - 1]!;
        pz[i] = pz[i - 1]!;
      }
      airborne = true;
      prev = cur;
      continue;
    }
    // Travel-locked schedule first; else HYSTERESIS on the measured decision:
    // hand off only when the other foot is clearly lower. In the cycle the
    // swing foot crosses decisively (tens of cm), but near-tie spans — a
    // standing entry, a feet-together termination, terminal double support —
    // used to flip-flop the choice per sample, and every flip is a "handoff:
    // no advance" frame that froze the derived travel mid-step.
    const scheduled = scheduledStance(stanceWindows, i * dt, true);
    if (airborne) {
      // TOUCHDOWN after a flight gap: the landing foot only just arrived, so
      // its prev→cur body-space delta spans the airborne sweep — a handoff
      // frame (no advance), then track the newly grounded foot.
      airborne = false;
      planted = scheduled ?? (cur.ry <= cur.ly ? 'R' : 'L');
      z[i] = z[i - 1]!;
      if (px && pz) {
        px[i] = px[i - 1]!;
        pz[i] = pz[i - 1]!;
      }
      prev = cur;
      continue;
    }
    let lower: 'R' | 'L' | null = scheduled;
    if (lower == null) {
      lower = planted;
      if (planted === 'R' && cur.ry > cur.ly + FOOT_HANDOFF_HYSTERESIS_M) lower = 'L';
      else if (planted === 'L' && cur.ly > cur.ry + FOOT_HANDOFF_HYSTERESIS_M) lower = 'R';
    }
    if (lower === planted) {
      // Advance the root by the planted foot's backward body-space step, so its
      // world position does not change. Under a PLANNED schedule a still-landing
      // stance foot can briefly move forward (the physical handoff hasn't
      // completed) — that is a handoff frame, not a retreat, so the advance is
      // floored at 0 (the walking root never backs up mid-window).
      // For a rotated heading the backward step is the sweep's projection onto
      // the heading unit vector; heading 0 keeps the legacy z-only expression.
      // A CURVED heading projects — and accumulates — along the heading at THIS
      // sample's time, so the path bends with the authored yaw progression.
      let back: number;
      if (headingDegAt) {
        const hd = headingDegAt(i * dt);
        const chx = Math.sin(hd * RAD);
        const chz = Math.cos(hd * RAD);
        back =
          planted === 'R'
            ? (prev.rz - cur.rz) * chz + ((prev.rx ?? 0) - (cur.rx ?? 0)) * chx
            : (prev.lz - cur.lz) * chz + ((prev.lx ?? 0) - (cur.lx ?? 0)) * chx;
        if (scheduled != null) back = Math.max(0, back);
        z[i] = z[i - 1]! + back;
        px![i] = px![i - 1]! + back * chx;
        pz![i] = pz![i - 1]! + back * chz;
        prev = cur;
        continue;
      }
      if (headingDeg === 0) {
        back = planted === 'R' ? prev.rz - cur.rz : prev.lz - cur.lz;
      } else {
        back =
          planted === 'R'
            ? (prev.rz - cur.rz) * hz + ((prev.rx ?? 0) - (cur.rx ?? 0)) * hx
            : (prev.lz - cur.lz) * hz + ((prev.lx ?? 0) - (cur.lx ?? 0)) * hx;
      }
      if (scheduled != null) back = Math.max(0, back);
      z[i] = z[i - 1]! + back;
    } else {
      // Handoff: the new foot just landed — no advance this frame, then track it.
      z[i] = z[i - 1]!;
      if (px && pz) {
        px[i] = px[i - 1]!;
        pz[i] = pz[i - 1]!;
      }
      planted = lower;
    }
    prev = cur;
  }
  const lerp = (arr: number[], tMs: number): number => {
    if (tMs <= 0) return arr[0]!;
    if (tMs >= totalMs) return arr[n - 1]!;
    const u = tMs / dt;
    const k = Math.min(n - 2, Math.floor(u));
    return arr[k]! + (arr[k + 1]! - arr[k]!) * (u - k);
  };
  return {
    totalMs,
    zAt(tMs: number): number {
      return lerp(z, tMs);
    },
    heading: [hx, hz],
    ...(px && pz
      ? {
          at(tMs: number): [number, number] {
            return [lerp(px, tMs), lerp(pz, tMs)];
          },
        }
      : {}),
  };
}

// ── Medio-lateral root shuttle (root motion FROM foot placement, X axis) ──────

/** A precomputed medio-lateral pelvis-shuttle offset curve over one motion,
 *  sampled at fixed steps and lerped in between — the lateral sibling of
 *  {@link FootDrivenTravel}. The scalar offset rides along the derivation's
 *  LATERAL unit vector (`lateral` — the heading's left-perpendicular); for the
 *  default heading 0 that is world +X (the original behaviour). */
export interface LateralShuttle {
  totalMs: number;
  /** Medio-lateral (stance-side+, subject-left+ at heading 0) root offset,
   *  meters, at tMs — applied along `lateral`. */
  xAt(tMs: number): number;
  /** Lateral unit vector [x, z] the offset rides: root += offset·(x, z).
   *  [1, 0] (world +X, subject-left) for the default heading 0 — applying it
   *  there is byte-identical to the old x-only ride. Ignored by appliers when
   *  the curved `at` lookup is present. */
  lateral: [number, number];
  /** CURVED heading (roadmap 6.2): the shuttle's world (x, z) offset at tMs —
   *  `xAt(tMs)` applied along the INSTANTANEOUS heading's left-perpendicular
   *  (the caller's per-time heading curve). Present ONLY when the derivation
   *  was given `headingDegAt`; appliers use it instead of `xAt`·`lateral`.
   *  Absent for a constant heading (byte-identical legacy path). */
  at?(tMs: number): [number, number];
}

/**
 * Derive the phase-locked MEDIO-LATERAL pelvis shuttle of a gait — the weight
 * transfer the walk was missing: each step, the pelvis rides toward (part-way
 * over) the STANCE foot, crossing the centre line at the double-support
 * transitions. Real free gait shuttles the pelvis a few cm toward the stance
 * side every step [Perry & Burnfield]; without it the body glides down the
 * midline like a rail-cart while the legs alternate underneath.
 *
 * Mirrors {@link deriveFootDrivenTravel}'s measure-then-derive pattern exactly:
 * `sampleFeetAtPhase(tMs)` poses the rig at tMs (FK + floor-pin, NO travel) and
 * returns the feet world X/Y. The derivation identifies the planted (lower)
 * foot per sample — with hysteresis so a standing entry/termination can't
 * flutter the handoff — then, over each stance window, shapes a smooth
 * half-sine excursion TOWARD that foot's measured side: zero at the window's
 * ends (the double-support / weight-transfer instants), peak `amplitudeM` at
 * mid-stance. Direction and reach come from the MEASURED feet (a wide or
 * narrow stance shuttles toward where the foot actually is), the amplitude is
 * capped well inside the half-stance-width so the COM stays within the base.
 *
 * `stanceWindows` (optional) supplies the PLANNED stance schedule (e.g. a gait
 * builder's authored windows, scaled to trajectory time): the shuttle is then
 * phase-locked to the same schedule any authored trunk counter-lean was
 * authored against, so root ride and absorb can never drift apart. Without it
 * the windows are the measured contiguous planted-foot runs. Returns a
 * piecewise-linear lookup applied along the heading's LATERAL unit only —
 * vertical grounding and forward travel keep their own channels.
 *
 * `headingDeg` (optional) keeps the shuttle PERPENDICULAR to a rotated travel
 * heading (same convention as {@link deriveFootDrivenTravel}): the feet's
 * lateral coordinate is their projection onto the heading's left-perpendicular
 * (cosH, −sinH) — which needs the feet world Z in {@link FeetLateral} — and
 * the returned `lateral` tells the applier which (x, z) ride the offset takes.
 * Heading 0 keeps the legacy world-X measurement verbatim (byte-identical).
 * `headingDegAt` (optional, roadmap 6.2 — CURVED walking): per-time heading
 * curve; the feet's lateral coordinate is measured against — and the shuttle
 * offset applied along — the INSTANTANEOUS heading's left-perpendicular via
 * the returned {@link LateralShuttle.at}. Omitted ⇒ the constant-heading path
 * runs verbatim (byte-identical).
 */
export function deriveGaitLateralShuttle(
  sampleFeetAtPhase: (tMs: number) => FeetLateral,
  totalMs: number,
  amplitudeM: number,
  stanceWindows?: GaitStanceWindow[],
  steps = 120,
  headingDeg = 0,
  headingDegAt?: (tMs: number) => number,
): LateralShuttle {
  const n = Math.max(2, steps);
  const dt = totalMs / (n - 1);
  const x = new Array<number>(n).fill(0);
  const amp = Math.max(0, amplitudeM);
  // Lateral unit vector (x, z) = the heading's left-perpendicular: (1, 0) for
  // heading 0 (world +X — the legacy axis; sin(0)/cos(0) are exact, so the
  // heading-0 path is byte-identical to the old x-only measurement).
  const hx = Math.sin(headingDeg * RAD);
  const hz = Math.cos(headingDeg * RAD);
  /** Lateral (left-perpendicular-to-heading) coordinate of a foot — against
   *  the heading at sample time tMs for a CURVED walk, else the constant. */
  const latOf = (fx: number, fz: number | undefined, tMs: number): number => {
    if (headingDegAt) {
      const hd = headingDegAt(tMs);
      return fx * Math.cos(hd * RAD) - (fz ?? 0) * Math.sin(hd * RAD);
    }
    return headingDeg === 0 ? fx : fx * hz - (fz ?? 0) * hx;
  };
  if (amp > 0) {
    const feet: FeetLateral[] = [];
    for (let i = 0; i < n; i += 1) feet.push(sampleFeetAtPhase(i * dt));
    // Planted (lower) foot per sample, with hysteresis at the handoff.
    const planted: ('R' | 'L')[] = [];
    let cur: 'R' | 'L' = feet[0]!.ry <= feet[0]!.ly ? 'R' : 'L';
    for (const f of feet) {
      if (cur === 'R' && f.ry > f.ly + FOOT_HANDOFF_HYSTERESIS_M) cur = 'L';
      else if (cur === 'L' && f.ly > f.ry + FOOT_HANDOFF_HYSTERESIS_M) cur = 'R';
      planted.push(cur);
    }
    // Body centre line = mean of the two feet across the cycle.
    let centerX = 0;
    for (let i = 0; i < n; i += 1) {
      const f = feet[i]!;
      centerX += (latOf(f.rx, f.rz, i * dt) + latOf(f.lx, f.lz, i * dt)) / 2;
    }
    centerX /= n;
    // Stance windows in sample indices: the planned schedule when supplied,
    // else the measured contiguous planted-foot runs.
    const runs: { i0: number; i1: number; foot?: 'R' | 'L' }[] = [];
    if (stanceWindows?.length) {
      for (const w of stanceWindows) {
        const i0 = Math.max(0, Math.min(n - 1, Math.round(w.fromMs / dt)));
        const i1 = Math.max(0, Math.min(n - 1, Math.round(w.toMs / dt)));
        if (i1 > i0) runs.push({ i0, i1, foot: w.foot.startsWith('R') ? 'R' : 'L' });
      }
    } else {
      let i = 0;
      while (i < n) {
        let j = i;
        while (j + 1 < n && planted[j + 1] === planted[i]) j += 1;
        if (j > i) runs.push({ i0: i, i1: j });
        i = j + 1;
      }
    }
    // Each stance window gets a half-sine toward its foot's measured side (the
    // scheduled foot when planned, else the majority-planted one).
    for (const { i0, i1, foot: schedFoot } of runs) {
      let rCount = 0;
      for (let k = i0; k <= i1; k += 1) if (planted[k] === 'R') rCount += 1;
      const foot: 'R' | 'L' = schedFoot ?? (rCount * 2 >= i1 - i0 + 1 ? 'R' : 'L');
      let stanceX = 0;
      for (let k = i0; k <= i1; k += 1)
        stanceX +=
          foot === 'R'
            ? latOf(feet[k]!.rx, feet[k]!.rz, k * dt)
            : latOf(feet[k]!.lx, feet[k]!.lz, k * dt);
      stanceX = stanceX / (i1 - i0 + 1) - centerX;
      // Toward the stance foot, capped inside the half-stance-width (60%) so a
      // narrow stance can never be over-shuttled past its own base edge.
      const reach = Math.sign(stanceX) * Math.min(amp, 0.6 * Math.abs(stanceX));
      for (let k = i0; k <= i1; k += 1) {
        x[k] = reach * Math.sin((Math.PI * (k - i0)) / (i1 - i0));
      }
    }
  }
  const xLookup = (tMs: number): number => {
    if (tMs <= 0) return x[0]!;
    if (tMs >= totalMs) return x[n - 1]!;
    const u = tMs / dt;
    const k = Math.min(n - 2, Math.floor(u));
    return x[k]! + (x[k + 1]! - x[k]!) * (u - k);
  };
  return {
    totalMs,
    xAt: xLookup,
    lateral: [hz, -hx],
    ...(headingDegAt
      ? {
          at(tMs: number): [number, number] {
            const off = xLookup(tMs);
            const hd = headingDegAt(tMs);
            // The instantaneous heading's left-perpendicular (cosH, −sinH).
            return [off * Math.cos(hd * RAD), -off * Math.sin(hd * RAD)];
          },
        }
      : {}),
  };
}

// ── Gravity-shaped grounded descents (weighted lowers — roadmap 3.3) ─────────
//
// The audit's "grounded weight" finding: a grounded descent (sit-down, floor
// get-down) EASES SYMMETRICALLY into its bottom — peak descent speed mid-span,
// braking into the stop — a hydraulic lower, not bodyweight caught. Gravity
// exists only when airborne (the ballistic flight parabola in motionTrajectory).
// This section is the opt-in, root-Y-only fix: within each monotone-DESCENDING
// span of the grounded (floor-pinned) root-Y arc, replace the vertical TIMING
// with a gravity-consistent profile — slow early, fast late, arrested at the
// bottom by the existing grounding (the floor/seat pin is the catch; the
// templates already author a small knee-yield there).
//
// PROFILE. Per span the target is  min(parabola, envelope), floored at the pin:
//   • `parabola` — the quarter-parabola of a body released from rest over the
//     span's drop/duration, capped at a physiologic terminal speed (a real
//     lower plateaus near ~1 m/s; it never free-falls): the gravity IDEAL.
//   • `envelope` — the least concave majorant (upper concave hull) of the
//     measured pin arc: the closest curve to the AUTHORED descent whose speed
//     never decreases. It rides the pin wherever the pin already accelerates
//     and bridges every mid-span brake — above all, the terminal ease-out —
//     with a constant-speed chord, so the descent arrives at the bottom AT
//     speed instead of braking before it.
// Both curves are concave (descending, non-decreasing speed) and share the
// span's endpoints, so their pointwise min is too — descent speed is monotone
// non-decreasing until the catch — and the reshape is exactly the pin at the
// span boundaries (C0 with the untouched frames around it).
//
// KINEMATIC CHARTER + LOCKSTEP. Root-Y ONLY: joint angles, knot times, and the
// horizontal root path are untouched, so goniometry and every settle
// measurement are byte-identical. Derived in a deterministic PRE-PASS over the
// built trajectory (the vertical-calibration pattern: sampler + stage run the
// SAME derivation on the same grounded arc and apply it per frame in lockstep)
// and applied through per-frame clamps against the live pin (hover/dip bounds
// below), so the feet never visibly leave — or clip — the floor.

/** Minimum net drop (m) a monotone-descending root-Y span needs to qualify as
 *  a weighted lower. Sub-10 cm bobs (breath-scale, small transfers) keep their
 *  authored timing. */
export const WEIGHTED_DESCENT_MIN_DROP_M = 0.1;
/** Minimum span duration (ms): a shorter "descent" is a grounding-switch
 *  artifact or a single-sample step, not a lower to reshape. */
export const WEIGHTED_DESCENT_MIN_SPAN_MS = 250;
/** Physiologic terminal descent speed (m/s) the quarter-parabola is capped at:
 *  a controlled bodyweight lower accelerates, then plateaus — it never
 *  free-falls (sit-down pelvis peaks ~0.5-0.9 m/s in life; 1.2 leaves room for
 *  a genuine drop while staying far under free-fall). */
export const WEIGHTED_DESCENT_TERMINAL_SPEED_MS = 1.2;
/** Per-sample slope (m/s) above which the sampled arc is a grounding-switch
 *  DISCONTINUITY (e.g. the quadruped feet→knee pin swap re-roots the body tens
 *  of cm in one step) — a span never extends across one. */
const WEIGHTED_DESCENT_DISCONTINUITY_MS = 2.0;
/** Apply-time bound (m) the reshaped root-Y may HOVER above the live pin. The
 *  reshape holds the body high while the joints keep folding, which lifts the
 *  pinned feet off the floor by the same amount — bounded to shoe-sole height
 *  (same order as the gait smoothing's GAIT_VERTICAL_MAX_RISE_M). */
export const WEIGHTED_DESCENT_MAX_HOVER_M = 0.03;
/** Apply-time bound (m) the reshaped root-Y may DIP below the live pin (the
 *  final catch may run slightly ahead of a terminal grounding switch — e.g.
 *  the sit-down's feet→seat pin step — matching the ~2 cm settle tolerance the
 *  seated grounding already carries). */
export const WEIGHTED_DESCENT_MAX_DIP_M = 0.02;
/** Leading/trailing flat trim (m): a span starts/ends where the arc has
 *  actually moved this far, so holds on either side stay untouched. */
const WEIGHTED_DESCENT_TRIM_M = 1e-3;

/** One reshaped descent span: a uniform-in-time target root-Y table. */
export interface WeightedDescentSpan {
  fromMs: number;
  toMs: number;
  /** Target root-Y per uniform sample over [fromMs, toMs] (≥2 entries). */
  y: number[];
}

/** A derived gravity-descent reshape: identity outside its spans. */
export interface WeightedDescentReshape {
  totalMs: number;
  spans: WeightedDescentSpan[];
}

/** Least concave majorant of uniformly-spaced samples: the UPPER convex hull
 *  of (i, y[i]), evaluated back at every i. Rides the curve wherever it is
 *  already concave (accelerating descent) and bridges every local brake with a
 *  straight (constant-speed) chord. */
function upperConcaveEnvelope(ys: number[]): number[] {
  const n = ys.length;
  if (n <= 2) return [...ys];
  const hull: number[] = [];
  for (let i = 0; i < n; i += 1) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2]!;
      const b = hull[hull.length - 1]!;
      // Pop b while a→b→i is a left turn or straight (b on/under the chord a→i).
      const cross = (b - a) * (ys[i]! - ys[a]!) - (ys[b]! - ys[a]!) * (i - a);
      if (cross >= 0) hull.pop();
      else break;
    }
    hull.push(i);
  }
  const out = new Array<number>(n);
  for (let h = 0; h + 1 < hull.length; h += 1) {
    const a = hull[h]!;
    const b = hull[h + 1]!;
    for (let i = a; i <= b; i += 1) {
      out[i] = ys[a]! + ((ys[b]! - ys[a]!) * (i - a)) / Math.max(1, b - a);
    }
  }
  return out;
}

/** Cumulative drop (m) at time τ (s) into a quarter-parabola release over
 *  span duration T (s) and total drop D (m), capped at terminal speed vT:
 *  pure ½at² when its end speed 2D/T stays under vT; else a constant-
 *  acceleration ramp to vT followed by terminal-speed descent (both cover D
 *  exactly). When even the AVERAGE speed exceeds vT the authored timing wins
 *  (pure parabola — the cap cannot be honoured without moving knot times). */
function gravityDropAt(tau: number, T: number, D: number, vT: number): number {
  const u = Math.min(1, Math.max(0, tau / T));
  if (2 * D <= vT * T || D >= vT * T) return D * u * u;
  const t1 = (2 * (vT * T - D)) / vT; // ramp duration; 0 < t1 < T here
  const a = vT / t1;
  return tau <= t1 ? 0.5 * a * tau * tau : 0.5 * vT * t1 + vT * (tau - t1);
}

/**
 * Derive the gravity-descent reshape from the emergent grounded root-Y arc.
 * `groundedRootYAt(tMs)` must return the FULLY-GROUNDED model-root Y at
 * absolute time tMs — the caller poses the rig and applies the same grounding
 * (posture pin / foot-root / floor-pin) its playback uses, exactly like the
 * vertical-calibration and foot-driven-travel pre-passes. Samples `steps`
 * uniform points, finds each monotone-descending span (net drop ≥
 * {@link WEIGHTED_DESCENT_MIN_DROP_M}, duration ≥
 * {@link WEIGHTED_DESCENT_MIN_SPAN_MS}, never across a grounding-switch
 * discontinuity), and builds the min(parabola, envelope) target table per span
 * (floored at the sampled pin, so the reshape only ever RE-TIMES the descent
 * upward/later — it never digs below the grounded arc at derive time).
 * Returns null when nothing qualifies (the identity — unflagged-equivalent).
 * Deterministic: same arc → same reshape.
 */
export function deriveWeightedDescent(
  groundedRootYAt: (tMs: number) => number,
  totalMs: number,
  steps = 128,
): WeightedDescentReshape | null {
  if (!(totalMs > 0)) return null;
  const n = Math.max(8, Math.floor(steps)) + 1;
  const dt = totalMs / (n - 1);
  const ys = new Array<number>(n);
  for (let i = 0; i < n; i += 1) ys[i] = groundedRootYAt(i * dt);

  const spans: WeightedDescentSpan[] = [];
  const maxStepDrop = (WEIGHTED_DESCENT_DISCONTINUITY_MS * dt) / 1000;
  let i = 0;
  while (i < n - 1) {
    // Maximal non-rising run from i, stopping at any grounding-switch step.
    let j = i;
    while (
      j < n - 1 &&
      ys[j + 1]! <= ys[j]! + 1e-4 &&
      ys[j]! - ys[j + 1]! <= maxStepDrop
    ) {
      j += 1;
    }
    if (j === i) {
      i += 1;
      continue;
    }
    // Trim leading/trailing flats so holds around the drop stay untouched.
    let s = i;
    while (s < j && ys[i]! - ys[s + 1]! < WEIGHTED_DESCENT_TRIM_M) s += 1;
    let e = j;
    while (e > s && ys[e - 1]! - ys[j]! < WEIGHTED_DESCENT_TRIM_M) e -= 1;
    const D = ys[s]! - ys[e]!;
    const spanMs = (e - s) * dt;
    if (D >= WEIGHTED_DESCENT_MIN_DROP_M && spanMs >= WEIGHTED_DESCENT_MIN_SPAN_MS) {
      const pin = ys.slice(s, e + 1);
      const env = upperConcaveEnvelope(pin);
      const T = spanMs / 1000;
      const y = pin.map((pinY, k) => {
        const par = pin[0]! - gravityDropAt((k * dt) / 1000, T, D, WEIGHTED_DESCENT_TERMINAL_SPEED_MS);
        return Math.max(Math.min(par, env[k]!), pinY);
      });
      spans.push({ fromMs: s * dt, toMs: e * dt, y });
    }
    i = j + 1;
  }
  return spans.length ? { totalMs, spans } : null;
}

/**
 * Apply a derived gravity-descent reshape to the grounded root-Y at time tMs:
 * inside a span, the lerped target table clamped to the live pin's
 * hover/dip band ({@link WEIGHTED_DESCENT_MAX_HOVER_M} /
 * {@link WEIGHTED_DESCENT_MAX_DIP_M}); outside every span — and for a null
 * reshape — exactly `y` (identity, so unflagged playback is byte-identical).
 */
export function applyWeightedDescent(
  y: number,
  reshape: WeightedDescentReshape | null | undefined,
  tMs: number,
): number {
  if (!reshape) return y;
  for (const span of reshape.spans) {
    if (tMs < span.fromMs || tMs > span.toMs) continue;
    const m = span.y.length - 1;
    if (m < 1) return y;
    const x = ((tMs - span.fromMs) / (span.toMs - span.fromMs)) * m;
    const k = Math.min(m - 1, Math.floor(x));
    const f = x - k;
    const target = span.y[k]! * (1 - f) + span.y[k + 1]! * f;
    return Math.min(Math.max(target, y - WEIGHTED_DESCENT_MAX_DIP_M), y + WEIGHTED_DESCENT_MAX_HOVER_M);
  }
  return y;
}

/** The RESOLVED-motion fields the weighted-descent gate reads (structural — a
 *  subset of motionSequence's ResolvedComposedMotion, kept structural so this
 *  root-space module never imports the sequence layer). */
export interface WeightedDescentMotionLike {
  status: string;
  weightedDescent?: boolean;
  loop?: boolean;
  footDrivenTravel?: boolean;
  verticalCalibrationCm?: number;
  contacts?: unknown[];
  keyframes: { stance?: string }[];
}

/**
 * Whether the gravity-descent reshape applies to a resolved motion: it must
 * OPT IN (`weightedDescent`) and be a grounded one-shot the quasi-static
 * descent model is valid for. HARD EXCLUSIONS even when flagged — airborne
 * motions (any floating keyframe: the ballistic flight parabola owns their
 * vertical), gait/travel and loops (the calibrated + smoothed cyclic vertical
 * is deliberate), calibrated verticals (`verticalCalibrationCm` owns root-Y),
 * declared IK contacts (the plant solver owns the legs), and motions with
 * nothing planted (no grounded arc to reshape). Exported so tests (and hosts)
 * can assert the exclusions without running the derivation.
 */
export function weightedDescentApplies(resolved: WeightedDescentMotionLike): boolean {
  if (resolved.status !== 'ok' || resolved.weightedDescent !== true) return false;
  if (resolved.keyframes.length === 0) return false;
  if (resolved.loop === true || resolved.footDrivenTravel === true) return false;
  if (resolved.verticalCalibrationCm != null) return false;
  if (resolved.contacts?.length) return false;
  if (resolved.keyframes.some((kf) => kf.stance === 'floating')) return false;
  return resolved.keyframes.some((kf) => kf.stance === 'planted');
}

// ── Heel-strike transient (footfall accent — roadmap 4.6) ────────────────────
//
// The audit's "no impact transient" finding: the calibrated + smoothed gait
// vertical glides through each footfall — the double-support valley is
// deliberately rounded (do NOT reduce that smoothing) — so contact carries no
// weight. This section is the additive accent ON TOP of the smoothed arc: at
// each foot-CONTACT instant (the starts of the same planned stance schedule
// the shuttle/travel derivations follow — a window opens when its foot lands),
// a brief downward DIP-AND-RECOVER on root Y, shaped by a critically-damped
// (non-oscillating) bump kernel with compact support: zero at contact, fast
// drop to the full dip ~40% into the span, damped recovery to exactly zero by
// the span's end — an impact caught by the loading-response knee, never a
// bounce. Amplitude scales with the PRE-CONTACT DESCENT RATE of the smoothed
// arc (faster arrival = firmer accent), clamped to a subtle 0.5–1 cm band.
//
// KINEMATIC CHARTER + LOCKSTEP. Root-Y ONLY, derived in a deterministic
// pre-pass over the built trajectory (the vertical-calibration pattern: the
// sampler and the live stage run the SAME derivation on the same smoothed arc
// and apply the same offset per frame). Gait-only: the sampler/stage derive it
// only for a foot-driven motion with a planned stance schedule; every other
// motion is byte-identical. The foot-plant IK after it absorbs the dip in the
// stance knee (the plant target compensates the offset at capture, so the
// stance foot still pins ON the floor — see the sampler/stage apply sites).

/** Kernel span (ms): the dip fully rises and recovers within this window after
 *  the contact instant — a brief transient, not a bounce (~80–120 ms in life). */
export const HEEL_STRIKE_SPAN_MS = 110;
/** Softest accent dip (m) — a footfall always lands with SOME weight. */
export const HEEL_STRIKE_MIN_DIP_M = 0.005;
/** Firmest accent dip (m) — subtle; the smoothed arc stays the star. */
export const HEEL_STRIKE_MAX_DIP_M = 0.01;
/** Pre-contact descent rate (m/s) of the smoothed arc at which the accent
 *  saturates at {@link HEEL_STRIKE_MAX_DIP_M}. The walk's smoothed vertical
 *  descends O(0.1 m/s) into double support; a faster (paced) arrival firms the
 *  accent toward the cap. */
export const HEEL_STRIKE_REF_DESCENT_M_S = 0.25;
/** Window (ms) BEFORE the contact instant over which the smoothed arc's
 *  descent rate is read (finite difference). */
const HEEL_STRIKE_RATE_WINDOW_MS = 80;
/** Peak position + normalization of the compact critically-damped bump
 *  u²(1−u)³ over u∈[0,1]: peak 1 at u = 2/5 (44 ms into the 110 ms span). */
const HEEL_STRIKE_KERNEL_NORM = 3125 / 108;

/** One derived footfall accent: a dip of `dipM` metres starting at `atMs`. */
export interface HeelStrikeAccent {
  atMs: number;
  dipM: number;
}

/** The derived accent schedule for one motion: identity outside every span. */
export interface HeelStrikeAccents {
  totalMs: number;
  accents: HeelStrikeAccent[];
}

/**
 * Derive the footfall accent schedule from the SMOOTHED grounded arc.
 * `smoothedRootYAt(tMs)` must return the pipeline's post-calibration root-Y at
 * absolute time tMs (the caller poses the rig, floor-pins and applies its
 * vertical calibration — exactly what its playback shows before the accent).
 * `contactInstantsMs` are the foot-contact instants — the STARTS of the same
 * planned stance schedule (gaitStanceWindowsMs, trajectory time base) the
 * shuttle/travel derivations follow. A start at t≈0 is the standing entry (no
 * arrival to accent) and is skipped; each remaining contact gets a dip
 * amplitude lerped {@link HEEL_STRIKE_MIN_DIP_M}→{@link HEEL_STRIKE_MAX_DIP_M}
 * by its pre-contact descent rate. Returns null when no contact qualifies
 * (the identity). Deterministic: same arc + instants → same accents.
 */
export function deriveHeelStrikeAccents(
  smoothedRootYAt: (tMs: number) => number,
  contactInstantsMs: number[],
  totalMs: number,
): HeelStrikeAccents | null {
  if (!(totalMs > 0)) return null;
  const accents: HeelStrikeAccent[] = [];
  for (const c of contactInstantsMs) {
    if (!Number.isFinite(c) || c < 1 || c >= totalMs) continue; // t≈0 = standing entry
    const w = Math.min(HEEL_STRIKE_RATE_WINDOW_MS, c);
    if (w <= 0) continue;
    // Descent rate of the smoothed arc INTO this contact (+ = descending, m/s).
    const rate = Math.max(0, (smoothedRootYAt(c - w) - smoothedRootYAt(c)) / (w / 1000));
    const firmness = Math.min(1, rate / HEEL_STRIKE_REF_DESCENT_M_S);
    accents.push({
      atMs: c,
      dipM: HEEL_STRIKE_MIN_DIP_M + (HEEL_STRIKE_MAX_DIP_M - HEEL_STRIKE_MIN_DIP_M) * firmness,
    });
  }
  return accents.length ? { totalMs, accents } : null;
}

/**
 * The accent's root-Y OFFSET (≤ 0, metres) at time tMs — the critically-damped
 * bump evaluated over every accent span covering tMs (spans of a symmetric
 * gait never overlap; summing keeps the lookup total-order-free anyway).
 * Exactly 0 outside every span and for a null schedule, so unaccented playback
 * is byte-identical. The caller adds this to the calibrated root-Y — and
 * subtracts it from a foot-plant target captured while it is non-zero, so the
 * landing foot pins at its natural floor contact and the dip is absorbed by
 * the leg IK (the loading-response knee) instead of burying the foot.
 */
export function heelStrikeOffsetAt(
  accents: HeelStrikeAccents | null | undefined,
  tMs: number,
): number {
  if (!accents) return 0;
  let off = 0;
  for (const a of accents.accents) {
    const u = (tMs - a.atMs) / HEEL_STRIKE_SPAN_MS;
    if (u <= 0 || u >= 1) continue;
    off -= a.dipM * HEEL_STRIKE_KERNEL_NORM * u * u * (1 - u) ** 3;
  }
  return off;
}

/** Apply the footfall accent to the calibrated root-Y at tMs — identity for a
 *  null schedule and outside every span (mirrors applyVerticalCalibration's
 *  role in the vertical pipeline: pin → vcal → accent → travel/shuttle). */
export function applyHeelStrikeAccent(
  y: number,
  accents: HeelStrikeAccents | null | undefined,
  tMs: number,
): number {
  return y + heelStrikeOffsetAt(accents, tMs);
}
