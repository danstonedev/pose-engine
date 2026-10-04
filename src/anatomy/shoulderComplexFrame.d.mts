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
export type ShoulderComplexDiagnosticCode = 'missing-current' | 'missing-reference' | 'non-finite-input' | 'zero-length-direction' | 'invalid-quaternion' | 'invalid-capacity' | 'plane-reference-degenerate' | 'plane-singularity' | 'antiparallel-twist';
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
    valid: {
        elevation: boolean;
        plane: boolean;
        twist: boolean;
    };
}
export declare const DEFAULT_SHOULDER_PROXY_BUDGET_DEG = 120;
export declare const SHOULDER_COMPLEX_CAPABILITY: Readonly<{
    kind: "girdle-proxy";
    version: 1;
    thoraxLabel: "Rest-relative arm elevation in live thorax frame";
    proxyLabel: "Arm elevation relative to girdle proxy";
    independentAnatomicalJoints: false;
}>;
export interface ShoulderComplexInspection {
    capability: typeof SHOULDER_COMPLEX_CAPABILITY;
    /** Complete means both directional elevations are available. Normal plane/
     * twist singularities remain explicit and do not invalidate the direction. */
    status: 'complete' | 'partial' | 'unavailable';
    thorax: ShoulderRelativeMeasurement;
    girdleProxy: ShoulderRelativeMeasurement;
    capacity: {
        /** Runtime policy; absent for standalone pure inspection. */
        enforced?: boolean;
        basis: 'engineering-girdle-proxy';
        budgetDeg: number | null;
        marginDeg: number | null;
        excessDeg: number | null;
        withinBudget: boolean | null;
    };
    diagnostics: ShoulderComplexDiagnostic[];
    /** Geometric hand-to-latched-support residual after final projection. Not a force. */
    supportResidualM?: number;
}
/** Pure finite-data inspection. Inputs are read only and may be incomplete;
 * missing/invalid measurements return null plus a diagnostic, never NaN. */
export declare function inspectShoulderComplex(input: ShoulderComplexInput): ShoulderComplexInspection;
