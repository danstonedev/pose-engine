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
import type { JointAngleReport } from './jointAngles';
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
 *  rest long axis (0,−1,0) toward −Z by `deg` about the medio-lateral axis,
 *  no twist. On the real rig −Z is POSTERIOR (the toes point +Z), so callers
 *  pick the anatomic direction by sign — the knee passes −deg. The canonical delta relates rest→current
 *  WORLD orientation (`currentWorld = restWorld · delta`), so the world
 *  direction of the swing is guaranteed regardless of how the GLB binds the
 *  bone-local frame — the thigh/clavicle local frames on the CC rig are
 *  twisted, which is why a parent-local construction moves the limb in the
 *  wrong world direction even while the parent-local readout looks right. */
function ballFlexDelta(deg: number): THREE.Quaternion {
  const f = deg * RAD;
  const swung = new THREE.Vector3(0, -Math.cos(f), -Math.sin(f));
  return new THREE.Quaternion().setFromUnitVectors(REST_DOWN, swung);
}

interface SupportedMotionSpec {
  /** Delta quaternion realizing a clinical target (deg, registry
   *  convention) from the anatomic-rest local quaternion. */
  buildDelta(clinicalDeg: number): THREE.Quaternion;
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
 *    (v1.2 field fix): the rig's anterior is +Z — the toes point +Z, pinned
 *    convention-free by the trunk calibration — so the raw ballFlexDelta
 *    swing toward −Z is what anatomic knee flexion needs, and the original
 *    un-negated spec shipped a front-kick (founder field report). The
 *    direction test now derives anterior from the toes themselves instead
 *    of assuming a world facing. With the corrected direction the geometric
 *    hinge readout signs anatomic flexion POSITIVE, so `fromReport` is
 *    identity.
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
 *  SHOULDER FLEXION (L/R_UpperArm.shoulderFlexion) remains deliberately NOT
 *  shipped: true forward flexion rotates about the clavicle-Y axis, which IS the
 *  swing-twist readout's long axis (0,−1,0) — so any world-correct raise is
 *  measured as pure `shoulderRotation`, and any readout-clean construction barely
 *  lifts the arm (≈41° world elevation for a commanded 90°). No single-axis
 *  construction is both world-correct and self-consistent; it needs a 2-axis
 *  build plus a world-frame readout redefinition. Shipping it would corrupt
 *  grading, so it refuses with 'unsupported-motion' until the readout is
 *  redefined (same workstream as enabling the ROM clamp in browsers). */
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
  // Shoulder abduction (v1.3): parent-frame Z-euler; readout mirrors on the right.
  const shoulderAbdL: SupportedMotionSpec = {
    buildDelta: (deg) => eulerZDelta(deg),
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  const shoulderAbdR: SupportedMotionSpec = {
    buildDelta: (deg) => eulerZDelta(-deg),
    compose: 'parent',
    fromReport: (deg) => deg,
  };
  return {
    L_Foot: { ankleFlexion: ankle },
    R_Foot: { ankleFlexion: ankle },
    L_Leg: { kneeFlexion: knee },
    R_Leg: { kneeFlexion: knee },
    L_UpLeg: { hipFlexion: hip },
    R_UpLeg: { hipFlexion: hip },
    L_Forearm: { elbowFlexion: elbow },
    R_Forearm: { elbowFlexion: elbow },
    Spine_Lower: { flexion: lumbar, lateralTilt: lumbarLateral, rotation: lumbarRotation },
    Neck: { flexion: cervicalFlex, rotation: cervicalRotation, lateralTilt: cervicalLateral },
    L_UpperArm: { shoulderAbduction: shoulderAbdL },
    R_UpperArm: { shoulderAbduction: shoulderAbdR },
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
  const delta = spec.buildDelta(clampedDegrees);
  const q =
    spec.compose === 'parent'
      ? delta.multiply(restQ) // parent-frame: delta × rest
      : restQ.clone().multiply(delta); // rest-frame: rest × delta
  target.bones[cmd.joint] = [q.x, q.y, q.z, q.w];
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
