import { Quaternion, Vector3, type Bone } from 'three';
import type { JointAngleRestReference } from './jointAngles';
import type { RomScenarioConstraints } from './romConstraints';
import { DEFAULT_SHOULDER_PROXY_BUDGET_DEG, inspectShoulderComplex,
  type ShoulderComplexFrame, type ShoulderComplexInspection } from './shoulderComplex';

export type ShoulderInspections = Record<'L' | 'R', ShoulderComplexInspection>;

/** Restore the recorded engineering policy without treating legacy frames as
 * constrained. Clinical scenario bounds remain owned by the current host. */
export function recordedShoulderConstraints(shoulders?: ShoulderInspections): RomScenarioConstraints | null {
  const result: RomScenarioConstraints = {};
  for (const side of ['L', 'R'] as const) {
    const capacity = shoulders?.[side].capacity;
    if (capacity?.enforced && capacity.budgetDeg !== null)
      result[`${side}_UpperArm`] = { girdleProxyElevation: { availableRange: { max: capacity.budgetDeg } } };
  }
  return Object.keys(result).length ? result : null;
}

export function attachShoulderSupportResiduals(shoulders: ShoulderInspections | undefined,
  bones: ReadonlyMap<string, Bone>, contacts: readonly { bone: string; target: Vector3 | null }[]): void {
  if (!shoulders) return;
  for (const contact of contacts) if (contact.target) {
    const hand = bones.get(contact.bone);
    if (hand) shoulders[contact.bone.startsWith('R_') ? 'R' : 'L'].supportResidualM
      = hand.getWorldPosition(new Vector3()).distanceTo(contact.target);
  }
}

export function shoulderConstraintsForPolicy(policy: 'legacy' | 'enforce-proxy' | undefined,
  constraints?: RomScenarioConstraints | null): RomScenarioConstraints | null | undefined {
  if (policy !== 'enforce-proxy') return constraints;
  const result = structuredClone(constraints ?? {});
  for (const side of ['L', 'R']) {
    const key = `${side}_UpperArm`;
    result[key] ??= {};
    result[key].girdleProxyElevation ??= {};
    result[key].girdleProxyElevation.availableRange ??= {};
    result[key].girdleProxyElevation.availableRange.max ??= DEFAULT_SHOULDER_PROXY_BUDGET_DEG;
  }
  return result;
}

/** This optional constraint is an engineering limit on the current girdle
 * proxy, separate from the registry's projected shoulder ROM fields. Its
 * absence retains legacy motion. Supplying max opts into enforcement; only
 * finite values in [0, 120] are accepted. Invalid settings fail closed. */
export function shoulderProxyCapacity(constraints: RomScenarioConstraints | null | undefined, side: 'L' | 'R') {
  const configured = constraints?.[`${side}_UpperArm`]?.girdleProxyElevation?.availableRange?.max;
  return configured === undefined ? { enforced: false, budgetDeg: DEFAULT_SHOULDER_PROXY_BUDGET_DEG }
    : { enforced: true, budgetDeg: Number.isFinite(configured)
      ? Math.max(0, Math.min(DEFAULT_SHOULDER_PROXY_BUDGET_DEG, configured)) : 0 };
}

export function captureShoulderFrames(bones: ReadonlyMap<string, Bone>): Record<'L' | 'R', ShoulderComplexFrame> {
  const frame = (side: 'L' | 'R'): ShoulderComplexFrame => {
    const arm = bones.get(`${side}_UpperArm`), elbow = bones.get(`${side}_Forearm`), girdle = bones.get(`${side}_Shoulder`);
    return {
      armWorldDirection: arm && elbow ? elbow.getWorldPosition(new Vector3()).sub(arm.getWorldPosition(new Vector3())).toArray() : null,
      armWorldQuaternion: arm?.getWorldQuaternion(new Quaternion()).toArray(),
      girdleWorldQuaternion: girdle?.getWorldQuaternion(new Quaternion()).toArray(),
      thoraxWorldQuaternion: girdle?.parent?.getWorldQuaternion(new Quaternion()).toArray(),
    };
  };
  return { L: frame('L'), R: frame('R') };
}

export function inspectRigShoulders(bones: ReadonlyMap<string, Bone>, rest: JointAngleRestReference,
  constraints?: RomScenarioConstraints | null): ShoulderInspections {
  const current = captureShoulderFrames(bones);
  const inspect = (side: 'L' | 'R') => {
    const policy = shoulderProxyCapacity(constraints, side);
    const result = inspectShoulderComplex({ side, current: current[side],
    // Captured once at anatomic rest. Root/pelvis readout adjustments must not
    // rewrite this reference: the inspector already removes live parent motion.
    rest: rest.shoulderFrames?.[side], proxyElevationBudgetDeg: policy.budgetDeg });
    result.capacity.enforced = policy.enforced;
    return result;
  };
  return { L: inspect('L'), R: inspect('R') };
}

/** Project the arm's LOCAL swing into its rest cone, preserving axial twist.
 * This changes neither the explicitly authored girdle nor any distal locals.
 * A shortest swing is ambiguous at exactly 180 degrees; choose the stable
 * quaternion arc supplied by the pose instead of inventing a clinical plane. */
export function projectShoulderProxyLocal(current: Quaternion, key: string, rest: JointAngleRestReference,
  budgetDeg: number): Quaternion | null {
  const local = rest.localQuats[key], world = rest.worldQuats[key], dir = rest.worldDirs?.[key];
  if (!local || !world || !dir || !Number.isFinite(budgetDeg)) return null;
  if (![...current.toArray(), ...local, ...world, ...dir].every(Number.isFinite)
    || current.lengthSq() < 1e-16 || Math.hypot(...local) < 1e-8 || Math.hypot(...world) < 1e-8) return null;
  const zeroQ = new Quaternion().fromArray(local);
  const localAxis = new Vector3().fromArray(dir).applyQuaternion(new Quaternion().fromArray(world).invert()).normalize();
  if (localAxis.lengthSq() < 1e-12) return null;
  const zero = localAxis.clone().applyQuaternion(zeroQ), now = localAxis.clone().applyQuaternion(current);
  const elevation = zero.angleTo(now), limit = Math.max(0, Math.min(180, budgetDeg)) * Math.PI / 180;
  if (elevation <= limit + 1e-10) return current.clone();
  const delta = current.clone().multiply(zeroQ.clone().invert());
  const axial = delta.x * zero.x + delta.y * zero.y + delta.z * zero.z;
  const twist = new Quaternion(zero.x * axial, zero.y * axial, zero.z * axial, delta.w);
  if (twist.lengthSq() < 1e-16) twist.identity(); else twist.normalize();
  const swing = delta.clone().multiply(twist.clone().invert()).normalize();
  if (swing.w < 0) swing.set(-swing.x, -swing.y, -swing.z, -swing.w);
  return new Quaternion().slerp(swing, limit / elevation).multiply(twist).multiply(zeroQ).normalize();
}
