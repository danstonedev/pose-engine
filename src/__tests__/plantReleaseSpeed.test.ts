/**
 * A RELEASED PLANT DOES NOT OUTRUN ITS OWN FK WHERE FK LEAVES IT ROOM — the
 * release length read off FK's motion, on the real rig.
 *
 * A release starts from the hold's joint speeds, so it lags FK and must move
 * faster than FK somewhere to catch up — unless FK slows down while it does.
 * At the base 120 ms it caught up while FK was still at speed:
 *
 * 1. THE RUN. The default travel run's released knee turned 25.4°/frame at 60
 *    Hz against its FK's own peak of 22.3 (every run pattern and rate 2–36%
 *    over), and the run's centre of mass bobbed 9.08 cm — past the 9 cm the
 *    validity gate allows, so the default run read `warn` (8.90 before the
 *    eased release). Its heel kick is a burst that halves 55–60 ms after toe-
 *    off; a release stretched past it catches up where FK has slack.
 * 2. A FOOT RELEASED AFTER A SLOW WEIGHT SHIFT (the single-leg-stance replica
 *    simMOVE plays): FK lifts it at ~5 mm/frame, but the hold kept it 9 cm from
 *    FK's foot, and the base release crossed that gap at 25 mm/frame (16.3
 *    before the eased release). The release now lasts as long as the gap needs
 *    for the target to travel no faster than FK moves the foot.
 *
 * What does NOT hold, and why (measured, not tuned away): a walk's swing leg
 * is still being sped up past the window's end, so no release length brings
 * its catch-up under FK's peak — the default walk's toe-off knee runs 1.16× it
 * (1.35 before the eased release; a 400 ms release still 1.06–1.26×). That lag
 * is the contact window outlasting the route's own lift-off: a route matter,
 * not something a release can undo. Those releases are pinned by the toe
 * tests' C1 checks, not here.
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
import { resolveComposedMotion, type ComposedMotion, type ResolvedComposedMotion } from '../services/motionSequence';
import {
  authoredToTrajectoryTimeScale,
  sampleComposedMotion,
  type MotionRecording,
} from '../services/motionRecording';
// Namespace import: the release-length helpers are read off the module so the
// rig checks below still run (and report their numbers) against an engine
// without them.
import * as footContact from '../services/footContact';
import { buildTravelRun, type RunPattern } from '../services/movementLocomotion';
import { assessValidity } from '../services/validityGate';
import { runGaitBiomechChecks } from '../services/gaitBiomechCheck';
import { captureFloorReference } from '../services/rootMotion';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);
let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let floorY: number;
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
  floorY = captureFloorReference(skinned.skeleton, variantCfg).floorY;
  rootRest0 = root.position.clone();
  rootQuat0 = root.quaternion.clone();
});

interface Sampled {
  resolved: ResolvedComposedMotion;
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
  const out = { resolved, rec, contacts };
  cache.set(`${key}@${sampleHz}`, out);
  return out;
}

const withoutContacts = (motion: () => ComposedMotion) => () => ({ ...motion(), contacts: [] });
const firstFrameAfter = (rec: MotionRecording, ms: number) => rec.frames.findIndex((f) => f.tMs > ms + 1e-6);
const firstFrameFrom = (rec: MotionRecording, ms: number) => rec.frames.findIndex((f) => f.tMs >= ms - 1e-6);

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
/** How far (°) joint `key` turns from frame i − 1 to frame i. */
function jointTurn(rec: MotionRecording, i: number, key: string): number {
  const a = rec.frames[i - 1]!.pose.bones[key]!;
  const b = rec.frames[i]!.pose.bones[key]!;
  return (_qa.set(a[0], a[1], a[2], a[3]).angleTo(_qb.set(b[0], b[1], b[2], b[3])) * 180) / Math.PI;
}

interface ReleaseSpeeds {
  foot: string;
  toMs: number;
  /** How long the release lasted (ms): to the first frame FK owns the leg. */
  lastedMs: number;
  /** Per chain joint: the release's fastest turn, FK's local peak (from one
   *  base release before the window's end to one after the release's end) and
   *  the hold's own speed on its last frame, all °/frame. */
  joints: { key: string; release: number; fk: number; hold: number }[];
  /** Fastest effector step during the release, and FK's over the same frames (m/frame). */
  effector: number;
  effectorFk: number;
  /** How far the effector drops below the point it was held at during the
   *  release, and how far FK's does over the same frames (m; negative = it
   *  stays above). */
  dip: number;
  dipFk: number;
}

/**
 * Measure every release of `contacts` that lets a leg go into swing (not a
 * terminal window, not a hand-over to the same leg's next contact) against
 * the same motion with no contacts. The release ends at the first frame from
 * which the leg's joints are FK's own through to its next contact.
 */
function releaseSpeeds(s: Sampled, fk: MotionRecording): ReleaseSpeeds[] {
  const { rec, contacts } = s;
  const T = footContact.PLANT_RELEASE_BLEND_MS;
  const totalMs = rec.frames[rec.frames.length - 1]!.tMs;
  const out: ReleaseSpeeds[] = [];
  for (const c of contacts) {
    if (!(c.toMs < totalMs - T)) continue;
    const side = c.foot.slice(0, 2);
    if (contacts.some((o) => o !== c && o.foot.startsWith(side) && o.fromMs <= c.toMs + T + 50 && o.toMs > c.toMs)) {
      continue;
    }
    const chain = [`${side}UpLeg`, `${side}Leg`, `${side}Foot`];
    const next = Math.min(
      totalMs + 1,
      ...contacts.filter((o) => o.foot.startsWith(side) && o.fromMs > c.toMs).map((o) => o.fromMs),
    );
    // FK owns the leg where its measured flexions are FK's (the recorded pose
    // of a frame a plant touched is re-read off the skeleton; FK's is the
    // trajectory's own, so compare what both measure).
    const owned = (i: number) =>
      (
        [
          ['UpLeg', 'hipFlexion'],
          ['Leg', 'kneeFlexion'],
          ['Foot', 'ankleFlexion'],
        ] as const
      ).every(([bone, m]) => {
        const a = rec.frames[i]!.angles[`${side}${bone}`]?.[m] ?? 0;
        const b = fk.frames[i]!.angles[`${side}${bone}`]?.[m] ?? 0;
        return Math.abs(a - b) < 1e-6;
      });
    const i0 = firstFrameAfter(rec, c.toMs);
    let ie = -1;
    for (let i = i0; i < rec.frames.length && rec.frames[i]!.tMs < next - 1e-6; i += 1) {
      if (!owned(i)) continue;
      let j = i;
      while (j < rec.frames.length && rec.frames[j]!.tMs < next - 1e-6 && owned(j)) j += 1;
      if (j >= rec.frames.length || rec.frames[j]!.tMs >= next - 1e-6) {
        ie = i;
        break;
      }
    }
    expect(ie, `${c.foot} @${c.toMs.toFixed(0)}: FK takes the leg back`).toBeGreaterThan(i0);
    const lo = Math.max(1, firstFrameFrom(fk, c.toMs - T));
    const hiT = rec.frames[ie]!.tMs + T;
    const joints = chain.map((key) => {
      let release = 0;
      for (let i = i0; i <= ie; i += 1) release = Math.max(release, jointTurn(rec, i, key));
      let peak = 0;
      for (let i = lo; i < fk.frames.length && fk.frames[i]!.tMs <= hiT + 1e-6; i += 1) {
        peak = Math.max(peak, jointTurn(fk, i, key));
      }
      return { key, release, fk: peak, hold: jointTurn(rec, i0 - 1, key) };
    });
    const step = (r: MotionRecording, i: number) => {
      const a = r.frames[i - 1]!.worldTracks![c.foot]!;
      const b = r.frames[i]!.worldTracks![c.foot]!;
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
    let effector = 0;
    let effectorFk = 0;
    let low = Infinity;
    let lowFk = Infinity;
    for (let i = i0; i <= ie; i += 1) {
      effector = Math.max(effector, step(rec, i));
      effectorFk = Math.max(effectorFk, step(fk, i));
      low = Math.min(low, rec.frames[i]!.worldTracks![c.foot]![1]);
      lowFk = Math.min(lowFk, fk.frames[i]!.worldTracks![c.foot]![1]);
    }
    const heldY = rec.frames[i0 - 1]!.worldTracks![c.foot]![1];
    out.push({
      foot: c.foot,
      toMs: c.toMs,
      lastedMs: rec.frames[ie]!.tMs - c.toMs,
      joints,
      effector,
      effectorFk,
      dip: heldY - low,
      dipFk: heldY - lowFk,
    });
  }
  return out;
}

const describeRelease = (r: ReleaseSpeeds) =>
  `${r.foot} @${r.toMs.toFixed(0)} ms (${r.lastedMs.toFixed(0)} ms): ` +
  r.joints
    .map((j) => `${j.key} ${j.release.toFixed(2)}°/frame (FK ${j.fk.toFixed(2)}, hold ${j.hold.toFixed(2)})`)
    .join(', ') +
  `; effector ${(r.effector * 1000).toFixed(1)} mm/frame (FK ${(r.effectorFk * 1000).toFixed(1)})` +
  `, dip ${(r.dip * 100).toFixed(2)} cm (FK ${(r.dipFk * 100).toFixed(2)})`;

describe('the travel run: a release never turns a joint faster than FK’s own local peak', () => {
  for (const [pattern, hz] of [
    ['run', 30],
    ['run', 60],
    ['run', 120],
    ['jog', 60],
    ['sprint', 60],
  ] as [RunPattern, number][]) {
    it(`${pattern} at ${hz} Hz: every released joint within FK’s local peak (or the hold’s own speed), the foot within FK’s and never below it (the knee was 1.02–1.36× FK at the base release)`, () => {
      const motion = () => buildTravelRun({ pattern });
      const s = sample(motion, pattern, hz);
      const fk = sample(withoutContacts(motion), `${pattern}-fk`, hz).rec;
      expect(fk.frames.length).toBe(s.rec.frames.length);
      const releases = releaseSpeeds(s, fk);
      expect(releases.length, `${pattern} releases into swing covered`).toBeGreaterThanOrEqual(4);
      for (const r of releases) {
        // eslint-disable-next-line no-console
        console.log(`${pattern} @${hz} Hz ${describeRelease(r)}`);
        // Stretched past the heel kick's burst (half-life 55–60 ms): 150–180 ms.
        expect(r.lastedMs, `${r.foot} release outlasts the base span`).toBeGreaterThan(footContact.PLANT_RELEASE_BLEND_MS);
        for (const j of r.joints) {
          expect(j.release, `${pattern} ${r.foot} ${j.key}: release vs FK’s local peak / the hold`).toBeLessThanOrEqual(
            Math.max(j.fk, j.hold),
          );
        }
        expect(r.effector, `${pattern} ${r.foot}: released foot vs FK’s`).toBeLessThanOrEqual(r.effectorFk);
        // …and it never drops below both the held point and FK's own lowest.
        expect(r.dip, `${pattern} ${r.foot}: dip below the held point (m)`).toBeLessThanOrEqual(Math.max(0, r.dipFk) + 1e-4);
      }
    }, 120_000);
  }

  it('the default run passes the validity gate — its centre of mass bobs within 9 cm again (9.08 at the base release, 8.90 before it eased)', () => {
    for (const hz of [30, 60, 120]) {
      const { resolved, rec } = sample(() => buildTravelRun(), 'run', hz);
      const report = assessValidity(resolved, rec.frames, { floorY, runBiomechChecks: runGaitBiomechChecks });
      const com = report.checks.find((c) => c.id === 'vertical-com');
      // eslint-disable-next-line no-console
      console.log(`run @${hz} Hz: ${report.overall}, vertical CoM ${com?.measured} cm (limit ${com?.threshold})`);
      expect(com, 'the run is graded on its vertical CoM').toBeDefined();
      expect(com!.pass, `run @${hz} Hz vertical CoM ${com!.measured} cm`).toBe(true);
      expect(report.checks.filter((c) => !c.pass).map((c) => c.id), `run @${hz} Hz`).toEqual([]);
      expect(report.overall, `run @${hz} Hz verdict`).toBe('pass');
    }
  }, 120_000);
});

type Target = { joint: string; motion: string; targetDegrees: number };
const target = (joint: string, motion: string, targetDegrees: number): Target => ({ joint, motion, targetDegrees });
const leg = (side: string, hip: number, knee: number): Target[] => [
  target(`${side}_UpLeg`, 'hipFlexion', hip),
  target(`${side}_Leg`, 'kneeFlexion', knee),
  target(`${side}_Foot`, 'ankleFlexion', 0),
];

/**
 * The single-leg stance as simMOVE's verifier replicates it: shift the weight
 * 9 cm onto the left foot over 3 s, then lift the right leg to hip 90° / knee
 * 90° over 3 s and hold. The right foot is held where it stood until the lift
 * starts (3800 ms) — by then FK, riding the shifted pelvis, has it 9 cm away.
 */
function singleLegStance(): ComposedMotion {
  const standing = [...leg('R', 0, 0), ...leg('L', 0, 0)];
  const lifted = [...leg('R', 90, 90), ...leg('L', 0, 0), target('R_UpLeg', 'hipAbduction', -5)];
  const shifted = { translateM: [0.09, 0, -0.04] as [number, number, number] };
  return {
    name: 'single-leg stance (replica)',
    startFrom: 'neutral',
    stance: 'planted',
    keyframes: [
      { durationMs: 800, stance: 'planted', targets: standing, root: { translateM: [0, 0, 0] } },
      { durationMs: 3000, stance: 'planted', targets: standing, root: shifted },
      { durationMs: 3000, stance: 'planted', targets: lifted, root: shifted, holdMs: 2000 },
    ],
    contacts: [{ foot: 'L_Foot' }, { foot: 'R_Foot', toMs: 3800 }],
  } as ComposedMotion;
}

describe('a foot released after a slow weight shift crosses its gap no faster than FK moves it', () => {
  it('the single-leg-stance replica: the foot peaks under 10 mm/frame at 60 Hz (25 at the base release, 16.3 before it eased), every joint within FK’s local peak (or the hold’s)', () => {
    const s = sample(singleLegStance, 'sls', 60);
    const fk = sample(withoutContacts(singleLegStance), 'sls-fk', 60).rec;
    const releases = releaseSpeeds(s, fk);
    expect(releases.map((r) => r.foot)).toEqual(['R_Foot']);
    const r = releases[0]!;
    // eslint-disable-next-line no-console
    console.log(`single-leg stance ${describeRelease(r)}`);
    expect(r.effector, 'released foot, m/frame').toBeLessThan(0.01);
    expect(r.dip, 'dip below the held point (m)').toBeLessThanOrEqual(Math.max(0, r.dipFk) + 1e-4);
    for (const j of r.joints) {
      expect(j.release, `${j.key}: release vs FK’s local peak / the hold`).toBeLessThanOrEqual(Math.max(j.fk, j.hold));
    }
  }, 120_000);
});

describe('the release length is read off FK’s motion (pure)', () => {
  /** A trajectory whose left knee turns about X at `speed(t)` °/ms, everything else still. */
  const kneeTrajectory = (speed: (tMs: number) => number, totalMs = 2000): footContact.ContactPlantTrajectory => {
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3(1, 0, 0);
    return {
      totalMs,
      sampleAt(tMs: number) {
        // Integrate the speed (trapezoid, 0.5 ms) for the knee's angle.
        let angleDeg = 0;
        for (let t = 0; t < tMs; t += 0.5) angleDeg += ((speed(t) + speed(Math.min(tMs, t + 0.5))) / 2) * Math.min(0.5, tMs - t);
        q.setFromAxisAngle(axis, (angleDeg * Math.PI) / 180);
        return {
          pose: {
            bones: {
              ...baselinePose.bones,
              L_Leg: [q.x, q.y, q.z, q.w],
            },
          },
        };
      },
    };
  };

  it('FK still, or swinging on at speed past the window: the base length; a burst that halves within 90 ms: 2.7× its half-life', () => {
    const solver = footContact.buildFootPlant(skinned, 'L_Foot', variantCfg)!;
    const toMs = 1000;
    const plan = (speed: (t: number) => number) => footContact.planPlantRelease(solver, toMs, kneeTrajectory(speed));
    expect(plan(() => 0).burstMs).toBe(footContact.PLANT_RELEASE_BLEND_MS);
    expect(plan(() => 0.3).burstMs).toBe(footContact.PLANT_RELEASE_BLEND_MS);
    // 0.3°/ms up to the window's end, then halving every `halfMs` after it —
    // read on a 5 ms grid, so a 58 ms half-life is found at 60 ms: 2.7 × 60.
    const halving = (halfMs: number) => (t: number) => (t < toMs ? 0.3 : 0.3 * Math.pow(0.5, (t - toMs) / halfMs));
    expect(plan(halving(58)).burstMs).toBeCloseTo(2.7 * 60, 6);
    expect(plan(halving(78)).burstMs).toBeCloseTo(2.7 * 80, 6);
    // A burst halving within 44 ms is covered by the base length already…
    expect(plan(halving(28)).burstMs).toBe(footContact.PLANT_RELEASE_BLEND_MS);
    // …and one still at more than half speed 90 ms on is no burst (a swing).
    expect(plan(halving(118)).burstMs).toBe(footContact.PLANT_RELEASE_BLEND_MS);
    // FK moves the foot only through the knee here: its peak effector speed is
    // the shank's length × the knee's peak rate.
    expect(plan(() => 0.3).effectorSpeed).toBeGreaterThan(0);
    expect(plan(() => 0).effectorSpeed).toBe(0);
  });

  it('a gap stretches the release only where FK moves the limb slowly, and the length is continuous in the gap with a continuous slope', () => {
    const L = footContact.plantReleaseLengthMs;
    const base = footContact.PLANT_RELEASE_BLEND_MS;
    // FK still: the base release (no FK speed to keep within).
    expect(L({ burstMs: base, effectorSpeed: 0 }, 0.1)).toBe(base);
    // FK swinging the foot at 3 m/s: a 10 cm gap is FK's own business.
    expect(L({ burstMs: base, effectorSpeed: 0.003 }, 0.1)).toBe(base);
    expect(L({ burstMs: 162, effectorSpeed: 0.003 }, 0.1)).toBe(162);
    // FK lifting the foot at 0.3 m/s: a 10 cm gap takes 1.98 × 0.1 / 0.0003 ms…
    expect(L({ burstMs: base, effectorSpeed: 0.0003 }, 0.1)).toBeCloseTo((1.98 * 0.1) / 0.0003, 6);
    // …a gap past the 15 cm cap no longer, and nothing lasts over 800 ms.
    expect(L({ burstMs: base, effectorSpeed: 0.0003 }, 0.4)).toBe(800);
    expect(L({ burstMs: base, effectorSpeed: 0.001 }, 0.4)).toBeCloseTo((1.98 * 0.15) / 0.001, 6);
    // Continuous, with a continuous slope, across every joint of the rule: on
    // a grid far finer than any of its roundings, the slope never jumps by
    // more than a twentieth of its largest value (a kink jumps by all of it).
    for (const effectorSpeed of [0.00007, 0.0003, 0.0009, 0.0014, 0.002]) {
      const at = (g: number) => L({ burstMs: base, effectorSpeed }, g);
      const h = 1e-8;
      const slopes: number[] = [];
      for (let g = 0; g <= 0.3; g += 1e-5) slopes.push((at(g + h) - at(g)) / h);
      const largest = Math.max(...slopes.map(Math.abs));
      let jump = 0;
      for (let k = 1; k < slopes.length; k += 1) jump = Math.max(jump, Math.abs(slopes[k]! - slopes[k - 1]!));
      expect(jump, `v ${effectorSpeed}: largest slope ${largest.toFixed(0)} ms/m`).toBeLessThan(0.05 * Math.max(largest, 1));
    }
    // …and continuous in FK's speed, through the gates that fade the gap rule
    // in: never more than 30 ms apart for FK 1 mm/s apart (the steepest, 24
    // ms, is where a near-still FK's 800 ms fades in over 0.05–0.1 m/s).
    for (let v = 0.00001; v < 0.004; v += 0.000001) {
      const a = L({ burstMs: base, effectorSpeed: v }, 0.1);
      const b = L({ burstMs: base, effectorSpeed: v + 0.000001 }, 0.1);
      expect(Math.abs(a - b), `v ${v}`).toBeLessThan(30);
    }
  });
});
