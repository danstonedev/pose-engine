/**
 * THE FOREFOOT RELEASES AGAINST 5c1c9ac — DDx's walk for James (two cycles of
 * the 0.85 walk, each stance held by its ankle and then by its forefoot until
 * the toes lift: ddxJamesWalk, as DDx builds it) and the toe-pivot walk (DDx's
 * hold pattern on the engine's walk) at 0.6, 0.85, 1, 1.2 and 1.5 of its pace:
 * its toe-offs and its braking step (the left toes' release, which the route
 * leaves far behind). Every release into swing, both rigs, 30 / 60 / 120 Hz,
 * measured and compared as in plantReleaseMain.test.ts.
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

describe('DDx’s walk and the toe-pivot walks: every release no worse than 5c1c9ac’s over the same frames (documented, with its value, where not)', () => {
  compareGroup(['TOES']);
});
