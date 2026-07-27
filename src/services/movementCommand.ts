/**
 * Imperative exam movement commands (simLAB A0 — "dorsiflex the right ankle
 * to 10 degrees").
 *
 * A host (the simLAB encounter cockpit) translates the AI patient's intent
 * into a structural {@link ExamMovementCommand}, the engine resolves it
 * against the SAME truth every other pose surface uses — the normative ROM
 * registry (`romRegistry.ts`) intersected with the active scenario
 * constraints (`romConstraints.ts`) — and answers with what the simulated
 * PATIENT actually did ({@link ExamMovementOutcome}): complied, complied
 * partially (modified), or refused, plus whether the achieved angle sits in
 * the authored painful arc.
 *
 * Pure math on plain data (poses + registry lookups) — no scene, no DOM —
 * so every rule here is unit-testable in Node. The Svelte stage
 * (`ExamStage3D.svelte`) is a thin animator over these functions.
 *
 * COMMAND VOCABULARY — `joint` is a ROM-registry canonical key and `motion`
 * is that joint's registry field key, in the registry's clinical sign
 * convention (positive/negative per `positiveAs`/`negativeAs`):
 *
 *   joint        motion            convention                    v1 support
 *   ─────────────────────────────────────────────────────────────────────────
 *   L/R_Foot     ankleFlexion      + dorsiflexion / − plantar    SUPPORTED
 *   L/R_Leg      kneeFlexion       + flexion / − hyperextension  SUPPORTED
 *   Spine_Lower  flexion           + forward flex / − extension  SUPPORTED (v1.1)
 *   (any other registry joint/field)                             refused, reason 'unsupported-motion'
 *
 * v1 deliberately ships the two sagittal motions the ankle pilot needs
 * (ankle + knee, the must-haves). Shoulder flexion was attempted and
 * withdrawn — see the SUPPORTED_MOTIONS doc for why the real rig can't yet
 * honor it honestly. v1.1 adds LUMBAR FLEXION (simLAB lumbar cases:
 * "bend forward"), rig-verified: the waist bone's parent-local frame is
 * body-aligned on the CC rig, so a parent-frame X-euler delta of +20° reads
 * back as clinical flexion +20.000° with ZERO lateral/rotation smear while
 * the head provably translates anterior (+Z, the rig's facing) and caudal —
 * the commanded visual and the measured readout agree exactly (see the
 * 'trunk:' cases in movementCommand.test.ts). Every OTHER registry-valid joint/motion resolves to a
 * refused outcome with `reason: 'unsupported-motion'` so hosts degrade
 * gracefully; unknown keys refuse with 'unknown-joint' / 'unknown-motion'.
 *
 * REFUSAL RULE (crisp, documented): a set-joint command is REFUSED when the
 * effective range (normative ∩ scenario `availableRange`) leaves less than
 * 20% of the requested travel achievable, measuring travel from neutral (0°,
 * the registry's clinical zero) along the requested direction:
 *
 *   t = targetDegrees, c = clamp(t, effectiveRange)
 *   achievableToward = t > 0 ? max(0, c) : max(0, −c)
 *   refused ⇔ |t| ≥ 0.5° AND achievableToward < 0.2·|t|
 *
 * So "dorsiflex to 10°" against an available range capped at +2° complies
 * to the cap (2/10 = 20% — exactly at the threshold still moves), while the
 * same command against a range capped at 0° or below refuses outright — the
 * patient can't produce any meaningful dorsiflexion. A target of ~0°
 * ("return to neutral") is never refused: the patient settles at the nearest
 * available angle (complied when neutral is reachable, modified otherwise).
 * Travel is measured from neutral, not from the current pose, so the rule
 * stays pure — a patient parked at −12° plantar who is asked for 10° dorsi
 * against a 0°-capped range still refuses, which reads clinically as
 * "I can't lift it past where it hangs".
 */
import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import { POSE_SCHEMA_VERSION, type CustomPose } from '../types';
import type { JointAngleReport, JointAngleRestReference } from './jointAngles';
import { getRomFieldDefinition, getRomJointDefinition } from './romRegistry';
import {
  getRomFieldConstraint,
  isInRomPainfulArc,
  resolveAvailableRange,
  type RomScenarioConstraints,
} from './romConstraints';

// ── Structural command / outcome types ─────────────────────────────────────
// Structural on purpose: hosts (simLAB mission-shell) mirror these shapes
// without importing this package into their transport layer.

export type ExamMovementCommand =
  | { action: 'set-joint'; joint: string; motion: string; targetDegrees: number }
  | { action: 'relax' };

export type ExamMovementLimiter = 'normative-rom' | 'scenario-constraint';

/** Machine-readable refusal detail (additive to the A0 outcome contract). */
export type ExamMovementRefusalReason =
  | 'unknown-joint'
  | 'unknown-motion'
  | 'unsupported-motion'
  | 'invalid-target'
  | 'no-achievable-travel'
  | 'stage-unavailable';

export interface ExamMovementOutcome {
  status: 'complied' | 'modified' | 'refused';
  joint?: string;
  motion?: string;
  requestedDegrees?: number;
  /** What the patient actually did, in the registry's clinical convention.
   *  From the live stage this is MEASURED (recomputed off the settled
   *  skeleton via computeJointAngles), not the planned clamp target. */
  achievedDegrees?: number;
  /** Which layer stopped short of the request (only when modified/refused). */
  limitedBy?: ExamMovementLimiter;
  /** True when the achieved angle lies inside the scenario's authored
   *  painful arc for this joint field. */
  painful?: boolean;
  /** Why a refused command was refused (see {@link ExamMovementRefusalReason}). */
  reason?: ExamMovementRefusalReason;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** Comply tolerance: requests within 0.5° of the clamp result count as
 *  fully complied (matches the registry's own neutral threshold). */
export const EXAM_COMMAND_COMPLY_EPS_DEG = 0.5;

/** Refusal threshold: achievable travel (from neutral, toward the target)
 *  below this fraction of the requested travel refuses the command. */
export const EXAM_COMMAND_REFUSAL_TRAVEL_RATIO = 0.2;

export interface ResolvedCommandTarget {
  status: 'complied' | 'modified' | 'refused';
  joint?: string;
  motion?: string;
  requestedDegrees?: number;
  /** ROM-clamped planned target (deg, registry clinical convention).
   *  Undefined when refused or when the command is a relax. */
  clampedDegrees?: number;
  limitedBy?: ExamMovementLimiter;
  /** True when the PLANNED clamped target sits inside the authored painful
   *  arc. The stage re-evaluates against the measured angle after settle. */
  painful?: boolean;
  reason?: ExamMovementRefusalReason;
}

/**
 * Validate a command against the ROM registry and clamp its target through
 * the effective range (normative ∩ scenario constraint). Pure: the per-scenario
 * constraints are passed explicitly in `opts.constraints` (no module-global
 * store — that broke concurrent/preflight resolves); omit them for normative
 * ROM only. Writes nothing.
 *
 * `variantCfg` is accepted for forward-compat (per-variant vocabularies);
 * v1 validates against the variant-independent registry.
 */
export function resolveCommandTarget(
  cmd: ExamMovementCommand,
  _variantCfg?: BodyVariantConfig,
  opts?: { weightBearing?: boolean; constraints?: RomScenarioConstraints | null },
): ResolvedCommandTarget {
  if (cmd.action === 'relax') {
    return { status: 'complied' };
  }

  const { joint, motion } = cmd;
  const jointDef = getRomJointDefinition(joint);
  if (!jointDef) {
    return { status: 'refused', joint, motion, reason: 'unknown-joint' };
  }
  const fieldDef = getRomFieldDefinition(joint, motion);
  if (!fieldDef) {
    return { status: 'refused', joint, motion, reason: 'unknown-motion' };
  }
  if (!isMovementCommandSupported(joint, motion)) {
    return { status: 'refused', joint, motion, reason: 'unsupported-motion' };
  }
  const requested = cmd.targetDegrees;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return { status: 'refused', joint, motion, reason: 'invalid-target' };
  }

  const constraint = getRomFieldConstraint(opts?.constraints, joint, motion);
  // Closed-chain (weight-bearing, planted) targets clamp to the field's larger
  // weightBearingMax on the positive side (ankle DF: ~35° WB vs ~20° open-chain).
  // A scenario constraint still tightens it below, so a reduced-DF fault holds.
  const baseRange =
    opts?.weightBearing &&
    fieldDef.weightBearingMax != null &&
    fieldDef.weightBearingMax > fieldDef.range.max
      ? { ...fieldDef.range, max: fieldDef.weightBearingMax }
      : fieldDef.range;
  const effective = resolveAvailableRange(baseRange, constraint);
  const clamped = Math.max(effective.min, Math.min(effective.max, requested));

  // Which layer owns the binding bound (for `limitedBy`)? Scenario when the
  // effective bound is tighter than the normative bound on that side.
  let limitedBy: ExamMovementLimiter | undefined;
  if (requested > effective.max + 1e-9) {
    limitedBy = effective.max < baseRange.max - 1e-9 ? 'scenario-constraint' : 'normative-rom';
  } else if (requested < effective.min - 1e-9) {
    limitedBy = effective.min > fieldDef.range.min + 1e-9 ? 'scenario-constraint' : 'normative-rom';
  }

  const base = {
    joint,
    motion,
    requestedDegrees: requested,
    painful: isInRomPainfulArc(clamped, constraint),
  };

  if (Math.abs(clamped - requested) <= EXAM_COMMAND_COMPLY_EPS_DEG) {
    return { status: 'complied', ...base, clampedDegrees: clamped };
  }

  // The refusal rule (documented in the module header): meaningful-motion
  // check, skipped for near-neutral targets ("return to neutral" always
  // settles at the nearest available angle instead of refusing).
  if (Math.abs(requested) >= EXAM_COMMAND_COMPLY_EPS_DEG) {
    const achievableToward = requested > 0 ? Math.max(0, clamped) : Math.max(0, -clamped);
    if (achievableToward < EXAM_COMMAND_REFUSAL_TRAVEL_RATIO * Math.abs(requested)) {
      return { status: 'refused', ...base, limitedBy, reason: 'no-achievable-travel' };
    }
  }

  return { status: 'modified', ...base, clampedDegrees: clamped, limitedBy };
}

// ── Target-pose construction ────────────────────────────────────────────────

const RAD = Math.PI / 180;
/** Canonical long axis at rest (child points down) — matches
 *  `REST_DOWN_LOCAL` in jointAngles.ts. */
const REST_DOWN = new THREE.Vector3(0, -1, 0);
/** Local-Z axis — the pinned finger-curl ring (see `computeDrivingRingMap`);
 *  a rest-frame rotation about it curls the MCP toward the palm. */
const LOCAL_Z = new THREE.Vector3(0, 0, 1);
/** The thumb metacarpal's ADduction axis — rig-probed: rotating R_Thumb1 about
 *  local X swings the thumb toward the index, local Y does nothing (it is the
 *  twist), and local Z is the curl `fingerFlexion` already uses. Both hands take
 *  the SAME sign; the rig mirrors so that −X adducts on the left too. */
const LOCAL_X = new THREE.Vector3(1, 0, 0);

/** Parent-local delta for a body-euler sagittal motion: pure X rotation in
 *  the YXZ order the readout decomposes with. For the foot, readout
 *  ankleFlexion = +euler.x·DEG exactly, so this construction reproduces the
 *  requested angle by algebra (the authored ankle-sprain pose's "R_Foot −X
 *  plantar-flexion axis" convention, expressed in the parent frame — dorsi
 *  positive = +X, plantar negative = −X). */
function eulerXDelta(deg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(deg * RAD, 0, 0, 'YXZ'));
}

/** Parent-local Y-euler delta (transverse/axial) — for body-aligned bones whose
 *  parent-local frame reads a clean yaw (lumbar + cervical rotation; rig-verified
 *  exact readback, zero off-plane smear). */
function eulerYDelta(deg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, deg * RAD, 0, 'YXZ'));
}

/** Parent-local Z-euler delta (frontal/lateral) — for body-aligned bones whose
 *  parent-local frame reads a clean tilt (lumbar + cervical lateralTilt, shoulder
 *  abduction; rig-verified). Note the readout's lateral sign convention: spine +
 *  neck lateralTilt carry latSign=−1, so those callers pass −deg. */
function eulerZDelta(deg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, deg * RAD, 'YXZ'));
}

/** CANONICAL-frame delta for a ball/hinge sagittal swing — the same frame
 *  the ROM clamp recomposes in (`poseRomClamp.recomposeBallJoint`): swing the
 *  rest long axis (0,−1,0) by `deg` about the medio-lateral axis, no twist.
 *  A +deg swing re-aims the distal segment ANTERIORLY — the way the body
 *  physically faces (world +Z on this rig; measured — hip flexion carries the
 *  foot to +Z), i.e. a front-kick for the leg. Callers pick the anatomic
 *  direction by SIGN: hip flexion passes +deg (thigh swings forward/anterior);
 *  the knee passes −deg so its shin re-aims POSTERIORLY (anatomic flexion, heel
 *  toward the buttock) rather than kicking forward, and the geometric hinge
 *  readout then signs that flexion POSITIVE. (NB: the goniometric ANGLE readout
 *  in jointAngles.ts labels anterior as −Z — a measurement-frame naming choice,
 *  NOT the mesh's physical facing; the two frames are independent.) The
 *  canonical delta relates rest→current WORLD orientation
 *  (`currentWorld = restWorld · delta`), so the world direction of the swing is
 *  DETERMINISTIC for a given sign regardless of how the GLB binds the
 *  bone-local frame — the thigh/clavicle local frames on the CC rig are
 *  twisted, which is why a parent-local construction moves the limb in an
 *  unreliable world direction even while the parent-local readout looks right. */
function ballFlexDelta(deg: number): THREE.Quaternion {
  const f = deg * RAD;
  const swung = new THREE.Vector3(0, -Math.cos(f), -Math.sin(f));
  return new THREE.Quaternion().setFromUnitVectors(REST_DOWN, swung);
}

/** CANONICAL-frame FRONTAL swing for a ball joint (hip abduction/adduction):
 *  re-aim the rest long axis (0,−1,0) toward ±X (lateral) by `deg` about the
 *  A-P axis, no twist. Same rest-frame construction family as ballFlexDelta but
 *  in the coronal plane. Rig-verified: readback hipAbduction == commanded within
 *  ±1° (L +deg away from midline; the right passes −deg to move away on its
 *  side). The swing-twist decomposition couples a few degrees of apparent
 *  rotation off-neutral, but the WORLD motion is a clean lateral swing (knee
 *  travels in X, zero anterior/posterior). */
function ballAbductDelta(deg: number): THREE.Quaternion {
  const f = deg * RAD;
  const swung = new THREE.Vector3(Math.sin(f), -Math.cos(f), 0);
  return new THREE.Quaternion().setFromUnitVectors(REST_DOWN, swung);
}

/** CANONICAL-frame TWIST about a ball joint's rest long axis (hip int/ext
 *  rotation): pure rotation about (0,−1,0). Rig-verified: readback hipRotation
 *  == commanded within ±1° (the readout twist sign is opposite the geometric
 *  twist on the left and same on the right, so the specs pass ∓deg). Small
 *  abduction coupling off-neutral; the twist itself is exact. */
function ballTwistDelta(deg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(REST_DOWN, deg * RAD);
}

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);
/** WORLD-plane elevation swing for the shoulder (option a): re-aim the arm's rest
 *  world direction about a world axis by `deg`, as a MINIMAL-ARC swing (zero axial
 *  twist), then conjugate into the rest-arm-local frame so `compose:'rest'` yields
 *  currentWorld = worldSwing × restWorld. Rig-verified: flexion/abduction read back
 *  exact with zero rotation leak. Without ctx (no rest reference) returns identity. */
function armSwingDelta(ctx: BuildCtx | undefined, worldAxis: THREE.Vector3, deg: number): THREE.Quaternion {
  if (!ctx?.restWorldQuat || !ctx.restDir) return new THREE.Quaternion();
  const target = ctx.restDir
    .clone()
    .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(worldAxis, deg * RAD));
  const worldSwing = new THREE.Quaternion().setFromUnitVectors(ctx.restDir, target);
  return unparentGirdle(
    ctx,
    ctx.restWorldQuat.clone().invert().multiply(worldSwing).multiply(ctx.restWorldQuat),
  );
}

/**
 * Correct a humeral delta for the girdle rotation applied ALONGSIDE it, so the
 * humerus lands on the SAME world orientation it would have reached without the
 * split — which is what keeps the humerothoracic readout exact and, because the
 * clavicle moved underneath it, is exactly what reduces the glenohumeral angle
 * by the scapular share.
 *
 * THE BUG THIS FIXES, because it was subtle and expensive. The first version of
 * the split simply handed `buildDelta` the reduced GH share and let the clavicle
 * add the rest. Flexion and abduction read back correctly, so it looked right —
 * but the humerus is a CHILD of the clavicle, so tilting the clavicle also
 * carries the humerus's axial frame with it. Rig-measured, apparent axial
 * rotation went 0° → 24.6° at 135° flexion → 104.4° at 180°, against exactly 0°
 * before the split. A visibly wrung arm, and a `shoulderRotation` readout
 * reporting a twist nobody commanded.
 *
 * The construction, with `W` the humerus rest world quat and `C` the girdle's
 * world-frame rotation. Un-split, the target world orientation is `W · full`.
 * Split, the achieved orientation is `C · W · delta`. Setting them equal:
 *
 *     delta = W⁻¹ · C⁻¹ · W · full
 *
 * so the delta is the FULL (unreduced) swing pre-rotated by the girdle's inverse
 * in the humerus's rest frame. Exact — no calibration table, no per-angle fit.
 * Identity when no girdle rotation accompanies the command, which is every
 * motion other than shoulder elevation and every elevation inside the setting
 * phase, so those paths stay byte-identical.
 */
function unparentGirdle(ctx: BuildCtx, delta: THREE.Quaternion): THREE.Quaternion {
  const { girdleWorld, restWorldQuat } = ctx;
  if (!girdleWorld || !restWorldQuat) return delta;
  return restWorldQuat
    .clone()
    .invert()
    .multiply(girdleWorld.clone().invert())
    .multiply(restWorldQuat)
    .multiply(delta);
}

/** The WORLD-frame rotation a girdle contribution applies to the clavicle.
 *  The scapular specs are PARENT-frame (`local = delta · restLocal`), so the
 *  world-frame rotation they realize is `parentWorld · delta · parentWorld⁻¹`.
 *  Null when the contributions are all zero or the clavicle's rest frame is
 *  unavailable — in which case no correction is needed or possible. */
function girdleWorldRotation(
  joint: string,
  contributions: { motion: string; degrees: number }[],
  baselinePose: CustomPose,
  rest: JointAngleRestReference | null | undefined,
): THREE.Quaternion | null {
  const key = girdleKeyFor(joint);
  const specs = key ? SUPPORTED_MOTIONS[key] : undefined;
  const restLocalArr = baselinePose.bones?.[key ?? ''];
  const restWorldArr = rest?.worldQuats?.[key ?? ''];
  if (!key || !specs || !restLocalArr || !restWorldArr) return null;
  const e = new THREE.Euler();
  let gx = 0;
  let gz = 0;
  for (const c of contributions) {
    const spec = specs[c.motion];
    if (!spec || !Number.isFinite(c.degrees) || Math.abs(c.degrees) < 1e-9) continue;
    e.setFromQuaternion(spec.buildDelta(c.degrees), 'YXZ');
    gx += e.x;
    gz += e.z;
  }
  if (Math.abs(gx) < 1e-9 && Math.abs(gz) < 1e-9) return null;
  const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(gx, 0, gz, 'YXZ'));
  const restLocal = new THREE.Quaternion(
    restLocalArr[0],
    restLocalArr[1],
    restLocalArr[2],
    restLocalArr[3],
  );
  const restWorld = new THREE.Quaternion(
    restWorldArr[0],
    restWorldArr[1],
    restWorldArr[2],
    restWorldArr[3],
  );
  const parentWorld = restWorld.multiply(restLocal.invert());
  return parentWorld.clone().multiply(delta).multiply(parentWorld.invert());
}

// ── SCAPULOHUMERAL RHYTHM ────────────────────────────────────────────────────
// The engine used to realize the ENTIRE commanded shoulder elevation as one
// quaternion on the UpperArm bone, with the clavicle untouched. Glenohumeral
// capacity is ~120°, so a commanded 180° asked the humerus for 180° of
// glenohumeral rotation — a 60° overdraft — and resolveCommandTarget returned
// 'complied'. The engine was certifying an anatomically impossible humerus as
// normal, which is the identical defect already fixed for the thumb (see
// romRegistry's Thumb1 note). Postures do command into that band.
//
// A goniometric "shoulder flexion" is the HUMEROTHORACIC angle — humerus
// relative to the trunk, scapular contribution included — so the registry
// ceiling of 180° is the right CLINICAL number. What was wrong was the
// REALIZATION. Elevation is now split across the two joints that actually
// produce it, and because the readout is world-anchored off the humerus (which
// is a CHILD of the clavicle) the girdle share is picked up automatically:
// commanded == measured still holds, on the humerothoracic angle.
//
// WHICH GIRDLE CHANNEL CARRIES WHICH PLANE — rig-measured, not assumed:
//   scapularTilt → shoulderFlexion     1:1 exactly  (40° tilt ⇒ +40.00° flexion)
//   upRotation   → shoulderAbduction   ~1:1         (60° upRot ⇒ +58.4° abduction)
//   upRotation   → shoulderFlexion     ~0           (and NEGATIVE past ~40°)
// That is also the correct anatomy: posterior tilt is the sagittal-plane girdle
// contribution, upward rotation the frontal-plane one (Ludewig et al. 2009
// measures both — +39° UR and +21° PT over 0→120° humerothoracic).
//
// THE MODEL. Below the SETTING PHASE (Inman, Saunders & Abbott 1944 — the first
// ~30° of abduction / ~60° of flexion) elevation is predominantly glenohumeral
// and scapular motion is small, variable and subject-specific; past it the
// ratio is ~2:1 GH:scapular. The setting phase is not a rounding detail here —
// it is what keeps GAIT untouched. Walking arm swing is ±12-15° and running
// ~±25°, both inside it, so neither authors any girdle rotation. That matters:
// there is no normative dataset of scapulothoracic joint kinematics in walking,
// and the real scapular upward rotation over a walking arm swing is ~0-5°.
// Adding a rhythm to gait would be inventing a motion that is not there.
const SCAPULOHUMERAL_SETTING_FLEX_DEG = 60;
const SCAPULOHUMERAL_SETTING_ABD_DEG = 30;
/** Glenohumeral : scapulothoracic elevation ratio past the setting phase.
 *  Inman's 2:1. Real values range 1.5:1-3:1 by phase and load (Kibler 1998;
 *  McQuade & Smidt 1998), so gates should band it rather than pin it. */
const SCAPULOHUMERAL_RATIO = 2;
/** Glenohumeral elevation capacity (deg). The whole point of the split. */
const GH_ELEVATION_MAX_DEG = 120;
/** Girdle excursion ceilings — the romRegistry bands for the clavicle bone.
 *  Kept in sync with romRegistry's L/R_Shoulder row. */
const GIRDLE_TILT_MAX_DEG = 40;
const GIRDLE_UPROT_MAX_DEG = 60;

/**
 * Split a commanded HUMEROTHORACIC elevation into its glenohumeral and
 * scapulothoracic shares. Below the setting phase it is all glenohumeral; past
 * it the remainder divides {@link SCAPULOHUMERAL_RATIO}:1; the humerus is then
 * hard-capped at {@link GH_ELEVATION_MAX_DEG} and the overflow spills to the
 * girdle, which is what makes a commanded 180° abduction land on Inman's exact
 * 120° GH + 60° scapular.
 *
 * THE RESIDUAL, stated plainly. The rig has ONE clavicle bone where anatomy has
 * two joints (sternoclavicular + acromioclavicular), so its sagittal excursion
 * is finite. Flexion beyond ~160° needs more girdle than the physiologic
 * `scapularTilt` band can supply, and rather than author an unphysiologic
 * girdle value the surplus goes BACK to the humerus. So the overdraft is not
 * eliminated at the very top of the flexion range — it is 20° at a commanded
 * 180°, down from 60°, and zero at or below 160°. Inflating the girdle band to
 * hide it would move the lie rather than remove it.
 *
 * Negative values (extension / adduction) pass through untouched: the rhythm
 * describes ELEVATION.
 */
export function girdleSplit(
  deg: number,
  plane: 'flexion' | 'abduction',
): { gh: number; girdle: number } {
  const settingDeg =
    plane === 'flexion' ? SCAPULOHUMERAL_SETTING_FLEX_DEG : SCAPULOHUMERAL_SETTING_ABD_DEG;
  if (!Number.isFinite(deg) || deg <= settingDeg) return { gh: deg, girdle: 0 };
  const girdleMaxDeg = plane === 'flexion' ? GIRDLE_TILT_MAX_DEG : GIRDLE_UPROT_MAX_DEG;
  let gh = settingDeg + (deg - settingDeg) * (SCAPULOHUMERAL_RATIO / (SCAPULOHUMERAL_RATIO + 1));
  let girdle = deg - gh;
  if (gh > GH_ELEVATION_MAX_DEG) {
    girdle += gh - GH_ELEVATION_MAX_DEG;
    gh = GH_ELEVATION_MAX_DEG;
  }
  if (girdle > girdleMaxDeg) {
    gh += girdle - girdleMaxDeg; // the documented residual
    girdle = girdleMaxDeg;
  }
  return { gh, girdle };
}

/** Build context a few specs need beyond the rest local quaternion: the body
 *  variant (finger fits are variant-keyed) and — when the caller supplies the
 *  rest reference — the commanded bone's rest WORLD orientation + world long
 *  axis (shoulder elevation builds a world-plane swing from them). */
interface BuildCtx {
  variantId?: string;
  restWorldQuat?: THREE.Quaternion;
  restDir?: THREE.Vector3;
  /** The commanded bone's PARENT world orientation at anatomic rest. Shoulder
   *  elevation needs it to express the clavicle's girdle rotation in world
   *  terms — see {@link girdleWorldRotation}. */
  parentRestWorldQuat?: THREE.Quaternion;
  /** The girdle (clavicle) rotation this command also applies, as a WORLD-frame
   *  rotation. Present only for humeral elevation with a nonzero scapular
   *  share; {@link armSwingDelta} and {@link composeShoulderDelta} correct for
   *  it so the humerothoracic result is unchanged by the split. */
  girdleWorld?: THREE.Quaternion;
}

interface SupportedMotionSpec {
  /** Delta quaternion realizing a clinical target (deg, registry
   *  convention) from the anatomic-rest local quaternion. `ctx` is provided
   *  only when buildCommandPose has the rest reference; specs that need it
   *  (shoulder elevation) return the identity delta without it. */
  buildDelta(clinicalDeg: number, ctx?: BuildCtx): THREE.Quaternion;
  /** OPTIONAL multi-bone realization. A digit's curl is ONE clinical value but
   *  three bones; a motion that supplies this gets its MCP delta from here
   *  instead of `buildDelta`, plus deltas for the middle/distal phalanges.
   *  Absent for every other motion, which stays exactly single-bone. */
  phalanges?(
    clinicalDeg: number,
    ctx?: BuildCtx,
  ): { mcp: THREE.Quaternion; pip: THREE.Quaternion; dip: THREE.Quaternion };
  /** OPTIONAL SHOULDER-GIRDLE realization. Shoulder ELEVATION is one clinical
   *  value (the humerothoracic angle a goniometer reads) but TWO joints: the
   *  glenohumeral joint and the scapulothoracic girdle. A motion that supplies
   *  this gets its humeral share from `buildDelta` and hands the remainder to
   *  the clavicle bone. See {@link girdleSplit} and {@link writeGirdle}.
   *  Absent for every other motion, which stays exactly single-bone. */
  girdle?(clinicalDeg: number): { gh: number; motion: string; degrees: number };
  /** OPTIONAL COMPANION-BONE realization — a SECOND bone this motion also
   *  writes, as a parent-frame Euler delta summed with any other motion writing
   *  the same companion.
   *
   *  The cervical spine needs it and the shoulder's `girdle` hook could not
   *  supply it: `girdle` hands a fixed sibling a DIFFERENT motion's share, which
   *  is the anatomy of an elevating arm, not of a two-segment curve. Head
   *  protraction is a TRANSLATION produced by rotating two stacked segments in
   *  OPPOSITE directions — lower-cervical flexion against upper-cervical
   *  extension — so both bones carry the same motion with opposite sign.
   *
   *  That also makes the two cervical channels orthogonal, which is what makes
   *  them measurable: the readout takes the SUM of the two segments as flexion
   *  and their HALF-DIFFERENCE as protraction, so neither can contaminate the
   *  other no matter what combination is commanded. See `writeCompanions`. */
  companion?: {
    /** Canonical key of the second bone. */
    key: string;
    buildDelta(clinicalDeg: number, ctx?: BuildCtx): THREE.Quaternion;
  };
  /** How the delta composes with the rest local quaternion:
   *  - 'parent': bone.local = delta × restLocal — a PARENT-frame delta.
   *    Exact for body-euler readouts (ankle), which decompose exactly this.
   *  - 'rest': bone.local = restLocal × delta — the CANONICAL/rest-frame
   *    delta (`currentWorld = restWorld · delta` when the parent chain is at
   *    rest, since restLocal = parentRestWorld⁻¹·restWorld). This is the
   *    authored ankle-pose convention (rest × axis rotation) generalized,
   *    and the same frame poseRomClamp recomposes ball/hinge joints in — it
   *    pins the WORLD direction of the motion. */
  compose: 'parent' | 'rest';
  /** Map the joint-angle REPORT value for this field into the registry's
   *  clinical convention (the hinge readout signs anatomic flexion negative;
   *  see jointAngles.ts). */
  fromReport(reportDeg: number): number;
}

/** v1 supported joint.motion → construction spec. DOCUMENTED SUPPORT LIST:
 *  L/R_Foot.ankleFlexion and L/R_Leg.kneeFlexion.
 *
 *  - ankleFlexion: parent-frame body-euler X delta (exact against the
 *    readout, which decomposes exactly this delta; dorsi + = +X, plantar
 *    − = −X — the authored ankle-sprain axis convention).
 *  - kneeFlexion: canonical/rest-frame ball swing, NEGATED into the delta
 *    (v1.2 field fix): the raw ballFlexDelta(+deg) swing re-aims the shin
 *    ANTERIORLY (the way the body faces — a FRONT-KICK), while anatomic knee
 *    flexion is the OPPOSITE: the shin re-aiming POSTERIORLY (heel toward the
 *    buttock). Passing −deg delivers that posterior flexion; the original
 *    un-negated spec shipped a front-kick (founder field report). With the
 *    corrected sign the geometric hinge readout signs anatomic flexion
 *    POSITIVE, so `fromReport` is identity.
 *
 *  v1.3 EXPANSION (rig-verified, each with a movementCommand.test.ts case
 *  asserting commanded == measured within ±2° and no off-plane smear):
 *   - HIP (L/R_UpLeg.hipFlexion): ball swing in the rest frame like the knee, but
 *     UN-negated — the readout measures the swing directly on the UpLeg (not a
 *     child), so +deg lands the thigh anterior; extension is negative.
 *   - ELBOW (L/R_Forearm.elbowFlexion): hinge, rest-frame ball swing +deg (flexes
 *     anterior toward the biceps, opposite the knee).
 *   - TRUNK (Spine_Lower.lateralTilt/rotation) + CERVICAL (Neck.flexion/rotation/
 *     lateralTilt): body-aligned parent-local frames, so clean single-axis euler
 *     deltas (X flex, Y rotation, Z lateral). lateralTilt carries latSign=−1 in
 *     the readout, so those specs pass −deg. (Trunk EXTENSION already works as
 *     negative Spine_Lower.flexion.)
 *   - SHOULDER ABDUCTION (L/R_UpperArm.shoulderAbduction): parent-frame Z-euler.
 *     Clavicle-Z ≈ world +Z (the true abduction axis) is perpendicular to the
 *     readout's long axis, so it decomposes as a clean swing (L +deg, R −deg).
 *
 *  v1.4 EXPANSION — HIP frontal + transverse (L/R_UpLeg), rig-verified:
 *   - hipAbduction: rest-frame FRONTAL swing (ballAbductDelta). One signed field,
 *     + = abduction / − = adduction; the readout mirrors on the right so the right
 *     spec swings toward −X. World motion is a clean lateral knee swing.
 *   - hipRotation: rest-frame TWIST about the long axis (ballTwistDelta). + = internal
 *     / − = external; the readout twist sign flips on the left, matches on the right.
 *   Main-axis readback is exact (±1°); as a swing-twist ball joint the off-neutral
 *   decomposition couples a few degrees into the other two planes (≤~5° at 30°) —
 *   an inherent readout artifact, not a world-motion error, and the graded axis is
 *   exact. (Hip flexion/extension shipped in v1.3.)
 *
 *  v1.5 EXPANSION — "every joint the rig reports" (calibration team, rig-verified):
 *   - ANKLE secondary (L/R_Foot.ankleInversion, .ankleAbduction): parent body-euler
 *     Z / Y; readout mirrors on the right → right passes the opposite sign. Exact, 0 smear.
 *   - GREAT TOE (L/R_Toes.toeFlexion): parent X-euler like the ankle, same sign both
 *     feet; + = MTP extension (toe up), − = curl.
 *   - THORACIC (Spine_Upper.flexion/lateralTilt/rotation): body-aligned segment, the
 *     lumbar constructions transfer verbatim (X / Z(−deg) / Y). Register under Spine_Upper.
 *   - SCAPULA / clavicle (L/R_Shoulder.upRotation/scapularTilt/protraction): parent
 *     body-euler Z / −X / −Y; upRotation + protraction mirror on the right, tilt does not.
 *   - WRIST (L/R_Hand.wristFlexion/wristDeviation): parent euler on the forearm-
 *     inherited frame — flexion Z (RIGHT inverts, ~180° frame flip), deviation X (no
 *     mirror). (pro/sup moved to the Forearm bone in v1.6 — see below.)
 *   - FINGERS / THUMB (L/R_{Thumb1,Index1,Mid1,Ring1,Pinky1}.fingerFlexion): composite
 *     MCP+PIP curl about the pinned local-Z ring (compose 'rest'). The readback is
 *     ABSOLUTE-geometric (not rest-relative) with a per-digit slope+offset, so buildDelta
 *     PRE-COMPENSATES (inverts the linear fit) → commanded == measured; fromReport identity.
 *     sideSign L −1 / R +1 curls toward the palm. Usable to ~110° on the single MCP bone.
 *
 *  v1.6 EXPANSION — SHOULDER (world-frame readout) + hinge rotations:
 *   - The UpperArm readout is now WORLD/thorax-anchored (jointAngles.upperArmWorldAngles):
 *     flexion/abduction come from the arm's real world long axis, rotation is the residual
 *     twist after removing the elevation swing. This fixes the old degeneracy (a forward
 *     raise used to read as pure rotation).
 *   - shoulderFlexion (NOW SHIPPED): rest-frame MINIMAL-ARC world-plane swing (armSwingDelta
 *     about world X); needs the rest world orientation, so buildCommandPose passes a
 *     BuildCtx. Exact + twist-free through ≥135°. + = forward.
 *   - shoulderAbduction: same world-swing about world Z (mirror per side); exact to ~90°.
 *   - shoulderRotation: rest-frame ballTwist; exact, zero elevation leak. + = internal.
 *     (flexion/abduction are IN-PLANE fields — each saturates toward 180° once the OTHER
 *     passes horizontal; an inherent 3-field ball-joint limit, harmless to single-plane grading.)
 *   - FOREARM pro/sup (L/R_Forearm.forearmRotation): TRUE forearm rotation (ballTwist on the
 *     Forearm bone; the readout writes the total to the elbow + wrist rows). + = supination.
 *   - KNEE rotation (L/R_Leg.kneeRotation): tibial int/ext (ballTwist); + = internal.
 *
 *  STILL REFUSED — elbow/knee VARUS-VALGUS (elbowDeviation, kneeDeviation): a frontal re-aim
 *  is geometrically indistinguishable from the (geometric) hinge-flexion term, so commanding
 *  deviation reads as ~1:1 phantom flexion. Shipping it would corrupt flexion grading. */
const SUPPORTED_MOTIONS: Record<string, Record<string, SupportedMotionSpec>> = (() => {
  const ankle: SupportedMotionSpec = {
    buildDelta: (deg) => eulerXDelta(deg),
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  const knee: SupportedMotionSpec = {
    buildDelta: (deg) => ballFlexDelta(-deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  // Hip + elbow: rest-frame ball swing, UN-negated (anterior). See the v1.3 note.
  const hip: SupportedMotionSpec = {
    buildDelta: (deg) => ballFlexDelta(deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  const elbow: SupportedMotionSpec = {
    buildDelta: (deg) => ballFlexDelta(deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  // Hip abduction/adduction (v1.4): rest-frame frontal swing. One signed field —
  // + = abduction (away from midline), − = adduction. The readout mirrors on the
  // right, so the right spec swings toward −X (pass −deg) to abduct on its side.
  const hipAbdL: SupportedMotionSpec = {
    buildDelta: (deg) => ballAbductDelta(deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  const hipAbdR: SupportedMotionSpec = {
    buildDelta: (deg) => ballAbductDelta(-deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  // Hip internal/external rotation (v1.4): rest-frame twist about the long axis.
  // + = internal rotation, − = external. The readout twist sign is flipped on the
  // left relative to the geometric twist and matched on the right (rig-verified),
  // so the left spec passes −deg and the right +deg.
  const hipRotL: SupportedMotionSpec = {
    buildDelta: (deg) => ballTwistDelta(-deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  const hipRotR: SupportedMotionSpec = {
    buildDelta: (deg) => ballTwistDelta(deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  // Lumbar flexion (v1.1): the waist bone's parent-local frame is body-aligned
  // on the CC rig (unlike the twisted thigh/clavicle locals), so a plain
  // parent-frame X-euler delta both LOOKS right in world space (head moves
  // anterior + caudal) and READS back exactly (clinical flexion = commanded,
  // zero lateral/rotation smear) — rig-verified in movementCommand.test.ts.
  const lumbar: SupportedMotionSpec = {
    buildDelta: (deg) => eulerXDelta(deg),
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  // Lumbar side-bend + axial rotation (v1.3): same body-aligned frame → Z/Y euler.
  const lumbarLateral: SupportedMotionSpec = {
    buildDelta: (deg) => eulerZDelta(-deg), // readout latSign=−1
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  const lumbarRotation: SupportedMotionSpec = {
    buildDelta: (deg) => eulerYDelta(deg),
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  // Cervical (v1.3): Neck parent-local frame is body-aligned like the waist.
  //
  // FLEXION IS SPLIT ACROSS BOTH CERVICAL SEGMENTS (v1.8), half to each. It used
  // to hinge entirely at NeckTwist02 and the readout summed both segments, which
  // measured correctly only because the lower segment never moved. Two reasons to
  // split it:
  //
  //   • It is what the rig already claims. The `Neck` handle is documented as a
  //     CURVE control that "curves both neck bones"; hinging one of them is not
  //     that, and reads as a break at the top of the neck rather than a bend.
  //   • It is what makes PROTRACTION measurable. With flexion on one bone the
  //     two channels are not separable — any flexion would leak into a
  //     protraction readout built from the segments' difference. Split evenly,
  //     flexion contributes ZERO difference and protraction contributes ZERO sum,
  //     so the pair is exactly orthogonal and each reads back its own command.
  const cervicalFlex: SupportedMotionSpec = {
    buildDelta: (deg) => eulerXDelta(deg / 2),
    companion: { key: 'Neck_Lower', buildDelta: (deg) => eulerXDelta(deg / 2) },
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  /**
   * HEAD PROTRACTION / RETRACTION — the forward-head translation, and the
   * clinically loud one this rig had no channel for at all.
   *
   * It is not a rotation of the neck; it is a TRANSLATION of the head, produced
   * by flexing the LOWER cervical spine while EXTENDING the upper. Two stacked
   * segments turning opposite ways carry the head forward while leaving it level
   * — which is exactly why it cannot be expressed by the `Neck` curve control,
   * which bends both segments the same way.
   *
   * The rig can do it: the chain is Spine02 → NeckTwist01 → NeckTwist02 → Head,
   * two cervical segments, which is the minimum the motion needs. (An earlier
   * note in the ledger called this unrepresentable and an ASSET problem. It was
   * neither; it was simply unbuilt.)
   *
   * + = protracted (chin forward), matching the shoulder girdle's Pro/Ret sign.
   */
  const cervicalProtraction: SupportedMotionSpec = {
    buildDelta: (deg) => eulerXDelta(-deg), // upper cervical EXTENDS
    companion: { key: 'Neck_Lower', buildDelta: (deg) => eulerXDelta(deg) }, // lower FLEXES
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  const cervicalRotation: SupportedMotionSpec = {
    buildDelta: (deg) => eulerYDelta(deg),
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  const cervicalLateral: SupportedMotionSpec = {
    buildDelta: (deg) => eulerZDelta(-deg), // readout latSign=−1
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  // Shoulder (v1.6): WORLD-frame elevation swings under the world UpperArm readout.
  // flexion = world sagittal swing (same both arms; forward is forward); abduction =
  // world frontal swing (mirrored per side, away-from-midline +); rotation = rest-frame
  // twist. SIGN_* pin the world-axis direction to the clinical + convention.
  //
  // ELEVATION IS SPLIT ACROSS TWO JOINTS (see girdleSplit): the commanded value is
  // the HUMEROTHORACIC angle, and only its glenohumeral share reaches the humerus.
  const SHOULDER_FLEX_SIGN = -1; // +deg flexion = forward (anterior)
  const SHOULDER_ABD_SIGN = 1; // +deg abduction = away from midline (L); R mirrors
  const shoulderFlex: SupportedMotionSpec = {
    buildDelta: (deg, ctx) => armSwingDelta(ctx, WORLD_X, SHOULDER_FLEX_SIGN * deg),
    girdle: (deg) => {
      const { gh, girdle } = girdleSplit(deg, 'flexion');
      return { gh, motion: 'scapularTilt', degrees: girdle };
    },
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  const shoulderAbdL: SupportedMotionSpec = {
    buildDelta: (deg, ctx) => armSwingDelta(ctx, WORLD_Z, SHOULDER_ABD_SIGN * deg),
    girdle: (deg) => {
      const { gh, girdle } = girdleSplit(deg, 'abduction');
      return { gh, motion: 'upRotation', degrees: girdle };
    },
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  const shoulderAbdR: SupportedMotionSpec = {
    buildDelta: (deg, ctx) => armSwingDelta(ctx, WORLD_Z, -SHOULDER_ABD_SIGN * deg),
    girdle: (deg) => {
      const { gh, girdle } = girdleSplit(deg, 'abduction');
      return { gh, motion: 'upRotation', degrees: girdle };
    },
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  // ── v1.5 EXPANSION (rig-verified by the calibration team; each ±≤2° readback,
  //    zero/near-zero off-plane smear, world-correct direction) ────────────────
  // ANKLE secondary axes (L/R_Foot): parent body-euler; readout mirrors on the
  // right so the right passes the opposite sign. inversion = eulerZ, abduction = eulerY.
  const ankleInvL: SupportedMotionSpec = { buildDelta: (deg) => eulerZDelta(-deg), compose: 'parent', fromReport: (deg) => deg };
  const ankleInvR: SupportedMotionSpec = { buildDelta: (deg) => eulerZDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  const ankleAbdL: SupportedMotionSpec = { buildDelta: (deg) => eulerYDelta(-deg), compose: 'parent', fromReport: (deg) => deg };
  const ankleAbdR: SupportedMotionSpec = { buildDelta: (deg) => eulerYDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  // GREAT TOE / forefoot MTP (L/R_Toes): parent X-euler like the ankle, same sign
  // both feet (toeFlexion = −euler.x, no mirror). + = extension (toe lifts up).
  const toe: SupportedMotionSpec = { buildDelta: (deg) => eulerXDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  // THORACIC (Spine_Upper): body-aligned segment — the lumbar constructions transfer verbatim.
  const thoracicFlex: SupportedMotionSpec = { buildDelta: (deg) => eulerXDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  const thoracicLateral: SupportedMotionSpec = { buildDelta: (deg) => eulerZDelta(-deg), compose: 'parent', fromReport: (deg) => deg };
  const thoracicRotation: SupportedMotionSpec = { buildDelta: (deg) => eulerYDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  // PELVIS (Hips bone). The pelvis was the one rig-reported joint with NO entry
  // here at all — declared in romRegistry, clamped by poseRomClamp, read back by
  // computeJointAngles, and commandable by nothing. That is why every shipped
  // motion measures a hard zero on all three pelvic channels: the walk's
  // "pelvic rotation" is model-ROOT yaw, which rotateRestReferenceByRoot then
  // cancels straight back out of the readout.
  //
  // Its readout is the WORLD-frame body-euler delta from rest (jointAngles'
  // pelvis block, decomposeBodyDelta over YXZ), which maps to the clinical
  // fields with no cross-terms at all:
  //     anteriorTilt = eX     rotation = eY     lateralTilt = eZ
  // So a command is just that euler — but expressed in the WORLD frame, while a
  // bone carries a LOCAL quaternion. `pelvisWorldEuler` conjugates through the
  // parent's rest world orientation to convert between them. Without that the
  // pelvis's parent (an unmapped skeleton-root bone carrying a −90° X rotation
  // on this rig) would silently permute the axes.
  const pelvisWorldEuler = (x: number, y: number, z: number): SupportedMotionSpec => ({
    buildDelta: (deg, ctx) => {
      const e = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(x * deg * RAD, y * deg * RAD, z * deg * RAD, 'YXZ'),
      );
      const p = ctx?.parentRestWorldQuat;
      return p ? p.clone().invert().multiply(e).multiply(p) : e;
    },
    compose: 'parent',
    fromReport: (deg) => deg,
  });
  const pelvisTilt = pelvisWorldEuler(1, 0, 0);
  const pelvisRotation = pelvisWorldEuler(0, 1, 0);
  const pelvisLateral = pelvisWorldEuler(0, 0, 1);
  // SCAPULAR GIRDLE (L/R_Shoulder = clavicle bone): parent body-euler. upRotation
  // (Z, mirror R), scapularTilt (−X, no mirror), protraction (−Y, mirror R). ~0 smear.
  const scapUpRotL: SupportedMotionSpec = { buildDelta: (deg) => eulerZDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  const scapUpRotR: SupportedMotionSpec = { buildDelta: (deg) => eulerZDelta(-deg), compose: 'parent', fromReport: (deg) => deg };
  const scapTilt: SupportedMotionSpec = { buildDelta: (deg) => eulerXDelta(-deg), compose: 'parent', fromReport: (deg) => deg };
  const scapProtractL: SupportedMotionSpec = { buildDelta: (deg) => eulerYDelta(-deg), compose: 'parent', fromReport: (deg) => deg };
  const scapProtractR: SupportedMotionSpec = { buildDelta: (deg) => eulerYDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  // WRIST (L/R_Hand): parent euler on the forearm-inherited frame. flexion = Z (the
  // RIGHT frame is flipped ~180°, so its sign inverts), deviation = X (no mirror),
  // proSup = Y (mirror R). NOTE proSup reads exact on the Hand bone but visually
  // spins the hand about a stationary forearm — a cosmetic caveat, grading is correct.
  const wristFlexL: SupportedMotionSpec = { buildDelta: (deg) => eulerZDelta(-deg), compose: 'parent', fromReport: (deg) => deg };
  const wristFlexR: SupportedMotionSpec = { buildDelta: (deg) => eulerZDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  const wristDev: SupportedMotionSpec = { buildDelta: (deg) => eulerXDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  const wristProSupL: SupportedMotionSpec = { buildDelta: (deg) => eulerYDelta(-deg), compose: 'parent', fromReport: (deg) => deg };
  const wristProSupR: SupportedMotionSpec = { buildDelta: (deg) => eulerYDelta(deg), compose: 'parent', fromReport: (deg) => deg };
  // SHOULDER ROTATION (L/R_UpperArm): parent Y-euler — a rest-frame twist smears on
  // the twisted humeral local frame, but the parent Y-euler reads clean. + = internal.
  // Mirror on the right. (shoulderFlexion stays refused — see the doc note.)
  // Shoulder rotation (v1.6): rest-frame twist about the arm long axis; exact + zero
  // elevation leak under the world readout. + = internal; readout mirrors on the right.
  const shoulderRotL: SupportedMotionSpec = { buildDelta: (deg) => ballTwistDelta(-deg), compose: 'rest', fromReport: (deg) => deg };
  const shoulderRotR: SupportedMotionSpec = { buildDelta: (deg) => ballTwistDelta(deg), compose: 'rest', fromReport: (deg) => deg };
  // Forearm pro/sup (v1.6): TRUE forearm rotation commanded on the Forearm bone
  // (radioulnar twist; the readout writes the total to both the elbow + wrist rows).
  // + = supination. Rest-frame twist; L +deg / R −deg.
  const forearmRotL: SupportedMotionSpec = { buildDelta: (deg) => ballTwistDelta(deg), compose: 'rest', fromReport: (deg) => deg };
  const forearmRotR: SupportedMotionSpec = { buildDelta: (deg) => ballTwistDelta(-deg), compose: 'rest', fromReport: (deg) => deg };
  // Knee rotation (v1.6): tibial int/ext rotation. Rest-frame twist; + = internal.
  // knee readout twistSign=−1 flips the pattern vs the forearm: L −deg / R +deg.
  const kneeRotL: SupportedMotionSpec = { buildDelta: (deg) => ballTwistDelta(-deg), compose: 'rest', fromReport: (deg) => deg };
  const kneeRotR: SupportedMotionSpec = { buildDelta: (deg) => ballTwistDelta(deg), compose: 'rest', fromReport: (deg) => deg };
  // FINGERS / THUMB: one composite curl command realized across all three
  // phalanges about the pinned local-Z ring. sideSign L −1 / R +1 curls the
  // fingertip toward the palm; `fromReport` is identity.
  //
  // NO CALIBRATION TABLE. `computeJointAngles` measures fingerFlexion as the
  // SIGNED sum of the MCP and PIP angles in the curl plane, as a delta from rest
  // — so the MCP contributes exactly (1 − FINGER_PIP_SHARE) of the total curl and
  // the PIP exactly FINGER_PIP_SHARE. Those sum to 1, which makes commanded equal
  // to measured identically and linearly: the authored total local curl IS the
  // clinical value. Rig-verified at ratio 1.000 on all five digits, both hands,
  // both variants, from −30° through +176°.
  //
  // This replaced a 130-constant per-digit per-variant lookup table (FINGER_CURVE)
  // plus its interpolating inverse, its non-finite guard, its regeneration
  // procedure, and five per-digit "floor" constants. All of that existed to invert
  // a measurement that summed UNSIGNED angles against a splayed reference vector,
  // and so reported a straight index finger as 22° of flexion and could not
  // represent extension at all. Fixing the readout deleted the machinery rather
  // than needing more of it — if a future change makes commanded stop equalling
  // measured here, the readout is what moved, not this.
  const makeFinger = (sideSign: number, digit: string): SupportedMotionSpec => {
    /** Total local curl (deg, signed for the side) realizing a clinical target.
     *  IDENTITY — the readout is linear in this quantity, so no inversion is
     *  needed. A non-finite command still must not reach the quaternion, or it
     *  poisons the whole skeleton on apply; buildCommandPose is shielded by
     *  resolveCommandTarget's refusal but buildComposedCommandPose is not. */
    const fullLocalDeg = (deg: number, _ctx?: BuildCtx) =>
      Number.isFinite(deg) ? sideSign * deg : 0;
    const about = (d: number) => new THREE.Quaternion().setFromAxisAngle(LOCAL_Z, d * RAD);
    return {
      // Single-bone fallback for callers without the phalanx bones mapped: the
      // whole curl at the knuckle. Reads back low (the table assumes the spread),
      // but it is the graceful degradation, not the supported path.
      buildDelta: (deg, ctx) => about(fullLocalDeg(deg, ctx)),
      /**
       * SPREAD THE CURL ALONG THE DIGIT. The shares follow the cascade a
       * relaxed hand actually takes — the PIP leads, the MCP trails it, and the
       * DIP carries about two-thirds of the PIP (measured tenodesis grip
       * proportions). At a firm relaxed grip (commanded 60°) that lands the male
       * middle finger at MCP 19° / PIP 35° / DIP 24°, and at the 160° ROM
       * ceiling at MCP 54° / PIP 100° / DIP 69° — each inside its own limit.
       *
       * THE THUMB IS NOT A FINGER and these shares are only approximately right
       * for it. Its chain is metacarpal / proximal / distal (rig-measured: the
       * first bone is 6.4cm against the middle finger's 5.3cm), so the three
       * rotations land on CMC / MP / IP — two true phalangeal joints, not three.
       * Its readout is also the least efficient of the five, needing 176° of
       * total local curl to reach a measured 160°, which puts the MP near 115°
       * against an anatomical ~60°. The thumb is therefore only anatomically
       * sound up to about 80° commanded (MP ~60°) — far above anything gait or
       * the relaxed hand ask for, both of which sit at or under its 28° floor.
       * Capping the thumb's fingerFlexion ROM in romRegistry would make that
       * limit explicit instead of documented; deliberately left for its own
       * change, since the ROM row is shared by all five digits.
       */
      phalanges: (deg, ctx) => {
        const full = fullLocalDeg(deg, ctx);
        const mcp = about(full * (1 - FINGER_PIP_SHARE));
        // The thumb also carries its resting ADduction, in the same rotation —
        // see THUMB_ADD_DEG for why it rides here rather than as its own command.
        if (digit === 'Thumb1')
          mcp.multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_X, THUMB_ADD_DEG * RAD));
        return {
          mcp,
          pip: about(full * FINGER_PIP_SHARE),
          dip: about(full * FINGER_DIP_SHARE),
        };
      },
      compose: 'rest',
      fromReport: (deg) => deg,
    };
  };
  return {
    L_Foot: { ankleFlexion: ankle, ankleInversion: ankleInvL, ankleAbduction: ankleAbdL },
    R_Foot: { ankleFlexion: ankle, ankleInversion: ankleInvR, ankleAbduction: ankleAbdR },
    L_Toes: { toeFlexion: toe },
    R_Toes: { toeFlexion: toe },
    L_Leg: { kneeFlexion: knee, kneeRotation: kneeRotL },
    R_Leg: { kneeFlexion: knee, kneeRotation: kneeRotR },
    L_UpLeg: { hipFlexion: hip, hipAbduction: hipAbdL, hipRotation: hipRotL },
    R_UpLeg: { hipFlexion: hip, hipAbduction: hipAbdR, hipRotation: hipRotR },
    L_Forearm: { elbowFlexion: elbow, forearmRotation: forearmRotL },
    R_Forearm: { elbowFlexion: elbow, forearmRotation: forearmRotR },
    // Wrist flex/dev on the Hand; pro/sup is commanded on the Forearm (true forearm
    // rotation), so it is intentionally NOT registered on the Hand.
    L_Hand: { wristFlexion: wristFlexL, wristDeviation: wristDev },
    R_Hand: { wristFlexion: wristFlexR, wristDeviation: wristDev },
    Hips: { anteriorTilt: pelvisTilt, lateralTilt: pelvisLateral, rotation: pelvisRotation },
    Spine_Lower: { flexion: lumbar, lateralTilt: lumbarLateral, rotation: lumbarRotation },
    Spine_Upper: { flexion: thoracicFlex, lateralTilt: thoracicLateral, rotation: thoracicRotation },
    Neck: {
      flexion: cervicalFlex,
      rotation: cervicalRotation,
      lateralTilt: cervicalLateral,
      protraction: cervicalProtraction,
    },
    L_Shoulder: { upRotation: scapUpRotL, scapularTilt: scapTilt, protraction: scapProtractL },
    R_Shoulder: { upRotation: scapUpRotR, scapularTilt: scapTilt, protraction: scapProtractR },
    L_UpperArm: { shoulderFlexion: shoulderFlex, shoulderAbduction: shoulderAbdL, shoulderRotation: shoulderRotL },
    R_UpperArm: { shoulderFlexion: shoulderFlex, shoulderAbduction: shoulderAbdR, shoulderRotation: shoulderRotR },
    L_Thumb1: { fingerFlexion: makeFinger(-1, 'Thumb1') },
    L_Index1: { fingerFlexion: makeFinger(-1, 'Index1') },
    L_Mid1: { fingerFlexion: makeFinger(-1, 'Mid1') },
    L_Ring1: { fingerFlexion: makeFinger(-1, 'Ring1') },
    L_Pinky1: { fingerFlexion: makeFinger(-1, 'Pinky1') },
    R_Thumb1: { fingerFlexion: makeFinger(1, 'Thumb1') },
    R_Index1: { fingerFlexion: makeFinger(1, 'Index1') },
    R_Mid1: { fingerFlexion: makeFinger(1, 'Mid1') },
    R_Ring1: { fingerFlexion: makeFinger(1, 'Ring1') },
    R_Pinky1: { fingerFlexion: makeFinger(1, 'Pinky1') },
  };
})();

/** True when v1 can realize this joint/motion as a pose. */
export function isMovementCommandSupported(joint: string, motion: string): boolean {
  return !!SUPPORTED_MOTIONS[joint]?.[motion];
}

/** The v1 command vocabulary, for host-side capability discovery. */
export function listSupportedMovementCommands(): { joint: string; motion: string }[] {
  const out: { joint: string; motion: string }[] = [];
  for (const [joint, motions] of Object.entries(SUPPORTED_MOTIONS)) {
    for (const motion of Object.keys(motions)) out.push({ joint, motion });
  }
  return out;
}

function copyPose(pose: CustomPose, variantId: string): CustomPose {
  const bones: Record<string, [number, number, number, number]> = {};
  for (const [key, q] of Object.entries(pose.bones ?? {})) bones[key] = [q[0], q[1], q[2], q[3]];
  const positions: Record<string, [number, number, number]> | undefined = pose.positions
    ? Object.fromEntries(Object.entries(pose.positions).map(([k, p]) => [k, [p[0], p[1], p[2]]]))
    : undefined;
  return {
    variant: variantId,
    bones,
    ...(positions ? { positions } : {}),
    schemaVersion: POSE_SCHEMA_VERSION,
  };
}

/**
 * Build the TARGET CustomPose for a resolved command by rotating the
 * commanded canonical bone about its documented motion axis FROM the
 * anatomic-rest local quaternion (per-motion composition — parent-frame
 * `delta × rest.local` for body-euler motions, rest/canonical-frame
 * `rest.local × delta` for ball/hinge motions; see
 * {@link SupportedMotionSpec}).
 *
 * @param baselinePose Full-skeleton anatomic-rest pose (serializeCustomPose
 *   right after applyAnatomicPose) — the source of the commanded bone's
 *   rest-local quaternion. For a `relax` command this is instead the pose
 *   the patient returns to (the authored/antalgic resting pose, or the
 *   anatomic baseline when none) and is returned as a copy.
 * @param cmd The command (already resolved/clamped by the caller).
 * @param clampedDegrees The ROM-clamped clinical target from
 *   {@link resolveCommandTarget} (ignored for relax).
 * @param variantCfg Variant the pose is stamped against.
 * @param fromPose Optional pose whose OTHER bones are preserved (the current
 *   on-screen pose, so sequential commands compose instead of snapping the
 *   rest of the body back to anatomic). Defaults to `baselinePose`.
 * @returns The target pose, or `null` when the joint/motion is unsupported
 *   (callers should have refused via {@link resolveCommandTarget} first).
 */
/**
 * How the one composite curl command splits across a digit's three phalanges,
 * as fractions of the digit's total local curl. The PIP LEADS and the MCP
 * trails it (MCP:PIP ≈ 0.54), which is the cascade a relaxed hand takes rather
 * than the equal split a naive spread would give.
 *
 * These are now FREE parameters — the readout measures the MCP and PIP terms
 * signed and in-plane, so they sum to the total curl for any split and commanded
 * equals measured whatever these are. They used to be half of a calibration:
 * a lookup table inverted the readout at this exact split, and changing a share
 * without regenerating the table silently broke the contract.
 */
const FINGER_PIP_SHARE = 0.65;
/** The distal phalanx is unmeasured (rig-probed: rotating it moves the readout
 *  0.00°), so this is pure shape — set at ~2/3 of the PIP, the tenodesis grip
 *  proportion, which is what makes the fingertip curl rather than point. */
const FINGER_DIP_SHARE = 0.45;
/**
 * Resting ADduction of the thumb metacarpal, degrees about LOCAL_X (negative =
 * in toward the index).
 *
 * The rig's rest thumb stands off the hand: the tip sits 5.4cm from the index
 * knuckle, which reads as a splayed, slightly startled hand rather than a
 * relaxed one. −14° brings it to 4.0cm — tucked alongside the index without
 * collapsing onto it (rig-probed: −20° reaches 3.2cm and starts to look pinched).
 *
 * It is applied WITH the curl, not as a separate command, because there is no
 * thumb-adduction channel in the registry and adding one would mean a new ROM
 * row, a new readout field and a two-dimensional calibration for a posture
 * detail. The cost is that it perturbs the thumb's OWN fingerFlexion readout —
 * that readout is the unsigned metacarpal-to-proximal angle, and adduction
 * swings the proximal away from the metacarpal. Under the SIGNED, in-plane,
 * rest-referenced readout that no longer biases the reading: the adduction is
 * perpendicular to the curl plane and the rest subtraction absorbs what is left,
 * so the thumb still measures its commanded curl exactly with this applied.
 * (Under the old unsigned readout it raised the thumb's reported floor from 28°
 * to 40° and forced its calibration rows to be regenerated.)
 */
const THUMB_ADD_DEG = -14;

/** The middle/distal phalanx pose keys for a digit's MCP key (`R_Index1` → 2, 3). */
function phalanxKeys(mcpKey: string): { pip: string; dip: string } {
  return { pip: `${mcpKey.slice(0, -1)}2`, dip: `${mcpKey.slice(0, -1)}3` };
}

/**
 * EVERY bone key a command on `joint` may write — not just the joint itself.
 *
 * A digit's one clinical `fingerFlexion` is realized across three bones, so any
 * caller reasoning about which bones a motion DRIVES must ask here instead of
 * assuming the target key is the only one touched. The settle pass in
 * buildSequencePoses is exactly that caller: it eases un-driven bones home, and
 * with a joint-key-only notion of "driven" it classified the phalanges as
 * residuals and slerped the spread back out of every commanded digit — leaving
 * the knuckle carrying a curl calibrated for a spread that no longer existed.
 */
export function commandedBoneKeys(joint: string): string[] {
  const specs = SUPPORTED_MOTIONS[joint];
  if (!specs) return [joint];
  // Shoulder elevation drives the clavicle as well as the humerus (writeGirdle),
  // so a settle pass that only knew about the humerus would erase the girdle
  // share — the exact failure the phalanx spread hit before this function
  // existed.
  const girdleKey = Object.values(specs).some((s) => s.girdle) ? girdleKeyFor(joint) : null;
  // Cervical flexion and protraction both drive the LOWER neck segment as a
  // companion; a settle pass that only knew about `Neck` would slerp it back out
  // — the same failure the phalanx spread and the girdle share both hit.
  const companionKeys = [
    ...new Set(Object.values(specs).flatMap((s) => (s.companion ? [s.companion.key] : []))),
  ];
  if (!Object.values(specs).some((s) => s.phalanges)) {
    return [joint, ...(girdleKey ? [girdleKey] : []), ...companionKeys];
  }
  const { pip, dip } = phalanxKeys(joint);
  return [joint, pip, dip];
}

export function buildCommandPose(
  baselinePose: CustomPose,
  cmd: ExamMovementCommand,
  clampedDegrees: number,
  variantCfg: BodyVariantConfig,
  fromPose?: CustomPose | null,
  rest?: JointAngleRestReference | null,
): CustomPose | null {
  if (cmd.action === 'relax') {
    return copyPose(baselinePose, variantCfg.id);
  }
  const spec = SUPPORTED_MOTIONS[cmd.joint]?.[cmd.motion];
  if (!spec) return null;
  const restArr = baselinePose.bones?.[cmd.joint];
  if (!restArr) return null;

  const target = copyPose(fromPose ?? baselinePose, variantCfg.id);
  const restQ = new THREE.Quaternion(restArr[0], restArr[1], restArr[2], restArr[3]);
  // Context beyond the rest local: the variant (finger fits are variant-keyed),
  // plus — when the rest reference is supplied — the bone's rest WORLD
  // orientation + direction (shoulder elevation builds a world-plane swing).
  const ctx: BuildCtx = { variantId: variantCfg.id };
  const rwArr = rest?.worldQuats?.[cmd.joint];
  const rdArr = rest?.worldDirs?.[cmd.joint];
  if (rwArr && rdArr) {
    ctx.restWorldQuat = new THREE.Quaternion(rwArr[0], rwArr[1], rwArr[2], rwArr[3]);
    ctx.restDir = new THREE.Vector3(rdArr[0], rdArr[1], rdArr[2]);
  }
  // The bone's PARENT world orientation at rest = restWorld · restLocal⁻¹. The
  // pelvis needs it to convert a WORLD-frame body euler (the frame its readout
  // decomposes in) into the local delta that realizes it.
  if (ctx.restWorldQuat)
    ctx.parentRestWorldQuat = ctx.restWorldQuat.clone().multiply(restQ.clone().invert());
  // The girdle share must be known BEFORE the humeral delta is built — the delta
  // is corrected for it (unparentGirdle), not merely reduced by it.
  const girdleShare = spec.girdle?.(clampedDegrees);
  if (girdleShare)
    ctx.girdleWorld =
      girdleWorldRotation(cmd.joint, [girdleShare], baselinePose, rest) ?? undefined;
  const delta = spec.buildDelta(clampedDegrees, ctx);
  const q =
    spec.compose === 'parent'
      ? delta.multiply(restQ) // parent-frame: delta × rest
      : restQ.clone().multiply(delta); // rest-frame: rest × delta
  target.bones[cmd.joint] = [q.x, q.y, q.z, q.w];

  writePhalanges(target, baselinePose, cmd.joint, spec, clampedDegrees, ctx, restQ);
  if (girdleShare) writeGirdle(target, baselinePose, cmd.joint, [girdleShare]);
  // …and the cervical pair spreads across both neck segments. See writeCompanions.
  writeCompanions(
    target,
    baselinePose,
    SUPPORTED_MOTIONS[cmd.joint] ?? {},
    [{ motion: cmd.motion, degrees: clampedDegrees }],
    ctx,
  );
  return target;
}

/**
 * Realize a digit across its three phalanges instead of hinging it entirely at
 * the knuckle, overwriting the single-bone result already written for the MCP.
 *
 * BOTH pose builders must call this. `buildComposedCommandPose` is the path the
 * whole composed-motion pipeline (and therefore gait) runs through; a spread
 * applied in only one of them means the calibration — which is measured against
 * the SPREAD geometry — is wrong wherever it is missing, and the digits read
 * several degrees low while looking like stiff paddles.
 *
 * A no-op for every non-digit motion (`phalanges` is undefined) and for any
 * variant whose middle/distal phalanges are unmapped: those keep the MCP-only
 * result, which is the graceful degradation.
 */
function writePhalanges(
  target: CustomPose,
  baselinePose: CustomPose,
  joint: string,
  spec: SupportedMotionSpec,
  deg: number,
  ctx: BuildCtx,
  restQ: THREE.Quaternion,
): void {
  const spread = spec.phalanges?.(deg, ctx);
  if (!spread) return;
  const { pip, dip } = phalanxKeys(joint);
  const restPip = baselinePose.bones?.[pip];
  const restDip = baselinePose.bones?.[dip];
  // ALL OR NOTHING. The MCP share is only 35% of the digit's curl — the rest
  // lives in the PIP and DIP — so writing the MCP before confirming the other
  // two are writable would leave a digit driven at a third of its commanded
  // angle. Bail instead, leaving the single-bone result buildDelta already
  // wrote. That is the documented degradation, and it is reachable: callers
  // supply their own baseline pose, and a partial one need not carry phalanges.
  if (!restPip || !restDip) return;
  const mcpQ = restQ.clone().multiply(spread.mcp);
  target.bones[joint] = [mcpQ.x, mcpQ.y, mcpQ.z, mcpQ.w];
  for (const [key, restArrP, delta] of [
    [pip, restPip, spread.pip],
    [dip, restDip, spread.dip],
  ] as const) {
    const composed = new THREE.Quaternion(
      restArrP[0],
      restArrP[1],
      restArrP[2],
      restArrP[3],
    ).multiply(delta);
    target.bones[key] = [composed.x, composed.y, composed.z, composed.w];
  }
}

/** The clavicle ('…_Shoulder', the scapular-girdle bone) that carries a
 *  humerus's scapulothoracic share, or null for any non-humeral joint. */
function girdleKeyFor(joint: string): string | null {
  const m = /^([LR]_)UpperArm$/.exec(joint);
  return m ? `${m[1]}Shoulder` : null;
}

/**
 * Write the SCAPULOTHORACIC share of one or more commanded shoulder elevations
 * onto the clavicle bone — the girdle sibling of {@link writePhalanges}.
 *
 * The contributions are realized through {@link buildComposedCommandPose} on the
 * clavicle joint itself rather than by hand, so flexion's `scapularTilt` and
 * abduction's `upRotation` fold into ONE body-euler delta exactly the way a
 * directly-commanded scapula would (writing them independently would have the
 * second silently clobber the first). The clavicle carries no `girdle` hook of
 * its own, so the recursion terminates immediately.
 *
 * AXIS-SCOPED, and that is load-bearing in both directions. The clavicle is a
 * parent-euler joint whose three clinical fields are three Euler axes:
 * `scapularTilt` = X, `protraction` = Y, `upRotation` = Z. This writes ONLY X
 * and Z — the two the rhythm drives — and carries Y through untouched:
 *   • Writing all three would erase gait's protraction, the one girdle channel
 *     the engine already drives (gaitModifiers), every time an arm elevated.
 *   • Skipping the write when the share is ZERO leaks the previous keyframe's
 *     share forward: a reach to 110° then back to 20° measured 36.67° for a
 *     commanded 20°, because the clavicle kept its 16.67° of tilt. So the write
 *     is unconditional and absolute from the anatomic rest, exactly like every
 *     other commanded value — never accumulated onto the incoming pose.
 * A scapular tilt / upward rotation commanded EXPLICITLY on the same side in
 * the same keyframe is therefore superseded by the humeral share. That is the
 * documented precedence: elevation owns the sagittal and frontal girdle axes.
 *
 * Degrades to a no-op when the clavicle is unmapped on this variant or the
 * caller's baseline does not carry it — the humerus keeps whatever
 * `buildDelta` already wrote, which is the glenohumeral share. That under-
 * rotates rather than over-rotates, which is the safe direction: it can never
 * re-introduce the impossible-humerus defect this split exists to fix.
 */
function writeGirdle(
  target: CustomPose,
  baselinePose: CustomPose,
  joint: string,
  contributions: { motion: string; degrees: number }[],
): void {
  const key = girdleKeyFor(joint);
  const restArr = baselinePose.bones?.[key ?? ''];
  const specs = key ? SUPPORTED_MOTIONS[key] : undefined;
  if (!key || !restArr || !specs) return;
  const restQ = new THREE.Quaternion(restArr[0], restArr[1], restArr[2], restArr[3]);
  // The girdle's own X/Z contribution, summed in the body-euler frame the
  // scapular specs are built in (same summation the parent-euler branch uses).
  const e = new THREE.Euler();
  let gx = 0;
  let gz = 0;
  for (const c of contributions) {
    const spec = specs[c.motion];
    if (!spec || !Number.isFinite(c.degrees)) continue;
    e.setFromQuaternion(spec.buildDelta(c.degrees), 'YXZ');
    gx += e.x;
    gz += e.z;
  }
  // Preserve whatever protraction (Y) the incoming pose already carries.
  const curArr = target.bones[key] ?? restArr;
  const existing = new THREE.Quaternion(curArr[0], curArr[1], curArr[2], curArr[3]).multiply(
    restQ.clone().invert(),
  );
  e.setFromQuaternion(existing, 'YXZ');
  const q = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(gx, e.y, gz, 'YXZ'))
    .multiply(restQ);
  target.bones[key] = [q.x, q.y, q.z, q.w];
}

/**
 * Write every COMPANION bone a joint's commanded motions also drive, summing
 * their parent-frame Euler deltas per companion.
 *
 * WRITTEN UNCONDITIONALLY AND ABSOLUTE FROM REST — including when no usable
 * motion has a companion, which zeroes it. That is deliberate and it is the
 * lesson `writeGirdle` learned the expensive way: a companion written only when
 * commanded LEAKS across keyframes, so a value authored at one keyframe survives
 * into the next that meant to leave it alone, and the readout drifts away from
 * the command. Absolute-from-rest cannot drift.
 *
 * Unlike `writeGirdle` this owns the WHOLE companion rather than scoped axes,
 * because a companion bone has no independent authoring path — nothing else
 * writes `Neck_Lower`. If a second companion user ever arrives that shares its
 * bone with another writer, this needs the same axis-scoping treatment.
 */
function writeCompanions(
  target: CustomPose,
  baselinePose: CustomPose,
  specs: Record<string, SupportedMotionSpec>,
  motions: { motion: string; degrees: number }[],
  ctx: BuildCtx,
): void {
  const byKey = new Map<string, { x: number; y: number; z: number }>();
  for (const m of Object.values(specs)) {
    if (m.companion) byKey.set(m.companion.key, { x: 0, y: 0, z: 0 });
  }
  if (byKey.size === 0) return;
  const e = new THREE.Euler();
  for (const t of motions) {
    const companion = specs[t.motion]?.companion;
    if (!companion || !Number.isFinite(t.degrees)) continue;
    const acc = byKey.get(companion.key)!;
    e.setFromQuaternion(companion.buildDelta(t.degrees, ctx), 'YXZ');
    acc.x += e.x;
    acc.y += e.y;
    acc.z += e.z;
  }
  for (const [key, acc] of byKey) {
    const restArr = baselinePose.bones?.[key];
    if (!restArr) continue;
    const restQ = new THREE.Quaternion(restArr[0], restArr[1], restArr[2], restArr[3]);
    const q = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(acc.x, acc.y, acc.z, 'YXZ'))
      .multiply(restQ);
    target.bones[key] = [q.x, q.y, q.z, q.w];
  }
}

/** True when a joint composes as a swing-twist BALL joint (shoulder / hip) —
 *  its three clinical fields (flexion/abduction/rotation) must be composed into
 *  ONE delta rather than written independently, or later fields silently
 *  overwrite earlier ones. */
function isBallJoint(joint: string): boolean {
  return /(?:UpperArm|UpLeg)$/.test(joint);
}

/** Shoulder (world-frame readout): compose flexion F, abduction A, rotation R
 *  (clinical deg) into ONE rest-frame local delta. Builds the target world arm
 *  direction that reads back exactly F and A under `upperArmWorldAngles`
 *  (in-plane, away from the flexion/abduction singularity), then adds the axial
 *  twist. Needs the rest world orientation (ctx). */
function composeShoulderDelta(ctx: BuildCtx, side: 'L' | 'R', F: number, A: number, R: number): THREE.Quaternion {
  const restDir = ctx.restDir!;
  const restWorldQuat = ctx.restWorldQuat!;
  const s = side === 'R' ? -1 : 1;
  const tFlex = Math.atan2(restDir.z, -restDir.y) + F * RAD;
  const tAbd = Math.atan2(s * restDir.x, -restDir.y) + A * RAD;
  const tf = Math.tan(tFlex), ta = Math.tan(tAbd);
  const c = 1 / Math.sqrt(1 + tf * tf + ta * ta);
  const target = new THREE.Vector3(s * c * ta, -c, c * tf).normalize();
  const worldSwing = new THREE.Quaternion().setFromUnitVectors(restDir, target);
  const delta = restWorldQuat.clone().invert().multiply(worldSwing).multiply(restWorldQuat);
  const twSign = side === 'R' ? 1 : -1;
  // Girdle-corrected (see unparentGirdle): identity when nothing accompanies it.
  return unparentGirdle(
    ctx,
    delta.multiply(new THREE.Quaternion().setFromAxisAngle(REST_DOWN, twSign * R * RAD)),
  );
}

/** Hip (canonical rest-frame readout): compose flexion F, abduction A, rotation
 *  R (clinical deg) into ONE rest-frame local delta. Re-aims the rest long axis
 *  to the swung direction that reads back F/A under `ballJointAngles`, then adds
 *  the long-axis twist. Main axis exact ±~4°; the swing-twist decomposition
 *  couples a few degrees into the off-axis fields off-neutral (documented). */
function composeHipDelta(side: 'L' | 'R', F: number, A: number, R: number): THREE.Quaternion {
  const s = side === 'R' ? -1 : 1;
  const aFlex = F * RAD;
  const aAbd = A * RAD * s;
  const rem = Math.cos(aAbd);
  const target = new THREE.Vector3(Math.sin(aAbd), -rem * Math.cos(aFlex), -rem * Math.sin(aFlex)).normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(REST_DOWN, target);
  const twSign = side === 'R' ? 1 : -1;
  return delta.multiply(new THREE.Quaternion().setFromAxisAngle(REST_DOWN, twSign * R * RAD));
}

/** One commanded motion on a joint inside a keyframe: its registry motion key
 *  and the (already ROM-clamped, trunk-compensated) clinical target. */
export interface ComposedJointTarget {
  motion: string;
  degrees: number;
}

/**
 * Build the target CustomPose for MULTIPLE motions commanded on the SAME joint
 * within one keyframe — the fix for the same-bone overwrite bug. Every motion
 * is composed into ONE bone quaternion instead of each write clobbering the
 * last:
 *   - BALL joints (L/R_UpperArm, L/R_UpLeg): flexion + abduction + rotation are
 *     folded into a single swing+twist delta ({@link composeShoulderDelta} /
 *     {@link composeHipDelta}). Main axes read back within tolerance; expect a
 *     few degrees of swing-twist coupling in the off-axis fields.
 *   - PARENT-euler joints (spine / neck / ankle / scapula / wrist / toes): the
 *     commanded axes are summed into ONE body-frame YXZ Euler delta, so e.g.
 *     lumbar flexion + lateralTilt + rotation coexist in one pose.
 *   - Any other rest-frame combination (e.g. elbow flexion + forearm rotation):
 *     the deltas are multiplied in order onto the rest local.
 * A single-motion group takes the identical path as {@link buildCommandPose}.
 */
export function buildComposedCommandPose(
  baselinePose: CustomPose,
  joint: string,
  targets: ComposedJointTarget[],
  variantCfg: BodyVariantConfig,
  fromPose?: CustomPose | null,
  rest?: JointAngleRestReference | null,
): CustomPose | null {
  const specs = SUPPORTED_MOTIONS[joint];
  if (!specs) return null;
  const restArr = baselinePose.bones?.[joint];
  if (!restArr) return null;
  const usable = targets.filter((t) => specs[t.motion]);
  if (usable.length === 0) return null;

  const target = copyPose(fromPose ?? baselinePose, variantCfg.id);
  const restQ = new THREE.Quaternion(restArr[0], restArr[1], restArr[2], restArr[3]);
  const ctx: BuildCtx = { variantId: variantCfg.id };
  const rwArr = rest?.worldQuats?.[joint];
  const rdArr = rest?.worldDirs?.[joint];
  if (rwArr && rdArr) {
    ctx.restWorldQuat = new THREE.Quaternion(rwArr[0], rwArr[1], rwArr[2], rwArr[3]);
    ctx.restDir = new THREE.Vector3(rdArr[0], rdArr[1], rdArr[2]);
  }
  // The bone's PARENT world orientation at rest = restWorld · restLocal⁻¹. The
  // pelvis needs it to convert a WORLD-frame body euler (the frame its readout
  // decomposes in) into the local delta that realizes it.
  if (ctx.restWorldQuat)
    ctx.parentRestWorldQuat = ctx.restWorldQuat.clone().multiply(restQ.clone().invert());

  let q: THREE.Quaternion;
  if (usable.length === 1) {
    const spec = specs[usable[0]!.motion]!;
    const share = spec.girdle?.(usable[0]!.degrees);
    if (share)
      ctx.girdleWorld = girdleWorldRotation(joint, [share], baselinePose, rest) ?? undefined;
    const delta = spec.buildDelta(usable[0]!.degrees, ctx);
    q = spec.compose === 'parent' ? delta.multiply(restQ) : restQ.clone().multiply(delta);
    target.bones[joint] = [q.x, q.y, q.z, q.w];
    // Digits spread across their phalanges here too — this is the builder the
    // composed-motion pipeline (and gait) uses. See writePhalanges.
    writePhalanges(target, baselinePose, joint, spec, usable[0]!.degrees, ctx, restQ);
    // …and shoulder elevation spreads across the glenohumeral joint and the
    // scapular girdle. See writeGirdle.
    if (share) writeGirdle(target, baselinePose, joint, [share]);
    // …and the cervical pair across both neck segments. See writeCompanions.
    writeCompanions(target, baselinePose, specs, usable, ctx);
    return target;
  } else if (isBallJoint(joint) && ctx.restDir) {
    // Fold flexion/abduction/rotation into one delta (shoulder world / hip canonical).
    const side: 'L' | 'R' = joint.startsWith('R_') ? 'R' : 'L';
    let F = 0, A = 0, R = 0;
    for (const t of usable) {
      if (t.motion.endsWith('Flexion')) F = t.degrees;
      else if (t.motion.endsWith('Abduction')) A = t.degrees;
      else if (t.motion.endsWith('Rotation')) R = t.degrees;
    }
    if (joint.endsWith('UpperArm')) {
      // SCAPULOHUMERAL SPLIT on the composed path too — the humerus receives only
      // the glenohumeral share of EACH plane, and both girdle contributions fold
      // into one clavicle delta. Without this branch a keyframe that commands
      // flexion and abduction together would bypass the split entirely and put
      // the whole elevation back on the humerus.
      const contributions = [
        { motion: 'scapularTilt', degrees: girdleSplit(F, 'flexion').girdle },
        { motion: 'upRotation', degrees: girdleSplit(A, 'abduction').girdle },
      ];
      ctx.girdleWorld =
        girdleWorldRotation(joint, contributions, baselinePose, rest) ?? undefined;
      q = restQ.clone().multiply(composeShoulderDelta(ctx, side, F, A, R));
      target.bones[joint] = [q.x, q.y, q.z, q.w];
      writeGirdle(target, baselinePose, joint, contributions);
      return target;
    }
    q = restQ.clone().multiply(composeHipDelta(side, F, A, R));
  } else if (usable.every((t) => specs[t.motion]!.compose === 'parent')) {
    // Body-frame parent-euler joints: sum the single-axis Euler contributions.
    const e = new THREE.Euler();
    let ex = 0, ey = 0, ez = 0;
    for (const t of usable) {
      e.setFromQuaternion(specs[t.motion]!.buildDelta(t.degrees, ctx), 'YXZ');
      ex += e.x; ey += e.y; ez += e.z;
    }
    q = new THREE.Quaternion().setFromEuler(new THREE.Euler(ex, ey, ez, 'YXZ')).multiply(restQ);
  } else {
    // Mixed rest-frame (e.g. elbow flexion + forearm rotation): compose in order.
    q = restQ.clone();
    for (const t of usable) q.multiply(specs[t.motion]!.buildDelta(t.degrees, ctx));
  }
  target.bones[joint] = [q.x, q.y, q.z, q.w];
  writeCompanions(target, baselinePose, specs, usable, ctx);
  return target;
}

/**
 * Read the MEASURED angle for a commanded joint/motion out of a
 * `computeJointAngles` report, mapped into the registry's clinical
 * convention (so it compares directly against `targetDegrees`). Returns
 * undefined when the report has no such joint/field.
 */
export function measureCommandMotion(
  report: JointAngleReport,
  joint: string,
  motion: string,
): number | undefined {
  const value = report.joints?.[joint]?.[motion];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const spec = SUPPORTED_MOTIONS[joint]?.[motion];
  return spec ? spec.fromReport(value) : value;
}

/**
 * Compose the final outcome for a resolved command: the resolution's status
 * metadata plus the MEASURED achieved angle (when the stage provides one)
 * and the painful-arc flag re-evaluated against that measured angle.
 */
export function finalizeOutcome(
  resolved: ResolvedCommandTarget,
  achievedDegrees?: number,
  constraints?: RomScenarioConstraints | null,
): ExamMovementOutcome {
  const outcome: ExamMovementOutcome = { status: resolved.status };
  if (resolved.joint != null) outcome.joint = resolved.joint;
  if (resolved.motion != null) outcome.motion = resolved.motion;
  if (resolved.requestedDegrees != null) outcome.requestedDegrees = resolved.requestedDegrees;
  if (resolved.limitedBy != null) outcome.limitedBy = resolved.limitedBy;
  if (resolved.reason != null) outcome.reason = resolved.reason;

  const achieved = achievedDegrees ?? resolved.clampedDegrees;
  if (achieved != null) {
    outcome.achievedDegrees = achieved;
    if (resolved.joint && resolved.motion) {
      outcome.painful = isInRomPainfulArc(
        achieved,
        getRomFieldConstraint(constraints, resolved.joint, resolved.motion),
      );
    }
  } else if (resolved.painful != null) {
    outcome.painful = resolved.painful;
  }
  return outcome;
}
