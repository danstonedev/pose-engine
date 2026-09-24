/**
 * A FOOT RELEASED AFTER A SLOW WEIGHT SHIFT OF 3–5 CM — the single-leg-stance
 * replica simMOVE plays, with smaller shifts than plantReleaseSpeed's 9 cm, on
 * the real rig. The release reads its length once, as the window ends: re-read
 * on every frame it followed the gap to FK as FK moved away, so it ran
 * backwards and lurched where the length met its cap.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MotionRecording } from '../services/motionRecording';
import {
  describeRelease,
  firstFrameAfter,
  jointTurn,
  loadRig,
  releaseSpeeds,
  sample,
  singleLegStance,
  withoutContacts,
} from './plantReleaseRig';

beforeAll(loadRig);
// Each test here samples the rig synchronously for seconds. Yield to the
// event loop before each one: a file whose tests run over 60 s in all without
// a turn of it trips vitest's worker RPC timeout ("Timeout calling
// onTaskUpdate"), which fails the run although every test passed.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('a slow weight shift of 3–5 cm: the release is read once, so it runs one way, and the foot never lurches', () => {
  // Re-read on every frame, the gap to FK grew as FK moved away and the length
  // with it: at 4 cm it went 474 → 800 ms mid-release, the weight ran backwards
  // (0.304 → 0.330) and, as the length met its cap, the foot's step at 120 Hz
  // went 1.35 → 3.67 mm in four frames — a lurch of 15 m/s². Read once, the
  // foot accelerates at under 1.1 m/s² at every rate (FK: 0.28), about what a
  // smoothstep closing a 5 cm gap over half a second needs (6G/L² ≈ 1.1).
  //
  // Against FK's own local peak, 4 and 5 cm stay within it; at 3 cm (a shorter
  // release: a smaller gap) the knee runs 1.17–1.18× it at every rate (1.85×
  // at the base release). The HOLD does that, not the catch-up: keeping the
  // foot while the pelvis shifts, it already turns the knee 1.8× FK's speed as
  // the window ends and is speeding it up, and a C1 release carries that on —
  // released over 600, 700 or 800 ms instead of 517 the knee still peaks at
  // 0.66–0.68°/frame (60 Hz). So a joint is held within the faster of FK and
  // the hold carried through the release, and within 1.2× FK's alone.
  for (const shiftM of [0.03, 0.04, 0.05]) {
    for (const hz of [30, 60, 120]) {
      it(`${shiftM * 100} cm at ${hz} Hz: the foot never steps back toward the held point, never accelerates past 2 m/s² or 4× FK’s, and every joint stays within the faster of FK and the hold it lets go of`, () => {
        const motion = () => singleLegStance(shiftM);
        const s = sample(motion, `sls${shiftM}`, hz);
        const fk = sample(withoutContacts(motion), `sls${shiftM}-fk`, hz).rec;
        const [r] = releaseSpeeds(s, fk);
        expect(r?.foot).toBe('R_Foot');
        const { rec } = s;
        const i0 = firstFrameAfter(rec, r!.toMs);
        const ie = firstFrameAfter(rec, r!.toMs + r!.lastedMs);
        const at = (r2: MotionRecording, i: number) => r2.frames[i]!.worldTracks!.R_Foot!;
        const held = at(rec, i0 - 1);
        const dt = 1 / hz;
        let back = 0;
        let lurch = 0;
        let lurchFk = 0;
        for (let i = i0 + 1; i <= ie; i += 1) {
          const out = (k: number) => Math.hypot(at(rec, k)[0]! - held[0]!, at(rec, k)[2]! - held[2]!);
          back = Math.max(back, out(i - 1) - out(i));
          const step = (r2: MotionRecording, k: number) => {
            const a = at(r2, k - 1);
            const b = at(r2, k);
            return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
          };
          lurch = Math.max(lurch, Math.abs(step(rec, i) - step(rec, i - 1)) / (dt * dt));
          lurchFk = Math.max(lurchFk, Math.abs(step(fk, i) - step(fk, i - 1)) / (dt * dt));
        }
        // The hold it lets go of: the same motion with the foot held through
        // the release, over the release's frames (contacts are authored ms).
        const toAuthored = 3800 / r!.toMs;
        const heldOn = () => ({
          ...motion(),
          contacts: [{ foot: 'L_Foot' }, { foot: 'R_Foot', toMs: (r!.toMs + r!.lastedMs + 200) * toAuthored }],
        });
        const hold = sample(heldOn, `sls${shiftM}-hold${r!.lastedMs.toFixed(0)}`, hz).rec;
        // eslint-disable-next-line no-console
        console.log(
          `single-leg stance ${shiftM * 100} cm @${hz} Hz ${describeRelease(r!)}; back ${(back * 1000).toFixed(3)} mm, ` +
            `acceleration ${lurch.toFixed(2)} m/s² (FK ${lurchFk.toFixed(2)})`,
        );
        expect(back, 'the foot steps back toward the held point (m)').toBeLessThan(1e-5);
        expect(lurch, 'the foot’s acceleration, m/s²').toBeLessThan(2);
        expect(lurch, 'the foot’s acceleration against FK’s').toBeLessThan(4 * lurchFk);
        for (const j of r!.joints) {
          let holdPeak = 0;
          for (let i = i0; i <= ie; i += 1) holdPeak = Math.max(holdPeak, jointTurn(hold, i, j.key));
          // eslint-disable-next-line no-console
          console.log(`  ${j.key}: ${j.release.toFixed(3)}°/frame, FK ${j.fk.toFixed(3)}, the hold through the release ${holdPeak.toFixed(3)}`);
          expect(j.release, `${j.key}: release vs FK’s local peak / the hold`).toBeLessThanOrEqual(Math.max(j.fk, holdPeak) + 1e-9);
          expect(j.release, `${j.key}: release vs FK’s local peak alone`).toBeLessThanOrEqual((shiftM <= 0.03 ? 1.2 : 1) * j.fk + 1e-9);
        }
      }, 120_000);
    }
  }
});
