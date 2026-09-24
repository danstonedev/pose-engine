/**
 * The motions every release is compared on against 5c1c9ac (plantReleaseMain*
 * tests), and the one measurement both sides are read with — so the fixture
 * of 5c1c9ac's releases (fixtures/plantRelease.5c1c9ac.json) was measured by
 * running exactly this on that tree: `measureAgainstMain` for every case, rig
 * and rate below.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ComposedMotion } from '../services/motionSequence';
import { buildFigureEightWalk, buildTravelRun, buildTravelWalk } from '../services/movementLocomotion';
import { releaseSpeeds, sampleOn, toePivotWalk, withoutContacts, type Rig } from './plantReleaseRig';

export const RATES = [30, 60, 120] as const;
export const RIGS = ['male', 'female'] as const;

/** A foot held at the start of a hip-45° / knee-60° lift over `liftMs`, let
 *  go at `releaseMs` into it (the other foot planted throughout). */
export function heldLift(releaseMs: number, liftMs: number): ComposedMotion {
  const t = (joint: string, motion: string, targetDegrees: number) => ({ joint, motion, targetDegrees });
  return {
    name: 'held lift',
    stance: 'planted',
    startFrom: 'neutral',
    keyframes: [{ durationMs: liftMs, holdMs: 1500, targets: [t('L_UpLeg', 'hipFlexion', 45), t('L_Leg', 'kneeFlexion', 60)] }],
    contacts: [{ foot: 'R_Foot' }, { foot: 'L_Foot', fromMs: 0, toMs: releaseMs }],
  } as ComposedMotion;
}

/** The curved walks and the figure-eight: the foot releases whose hand-back
 *  of a near-floor hold turned the hip faster than 5c1c9ac did. */
export const CURVED: Record<string, () => ComposedMotion> = {
  'walk-t45': () => buildTravelWalk({ turnDeg: 45 }),
  'walk-t90': () => buildTravelWalk({ turnDeg: 90 }),
  'walk-t-90': () => buildTravelWalk({ turnDeg: -90 }),
  'walk-t120': () => buildTravelWalk({ turnDeg: 120 }),
  'fig8-1': () => buildFigureEightWalk()[0]!,
  'fig8-2': () => buildFigureEightWalk()[1]!,
};

/** The toe-pivot walk's braking step (its left toes' release) at three speeds. */
export const BRAKING: Record<string, () => ComposedMotion> = {
  toe: () => toePivotWalk(),
  'toe1.2': () => toePivotWalk(1.2),
  'toe1.5': () => toePivotWalk(1.5),
};

/** Runs, jogs and sprints at three paces, lifts let go early and late, and the
 *  DDx-pattern toe walk's toe-offs. */
export const OTHERS: Record<string, () => ComposedMotion> = {
  'trun-0.7': () => buildTravelRun({ speed: 0.7 }),
  trun: () => buildTravelRun(),
  'trun-1.3': () => buildTravelRun({ speed: 1.3 }),
  'tjog-0.7': () => buildTravelRun({ pattern: 'jog', speed: 0.7 }),
  tjog: () => buildTravelRun({ pattern: 'jog' }),
  'tjog-1.3': () => buildTravelRun({ pattern: 'jog', speed: 1.3 }),
  'tsprint-0.7': () => buildTravelRun({ pattern: 'sprint', speed: 0.7 }),
  tsprint: () => buildTravelRun({ pattern: 'sprint' }),
  'tsprint-1.3': () => buildTravelRun({ pattern: 'sprint', speed: 1.3 }),
  'heldlift-50-600': () => heldLift(50, 600),
  'heldlift-100-600': () => heldLift(100, 600),
  'heldlift-150-400': () => heldLift(150, 400),
  'heldlift-250-300': () => heldLift(250, 300),
  toe: () => toePivotWalk(),
  'toe0.85': () => toePivotWalk(0.85),
};

/** One release as both trees are compared on it. */
export interface MainMeasure {
  lastedMs: number;
  /** The release's fastest hip, knee and ankle turn (°/frame). */
  peaks: number[];
  /** FK's local peak of each (°/frame). */
  fkPeaks: number[];
  /** The effector's fastest change of step (mm/frame²). */
  accel: number;
  /** Over FLOOR_SPAN_MS: drop below the held point (cm), lowest height over
   *  the floor (cm), frames more than 3 mm under it. */
  dip: number;
  low: number;
  under: number;
}

/** Every release into swing of `motion` on `rig` at `hz`, by `Foot@toMs`. */
export function measureAgainstMain(
  rig: Rig,
  key: string,
  motion: () => ComposedMotion,
  hz: number,
): Record<string, MainMeasure> {
  const s = sampleOn(rig, motion, key, hz);
  const fk = sampleOn(rig, withoutContacts(motion), `${key}-fk`, hz).rec;
  const out: Record<string, MainMeasure> = {};
  for (const r of releaseSpeeds(s, fk, rig.floorY)) {
    out[`${r.foot}@${r.toMs.toFixed(0)}`] = {
      lastedMs: r.lastedMs,
      peaks: r.joints.map((j) => j.release),
      fkPeaks: r.joints.map((j) => j.fk),
      accel: r.accel * 1000,
      dip: r.floor!.dip * 100,
      low: r.floor!.low * 100,
      under: r.floor!.under,
    };
  }
  return out;
}

export type MainGroup = 'CURVED' | 'BRAKING' | 'OTHERS';

/** 5c1c9ac's releases (the fixture): per group, rig, case, rate and release,
 *  its hip / knee / ankle peaks, and its foot acceleration (the curved walks)
 *  or its toes' floor clearance (the braking step). */
type MainFixture = Record<
  MainGroup,
  Record<string, Record<string, Record<string, Record<string, { peaks: number[]; accel?: number; dip?: number; low?: number; under?: number }>>>>
>;
let fixture: MainFixture | null = null;
const mainFixture = (): MainFixture =>
  (fixture ??= JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/plantRelease.5c1c9ac.json', import.meta.url)), 'utf8'),
  ) as MainFixture);

/** Ties (a joint on FK's own peak in both trees) compare equal. */
const EPS = 1e-9;
const JOINTS = ['hip', 'knee', 'ankle'];

/**
 * Where `ours` (this tree's releases of one case, rig and rate) is worse than
 * 5c1c9ac's: each joint faster than both 5c1c9ac's release and FK's local peak;
 * for the curved walks the foot's acceleration; for the braking step its toes
 * dropping further, lower or longer under the floor. Keyed `rig case Hz
 * release metric`, each with what was measured. Also the releases it compared
 * (every one 5c1c9ac has must be here).
 */
export function worseThanMain(
  group: MainGroup,
  rig: string,
  key: string,
  hz: number,
  ours: Record<string, MainMeasure>,
): { compared: string[]; missing: string[]; worse: Map<string, string> } {
  const main = mainFixture()[group][rig]![key]![String(hz)]!;
  const worse = new Map<string, string>();
  const missing: string[] = [];
  const compared: string[] = [];
  for (const [release, m] of Object.entries(main)) {
    const c = ours[release];
    if (!c) {
      missing.push(release);
      continue;
    }
    compared.push(release);
    const id = (what: string) => `${rig} ${key} ${hz} ${release} ${what}`;
    JOINTS.forEach((joint, j) => {
      const bound = Math.max(m.peaks[j]!, c.fkPeaks[j]!);
      if (c.peaks[j]! > bound * (1 + EPS) + EPS) {
        worse.set(id(joint), `${c.peaks[j]!.toFixed(2)}°/frame, 5c1c9ac ${m.peaks[j]!.toFixed(2)}, FK ${c.fkPeaks[j]!.toFixed(2)}`);
      }
    });
    if (m.accel !== undefined && c.accel > m.accel * (1 + EPS) + EPS) {
      worse.set(id('accel'), `${c.accel.toFixed(1)} mm/frame², 5c1c9ac ${m.accel.toFixed(1)}`);
    }
    if (m.dip !== undefined && c.dip > m.dip + EPS) worse.set(id('dip'), `${c.dip.toFixed(2)} cm, 5c1c9ac ${m.dip.toFixed(2)}`);
    if (m.low !== undefined && c.low < m.low - EPS) worse.set(id('low'), `${c.low.toFixed(2)} cm, 5c1c9ac ${m.low.toFixed(2)}`);
    if (m.under !== undefined && c.under > m.under) worse.set(id('under'), `${c.under} frames, 5c1c9ac ${m.under}`);
  }
  return { compared, missing, worse };
}
