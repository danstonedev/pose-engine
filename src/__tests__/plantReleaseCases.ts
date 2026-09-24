/**
 * The motions every release is compared on against 5c1c9ac
 * (plantReleaseMain*.test.ts), and the comparison itself. 5c1c9ac's releases
 * are a fixture (fixtures/plantRelease.5c1c9ac.json) measured on that tree by
 * the same code (plantReleaseTrace: `releaseTraces` → `storeRelease` for every
 * case, rig and rate below).
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ComposedMotion } from '../services/motionSequence';
import { buildFigureEightWalk, buildTravelRun, buildTravelWalk } from '../services/movementLocomotion';
import { ddxJamesWalk } from './ddxJamesWalk';
import { toePivotWalk } from './plantReleaseRig';
import {
  compareRelease,
  JOINT_NAMES,
  releaseTraces,
  storeRelease,
  type ReleaseCase,
  type ReleaseComparison,
  type StoredRelease,
} from './plantReleaseTrace';
import type { Rig } from './plantReleaseRig';

export const RATES = [30, 60, 120] as const;
export const RIGS = ['male', 'female'] as const;

const t = (joint: string, motion: string, targetDegrees: number) => ({ joint, motion, targetDegrees });

/** A foot held at the start of a hip-45° / knee-60° lift over `liftMs`, let
 *  go at `releaseMs` into it (the other foot planted throughout). */
export function heldLift(releaseMs: number, liftMs: number): ComposedMotion {
  return {
    name: 'held lift',
    stance: 'planted',
    startFrom: 'neutral',
    keyframes: [{ durationMs: liftMs, holdMs: 1500, targets: [t('L_UpLeg', 'hipFlexion', 45), t('L_Leg', 'kneeFlexion', 60)] }],
    contacts: [{ foot: 'R_Foot' }, { foot: 'L_Foot', fromMs: 0, toMs: releaseMs }],
  } as ComposedMotion;
}

/** An exam-style command on a planted stance: the left hip and knee flexed to
 *  90° over 1.2 s, held 0.8 s and returned, its foot let go 150 ms in. */
export function hipFlexion90(): ComposedMotion {
  const targets = [t('L_UpLeg', 'hipFlexion', 90), t('L_Leg', 'kneeFlexion', 90)];
  return {
    name: 'hip flex L',
    stance: 'planted',
    startFrom: 'neutral',
    keyframes: [
      { durationMs: 1200, holdMs: 800, targets },
      { durationMs: 1200, targets: targets.map((x) => ({ ...x, targetDegrees: 0 })) },
    ],
    contacts: [{ foot: 'R_Foot' }, { foot: 'L_Foot', toMs: 150 }],
  } as ComposedMotion;
}

const m = (motion: () => ComposedMotion): ReleaseCase => ({ motion });

/** The walks: the straight walk at three paces, the heading-180 walk, the
 *  curved walks, and the figure-eight played as its contract says — a chain,
 *  its second segment a continuation of the first (sampleMotionChain). */
export const WALKS: Record<string, ReleaseCase> = {
  walk: m(() => buildTravelWalk()),
  'walk-1.2': m(() => buildTravelWalk({ speed: 1.2 })),
  'walk-1.5': m(() => buildTravelWalk({ speed: 1.5 })),
  'walk-h180': m(() => buildTravelWalk({ headingDeg: 180 })),
  'walk-t45': m(() => buildTravelWalk({ turnDeg: 45 })),
  'walk-t90': m(() => buildTravelWalk({ turnDeg: 90 })),
  'walk-t-90': m(() => buildTravelWalk({ turnDeg: -90 })),
  'walk-t120': m(() => buildTravelWalk({ turnDeg: 120 })),
  'walk-0.8-t90': m(() => buildTravelWalk({ speed: 0.8, turnDeg: 90 })),
  'fig8-1': { chain: () => [...buildFigureEightWalk()], part: 0 },
  'fig8-2': { chain: () => [...buildFigureEightWalk()], part: 1 },
};

/** DDx's walk for James — two cycles of the 0.85 walk with forefoot holds
 *  (ddxJamesWalk) — and the toe-pivot walk (DDx's hold pattern on the
 *  engine's walk) at four paces: their toe-offs and the braking step (the
 *  left toes' release). */
export const TOES: Record<string, ReleaseCase> = {
  'ddx-walk': m(() => ddxJamesWalk()),
  toe: m(() => toePivotWalk()),
  'toe0.6': m(() => toePivotWalk(0.6)),
  'toe0.85': m(() => toePivotWalk(0.85)),
  'toe1.2': m(() => toePivotWalk(1.2)),
  'toe1.5': m(() => toePivotWalk(1.5)),
};

/** The travel run, jog and sprint at 0.7, 1 and 1.3 of their pace. */
export const RUNS: Record<string, ReleaseCase> = {
  'trun-0.7': m(() => buildTravelRun({ speed: 0.7 })),
  trun: m(() => buildTravelRun()),
  'trun-1.3': m(() => buildTravelRun({ speed: 1.3 })),
  'tjog-0.7': m(() => buildTravelRun({ pattern: 'jog', speed: 0.7 })),
  tjog: m(() => buildTravelRun({ pattern: 'jog' })),
  'tjog-1.3': m(() => buildTravelRun({ pattern: 'jog', speed: 1.3 })),
  'tsprint-0.7': m(() => buildTravelRun({ pattern: 'sprint', speed: 0.7 })),
  tsprint: m(() => buildTravelRun({ pattern: 'sprint' })),
  'tsprint-1.3': m(() => buildTravelRun({ pattern: 'sprint', speed: 1.3 })),
};

/** A foot let go 50–250 ms into a 300–600 ms lift, and the hip flexed to 90°
 *  with its foot let go 150 ms in. */
export const LIFTS: Record<string, ReleaseCase> = {
  'heldlift-50-600': m(() => heldLift(50, 600)),
  'heldlift-100-600': m(() => heldLift(100, 600)),
  'heldlift-150-400': m(() => heldLift(150, 400)),
  'heldlift-250-300': m(() => heldLift(250, 300)),
  'cmd-hipflex90-L': m(() => hipFlexion90()),
};

export type MainGroup = 'WALKS' | 'TOES' | 'RUNS' | 'LIFTS';
export const GROUPS: Record<MainGroup, Record<string, ReleaseCase>> = { WALKS, TOES, RUNS, LIFTS };

/** 5c1c9ac's releases: group → case → rig → rate → `Foot@toMs` → release. */
export type MainFixture = Record<string, Record<string, Record<string, Record<string, Record<string, StoredRelease>>>>>;

let fixture: MainFixture | null = null;
export const mainFixture = (): MainFixture =>
  (fixture ??= JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/plantRelease.5c1c9ac.json', import.meta.url)), 'utf8'),
  ) as MainFixture);

/** Ties compare equal: the fixture keeps three decimals (°/frame, °/frame²,
 *  mm/frame², cm), so anything within 0.002 of 5c1c9ac's is its value. */
const EPS = 0.002;

/**
 * Every way this tree's releases of one case, rig and rate are worse than
 * 5c1c9ac's, over the common window of each release, keyed
 * `rig case Hz release metric` with the number measured:
 *  - `hip|knee|ankle`: a joint turning faster than 5c1c9ac's release did;
 *  - `hip|knee|ankle FK`: a joint turning faster than this tree's own FK over
 *    the window where 5c1c9ac's stayed within its FK's (where 5c1c9ac too
 *    outran its FK, the first check is the bound);
 *  - `… change` and `accel`: a joint's speed change or the effector's second
 *    difference over 5c1c9ac's. At 30 Hz these are the accepted price of a C1
 *    release (5c1c9ac's linear ramp read as a one-frame kink there) as long
 *    as every joint is within 5c1c9ac's speed, and are not listed then;
 *  - `toes|foot low|under`: going deeper under the floor, or on more frames.
 * Also the releases it compared (every one 5c1c9ac has must be here).
 */
export function worseThanMain(
  group: MainGroup,
  rig: Rig,
  key: string,
  hz: number,
): { compared: string[]; missing: string[]; worse: Map<string, number>; detail: Map<string, string> } {
  const main = mainFixture()[group]![key]![rig.variant]![String(hz)]!;
  const ours = releaseTraces(rig, key, GROUPS[group][key]!, hz);
  const worse = new Map<string, number>();
  const detail = new Map<string, string>();
  const missing: string[] = [];
  const compared: string[] = [];
  for (const [release, stored] of Object.entries(main)) {
    const r = ours[release];
    if (!r) {
      missing.push(release);
      continue;
    }
    compared.push(release);
    const c: ReleaseComparison = compareRelease(r, stored);
    const id = (what: string) => `${rig.variant} ${key} ${hz} ${release} ${what}`;
    const flag = (what: string, ours: number, theirs: number, unit: string) => {
      worse.set(id(what), ours);
      detail.set(id(what), `${ours.toFixed(2)} ${unit}, 5c1c9ac ${theirs.toFixed(2)} (window ${c.T.toFixed(0)} ms)`);
    };
    let speedsWithin = true;
    JOINT_NAMES.forEach((joint, n) => {
      const s = c.speed[n]!;
      if (s.ours > s.main + EPS) {
        speedsWithin = false;
        flag(joint, s.ours, s.main, '°/frame');
      }
      const mainOutranFk = s.main > s.fkMain + EPS;
      if (!mainOutranFk && s.ours > s.fkOurs + EPS) flag(`${joint} FK`, s.ours, s.fkOurs, '°/frame (FK)');
    });
    if (hz !== 30 || !speedsWithin) {
      JOINT_NAMES.forEach((joint, n) => {
        const s = c.change[n]!;
        if (s.ours > s.main + EPS) flag(`${joint} change`, s.ours, s.main, '°/frame²');
      });
      if (c.accel.ours > c.accel.main + EPS) flag('accel', c.accel.ours, c.accel.main, 'mm/frame²');
    }
    const f = c.floor;
    if (f.ours.toesLow > f.main.toesLow + EPS) flag('toes low', f.ours.toesLow, f.main.toesLow, 'cm under');
    if (f.ours.toesUnder > f.main.toesUnder) flag('toes under', f.ours.toesUnder, f.main.toesUnder, 'frames');
    if (f.ours.footLow > f.main.footLow + EPS) flag('foot low', f.ours.footLow, f.main.footLow, 'cm under');
    if (f.ours.footUnder > f.main.footUnder) flag('foot under', f.ours.footUnder, f.main.footUnder, 'frames');
  }
  return { compared, missing, worse, detail };
}

/** A documented shortfall's recorded value may be matched, not exceeded
 *  (floating-point slack only). */
export const within = (measured: number, recorded: number): boolean => measured <= recorded * (1 + 1e-4) + 1e-4;

/**
 * The comparison every plantReleaseMain* test runs for one case on one rig, at
 * 30, 60 and 120 Hz: every release 5c1c9ac has is released here, and whatever
 * is worse than 5c1c9ac's (worseThanMain) is listed in `notMet` with the value
 * measured — which it may match but not exceed — while every listed entry is
 * still worse than 5c1c9ac (so the list is what the tree does, no more).
 * Returns a line per rate for the log.
 */
export function expectNoWorseThanMain(
  group: MainGroup,
  rig: Rig,
  key: string,
  notMet: Readonly<Record<string, number>>,
): string[] {
  const log: string[] = [];
  const prefix = `${rig.variant} ${key} `;
  const seen = new Set<string>();
  for (const hz of RATES) {
    const { compared, missing, worse, detail } = worseThanMain(group, rig, key, hz);
    expect(missing, `${prefix}@${hz} Hz: 5c1c9ac's releases, all released here`).toEqual([]);
    expect(compared.length, `${prefix}@${hz} Hz: releases compared`).toBeGreaterThan(0);
    for (const [id, measured] of worse) {
      seen.add(id);
      const recorded = notMet[id];
      log.push(`worse than 5c1c9ac: ${id} — ${detail.get(id)}${recorded !== undefined ? ` (documented: ${recorded})` : ''}`);
      expect(recorded !== undefined, `${id}: ${detail.get(id)} — worse than 5c1c9ac, and not documented`).toBe(true);
      expect(within(measured, recorded!), `${id}: ${measured} — worse than its documented ${recorded}`).toBe(true);
    }
  }
  const stale = Object.keys(notMet).filter((id) => id.startsWith(prefix) && !seen.has(id));
  expect(stale, `${prefix}: documented as worse than 5c1c9ac, and no longer is — remove`).toEqual([]);
  return log;
}

/**
 * Regenerating the fixtures. 5c1c9ac's releases: on a checkout of 5c1c9ac with
 * this file, plantReleaseTrace.ts, plantReleaseRig.ts and ddxJamesWalk.ts
 * copied into its src/__tests__, a one-off test writes
 * `JSON.stringify(await measureAllReleases(loadRigOf))` to
 * fixtures/plantRelease.5c1c9ac.json. What this tree does worse
 * (fixtures/plantRelease.notMet.json): `await listWorseThanMain(loadRigOf)`
 * here, each value rounded UP to three decimals.
 */
export async function measureAllReleases(
  loadRig: (variant: (typeof RIGS)[number]) => Promise<Rig>,
): Promise<MainFixture> {
  const out: MainFixture = {};
  for (const variant of RIGS) {
    const rig = await loadRig(variant);
    for (const [group, set] of Object.entries(GROUPS)) {
      for (const [key, rc] of Object.entries(set)) {
        for (const hz of RATES) {
          const stored: Record<string, StoredRelease> = {};
          for (const [release, trace] of Object.entries(releaseTraces(rig, key, rc, hz))) stored[release] = storeRelease(trace);
          (((out[group] ??= {})[key] ??= {})[variant] ??= {})[String(hz)] = stored;
        }
      }
    }
  }
  return out;
}

export async function listWorseThanMain(
  loadRig: (variant: (typeof RIGS)[number]) => Promise<Rig>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const variant of RIGS) {
    const rig = await loadRig(variant);
    for (const group of Object.keys(GROUPS) as MainGroup[]) {
      for (const key of Object.keys(GROUPS[group])) {
        for (const hz of RATES) {
          for (const [id, v] of worseThanMain(group, rig, key, hz).worse) out[id] = Math.ceil(v * 1000 - 1e-9) / 1000;
        }
      }
    }
  }
  return out;
}
