/**
 * THE WALKS' RELEASES AGAINST 5c1c9ac — the straight walk at 1, 1.2 and 1.5,
 * the heading-180 walk, the curved walks (45°, ±90°, 120°, and 90° at 0.8),
 * and the figure-eight played as its contract says: a chain, its second
 * segment a continuation of the first (sampleMotionChain). Every release into
 * swing, both rigs, 30 / 60 / 120 Hz.
 *
 * How (plantReleaseTrace): 5c1c9ac's releases are a fixture measured on that
 * tree by the same code. Each release is compared over a COMMON window — from
 * the window's end to the later of the two releases' ends — on each leg
 * joint's peak speed, its peak speed change, the effector's peak second
 * difference and the toes' and ankle's depth and frames under the floor over
 * the 300 ms after the window; and, separately, each joint's peak against this
 * tree's own FK over the same window, where 5c1c9ac stayed within its FK's.
 * At 30 Hz a speed change or second difference over 5c1c9ac's is the accepted
 * price of a C1 release (5c1c9ac's linear ramp reads there as a one-frame
 * kink) as long as every joint is within 5c1c9ac's speed; at 60 and 120 Hz it
 * counts. Whatever is worse is listed with the value measured
 * (fixtures/plantRelease.notMet.json), which it may match but not exceed, and
 * every listed entry must still be worse (the list is what the tree does).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRigOf, type Rig } from './plantReleaseRig';
import { expectNoWorseThanMain, GROUPS, mainFixture, RATES, RIGS, type MainGroup } from './plantReleaseCases';

const rigs: Partial<Record<(typeof RIGS)[number], Rig>> = {};

beforeAll(async () => {
  for (const variant of RIGS) rigs[variant] = await loadRigOf(variant);
}, 120_000);
// Each test here samples the rig synchronously for seconds. Yield to the
// event loop before each one: a file whose tests run over 60 s in all without
// a turn of it trips vitest's worker RPC timeout ("Timeout calling
// onTaskUpdate"), which fails the run although every test passed.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Worse than 5c1c9ac, as measured (fixtures/plantRelease.notMet.json:
 *  `rig case Hz release metric` → the value this tree measures). */
const NOT_MET: Record<string, number> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/plantRelease.notMet.json', import.meta.url)), 'utf8'),
) as Record<string, number>;

function compareGroup(groups: MainGroup[]): void {
  for (const group of groups) {
    for (const variant of RIGS) {
      for (const key of Object.keys(GROUPS[group])) {
        it(`${variant} ${key} at 30, 60 and 120 Hz`, () => {
          const fixture = mainFixture()[group]?.[key]?.[variant];
          expect(Object.keys(fixture ?? {}), `5c1c9ac measured ${variant} ${key} at every rate`).toEqual(RATES.map(String));
          const log = expectNoWorseThanMain(group, rigs[variant]!, key, NOT_MET);
          // eslint-disable-next-line no-console
          if (log.length) console.log(log.join('\n'));
        }, 300_000);
      }
    }
  }
}

describe('the walks and the chained figure-eight: every release no worse than 5c1c9ac’s over the same frames (documented, with its value, where not)', () => {
  compareGroup(['WALKS']);
});
