export const DEFAULT_SHOULDER_PROXY_BUDGET_DEG = 120;
export const SHOULDER_COMPLEX_CAPABILITY = Object.freeze({
    kind: 'girdle-proxy',
    version: 1,
    thoraxLabel: 'Rest-relative arm elevation in live thorax frame',
    proxyLabel: 'Arm elevation relative to girdle proxy',
    independentAnatomicalJoints: false,
});
const DEG = 180 / Math.PI;
// Numerical degeneracy guards, not clinical acceptance or ROM tolerances.
const DIRECTION_EPS = 1e-7;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
const inverse = (q) => [-q[0], -q[1], -q[2], q[3]];
function multiply(a, b) {
    const [x, y, z, w] = a, [u, v, t, s] = b;
    return [w * u + x * s + y * t - z * v, w * v - x * t + y * s + z * u,
        w * t + x * v - y * u + z * s, w * s - x * u - y * v - z * t];
}
function rotate(v, q) {
    const out = multiply(multiply(q, [v[0], v[1], v[2], 0]), inverse(q));
    return [out[0], out[1], out[2]];
}
const empty = () => ({ armDirection: null, restArmDirection: null,
    elevationDeg: null, planeOfElevationDeg: null, restAxisTwistDeg: null,
    valid: { elevation: false, plane: false, twist: false } });
/** Pure finite-data inspection. Inputs are read only and may be incomplete;
 * missing/invalid measurements return null plus a diagnostic, never NaN. */
export function inspectShoulderComplex(input) {
    const diagnostics = [];
    const note = (code, field) => diagnostics.push({ code, field });
    function vector(value, field) {
        if (value == null) {
            note(field.startsWith('rest.') ? 'missing-reference' : 'missing-current', field);
            return null;
        }
        if (value.length !== 3 || !Array.from(value).every(Number.isFinite)) {
            note('non-finite-input', field);
            return null;
        }
        const magnitude = Math.max(...value.map(Math.abs));
        if (magnitude === 0) {
            note('zero-length-direction', field);
            return null;
        }
        const scaled = value.map(n => n / magnitude);
        return scale(scaled, 1 / Math.hypot(...scaled));
    }
    function quaternion(value, field) {
        if (value == null) {
            note(field.startsWith('rest.') ? 'missing-reference' : 'missing-current', field);
            return null;
        }
        if (value.length !== 4 || !Array.from(value).every(Number.isFinite)) {
            note('non-finite-input', field);
            return null;
        }
        const magnitude = Math.max(...value.map(Math.abs));
        if (magnitude === 0) {
            note('invalid-quaternion', field);
            return null;
        }
        const scaled = value.map(n => n / magnitude);
        const length = Math.hypot(...scaled);
        return scaled.map(n => n / length);
    }
    const currentDir = vector(input.current?.armWorldDirection, 'current.armWorldDirection');
    const restDir = vector(input.rest?.armWorldDirection, 'rest.armWorldDirection');
    const currentArm = quaternion(input.current?.armWorldQuaternion, 'current.armWorldQuaternion');
    const restArm = quaternion(input.rest?.armWorldQuaternion, 'rest.armWorldQuaternion');
    const anterior = vector(input.restAnteriorWorld ?? [0, 0, 1], 'rest.anteriorWorld');
    function inspect(frameKey, label) {
        const result = empty();
        const currentFrame = quaternion(input.current?.[frameKey], 'current.' + frameKey);
        const restFrame = quaternion(input.rest?.[frameKey], 'rest.' + frameKey);
        if (!currentFrame || !restFrame || !currentDir || !restDir)
            return result;
        const now = rotate(currentDir, inverse(currentFrame));
        const zero = rotate(restDir, inverse(restFrame));
        const cosine = Math.max(-1, Math.min(1, dot(zero, now)));
        const swingAxis = cross(zero, now);
        const sine = Math.hypot(...swingAxis);
        result.armDirection = now;
        result.restArmDirection = zero;
        // atan2 is stable near both zero and pi, where acos amplifies roundoff.
        result.elevationDeg = Math.atan2(sine, cosine) * DEG;
        result.valid.elevation = true;
        if (anterior) {
            const rawForward = rotate(anterior, inverse(restFrame));
            const along = dot(rawForward, zero);
            const tangent = [rawForward[0] - along * zero[0], rawForward[1] - along * zero[1], rawForward[2] - along * zero[2]];
            const length = Math.hypot(...tangent);
            if (length < DIRECTION_EPS)
                note('plane-reference-degenerate', label);
            else if (sine < DIRECTION_EPS)
                note('plane-singularity', label);
            else {
                const forward = scale(tangent, 1 / length);
                const outward = scale(cross(forward, zero), input.side === 'L' ? 1 : -1);
                result.planeOfElevationDeg = Math.atan2(dot(now, outward), dot(now, forward)) * DEG;
                result.valid.plane = true;
            }
        }
        if (cosine < 0 && sine < DIRECTION_EPS)
            note('antiparallel-twist', label);
        else if (currentArm && restArm) {
            const currentRelative = multiply(inverse(currentFrame), currentArm);
            const restRelative = multiply(inverse(restFrame), restArm);
            const delta = multiply(currentRelative, inverse(restRelative));
            const swingLength = Math.hypot(...swingAxis, 1 + cosine);
            const swing = sine < DIRECTION_EPS ? [0, 0, 0, 1]
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
    if (budgetDeg === null)
        note('invalid-capacity', 'proxyElevationBudgetDeg');
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
