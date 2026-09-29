/** Frame-relative shoulder inspection for the existing single girdle proxy.
 * This inspects a pose; it never changes commands, joints or legacy readouts.
 * Directions must use the calibrated humeral long axis (e.g. shoulder to elbow),
 * not an assumed bone-local -Y. No measured quantity here is anatomical GH/SC/AC/ST.
 */
export type ShoulderVector3 = readonly [number, number, number];
export type ShoulderQuaternion = readonly [number, number, number, number];

export interface ShoulderComplexFrame {
  armWorldDirection?: ShoulderVector3 | null;
  armWorldQuaternion?: ShoulderQuaternion | null;
  thoraxWorldQuaternion?: ShoulderQuaternion | null;
  girdleWorldQuaternion?: ShoulderQuaternion | null;
}

export interface ShoulderComplexInput {
  side: 'L' | 'R';
  current?: ShoulderComplexFrame | null;
  rest?: ShoulderComplexFrame | null;
  /** Anterior direction at reference capture. +Z assumes the usual anatomic
   * world frame; callers with a rotated reference must provide its anterior. */
  restAnteriorWorld?: ShoulderVector3;
  /** Existing engineering budget, not an independently calibrated patient limit.
   * Omit to inspect against the current 120-degree model budget. */
  proxyElevationBudgetDeg?: number;
}

export type ShoulderComplexDiagnosticCode =
  | 'missing-current' | 'missing-reference' | 'non-finite-input'
  | 'zero-length-direction' | 'invalid-quaternion' | 'invalid-capacity'
  | 'plane-reference-degenerate' | 'plane-singularity' | 'antiparallel-twist';
export interface ShoulderComplexDiagnostic {
  code: ShoulderComplexDiagnosticCode;
  field: string;
}

export interface ShoulderRelativeMeasurement {
  armDirection: ShoulderVector3 | null;
  restArmDirection: ShoulderVector3 | null;
  /** Unsigned angle between actual current/rest long axes in corresponding
   * parent frames. Axial rotation alone does not consume this capacity. */
  elevationDeg: number | null;
  /** 0 = anterior; +90 = outward for the selected side. Null at a degenerate
   * projection or when the anterior reference cannot define a tangent axis. */
  planeOfElevationDeg: number | null;
  /** Signed right-handed twist about the REST arm axis, after removing the
   * shortest rest-to-current swing, in [-180, 180). No clinical side sign flip.
   * Null for antiparallel axes: their shortest swing has no unique axis. */
  restAxisTwistDeg: number | null;
  valid: { elevation: boolean; plane: boolean; twist: boolean };
}

export const DEFAULT_SHOULDER_PROXY_BUDGET_DEG = 120;
export const SHOULDER_COMPLEX_CAPABILITY = Object.freeze({
  kind: 'girdle-proxy' as const,
  version: 1 as const,
  thoraxLabel: 'Rest-relative arm elevation in live thorax frame',
  proxyLabel: 'Arm elevation relative to girdle proxy',
  independentAnatomicalJoints: false as const,
});

export interface ShoulderComplexInspection {
  capability: typeof SHOULDER_COMPLEX_CAPABILITY;
  /** Complete means both directional elevations are available. Normal plane/
   * twist singularities remain explicit and do not invalidate the direction. */
  status: 'complete' | 'partial' | 'unavailable';
  thorax: ShoulderRelativeMeasurement;
  girdleProxy: ShoulderRelativeMeasurement;
  capacity: {
    basis: 'engineering-girdle-proxy';
    budgetDeg: number | null;
    marginDeg: number | null;
    excessDeg: number | null;
    withinBudget: boolean | null;
  };
  diagnostics: ShoulderComplexDiagnostic[];
}

const DEG = 180 / Math.PI;
// Numerical degeneracy guards, not clinical acceptance or ROM tolerances.
const DIRECTION_EPS = 1e-7;
type V = [number, number, number];
type Q = [number, number, number, number];
const dot = (a: ShoulderVector3, b: ShoulderVector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ShoulderVector3, b: ShoulderVector3): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: ShoulderVector3, n: number): V => [a[0] * n, a[1] * n, a[2] * n];
const inverse = (q: ShoulderQuaternion): Q => [-q[0], -q[1], -q[2], q[3]];
function multiply(a: ShoulderQuaternion, b: ShoulderQuaternion): Q {
  const [x, y, z, w] = a, [u, v, t, s] = b;
  return [w * u + x * s + y * t - z * v, w * v - x * t + y * s + z * u,
    w * t + x * v - y * u + z * s, w * s - x * u - y * v - z * t];
}
function rotate(v: ShoulderVector3, q: ShoulderQuaternion): V {
  const out = multiply(multiply(q, [v[0], v[1], v[2], 0]), inverse(q));
  return [out[0], out[1], out[2]];
}
const empty = (): ShoulderRelativeMeasurement => ({ armDirection: null, restArmDirection: null,
  elevationDeg: null, planeOfElevationDeg: null, restAxisTwistDeg: null,
  valid: { elevation: false, plane: false, twist: false } });

/** Pure finite-data inspection. Inputs are read only and may be incomplete;
 * missing/invalid measurements return null plus a diagnostic, never NaN. */
export function inspectShoulderComplex(input: ShoulderComplexInput): ShoulderComplexInspection {
  const diagnostics: ShoulderComplexDiagnostic[] = [];
  const note = (code: ShoulderComplexDiagnosticCode, field: string) => diagnostics.push({ code, field });
  function vector(value: ShoulderVector3 | null | undefined, field: string): V | null {
    if (value == null) { note(field.startsWith('rest.') ? 'missing-reference' : 'missing-current', field); return null; }
    if (value.length !== 3 || !Array.from(value).every(Number.isFinite)) { note('non-finite-input', field); return null; }
    const magnitude = Math.max(...value.map(Math.abs));
    if (magnitude === 0) { note('zero-length-direction', field); return null; }
    const scaled = value.map(n => n / magnitude) as V;
    return scale(scaled, 1 / Math.hypot(...scaled));
  }
  function quaternion(value: ShoulderQuaternion | null | undefined, field: string): Q | null {
    if (value == null) { note(field.startsWith('rest.') ? 'missing-reference' : 'missing-current', field); return null; }
    if (value.length !== 4 || !Array.from(value).every(Number.isFinite)) { note('non-finite-input', field); return null; }
    const magnitude = Math.max(...value.map(Math.abs));
    if (magnitude === 0) { note('invalid-quaternion', field); return null; }
    const scaled = value.map(n => n / magnitude) as Q;
    const length = Math.hypot(...scaled);
    return scaled.map(n => n / length) as Q;
  }
  const currentDir = vector(input.current?.armWorldDirection, 'current.armWorldDirection');
  const restDir = vector(input.rest?.armWorldDirection, 'rest.armWorldDirection');
  const currentArm = quaternion(input.current?.armWorldQuaternion, 'current.armWorldQuaternion');
  const restArm = quaternion(input.rest?.armWorldQuaternion, 'rest.armWorldQuaternion');
  const anterior = vector(input.restAnteriorWorld ?? [0, 0, 1], 'rest.anteriorWorld');
  function inspect(frameKey: 'thoraxWorldQuaternion' | 'girdleWorldQuaternion', label: string): ShoulderRelativeMeasurement {
    const result = empty();
    const currentFrame = quaternion(input.current?.[frameKey], 'current.' + frameKey);
    const restFrame = quaternion(input.rest?.[frameKey], 'rest.' + frameKey);
    if (!currentFrame || !restFrame || !currentDir || !restDir) return result;
    const now = rotate(currentDir, inverse(currentFrame));
    const zero = rotate(restDir, inverse(restFrame));
    const cosine = Math.max(-1, Math.min(1, dot(zero, now)));
    const swingAxis = cross(zero, now);
    const sine = Math.hypot(...swingAxis);
    result.armDirection = now; result.restArmDirection = zero;
    // atan2 is stable near both zero and pi, where acos amplifies roundoff.
    result.elevationDeg = Math.atan2(sine, cosine) * DEG;
    result.valid.elevation = true;
    if (anterior) {
      const rawForward = rotate(anterior, inverse(restFrame));
      const along = dot(rawForward, zero);
      const tangent: V = [rawForward[0] - along * zero[0], rawForward[1] - along * zero[1], rawForward[2] - along * zero[2]];
      const length = Math.hypot(...tangent);
      if (length < DIRECTION_EPS) note('plane-reference-degenerate', label);
      else if (sine < DIRECTION_EPS) note('plane-singularity', label);
      else {
        const forward = scale(tangent, 1 / length);
        const outward = scale(cross(forward, zero), input.side === 'L' ? 1 : -1);
        result.planeOfElevationDeg = Math.atan2(dot(now, outward), dot(now, forward)) * DEG;
        result.valid.plane = true;
      }
    }
    if (cosine < 0 && sine < DIRECTION_EPS) note('antiparallel-twist', label);
    else if (currentArm && restArm) {
      const currentRelative = multiply(inverse(currentFrame), currentArm);
      const restRelative = multiply(inverse(restFrame), restArm);
      const delta = multiply(currentRelative, inverse(restRelative));
      const swingLength = Math.hypot(...swingAxis, 1 + cosine);
      const swing: Q = sine < DIRECTION_EPS ? [0, 0, 0, 1]
        : [swingAxis[0] / swingLength, swingAxis[1] / swingLength, swingAxis[2] / swingLength, (1 + cosine) / swingLength];
      const residual = multiply(inverse(swing), delta);
      const axial = residual[0] * zero[0] + residual[1] * zero[1] + residual[2] * zero[2];
      const degrees = 2 * Math.atan2(axial, residual[3]) * DEG;
      result.restAxisTwistDeg = ((degrees + 180) % 360 + 360) % 360 - 180;
      result.valid.twist = true;
    }
    return result;
  }
  const thorax = inspect('thoraxWorldQuaternion', 'thorax');
  const girdleProxy = inspect('girdleWorldQuaternion', 'girdleProxy');
  const requestedBudget = input.proxyElevationBudgetDeg ?? DEFAULT_SHOULDER_PROXY_BUDGET_DEG;
  const budgetDeg = Number.isFinite(requestedBudget) && requestedBudget >= 0 && requestedBudget <= 180 ? requestedBudget : null;
  if (budgetDeg === null) note('invalid-capacity', 'proxyElevationBudgetDeg');
  const marginDeg = budgetDeg !== null && girdleProxy.elevationDeg !== null ? budgetDeg - girdleProxy.elevationDeg : null;
  return {
    capability: SHOULDER_COMPLEX_CAPABILITY,
    status: thorax.valid.elevation && girdleProxy.valid.elevation ? 'complete'
      : thorax.valid.elevation || girdleProxy.valid.elevation ? 'partial' : 'unavailable',
    thorax, girdleProxy,
    capacity: { basis: 'engineering-girdle-proxy', budgetDeg, marginDeg,
      excessDeg: marginDeg === null ? null : Math.max(0, -marginDeg),
      withinBudget: marginDeg === null ? null : marginDeg >= -1e-8 },
    diagnostics,
  };
}
