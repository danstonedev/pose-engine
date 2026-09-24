/**
 * THE WALKS' RELEASES, ON THE REAL RIG — where no release keeps within FK's
 * own local peak (plantReleaseSpeed explains why), held to what the base
 * release did so that none can get faster unnoticed.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ComposedMotion } from '../services/motionSequence';
import { buildFigureEightWalk, buildTravelWalk } from '../services/movementLocomotion';
import {
  describeRelease,
  loadRig,
  releaseSpeeds,
  sample,
  toePivotWalk,
  withoutContacts,
} from './plantReleaseRig';

beforeAll(loadRig);
// Each test here samples the rig synchronously for seconds. Yield to the
// event loop before each one: a file whose tests run over 60 s in all without
// a turn of it trips vitest's worker RPC timeout ("Timeout calling
// onTaskUpdate"), which fails the run although every test passed.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('the walks: where no release keeps within FK’s local peak (documented, not met)', () => {
  // A walk's contact windows end after its FK has begun the swing, so the held
  // limb starts its release behind a leg FK is still speeding up: no length
  // lets the catch-up fall where FK has slack (a 400 ms release still ran the
  // default walk's knee 1.06–1.26× FK's peak), and the slack gate keeps these
  // at the burst's length. What the release must not do is ADD speed: the
  // round-1 release handed its near-floor hold back as the target crossed a 1
  // cm band — in one or two frames — and turned the 120° walk's hip 3.90× FK's
  // local peak at 120 Hz and the 0.6 walk's braking hip 1.47× (2.43 and 1.27
  // on 2504a7e's base release). Each release here is held to the base
  // release's own ratio (2504a7e), plus at most 0.05 of FK's peak: what the
  // hold off the floor-drag costs the hip (the figure-eight's right release at
  // 30 Hz: 2.078 against 2.038, for its first released frame 8.1 mm against
  // 9.7). Measured, max over the leg joints of release / FK's local peak, at
  // 30 / 60 / 120 Hz (round 1 = the band-timed hand-back this replaced):
  //                            2504a7e              now                  round 1
  //   walk-0.6  L_Foot@2077    1.023 1.154 1.266    1.023 1.154 1.266    1.280 1.404 1.467
  //   walk-t120 R_Foot@1037    2.248 2.401 2.429    2.248 2.401 2.431    2.702 3.116 3.904
  //   fig8-2    R_Foot@1157    2.038 2.141 2.148    2.078 2.150 2.163    2.069 2.400 3.843
  // (5c1c9ac, shorter and linear: 1.083 1.267 1.509 · 2.171 2.247 2.298 ·
  // 1.681 1.961 2.011.) Every other release here matches 2504a7e to 0.001.
  const BASE: Record<string, Record<number, Record<string, number>>> = {
    walk: {
      30: { 'R_Foot@1037': 1.165, 'L_Foot@1609': 1.076 },
      60: { 'R_Foot@1037': 1.161, 'L_Foot@1609': 1.305 },
      120: { 'R_Foot@1037': 1.205, 'L_Foot@1609': 1.481 },
    },
    'walk-0.6': {
      30: { 'R_Foot@1339': 1.07, 'L_Foot@2077': 1.023 },
      60: { 'R_Foot@1339': 1.082, 'L_Foot@2077': 1.154 },
      120: { 'R_Foot@1339': 1.091, 'L_Foot@2077': 1.266 },
    },
    'walk-t120': {
      30: { 'R_Foot@1037': 2.248, 'L_Foot@1609': 1.338 },
      60: { 'R_Foot@1037': 2.401, 'L_Foot@1609': 1.525 },
      120: { 'R_Foot@1037': 2.429, 'L_Foot@1609': 1.702 },
    },
    'fig8-2': {
      30: { 'R_Foot@1157': 2.038, 'L_Foot@1729': 1.795 },
      60: { 'R_Foot@1157': 2.141, 'L_Foot@1729': 1.982 },
      120: { 'R_Foot@1157': 2.148, 'L_Foot@1729': 2.127 },
    },
    // DDx's toe-off (its toes held 46% into the next keyframe): the right toes
    // match 2504a7e to the digit (5c1c9ac: 2.573 2.819 2.946 · 1.650 2.128
    // 2.813). The left toes' braking step has its own bounds (toeContact).
    toe: {
      30: { 'R_Toes@1209': 2.13 },
      60: { 'R_Toes@1209': 2.525 },
      120: { 'R_Toes@1209': 2.536 },
    },
    'toe0.6': {
      30: { 'R_Toes@1561': 1.6 },
      60: { 'R_Toes@1561': 1.646 },
      120: { 'R_Toes@1561': 1.614 },
    },
  };
  /** The braking step's toe release, bounded in toeContact.test.ts. */
  const brakingStep = (key: string, foot: string) => key.startsWith('toe') && foot === 'L_Toes';
  const cases: [string, () => ComposedMotion][] = [
    ['walk', () => buildTravelWalk()],
    ['walk-0.6', () => buildTravelWalk({ speed: 0.6 })],
    ['walk-t120', () => buildTravelWalk({ turnDeg: 120 })],
    ['fig8-2', () => buildFigureEightWalk()[1]!],
    ['toe', () => toePivotWalk()],
    ['toe0.6', () => toePivotWalk(0.6)],
  ];
  for (const [key, motion] of cases) {
    for (const hz of [30, 60, 120]) {
      it(`${key} at ${hz} Hz: every release within the base release’s ratio to FK’s local peak (+0.05)`, () => {
        const s = sample(motion, key, hz);
        const fk = sample(withoutContacts(motion), `${key}-fk`, hz).rec;
        const releases = releaseSpeeds(s, fk).filter((r) => !brakingStep(key, r.foot));
        expect(releases.length, `${key} releases into swing`).toBeGreaterThanOrEqual(key.startsWith('toe') ? 1 : 2);
        const measured = releases.map((r) => {
          const ratio = Math.max(...r.joints.map((j) => j.release / j.fk));
          const name = `${r.foot}@${r.toMs.toFixed(0)}`;
          // eslint-disable-next-line no-console
          console.log(`walk ${key} @${hz} Hz ${name}: ${ratio.toFixed(3)}× FK’s local peak | ${describeRelease(r)}`);
          return { name, ratio };
        });
        for (const { name, ratio } of measured) {
          const base = BASE[key]?.[hz]?.[name];
          expect(base, `${key} ${name} @${hz} Hz measured on the base release`).toBeDefined();
          expect(ratio, `${key} ${name} @${hz} Hz vs the base release’s ${base}`).toBeLessThanOrEqual(base! + 0.05);
        }
      }, 120_000);
    }
  }
});
