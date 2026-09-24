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
 *    for the target to travel no faster than FK moves the foot — read ONCE,
 *    as the window ends, so it runs one way at one pace.
 *
 * What does NOT hold, and why (measured, not tuned away): a walk's swing leg
 * is still being sped up past the window's end, so no release length brings
 * its catch-up under FK's peak — the default walk's toe-off knee runs 1.16× it
 * (1.35 before the eased release; a 400 ms release still 1.06–1.26×), the
 * 120° walk's hip 2.2–2.4×. That lag is the contact window outlasting the
 * route's own lift-off: a route matter, not something a release can undo.
 * Those releases are held to what the base release did (plantReleaseWalks),
 * and the braking step's by the toe tests (toeContact). The single-leg stance
 * with a 3–5 cm shift is plantReleaseStance; the rig and the measurements are
 * shared (plantReleaseRig).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
// Namespace import: the release-length helpers are read off the module so the
// rig checks below still run (and report their numbers) against an engine
// without them.
import * as footContact from '../services/footContact';
import { buildTravelRun, type RunPattern } from '../services/movementLocomotion';
import { assessValidity } from '../services/validityGate';
import { runGaitBiomechChecks } from '../services/gaitBiomechCheck';
import {
  baselinePose,
  describeRelease,
  floorY,
  loadRig,
  releaseSpeeds,
  rest,
  root,
  rootQuat0,
  rootRest0,
  sample,
  singleLegStance,
  skinned,
  variantCfg,
  withoutContacts,
} from './plantReleaseRig';

beforeAll(loadRig);

describe('the travel run: a release never turns a joint faster than FK’s own local peak', () => {
  for (const [pattern, hz] of [
    ['run', 30],
    ['run', 60],
    ['run', 120],
    ['jog', 60],
    ['sprint', 60],
  ] as [RunPattern, number][]) {
    it(`${pattern} at ${hz} Hz: every released joint within FK’s local peak, the foot within FK’s and never below it (the knee was 1.02–1.36× FK at the base release)`, () => {
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
        // FK's own local peak alone (it was FK's or the hold's last speed,
        // whichever was larger): every run release here is 0.66–0.97× FK's.
        for (const j of r.joints) {
          expect(j.release, `${pattern} ${r.foot} ${j.key}: release vs FK’s local peak`).toBeLessThanOrEqual(j.fk);
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

describe('a release is read once, as its window ends', () => {
  it('its length stays what it was read as, and its weight only falls, while FK moves on from the held point', () => {
    // Re-read on every frame, the release's length followed the gap to FK as
    // FK moved away, so the weight ran backwards and lurched where the length
    // met its cap (the single-leg stance with a 3 cm shift: the weight rose by
    // up to 0.016 a frame at 60 Hz). Here the gap keeps growing through the
    // release: the pelvis drifts sideways at 10 cm/s while FK's hip speeds up
    // from rest, so a length read again on each frame would keep growing.
    const foot = footContact.buildFootPlant(skinned, 'L_Foot', variantCfg)!;
    const keys = foot.ctx.canonicalKeys;
    const chain = foot.ctx.bones;
    const toMs = 300;
    // FK's hip speeds up from rest as the window ends; the pelvis has drifted
    // 2 cm when it does, and drifts on 1.7 mm a frame.
    const flexRad = (t: number) => 5e-7 * Math.max(0, t - toMs) ** 2;
    const drift = (t: number) => 1e-4 * Math.max(0, t - 100);
    const axis = new THREE.Vector3(1, 0, 0);
    const bones = (t: number): Record<string, number[]> => {
      const out: Record<string, number[]> = {};
      for (let i = 1; i < chain.length; i += 1) {
        const q = baselinePose.bones[keys[i]!]!;
        const quat = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
        if (i === chain.length - 1) quat.multiply(new THREE.Quaternion().setFromAxisAngle(axis, flexRad(t)));
        out[keys[i]!] = [quat.x, quat.y, quat.z, quat.w];
      }
      return out;
    };
    const trajectory: footContact.ContactPlantTrajectory = { totalMs: 3000, sampleAt: (t) => ({ pose: { bones: bones(t) } }) };
    const poseFk = (t: number) => {
      const b = bones(t);
      for (let i = 1; i < chain.length; i += 1) {
        const q = b[keys[i]!]!;
        chain[i]!.quaternion.set(q[0]!, q[1]!, q[2]!, q[3]!);
      }
      const q0 = baselinePose.bones[keys[0]!]!;
      chain[0]!.quaternion.set(q0[0]!, q0[1]!, q0[2]!, q0[3]!);
      root.position.set(rootRest0.x + drift(t), rootRest0.y, rootRest0.z);
      root.quaternion.copy(rootQuat0);
      root.updateMatrixWorld(true);
    };
    const plants: footContact.ContactPlant[] = [{ solver: foot, fromMs: 0, toMs, target: null, reuseInitialAnchor: false }];
    const frame: footContact.ContactPlantFrame = { rest, hingeAxisRest: rest, heelStrikeY: 0, initialTargets: new Map(), trajectory };
    const lengths: number[] = [];
    const weights: number[] = [];
    for (let t = 0; t <= 2000; t += 1000 / 60) {
      poseFk(t);
      footContact.stepContactPlants(plants, t, frame);
      const release = plants[0]!.release;
      if (t > toMs && plants[0]!.target && release) {
        lengths.push(release.lengthMs);
        weights.push(footContact.plantReleaseWeight(t - toMs, release.lengthMs));
      }
    }
    root.position.copy(rootRest0);
    root.quaternion.copy(rootQuat0);
    root.updateMatrixWorld(true);
    let rise = 0;
    for (let k = 1; k < weights.length; k += 1) rise = Math.max(rise, weights[k]! - weights[k - 1]!);
    // eslint-disable-next-line no-console
    console.log(`read-once release: ${lengths.length} released frames, length ${lengths[0]?.toFixed(1)} ms (${Math.min(...lengths).toFixed(1)}–${Math.max(...lengths).toFixed(1)}), weight rises by ${rise.toExponential(2)} at most`);
    expect(lengths.length, 'released frames').toBeGreaterThan(5);
    expect(lengths[0]!, 'the gap stretches it past the base').toBeGreaterThan(footContact.PLANT_RELEASE_BLEND_MS);
    expect(Math.max(...lengths) - Math.min(...lengths), 'the length, frame to frame (ms)').toBe(0);
    expect(rise, 'the weight never rises').toBeLessThanOrEqual(0);
  });
});

describe('two contacts of one leg never release at once', () => {
  it('a foot release is cut to end as the same leg’s toes window does, so the toes release reads FK alone', () => {
    // The 0.6× toe walk's foot release, stretched to 256 ms, outlived the toes'
    // window by 8 ms and ran beside their release (1–3 frames), so the toes
    // release read a destination the foot release had already moved. Here a
    // base (120 ms) foot release meets a toes window ending 100 ms after it.
    const foot = footContact.buildFootPlant(skinned, 'L_Foot', variantCfg)!;
    const toes = footContact.buildFootPlant(skinned, 'L_Toes', variantCfg)!;
    const run = (withToes: boolean) => {
      root.position.copy(rootRest0);
      root.quaternion.copy(rootQuat0);
      const chain = toes.ctx.bones;
      const poseFk = () => {
        for (let i = 0; i < chain.length; i += 1) {
          const q = baselinePose.bones[toes.ctx.canonicalKeys[i]!]!;
          chain[i]!.quaternion.set(q[0]!, q[1]!, q[2]!, q[3]!);
        }
        root.updateMatrixWorld(true);
      };
      const plants: footContact.ContactPlant[] = [
        { solver: foot, fromMs: 0, toMs: 300, target: null, reuseInitialAnchor: false },
        ...(withToes ? [{ solver: toes, fromMs: 250, toMs: 400, target: null, reuseInitialAnchor: false }] : []),
      ];
      const frame: footContact.ContactPlantFrame = { rest, hingeAxisRest: rest, heelStrikeY: 0, initialTargets: new Map() };
      const footHeldAfter: number[] = [];
      let length = NaN;
      for (let t = 0; t <= 600; t += 1000 / 60) {
        poseFk();
        footContact.stepContactPlants(plants, t, frame);
        if (t > 300 && Number.isNaN(length)) length = plants[0]!.release?.lengthMs ?? NaN;
        if (t > 400 + 1e-6 && plants[0]!.target) footHeldAfter.push(t);
      }
      poseFk();
      return { length, footHeldAfter };
    };
    const alone = run(false);
    const both = run(true);
    // eslint-disable-next-line no-console
    console.log(`foot release ${alone.length} ms alone, ${both.length} ms with the toes window ending 100 ms after it; foot still releasing after the toes let go at ${both.footHeldAfter.map((t) => t.toFixed(1)).join(', ') || 'no frame'}`);
    expect(alone.length).toBe(footContact.PLANT_RELEASE_BLEND_MS);
    expect(both.length).toBeCloseTo(100, 9);
    expect(both.footHeldAfter, 'frames after the toes window on which the foot release still runs').toEqual([]);
  });
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

  it('the gap asks for the length that keeps the target within FK’s effector speed, read where the catch-up runs, continuous with a continuous slope', () => {
    const G = footContact.plantReleaseGapMs;
    // FK still: no FK speed to keep within — the gap asks for nothing.
    expect(G({ effectorSpeed: 0 }, 0.1)).toBe(0);
    // FK lifting the foot at 0.3 m/s: a 10 cm gap takes 1.98 × 0.1 / 0.0003 ms…
    expect(G({ effectorSpeed: 0.0003 }, 0.1)).toBeCloseTo((1.98 * 0.1) / 0.0003, 6);
    // …a gap past the 15 cm cap no longer, and nothing asks for over 800 ms.
    expect(G({ effectorSpeed: 0.0003 }, 0.4)).toBe(800);
    expect(G({ effectorSpeed: 0.001 }, 0.4)).toBeCloseTo((1.98 * 0.15) / 0.001, 6);
    // The gap is FK's offset where the catch-up runs fastest, 0.68 of the way
    // through the release it asks for — FK moves on meanwhile. With FK moving
    // away at 0.1 m/s from 5 cm at the window's end, that is the fixed point
    // L = 1.98 · (0.05 + 0.0001 · 0.68 L) / 0.001.
    const fixedPoint = (1.98 * 0.05) / 0.001 / (1 - (1.98 * 0.68 * 0.0001) / 0.001);
    expect(G({ effectorSpeed: 0.001 }, (ms) => 0.05 + 0.0001 * ms)).toBeCloseTo(fixedPoint, 2);
    // Continuous, with a continuous slope, across every joint of the rule: on
    // a grid far finer than any of its roundings, the slope never jumps by
    // more than a twentieth of its largest value (a kink jumps by all of it).
    for (const effectorSpeed of [0.00007, 0.0003, 0.0009, 0.0014, 0.002]) {
      const at = (g: number) => G({ effectorSpeed }, g);
      const h = 1e-8;
      const slopes: number[] = [];
      for (let g = 0; g <= 0.3; g += 1e-5) slopes.push((at(g + h) - at(g)) / h);
      const largest = Math.max(...slopes.map(Math.abs));
      let jump = 0;
      for (let k = 1; k < slopes.length; k += 1) jump = Math.max(jump, Math.abs(slopes[k]! - slopes[k - 1]!));
      expect(jump, `v ${effectorSpeed}: largest slope ${largest.toFixed(0)} ms/m`).toBeLessThan(0.05 * Math.max(largest, 1));
    }
    // …and continuous in FK's speed, through the gate that fades the gap rule
    // in: never more than 30 ms apart for FK 1 mm/s apart (the steepest, 24
    // ms, is where a near-still FK's 800 ms fades in over 0.05–0.1 m/s).
    for (let v = 0.00001; v < 0.004; v += 0.000001) {
      const a = G({ effectorSpeed: v }, 0.1);
      const b = G({ effectorSpeed: v + 0.000001 }, 0.1);
      expect(Math.abs(a - b), `v ${v}`).toBeLessThan(30);
    }
  });

  it('a gap stretches the release only where FK leaves room to catch up in: FK slowing or speeding up from rest, not FK at its plateau', () => {
    const L = footContact.plantReleaseLengthMs;
    const base = footContact.PLANT_RELEASE_BLEND_MS;
    const step = 5;
    const horizonMs = 800;
    /** A plan whose one moving joint turns at `speed(t)` °/ms (t from the
     *  window's end), FK's effector at `effectorSpeed`, read as far as the
     *  release's longest read reaches. */
    const plan = (speed: (t: number) => number, effectorSpeed: number, burstMs = base): footContact.PlantReleasePlan => {
      const row: number[] = [];
      for (let t = -base; t < horizonMs + base; t += step) row.push(speed(t));
      return { burstMs, effectorSpeed, jointSpeeds: [row, row.map(() => 0)], path: [], horizonMs };
    };
    // A 10 cm gap, FK lifting at 0.3 m/s: 1.98 × 0.1 / 0.0003 = 660 ms asked.
    const asked = (1.98 * 0.1) / 0.0003;
    // FK slowing after the window: its catch-up falls where FK has slack — the
    // whole stretch, joined to the burst by the smooth maximum (20 ms wide).
    const slowing = plan((t) => (t < 0 ? 0.3 : 0.3 * Math.exp(-t / 150)), 0.0003);
    expect(L(slowing, 0.1)).toBeCloseTo(asked, 6);
    // FK speeding up slowly from rest (the single-leg stance's lift): the
    // stretch's middle half runs well below FK's peak over the release, so it
    // stands too.
    const fromRest = plan((t) => Math.max(0, 0.0005 * t), 0.0003);
    expect(L(fromRest, 0.1)).toBeCloseTo(asked, 6);
    // FK at its plateau from the window on (the 0.6× walk's braking step): no
    // stretch leaves it room — the release keeps the burst's length, with no
    // smooth-maximum offset…
    const plateau = plan(() => 0.3, 0.0003);
    expect(L(plateau, 0.1)).toBe(base);
    expect(L(plan(() => 0.3, 0.0003, 162), 0.1)).toBe(162);
    // …and a still joint takes no part in that: only the moving one is read.
    expect(L(plan((t) => (t < 0 ? 0.3 : 0.3 * Math.exp(-t / 150)), 0.0003), 0.1)).toBe(L(slowing, 0.1));
    // Nothing is stretched past the plan's read, nor past 800 ms.
    expect(L({ ...slowing, horizonMs: 300 }, 0.1)).toBeLessThanOrEqual(300 + 1e-9);
    expect(L(slowing, 0.4)).toBeLessThanOrEqual(800);
    // In the gap, where FK leaves room, the length is continuous (no step
    // larger than a grid step's worth of slope) from the burst up.
    let worst = 0;
    for (let g = 0; g <= 0.2; g += 0.0005) worst = Math.max(worst, Math.abs(L(slowing, g + 0.0005) - L(slowing, g)));
    expect(worst, 'largest step of the length over a 0.5 mm step of the gap (ms)').toBeLessThan(5);
  });
});
