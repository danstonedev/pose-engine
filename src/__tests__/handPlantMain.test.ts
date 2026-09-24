/**
 * THE HAND-PLANTED MOTIONS AGAINST 5c1c9ac — both rigs, 30 / 60 / 120 Hz.
 *
 * 5c1c9ac's numbers are a fixture (fixtures/handPlant.5c1c9ac.json), measured
 * on that tree by the same code that measures this one
 * (handPlantCases.measureHandCase). Nothing here may be worse than 5c1c9ac;
 * where this tree is, it is listed below with what was measured, and that
 * number is asserted.
 *
 * LETTING GO. The bird-dog lifts its left hand off the floor twice (its
 * grounding goes 'quadruped' → 'quadruped-hand-R' at 2742 and 5058 ms). The
 * hand was dropped from the reach on the switch's frame, so its arm snapped
 * from the reach's solve to FK in one frame: the forearm 5.5° (male) and 6.0°
 * (female) in one frame on 5c1c9ac, 8.1° and 11.2° once the latch was read at
 * the touch (2d8f5e6) — the same step at every rate, 976 and 1341 °/s at
 * 120 Hz — and the upper arm 16–20° in one frame on 5c1c9ac. The arm is now
 * blended back from how the reach drew it when it let go to FK over 100 ms
 * (rootMotion.handReachReleasedAt, footContact.solveHandReach).
 *
 * SELF-HEALING. Pressing up from prone (after lowering to it, in a chain),
 * the planted hands cannot hold their points as the body rises: they let go
 * and re-latch, and the arm snapped to its new state in one frame — the hands
 * 12.8 cm in one 120 Hz frame, a 17.1 m/s seam-jerk on 2d8f5e6 (the gate
 * fails over 12; 5c1c9ac 9.9, 15.3 female). Each change of state's jump in
 * where the hand is drawn now fades out over 150 ms
 * (footContact.HAND_REACH_BLEND_MS).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HAND_RATES,
  HAND_RIGS,
  loadHandRig,
  measureHandCase,
  type HandMeasure,
  type HandRig,
  type HandRigVariant,
} from './handPlantCases';

const rigs: Partial<Record<HandRigVariant, HandRig>> = {};

beforeAll(async () => {
  for (const variant of HAND_RIGS) rigs[variant] = await loadHandRig(variant);
}, 120_000);
// Each test here samples the rig synchronously for seconds. Yield to the
// event loop before each one: a file whose tests run over 60 s in all without
// a turn of it trips vitest's worker RPC timeout ("Timeout calling
// onTaskUpdate"), which fails the run although every test passed.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

type Fixture = Record<string, Record<HandRigVariant, Record<string, HandMeasure>>>;
const MAIN: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/handPlant.5c1c9ac.json', import.meta.url)), 'utf8'),
);

/** Worse than 5c1c9ac, measured: `case rig rate measure` → this tree's value. */
const NOT_MET: Record<string, number> = {
  // The press-up's first frames: the body starts to rise off the floor, and
  // FK's own centre of mass reads 4.81 mm/frame² there at 30 Hz. 5c1c9ac reads
  // 4.55 only because its arms snap 30° and 43° in those two frames (the
  // hands re-latched on the frame), lifting the centre of mass a frame early.
  'prone-chain press-up male 30 comAccel': 4.74,
  'plank-prone-chain press-up male 30 comAccel': 4.74,
};

/** Assert `ours` no worse than 5c1c9ac's `main` — or, listed above, than
 *  what was measured when it was listed. */
function noWorse(id: string, ours: number, main: number): void {
  const listed = NOT_MET[id];
  // eslint-disable-next-line no-console
  if (ours > main) console.log(`worse than 5c1c9ac: ${id} ${ours.toFixed(3)} (5c1c9ac ${main.toFixed(3)})${listed !== undefined ? ' — documented' : ''}`);
  if (listed !== undefined) {
    expect(ours, `${id}: documented at ${listed} (5c1c9ac ${main})`).toBeLessThanOrEqual(listed * 1.01);
    return;
  }
  expect(ours, `${id} (5c1c9ac ${main})`).toBeLessThanOrEqual(main);
}

describe('letting go: the bird-dog’s lifted arm turns no faster, and pops no more, than 5c1c9ac’s', () => {
  for (const variant of HAND_RIGS) {
    for (const id of ['bird-dog-L3', 'bird-dog-L2']) {
      it(`${variant} ${id} at 30, 60 and 120 Hz`, () => {
        for (const hz of HAND_RATES) {
          const ours = measureHandCase(rigs[variant]!, id, hz);
          const main = MAIN[id]![variant][hz]!;
          for (const bone of ['L_UpperArm', 'L_Forearm']) {
            noWorse(`${id} ${variant} ${hz} ${bone} peak`, ours.arm[bone]!.peak, main.arm[bone]!.peak);
            noWorse(`${id} ${variant} ${hz} ${bone} pop`, ours.arm[bone]!.pop, main.arm[bone]!.pop);
          }
          noWorse(`${id} ${variant} ${hz} L_Hand accel`, ours.hands.L_Hand!.accel, main.hands.L_Hand!.accel);
          noWorse(`${id} ${variant} ${hz} L_Hand depth`, ours.hands.L_Hand!.depth, main.hands.L_Hand!.depth);
          // A snap reads the same size at every rate; the blend's turn per
          // frame halves as the rate doubles. 2d8f5e6: 7.8–11.1° at 60 and
          // 120 Hz (5c1c9ac 5.3–5.9); now under 1.3°.
          if (hz > 30) expect(ours.arm.L_Forearm!.pop, `${id} ${variant} ${hz}: the forearm's one-frame pop (°)`).toBeLessThan(1.3);
        }
      }, 180_000);
    }
  }
});

describe('self-healing: the prone chain’s press-up hands do not jump — seam-jerk, hands, centre of mass and arms no worse than 5c1c9ac’s', () => {
  for (const variant of HAND_RIGS) {
    for (const id of ['prone-chain press-up', 'plank-prone-chain press-up']) {
      it(`${variant} ${id} at 30, 60 and 120 Hz`, () => {
        for (const hz of HAND_RATES) {
          const ours = measureHandCase(rigs[variant]!, id, hz);
          const main = MAIN[id]![variant][hz]!;
          noWorse(`${id} ${variant} ${hz} seamJerk`, ours.seamJerk, main.seamJerk);
          expect(ours.seamJerk, `${id} ${variant} ${hz}: the validity gate's seam-jerk limit (m/s)`).toBeLessThanOrEqual(12);
          noWorse(`${id} ${variant} ${hz} comAccel`, ours.comAccel, main.comAccel);
          for (const hand of ['L_Hand', 'R_Hand']) {
            noWorse(`${id} ${variant} ${hz} ${hand} accel`, ours.hands[hand]!.accel, main.hands[hand]!.accel);
            noWorse(`${id} ${variant} ${hz} ${hand} depth`, ours.hands[hand]!.depth, main.hands[hand]!.depth);
          }
          for (const bone of ['L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm']) {
            noWorse(`${id} ${variant} ${hz} ${bone} peak`, ours.arm[bone]!.peak, main.arm[bone]!.peak);
            noWorse(`${id} ${variant} ${hz} ${bone} pop`, ours.arm[bone]!.pop, main.arm[bone]!.pop);
          }
        }
      }, 180_000);
    }
  }
});
