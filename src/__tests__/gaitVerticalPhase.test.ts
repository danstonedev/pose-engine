/**
 * THE BOB THE RIGHT WAY UP — the calibrated pelvis vertical of a one-shot walk
 * that spans several gait periods (deriveVerticalCalibration's
 * `periodFraction`).
 *
 * A one-shot travel walk is calibrated whole, and its smoothing window used to be
 * a fixed share of the WHOLE clip. On a two-cycle 0.85-speed walk (3.96 s) that
 * is a 743 ms boxcar against 520-620 ms steps: the step bob fell in the boxcar's
 * negative lobe and came out inverted — the centre of mass highest 10% into the
 * cycle, just after initial contact, lowest in single stance — and so flat that
 * the rise limit cut a 3.0 cm one-frame drop into it at the first landing.
 *
 * The fixture is the floor pin such a walk produces: standing, three 1.1 s gait
 * cycles whose pin dips 6 cm in a sharp V at every double support (the legs
 * spread), standing again.
 */
import { describe, expect, it } from 'vitest';
import { applyVerticalCalibration, deriveVerticalCalibration } from '../services/rootMotion';
import { GAIT_VERTICAL_MAX_RISE_M } from '../services/motionRecording';

const STAND_MS = 600;
const PERIOD_MS = 1100;
const CYCLES = 3;
const CLIP_MS = STAND_MS + CYCLES * PERIOD_MS + STAND_MS;
/** Double-support instants: every half period through the gait. */
const DOUBLE_SUPPORT_MS = Array.from({ length: 2 * CYCLES + 1 }, (_, k) => STAND_MS + (k * PERIOD_MS) / 2);
const VALLEY_M = 0.06;
const VALLEY_HALF_MS = 90;
/** The pinned root height (m, standing = 0) at clip time tMs. */
const pinAt = (tMs: number): number => {
  if (tMs < STAND_MS - VALLEY_HALF_MS || tMs > CLIP_MS - STAND_MS + VALLEY_HALF_MS) return 0;
  let y = -0.005;
  for (const d of DOUBLE_SUPPORT_MS) y -= VALLEY_M * Math.max(0, 1 - Math.abs(tMs - d) / VALLEY_HALF_MS);
  return y;
};
const TARGET_M = 0.05;

const calibrate = (periodFraction?: number) =>
  deriveVerticalCalibration((u) => pinAt(u * CLIP_MS), TARGET_M, 48, true, GAIT_VERTICAL_MAX_RISE_M, periodFraction);

describe('a one-shot walk several periods long keeps its bob the right way up', () => {
  it('the calibrated arc is lowest at double support and highest at mid-stance', () => {
    const cal = calibrate(PERIOD_MS / CLIP_MS);
    // Over the middle cycle (phase 0 = a double support), where does the arc's
    // twice-per-cycle component peak? Mid-stance is 0.25, double support 0/0.5.
    const t0 = STAND_MS + PERIOD_MS;
    const n = 220;
    const ys = Array.from({ length: n }, (_, k) =>
      applyVerticalCalibration(Number.POSITIVE_INFINITY, cal, (t0 + (PERIOD_MS * k) / n) / CLIP_MS),
    );
    const mean = ys.reduce((s, y) => s + y, 0) / n;
    let c = 0;
    let s = 0;
    ys.forEach((y, k) => {
      c += (y - mean) * Math.cos((4 * Math.PI * k) / n);
      s += (y - mean) * Math.sin((4 * Math.PI * k) / n);
    });
    const peak = (((Math.atan2(s, c) / (4 * Math.PI)) % 0.5) + 0.5) % 0.5;
    // eslint-disable-next-line no-console
    console.log(`bob peaks at ${peak.toFixed(3)} of the cycle after double support (mid-stance 0.25)`);
    // Before: 0.000 — the peaks AT double support, the arc upside down.
    expect(peak).toBeGreaterThan(0.125);
    expect(peak).toBeLessThan(0.375);
  });

  it('never drops faster than gravity where the rise limit meets a double-support valley', () => {
    const cal = calibrate(PERIOD_MS / CLIP_MS);
    // The pelvis as played at 30 Hz: the table, held within the rise limit above
    // the live pin frame by frame.
    const dtMs = 1000 / 30;
    const ys: number[] = [];
    for (let t = 0; t <= CLIP_MS; t += dtMs) ys.push(applyVerticalCalibration(pinAt(t), cal, t / CLIP_MS));
    let worst = Infinity;
    for (let i = 1; i < ys.length - 1; i += 1) {
      const accel = (ys[i + 1]! - 2 * ys[i]! + ys[i - 1]!) / (dtMs / 1000) ** 2;
      worst = Math.min(worst, accel / 9.81);
    }
    // eslint-disable-next-line no-console
    console.log(`steepest drop: ${worst.toFixed(2)} g`);
    // Before: −2.1 g — the flat arc, cut down to pin + limit for a frame.
    expect(worst).toBeGreaterThan(-1);
  });

  it('a single-cycle clip (the stock travel walk: its period is 0.41 of the clip) keeps the derivation it had', () => {
    // Its clip-sized window is 0.92 of a step: the bob is attenuated, not
    // inverted, and that walk's double-support and pelvis-excursion gates are
    // measured on exactly this arc.
    const calls = { legacy: 0, single: 0 };
    const legacy = deriveVerticalCalibration(
      (u) => {
        calls.legacy += 1;
        return pinAt(u * CLIP_MS);
      },
      TARGET_M,
      48,
      true,
      GAIT_VERTICAL_MAX_RISE_M,
    );
    const single = deriveVerticalCalibration(
      (u) => {
        calls.single += 1;
        return pinAt(u * CLIP_MS);
      },
      TARGET_M,
      48,
      true,
      GAIT_VERTICAL_MAX_RISE_M,
      1024 / 2509, // the stock walk's published cycle over its clip
    );
    expect(single).toEqual(legacy);
    expect(calls.single).toBe(calls.legacy);
  });
});
