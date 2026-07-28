/**
 * MEASURED SPATIOTEMPORAL GATE FOR RUNNING — the sibling of
 * gaitSpatiotemporal.test.ts, and it exists for the same reason that one does.
 *
 * The run had run.test.ts, runParity.test.ts and floorMargin.test.ts all green
 * while travelling at 0.593 m/s — SLOWER than the engine's own walk (1.349 m/s)
 * and a factor of 7-37 below the Froude number at which humans stop walking.
 * Nothing compared a measured running variable to a normative band, so nothing
 * could see it.
 *
 * THREE TRAPS, encoded as structure because each produced a wrong reading during
 * the work that led here:
 *
 *  1. MEASURE CONTACT AT THE TOE, NOT THE ANKLE. runParity's existing contact
 *     check reads L_Foot/R_Foot — the ANKLE, which sits ~3.9 cm above the floor
 *     at neutral and higher on a plantarflexed trailing foot. A whole-clip ankle
 *     threshold therefore cannot detect double support, which is the single
 *     property that distinguishes running from walking.
 *  2. MEASURE THE STEADY CYCLE. Same entry/exit transient the walk gate
 *     documents: buildTravelRun's first and last steps are not the repeating
 *     rhythm.
 *  3. DUTY FACTOR HAS TWO CONVENTIONS. This file uses Alexander & Jayes'
 *     DF = ground contact time / STRIDE time. The GCT/step-time convention
 *     silently doubles it, and GCT/(GCT+flight) turns an elite 0.218 into 0.436.
 *     A number quoted without its convention is not a number.
 *
 * Bands live in services/normativeRun so they are engine data, not test data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../services/anatomicPose';
import { serializeCustomPose } from '../services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../services/jointAngles';
import { resolveComposedMotion } from '../services/motionSequence';
import { sampleComposedMotion } from '../services/motionRecording';
import { buildTravelRun } from '../services/movementLocomotion';
import { froudeNumber } from '../services/normativeGait';
import {
  DUTY_FACTOR_RUN_CEILING,
  FROUDE_RUN_FLOOR,
  RUN_PATTERN_BANDS,
  classifyRunPattern,
  isRunning,
  scaleCadenceToLeg,
} from '../services/normativeRun';
import { captureFloorReference } from '../services/rootMotion';
import { BODY_VARIANTS } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';

const variantCfg = BODY_VARIANTS.male;
const GLB_URL = new URL('../../models/painmap3D_male.runtime.glb', import.meta.url);

let root: THREE.Object3D;
let skinned: THREE.SkinnedMesh;
let rest: JointAngleRestReference;
let baselinePose: CustomPose;
let toeRestY = 0;

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
  // CONTACT DATUM. The toes do NOT rest at world 0 — the rig's anatomic rest puts
  // them ~3.5 cm up, and the floor-pin grounds each contact to ITS OWN rest-Y.
  // Measuring "toe down" against 0 therefore reads a perfectly planted foot as
  // airborne (and produced a 30 spm cadence and 1.6 s flights before this line
  // existed). Contact is measured against the pin's own datum.
  const floor = captureFloorReference(skinned.skeleton, variantCfg);
  toeRestY = Math.min(floor.restY['L_Toes'] ?? 0, floor.restY['R_Toes'] ?? 0);
  floor0 = floor.floorY;
}, 60_000);

interface RunMeasured {
  legM: number;
  cadenceSpm: number;
  gctMs: number;
  flightMs: number;
  dutyFactor: number;
  stepM: number;
  speedMps: number;
  froude: number;
  doubleSupportMs: number;
  flightFraction: number;
}

/** The speed settings the gate sweeps, ascending. */
const SPEEDS = [0.6, 0.8, 1.0, 1.2, 1.6];

/** Contact = the TOE within this of ITS OWN pinned rest height. Trap 1 above. */
const TOE_CONTACT_M = 0.03;
/** World-Y of the ground plane (the lowest foot contact's rest height). */
let floor0 = 0;

function measureRun(speed: number, pattern: 'jog' | 'run' | 'sprint' = 'run'): RunMeasured {
  const resolved = resolveComposedMotion(buildTravelRun({ speed, pattern }), variantCfg);
  expect(resolved.status).toBe('ok');
  const rec = sampleComposedMotion(resolved, {
    baselinePose,
    variantCfg,
    rest,
    skeletonHarness: { root, skinned },
    sampleHz: 240,
  });
  const frames = rec.frames;
  const ends: number[] = [];
  let acc = 0;
  for (const k of resolved.keyframes) {
    acc += k.durationMs + (k.holdMs ?? 0);
    ends.push(acc);
  }
  // STEADY WINDOW, from the builder rather than from counting keyframes.
  // buildTravelRun publishes the gait cycle it authored (initial contact of a
  // foot to that foot's next), which is exactly what a spatiotemporal average is
  // defined over and is entry-free by construction. Deriving it here from
  // keyframe indices is what broke when the run gained an initiation: the window
  // slid one knot early, swallowed the entry, and read a jog's duty factor as a
  // sprint's (0.41 -> 0.26). Falling back to indices keeps this measurable for a
  // motion that publishes no cycle.
  const cycle = resolved.gaitCycleMs;
  const from = cycle ? cycle.fromMs : ends[Math.min(3, ends.length - 2)]!;
  const to = cycle ? cycle.toMs : ends[Math.max(0, ends.length - 4)]!;
  const steady = frames.filter((f) => f.tMs >= from && f.tMs <= to);
  const legM = frames[0]!.worldTracks!.Hips![1]! - floor0;

  const down = (f: (typeof frames)[number], side: 'L' | 'R'): boolean =>
    (f.worldTracks![`${side}_Toes`]?.[1] ?? 1) - toeRestY <= TOE_CONTACT_M;

  // Per-foot contact runs inside the steady window.
  const runsOf = (side: 'L' | 'R'): number[] => {
    const out: number[] = [];
    let start: number | null = null;
    for (const f of steady) {
      if (down(f, side)) {
        if (start == null) start = f.tMs;
      } else if (start != null) {
        out.push(f.tMs - start);
        start = null;
      }
    }
    return out;
  };
  const contacts = [...runsOf('L'), ...runsOf('R')].filter((d) => d > 20);
  const gctMs = contacts.length ? contacts.reduce((a, b) => a + b, 0) / contacts.length : 0;

  // Airborne = neither toe down. Double support = both toes down.
  let airborne = 0;
  let doubleSupport = 0;
  let n = 0;
  for (const f of steady) {
    const l = down(f, 'L');
    const r = down(f, 'R');
    if (!l && !r) airborne += 1;
    if (l && r) doubleSupport += 1;
    n += 1;
  }
  const windowMs = (steady.at(-1)?.tMs ?? 0) - (steady[0]?.tMs ?? 0);
  const flightFraction = n ? airborne / n : 0;
  const doubleSupportMs = n ? (doubleSupport / n) * windowMs : 0;

  // Cadence from actual contact starts, DEBOUNCED. A toe crossing the contact
  // threshold repeatedly near touchdown otherwise manufactures extra "steps" and
  // inflates cadence — the reading is only as good as its edge detection.
  const MIN_RUN_MS = 40;
  const startsFor = (side: 'L' | 'R'): number[] => {
    const out: number[] = [];
    let start: number | null = null;
    let lastEnd = -Infinity;
    for (const f of steady) {
      if (down(f, side)) {
        if (start == null) start = f.tMs;
      } else if (start != null) {
        if (f.tMs - start >= MIN_RUN_MS && start - lastEnd >= MIN_RUN_MS) out.push(start);
        lastEnd = f.tMs;
        start = null;
      }
    }
    return out;
  };
  const starts = [...startsFor('L'), ...startsFor('R')].sort((a, b) => a - b);
  const stepPeriods = starts.slice(1).map((t, i) => t - starts[i]!).filter((d) => d > MIN_RUN_MS);
  const stepMs = stepPeriods.length
    ? stepPeriods.reduce((a, b) => a + b, 0) / stepPeriods.length
    : windowMs;
  const cadenceSpm = stepMs > 0 ? 60_000 / stepMs : 0;
  const strideMs = stepMs * 2;
  const flightMs = Math.max(0, stepMs - gctMs);
  const dutyFactor = strideMs > 0 ? gctMs / strideMs : 0;

  // Speed from actual root travel across the steady window.
  const z0 = steady[0]?.root?.translateM?.[2] ?? 0;
  const z1 = steady.at(-1)?.root?.translateM?.[2] ?? 0;
  const speedMps = windowMs > 0 ? Math.abs(z1 - z0) / (windowMs / 1000) : 0;
  const stepM = speedMps * (stepMs / 1000);

  return {
    legM,
    cadenceSpm,
    gctMs,
    flightMs,
    dutyFactor,
    stepM,
    speedMps,
    froude: froudeNumber(speedMps, legM),
    doubleSupportMs,
    flightFraction,
  };
}

/** Every speed setting, measured once, in ascending order. */
let measured: RunMeasured[] = [];

describe('the three patterns are DISTINCT and each lands in its own band', () => {
  const PATTERNS = ['jog', 'run', 'sprint'] as const;
  let byPattern: Record<string, RunMeasured> = {};

  beforeAll(() => {
    byPattern = Object.fromEntries(PATTERNS.map((p) => [p, measureRun(1.0, p)]));
    for (const p of PATTERNS) {
      const m = byPattern[p]!;
      // eslint-disable-next-line no-console
      console.log(
        `${p.padEnd(6)} cadence ${m.cadenceSpm.toFixed(1)} · GCT ${m.gctMs.toFixed(0)}ms · ` +
          `flight ${m.flightMs.toFixed(0)}ms · DF ${m.dutyFactor.toFixed(3)} · step ${m.stepM.toFixed(2)}m · ` +
          `${m.speedMps.toFixed(2)} m/s · Fr ${m.froude.toFixed(2)} · classifies ${classifyRunPattern(m.dutyFactor)}`,
      );
    }
  }, 300_000);

  it('each pattern CLASSIFIES as itself by duty factor', () => {
    // The strongest single statement that these are three patterns and not three
    // speeds: classifyRunPattern knows nothing about how they were built, only
    // about the duty factor they produce. Duty factor is the discriminator
    // because it is dimensionless — no leg-length scaling to get wrong.
    for (const p of PATTERNS)
      expect(classifyRunPattern(byPattern[p]!.dutyFactor), `${p} classifies as ${p}`).toBe(p);
  });

  it('each pattern lands inside its declared band — DF, GCT, cadence, Froude', () => {
    for (const p of PATTERNS) {
      const m = byPattern[p]!;
      const band = RUN_PATTERN_BANDS[p];
      const within = (v: number, [lo, hi]: readonly [number, number], what: string) => {
        expect(v, `${p} ${what} ≥ ${lo}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${p} ${what} ≤ ${hi}`).toBeLessThanOrEqual(hi);
      };
      within(m.dutyFactor, band.dutyFactor, 'duty factor');
      within(m.gctMs, band.gctMs, 'ground contact');
      within(m.froude, band.froude, 'Froude');
      // Cadence bands are quoted at the literature leg length — scale to the rig.
      const [lo, hi] = band.cadenceSpm;
      within(
        m.cadenceSpm,
        [scaleCadenceToLeg(lo, m.legM), scaleCadenceToLeg(hi, m.legM)] as const,
        'cadence (leg-scaled)',
      );
    }
  });

  it('they are ORDERED — faster pattern, shorter contact, lower duty factor, longer step', () => {
    // A speed dial alone cannot produce this: scaling every duration and
    // amplitude together moves ground time and stride time in step and leaves
    // the duty factor roughly put. Ordering on DF is what proves the patterns
    // differ in KIND rather than in pace.
    for (const [a, b] of [
      ['jog', 'run'],
      ['run', 'sprint'],
    ] as const) {
      const x = byPattern[a]!;
      const y = byPattern[b]!;
      expect(y.speedMps, `${b} is faster than ${a}`).toBeGreaterThan(x.speedMps);
      expect(y.gctMs, `${b} has shorter ground contact than ${a}`).toBeLessThan(x.gctMs);
      expect(y.dutyFactor, `${b} has a lower duty factor than ${a}`).toBeLessThan(x.dutyFactor);
      expect(y.stepM, `${b} steps longer than ${a}`).toBeGreaterThan(x.stepM);
    }
  });

  it('all three are genuinely RUNNING — no double support, above the walk-run transition', () => {
    for (const p of PATTERNS) {
      expect(isRunning(byPattern[p]!), `${p} is running`).toBe(true);
      expect(byPattern[p]!.doubleSupportMs, `${p} has no double support`).toBe(0);
    }
  });

  it('the SPRINT reaches its band only because its absorb is ballistic — the floor would forbid it', () => {
    // 85-150 ms of stance is ≤75 ms per stance keyframe, and the 'functional'
    // floor is 90 ms: two functional stance keyframes floor the sprint at 180 ms,
    // above its entire band. This pins the reasoning so a future tidy-up that
    // "simplifies" the class back to functional fails here rather than silently
    // turning the sprint into a run.
    expect(byPattern.sprint!.gctMs, 'sprint stance is under the two-functional-floor').toBeLessThan(180);
  });
});

describe('running spatiotemporals, measured on the rig', () => {
  beforeAll(() => {
    // NOT `SPEEDS.map(measureRun)` — map passes the INDEX as the second argument,
    // which lands in `pattern` and resolves RUN_PATTERNS[0] to undefined.
    measured = SPEEDS.map((sp) => measureRun(sp));
    for (const [i, m] of measured.entries())
      // eslint-disable-next-line no-console
      console.log(
        `speed ${SPEEDS[i]}: leg ${m.legM.toFixed(3)}m · cadence ${m.cadenceSpm.toFixed(1)} spm · ` +
          `GCT ${m.gctMs.toFixed(0)}ms · flight ${m.flightMs.toFixed(0)}ms · DF ${m.dutyFactor.toFixed(3)} · ` +
          `step ${m.stepM.toFixed(2)}m · speed ${m.speedMps.toFixed(3)} m/s · Fr ${m.froude.toFixed(3)} · ` +
          `doubleSupport ${m.doubleSupportMs.toFixed(0)}ms · airborne ${(m.flightFraction * 100).toFixed(0)}%`,
      );
  }, 300_000);

  // ── The definitional gates: is this a run at all? ──────────────────────────
  // These are the checks whose absence let a 0.59 m/s "run" ship green. Each is
  // a DEFINITION of running, not a preference, so they hold at EVERY setting.

  it('has NO double support at any speed — the property that makes it a run', () => {
    for (const [i, m] of measured.entries())
      expect(m.doubleSupportMs, `speed ${SPEEDS[i]}: both feet down`).toBe(0);
  });

  it('duty factor is below 0.5 at every speed (Alexander & Jayes convention)', () => {
    for (const [i, m] of measured.entries()) {
      expect(m.dutyFactor, `speed ${SPEEDS[i]} DF`).toBeLessThan(DUTY_FACTOR_RUN_CEILING);
      expect(m.dutyFactor, `speed ${SPEEDS[i]} DF is a real contact, not a hop`).toBeGreaterThan(0.15);
    }
  });

  it('clears the walk→run Froude transition at every speed', () => {
    // The ONE physically discrete boundary (normativeRun): below it an
    // inverted-pendulum vault is completable and humans walk. The old run sat at
    // Froude 0.017-0.086 — a factor of 5-26 BELOW this line while calling itself
    // a run, and no gate could say so.
    for (const [i, m] of measured.entries())
      expect(m.froude, `speed ${SPEEDS[i]} Froude`).toBeGreaterThanOrEqual(FROUDE_RUN_FLOOR);
  });

  it('is FASTER than the engine\'s own walk — at its slowest setting', () => {
    // The defect in one line. buildTravelWalk measures 1.349 m/s on this rig
    // (gaitSpatiotemporal.test.ts); the run used to travel 0.42-1.12 m/s.
    expect(measured[0]!.speedMps, 'slowest run vs the walk').toBeGreaterThan(1.5);
  });

  it('every setting satisfies isRunning() as a whole', () => {
    for (const [i, m] of measured.entries())
      expect(isRunning(m), `speed ${SPEEDS[i]} is running`).toBe(true);
  });

  // ── Pattern placement and monotonicity ────────────────────────────────────

  it('lands in the declared RUN band at speed 1 — cadence, GCT and duty factor', () => {
    const m = measured[SPEEDS.indexOf(1.0)]!;
    const band = RUN_PATTERN_BANDS.run;
    expect(m.dutyFactor, 'DF in the run band').toBeGreaterThanOrEqual(band.dutyFactor[0]);
    expect(m.dutyFactor, 'DF in the run band').toBeLessThanOrEqual(band.dutyFactor[1]);
    expect(m.gctMs, 'GCT in the run band').toBeGreaterThanOrEqual(band.gctMs[0]);
    expect(m.gctMs, 'GCT in the run band').toBeLessThanOrEqual(band.gctMs[1]);
    // Cadence bands are quoted at the literature leg length — scale to the rig.
    const [loSpm, hiSpm] = band.cadenceSpm.map((c) => scaleCadenceToLeg(c, m.legM));
    expect(m.cadenceSpm, 'cadence in the run band (leg-scaled)').toBeGreaterThanOrEqual(loSpm!);
    expect(m.cadenceSpm, 'cadence in the run band (leg-scaled)').toBeLessThanOrEqual(hiSpm!);
    expect(classifyRunPattern(m.dutyFactor), 'classifies as a run').toBe('run');
  });

  it('the speed request is monotone in every variable it should be', () => {
    // Faster ⇒ faster, longer steps, SHORTER ground contact, LOWER duty factor.
    // The last two are what actually distinguishes a fast run from a slow one;
    // a template that only scales amplitude gets the first two and misses these.
    for (let i = 1; i < measured.length; i += 1) {
      const a = measured[i - 1]!;
      const b = measured[i]!;
      const at = `${SPEEDS[i - 1]}→${SPEEDS[i]}`;
      expect(b.speedMps, `${at} travels faster`).toBeGreaterThan(a.speedMps);
      expect(b.stepM, `${at} steps longer`).toBeGreaterThan(a.stepM);
      expect(b.gctMs, `${at} ground contact shortens`).toBeLessThan(a.gctMs);
      expect(b.dutyFactor, `${at} duty factor falls`).toBeLessThan(a.dutyFactor);
    }
  });

  it('the airborne fraction agrees with the duty factor (1 − 2·DF), so the two measurements corroborate', () => {
    // An independent cross-check: flight fraction is counted frame-by-frame from
    // the toes, duty factor from contact-run durations against the step period.
    // They are computed from different quantities and must still agree — if a
    // contact-edge detection were fooling one, this would separate them.
    for (const [i, m] of measured.entries())
      expect(
        Math.abs(m.flightFraction - (1 - 2 * m.dutyFactor)),
        `speed ${SPEEDS[i]}: flight fraction vs 1−2·DF`,
      ).toBeLessThan(0.1);
  });
});
