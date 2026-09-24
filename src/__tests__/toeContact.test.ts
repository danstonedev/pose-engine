/**
 * TOE CONTACT + EASED PLANT RELEASE — the forefoot pivot of push-off, on the
 * real rig.
 *
 * A walk may hold each stance foot flat (an ankle contact) and then, from heel
 * rise to toe lift, by its forefoot (a toe contact) — DDx's walk declares
 * exactly that. `toePivotWalk` reproduces the pattern on the engine's own
 * travelling walk, and this gate holds five things the old plant got wrong:
 *
 * 1. A TOE CONTACT IS A LEG CHAIN WITH A HINGED KNEE. It reused the foot's two
 *    parents (toes → ankle → knee — the hip never helped) and its hinge key was
 *    the toe bone itself (the 'Foot'-suffix rewrite missed 'Toes'), so the knee
 *    was solved as a free ball joint: 4.8° of knee varus/valgus through the
 *    right toe pivot here (4.6°/5.0° on the DDx walk), 0.0° with the foot
 *    flat.
 * 2. THE RELEASE IS C1 WHERE IT LEAVES THE HOLD AND WHERE IT JOINS FK. The old
 *    ramp was linear — a velocity kink at both ends, a joint running into a
 *    dead stop as it ended. Fading the correction the last held frame applied
 *    (the first fix) smoothed the end but not the start: every joint dropped the
 *    hold's speed and took FK's on the first released frame (the right ankle
 *    −5.9 → +1.1°/frame here at 120 Hz), and the released toes took FK's
 *    2.5 m/s with them.
 * 3. THE RELEASED TOES LEAVE THE FLOOR FROM REST, WITHOUT SLIDING EITHER WAY:
 *    the linear ramp pulled them back toward an FK pose that trails the held
 *    forefoot (7.2 / 10.1 / 4.8 mm at speed 1 / 0.85 / 1.2) and the faded
 *    correction skidded them forward with FK's swing (24.6 / 39.7 / 30.1 mm),
 *    both while they were still within 1 cm of the floor.
 * 4. …AND AT DDX'S 30 Hz, WHERE FK HAS THEM WELL BEHIND AND ABOVE: the per-
 *    joint blend with FK dragged the drawn toes off the lift-first target
 *    toward FK's, 12.4 mm back along the floor on the first released frame
 *    (DDx's walk: 3.3–11.3 mm).
 * 5. A RELEASE THE ROUTE HAS LEFT FAR BEHIND STAYS BOUNDED — knowingly short
 *    of FK's own: the braking step's toes, 38 cm behind FK's when their hold
 *    ends, peaked at 152 mm/frame and dipped 5.2 cm below the held point at 60
 *    Hz (107 and 4.4 before the eased release; 88 and 4.5 now, FK 46 and 2.5),
 *    and its ankle still turns 9–14× FK's own peak — the hold it leaves
 *    already turns it 7–14×.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import { captureJointAngleRestReference, type JointAngleRestReference } from '../services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../services/motionSequence';
import {
  authoredToTrajectoryTimeScale,
  sampleComposedMotion,
  type MotionRecording,
} from '../services/motionRecording';
// Namespace import: the release-weight helper is read off the module so the rig
// checks below still run (and report their numbers) against an engine without it.
import * as footContact from '../services/footContact';
import { buildTravelWalk } from '../services/movementTemplates';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

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
// Each test here samples the rig synchronously for seconds. Yield to the
// event loop before each one: a file whose tests run over 60 s in all without
// a turn of it trips vitest's worker RPC timeout ("Timeout calling
// onTaskUpdate"), which fails the run although every test passed.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** The heel rises this far before the end of terminal stance's keyframe, and
 *  the toes lift this far into the keyframe after toe-off (DDx's walk values). */
const HEEL_RISE_FRACTION = 0.35;
const TOE_LIFT_FRACTION = 0.46;

/**
 * The engine walk with each stance split DDx's way: the foot held flat from
 * landing to heel rise, then by its forefoot until the toes lift part-way into
 * initial swing. Layout [0] initiation · [1..8] cycle · [9] braking step ·
 * [10] settle: the right heel rises late in keyframe 4 and its toes lift in 6;
 * the left's in 8 and 9. The builder's closing contacts are kept.
 */
function toePivotWalk(speed?: number): ComposedMotion {
  const walk = buildTravelWalk(speed ? { speed } : {});
  const kfs = walk.keyframes;
  const ends: number[] = [];
  kfs.reduce((t, k) => {
    ends.push(t + k.durationMs + (k.holdMs ?? 0));
    return ends[ends.length - 1]!;
  }, 0);
  const rise = (k: number) => ends[k]! - HEEL_RISE_FRACTION * kfs[k]!.durationMs;
  const lift = (k: number) => ends[k - 1]! + TOE_LIFT_FRACTION * kfs[k]!.durationMs;
  return {
    ...walk,
    contacts: [
      { foot: 'R_Foot', fromMs: 0, toMs: rise(4) },
      { foot: 'R_Toes', fromMs: rise(4), toMs: lift(6) },
      { foot: 'L_Foot', fromMs: ends[4]!, toMs: rise(8) },
      { foot: 'L_Toes', fromMs: rise(8), toMs: lift(9) },
      ...(walk.contacts ?? []).slice(2),
    ],
  };
}

interface Sampled {
  rec: MotionRecording;
  /** The contacts on the trajectory clock the frames run on. */
  contacts: { foot: string; fromMs: number; toMs: number }[];
}

const cache = new Map<string, Sampled>();
function sample(motion: () => ComposedMotion, key: string, sampleHz: number): Sampled {
  const hit = cache.get(`${key}@${sampleHz}`);
  if (hit) return hit;
  root.position.copy(rootRest0);
  root.quaternion.copy(rootQuat0);
  root.updateMatrixWorld(true);
  const resolved = resolveComposedMotion(motion(), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose, variantCfg, rest, skeletonHarness: { root, skinned }, sampleHz,
  });
  const scale = authoredToTrajectoryTimeScale(resolved, rec.frames[rec.frames.length - 1]!.tMs);
  const contacts = (resolved.contacts ?? []).map((c) => ({
    foot: c.foot,
    fromMs: (c.fromMs ?? -Infinity) * scale,
    toMs: (c.toMs ?? Infinity) * scale,
  }));
  const out = { rec, contacts };
  cache.set(`${key}@${sampleHz}`, out);
  return out;
}

const inWindow = (c: { fromMs: number; toMs: number }, tMs: number) =>
  tMs >= c.fromMs - 1e-6 && tMs <= c.toMs + 1e-6;
const angle = (rec: MotionRecording, i: number, bone: string, motion: string): number =>
  rec.frames[i]!.angles[bone]?.[motion] ?? 0;

describe('a toe contact is a leg chain whose knee stays a hinge', () => {
  it('the toe chain climbs toes → ankle → knee → hip and hinges the KNEE; the foot chain is unchanged', () => {
    const keysOf = (key: string) => footContact.buildFootPlant(skinned, key, variantCfg)!.ctx.canonicalKeys;
    expect(keysOf('L_Toes')).toEqual(['L_Toes', 'L_Foot', 'L_Leg', 'L_UpLeg']);
    expect(keysOf('R_Toes')).toEqual(['R_Toes', 'R_Foot', 'R_Leg', 'R_UpLeg']);
    expect(footContact.buildFootPlant(skinned, 'R_Toes', variantCfg)!.kneeKey).toBe('R_Leg');
    expect(keysOf('L_Foot')).toEqual(['L_Foot', 'L_Leg', 'L_UpLeg']);
    expect(footContact.buildFootPlant(skinned, 'L_Foot', variantCfg)!.kneeKey).toBe('L_Leg');
    expect(footContact.kneeKeyForFoot('L_Toes')).toBe('L_Leg');
    expect(footContact.kneeKeyForFoot('R_Foot')).toBe('R_Leg');
  });

  it('a declared HAND contact hinges the elbow, like the grounding hand plant (it hinged nothing)', () => {
    const plant = footContact.buildFootPlant(skinned, 'L_Hand', variantCfg)!;
    expect(plant.ctx.canonicalKeys).toEqual(['L_Hand', 'L_Forearm', 'L_UpperArm']);
    expect(plant.kneeKey).toBe('L_Forearm');
    expect(plant.kneeKey).toBe(footContact.buildHandPlant(skinned, 'L_Hand', variantCfg)!.kneeKey);
  });

  it('through every toe pivot the knee takes no varus/valgus (was 4.8°) and the forefoot stays put', () => {
    const { rec, contacts } = sample(() => toePivotWalk(), 'toe', 60);
    let pivots = 0;
    for (const c of contacts) {
      const side = c.foot.slice(0, 2);
      const frames = rec.frames.map((_, i) => i).filter((i) => inWindow(c, rec.frames[i]!.tMs));
      expect(frames.length, `${c.foot} window sampled`).toBeGreaterThan(3);
      const worst = Math.max(...frames.map((i) => Math.abs(angle(rec, i, `${side}Leg`, 'kneeDeviation'))));
      // eslint-disable-next-line no-console
      console.log(`${c.foot} ${c.fromMs.toFixed(0)}–${c.toMs.toFixed(0)} ms: max |kneeDeviation| ${worst.toFixed(2)}°`);
      expect(worst, `${c.foot} knee varus/valgus`).toBeLessThan(0.5);
      if (!c.foot.endsWith('Toes')) continue;
      pivots += 1;
      // The hinge costs the hold nothing: the forefoot stays where it was put.
      const slide = footContact.measureContactSlide(rec, c.foot, c.fromMs, c.toMs);
      // eslint-disable-next-line no-console
      console.log(`${c.foot} held: slide ${(slide.horizontalM * 1000).toFixed(2)} mm, lift ${(slide.verticalM * 1000).toFixed(2)} mm`);
      expect(slide.horizontalM, `${c.foot} forefoot slide`).toBeLessThan(0.005);
      expect(slide.verticalM, `${c.foot} forefoot lift`).toBeLessThan(0.005);
    }
    expect(pivots, 'both toe pivots covered').toBe(2);
  });
});

/** The left leg lifting to hip 25° / knee 45° over `liftMs` and then holding
 *  still until 1200 ms, while its foot is held on the floor until `releaseMs`.
 *  With the release after the lift, FK stands still across it and the leg's
 *  path is the release's own. */
function liftAfterRelease(releaseMs: number, liftMs = 300): ComposedMotion {
  return {
    name: 'lift after release',
    stance: 'planted',
    startFrom: 'neutral',
    keyframes: [
      {
        durationMs: liftMs,
        holdMs: 1200 - liftMs,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 25 },
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 45 },
        ],
      },
    ],
    contacts: [{ foot: 'R_Foot' }, { foot: 'L_Foot', fromMs: 0, toMs: releaseMs }],
  };
}

/** The releases that let a leg go into swing: not a terminal window (it lets go
 *  with the motion's end) and not a hand-over to the same leg's next contact
 *  (the flat foot to its toes, which keeps the leg held). */
function swingReleases(contacts: Sampled['contacts'], totalMs: number): Sampled['contacts'] {
  const T = footContact.PLANT_RELEASE_BLEND_MS;
  return contacts.filter((c) => {
    if (c.toMs >= totalMs - T) return false;
    const side = c.foot.slice(0, 2);
    return !contacts.some(
      (o) => o !== c && o.foot.startsWith(side) && o.fromMs <= c.toMs + T + 50 && o.toMs > c.toMs,
    );
  });
}

const LEG_FLEXION = [
  ['UpLeg', 'hipFlexion'],
  ['Leg', 'kneeFlexion'],
  ['Foot', 'ankleFlexion'],
] as const;
const firstFrameAfter = (rec: MotionRecording, ms: number) => rec.frames.findIndex((f) => f.tMs > ms + 1e-6);
const firstFrameFrom = (rec: MotionRecording, ms: number) => rec.frames.findIndex((f) => f.tMs >= ms - 1e-6);
const withoutContacts = (motion: () => ComposedMotion) => () => ({ ...motion(), contacts: [] });

/** No release lasts longer (ms) — footContact's cap on plantReleaseLengthMs. */
const RELEASE_MAX_MS = 800;

/**
 * The first frame after contact `c`'s window from which FK owns the released
 * leg — its hip, knee and ankle flexion equal to the no-contact recording's —
 * through to the leg's next contact. A release's length is read off FK's own
 * motion (footContact.plantReleaseLengthMs), so where one ends is measured,
 * not assumed. −1 when FK never takes the leg back.
 */
function releaseEndFrame(
  rec: MotionRecording,
  fk: MotionRecording,
  contacts: Sampled['contacts'],
  c: Sampled['contacts'][number],
): number {
  const side = c.foot.slice(0, 2);
  const next = Math.min(
    Infinity,
    ...contacts.filter((o) => o.foot.startsWith(side) && o.fromMs > c.toMs).map((o) => o.fromMs),
  );
  const owned = (i: number) =>
    LEG_FLEXION.every(
      ([bone, m]) => Math.abs(angle(rec, i, `${side}${bone}`, m) - angle(fk, i, `${side}${bone}`, m)) < 1e-6,
    );
  const before = (i: number) => i < rec.frames.length && rec.frames[i]!.tMs < next - 1e-6;
  for (let i = firstFrameAfter(rec, c.toMs); before(i); i += 1) {
    if (!owned(i)) continue;
    let j = i;
    while (before(j) && owned(j)) j += 1;
    if (!before(j)) return i;
  }
  return -1;
}

/**
 * DDx's walk at its own 30 Hz, on the engine: the left toes held on the floor
 * while the leg flexes up and back (hip 20°, knee 50°, ankle 30° dorsiflexed
 * over 200 ms) and the body backs off 10 cm over the planted right foot, the
 * toes let go 111 ms in. On the first released 30 Hz frame (133 ms, 22 ms into
 * the release — DDx's first right-toe frame is 22 ms in too) FK has the toes
 * 13 cm behind and 5 cm above the held point and still moving back — the
 * geometry in which the per-joint blend dragged DDx's released toes 3.3–11.3 mm
 * back along the floor (FK 7–12 cm behind, 2.5–7 cm up).
 */
function toeOffBehind(): ComposedMotion {
  return {
    name: 'toe off behind',
    stance: 'planted',
    startFrom: 'neutral',
    keyframes: [
      {
        durationMs: 200,
        holdMs: 1000,
        root: { translateM: [0, 0, -0.1] },
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 20 },
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 50 },
          { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 30 },
        ],
      },
    ],
    contacts: [{ foot: 'R_Foot' }, { foot: 'L_Toes', fromMs: 0, toMs: 111 }],
  };
}

describe('the plant release is C1 where it leaves the hold and where it joins FK', () => {
  const T = footContact.PLANT_RELEASE_BLEND_MS;

  it('the release weight runs 1 → 0 over PLANT_RELEASE_BLEND_MS with zero rate at BOTH ends (C1)', () => {
    const w = (ms: number) => footContact.plantReleaseWeight(ms);
    expect(w(-5)).toBe(1);
    expect(w(0)).toBe(1);
    expect(w(T)).toBe(0);
    expect(w(T + 5)).toBe(0);
    expect(w(T / 2)).toBeCloseTo(0.5, 12);
    // Rate at both ends: a one-sided difference over 0.1% of the ramp is ~0
    // (the linear ramp's is −1/T at both — a velocity kink into and out of it).
    const h = T / 1000;
    expect(Math.abs((w(h) - w(0)) / h) * T).toBeLessThan(0.01);
    expect(Math.abs((w(T) - w(T - h)) / h) * T).toBeLessThan(0.01);
    // Monotone, and its rate is continuous everywhere (no kink inside either).
    let prevRate = 0;
    for (let ms = 0; ms <= T; ms += h) {
      const rate = (w(ms + h) - w(ms)) / h;
      expect(rate).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(rate - prevRate) * T).toBeLessThan(0.01);
      prevRate = rate;
    }
  });

  it('the cruise (an ankle release) is C1 at both ends too, turns at 1.25/length at most, and is the smoothstep from 500 ms', () => {
    // It reaches its full rate by a fifth of the way and holds it to the last
    // fifth: 1.25/length at most, where the smoothstep peaks at 1.5/length.
    for (const L of [120, 250, 400, 500, 700]) {
      const w = (ms: number) => footContact.plantReleaseWeight(ms, L, 'cruise');
      const smooth = (ms: number) => footContact.plantReleaseWeight(ms, L);
      expect(w(0)).toBe(1);
      expect(w(L)).toBe(0);
      const h = L / 1000;
      expect(Math.abs((w(h) - w(0)) / h) * L, `${L} ms: rate leaving`).toBeLessThan(0.01);
      expect(Math.abs((w(L) - w(L - h)) / h) * L, `${L} ms: rate arriving`).toBeLessThan(0.01);
      let prevRate = 0;
      let peak = 0;
      for (let ms = 0; ms <= L; ms += h) {
        const rate = (w(ms + h) - w(ms)) / h;
        expect(rate, `${L} ms: monotone`).toBeLessThanOrEqual(1e-12);
        expect(Math.abs(rate - prevRate) * L, `${L} ms: rate continuous`).toBeLessThan(0.01);
        peak = Math.max(peak, -rate * L);
        prevRate = rate;
        if (L >= 500) expect(w(ms), `${L} ms: the smoothstep`).toBe(smooth(ms));
      }
      if (L <= 300) expect(peak, `${L} ms: peak rate × length`).toBeLessThan(1.25 + 1e-6);
      else expect(peak, `${L} ms: peak rate × length`).toBeLessThan(1.5 + 1e-6);
    }
  });

  it('released joint angles leave the hold and come to rest with zero speed — no kink, no dead stop', () => {
    // The hold ends mid-way through the still pose, so FK stands still across
    // the whole release and the knee's path is the release's own. Sampled at
    // the sampler's top rate, 120 Hz.
    const releaseMs = 700;
    const { rec } = sample(() => liftAfterRelease(releaseMs), 'lift', 120);
    const knee = rec.frames.map((_, i) => angle(rec, i, 'L_Leg', 'kneeFlexion'));
    const [start, end] = [firstFrameFrom(rec, releaseMs), firstFrameFrom(rec, releaseMs + T)];
    const speed = (i: number) => Math.abs(knee[i + 1]! - knee[i]!); // °/frame
    const peak = Math.max(...knee.slice(start, end).map((_, k) => speed(start + k)));
    // eslint-disable-next-line no-console
    console.log(
      `knee held ${knee[start]!.toFixed(1)}° → FK ${knee[end]!.toFixed(1)}°; per frame: peak ${peak.toFixed(3)}°, first ${speed(start).toFixed(3)}°, last ${speed(end - 1).toFixed(3)}°, after ${speed(end).toFixed(4)}°`,
    );
    // The release has real work to do (the held foot kept the knee 13° short)…
    expect(knee[end]! - knee[start]!).toBeGreaterThan(10);
    // …it leaves the still hold easing in and arrives at the still FK pose
    // easing out: the first and last frame move under a quarter of the fastest
    // one (a linear fade moves its full rate in both — it jolts off the hold,
    // then stops dead)…
    expect(speed(start - 1), 'held still').toBeLessThan(1e-3);
    expect(speed(start) / peak, 'eases out of the hold').toBeLessThan(0.25);
    expect(speed(end - 1) / peak, 'eases into FK — no dead stop').toBeLessThan(0.25);
    expect(speed(end), 'FK still after the release').toBeLessThan(1e-3);
    // …and it never overshoots: the knee moves one way from held to FK.
    for (let i = start; i < end; i += 1) expect(knee[i + 1]! - knee[i]!).toBeGreaterThanOrEqual(-1e-6);
  });

  for (const [key, motion, swings] of [
    ['toe', () => toePivotWalk(), 2],
    ['toe0.85', () => toePivotWalk(0.85), 2],
    ['toe1.2', () => toePivotWalk(1.2), 2],
    ['walk', () => buildTravelWalk(), 2],
    ['toeOff', () => toeOffBehind(), 1],
  ] as const) {
    it(`${key}: the first released frame moves at the hold's joint speeds, the last at FK's, and FK owns the leg after`, () => {
      const { rec, contacts } = sample(motion, key, 120);
      // The same motion with no contacts: the FK pose the release hands over
      // to (plants move no root, so its joint readouts are exactly FK's).
      const fk = sample(withoutContacts(motion), `${key}-fk`, 120).rec;
      expect(fk.frames.length).toBe(rec.frames.length);
      const releases = swingReleases(contacts, rec.frames[rec.frames.length - 1]!.tMs);
      expect(releases.length, `${key} releases into swing covered`).toBeGreaterThanOrEqual(swings);
      for (const c of releases) {
        // …and with this contact held on past its window: what the leg does if
        // it is not let go.
        const index = contacts.indexOf(c);
        const held = sample(
          () => {
            const m = motion();
            return {
              ...m,
              contacts: m.contacts!.map((k, i) => (i === index ? { ...k, toMs: k.toMs! + T } : k)),
            };
          },
          `${key}-held${index}`,
          120,
        ).rec;
        const side = c.foot.slice(0, 2);
        const i0 = firstFrameAfter(rec, c.toMs); // the first released frame
        const ie = releaseEndFrame(rec, fk, contacts, c); // the first frame FK owns again
        // The release lasts at least the base span and at most the cap: its
        // length is read off FK's motion (the braking step's toes take 243 ms).
        expect(ie, `${key} ${c.foot}: FK takes the leg back`).toBeGreaterThan(i0);
        const lasted = rec.frames[ie]!.tMs - c.toMs;
        expect(lasted, `${key} ${c.foot}: release length`).toBeGreaterThanOrEqual(T - 1e-6);
        expect(lasted, `${key} ${c.foot}: release length`).toBeLessThan(RELEASE_MAX_MS + 1000 / 120);
        for (const [bone, m] of LEG_FLEXION) {
          const a = (r: MotionRecording, i: number) => angle(r, i, `${side}${bone}`, m);
          const v = (r: MotionRecording, i: number) => a(r, i) - a(r, i - 1); // °/frame into frame i
          // LEAVING THE HOLD: on the first released frame the joint moves at
          // the speed the hold itself goes on at — letting go starts from it,
          // and a smoothstep lets go of only its square share in the first
          // frame (0.06 of the release in: at most 0.43°/frame off, the right
          // toe release's ankle). Fading the correction the last held frame
          // applied took FK's speed there instead: that ankle +1.1°/frame
          // where the hold goes on at −6.6.
          const leave = Math.abs(v(rec, i0) - v(held, i0));
          // JOINING FK: the last release frame moves at FK's speed — no dead
          // stop (the linear ramp's: the DDx left ankle +10.6 → 0.1°/frame).
          const join = Math.abs(v(rec, ie) - v(fk, ie));
          // eslint-disable-next-line no-console
          console.log(
            `${key} ${c.foot} release @${c.toMs.toFixed(0)} ms (${lasted.toFixed(0)} ms) ${m}: first released frame ${v(rec, i0).toFixed(2)}°/frame (held on ${v(held, i0).toFixed(2)}, FK ${v(fk, i0).toFixed(2)}); joining FK ${join.toFixed(3)}°/frame off its speed`,
          );
          expect(leave, `${key} ${c.foot} ${m}: speed off the hold's, leaving it`).toBeLessThan(0.5);
          expect(join, `${key} ${c.foot} ${m}: speed off FK's joining it`).toBeLessThan(0.05);
          expect(Math.abs(a(rec, ie) - a(fk, ie)), `${key} ${c.foot} ${m}: FK owns it after`).toBeLessThan(1e-6);
        }
      }
    }, 60_000); // three 120 Hz rig recordings per motion
  }

  it('the forefoot hold owns the leg while the ankle contact lets go — whatever order they are declared in', () => {
    // Declared toes-first, the ankle contact's release used to run AFTER the
    // forefoot hold in the same frame and drag the held toes with it; releases
    // now run before holds, so the order cannot matter.
    const { rec } = sample(() => toePivotWalk(), 'toe', 60);
    const reordered = () => {
      const m = toePivotWalk();
      const [rFoot, rToes, lFoot, lToes, ...rest] = m.contacts!;
      return { ...m, contacts: [rToes!, rFoot!, lToes!, lFoot!, ...rest] };
    };
    const flipped = sample(reordered, 'toe-reordered', 60).rec;
    let worst = 0;
    for (let i = 0; i < rec.frames.length; i += 1) {
      for (const key of ['L_Toes', 'R_Toes', 'L_Foot', 'R_Foot']) {
        const a = rec.frames[i]!.worldTracks![key]!;
        const b = flipped.frames[i]!.worldTracks![key]!;
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    expect(worst, 'feet and toes identical in both declaration orders (m)').toBeLessThan(1e-9);
  });

  it('a release depends on nothing but its own frame: recordings at 40 and 120 Hz agree at every common frame', () => {
    // The live stage steps the plants at its own frame times; the promise is
    // that it shows exactly what a recording does at the same time. The hold
    // here is captured at t = 0 on both clocks and ends at 690 ms, while the
    // leg is still lifting — off the 40 Hz grid, so the last held frame
    // differs (675 vs 683.3 ms). A release that carried anything forward from
    // the frames before it (the correction the last held frame applied, as the
    // first fix faded) would differ from there on; this one is a function of
    // the frame's FK pose, the held point and the time alone.
    const lifting = () => liftAfterRelease(690, 900);
    const slow = sample(lifting, 'lifting690', 40).rec;
    const fast = sample(lifting, 'lifting690', 120).rec;
    let common = 0;
    let releasing = 0;
    let worst = 0;
    for (const f of slow.frames) {
      const g = fast.frames.find((x) => Math.abs(x.tMs - f.tMs) < 1e-6);
      if (!g) continue;
      common += 1;
      if (f.tMs > 690 && f.tMs < 690 + T) releasing += 1;
      for (const key of ['L_Foot', 'L_Toes', 'L_Leg', 'L_UpLeg']) {
        const a = f.worldTracks![key]!;
        const b = g.worldTracks![key]!;
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    expect(common).toBe(slow.frames.length);
    expect(releasing, 'release frames compared').toBeGreaterThanOrEqual(4);
    expect(worst, 'the two clocks agree at every common frame (m)').toBeLessThan(1e-9);
  });
});

describe('the released toes leave the floor from rest, without sliding either way', () => {
  // Sampled at 120 Hz: the first released frames are where the linear ramp
  // dragged the toes back (7.2 / 10.1 / 4.8 mm at these paces) and the faded
  // correction skidded them forward (24.6 / 39.7 / 30.1 mm) before they had
  // lifted 1 cm. The 0.6× walk at every rate too: the hold off the floor-drag
  // handed back as the target crossed a height band slid its toes 8.5 mm at
  // 30 Hz (0.5 at 2504a7e); on the release's own clock, 0–1.6 mm.
  for (const [speed, hz] of [
    [1, 120],
    [0.85, 120],
    [1.2, 120],
    [0.6, 120],
    [0.6, 60],
    [0.6, 30],
  ] as const) {
    it(`speed ${speed} at ${hz} Hz: the released toes start from rest, and move under 5 mm either way until they lift 1 cm`, () => {
      const motion = () => toePivotWalk(speed === 1 ? undefined : speed);
      const key = speed === 1 ? 'toe' : `toe${speed}`;
      const { rec, contacts } = sample(motion, key, hz);
      const fk = sample(withoutContacts(motion), `${key}-fk`, hz).rec;
      const horizontal = (p: number[], q: number[]) => Math.hypot(p[0]! - q[0]!, p[2]! - q[2]!);
      const judged: string[] = [];
      for (const c of contacts) {
        if (!c.foot.endsWith('Toes')) continue;
        const i0 = firstFrameAfter(rec, c.toMs);
        const ie = releaseEndFrame(rec, fk, contacts, c);
        expect(ie, `${c.foot}: FK takes the leg back`).toBeGreaterThan(i0);
        const held = rec.frames[i0 - 1]!.worldTracks![c.foot]!;
        const toes = (r: MotionRecording, i: number) => r.frames[i]!.worldTracks![c.foot]!;
        // Only the route can lift released toes off the floor. The left toe
        // hold runs into the builder's braking step, whose own FK drags that
        // foot's toes along the floor (it swings the leg through with the knee
        // at 30°): there FK never lifts them 1 cm above the held point, so any
        // release follows them along it. Assert that, rather than skip it.
        let fkLift = -Infinity;
        for (let i = i0; i <= ie; i += 1) fkLift = Math.max(fkLift, toes(fk, i)[1]! - held[1]!);
        if (fkLift < 0.01) {
          // eslint-disable-next-line no-console
          console.log(`speed ${speed} @${hz} Hz ${c.foot} release @${c.toMs.toFixed(0)} ms: the route keeps them on the floor (FK lifts them ${(fkLift * 1000).toFixed(1)} mm) — not judged`);
          expect(c.foot, 'only the braking step drags its toes').toBe('L_Toes');
          continue;
        }
        judged.push(c.foot);
        // FROM REST: the first released frame moves the toes a small share of
        // what the route moves its own toes (the faded correction: ~90%).
        const first = horizontal(toes(rec, i0), held);
        const routeFirst = horizontal(toes(fk, i0), toes(fk, i0 - 1));
        // EITHER WAY: until they have lifted 1 cm, the toes stay within 5 mm of
        // where they were held, forward or back.
        let onFloor = 0;
        let slide = 0;
        for (let i = i0; i < ie; i += 1) {
          const p = toes(rec, i);
          if (p[1]! - held[1]! >= 0.01) break; // lifted — a swing, not a slide
          onFloor += 1;
          slide = Math.max(slide, horizontal(p, held));
        }
        // eslint-disable-next-line no-console
        console.log(
          `speed ${speed} @${hz} Hz ${c.foot} release @${c.toMs.toFixed(0)} ms: first frame ${(first * 1000).toFixed(1)} mm (route ${(routeFirst * 1000).toFixed(1)}), ${onFloor} frames under 1 cm, slide ${(slide * 1000).toFixed(1)} mm`,
        );
        expect(first / routeFirst, `${c.foot} leaves from rest`).toBeLessThan(0.2);
        expect(onFloor, `${c.foot} frames judged`).toBeGreaterThan(0);
        expect(slide, `${c.foot} slides along the floor`).toBeLessThan(0.005);
      }
      expect(judged, 'the right toe release judged').toEqual(['R_Toes']);
    }, 60_000);
  }
});

describe('at DDx’s 30 Hz, toes the route has well behind and above stay on the release’s lift-first path', () => {
  // The per-joint blend with FK drags the drawn toes off the release target
  // toward FK's toes — and with FK's toes 13 cm behind and 5 cm up (toeOffBehind)
  // that dragged them 12.4 mm back along the floor on the first released 30 Hz
  // frame, while the target itself had moved under 1 mm (DDx's walk: 3.3–11.3
  // mm). The limb is now swung back toward the solve's own point until the
  // toes are predicted to have lifted a centimetre, and let go on the release's
  // own clock after that — the same at every rate. (Handed back as the target
  // crossed a height band instead, the 120 Hz frames 4–10 mm up came in the
  // hand-back and slid 5.8 mm.)
  for (const hz of [30, 60, 120]) {
    it(`${hz} Hz: until they lift 1 cm the released toes stay within 2 mm of the held point (12.4 mm before)`, () => {
      const { rec, contacts } = sample(toeOffBehind, 'toeOff', hz);
      const fk = sample(withoutContacts(toeOffBehind), 'toeOff-fk', hz).rec;
      expect(fk.frames.length).toBe(rec.frames.length);
      const c = contacts.find((k) => k.foot === 'L_Toes')!;
      const i0 = firstFrameAfter(rec, c.toMs);
      const ie = releaseEndFrame(rec, fk, contacts, c);
      expect(ie, 'FK takes the leg back').toBeGreaterThan(i0);
      const held = rec.frames[i0 - 1]!.worldTracks!.L_Toes!;
      const toes = (r: MotionRecording, i: number) => r.frames[i]!.worldTracks!.L_Toes!;
      if (hz === 30) {
        // THE PREMISE — DDx's geometry on the first released frame, 22 ms in:
        // FK has the toes 10–14 cm behind (+Z is forward) and 5–9 cm above
        // the held point, and is still carrying them back.
        expect(rec.frames[i0]!.tMs - c.toMs).toBeGreaterThan(15);
        expect(rec.frames[i0]!.tMs - c.toMs).toBeLessThan(30);
        const behind = held[2]! - toes(fk, i0)[2]!;
        const above = toes(fk, i0)[1]! - held[1]!;
        // eslint-disable-next-line no-console
        console.log(`toeOff @30 Hz: FK toes ${(behind * 100).toFixed(1)} cm behind, ${(above * 100).toFixed(1)} cm above the held point on the first released frame`);
        expect(behind).toBeGreaterThan(0.1);
        expect(behind).toBeLessThan(0.14);
        expect(above).toBeGreaterThan(0.05);
        expect(above).toBeLessThan(0.09);
        expect(toes(fk, i0)[2]!, 'FK still carrying them back').toBeLessThan(toes(fk, i0 - 1)[2]!);
      }
      // ON THE PATH: while they are within 1 cm of the held height, the toes
      // are where the lift-first target puts them — at the held point, give or
      // take its horizontal share (the square of a release barely begun).
      let onFloor = 0;
      let slide = 0;
      for (let i = i0; i < ie; i += 1) {
        const p = toes(rec, i);
        if (p[1]! - held[1]! >= 0.01) break;
        onFloor += 1;
        slide = Math.max(slide, Math.hypot(p[0]! - held[0]!, p[2]! - held[2]!));
      }
      // eslint-disable-next-line no-console
      console.log(`toeOff @${hz} Hz: ${onFloor} released frames under 1 cm, slide ${(slide * 1000).toFixed(2)} mm; release ${(rec.frames[ie]!.tMs - c.toMs).toFixed(0)} ms`);
      expect(onFloor, 'frames judged').toBeGreaterThan(0);
      expect(slide, 'slide along the floor (m)').toBeLessThan(0.002);
    }, 60_000);
  }
});

describe('a toe release the route has left far behind (the braking step) stays bounded', () => {
  // The left toe hold runs 46% into the builder's braking step, whose FK has
  // swung the leg through with the knee at 30°: FK's toes are 38 cm ahead of
  // the held point when it ends and 68 cm when the release does — a lag the
  // route made, which a joint-space release has to cover. FK itself drags
  // those toes 1–3 cm under the held point.
  //
  // KNOWINGLY NOT MET: no release of this hold can keep every joint within
  // FK's own local peak. A release is C1 with the hold it leaves — its first
  // frames ARE the hold — and on its last frame this hold already turns the
  // ankle 4.0–16°/frame, 7.4–14× FK's peak (FK's ankle barely moves through
  // the braking step). The blend of the held leg (toes back on the floor) with
  // FK's (leg through, knee 30°) passes the vertical with less knee than FK,
  // which dipped the toes 2 cm under FK's; the released forefoot is now kept
  // off the floor at FK's own level by the ankle and hip
  // (footContact.liftReleasedForefoot), so its dip is FK's. Flooring the
  // knee's flexion at FK's turns the joints 9–20× FK's peak, and lifting with
  // the knee 1.5–1.6×. The route's contact timing is what would remove it.
  // Bounded against FK alone at every rate, and on the 0.6× walk's braking
  // step too, so none can get worse unnoticed: toes under 2× FK's, the dip
  // within 2.1 cm of FK's, each leg joint's peak / FK's local peak no worse
  // than the base release (2504a7e) or the one before it (5c1c9ac) did, to 2%
  // (plantReleaseMain.test compares it with 5c1c9ac alone, at speeds 1, 1.2
  // and 1.5, on both rigs). Measured — toes mm/frame (FK) · dip cm (FK) · hip
  // / knee / ankle over FK's peak:
  //               toes mm/frame (FK)  dip cm (FK)            hip / knee / ankle over FK's peak
  //               now 2504a7e 5c1c9ac now  2504a7e 5c1c9ac   now             2504a7e         5c1c9ac
  //   1× @30 Hz   159 266 195 (91)    1.87 3.81 4.28 (1.9)   0.85 1.22 13.1  1.09 1.33 12.9  1.00 1.28 10.1
  //   1× @60 Hz    88 152 107 (46)    2.41 5.19 4.42 (2.5)   1.06 1.23 12.6  1.53 1.43 12.3  0.98 1.86 12.6
  //   1× @120 Hz   46  82  56 (23)    3.18 5.87 4.87 (3.2)   1.13 1.26 13.0  1.79 1.48 15.6  0.99 2.05 17.1
  //   0.6× @30 Hz  76 182 131 (52)    1.29 2.92 2.72 (1.1)   1.25 1.80 14.2  1.25 1.98 18.1  1.00 1.43 10.0
  //   0.6× @60 Hz  41 107  77 (26)    1.10 3.59 3.94 (1.1)   0.85 1.31 14.4  0.96 1.96 24.4  0.98 1.34 15.2
  //   0.6× @120 Hz 21  59  40 (13)    1.10 3.92 4.37 (1.2)   0.66 1.32 13.7  1.25 2.07 26.2  0.97 1.72 16.2
  // (The 1× ankle at 30 Hz, 13.1 against 12.9, is the hold's own acceleration
  // carried on: it turned the ankle 10.2 then 16.0°/frame, and the first
  // released frame 24.35, 2504a7e's 23.9. The dips are sampled, so a coarse
  // clock can miss the bottom: 2504a7e's 2.92 cm at 30 Hz is 3.92 at 120.)
  const BEFORE: Record<string, [number, number, number]> = {
    '1@30': [1.09, 1.328, 12.867],
    '1@60': [1.531, 1.859, 12.597],
    '1@120': [1.792, 2.048, 17.119],
    '0.6@30': [1.25, 1.978, 18.066],
    '0.6@60': [0.979, 1.961, 24.393],
    '0.6@120': [1.247, 2.066, 26.227],
  };
  for (const speed of [1, 0.6] as const) {
    for (const hz of [30, 60, 120]) {
      it(`speed ${speed} at ${hz} Hz: toes under 2× FK’s, the dip within 2.1 cm of FK’s, each joint over FK’s peak no worse than before`, () => {
        const key = speed === 1 ? 'toe' : `toe${speed}`;
        const motion = () => toePivotWalk(speed === 1 ? undefined : speed);
        const { rec, contacts } = sample(motion, key, hz);
        const fk = sample(withoutContacts(motion), `${key}-fk`, hz).rec;
        const c = contacts.find((k) => k.foot === 'L_Toes')!;
        const i0 = firstFrameAfter(rec, c.toMs);
        const ie = releaseEndFrame(rec, fk, contacts, c);
        expect(ie, 'FK takes the leg back').toBeGreaterThan(i0);
        const held = rec.frames[i0 - 1]!.worldTracks!.L_Toes!;
        const toes = (r: MotionRecording, i: number) => r.frames[i]!.worldTracks!.L_Toes!;
        const step = (r: MotionRecording, i: number) => {
          const a = toes(r, i - 1);
          const b = toes(r, i);
          return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
        };
        let peak = 0;
        let peakFk = 0;
        let low = Infinity;
        let lowFk = Infinity;
        for (let i = i0; i <= ie; i += 1) {
          peak = Math.max(peak, step(rec, i));
          peakFk = Math.max(peakFk, step(fk, i));
          low = Math.min(low, toes(rec, i)[1]!);
          lowFk = Math.min(lowFk, toes(fk, i)[1]!);
        }
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();
        const turn = (r: MotionRecording, i: number, bone: string) => {
          const a = r.frames[i - 1]!.pose.bones[bone]!;
          const b = r.frames[i]!.pose.bones[bone]!;
          return (qa.set(a[0], a[1], a[2], a[3]).angleTo(qb.set(b[0], b[1], b[2], b[3])) * 180) / Math.PI;
        };
        const T = footContact.PLANT_RELEASE_BLEND_MS;
        const lo = firstFrameFrom(fk, c.toMs - T);
        const hiMs = rec.frames[ie]!.tMs + T;
        const overFk: number[] = [];
        let worstBound = 0;
        const joints: string[] = [];
        for (const bone of ['L_UpLeg', 'L_Leg', 'L_Foot']) {
          let release = 0;
          for (let i = i0; i <= ie; i += 1) release = Math.max(release, turn(rec, i, bone));
          let fkPeak = 0;
          for (let i = lo; i < fk.frames.length && fk.frames[i]!.tMs <= hiMs + 1e-6; i += 1) {
            fkPeak = Math.max(fkPeak, turn(fk, i, bone));
          }
          const hold = turn(rec, i0 - 1, bone);
          overFk.push(release / fkPeak);
          worstBound = Math.max(worstBound, release / Math.max(fkPeak, hold));
          joints.push(`${bone} ${release.toFixed(2)}°/frame (FK ${fkPeak.toFixed(2)}, hold ${hold.toFixed(2)})`);
        }
        const dip = held[1]! - low;
        const dipFk = held[1]! - lowFk;
        // eslint-disable-next-line no-console
        console.log(
          `braking step, speed ${speed} @${hz} Hz: ${(rec.frames[ie]!.tMs - c.toMs).toFixed(0)} ms, toes peak ${(peak * 1000).toFixed(1)} mm/frame (FK ${(peakFk * 1000).toFixed(1)}), ` +
            `dip ${(dip * 100).toFixed(2)} cm (FK ${(dipFk * 100).toFixed(2)}), over FK's peak ${overFk.map((x) => x.toFixed(3)).join(' / ')} | ${joints.join(', ')}`,
        );
        expect(peak / peakFk, 'toes against FK’s').toBeLessThan(2);
        expect(dip - dipFk, 'dip below FK’s own (m)').toBeLessThan(0.021);
        const before = BEFORE[`${speed}@${hz}`];
        expect(before, 'measured before').toBeDefined();
        overFk.forEach((x, j) => {
          expect(x, `${['hip', 'knee', 'ankle'][j]} over FK’s local peak, vs the worse of 2504a7e and 5c1c9ac`).toBeLessThanOrEqual(before![j]! * 1.02);
        });
        if (speed === 1 && hz === 60) {
          // The bounds this test first held the 60 Hz braking step to (the
          // bound there FK's own local peak or the hold's last speed).
          expect(peak, 'toes, m/frame').toBeLessThan(0.1);
          expect(worstBound, 'leg joints against FK’s local peak / the hold').toBeLessThan(1.3);
          expect(dip, 'dip below the held point (m)').toBeLessThan(0.05);
        }
      }, 60_000);
    }
  }
});
