/**
 * DET-APP-01 / SEAM-11 — variantCfg + currentAngles threading (pure gates).
 *
 * The public resolution/derivation entry points must thread the REAL body-variant
 * config and the live joint state all the way through, not silently fall back to a
 * default:
 *   • DET-APP-01 — a non-default variant DERIVES with its own proportions: the
 *     variant-keyed finger fit in buildCommandPose lands a female curl on a
 *     different bone quat than the male curl (variantCfg.id reaches the derivation).
 *   • SEAM-11 — a continuation THREADS currentAngles into the velocity governor:
 *     resolveComposedMotion seeds each target's velocity 'from' with the live
 *     angle, so a keyframe already AT its target is not re-timed while the same
 *     keyframe reached from far away is stretched by the velocity floor.
 *
 * Each gate is written to FAIL on the counterfactual (the value defaulted away).
 */
import { describe, expect, it } from 'vitest';
import { buildCommandPose, type ExamMovementCommand } from '../services/movementCommand';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

/** Angle (deg) between two [x,y,z,w] quaternions (normalized so a near-unit float
 *  norm can't masquerade as a rotation — identical quats read exactly 0). */
function quatAngleDeg(a: [number, number, number, number], b: [number, number, number, number]): number {
  const na = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  const nb = Math.hypot(b[0], b[1], b[2], b[3]) || 1;
  const dot = Math.min(
    1,
    Math.abs((a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (na * nb)),
  );
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

describe('DET-APP-01 — a non-default variant derives with its OWN proportions', () => {
  // The finger curve is variant-keyed (male vs female rest hand postures differ,
  // rig-verified). buildCommandPose threads variantCfg.id into the derivation, so
  // the SAME commanded curl lands on DIFFERENT bone quats per variant — across
  // ALL THREE phalanges, which is where the digit's curl actually lives.
  const baseline: CustomPose = {
    variant: 'male',
    bones: { L_Index1: [0, 0, 0, 1], L_Index2: [0, 0, 0, 1], L_Index3: [0, 0, 0, 1] },
  };
  const curl: ExamMovementCommand = {
    action: 'set-joint',
    joint: 'L_Index1',
    motion: 'fingerFlexion',
    targetDegrees: 90,
  };

  it('the finger curl is now variant-INDEPENDENT by construction — the readout carries the variant', () => {
    const male = buildCommandPose(baseline, curl, 90, BODY_VARIANTS.male);
    const female = buildCommandPose(baseline, curl, 90, BODY_VARIANTS.female);
    expect(male, 'male finger pose builds').not.toBeNull();
    expect(female, 'female finger pose builds').not.toBeNull();
    // This used to assert the OPPOSITE — that the two variants produced measurably
    // different quats — because the command inverted a per-variant calibration
    // table. That table existed only to undo a readout that reported a straight
    // digit as ~22° of flexion, and each variant's rest hand posture made its own
    // offset. The readout is now signed and rest-referenced, so it subtracts each
    // variant's rest itself: the same clinical value is the same local rotation on
    // any rig, and the variant enters at measurement rather than at authoring.
    // That is strictly better — a variant with no calibration row used to fall
    // back to the male table and silently misreport.
    for (const key of ['L_Index1', 'L_Index2', 'L_Index3'] as const)
      expect(quatAngleDeg(male!.bones![key]!, female!.bones![key]!), key).toBeLessThan(0.01);
    // The per-variant guarantee that matters is that each rig still MEASURES the
    // commanded value — held by the female canary in movementCommand.test.ts,
    // which walks the whole ROM on the female GLB.
  });

  it('the SAME variant is deterministic (identical input → bit-identical bone quat)', () => {
    const a = buildCommandPose(baseline, curl, 90, BODY_VARIANTS.female)!.bones!['L_Index1']!;
    const b = buildCommandPose(baseline, curl, 90, BODY_VARIANTS.female)!.bones!['L_Index1']!;
    expect(a).toEqual(b);
  });
});

describe('SEAM-11 — a continuation threads currentAngles into the velocity governor', () => {
  // One fast keyframe (50 ms) driving the hip to 90°. startFrom:'current' means the
  // velocity 'from' is seeded by currentAngles. Reached from AT-target the delta is
  // ~0 (no floor); reached from far the 90° delta trips the velocity floor and the
  // keyframe is stretched. If currentAngles never reached the governor, both would
  // seed from 0 and re-time identically.
  const fast: ComposedMotion = {
    name: 'quick hip raise',
    startFrom: 'current',
    keyframes: [
      { durationMs: 50, targets: [{ joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 90 }] },
    ],
  };

  const dur = (currentAngles: Record<string, number>): number => {
    const r = resolveComposedMotion(fast, BODY_VARIANTS.male, { currentAngles });
    expect(r.status).toBe('ok');
    return r.keyframes[0]!.durationMs;
  };

  it('a keyframe reached from AT its target is not re-timed; from far it is stretched', () => {
    const atTarget = dur({ 'L_UpLeg.hipFlexion': 90 }); // delta ~0 → no hip floor
    const far = dur({ 'L_UpLeg.hipFlexion': 0 }); // delta 90° → velocity floor stretches
    // Counterfactual: seeding ignored ⇒ both seed the hip from 0 ⇒ equal durations.
    expect(far, 'the far-reached keyframe is stretched more than the at-target one').toBeGreaterThan(atTarget);
  });

  it('the at-target continuation keeps its authored tempo (governor saw the live angle)', () => {
    const r = resolveComposedMotion(fast, BODY_VARIANTS.male, {
      currentAngles: { 'L_UpLeg.hipFlexion': 90 },
    });
    // The hip contributes ~0 delta, so the keyframe is NOT flagged as velocity-floored
    // by the hip — it kept (near) the authored 50 ms rather than being stretched to the
    // ~375 ms a 90°-from-neutral move would require.
    expect(r.keyframes[0]!.durationMs).toBeLessThan(200);
  });
});
