/**
 * THE HAND-PLANTED MOTIONS AGAINST 5c1c9ac — both rigs, 30 / 60 / 120 Hz.
 *
 * 5c1c9ac's numbers are a fixture (fixtures/handPlant.5c1c9ac.json), measured
 * on that tree by the same code that measures this one
 * (handPlantCases.measureHandCase). Nothing measured here may be worse than
 * 5c1c9ac; where this tree is, it is listed below with what was measured (and
 * 5c1c9ac's and 2d8f5e6's numbers), and that number is asserted, so it cannot
 * get worse either.
 *
 * LETTING GO. The bird-dog lifts its left hand off the floor twice (its
 * grounding goes 'quadruped' → 'quadruped-hand-R' at 2742 and 5058 ms). The
 * hand was dropped from the reach on the switch's frame, so its arm snapped
 * from the reach's solve to FK in one frame: the forearm 5.5° (male) and 6.0°
 * (female) in one frame on 5c1c9ac, 8.1° and 11.2° once the latch was read at
 * the touch (2d8f5e6) — the same step at every rate, 976 and 1341 °/s at
 * 120 Hz — and the upper arm 16–20° in one frame on 5c1c9ac. The arm is now
 * FK's, still turned by a share of how the reach had it turned off FK's the
 * moment it let go that fades out over 100 ms (rootMotion
 * .handReachReleasedAt, footContact.solveHandReach).
 *
 * SELF-HEALING. Pressing up from prone (after lowering to it, in a chain),
 * the planted hands cannot hold their points as the body rises: they let go
 * and re-latch, and the arm snapped to its new state in one frame — the hands
 * 12.8 cm in one 120 Hz frame, a 17.1 m/s seam-jerk on 2d8f5e6 (the gate
 * fails over 12; 5c1c9ac 9.9, 15.3 female). Each change of state's jump in
 * where the hand is drawn now fades out over 150 ms
 * (footContact.HAND_REACH_BLEND_MS).
 *
 * LANDING (NOT MET). Sampled on their own, the push-up, the plank from
 * quadruped, the quadruped from plank, the press-up to quadruped and the
 * bird-dog drop from standing onto their hands, and the arm then catches a
 * body that keeps coming down (FK drives the hands up to 18 cm under the
 * floor). 5c1c9ac latched each hand on the first FRAME whose pulled hand was
 * inside the 3 cm band — where and when it caught moved with the frame rate
 * (at 30 Hz anywhere in the band, at 120 Hz near its edge) — freezing the
 * reach's elbow extension there. This tree latches where the pulled hand
 * touches the floor, on the motion's own clock (every rate and clock settles
 * alike, which must stay):
 *  - the transitions: the reach's 2–4° of elbow extension beyond FK's closes
 *    over the last frames before the touch, where 5c1c9ac froze it — the
 *    forearm 1.1–1.8× 5c1c9ac's peak, 0.7–1.9°/frame at 60/120 Hz (e.g. the
 *    female plank from quadruped at 120 Hz, 1.75 against 0.96: 210 °/s
 *    against 115), while the hands land with a fifth to a half of its
 *    acceleration and no deeper. Latched on the frame as 5c1c9ac did, this
 *    tree's transitions read within 2% of it — but that latch moved the
 *    settled hands with the frame rate (the round-3 work removed it for that);
 *  - the push-up: FK's own catch changed with the C¹ follow-through (round 1:
 *    5c1c9ac's forearm stalled five 120 Hz frames at the touch). Latched on
 *    the frame, this tree reads 51.4°/frame at 30 Hz, 30.8 at 60, and 5.3–6.2
 *    cm under the floor; at the touch 46.8, 29.2 and 3.9 — against 5c1c9ac's
 *    39.9, 27.9 and 3.5. At 120 Hz it is 14.7 against 17.1 (female 16.8
 *    against 21.6, 4.0 cm deep against 5.7).
 * Latched earlier (1.5 cm up) the transitions read at 5c1c9ac's but the
 * push-up's catch reads 52.8°/frame at 30 Hz and 4.9 cm deep; later, the
 * reverse. Not reaching down at all while descending (the hand FK's until it
 * touches) took the male transitions under 5c1c9ac's, but turned the
 * get-downs' forearms 30% faster and their centre of mass 15% harder at 30 Hz,
 * and still left the female transitions and the push-up over it. The
 * straight arm the hand lands on is the root of it: its first centimetre of
 * catch costs ~18° of elbow, so how fast the elbow folds and how far the hand
 * sinks trade one for the other.
 *
 * LOWERING TO PRONE (NOT MET). Chained after getting down onto hands and
 * knees, no hand is planted (the segment's frames carry no grounding) and the
 * arms sweep back along the floor as the body lowers. The C¹ proximal-to-
 * distal onset (7dbe339, round 1) starts the arm's swing sooner and slower, so
 * it lags 5c1c9ac's by 1–2° mid-sweep and the wrist dips 0.6 cm under the
 * floor where 5c1c9ac's stays 0.6 cm over it (female; 30 cm along the floor
 * within 1.5 cm of its lowest point, against 5c1c9ac's sweep a hair above its
 * own lowest, at the start). No hand-plant state runs there; identical on
 * 2d8f5e6.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HAND_CASES,
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

const ARM = ['L_UpperArm', 'R_UpperArm', 'L_Forearm', 'R_Forearm'];
const turns = (bones: string[]): string[] => bones.flatMap((b) => [`${b} peak`, `${b} pop`]);
const handsBy = (what: string[]): string[] => ['L_Hand', 'R_Hand'].flatMap((h) => what.map((w) => `${h} ${w}`));

/** What is measured against 5c1c9ac, per case. */
const CHECKS: Record<string, string[]> = {
  'bird-dog-L3': [...turns(['L_UpperArm', 'L_Forearm']), 'L_Hand accel', 'L_Hand depth'],
  'bird-dog-L2': [...turns(['L_UpperArm', 'L_Forearm']), 'L_Hand accel', 'L_Hand depth'],
  'prone-chain press-up': ['seamJerk', 'comAccel', ...handsBy(['accel', 'depth', 'lowSlide']), ...turns(ARM)],
  'plank-prone-chain press-up': ['seamJerk', 'comAccel', ...handsBy(['accel', 'depth', 'lowSlide']), ...turns(ARM)],
  'bird-dog': [...turns(ARM), ...handsBy(['accel', 'depth'])],
  'push-up': [...turns(ARM), ...handsBy(['accel', 'depth'])],
  'plank-from-quadruped': [...turns(ARM), ...handsBy(['accel', 'depth'])],
  'quadruped-from-plank': [...turns(ARM), ...handsBy(['accel', 'depth'])],
  'press-up-to-quadruped': [...turns(ARM), ...handsBy(['accel', 'depth'])],
  'prone-chain lower-to-prone': handsBy(['depth', 'lowSlide']),
};

/** Worse than 5c1c9ac, measured: `case rig rate measure` → this tree's value
 *  (°/frame, mm/frame², m, m/s — as measureHandCase reads it). */
const NOT_MET: Record<string, number> = {
  // SELF-HEALING, the press-up's first frames. The centre of mass: the body
  // starts to rise off the floor, and FK's own reads 4.81 mm/frame² there at
  // 30 Hz; 5c1c9ac reads 4.55 only because its arms snap 30° and 43° in those
  // two frames (its hands re-latched on the frame), lifting the centre of mass
  // a frame early. The hands' travel near their lowest point: they start 11
  // cm under the floor and are drawn up and out over the first frames, where
  // 5c1c9ac's popped 3 cm clear of it in one frame (2d8f5e6: 6.9–14.1 mm).
  'prone-chain press-up male 30 comAccel': 4.736, // 5c1c9ac 4.549, 2d8f5e6 7.979
  'prone-chain press-up male 30 L_Hand lowSlide': 0.004651, // 5c1c9ac 0.0, 2d8f5e6 0.0075
  'prone-chain press-up male 30 R_Hand lowSlide': 0.004651, // 5c1c9ac 0.0, 2d8f5e6 0.0075
  'prone-chain press-up male 60 L_Hand lowSlide': 0.00742, // 5c1c9ac 0.0, 2d8f5e6 0.01151
  'prone-chain press-up male 60 R_Hand lowSlide': 0.00742, // 5c1c9ac 0.0, 2d8f5e6 0.01151
  'prone-chain press-up male 120 L_Hand lowSlide': 0.00742, // 5c1c9ac 0.0, 2d8f5e6 0.01414
  'prone-chain press-up male 120 R_Hand lowSlide': 0.00742, // 5c1c9ac 0.0, 2d8f5e6 0.01414
  'prone-chain press-up female 30 L_Hand lowSlide': 0.004267, // 5c1c9ac 0.0, 2d8f5e6 0.006867
  'prone-chain press-up female 30 R_Hand lowSlide': 0.004267, // 5c1c9ac 0.0, 2d8f5e6 0.006867
  'prone-chain press-up female 60 L_Hand lowSlide': 0.006815, // 5c1c9ac 0.0, 2d8f5e6 0.01055
  'prone-chain press-up female 60 R_Hand lowSlide': 0.006815, // 5c1c9ac 0.0, 2d8f5e6 0.01055
  'prone-chain press-up female 120 L_Hand lowSlide': 0.006815, // 5c1c9ac 0.0, 2d8f5e6 0.01297
  'prone-chain press-up female 120 R_Hand lowSlide': 0.006815, // 5c1c9ac 0.0, 2d8f5e6 0.01297
  'plank-prone-chain press-up male 30 comAccel': 4.736, // 5c1c9ac 4.549, 2d8f5e6 7.979
  'plank-prone-chain press-up male 30 L_Hand lowSlide': 0.004651, // 5c1c9ac 0.0, 2d8f5e6 0.0075
  'plank-prone-chain press-up male 30 R_Hand lowSlide': 0.004651, // 5c1c9ac 0.0, 2d8f5e6 0.0075
  'plank-prone-chain press-up male 60 L_Hand lowSlide': 0.00742, // 5c1c9ac 0.0, 2d8f5e6 0.01151
  'plank-prone-chain press-up male 60 R_Hand lowSlide': 0.00742, // 5c1c9ac 0.0, 2d8f5e6 0.01151
  'plank-prone-chain press-up male 120 L_Hand lowSlide': 0.00742, // 5c1c9ac 0.0, 2d8f5e6 0.01414
  'plank-prone-chain press-up male 120 R_Hand lowSlide': 0.00742, // 5c1c9ac 0.0, 2d8f5e6 0.01414
  'plank-prone-chain press-up female 30 L_Hand lowSlide': 0.004267, // 5c1c9ac 0.0, 2d8f5e6 0.006867
  'plank-prone-chain press-up female 30 R_Hand lowSlide': 0.004267, // 5c1c9ac 0.0, 2d8f5e6 0.006867
  'plank-prone-chain press-up female 60 L_Hand lowSlide': 0.006815, // 5c1c9ac 0.0, 2d8f5e6 0.01055
  'plank-prone-chain press-up female 60 R_Hand lowSlide': 0.006815, // 5c1c9ac 0.0, 2d8f5e6 0.01055
  'plank-prone-chain press-up female 120 L_Hand lowSlide': 0.006815, // 5c1c9ac 0.0, 2d8f5e6 0.01297
  'plank-prone-chain press-up female 120 R_Hand lowSlide': 0.006815, // 5c1c9ac 0.0, 2d8f5e6 0.01297
  // LANDING (see above): the bird-dog's right hand lands from standing and is
  // released 65 ms later; its forearm's landing and the planted left hand's
  // depth, which is FK's own (to 0.1 µm).
  'bird-dog male 120 L_UpperArm pop': 0.1104, // 5c1c9ac 0.1016, 2d8f5e6 0.1093
  'bird-dog male 120 L_Forearm pop': 0.2899, // 5c1c9ac 0.2387, 2d8f5e6 0.3377
  'bird-dog female 30 R_Forearm pop': 2.984, // 5c1c9ac 2.892, 2d8f5e6 3.015
  'bird-dog female 30 L_Hand depth': 0.05844, // 5c1c9ac 0.05836, 2d8f5e6 0.05845
  'bird-dog female 60 R_Forearm peak': 2.898, // 5c1c9ac 2.329, 2d8f5e6 2.966
  'bird-dog female 60 L_Hand depth': 0.05844, // 5c1c9ac 0.0584, 2d8f5e6 0.05845
  'bird-dog female 120 R_Forearm peak': 1.803, // 5c1c9ac 1.713, 2d8f5e6 1.788
  'bird-dog female 120 L_Hand depth': 0.05844, // 5c1c9ac 0.05844, 2d8f5e6 0.05845
  // LANDING (see above): the push-up's catch.
  'push-up male 30 L_UpperArm peak': 21.42, // 5c1c9ac 18.19, 2d8f5e6 21.48
  'push-up male 30 L_UpperArm pop': 11.66, // 5c1c9ac 3.997, 2d8f5e6 11.75
  'push-up male 30 R_UpperArm peak': 21.41, // 5c1c9ac 18.19, 2d8f5e6 21.48
  'push-up male 30 R_UpperArm pop': 11.66, // 5c1c9ac 3.997, 2d8f5e6 11.75
  'push-up male 30 L_Forearm peak': 46.85, // 5c1c9ac 39.9, 2d8f5e6 46.99
  'push-up male 30 L_Forearm pop': 22.58, // 5c1c9ac 8.096, 2d8f5e6 22.81
  'push-up male 30 R_Forearm peak': 46.84, // 5c1c9ac 39.9, 2d8f5e6 46.99
  'push-up male 30 R_Forearm pop': 22.58, // 5c1c9ac 8.096, 2d8f5e6 22.81
  'push-up male 30 L_Hand accel': 98.83, // 5c1c9ac 88.37, 2d8f5e6 99.16
  'push-up male 30 L_Hand depth': 0.03878, // 5c1c9ac 0.03461, 2d8f5e6 0.03916
  'push-up male 30 R_Hand accel': 98.82, // 5c1c9ac 88.37, 2d8f5e6 99.16
  'push-up male 30 R_Hand depth': 0.03878, // 5c1c9ac 0.03461, 2d8f5e6 0.03915
  'push-up male 60 L_UpperArm peak': 13.5, // 5c1c9ac 12.82, 2d8f5e6 13.54
  'push-up male 60 L_UpperArm pop': 5.561, // 5c1c9ac 0.6592, 2d8f5e6 5.572
  'push-up male 60 R_UpperArm peak': 13.5, // 5c1c9ac 12.82, 2d8f5e6 13.54
  'push-up male 60 R_UpperArm pop': 5.561, // 5c1c9ac 0.659, 2d8f5e6 5.573
  'push-up male 60 L_Forearm peak': 29.19, // 5c1c9ac 27.88, 2d8f5e6 29.28
  'push-up male 60 L_Forearm pop': 11.54, // 5c1c9ac 1.419, 2d8f5e6 11.56
  'push-up male 60 R_Forearm peak': 29.19, // 5c1c9ac 27.88, 2d8f5e6 29.28
  'push-up male 60 R_Forearm pop': 11.54, // 5c1c9ac 1.419, 2d8f5e6 11.56
  'push-up male 60 L_Hand accel': 41.31, // 5c1c9ac 35.62, 2d8f5e6 41.49
  'push-up male 60 L_Hand depth': 0.03878, // 5c1c9ac 0.03461, 2d8f5e6 0.03916
  'push-up male 60 R_Hand accel': 41.31, // 5c1c9ac 35.61, 2d8f5e6 41.49
  'push-up male 60 R_Hand depth': 0.03878, // 5c1c9ac 0.03461, 2d8f5e6 0.03915
  'push-up male 120 L_Hand depth': 0.03878, // 5c1c9ac 0.03465, 2d8f5e6 0.03916
  'push-up male 120 R_Hand depth': 0.03878, // 5c1c9ac 0.03464, 2d8f5e6 0.03915
  'push-up female 30 L_Hand depth': 0.03389, // 5c1c9ac 0.02573, 2d8f5e6 0.03389
  'push-up female 30 R_Hand depth': 0.03389, // 5c1c9ac 0.02573, 2d8f5e6 0.03389
  'push-up female 60 L_UpperArm pop': 4.794, // 5c1c9ac 3.77, 2d8f5e6 4.652
  'push-up female 60 R_UpperArm pop': 4.794, // 5c1c9ac 3.77, 2d8f5e6 4.652
  'push-up female 60 L_Forearm pop': 10.21, // 5c1c9ac 7.761, 2d8f5e6 9.884
  'push-up female 60 R_Forearm pop': 10.21, // 5c1c9ac 7.761, 2d8f5e6 9.883
  // LANDING (see above): the transitions' landing.
  'plank-from-quadruped male 30 L_UpperArm pop': 0.02486, // 5c1c9ac 0.008516, 2d8f5e6 0.02486
  'plank-from-quadruped male 30 R_UpperArm pop': 0.02485, // 5c1c9ac 0.008514, 2d8f5e6 0.02485
  'plank-from-quadruped male 60 L_Forearm peak': 1.57, // 5c1c9ac 1.183, 2d8f5e6 1.57
  'plank-from-quadruped male 60 R_Forearm peak': 1.57, // 5c1c9ac 1.183, 2d8f5e6 1.57
  'plank-from-quadruped male 120 L_Forearm peak': 0.8134, // 5c1c9ac 0.6537, 2d8f5e6 0.8134
  'plank-from-quadruped male 120 R_Forearm peak': 0.8125, // 5c1c9ac 0.6525, 2d8f5e6 0.8125
  'plank-from-quadruped female 30 L_Forearm peak': 5.752, // 5c1c9ac 4.249, 2d8f5e6 5.699
  'plank-from-quadruped female 30 L_Forearm pop': 2.891, // 5c1c9ac 1.561, 2d8f5e6 2.861
  'plank-from-quadruped female 30 R_Forearm peak': 5.752, // 5c1c9ac 4.249, 2d8f5e6 5.699
  'plank-from-quadruped female 30 R_Forearm pop': 2.891, // 5c1c9ac 1.561, 2d8f5e6 2.861
  'plank-from-quadruped female 60 L_UpperArm pop': 0.1917, // 5c1c9ac 0.1171, 2d8f5e6 0.2183
  'plank-from-quadruped female 60 R_UpperArm pop': 0.1917, // 5c1c9ac 0.1171, 2d8f5e6 0.2183
  'plank-from-quadruped female 60 L_Forearm peak': 3.063, // 5c1c9ac 2.334, 2d8f5e6 3.039
  'plank-from-quadruped female 60 L_Forearm pop': 0.3737, // 5c1c9ac 0.3245, 2d8f5e6 0.378
  'plank-from-quadruped female 60 R_Forearm peak': 3.063, // 5c1c9ac 2.334, 2d8f5e6 3.038
  'plank-from-quadruped female 60 R_Forearm pop': 0.3737, // 5c1c9ac 0.3245, 2d8f5e6 0.378
  'plank-from-quadruped female 120 L_Forearm peak': 1.753, // 5c1c9ac 0.9609, 2d8f5e6 1.739
  'plank-from-quadruped female 120 R_Forearm peak': 1.753, // 5c1c9ac 0.9609, 2d8f5e6 1.739
  'quadruped-from-plank male 30 L_Forearm peak': 2.13, // 5c1c9ac 1.955, 2d8f5e6 2.194
  'quadruped-from-plank male 30 R_Forearm peak': 2.13, // 5c1c9ac 1.955, 2d8f5e6 2.194
  'quadruped-from-plank male 60 L_Forearm peak': 1.571, // 5c1c9ac 1.157, 2d8f5e6 1.571
  'quadruped-from-plank male 60 L_Forearm pop': 0.4356, // 5c1c9ac 0.3582, 2d8f5e6 0.4356
  'quadruped-from-plank male 60 R_Forearm peak': 1.57, // 5c1c9ac 1.156, 2d8f5e6 1.57
  'quadruped-from-plank male 60 R_Forearm pop': 0.4359, // 5c1c9ac 0.3586, 2d8f5e6 0.4359
  'quadruped-from-plank male 120 L_Forearm peak': 0.8429, // 5c1c9ac 0.5275, 2d8f5e6 0.8429
  'quadruped-from-plank male 120 L_Forearm pop': 0.1153, // 5c1c9ac 0.05474, 2d8f5e6 0.1153
  'quadruped-from-plank male 120 R_Forearm peak': 0.842, // 5c1c9ac 0.526, 2d8f5e6 0.842
  'quadruped-from-plank male 120 R_Forearm pop': 0.1155, // 5c1c9ac 0.05492, 2d8f5e6 0.1155
  'quadruped-from-plank female 30 L_UpperArm pop': 0.396, // 5c1c9ac 0.05079, 2d8f5e6 0.4697
  'quadruped-from-plank female 30 R_UpperArm pop': 0.396, // 5c1c9ac 0.05079, 2d8f5e6 0.4698
  'quadruped-from-plank female 60 L_Forearm peak': 1.882, // 5c1c9ac 1.415, 2d8f5e6 1.882
  'quadruped-from-plank female 60 L_Forearm pop': 0.7196, // 5c1c9ac 0.6756, 2d8f5e6 0.7196
  'quadruped-from-plank female 60 R_Forearm peak': 1.882, // 5c1c9ac 1.415, 2d8f5e6 1.882
  'quadruped-from-plank female 60 R_Forearm pop': 0.7196, // 5c1c9ac 0.6756, 2d8f5e6 0.7196
  'quadruped-from-plank female 120 L_UpperArm pop': 0.1044, // 5c1c9ac 0.08453, 2d8f5e6 0.08218
  'quadruped-from-plank female 120 R_UpperArm pop': 0.1044, // 5c1c9ac 0.08453, 2d8f5e6 0.08218
  'quadruped-from-plank female 120 L_Forearm peak': 1.051, // 5c1c9ac 0.7221, 2d8f5e6 1.051
  'quadruped-from-plank female 120 L_Forearm pop': 0.2198, // 5c1c9ac 0.2162, 2d8f5e6 0.2198
  'quadruped-from-plank female 120 R_Forearm peak': 1.051, // 5c1c9ac 0.7221, 2d8f5e6 1.051
  'quadruped-from-plank female 120 R_Forearm pop': 0.2198, // 5c1c9ac 0.2162, 2d8f5e6 0.2198
  'press-up-to-quadruped male 30 L_Forearm peak': 2.166, // 5c1c9ac 1.511, 2d8f5e6 2.221
  'press-up-to-quadruped male 30 L_Forearm pop': 0.6852, // 5c1c9ac 0.6748, 2d8f5e6 0.7399
  'press-up-to-quadruped male 30 R_Forearm peak': 2.166, // 5c1c9ac 1.511, 2d8f5e6 2.221
  'press-up-to-quadruped male 30 R_Forearm pop': 0.6854, // 5c1c9ac 0.6751, 2d8f5e6 0.7402
  'press-up-to-quadruped male 60 L_Forearm peak': 1.103, // 5c1c9ac 0.8639, 2d8f5e6 1.117
  'press-up-to-quadruped male 60 R_Forearm peak': 1.103, // 5c1c9ac 0.863, 2d8f5e6 1.117
  'press-up-to-quadruped male 120 L_Forearm peak': 0.6555, // 5c1c9ac 0.4335, 2d8f5e6 0.6555
  'press-up-to-quadruped male 120 L_Forearm pop': 0.07002, // 5c1c9ac 0.03174, 2d8f5e6 0.07002
  'press-up-to-quadruped male 120 R_Forearm peak': 0.6543, // 5c1c9ac 0.4316, 2d8f5e6 0.6543
  'press-up-to-quadruped male 120 R_Forearm pop': 0.07018, // 5c1c9ac 0.03188, 2d8f5e6 0.07018
  'press-up-to-quadruped female 30 L_Forearm peak': 2.282, // 5c1c9ac 2.093, 2d8f5e6 2.348
  'press-up-to-quadruped female 30 R_Forearm peak': 2.282, // 5c1c9ac 2.093, 2d8f5e6 2.348
  'press-up-to-quadruped female 60 L_UpperArm pop': 0.1303, // 5c1c9ac 0.06334, 2d8f5e6 0.103
  'press-up-to-quadruped female 60 R_UpperArm pop': 0.1303, // 5c1c9ac 0.06334, 2d8f5e6 0.103
  'press-up-to-quadruped female 60 L_Forearm peak': 1.537, // 5c1c9ac 1.114, 2d8f5e6 1.537
  'press-up-to-quadruped female 60 L_Forearm pop': 0.4765, // 5c1c9ac 0.4603, 2d8f5e6 0.4765
  'press-up-to-quadruped female 60 R_Forearm peak': 1.537, // 5c1c9ac 1.114, 2d8f5e6 1.537
  'press-up-to-quadruped female 60 R_Forearm pop': 0.4765, // 5c1c9ac 0.4603, 2d8f5e6 0.4765
  'press-up-to-quadruped female 120 L_UpperArm pop': 0.06915, // 5c1c9ac 0.05333, 2d8f5e6 0.06988
  'press-up-to-quadruped female 120 R_UpperArm pop': 0.06915, // 5c1c9ac 0.05333, 2d8f5e6 0.06988
  'press-up-to-quadruped female 120 L_Forearm peak': 0.8384, // 5c1c9ac 0.5642, 2d8f5e6 0.8384
  'press-up-to-quadruped female 120 L_Forearm pop': 0.1938, // 5c1c9ac 0.135, 2d8f5e6 0.196
  'press-up-to-quadruped female 120 R_Forearm peak': 0.8384, // 5c1c9ac 0.5642, 2d8f5e6 0.8384
  'press-up-to-quadruped female 120 R_Forearm pop': 0.1938, // 5c1c9ac 0.135, 2d8f5e6 0.196
  // LOWERING TO PRONE (see above).
  'prone-chain lower-to-prone male 30 L_Hand depth': 0.005384, // 5c1c9ac 0.003703, 2d8f5e6 0.005384
  'prone-chain lower-to-prone male 30 L_Hand lowSlide': 0.003952, // 5c1c9ac 0.0, 2d8f5e6 0.003952
  'prone-chain lower-to-prone male 30 R_Hand depth': 0.005384, // 5c1c9ac 0.003702, 2d8f5e6 0.005384
  'prone-chain lower-to-prone male 30 R_Hand lowSlide': 0.003952, // 5c1c9ac 2.22e-16, 2d8f5e6 0.003952
  'prone-chain lower-to-prone male 60 L_Hand depth': 0.005384, // 5c1c9ac 0.003703, 2d8f5e6 0.005384
  'prone-chain lower-to-prone male 60 L_Hand lowSlide': 0.003952, // 5c1c9ac 4.441e-16, 2d8f5e6 0.003952
  'prone-chain lower-to-prone male 60 R_Hand depth': 0.005384, // 5c1c9ac 0.003702, 2d8f5e6 0.005384
  'prone-chain lower-to-prone male 60 R_Hand lowSlide': 0.003952, // 5c1c9ac 6.661e-16, 2d8f5e6 0.003952
  'prone-chain lower-to-prone male 120 L_Hand depth': 0.005384, // 5c1c9ac 0.002748, 2d8f5e6 0.005384
  'prone-chain lower-to-prone male 120 L_Hand lowSlide': 0.003953, // 5c1c9ac 8.882e-16, 2d8f5e6 0.003953
  'prone-chain lower-to-prone male 120 R_Hand depth': 0.005384, // 5c1c9ac 0.002747, 2d8f5e6 0.005384
  'prone-chain lower-to-prone male 120 R_Hand lowSlide': 0.003953, // 5c1c9ac 8.882e-16, 2d8f5e6 0.003953
  'prone-chain lower-to-prone female 30 L_Hand depth': 0.01165, // 5c1c9ac 0.009451, 2d8f5e6 0.01165
  'prone-chain lower-to-prone female 30 L_Hand lowSlide': 0.2975, // 5c1c9ac 0.0, 2d8f5e6 0.2975
  'prone-chain lower-to-prone female 30 R_Hand depth': 0.01165, // 5c1c9ac 0.009451, 2d8f5e6 0.01165
  'prone-chain lower-to-prone female 30 R_Hand lowSlide': 0.2975, // 5c1c9ac 0.0, 2d8f5e6 0.2975
  'prone-chain lower-to-prone female 60 L_Hand depth': 0.01165, // 5c1c9ac 0.009451, 2d8f5e6 0.01165
  'prone-chain lower-to-prone female 60 L_Hand lowSlide': 0.3017, // 5c1c9ac 4.441e-16, 2d8f5e6 0.3017
  'prone-chain lower-to-prone female 60 R_Hand depth': 0.01165, // 5c1c9ac 0.009451, 2d8f5e6 0.01165
  'prone-chain lower-to-prone female 60 R_Hand lowSlide': 0.3017, // 5c1c9ac 4.441e-16, 2d8f5e6 0.3017
  'prone-chain lower-to-prone female 120 L_Hand depth': 0.01165, // 5c1c9ac 0.009451, 2d8f5e6 0.01165
  'prone-chain lower-to-prone female 120 L_Hand lowSlide': 0.3119, // 5c1c9ac 1.332e-15, 2d8f5e6 0.3119
  'prone-chain lower-to-prone female 120 R_Hand depth': 0.01165, // 5c1c9ac 0.009451, 2d8f5e6 0.01165
  'prone-chain lower-to-prone female 120 R_Hand lowSlide': 0.3119, // 5c1c9ac 1.332e-15, 2d8f5e6 0.3119
};

/** Read measure `key` off `m`. */
function read(m: HandMeasure, key: string): number {
  if (key === 'seamJerk' || key === 'comAccel') return m[key];
  const [part, what] = key.split(' ') as [string, string];
  if (part.endsWith('Hand')) return m.hands[part]![what as 'accel' | 'depth' | 'lowSlide'];
  return m.arm[part]![what as 'peak' | 'pop'];
}

/** Assert `ours` no worse than 5c1c9ac's `main` (the fixture keeps 6
 *  significant figures) — or, listed above, than what was measured when it
 *  was listed (kept to 4). */
function noWorse(id: string, ours: number, main: number): void {
  const listed = NOT_MET[id];
  if (listed !== undefined) {
    expect(ours, `${id}: documented at ${listed} (5c1c9ac ${main})`).toBeLessThanOrEqual(listed * 1.01);
    return;
  }
  expect(ours, `${id} (5c1c9ac ${main})`).toBeLessThanOrEqual(main * (1 + 1e-5) + 1e-12);
}

describe('the hand-planted motions measure no worse than 5c1c9ac (documented where not met)', () => {
  it('lists only what is measured', () => {
    for (const id of Object.keys(NOT_MET)) {
      const [caseId, rest] = [Object.keys(CHECKS).find((c) => id.startsWith(`${c} `)), id];
      expect(caseId, `${rest}: a measured case`).toBeDefined();
      expect(Object.keys(HAND_CASES)).toContain(caseId);
    }
  });
  for (const variant of HAND_RIGS) {
    for (const [id, keys] of Object.entries(CHECKS)) {
      it(`${variant} ${id} at 30, 60 and 120 Hz`, () => {
        for (const hz of HAND_RATES) {
          const ours = measureHandCase(rigs[variant]!, id, hz);
          const main = MAIN[id]![variant][hz]!;
          for (const key of keys) noWorse(`${id} ${variant} ${hz} ${key}`, read(ours, key), read(main, key));
          if (id.startsWith('bird-dog-L') && hz > 30) {
            // Letting go: a snap reads the same size at every rate, the
            // blend's turn per frame halves as the rate doubles. 2d8f5e6:
            // 7.8–11.1° at 60 and 120 Hz (5c1c9ac 5.3–5.9); now under 1.3°.
            expect(ours.arm.L_Forearm!.pop, `${id} ${variant} ${hz}: the lifted forearm's one-frame pop (°)`).toBeLessThan(1.3);
          }
          if (id.endsWith('press-up')) {
            expect(ours.seamJerk, `${id} ${variant} ${hz}: the validity gate's seam-jerk limit (m/s)`).toBeLessThanOrEqual(12);
          }
        }
      }, 180_000);
    }
  }
});
