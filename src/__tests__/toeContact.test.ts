/**
 * TOE CONTACT + EASED PLANT RELEASE — the forefoot pivot of push-off, on the
 * real rig.
 *
 * A walk may hold each stance foot flat (an ankle contact) and then, from heel
 * rise to toe lift, by its forefoot (a toe contact) — DDx's walk declares
 * exactly that. `toePivotWalk` reproduces the pattern on the engine's own
 * travelling walk, and this gate holds three things the old plant got wrong:
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

  for (const [key, motion] of [
    ['toe', () => toePivotWalk()],
    ['toe0.85', () => toePivotWalk(0.85)],
    ['toe1.2', () => toePivotWalk(1.2)],
    ['walk', () => buildTravelWalk()],
  ] as const) {
    it(`${key}: the first released frame moves at the hold's joint speeds, the last at FK's, and FK owns the leg after`, () => {
      const { rec, contacts } = sample(motion, key, 120);
      // The same motion with no contacts: the FK pose the release hands over
      // to (plants move no root, so its joint readouts are exactly FK's).
      const fk = sample(withoutContacts(motion), `${key}-fk`, 120).rec;
      expect(fk.frames.length).toBe(rec.frames.length);
      const releases = swingReleases(contacts, rec.frames[rec.frames.length - 1]!.tMs);
      expect(releases.length, `${key} releases into swing covered`).toBeGreaterThanOrEqual(2);
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
        const ie = firstFrameFrom(rec, c.toMs + T); // the first frame FK owns again
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
            `${key} ${c.foot} release @${c.toMs.toFixed(0)} ms ${m}: first released frame ${v(rec, i0).toFixed(2)}°/frame (held on ${v(held, i0).toFixed(2)}, FK ${v(fk, i0).toFixed(2)}); joining FK ${join.toFixed(3)}°/frame off its speed`,
          );
          expect(leave, `${key} ${c.foot} ${m}: speed off the hold's, leaving it`).toBeLessThan(0.5);
          expect(join, `${key} ${c.foot} ${m}: speed off FK's joining it`).toBeLessThan(0.05);
          expect(Math.abs(a(rec, ie) - a(fk, ie)), `${key} ${c.foot} ${m}: FK owns it after`).toBeLessThan(1e-6);
        }
      }
    });
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
  // lifted 1 cm.
  const T = footContact.PLANT_RELEASE_BLEND_MS;
  for (const speed of [1, 0.85, 1.2] as const) {
    it(`speed ${speed}: the released toes start from rest, and move under 5 mm either way until they lift 1 cm`, () => {
      const motion = () => toePivotWalk(speed === 1 ? undefined : speed);
      const { rec, contacts } = sample(motion, `toe${speed}`, 120);
      const fk = sample(withoutContacts(motion), `toe${speed}-fk`, 120).rec;
      const horizontal = (p: number[], q: number[]) => Math.hypot(p[0]! - q[0]!, p[2]! - q[2]!);
      const judged: string[] = [];
      for (const c of contacts) {
        if (!c.foot.endsWith('Toes')) continue;
        const i0 = firstFrameAfter(rec, c.toMs);
        const ie = firstFrameFrom(rec, c.toMs + T);
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
          console.log(`speed ${speed} ${c.foot} release @${c.toMs.toFixed(0)} ms: the route keeps them on the floor (FK lifts them ${(fkLift * 1000).toFixed(1)} mm) — not judged`);
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
          `speed ${speed} ${c.foot} release @${c.toMs.toFixed(0)} ms: first frame ${(first * 1000).toFixed(1)} mm (route ${(routeFirst * 1000).toFixed(1)}), ${onFloor} frames under 1 cm, slide ${(slide * 1000).toFixed(1)} mm`,
        );
        expect(first / routeFirst, `${c.foot} leaves from rest`).toBeLessThan(0.2);
        expect(onFloor, `${c.foot} frames judged`).toBeGreaterThan(0);
        expect(slide, `${c.foot} slides along the floor`).toBeLessThan(0.005);
      }
      expect(judged, 'the right toe release judged').toEqual(['R_Toes']);
    });
  }
});
