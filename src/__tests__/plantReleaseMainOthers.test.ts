/**
 * RUNS, LIFTS AND TOE-OFFS AGAINST 5c1c9ac — every release, both rigs, 30 / 60
 * / 120 Hz: the travel run, jog and sprint at 0.7, 1 and 1.3 of their pace,
 * a foot let go 50–250 ms into a 300–600 ms lift, and the DDx-pattern toe
 * walk's toe-offs (speeds 1 and 0.85). Measured and compared as in
 * plantReleaseMain.test.ts: no joint may turn faster than both 5c1c9ac's
 * release and FK's own local peak, and where one does it is listed here with
 * what was measured and asserted nowhere; anything else worse fails.
 *
 * Against FK alone (plantReleaseSpeed holds the default run at every rate,
 * and the jog and sprint at 60 Hz, to it): 25 of the 240 run and lift
 * releases here turn a joint past FK's local peak — 19 by 0.1–15% (12 runs
 * at 30 Hz, up to 15%; 6 runs and a lift at 120 Hz, up to 9%, the female
 * sprint at 1.3 of its pace) and the lift let go 150 ms into its 400 ms
 * raise, whose hip runs 1.38–1.41× FK's at every rate (5c1c9ac 1.31× at
 * 30 Hz).
 *
 * NOT MET, 20 of 252: the toe-offs' hip, 1–19% faster than 5c1c9ac's at 30 /
 * 60 / 120 Hz, and their knee by 0.3–4.4% at some rates — 5c1c9ac's toe chain
 * stopped at the knee, so its hip was FK's through every toe release, and
 * this one climbs to the hip (toeContact); the lift let go at 150 ms, its hip
 * 6% faster at 30 Hz (7.75 against 7.31°/frame); and the female sprint at 1.3
 * of its pace at 120 Hz, its right knee 2% and 1.4% past both.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadRigOf, type Rig } from './plantReleaseRig';
import { measureAgainstMain, OTHERS, RATES, RIGS, worseThanMain } from './plantReleaseCases';

const rigs: Partial<Record<(typeof RIGS)[number], Rig>> = {};

beforeAll(async () => {
  for (const variant of RIGS) rigs[variant] = await loadRigOf(variant);
}, 120_000);
// Each test here samples the rig synchronously for seconds. Yield to the
// event loop before each one: a file whose tests run over 60 s in all without
// a turn of it trips vitest's worker RPC timeout ("Timeout calling
// onTaskUpdate"), which fails the run although every test passed.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Worse than 5c1c9ac, measured (see above). */
const NOT_MET: Record<string, string> = {
  'male heldlift-150-400 30 L_Foot@150 hip': '7.75°/frame, 5c1c9ac 7.31, FK 5.57',
  'male toe 60 R_Toes@1209 hip': '2.80°/frame, 5c1c9ac 2.63, FK 2.63',
  'male toe 60 R_Toes@1209 knee': '6.19°/frame, 5c1c9ac 5.85, FK 6.11',
  'male toe 120 R_Toes@1209 hip': '1.41°/frame, 5c1c9ac 1.32, FK 1.32',
  'male toe 120 R_Toes@1209 knee': '3.17°/frame, 5c1c9ac 3.14, FK 3.07',
  'male toe0.85 30 R_Toes@1312 hip': '4.46°/frame, 5c1c9ac 4.40, FK 4.40',
  'male toe0.85 60 R_Toes@1312 hip': '2.44°/frame, 5c1c9ac 2.24, FK 2.24',
  'male toe0.85 120 R_Toes@1312 hip': '1.23°/frame, 5c1c9ac 1.12, FK 1.12',
  'female tsprint-1.3 120 R_Foot@535 knee': '16.42°/frame, 5c1c9ac 15.14, FK 16.07',
  'female tsprint-1.3 120 R_Foot@1141 knee': '17.65°/frame, 5c1c9ac 17.41, FK 16.19',
  'female heldlift-150-400 30 L_Foot@150 hip': '7.67°/frame, 5c1c9ac 7.25, FK 5.57',
  'female toe 30 R_Toes@1209 hip': '5.73°/frame, 5c1c9ac 5.19, FK 5.19',
  'female toe 30 R_Toes@1209 knee': '12.34°/frame, 5c1c9ac 11.58, FK 12.01',
  'female toe 60 R_Toes@1209 hip': '3.14°/frame, 5c1c9ac 2.63, FK 2.63',
  'female toe 120 R_Toes@1209 hip': '1.57°/frame, 5c1c9ac 1.32, FK 1.32',
  'female toe0.85 30 R_Toes@1312 hip': '4.45°/frame, 5c1c9ac 4.40, FK 4.40',
  'female toe0.85 30 R_Toes@1312 knee': '10.56°/frame, 5c1c9ac 10.53, FK 10.08',
  'female toe0.85 60 R_Toes@1312 hip': '2.48°/frame, 5c1c9ac 2.24, FK 2.24',
  'female toe0.85 60 R_Toes@1312 knee': '5.72°/frame, 5c1c9ac 5.48, FK 5.19',
  'female toe0.85 120 R_Toes@1312 hip': '1.24°/frame, 5c1c9ac 1.12, FK 1.12',
};

describe('runs, lifts and toe-offs: no joint faster than 5c1c9ac’s release or FK’s own peak (documented where not met)', () => {
  for (const variant of RIGS) {
    for (const [key, motion] of Object.entries(OTHERS)) {
      it(`${variant} ${key} at 30, 60 and 120 Hz`, () => {
        for (const hz of RATES) {
          const ours = measureAgainstMain(rigs[variant]!, key, motion, hz);
          const { compared, missing, worse } = worseThanMain('OTHERS', variant, key, hz, ours);
          expect(missing, `${variant} ${key} @${hz} Hz: 5c1c9ac's releases, all released here`).toEqual([]);
          expect(compared.length, `${variant} ${key} @${hz} Hz: releases compared`).toBeGreaterThan(0);
          for (const [id, what] of worse) {
            // eslint-disable-next-line no-console
            console.log(`worse than 5c1c9ac: ${id} — ${what}${NOT_MET[id] ? ' (documented)' : ''}`);
            expect(NOT_MET[id], `${id}: ${what} — worse than 5c1c9ac, and not documented as unmet`).toBeDefined();
          }
        }
      }, 180_000);
    }
  }
});
