/**
 * THE HAND-OVER — the root's travel while the support passes from one foot to
 * the other (deriveFootDrivenTravel), and the touchdown-planted gait that keeps
 * it moving (ComposedMotion.plantOnTouchdown).
 *
 * By default the sample that switches feet advances nothing: on a two-cycle
 * 0.85-speed walk the pelvis stopped for a whole 33 ms frame at every hand-over
 * (0.37 and 0.25 cm against ~4.1) and then lurched 5.8 cm. The stall is the one
 * advance consistent with plants captured at their PLANNED window start, while
 * the landing foot is still in the air — every centimetre past that point is
 * dragged back by the leg IK. A touchdown-planted gait removes it at the root:
 * each hold starts where its foot comes down, the point on the floor stays
 * world-fixed (the forefoot through a toe hold, the lower of heel and forefoot
 * for a foot no plant holds), and the support transfers as the landing foot
 * reaches the floor.
 *
 * The unit tests drive the derivation with a synthetic walk whose WORLD motion
 * is known (the body at a constant 1.2 m/s, planted points world-fixed); the
 * rig tests run the stock walk both ways.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion, type MotionRecording } from '../services/motionRecording';
import { buildFigureEightWalk, buildTravelWalk } from '../services/movementTemplates';
import { measureContactSlide, PLANT_RELEASE_BLEND_MS, plantReleaseWeight } from '../services/footContact';
import {
  deriveFootDrivenTravel,
  startPlantsWhereFeetLand,
  type FeetZ,
  type FootGround,
  type GaitContactHold,
} from '../services/rootMotion';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

/** Body speed, m per ms (1.2 m/s). */
const V = 0.0012;
/** Ankle → forefoot (m). */
const FOOT = 0.14;

/** A foot's ground contacts from its WORLD ankle (z, height) and pitch θ (rad,
 *  + = heel up, rotating about the forefoot; − = toes up, about the heel),
 *  expressed in the BODY frame the derivation measures (body at V·t). */
function foot(t: number, azWorld: number, ah: number, pitch: number, x: number): FootGround {
  const az = azWorld - V * t;
  return {
    ax: x,
    az,
    ah,
    tx: x,
    tz: az + FOOT * Math.cos(pitch),
    th: Math.max(0, ah - FOOT * Math.sin(pitch)),
  };
}

const feetOf = (R: FootGround, L: FootGround): FeetZ => ({
  rz: R.az,
  ry: R.ah,
  rx: R.ax,
  lz: L.az,
  ly: L.ah,
  lx: L.ax,
  ground: { R, L },
});

/** Per-sample advance of a derived travel over its own sample times. */
function advances(travel: { zAt(t: number): number }, times: number[]): number[] {
  return times.slice(1).map((t, i) => travel.zAt(t) - travel.zAt(times[i]!));
}

/** Run the derivation and keep the times it sampled at. */
function derive(
  sample: (t: number) => FeetZ,
  totalMs: number,
  holds: GaitContactHold[] | undefined,
  plantOnTouchdown: boolean,
): { travel: ReturnType<typeof deriveFootDrivenTravel>; times: number[] } {
  const times: number[] = [];
  const travel = deriveFootDrivenTravel(
    (t) => {
      times.push(t);
      return sample(t);
    },
    totalMs,
    undefined,
    120,
    0,
    undefined,
    holds,
    plantOnTouchdown,
  );
  return { travel, times };
}

const smooth = (u: number): number => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};

/** R stands flat, rises onto its forefoot (held from 300 ms), toes off at 650.
 *  L swings in — still moving forward in the world, slowing to rest at touchdown
 *  (TD), 8 cm up 150 ms before it. */
const TD = 500;
function landing(t: number): FeetZ {
  const c = (1.5 * V) / (2 * 150); // L's world speed 1.5 V at TD-150, 0 at TD
  const pitchR = t < 300 ? 0 : 0.6 * smooth((t - 300) / 350);
  const R = foot(t, FOOT - FOOT * Math.cos(pitchR), FOOT * Math.sin(pitchR), pitchR, -0.1);
  const before = Math.max(0, TD - t);
  const lz = 0.6 - c * before * before;
  const lh = t < TD ? 0.08 * Math.min(1, before / 150) ** 2 : 0;
  const L = foot(t, lz, lh, t < TD ? -0.25 * Math.min(1, before / 150) : 0, 0.1);
  return feetOf(R, L);
}

describe('the hand-over, unit: planned-start plants stall it, touchdown plants keep it moving', () => {
  it('by default the switching sample advances nothing; a touchdown-planted gait measures it', () => {
    // The L hold opens 150 ms before the foot lands — where the stock walk opens
    // its landing holds, 8 cm up. The default stalls on the switch; the
    // touchdown model starts the hold at the landing and passes the support
    // over as the foot closes on the floor.
    const holds: GaitContactHold[] = [
      { foot: 'R_Foot', fromMs: 0, toMs: 300 },
      { foot: 'R_Toes', fromMs: 300, toMs: 650 },
      { foot: 'L_Foot', fromMs: TD - 150, toMs: 900 },
    ];
    const byDefault = derive(landing, 900, holds, false);
    const planted = advances(byDefault.travel, byDefault.times);
    const dtDefault = byDefault.times[1]! - byDefault.times[0]!;
    const touchdown = derive(landing, 900, holds, true);
    const moving = advances(touchdown.travel, touchdown.times);
    const dt = touchdown.times[1]! - touchdown.times[0]!;
    const worst = Math.min(...moving) / (V * dt);
    // eslint-disable-next-line no-console
    console.log(
      `hand-over: default slowest sample ${(Math.min(...planted) / (V * dtDefault)).toFixed(3)} × body speed, ` +
        `touchdown-planted ${worst.toFixed(3)}`,
    );
    expect(Math.min(...planted)).toBe(0);
    // The landing foot is still slowing as it takes the weight, so the transfer
    // dips — to ~0.7 of body speed here — but it never stops.
    expect(worst).toBeGreaterThan(0.5);
    // The hold starts as the heel comes within 5 mm of the floor — 37.5 ms
    // before it touches, on this fixture's 8 cm·(1 − t/150)² descent — and once
    // down the ankle is world-fixed.
    expect(touchdown.travel.holdFromMs![2]).toBeCloseTo(TD - 37.5, 0);
    const ankleWorld = (t: number): number => landing(t).lz + touchdown.travel.zAt(t);
    const down = touchdown.times.filter((t) => t >= TD);
    for (const t of down) expect(Math.abs(ankleWorld(t) - ankleWorld(down[0]!))).toBeLessThan(1e-9);
  });

  it('a hold starts where its foot comes down — unless the foot is already down, or never lands in it', () => {
    const holds: GaitContactHold[] = [
      // Opens 150 ms early, 8 cm up: starts at the landing.
      { foot: 'L_Foot', fromMs: TD - 150, toMs: 900 },
      // Opens with the forefoot on the floor (R's heel-rise hold): unchanged.
      { foot: 'R_Toes', fromMs: 300, toMs: 650 },
      // Opens and closes while the foot is still in the air: never lands in it.
      { foot: 'L_Foot', fromMs: 200, toMs: 300 },
    ];
    const { travel } = derive(landing, 900, holds, true);
    const [late, onFloor, airborne] = travel.holdFromMs!;
    expect(late).toBeCloseTo(TD - 37.5, 0);
    expect(onFloor).toBe(300);
    expect(airborne).toBe(200);
    // The plants follow the same schedule, in the order they were passed.
    const plants = holds.map((h) => ({ fromMs: h.fromMs }));
    startPlantsWhereFeetLand(plants, travel);
    expect(plants.map((p) => p.fromMs)).toEqual(travel.holdFromMs);
    // A default derivation publishes no schedule: plants keep their windows.
    expect(derive(landing, 900, holds, false).travel.holdFromMs).toBeUndefined();
  });

  it('through heel rise the forefoot the plant holds stays world-fixed, not the ankle rolling over it', () => {
    // R rolls 35° onto its forefoot; L is high in swing throughout. Following
    // the ankle — the default — the body lags the planted forefoot by
    // FOOT·(1 − cos 35°) = 2.5 cm by toe-off.
    const sample = (t: number): FeetZ => {
      const pitch = 0.61 * smooth((t - 100) / 400);
      return feetOf(
        foot(t, FOOT - FOOT * Math.cos(pitch), FOOT * Math.sin(pitch), pitch, -0.1),
        foot(t, 0.3 + V * t, 0.12, 0, 0.1),
      );
    };
    const holds: GaitContactHold[] = [
      { foot: 'R_Foot', fromMs: 0, toMs: 100 },
      { foot: 'R_Toes', fromMs: 100, toMs: 500 },
    ];
    const drift = (plantOnTouchdown: boolean): number => {
      const { travel, times } = derive(sample, 500, holds, plantOnTouchdown);
      const toesWorld = (t: number): number => sample(t).ground!.R.tz + travel.zAt(t);
      return Math.max(...times.map((t) => Math.abs(toesWorld(t) - toesWorld(0))));
    };
    // eslint-disable-next-line no-console
    console.log(
      `heel rise: held forefoot drifts ${(drift(false) * 100).toFixed(2)} cm by default, ` +
        `${(drift(true) * 100).toFixed(3)} cm touchdown-planted`,
    );
    expect(drift(false)).toBeGreaterThan(0.02);
    expect(drift(true)).toBeLessThan(1e-3);
  });

  it('a foot no plant holds any more is kept fixed at its point on the floor', () => {
    // The R ankle hold ends at 100 ms (its release ramp at 200); R then rolls
    // unheld onto its forefoot, which stays on the floor. L is high in swing.
    const sample = (t: number): FeetZ => {
      const pitch = 0.61 * smooth((t - 150) / 350);
      return feetOf(
        foot(t, FOOT - FOOT * Math.cos(pitch), FOOT * Math.sin(pitch), pitch, -0.1),
        foot(t, 0.3 + V * t, 0.12, 0, 0.1),
      );
    };
    const holds: GaitContactHold[] = [{ foot: 'R_Foot', fromMs: 0, toMs: 100 }];
    const { travel, times } = derive(sample, 500, holds, true);
    const toesWorld = (t: number): number => sample(t).ground!.R.tz + travel.zAt(t);
    const drift = Math.max(...times.filter((t) => t >= 200).map((t) => Math.abs(toesWorld(t) - toesWorld(200))));
    // eslint-disable-next-line no-console
    console.log(`unheld heel rise: forefoot drifts ${(drift * 100).toFixed(3)} cm after the release ramp`);
    expect(drift).toBeLessThan(1e-3);
  });

  it('through a hold’s release the support point hands over on the plant’s own release weight', () => {
    // R's forefoot is held to 300 ms, the ankle on the floor and the toes up —
    // so a foot no plant holds bears on its ankle — and from 300 the toes rise
    // on, so the forefoot and the ankle sweep differently and each interval's
    // advance reads the forefoot's share of the support. The plant lets go on
    // plantReleaseWeight (a touchdown-planted gait's plants take the base
    // release), and the travel must let go with it: the linear ramp it had
    // ran up to 0.096 ahead of the plant's smoothstep, then as far behind.
    const pitchAt = (t: number): number => -0.2 - 0.8 * Math.min(1, Math.max(0, (t - 300) / 300));
    const sample = (t: number): FeetZ =>
      feetOf(foot(t, 0, 0, pitchAt(t), -0.1), foot(t, 0.3 + V * t, 0.12, 0, 0.1));
    const { travel, times } = derive(sample, 600, [{ foot: 'R_Toes', fromMs: 0, toMs: 300 }], true);
    const grid = [...new Set(times)].sort((a, b) => a - b);
    let worst = 0;
    let inRelease = 0;
    for (let i = 1; i < grid.length; i += 1) {
      const ta = grid[i - 1]!;
      const tb = grid[i]!;
      if (tb <= 300 + 1e-9) continue; // held: the forefoot and the ankle sweep alike
      const a = sample(ta).ground!.R;
      const b = sample(tb).ground!.R;
      const ankle = a.az - b.az;
      const share = (travel.zAt(tb) - travel.zAt(ta) - ankle) / (a.tz - b.tz - ankle);
      const plant = (plantReleaseWeight(ta - 300) + plantReleaseWeight(tb - 300)) / 2;
      worst = Math.max(worst, Math.abs(share - plant));
      if (tb < 300 + PLANT_RELEASE_BLEND_MS) inRelease += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`release hand-over: forefoot share off the plant's weight by ${worst.toExponential(2)} at worst`);
    expect(inRelease).toBeGreaterThanOrEqual(10);
    expect(worst).toBeLessThan(1e-6);
  });

  it('a touchdown-planted gait samples at most 20 ms apart; the default keeps its sample count', () => {
    // A fixed 120 samples fall one per 33 ms frame on a 4 s walk and one per
    // 84 ms on a 10 s one — too coarse to read a landing foot's last 5 cm.
    const still = (t: number): FeetZ => feetOf(foot(t, V * t, 0, 0, -0.1), foot(t, 0.5 + V * t, 0, 0, 0.1));
    for (const totalMs of [500, 4000, 10000]) {
      const touchdown = derive(still, totalMs, [], true).times;
      const gaps = touchdown.slice(1).map((t, i) => t - touchdown[i]!);
      expect(Math.max(...gaps), `${totalMs} ms motion`).toBeLessThanOrEqual(20 + 1e-9);
      expect(touchdown[touchdown.length - 1]).toBeCloseTo(totalMs, 9);
      expect(derive(still, totalMs, [], false).times).toHaveLength(120);
    }
  });
});

// ── The stock walk, sampled on the rig ──────────────────────────────────────

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let rootRest0: THREE.Vector3;
let rootQuat0: THREE.Quaternion;

beforeAll(async () => {
  const buf = readFileSync(fileURLToPath(GLB_URL));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  root = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  rest = captureJointAngleRestReference(skinned.skeleton, variantCfg);
  baselinePose = serializeCustomPose(skinned.skeleton, variantCfg, 'male');
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

/** Sample the stock walk (optionally touchdown-planted) on the rig. */
function walk(speed: number, plantOnTouchdown: boolean, sampleHz: number) {
  return sampled({ ...buildTravelWalk({ speed }), ...(plantOnTouchdown ? { plantOnTouchdown: true } : {}) }, sampleHz);
}

/** Sample a motion on the rig, with its keyframe ends on the frames' clock. */
function sampled(motion: ComposedMotion, sampleHz: number) {
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(motion, variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz,
  });
  // Keyframe ends on the trajectory clock the frames run on.
  const authoredMs = resolved.keyframes.reduce((s, k) => s + k.durationMs + (k.holdMs ?? 0), 0);
  const scale = rec.frames[rec.frames.length - 1]!.tMs / authoredMs;
  const ends: number[] = [];
  let acc = 0;
  for (const k of resolved.keyframes) {
    acc += k.durationMs + (k.holdMs ?? 0);
    ends.push(acc * scale);
  }
  return { rec, ends, resolved, scale };
}

/** Height (m) of a foot's lower contact above where it stood at frame 0. */
function footUp(rec: MotionRecording, i: number, side: 'L' | 'R'): number {
  const f = rec.frames[i]!.worldTracks!;
  const f0 = rec.frames[0]!.worldTracks!;
  return Math.min(f[`${side}_Foot`]![1] - f0[`${side}_Foot`]![1], f[`${side}_Toes`]![1] - f0[`${side}_Toes`]![1]);
}

/** The L stance of the stock walk's cycle: from where the L foot comes down
 *  (lower contact within 1 cm of its standing height) after the end of
 *  keyframe [4] — where the plan opens its hold — to the end of [8]. */
function leftStance(rec: MotionRecording, ends: number[]): number[] {
  const idx: number[] = [];
  let down = false;
  rec.frames.forEach((f, i) => {
    if (f.tMs < ends[4]! || f.tMs > ends[8]!) return;
    down ||= footUp(rec, i, 'L') < 0.01;
    if (down) idx.push(i);
  });
  return idx;
}

describe('the stock walk on the rig, planned-start plants against touchdown plants', () => {
  it('touchdown-planted, the landing foot is pinned flat on the floor with a physiological stance knee', () => {
    const planned = walk(1, false, 30);
    const touchdown = walk(1, true, 30);
    const stance = (w: typeof planned) => {
      const idx = leftStance(w.rec, w.ends);
      const ankle = idx.map((i) => {
        const f = w.rec.frames[i]!.worldTracks!;
        return f.L_Foot![1] - w.rec.frames[0]!.worldTracks!.L_Foot![1];
      });
      const knee = idx.map((i) => w.rec.frames[i]!.angles.L_Leg!.kneeFlexion!);
      return {
        ankleMedianCm: [...ankle].sort((a, b) => a - b)[Math.floor(ankle.length / 2)]! * 100,
        kneePeak: Math.max(...knee),
      };
    };
    const a = stance(planned);
    const b = stance(touchdown);
    // eslint-disable-next-line no-console
    console.log(
      `L stance: heel ${a.ankleMedianCm.toFixed(2)} cm up / knee peak ${a.kneePeak.toFixed(1)}° planned-start, ` +
        `${b.ankleMedianCm.toFixed(2)} cm / ${b.kneePeak.toFixed(1)}° touchdown-planted`,
    );
    // Measured: 3.9 cm / 43.5° with the hold captured 8 cm up in the air; the
    // heel down and an 18° loading-response peak once it is captured on landing.
    expect(b.ankleMedianCm).toBeLessThan(1);
    expect(b.kneePeak).toBeLessThan(25);
    expect(a.kneePeak - b.kneePeak).toBeGreaterThan(15);
  });

  it('touchdown-planted, where the foot lands does not depend on the sample rate', () => {
    // A plant captured at the first frame inside a window that opens mid-swing
    // catches the foot moving at ~3 m/s, so the recording, the 60 fps stage and
    // a 120 Hz export each put the footprint somewhere else.
    const footprint = (plantOnTouchdown: boolean, hz: number): number => {
      const { rec, ends } = walk(1, plantOnTouchdown, hz);
      const i = rec.frames.findIndex((f) => f.tMs >= ends[6]!); // L mid-stance
      return rec.frames[i]!.worldTracks!.L_Foot![2]!;
    };
    const spread = (plantOnTouchdown: boolean): number => {
      const zs = [30, 60, 120].map((hz) => footprint(plantOnTouchdown, hz));
      return Math.max(...zs) - Math.min(...zs);
    };
    const planned = spread(false);
    const touchdown = spread(true);
    // eslint-disable-next-line no-console
    console.log(
      `L footprint spread across 30/60/120 Hz: ${(planned * 100).toFixed(2)} cm planned-start, ` +
        `${(touchdown * 100).toFixed(2)} cm touchdown-planted`,
    );
    expect(touchdown).toBeLessThan(0.005);
    // Six rig recordings of a walk (two plans × 30/60/120 Hz): ~4.3 s on an
    // idle machine, over the 5 s default under load (6.9–9.9 s measured).
  }, 60_000);

  it.each([
    ['walk 0.8', 0.8, 0.81, 41.7],
    ['walk 1', 1, 1.07, 48.0],
    ['walk 1.2', 1.2, 1.35, 53.6],
    ['figure-eight lobe b', 0, 2.99, 49.5],
  ] as const)(
    '%s by default: the landing foot holds and the stance knee bends as on the base walk',
    (label, speed, baseDriftCm, baseKneeDeg) => {
      // Moving the root through the hand-over while the plants still capture at
      // their planned start drags the landing foot back against the IK: that
      // doubled its in-window drift (1.07 → 2.44 cm at 1×) and bent the stance
      // knee 3-6° further. By default the travel is the base derivation, so
      // both stay at the base walk's values (measured on 5c1c9ac, 120 Hz).
      const motion = speed > 0 ? buildTravelWalk(speed === 1 ? {} : { speed }) : buildFigureEightWalk()[1]!;
      const { rec, resolved, scale } = sampled(motion, 120);
      const c = resolved.contacts!.find((w) => w.foot === 'L_Foot')!;
      const fromMs = c.fromMs! * scale;
      const toMs = c.toMs! * scale;
      const driftCm = measureContactSlide(rec, 'L_Foot', fromMs, toMs).horizontalM * 100;
      const kneeDeg = Math.max(
        ...rec.frames.filter((f) => f.tMs >= fromMs && f.tMs <= toMs).map((f) => f.angles.L_Leg!.kneeFlexion!),
      );
      // eslint-disable-next-line no-console
      console.log(`${label} by default: L in-window drift ${driftCm.toFixed(2)} cm, stance knee peak ${kneeDeg.toFixed(1)}°`);
      expect(driftCm).toBeLessThan(baseDriftCm + 0.3);
      expect(kneeDeg).toBeLessThan(baseKneeDeg + 1.5);
    },
  );

  it.each([0.7, 0.85, 1, 1.3])(
    'speed %s touchdown-planted: the pelvis keeps half its steady pace or more through the cycle’s hand-over',
    (speed) => {
      // The steady window gaitSpatiotemporal measures — the end of keyframe [2]
      // to the end of [8] — holds one whole hand-over: the plan passes the
      // support from R to L at the end of [4], and the landing foot reaches the
      // floor ~60-130 ms later. Judged over the same span for both plant models.
      const slowest = (plantOnTouchdown: boolean) => {
        const { rec, ends } = walk(speed, plantOnTouchdown, 60);
        const frames = rec.frames;
        const hips = (i: number): number[] => frames[i]!.worldTracks!.Hips!;
        const step = (i: number): number =>
          100 * Math.hypot(hips(i)[0]! - hips(i - 1)[0]!, hips(i)[2]! - hips(i - 1)[2]!);
        const steady: number[] = [];
        for (let i = 1; i < frames.length; i += 1) {
          if (frames[i]!.tMs >= ends[2]! && frames[i]!.tMs <= ends[8]!) steady.push(i);
        }
        const median = steady.map(step).sort((a, b) => a - b)[Math.floor(steady.length / 2)]!;
        const handOver = steady.filter((i) => Math.abs(frames[i]!.tMs - ends[4]! - 75) <= 175);
        const i = handOver.reduce((a, b) => (step(b) < step(a) ? b : a));
        return { share: step(i) / median, cm: step(i), at: frames[i]!.tMs, median };
      };
      const planned = slowest(false);
      const touchdown = slowest(true);
      const say = (r: typeof planned) => `${r.cm.toFixed(2)} at ${r.at.toFixed(0)} ms (${(100 * r.share).toFixed(0)}%)`;
      // eslint-disable-next-line no-console
      console.log(
        `walk ${speed}: pelvis ${touchdown.median.toFixed(2)} cm/frame steady; slowest hand-over frame ` +
          `${say(planned)} planned-start, ${say(touchdown)} touchdown-planted`,
      );
      // Measured 54%, 62%, 72% and 66%; with plants at their planned start (the
      // default) 10%, 17%, 9% and 12% — the switching sample advances nothing.
      expect(touchdown.share).toBeGreaterThan(0.5);
    },
  );
});
