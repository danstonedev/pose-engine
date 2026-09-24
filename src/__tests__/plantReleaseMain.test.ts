/**
 * THE CURVED WALKS AND THE BRAKING STEP AGAINST 5c1c9ac — every release, both
 * rigs, 30 / 60 / 120 Hz.
 *
 * 5c1c9ac's releases are a fixture (fixtures/plantRelease.5c1c9ac.json),
 * measured on that tree by the same code that measures this one
 * (plantReleaseCases.measureAgainstMain): per release into swing, each leg
 * joint's fastest turn over the release (the window's end to the first frame
 * FK owns the leg again), the foot's fastest change of step over it, and the
 * toes' drop below their held point, lowest height and frames more than 3 mm
 * under the floor over the 300 ms after the window (the same span on
 * both trees, past either's release). A joint may turn as fast as FK's own
 * local peak — the route's motion, not the release's — or as 5c1c9ac's
 * release did, whichever is faster; nothing else may be worse. Where this tree
 * is worse, it is listed below with what was measured, and asserted nowhere:
 * the test fails on anything worse that is not listed.
 *
 * THE CURVED WALKS (walk-t45 / t90 / t-90 / t120, the figure-eight): ec3d0eb
 * held every released effector off the floor-drag and handed the hold back
 * on the release's clock, and 31 of these 72 releases turned the hip faster
 * than both 5c1c9ac's release and FK's own peak (up to 24%, the figure-
 * eight's right foot at 30 Hz: 10.70 against 8.65°/frame). Only a forefoot is
 * held now, and an ankle release cruises (footContact PlantReleaseShape): 8
 * do, all at 30 Hz, by 5–10% (listed). NOT MET: the foot's acceleration, over
 * 5c1c9ac's in 35 of 72 (up to 28%, the left foot's release at 1609 ms at
 * 30 Hz: 76.1 against 59.4 mm/frame²; ec3d0eb 46, up to 68%). 5c1c9ac's
 * release was a 100 ms linear ramp: it set the foot moving at full speed on
 * its first frame — a velocity kink, which a second difference reads as one
 * frame's change — and never accelerated after; a release that leaves the
 * hold at the hold's own speed (C1) has to accelerate onto FK's swing, and at
 * 30 Hz it has three or four frames to do it in.
 *
 * THE BRAKING STEP (the toe-pivot walk's left toes, speeds 1, 1.2 and 1.5):
 * the released toes no longer go deeper under the floor than FK's own
 * (footContact liftReleasedForefoot) — drop, lowest point and frames under
 * the floor within 5c1c9ac's everywhere (male, speed 1, 60 Hz: 2.41 cm drop,
 * 0.68 cm under at the lowest, 2 frames more than 3 mm under, against 4.42,
 * 2.53, 5; ec3d0eb 4.52, 2.79, 6), and the knee under 5c1c9ac's everywhere.
 * NOT MET: the hip at 60 and 120 Hz — 5c1c9ac's toe chain stopped at the knee,
 * so its hip was FK's through every toe release; this one climbs to the hip
 * (toeContact: the knee stays a hinge) and its hip lags FK's by what the hold
 * turned it; and the ankle at 30 Hz, speed 1 — the release's first frames are
 * the hold carried on (C1), and this hold turns the ankle 24.35°/frame there —
 * and at 1.2 and 1.5, which the lift off the floor turns (the knee is what the
 * blend is short of, and lifting with it ran the knee 1.5–1.6× FK's peak).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadRigOf, type Rig } from './plantReleaseRig';
import { BRAKING, CURVED, measureAgainstMain, RATES, RIGS, worseThanMain } from './plantReleaseCases';

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
const CURVED_NOT_MET: Record<string, string> = {
  'male walk-t45 60 R_Foot@1037 accel': '32.9 mm/frame², 5c1c9ac 31.7',
  'male walk-t90 30 R_Foot@1037 accel': '80.4 mm/frame², 5c1c9ac 74.0',
  'male walk-t90 30 L_Foot@1609 accel': '66.3 mm/frame², 5c1c9ac 61.7',
  'male walk-t90 60 R_Foot@1037 accel': '36.1 mm/frame², 5c1c9ac 33.2',
  'male walk-t90 120 R_Foot@1037 accel': '12.3 mm/frame², 5c1c9ac 11.4',
  'male walk-t-90 30 R_Foot@1037 accel': '77.7 mm/frame², 5c1c9ac 76.4',
  'male walk-t-90 30 L_Foot@1609 hip': '6.19°/frame, 5c1c9ac 5.81, FK 4.87',
  'male walk-t-90 30 L_Foot@1609 accel': '78.8 mm/frame², 5c1c9ac 61.6',
  'male walk-t-90 60 R_Foot@1037 accel': '35.5 mm/frame², 5c1c9ac 33.6',
  'male walk-t-90 120 R_Foot@1037 accel': '12.4 mm/frame², 5c1c9ac 11.6',
  'male walk-t120 30 R_Foot@1037 accel': '92.5 mm/frame², 5c1c9ac 82.4',
  'male walk-t120 30 L_Foot@1609 hip': '6.28°/frame, 5c1c9ac 5.78, FK 4.87',
  'male walk-t120 30 L_Foot@1609 accel': '73.1 mm/frame², 5c1c9ac 62.2',
  'male walk-t120 60 R_Foot@1037 accel': '39.4 mm/frame², 5c1c9ac 35.6',
  'male walk-t120 120 R_Foot@1037 accel': '13.1 mm/frame², 5c1c9ac 12.0',
  'male fig8-1 30 R_Foot@1037 accel': '92.5 mm/frame², 5c1c9ac 82.4',
  'male fig8-1 30 L_Foot@1609 hip': '6.28°/frame, 5c1c9ac 5.78, FK 4.87',
  'male fig8-1 30 L_Foot@1609 accel': '73.1 mm/frame², 5c1c9ac 62.2',
  'male fig8-1 60 R_Foot@1037 accel': '39.4 mm/frame², 5c1c9ac 35.6',
  'male fig8-1 120 R_Foot@1037 accel': '13.1 mm/frame², 5c1c9ac 12.0',
  'male fig8-2 30 R_Foot@1157 hip': '9.48°/frame, 5c1c9ac 8.65, FK 5.15',
  'male fig8-2 60 R_Foot@1157 accel': '41.4 mm/frame², 5c1c9ac 38.5',
  'male fig8-2 120 R_Foot@1157 accel': '16.6 mm/frame², 5c1c9ac 15.7',
  'female walk-t45 60 R_Foot@1037 accel': '32.0 mm/frame², 5c1c9ac 31.3',
  'female walk-t90 30 R_Foot@1037 accel': '78.1 mm/frame², 5c1c9ac 71.2',
  'female walk-t90 30 L_Foot@1609 accel': '64.1 mm/frame², 5c1c9ac 59.4',
  'female walk-t90 60 R_Foot@1037 accel': '35.0 mm/frame², 5c1c9ac 32.1',
  'female walk-t-90 30 R_Foot@1037 accel': '75.7 mm/frame², 5c1c9ac 73.7',
  'female walk-t-90 30 L_Foot@1609 hip': '6.05°/frame, 5c1c9ac 5.76, FK 4.87',
  'female walk-t-90 30 L_Foot@1609 accel': '76.1 mm/frame², 5c1c9ac 59.4',
  'female walk-t-90 60 R_Foot@1037 accel': '34.5 mm/frame², 5c1c9ac 32.4',
  'female walk-t120 30 R_Foot@1037 accel': '89.5 mm/frame², 5c1c9ac 79.0',
  'female walk-t120 30 L_Foot@1609 hip': '6.15°/frame, 5c1c9ac 5.73, FK 4.87',
  'female walk-t120 30 L_Foot@1609 accel': '70.6 mm/frame², 5c1c9ac 60.0',
  'female walk-t120 60 R_Foot@1037 accel': '38.2 mm/frame², 5c1c9ac 34.3',
  'female walk-t120 120 R_Foot@1037 accel': '12.7 mm/frame², 5c1c9ac 11.6',
  'female fig8-1 30 R_Foot@1037 accel': '89.5 mm/frame², 5c1c9ac 79.0',
  'female fig8-1 30 L_Foot@1609 hip': '6.15°/frame, 5c1c9ac 5.73, FK 4.87',
  'female fig8-1 30 L_Foot@1609 accel': '70.6 mm/frame², 5c1c9ac 60.0',
  'female fig8-1 60 R_Foot@1037 accel': '38.2 mm/frame², 5c1c9ac 34.3',
  'female fig8-1 120 R_Foot@1037 accel': '12.7 mm/frame², 5c1c9ac 11.6',
  'female fig8-2 30 R_Foot@1157 hip': '9.47°/frame, 5c1c9ac 8.64, FK 5.15',
  'female fig8-2 60 R_Foot@1157 accel': '40.0 mm/frame², 5c1c9ac 37.0',
};
const BRAKING_NOT_MET: Record<string, string> = {
  'male toe 30 L_Toes@1724 ankle': '24.35°/frame, 5c1c9ac 18.79, FK 1.86',
  'male toe 60 L_Toes@1724 hip': '2.62°/frame, 5c1c9ac 2.41, FK 2.46',
  'male toe 120 L_Toes@1724 hip': '1.39°/frame, 5c1c9ac 1.21, FK 1.23',
  'male toe1.2 30 L_Toes@1574 ankle': '21.46°/frame, 5c1c9ac 18.27, FK 2.21',
  'male toe1.2 60 L_Toes@1574 hip': '3.29°/frame, 5c1c9ac 2.74, FK 2.80',
  'male toe1.2 60 L_Toes@1574 ankle': '13.67°/frame, 5c1c9ac 10.89, FK 1.12',
  'male toe1.2 120 L_Toes@1574 hip': '1.69°/frame, 5c1c9ac 1.38, FK 1.40',
  'male toe1.5 30 L_Toes@1408 ankle': '23.51°/frame, 5c1c9ac 20.55, FK 2.73',
  'male toe1.5 60 L_Toes@1408 hip': '4.05°/frame, 5c1c9ac 3.22, FK 3.28',
  'male toe1.5 60 L_Toes@1408 ankle': '16.15°/frame, 5c1c9ac 12.23, FK 1.40',
  'male toe1.5 120 L_Toes@1408 hip': '2.09°/frame, 5c1c9ac 1.63, FK 1.64',
  'male toe1.5 120 L_Toes@1408 ankle': '8.46°/frame, 5c1c9ac 6.55, FK 0.70',
  'female toe 120 L_Toes@1724 hip': '1.32°/frame, 5c1c9ac 1.21, FK 1.23',
  'female toe1.2 30 L_Toes@1574 ankle': '23.15°/frame, 5c1c9ac 17.74, FK 2.21',
  'female toe1.2 60 L_Toes@1574 hip': '3.28°/frame, 5c1c9ac 2.74, FK 2.80',
  'female toe1.2 60 L_Toes@1574 ankle': '11.64°/frame, 5c1c9ac 11.00, FK 1.12',
  'female toe1.2 120 L_Toes@1574 hip': '1.68°/frame, 5c1c9ac 1.38, FK 1.40',
  'female toe1.2 120 L_Toes@1574 ankle': '7.17°/frame, 5c1c9ac 6.03, FK 0.56',
  'female toe1.5 30 L_Toes@1408 hip': '6.57°/frame, 5c1c9ac 6.22, FK 6.42',
  'female toe1.5 30 L_Toes@1408 ankle': '24.54°/frame, 5c1c9ac 23.32, FK 2.73',
  'female toe1.5 60 L_Toes@1408 hip': '3.99°/frame, 5c1c9ac 3.22, FK 3.28',
  'female toe1.5 60 L_Toes@1408 ankle': '12.14°/frame, 5c1c9ac 9.55, FK 1.40',
  'female toe1.5 120 L_Toes@1408 hip': '2.23°/frame, 5c1c9ac 1.63, FK 1.64',
  'female toe1.5 120 L_Toes@1408 ankle': '8.44°/frame, 5c1c9ac 5.42, FK 0.70',
};

describe('the curved walks and the figure-eight: no joint faster than 5c1c9ac’s release or FK’s own peak, and the foot’s acceleration (documented where not met)', () => {
  for (const variant of RIGS) {
    for (const [key, motion] of Object.entries(CURVED)) {
      it(`${variant} ${key} at 30, 60 and 120 Hz`, () => {
        for (const hz of RATES) {
          const ours = measureAgainstMain(rigs[variant]!, key, motion, hz);
          const { compared, missing, worse } = worseThanMain('CURVED', variant, key, hz, ours);
          expect(missing, `${variant} ${key} @${hz} Hz: 5c1c9ac's releases, all released here`).toEqual([]);
          expect(compared.length, `${variant} ${key} @${hz} Hz: releases compared`).toBeGreaterThan(0);
          for (const [id, what] of worse) {
            // eslint-disable-next-line no-console
            console.log(`worse than 5c1c9ac: ${id} — ${what}${CURVED_NOT_MET[id] ? ' (documented)' : ''}`);
            expect(CURVED_NOT_MET[id], `${id}: ${what} — worse than 5c1c9ac, and not documented as unmet`).toBeDefined();
          }
        }
      }, 180_000);
    }
  }
});

describe('the braking step at speeds 1, 1.2 and 1.5: the toes no deeper, lower or longer under the floor than 5c1c9ac’s, the knee no faster (the hip and ankle documented where not met)', () => {
  for (const variant of RIGS) {
    for (const [key, motion] of Object.entries(BRAKING)) {
      it(`${variant} ${key} at 30, 60 and 120 Hz`, () => {
        for (const hz of RATES) {
          const ours = measureAgainstMain(rigs[variant]!, key, motion, hz);
          const { compared, missing, worse } = worseThanMain('BRAKING', variant, key, hz, ours);
          expect(missing, `${variant} ${key} @${hz} Hz: 5c1c9ac's releases, all released here`).toEqual([]);
          expect(compared.length, `${variant} ${key} @${hz} Hz: releases compared`).toBeGreaterThan(0);
          for (const [id, what] of worse) {
            // eslint-disable-next-line no-console
            console.log(`worse than 5c1c9ac: ${id} — ${what}${BRAKING_NOT_MET[id] ? ' (documented)' : ''}`);
            expect(BRAKING_NOT_MET[id], `${id}: ${what} — worse than 5c1c9ac, and not documented as unmet`).toBeDefined();
          }
        }
      }, 180_000);
    }
  }
});
