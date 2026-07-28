/**
 * PUBLIC baseOfSupport ↔ LIVE scoring parity.
 *
 * The exported `baseOfSupport` was feet-only while the live scoring path
 * (`collectBase` → `computeBalanceState` / `computeBalanceTimeline`) unioned feet
 * PLUS bearing hands and knees. Same name, same concept, two different polygons —
 * so any caller of the public API got a strictly NARROWER base than the engine
 * actually scores with, for exactly the postures (plank / push-up / quadruped /
 * kneel) where hands and knees ARE the base.
 *
 * Both now go through one assembler and one contact model. These tests pin that.
 */
import { describe, expect, it } from 'vitest';
import {
  baseOfSupport,
  marginOfStability,
  type FootContactXZ,
  type GroundContactXZ,
} from '../services/centerOfMass';

/** Two flat feet, ~20 cm apart, heels at z=0 and toes forward. */
const standingFeet = (contact = true): FootContactXZ[] => [
  { key: 'L_Foot', ankle: [-0.1, 0], toe: [-0.1, 0.18], ankleY: 0, contact },
  { key: 'R_Foot', ankle: [0.1, 0], toe: [0.1, 0.18], ankleY: 0, contact },
];

/** Two hands planted well forward of the feet — the plank/push-up shape. */
const plantedHands = (contact = true): GroundContactXZ[] => [
  { key: 'L_Hand', xz: [-0.2, -0.9], half: 0.05, contact },
  { key: 'R_Hand', xz: [0.2, -0.9], half: 0.05, contact },
];

const area = (poly: [number, number][]): number => {
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
};

describe('baseOfSupport — feet-only remains the default', () => {
  it('omitting `others` reproduces the historical feet-only base', () => {
    const base = baseOfSupport(standingFeet(), 0);
    expect(base.airborne).toBe(false);
    expect(base.contacts.sort()).toEqual(['L_Foot', 'R_Foot']);
    expect(base.polygon.length).toBeGreaterThanOrEqual(3);
  });

  it('no bearing contact at all is airborne', () => {
    expect(baseOfSupport(standingFeet(false), 0).airborne).toBe(true);
    expect(baseOfSupport([], 0).airborne).toBe(true);
    expect(marginOfStability([0, 0], baseOfSupport([], 0))).toBeNull();
  });

  it('a non-bearing foot does not contribute', () => {
    const oneUp: FootContactXZ[] = [
      { key: 'L_Foot', ankle: [-0.1, 0], toe: [-0.1, 0.18], ankleY: 0, contact: true },
      { key: 'R_Foot', ankle: [0.1, 0], toe: [0.1, 0.18], ankleY: 0.3, contact: false },
    ];
    expect(baseOfSupport(oneUp, 0).contacts).toEqual(['L_Foot']);
  });
});

describe('baseOfSupport — bearing hands widen the base, as the live path already did', () => {
  it('hands enlarge the polygon rather than being ignored', () => {
    const feetOnly = baseOfSupport(standingFeet(), 0);
    const withHands = baseOfSupport(standingFeet(), 0, plantedHands());
    expect(area(withHands.polygon)).toBeGreaterThan(area(feetOnly.polygon));
    expect(withHands.contacts.sort()).toEqual(['L_Foot', 'L_Hand', 'R_Foot', 'R_Hand']);
  });

  it('THE REGRESSION: a plank CoM reads inside the real base and outside the feet-only one', () => {
    // A plank's CoM projects forward of the feet, between hands and feet. The
    // feet-only base called that a topple; the real base contains it.
    const com: [number, number] = [0, -0.45];
    const feetOnly = baseOfSupport(standingFeet(), 0);
    const withHands = baseOfSupport(standingFeet(), 0, plantedHands());

    expect(marginOfStability(com, feetOnly)!).toBeLessThan(0); // phantom "off balance"
    expect(marginOfStability(com, withHands)!).toBeGreaterThan(0); // the truth
  });

  it('non-bearing hands (arms in the air) do not widen anything', () => {
    const lifted = baseOfSupport(standingFeet(), 0, plantedHands(false));
    const feetOnly = baseOfSupport(standingFeet(), 0);
    expect(lifted.contacts.sort()).toEqual(feetOnly.contacts.sort());
    expect(area(lifted.polygon)).toBeCloseTo(area(feetOnly.polygon), 6);
  });

  it('hands alone bear the body when the feet are lifted (a handstand-like base)', () => {
    const handsOnly = baseOfSupport(standingFeet(false), 0, plantedHands());
    expect(handsOnly.airborne).toBe(false);
    expect(handsOnly.contacts.sort()).toEqual(['L_Hand', 'R_Hand']);
  });
});
