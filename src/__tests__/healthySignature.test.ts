/**
 * HEALTHY-ASYMMETRY SIGNATURE (Wave 5 · life-signals / roadmap 5.3) — the
 * audit's polish finding: "the default gait is a perfect L/R mirror — no 2-4%
 * bilateral signature of a healthy human". Gates:
 *   • the default walk/run builders carry a 2–4% L/R arm-swing AMPLITUDE
 *     difference (amplitude-ONLY — the timing half was evaluated and
 *     deliberately rejected; see healthySignature.ts for the entanglement
 *     rationale), deterministic per seed with a fixed default seed;
 *   • the sum-preserving split keeps the reciprocal arm-swing difference —
 *     the thoracic-rotation driver — exactly intact, so every trunk/gaze gate
 *     measures the same drive;
 *   • timing, stance schedule, contacts and every non-arm channel are
 *     byte-identical to the symmetric build;
 *   • `asymmetry: false` (the clean-mode opt-out) restores the textbook
 *     mirror exactly; the transform is pure (input never mutated).
 */
import { describe, expect, it } from 'vitest';
import {
  healthyArmAsymmetry,
  healthySignature,
  HEALTHY_ASYM_MAX,
  HEALTHY_ASYM_MIN,
} from '../services/healthySignature';
import {
  buildRun,
  buildTravelRun,
  buildTravelWalk,
} from '../services/movementTemplates';
import type { ComposedMotion } from '../services/motionSequence';

/** Peak |shoulderFlexion| authored on one side across a motion's keyframes. */
function armPeak(motion: ComposedMotion, side: 'L' | 'R'): number {
  let peak = 0;
  for (const kf of motion.keyframes) {
    for (const t of kf.targets ?? []) {
      if (t.joint === `${side}_UpperArm` && t.motion === 'shoulderFlexion') {
        peak = Math.max(peak, Math.abs(t.targetDegrees));
      }
    }
  }
  return peak;
}

/** L−R amplitude difference as a fraction of the mean. */
function armAsymFraction(motion: ComposedMotion): number {
  const l = armPeak(motion, 'L');
  const r = armPeak(motion, 'R');
  return Math.abs(l - r) / ((l + r) / 2);
}

describe('healthyArmAsymmetry — the seed-derived bilateral split', () => {
  it('asym lands in the 2–4% band for any seed; the two scales sum to exactly 2 (sum-preserving)', () => {
    for (const seed of [0, 1, 7.25, 17, 42, 123.456, 999]) {
      const { asym, leftScale, rightScale } = healthyArmAsymmetry(seed);
      expect(asym).toBeGreaterThanOrEqual(HEALTHY_ASYM_MIN);
      expect(asym).toBeLessThan(HEALTHY_ASYM_MAX);
      expect(leftScale + rightScale).toBeCloseTo(2, 12);
      expect(Math.abs(leftScale - rightScale)).toBeCloseTo(asym, 12);
    }
  });

  it('deterministic per seed; different seeds give different signatures', () => {
    expect(healthyArmAsymmetry(17)).toEqual(healthyArmAsymmetry(17));
    const a = healthyArmAsymmetry(3);
    const b = healthyArmAsymmetry(4);
    expect(a.asym === b.asym && a.leftScale === b.leftScale).toBe(false);
  });
});

describe('healthySignature on the gait builders', () => {
  it('the DEFAULT travelling walk is no longer a perfect mirror: L/R arm-swing amplitude differs by 2–4%', () => {
    const walk = buildTravelWalk();
    const frac = armAsymFraction(walk);
    // eslint-disable-next-line no-console
    console.log(`healthy signature: travel-walk arm-swing L/R difference ${(frac * 100).toFixed(2)}%`);
    expect(frac).toBeGreaterThanOrEqual(HEALTHY_ASYM_MIN - 1e-9);
    expect(frac).toBeLessThanOrEqual(HEALTHY_ASYM_MAX + 1e-9);
  });

  it('the run builders carry the same signature band', () => {
    for (const motion of [buildRun(), buildTravelRun()]) {
      const frac = armAsymFraction(motion);
      expect(frac, `${motion.name} L/R arm difference`).toBeGreaterThanOrEqual(HEALTHY_ASYM_MIN - 1e-9);
      expect(frac, `${motion.name} L/R arm difference`).toBeLessThanOrEqual(HEALTHY_ASYM_MAX + 1e-9);
    }
  });

  it('`asymmetry: false` (clean mode) restores the exact textbook mirror', () => {
    for (const motion of [
      buildTravelWalk({ asymmetry: false }),
      buildRun({ asymmetry: false }),
      buildTravelRun({ asymmetry: false }),
    ]) {
      expect(armPeak(motion, 'L'), `${motion.name} symmetric`).toBe(armPeak(motion, 'R'));
    }
  });

  it('deterministic: two default builds are byte-identical; an explicit seed changes the signature', () => {
    expect(JSON.stringify(buildTravelWalk())).toBe(JSON.stringify(buildTravelWalk()));
    const a = buildTravelWalk({ asymmetry: 3 });
    const b = buildTravelWalk({ asymmetry: 4 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('AMPLITUDE-ONLY (the documented choice): timing, stance schedule and contacts are byte-identical to the symmetric build', () => {
    const signed = buildTravelWalk();
    const clean = buildTravelWalk({ asymmetry: false });
    expect(signed.keyframes.length).toBe(clean.keyframes.length);
    expect(signed.keyframes.map((k) => [k.durationMs ?? 0, k.holdMs ?? 0])).toEqual(
      clean.keyframes.map((k) => [k.durationMs ?? 0, k.holdMs ?? 0]),
    );
    expect(signed.gaitStanceWindowsMs).toEqual(clean.gaitStanceWindowsMs);
    expect(signed.contacts).toEqual(clean.contacts);
    const run = buildTravelRun();
    const runClean = buildTravelRun({ asymmetry: false });
    expect(run.gaitStanceWindowsMs).toEqual(runClean.gaitStanceWindowsMs);
    expect(run.contacts).toEqual(runClean.contacts);
  });

  it('touches ONLY the arm carriage: every leg/foot/trunk/neck channel and every root directive is byte-identical to the symmetric build', () => {
    // The signature scales shoulderFlexion BEFORE the coordination pass, so
    // the arm's DERIVED secondary carriage (abduction, pronation, scapular
    // glide, wrist drag) intentionally follows its driver — the whole arm
    // carries the signature coherently. Everything the rig gates measure for
    // grounding/grading — legs, feet, toes, spine, neck, root — must be exact.
    const ARM_CHAIN = /_(UpperArm|Forearm|Shoulder|Hand|Thumb1|Index1|Mid1|Ring1|Pinky1)$/;
    const signed = buildTravelWalk();
    const clean = buildTravelWalk({ asymmetry: false });
    for (let i = 0; i < signed.keyframes.length; i += 1) {
      const s = (signed.keyframes[i]!.targets ?? []).filter((t) => !ARM_CHAIN.test(t.joint));
      const c = (clean.keyframes[i]!.targets ?? []).filter((t) => !ARM_CHAIN.test(t.joint));
      expect(s.length, `keyframe ${i} channel count`).toBe(c.length);
      for (let j = 0; j < s.length; j += 1) {
        expect(`${s[j]!.joint}.${s[j]!.motion}`).toBe(`${c[j]!.joint}.${c[j]!.motion}`);
        // Angle-identical to 1e-9° — the trunk rotation derives from the
        // (exactly preserved) reciprocal arm difference, so only float ULP
        // noise separates the two builds on these channels.
        expect(
          Math.abs(s[j]!.targetDegrees - c[j]!.targetDegrees),
          `keyframe ${i} ${s[j]!.joint}.${s[j]!.motion}`,
        ).toBeLessThan(1e-9);
      }
      expect(signed.keyframes[i]!.root, `keyframe ${i} root directive`).toEqual(clean.keyframes[i]!.root);
    }
  });

  it('the sum-preserving split keeps the reciprocal arm-swing DIFFERENCE — the thoracic-rotation driver — intact on the walk', () => {
    const signed = buildTravelWalk();
    const clean = buildTravelWalk({ asymmetry: false });
    const diffAt = (m: ComposedMotion, i: number): number => {
      const ts = m.keyframes[i]!.targets ?? [];
      const at = (j: string): number =>
        ts.find((t) => t.joint === j && t.motion === 'shoulderFlexion')?.targetDegrees ?? 0;
      return at('R_UpperArm') - at('L_UpperArm');
    };
    for (let i = 0; i < signed.keyframes.length; i += 1) {
      // The walk's arm targets are ± mirror pairs, so with scales summing to
      // 2 the difference is EXACT — the trunk coordination derives the same
      // counter-rotation to the degree (head-steadiness gates unaffected).
      expect(diffAt(signed, i), `keyframe ${i} reciprocal drive`).toBeCloseTo(diffAt(clean, i), 9);
    }
  });

  it('is pure: the input motion is never mutated', () => {
    const clean = buildTravelWalk({ asymmetry: false });
    const before = JSON.stringify(clean);
    healthySignature(clean, 42);
    expect(JSON.stringify(clean)).toBe(before);
  });
});
