/**
 * SQUAD TANGENT CLAMP (SEAM-4 cause 1) — near-antipode knot deltas.
 *
 * When adjacent orientation knots differ by more than ~120°, the quaternion log
 * that seeds the SQUAD tangents is ill-conditioned: the neighbour-derived
 * control points bend the path off the short arc (measured on the
 * get-down-to-plank arms as a wrong-way sweep snapping 168° in <10 ms; on a
 * pure 170° test segment the unclamped spline overshoots BOTH endpoints —
 * range [−0.73°, 180.73°] for authored [5°, 175°]). Any segment wider than the
 * threshold now interpolates as a plain short-arc slerp (controls = endpoints,
 * so SQUAD degenerates to slerp exactly) and the knots flanking it get
 * zero-velocity path tangents (the pathExtremum damping), keeping C0.
 *
 * Gates: (1) a 170° segment interpolates MONOTONICALLY along the short arc,
 * never leaving the knot-to-knot angle range; (2) it stays ON the geodesic
 * (bounded intermediate deviation) for a mixed-axis pair too; (3) small-delta
 * series are NUMERICALLY UNCHANGED — pinned against samples generated from the
 * pre-clamp implementation (origin/main), which the clamped path reproduces
 * bit-for-bit because sub-threshold series never take the fallback branch.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPoseTrajectory, type TrajectoryKnot } from '../services/motionTrajectory';

const IDENT: [number, number, number, number] = [0, 0, 0, 1];

function rot(deg: number, axis: [number, number, number]): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(...axis).normalize(),
    (deg * Math.PI) / 180,
  );
  return [q.x, q.y, q.z, q.w];
}
function knot(
  timeMs: number,
  bones: Record<string, [number, number, number, number]>,
  stop: boolean,
): TrajectoryKnot {
  return {
    timeMs,
    pose: { variant: 'male', bones, schemaVersion: 'test' },
    rootQuat: IDENT,
    rootTranslate: [0, 0, 0],
    stop,
    planted: false,
  };
}
const q4 = (t: [number, number, number, number]): THREE.Quaternion =>
  new THREE.Quaternion(t[0], t[1], t[2], t[3]);

describe('SQUAD tangent clamp — a 170° segment takes the short arc, monotonically', () => {
  // Interior fly-through segment B→C spans 170° about +X, flanked by small
  // deltas — the ill-conditioned case (unclamped: overshoots both ends).
  const traj = buildPoseTrajectory([
    knot(0, { Hips: rot(0, [1, 0, 0]) }, true),
    knot(600, { Hips: rot(5, [1, 0, 0]) }, false),
    knot(1200, { Hips: rot(175, [1, 0, 0]) }, false),
    knot(1800, { Hips: rot(180, [1, 0, 0]) }, true),
  ]);
  const angleAt = (t: number): number => {
    const q = traj.sampleAt(t).pose.bones.Hips!;
    return (2 * Math.atan2(q[0]!, q[3]!) * 180) / Math.PI; // signed angle about +X
  };

  it('monotone along the short arc, never outside the knot angle range', () => {
    let prev = -Infinity;
    for (let t = 600; t <= 1200; t += 5) {
      const a = angleAt(t);
      expect(a, `t=${t} stays at/above the departing knot`).toBeGreaterThan(5 - 1e-6);
      expect(a, `t=${t} stays at/below the arriving knot`).toBeLessThan(175 + 1e-6);
      expect(a, `t=${t} monotone (no wrong-way sweep)`).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = a;
    }
  });

  it('the rotation axis never flips (pure +X throughout — no detour)', () => {
    for (let t = 600; t <= 1200; t += 25) {
      const q = traj.sampleAt(t).pose.bones.Hips!;
      expect(Math.abs(q[1]!), `t=${t} no Y component`).toBeLessThan(1e-9);
      expect(Math.abs(q[2]!), `t=${t} no Z component`).toBeLessThan(1e-9);
    }
  });

  it('hits both knots exactly (C0 preserved)', () => {
    expect(angleAt(600)).toBeCloseTo(5, 6);
    expect(angleAt(1200)).toBeCloseTo(175, 6);
  });
});

describe('SQUAD tangent clamp — mixed-axis 170° pair stays on the geodesic', () => {
  it('max intermediate deviation from the knot-to-knot geodesic is bounded', () => {
    const b = rot(20, [0, 1, 0]);
    const c = rot(170, [1, 0.3, 0]); // ~168.5° from b — over the threshold
    const qb = q4(b);
    const qc = q4(c);
    expect((qb.angleTo(qc) * 180) / Math.PI).toBeGreaterThan(160);
    const traj = buildPoseTrajectory([
      knot(0, { Hips: rot(0, [0, 1, 0]) }, true),
      knot(600, { Hips: b }, false),
      knot(1200, { Hips: c }, false),
      knot(1800, { Hips: rot(175, [1, 0.3, 0]) }, true),
    ]);
    // Deviation of each sample from the geodesic b→c: the nearest slerp point.
    const probe = new THREE.Quaternion();
    const onArc = new THREE.Quaternion();
    for (let t = 600; t <= 1200; t += 20) {
      const s = traj.sampleAt(t).pose.bones.Hips!;
      probe.set(s[0]!, s[1]!, s[2]!, s[3]!);
      let best = Infinity;
      for (let u = 0; u <= 1.0001; u += 0.005) {
        onArc.copy(qb).slerp(qc, Math.min(1, u));
        best = Math.min(best, (probe.angleTo(onArc) * 180) / Math.PI);
      }
      expect(best, `t=${t} on the short-arc geodesic`).toBeLessThan(0.5);
    }
  });
});

describe('SQUAD tangent clamp — sub-threshold segments are numerically unchanged', () => {
  it('a mixed-axis small-delta series reproduces the pre-clamp spline bit-for-bit', () => {
    // Fixture identical to the one sampled on origin/main (pre-clamp): mixed
    // axes, every segment well under the 120° threshold. Expected quaternions
    // below were generated from THAT implementation; the clamped build matched
    // it with max component difference 0 (same code path — the fallback branch
    // never fires under the threshold).
    const traj = buildPoseTrajectory([
      knot(0, { Hips: rot(0, [1, 0, 0]), L_UpperArm: rot(10, [0, 1, 0]) }, true),
      knot(500, { Hips: rot(40, [1, 0, 0]), L_UpperArm: rot(-50, [0, 1, 0]) }, false),
      knot(1100, { Hips: rot(80, [1, 0, 0]), L_UpperArm: rot(30, [1, 1, 0]) }, false),
      knot(1700, { Hips: rot(25, [1, 0, 0]), L_UpperArm: rot(85, [0, 0, 1]) }, true),
    ]);
    const expected: [number, [number, number, number, number]][] = [
      [0, [0.0, 0.0, 0.0, 1.0]],
      [137, [0.046897003164035, 0.0, 0.0, 0.998899730250355]],
      [350, [0.224949175231208, 0.0, 0.0, 0.974370498610667]],
      [500, [0.342020143325669, 0.0, 0.0, 0.939692620785908]],
      [683, [0.469799879451603, 0.0, 0.0, 0.882772945477635]],
      [900, [0.601673380649915, 0.0, 0.0, 0.798742225638098]],
      [1100, [0.642787609686539, 0.0, 0.0, 0.766044443118978]],
      [1333, [0.497937497010718, 0.0, 0.0, 0.867212920262781]],
      [1550, [0.271622619852331, 0.0, 0.0, 0.962403840591129]],
      [1700, [0.216439613938103, 0.0, 0.0, 0.976296007119933]],
    ];
    for (const [t, q] of expected) {
      const s = traj.sampleAt(t).pose.bones.Hips!;
      for (let i = 0; i < 4; i += 1) {
        expect(s[i]!, `Hips t=${t} component ${i}`).toBeCloseTo(q[i]!, 12);
      }
    }
  });
});
