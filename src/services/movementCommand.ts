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
 * the effective range (normative ∩ active scenario constraint). Pure: reads
 * the module-level scenario-constraint store installed via
 * `setRomScenarioConstraints`, writes nothing.
 *
 * `variantCfg` is accepted for forward-compat (per-variant vocabularies);
 * v1 validates against the variant-independent registry.
 */
export function resolveCommandTarget(
  cmd: ExamMovementCommand,
  _variantCfg?: BodyVariantConfig,
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

  const constraint = getRomFieldConstraint(joint, motion);
  const effective = resolveAvailableRange(fieldDef.range, constraint);
  const clamped = Math.max(effective.min, Math.min(effective.max, requested));

  // Which layer owns the binding bound (for `limitedBy`)? Scenario when the
  // effective bound is tighter than the normative bound on that side.
  let limitedBy: ExamMovementLimiter | undefined;
  if (requested > effective.max + 1e-9) {
    limitedBy = effective.max < fieldDef.range.max - 1e-9 ? 'scenario-constraint' : 'normative-rom';
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
  return ctx.restWorldQuat.clone().invert().multiply(worldSwing).multiply(ctx.restWorldQuat);
}

/** Build context a few specs need beyond the rest local quaternion: the body
 *  variant (finger fits are variant-keyed) and — when the caller supplies the
 *  rest reference — the commanded bone's rest WORLD orientation + world long
 *  axis (shoulder elevation builds a world-plane swing from them). */
interface BuildCtx {
  variantId?: string;
  restWorldQuat?: THREE.Quaternion;
  restDir?: THREE.Vector3;
}

interface SupportedMotionSpec {
  /** Delta quaternion realizing a clinical target (deg, registry
   *  convention) from the anatomic-rest local quaternion. `ctx` is provided
   *  only when buildCommandPose has the rest reference; specs that need it
   *  (shoulder elevation) return the identity delta without it. */
  buildDelta(clinicalDeg: number, ctx?: BuildCtx): THREE.Quaternion;
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
  const cervicalFlex: SupportedMotionSpec = {
    buildDelta: (deg) => eulerXDelta(deg),
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
  const SHOULDER_FLEX_SIGN = -1; // +deg flexion = forward (anterior)
  const SHOULDER_ABD_SIGN = 1; // +deg abduction = away from midline (L); R mirrors
  const shoulderFlex: SupportedMotionSpec = {
    buildDelta: (deg, ctx) => armSwingDelta(ctx, WORLD_X, SHOULDER_FLEX_SIGN * deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  const shoulderAbdL: SupportedMotionSpec = {
    buildDelta: (deg, ctx) => armSwingDelta(ctx, WORLD_Z, SHOULDER_ABD_SIGN * deg),
    compose: 'rest',
    fromReport: (deg) => deg,
  };
  const shoulderAbdR: SupportedMotionSpec = {
    buildDelta: (deg, ctx) => armSwingDelta(ctx, WORLD_Z, -SHOULDER_ABD_SIGN * deg),
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
  // FINGERS / THUMB: composite MCP+PIP curl about the pinned local-Z ring. The
  // readback is ABSOLUTE-geometric (not rest-relative), so it carries a per-digit
  // slope+offset (linear fit on the flexion branch). buildDelta PRE-COMPENSATES
  // (inverts the fit) so commanded == measured across the usable range; fromReport is
  // identity. sideSign L −1 / R +1 curls the fingertip toward the palm. Usable to
  // ~110° (single MCP bone; the full 160° would also drive the PIP child).
  // The fits are VARIANT-KEYED: the slopes are shared rig geometry, but the
  // OFFSETS are each hand's rest MCP posture, which differs male vs female
  // (rig-verified on both GLBs; L and R are bit-identical per variant).
  const FINGER_FIT: Record<string, Record<string, { slope: number; offset: number }>> = {
    male: {
      Thumb1: { slope: 0.99, offset: 11.5 },
      Index1: { slope: 0.93, offset: 14 },
      Mid1: { slope: 1.0, offset: 6 },
      Ring1: { slope: 0.99, offset: 3 },
      Pinky1: { slope: 0.91, offset: 4 },
    },
    female: {
      Thumb1: { slope: 1.0, offset: 15.2 },
      Index1: { slope: 0.93, offset: 9.8 },
      Mid1: { slope: 1.0, offset: 3.5 },
      Ring1: { slope: 0.99, offset: 1.7 },
      Pinky1: { slope: 0.93, offset: 7.9 },
    },
  };
  const makeFinger = (sideSign: number, digit: string): SupportedMotionSpec => ({
    buildDelta: (deg, ctx) => {
      const variant = FINGER_FIT[ctx?.variantId ?? 'male'] ?? FINGER_FIT.male!;
      const fit = variant[digit] ?? FINGER_FIT.male![digit]!;
      return new THREE.Quaternion().setFromAxisAngle(
        LOCAL_Z,
        ((sideSign * (deg - fit.offset)) / fit.slope) * RAD,
      );
    },
    compose: 'rest',
    fromReport: (deg) => deg,
  });
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
    Spine_Lower: { flexion: lumbar, lateralTilt: lumbarLateral, rotation: lumbarRotation },
    Spine_Upper: { flexion: thoracicFlex, lateralTilt: thoracicLateral, rotation: thoracicRotation },
    Neck: { flexion: cervicalFlex, rotation: cervicalRotation, lateralTilt: cervicalLateral },
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
  const delta = spec.buildDelta(clampedDegrees, ctx);
  const q =
    spec.compose === 'parent'
      ? delta.multiply(restQ) // parent-frame: delta × rest
      : restQ.clone().multiply(delta); // rest-frame: rest × delta
  target.bones[cmd.joint] = [q.x, q.y, q.z, q.w];
  return target;
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
  return delta.multiply(new THREE.Quaternion().setFromAxisAngle(REST_DOWN, twSign * R * RAD));
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

  let q: THREE.Quaternion;
  if (usable.length === 1) {
    const spec = specs[usable[0]!.motion]!;
    const delta = spec.buildDelta(usable[0]!.degrees, ctx);
    q = spec.compose === 'parent' ? delta.multiply(restQ) : restQ.clone().multiply(delta);
  } else if (isBallJoint(joint) && ctx.restDir) {
    // Fold flexion/abduction/rotation into one delta (shoulder world / hip canonical).
    const side: 'L' | 'R' = joint.startsWith('R_') ? 'R' : 'L';
    let F = 0, A = 0, R = 0;
    for (const t of usable) {
      if (t.motion.endsWith('Flexion')) F = t.degrees;
      else if (t.motion.endsWith('Abduction')) A = t.degrees;
      else if (t.motion.endsWith('Rotation')) R = t.degrees;
    }
    const delta = joint.endsWith('UpperArm')
      ? composeShoulderDelta(ctx, side, F, A, R)
      : composeHipDelta(side, F, A, R);
    q = restQ.clone().multiply(delta);
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
        getRomFieldConstraint(resolved.joint, resolved.motion),
      );
    }
  } else if (resolved.painful != null) {
    outcome.painful = resolved.painful;
  }
  return outcome;
}
