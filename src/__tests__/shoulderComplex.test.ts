import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { inspectShoulderComplex, type ShoulderComplexInput, type ShoulderComplexFrame,
  type ShoulderQuaternion, type ShoulderVector3 } from '../services/shoulderComplex';

const down = new THREE.Vector3(0, -1, 0);
const q = (axis: THREE.Vector3, degrees: number) => new THREE.Quaternion().setFromAxisAngle(axis, degrees * Math.PI / 180);
const identity: ShoulderQuaternion = [0, 0, 0, 1];
const rest: ShoulderComplexFrame = { armWorldDirection: [0, -1, 0], armWorldQuaternion: identity,
  thoraxWorldQuaternion: identity, girdleWorldQuaternion: identity };
function input(flex: number, girdle = 0, twist = 0): ShoulderComplexInput {
  const proxy = q(new THREE.Vector3(-1, 0, 0), girdle);
  const arm = proxy.clone().multiply(q(new THREE.Vector3(-1, 0, 0), flex))
    .multiply(q(down, twist));
  return { side: 'L', rest, current: { armWorldDirection: down.clone().applyQuaternion(arm).toArray(),
    armWorldQuaternion: arm.toArray(), thoraxWorldQuaternion: identity, girdleWorldQuaternion: proxy.toArray() } };
}
const finiteTree = (value: unknown): void => {
  if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
  else if (Array.isArray(value)) value.forEach(finiteTree);
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteTree);
};

describe('pure shoulder-complex geometry and data contract', () => {
  it('separates actual thorax excursion from proxy-relative excursion and its engineering capacity', () => {
    const result = inspectShoulderComplex(input(100, 35));
    expect(result.thorax.elevationDeg).toBeCloseTo(135, 10);
    expect(result.girdleProxy.elevationDeg).toBeCloseTo(100, 10);
    expect(result.capacity).toMatchObject({ basis: 'engineering-girdle-proxy', budgetDeg: 120, withinBudget: true });
    expect(result.capacity.marginDeg).toBeCloseTo(20, 10);
    expect(result.capability.kind).toBe('girdle-proxy');
    expect(result.capability.independentAnatomicalJoints).toBe(false);
    const limited = inspectShoulderComplex({ ...input(100, 35), proxyElevationBudgetDeg: 90 });
    expect(limited.capacity.marginDeg).toBeCloseTo(-10, 10);
    expect(limited.capacity.excessDeg).toBeCloseTo(10, 10);
    expect(limited.capacity.withinBudget).toBe(false);
  });

  for (const degrees of [-175, -60, 0, 60, 175]) it(`axial twist ${degrees} does not consume elevation capacity`, () => {
    const result = inspectShoulderComplex(input(60, 20, degrees));
    expect(result.thorax.elevationDeg).toBeCloseTo(80, 9);
    expect(result.girdleProxy.elevationDeg).toBeCloseTo(60, 9);
    expect(result.girdleProxy.restAxisTwistDeg).toBeCloseTo(degrees, 9);
    expect(result.girdleProxy.valid.twist).toBe(true);
  });

  it('uses a mirrored outward plane but an explicitly unmirrored rest-axis twist convention', () => {
    for (const side of ['L', 'R'] as const) {
      const arm = q(new THREE.Vector3(0, 0, side === 'L' ? 1 : -1), 70).multiply(q(down, 30));
      const result = inspectShoulderComplex({ side, rest, current: { ...rest,
        armWorldQuaternion: arm.toArray(), armWorldDirection: down.clone().applyQuaternion(arm).toArray() } });
      expect(result.thorax.planeOfElevationDeg).toBeCloseTo(90, 9);
      expect(result.thorax.restAxisTwistDeg).toBeCloseTo(30, 9);
    }
  });

  it('is invariant when live parents change and when reference capture is globally rotated', () => {
    const original = input(75, 30, -40);
    const expected = inspectShoulderComplex(original);
    for (const rotateRest of [false, true]) {
      const parent = new THREE.Quaternion().setFromEuler(new THREE.Euler(.7, 1.2, -.4));
      const transform = (f: ShoulderComplexFrame): ShoulderComplexFrame => ({
        armWorldDirection: new THREE.Vector3().fromArray(f.armWorldDirection!).applyQuaternion(parent).toArray(),
        ...Object.fromEntries(['armWorldQuaternion', 'thoraxWorldQuaternion', 'girdleWorldQuaternion'].map(key =>
          [key, parent.clone().multiply(new THREE.Quaternion().fromArray(f[key as keyof ShoulderComplexFrame]!)).toArray()])),
      });
      const actual = inspectShoulderComplex({ ...original, current: transform(original.current!),
        ...(rotateRest ? { rest: transform(rest), restAnteriorWorld: new THREE.Vector3(0, 0, 1).applyQuaternion(parent).toArray() } : {}) });
      for (const key of ['thorax', 'girdleProxy'] as const) {
        expect(actual[key].elevationDeg).toBeCloseTo(expected[key].elevationDeg!, 9);
        expect(actual[key].planeOfElevationDeg).toBeCloseTo(expected[key].planeOfElevationDeg!, 9);
        expect(actual[key].restAxisTwistDeg).toBeCloseTo(expected[key].restAxisTwistDeg!, 9);
      }
    }
  });

  it('is unchanged by quaternion sign and safely normalizes extreme finite magnitudes', () => {
    const original = input(75, 20, -40), expected = inspectShoulderComplex(original);
    for (const multiplier of [-1, 1e300, 1e-300]) {
      const scaled: ShoulderComplexFrame = Object.fromEntries(Object.entries(original.current!).map(([key, value]) =>
        [key, value!.map((n: number) => n * multiplier)]));
      // Negating a quaternion preserves orientation; negating a vector does not.
      scaled.armWorldDirection = original.current!.armWorldDirection;
      expect(inspectShoulderComplex({ ...original, current: scaled }).girdleProxy.elevationDeg).toBeCloseTo(expected.girdleProxy.elevationDeg!, 9);
      expect(inspectShoulderComplex({ ...original, current: scaled }).girdleProxy.restAxisTwistDeg).toBeCloseTo(expected.girdleProxy.restAxisTwistDeg!, 9);
    }
  });

  it('reports plane and antiparallel twist singularities without inventing a measurement', () => {
    const neutral = inspectShoulderComplex(input(0));
    expect(neutral.status).toBe('complete');
    expect(neutral.thorax.elevationDeg).toBe(0);
    expect(neutral.thorax.planeOfElevationDeg).toBeNull();
    expect(neutral.thorax.restAxisTwistDeg).toBe(0);
    const overhead = inspectShoulderComplex(input(180));
    expect(overhead.thorax.elevationDeg).toBeCloseTo(180, 10);
    expect(overhead.thorax.valid).toEqual({ elevation: true, plane: false, twist: false });
    expect(overhead.diagnostics.map(d => d.code)).toContain('antiparallel-twist');
    for (const degrees of [89.9999, 90, 90.0001, 179.99]) finiteTree(inspectShoulderComplex(input(degrees, 0, 20)));
    const badPlane = inspectShoulderComplex({ ...input(80), restAnteriorWorld: [0, -1, 0] });
    expect(badPlane.thorax.valid.elevation).toBe(true);
    expect(badPlane.thorax.valid.plane).toBe(false);
    expect(badPlane.diagnostics.map(d => d.code)).toContain('plane-reference-degenerate');
  });

  it('retains available measurements when girdle mapping or arm twist reference is missing', () => {
    const missing = input(60); delete missing.current!.girdleWorldQuaternion;
    const result = inspectShoulderComplex({ ...missing, rest: { ...rest, armWorldQuaternion: undefined } });
    expect(result.status).toBe('partial');
    expect(result.thorax.elevationDeg).toBeCloseTo(60, 9);
    expect(result.thorax.valid.twist).toBe(false);
    expect(result.girdleProxy.elevationDeg).toBeNull();
    expect(result.capacity.marginDeg).toBeNull();
    expect(result.diagnostics).toContainEqual({ code: 'missing-current', field: 'current.girdleWorldQuaternion' });
    expect(result.diagnostics).toContainEqual({ code: 'missing-reference', field: 'rest.armWorldQuaternion' });
  });

  it('returns finite nullable data and specific diagnostics for malformed or missing references', () => {
    const cases: ShoulderComplexInput[] = [
      { side: 'L' },
      { ...input(60), current: { ...rest, armWorldDirection: [NaN, 0, 0] } },
      { ...input(60), rest: { ...rest, thoraxWorldQuaternion: [Infinity, 0, 0, 1] } },
      { ...input(60), current: { ...rest, armWorldDirection: [0, 0, 0] } },
      { ...input(60), rest: { ...rest, girdleWorldQuaternion: [0, 0, 0, 0] } },
      ...[NaN, Infinity, -1, 181].map(proxyElevationBudgetDeg => ({ ...input(60), proxyElevationBudgetDeg })),
    ];
    for (const bad of cases) {
      const result = inspectShoulderComplex(bad); finiteTree(result);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
    const frozen = input(60, 20, 30);
    Object.values(frozen.current!).forEach(Object.freeze); Object.freeze(frozen.current);
    const original = JSON.stringify(frozen);
    inspectShoulderComplex(frozen);
    expect(JSON.stringify(frozen)).toBe(original);
  });

  it('rejects sparse vectors and quaternions instead of reporting a valid NaN measurement', () => {
    const sparseDirection = inspectShoulderComplex({ ...input(60), current: {
      ...rest, armWorldDirection: Array(3) as unknown as ShoulderVector3,
    } });
    expect(sparseDirection.status).toBe('unavailable');
    expect(sparseDirection.capacity.marginDeg).toBeNull();
    expect(sparseDirection.diagnostics).toContainEqual({ code: 'non-finite-input', field: 'current.armWorldDirection' });
    finiteTree(sparseDirection);
    const sparseRotation = inspectShoulderComplex({ ...input(60), current: {
      ...rest, girdleWorldQuaternion: Array(4) as unknown as ShoulderQuaternion,
    } });
    expect(sparseRotation.status).toBe('partial');
    expect(sparseRotation.girdleProxy.valid.elevation).toBe(false);
    expect(sparseRotation.diagnostics).toContainEqual({ code: 'non-finite-input', field: 'current.girdleWorldQuaternion' });
    finiteTree(sparseRotation);
  });
});
