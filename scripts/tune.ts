/**
 * MOVEMENT-PATTERN TUNING HARNESS — the runnable front door to the policy search.
 *
 *   npm run tune -- --motion walk --budget 40
 *
 * WHAT THIS IS FOR. The tuning modules (motionObjective / policySearch /
 * gaitTuning) are pure and library-shaped on purpose, which left them executable
 * only from inside vitest. An author cannot tune a movement from a test file: the
 * numbers scroll past in a green run, nothing is written down, and there is no way
 * to try a different seed or budget without editing source. This script is the
 * missing half — it loads the real rig, runs the search, and prints the evidence an
 * author needs to decide whether to accept the result.
 *
 * IT REPORTS EVIDENCE, IT DOES NOT EDIT SOURCE. The output is a recommendation and
 * a per-check breakdown; applying it is a human commit. That boundary is
 * deliberate. The identity values are clinical reference points (see gaitTuning),
 * and an optimizer that could rewrite them unattended would be able to drift the
 * reference without anyone reading a diff.
 *
 * THE HONESTY CHECKS ARE THE POINT. A tuning harness that always prints a winner is
 * worse than no harness, because a search over a flat, mis-specified or
 * non-reproducible objective still returns SOMETHING and it will look like a
 * result. So a recommendation here has to survive six separate ways of being wrong:
 *
 *   1. SENSITIVITY (before the search) — probe each parameter across its full range.
 *      One that moves no graded check is held at its shipped value instead of being
 *      searched, because an unobservable dimension only adds noise to the others.
 *   2. DETERMINISM — the rig is mutated in place across evaluations, so the same
 *      vector could in principle score differently depending on what ran before it.
 *      The identity point is measured twice, once at the start and once after the
 *      whole search, and a mismatch invalidates the run outright.
 *   3. DYNAMIC RANGE — if the objective does not move across the search's own
 *      history, there was no gradient and the "best" is the first lucky sample.
 *   4. RE-MEASUREMENT — the winning vector is scored again from a fresh evaluation
 *      and must reproduce the reward the search recorded.
 *   5. ATTRIBUTION — each coordinate is reverted alone to see what it was actually
 *      worth, and only the ones that earn their change are recommended.
 *   6. THE GATE — assessValidity stays the authority. A recommendation whose motion
 *      the gate rejects is suppressed no matter how good its reward looked.
 *
 * A run that fails 2, 3, 4 or 6 exits non-zero and says which, so this is usable in
 * CI as a regression check on the tuning loop itself.
 *
 * THIS IS NOT DECORATION — it is how the objective got debugged. Every run of this
 * harness so far has falsified something. In order: `vertical-com` was oriented to
 * reward a bouncier walk, `froude` charged a run for being a run, `self-intersection`
 * paid without limit for flinging the arms wide, and `headStabilize` turned out to be
 * invisible to every check the gate has. None of those were visible in the shipped
 * ValidityReport.score, which read 0.80 through all of it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { applyAnatomicPose } from '../src/services/anatomicPose';
import { serializeCustomPose } from '../src/services/poseRig';
import {
  captureJointAngleRestReference,
  type JointAngleRestReference,
} from '../src/services/jointAngles';
import { resolveComposedMotion, type ComposedMotion } from '../src/services/motionSequence';
import { sampleComposedMotion } from '../src/services/motionRecording';
import { captureFloorReference } from '../src/services/rootMotion';
import { assessValidity, type ValidityReport } from '../src/services/validityGate';
import { runGaitBiomechChecks } from '../src/services/gaitBiomechCheck';
import { buildTravelWalk, buildTravelRun } from '../src/services/movementLocomotion';
import { spinalGaitCoordination } from '../src/services/gaitModifiers';
import {
  motionObjective,
  type ObjectiveTerm,
  type MotionRegime,
} from '../src/services/motionObjective';
import {
  searchParameters,
  identityVector,
  type Parameter,
  type Vector,
} from '../src/services/policySearch';
import { GAIT_TRUNK_PARAMETERS, applyTrunkGains } from '../src/services/gaitTuning';
import { BODY_VARIANTS } from '../src/anatomy/bodyVariants';
import type { CustomPose } from '../src/types';

// ── The tunable jobs ────────────────────────────────────────────────────────────
// A job pairs a base motion with the parameter surface that shapes it. Two entries
// is not a limitation of the harness, it is the honest extent of what the engine
// currently exposes as tunable options (see gaitTuning's scope note). Run BOTH: a
// gain set that only helps the walk it was developed against has been fit, not
// tuned, and the second job is what makes that visible.

interface TuneJob {
  readonly id: string;
  readonly summary: string;
  /** What the motion is TRYING to be. Band terms are graded against this; getting
   *  it wrong charges a correct motion for being itself (see MotionRegime). */
  readonly regime: MotionRegime;
  readonly parameters: readonly Parameter[];
  readonly build: (v: Vector) => ComposedMotion;
}

const JOBS: readonly TuneJob[] = [
  {
    id: 'walk',
    summary: 'travel walk — trunk coordination gains',
    regime: 'walk',
    parameters: GAIT_TRUNK_PARAMETERS,
    build: (v) => applyTrunkGains(buildTravelWalk(), v, spinalGaitCoordination),
  },
  {
    id: 'run',
    summary: 'travel run — trunk coordination gains',
    regime: 'run',
    parameters: GAIT_TRUNK_PARAMETERS,
    // The run builder already applies its own spinal pass at energy 2; re-applying
    // here with the search's gains is the same seam the walk uses, and `energy` is
    // left at the builder's derivation so only the four gains move.
    build: (v) => applyTrunkGains(buildTravelRun(), v, spinalGaitCoordination),
  },
];

// ── Arguments ───────────────────────────────────────────────────────────────────
// STRICT parsing. An unrecognised flag aborts rather than being ignored: a typo in
// `--budget` on a 20-minute run that silently used the default would produce a
// report whose header does not describe what actually ran.

interface Args {
  motion: string;
  budget: number;
  seed: number;
  hz: number;
  initialStep: number;
  json: string | null;
}

const DEFAULTS: Args = {
  motion: 'walk',
  budget: 40,
  seed: 7,
  hz: 30,
  initialStep: 0.15,
  json: null,
};

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { ...DEFAULTS };
  const numeric: Record<string, (n: number) => void> = {
    budget: (n) => (out.budget = n),
    seed: (n) => (out.seed = n),
    hz: (n) => (out.hz = n),
    'initial-step': (n) => (out.initialStep = n),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith('--')) throw new Error(`unexpected argument "${raw}" (flags take --name value)`);
    const [flag, inlineValue] = raw.slice(2).split('=', 2) as [string, string | undefined];
    const value = inlineValue ?? argv[++i];
    if (flag === 'help') {
      printUsage();
      process.exit(0);
    }
    if (value === undefined) throw new Error(`--${flag} needs a value`);
    if (flag === 'motion') {
      out.motion = value;
    } else if (flag === 'json') {
      out.json = value;
    } else if (numeric[flag]) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`--${flag} must be a number, got "${value}"`);
      numeric[flag]!(n);
    } else {
      throw new Error(`unknown flag --${flag}. Run with --help.`);
    }
  }
  if (out.budget < 2) throw new Error('--budget must be at least 2 (identity + one proposal)');
  if (out.hz < 5) throw new Error('--hz below 5 undersamples the gate checks');
  return out;
}

function printUsage(): void {
  const ids = JOBS.map((j) => j.id).join(' | ');
  process.stdout.write(
    [
      'Tune a movement pattern against the engine objective.',
      '',
      '  npm run tune -- [flags]',
      '',
      `  --motion <${ids}|all>   which job to tune            (default ${DEFAULTS.motion})`,
      `  --budget <n>              evaluations to spend         (default ${DEFAULTS.budget})`,
      `  --seed <n>                PRNG seed; same seed, same run (default ${DEFAULTS.seed})`,
      `  --hz <n>                  sampler rate                 (default ${DEFAULTS.hz})`,
      `  --initial-step <f>        first step, fraction of range (default ${DEFAULTS.initialStep})`,
      '  --json <path>             also write the full report as JSON',
      '',
      'Exits non-zero if the run fails one of its own honesty checks.',
      '',
    ].join('\n'),
  );
}

// ── The rig ─────────────────────────────────────────────────────────────────────

interface Rig {
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  rest: JointAngleRestReference;
  baselinePose: CustomPose;
  rootRest0: THREE.Vector3;
  rootQuat0: THREE.Quaternion;
  floorY: number;
}

const variantCfg = BODY_VARIANTS.male;

async function loadRig(): Promise<Rig> {
  const buf = readFileSync(
    fileURLToPath(new URL('../models/painmap3D_male.runtime.glb', import.meta.url)),
  );
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    l.parse(ab, '', res as never, rej);
  });
  const root: THREE.Object3D = gltf.scene;
  root.scale.setScalar(variantCfg.pose.rootScale);
  let skinned: THREE.SkinnedMesh | undefined;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  if (!skinned) throw new Error('no SkinnedMesh in the runtime GLB');
  root.updateMatrixWorld(true);
  applyAnatomicPose(root, variantCfg);
  root.updateMatrixWorld(true);
  return {
    root,
    skinned,
    rest: captureJointAngleRestReference(skinned.skeleton, variantCfg),
    baselinePose: serializeCustomPose(skinned.skeleton, variantCfg, 'male'),
    rootRest0: root.position.clone(),
    rootQuat0: root.quaternion.clone(),
    floorY: captureFloorReference(skinned.skeleton, variantCfg).floorY,
  };
}

// ── Evaluation ──────────────────────────────────────────────────────────────────

interface Evaluation {
  reward: number;
  valid: boolean;
  /** The shipped token score, printed alongside so the gap between the two is
   *  visible in every run rather than being a claim in a comment. */
  score: number;
  overall: ValidityReport['overall'];
  terms: ObjectiveTerm[];
  ungraded: string[];
  resolved: boolean;
}

function makeEvaluator(rig: Rig, job: TuneJob, hz: number): (v: Vector) => Evaluation {
  return (v) => {
    // The rig is a single mutable object reused across every evaluation, so each
    // one has to start from the captured rest transform. Skipping this is how an
    // evaluation would inherit the previous candidate's root and become
    // order-dependent — which the determinism check exists to catch.
    rig.root.position.copy(rig.rootRest0);
    rig.root.quaternion.copy(rig.rootQuat0);
    rig.root.updateMatrixWorld(true);
    const resolved = resolveComposedMotion(job.build(v), variantCfg);
    if (resolved.status !== 'ok') {
      return {
        reward: -Infinity,
        valid: false,
        score: 0,
        overall: 'fail',
        terms: [],
        ungraded: [],
        resolved: false,
      };
    }
    const rec = sampleComposedMotion(resolved, {
      baselinePose: rig.baselinePose,
      variantCfg,
      rest: rig.rest,
      skeletonHarness: { root: rig.root, skinned: rig.skinned },
      sampleHz: hz,
    });
    const report = assessValidity(resolved, rec.frames, {
      floorY: rig.floorY,
      runBiomechChecks: runGaitBiomechChecks,
    });
    const obj = motionObjective(report, { regime: job.regime });
    return {
      reward: obj.reward,
      valid: obj.valid,
      score: report.score,
      overall: report.overall,
      terms: obj.terms,
      ungraded: obj.ungraded,
      resolved: true,
    };
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────────

const n4 = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : String(x));
const n3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x));
const signed = (x: number) => (x >= 0 ? `+${n4(x)}` : n4(x));

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    '  ' + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  return [line(headers), '  ' + widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join(
    '\n',
  );
}

/** Per-check contribution, before vs after. This is the column an author actually
 *  reads: a reward that improved is uninteresting until you know WHICH check moved,
 *  because "penetration got better" and "the knee curve got better" call for
 *  completely different follow-up work. */
function termDeltaTable(before: readonly ObjectiveTerm[], after: readonly ObjectiveTerm[]): string {
  const byId = new Map(after.map((t) => [t.id, t]));
  const rows = before.map((b) => {
    const a = byId.get(b.id);
    const d = a ? a.contribution - b.contribution : NaN;
    return [
      b.id,
      n4(b.measured),
      a ? n4(a.measured) : '—',
      n4(b.contribution),
      a ? n4(a.contribution) : '—',
      a ? signed(d) : '—',
    ];
  });
  // Biggest movers first — on eleven checks the interesting one is rarely at the top
  // alphabetically, and an author scanning a terminal reads the first two rows.
  rows.sort((x, y) => Math.abs(Number(y[5]) || 0) - Math.abs(Number(x[5]) || 0));
  return table(['check', 'measured@id', 'measured@best', 'contrib@id', 'contrib@best', 'Δ'], rows);
}

function vectorDeltaTable(params: readonly Parameter[], id: Vector, best: Vector): string {
  return table(
    ['parameter', 'identity', 'best', 'Δ', 'range'],
    params.map((p) => {
      const a = id[p.name] ?? p.identity;
      const b = best[p.name] ?? p.identity;
      return [p.name, n3(a), n3(b), signed(b - a), `${n3(p.min)}…${n3(p.max)}`];
    }),
  );
}

// ── One job ─────────────────────────────────────────────────────────────────────

interface JobOutcome {
  job: string;
  ok: boolean;
  failures: string[];
  recommend: boolean;
  baselineReward: number;
  bestReward: number;
  gain: number;
  evaluations: number;
  accepted: number;
  stoppedBy: string;
  rewardSpread: number;
  searchable: string[];
  blind: string[];
  best: Vector;
  /** The subset of `best` that survives per-parameter ablation — what a human
   *  should actually apply. */
  minimal: Vector;
  minimalGain: number;
  ablations: Ablation[];
  atBound: string[];
  identity: Vector;
  baselineScore: number;
  bestScore: number;
  baselineOverall: string;
  bestOverall: string;
  terms: { identity: ObjectiveTerm[]; best: ObjectiveTerm[] };
  ungraded: string[];
}

/** Below this the "gain" is not worth a clinical diff — it is the search finding a
 *  fifth decimal place. */
const MEANINGFUL_GAIN = 0.01;

/** A coordinate must be worth at least this much of the gain on its own before the
 *  harness will name it in a recommendation. See {@link ablate}. */
const ATTRIBUTION_FLOOR = 0.002;

/** Below this, moving a parameter across its ENTIRE range changes nothing the gate
 *  measures. Not "a small effect" — no effect. */
const SENSITIVITY_FLOOR = 1e-6;

interface Sensitivity {
  name: string;
  /** Reward span across {min, identity, max}, holding every other coordinate at
   *  its shipped value. */
  span: number;
  observable: boolean;
  note: string;
}

/**
 * PRE-FLIGHT: can this objective SEE each parameter at all?
 *
 * The engine's gate measures feet, floor contact, centre of mass, hand-to-thigh
 * clearance and three sagittal LEG curves. It has no measurement of the neck, the
 * gaze, scapular rhythm or trunk carriage. So a trunk-gain vector can contain
 * coordinates that are clinically meaningful and simultaneously invisible here —
 * `headStabilize` is exactly that, and its ablation drop measures 0.0000 because
 * nothing downstream of the neck is graded.
 *
 * Leaving such a coordinate in the search is not free. A (1+1)-ES perturbs every
 * dimension on every proposal, so an unobservable one injects pure noise into an
 * otherwise lower-dimensional problem — it makes good steps look worse and drags
 * blameless values along inside accepted ones. Probing min/identity/max up front
 * costs 2n evaluations and removes the dimension honestly, with the reason printed.
 *
 * This says nothing about whether the parameter MATTERS. It says this objective
 * cannot be used to tune it, which is a fact about the gate, not about the gait.
 */
function probeSensitivity(
  params: readonly Parameter[],
  identity: Vector,
  baseReward: number,
  evaluate: (v: Vector) => Evaluation,
): Sensitivity[] {
  return params.map((p) => {
    const rewards = [baseReward];
    for (const edge of [p.min, p.max]) {
      const e = evaluate({ ...identity, [p.name]: edge });
      // An invalid edge is still information — the parameter clearly does something,
      // it just leaves the shippable region there.
      if (e.valid) rewards.push(e.reward);
      else rewards.push(Number.NaN);
    }
    const finite = rewards.filter((r) => Number.isFinite(r));
    const sawInvalid = rewards.some((r) => !Number.isFinite(r));
    const span = finite.length > 1 ? Math.max(...finite) - Math.min(...finite) : 0;
    const observable = span > SENSITIVITY_FLOOR || sawInvalid;
    return {
      name: p.name,
      span,
      observable,
      note: observable
        ? sawInvalid && span <= SENSITIVITY_FLOOR
          ? 'only observable as a gate failure at an edge'
          : ''
        : 'no graded check responds to it — outside what this gate can measure',
    };
  });
}

function sensitivityTable(rows: readonly Sensitivity[]): string {
  return table(
    ['parameter', 'reward span over full range', 'searchable', 'note'],
    rows.map((s) => [s.name, n4(s.span), s.observable ? 'yes' : 'NO', s.note]),
  );
}

interface Ablation {
  name: string;
  identity: number;
  best: number;
  /** Reward lost by resetting THIS coordinate to identity, holding the rest at
   *  their tuned values. Positive means the coordinate is earning its change. */
  drop: number;
  attributable: boolean;
}

/**
 * WHICH KNOB ACTUALLY MATTERED.
 *
 * A (1+1)-ES perturbs every coordinate at once and accepts or rejects the vector as
 * a whole, so a coordinate can drift a long way purely by riding inside accepted
 * steps without ever having earned it. Reporting the raw winning vector as a list
 * of recommended changes therefore claims evidence the search never gathered — and
 * for an author, "change these four numbers" and "change this one number" are
 * completely different amounts of review.
 *
 * So each coordinate is put back to its shipped value on its own, with the others
 * held at their tuned values, and re-scored. What the reward loses is that
 * coordinate's contribution. Costs one evaluation per parameter.
 */
function ablate(
  params: readonly Parameter[],
  best: Vector,
  bestReward: number,
  evaluate: (v: Vector) => Evaluation,
): Ablation[] {
  return params.map((p) => {
    const probe: Vector = { ...best, [p.name]: p.identity };
    const e = evaluate(probe);
    const drop = bestReward - (e.valid ? e.reward : -Infinity);
    return {
      name: p.name,
      identity: p.identity,
      best: best[p.name]!,
      drop,
      // A coordinate that did not move needs no evidence and claims no credit.
      attributable: Math.abs(best[p.name]! - p.identity) > 1e-9 && drop > ATTRIBUTION_FLOOR,
    };
  });
}

function ablationTable(rows: readonly Ablation[]): string {
  return table(
    ['parameter', 'identity', 'best', 'reward lost if reverted', 'verdict'],
    rows.map((a) => [
      a.name,
      n3(a.identity),
      n3(a.best),
      Number.isFinite(a.drop) ? signed(a.drop) : 'invalid',
      Math.abs(a.best - a.identity) <= 1e-9
        ? 'unchanged'
        : a.attributable
          ? 'earns it'
          : 'rode along',
    ]),
  );
}

async function runJob(rig: Rig, job: TuneJob, args: Args): Promise<JobOutcome> {
  const evaluate = makeEvaluator(rig, job, args.hz);
  const identity = identityVector(job.parameters);
  const failures: string[] = [];

  process.stdout.write(`\n━━ ${job.id} — ${job.summary}\n`);
  process.stdout.write(
    `   budget ${args.budget} · seed ${args.seed} · ${args.hz} Hz · step ${args.initialStep}\n\n`,
  );

  // (1) The identity point, measured before anything else has touched the rig.
  const idFirst = evaluate(identity);
  if (!idFirst.resolved) failures.push('the identity vector does not RESOLVE — the job is broken');
  process.stdout.write(
    `   identity   reward ${n4(idFirst.reward)}   gate ${idFirst.overall} (score ${n3(idFirst.score)})\n`,
  );
  if (idFirst.ungraded.length) {
    process.stdout.write(
      `   ! ungraded checks present, they contribute NOTHING to the search: ${idFirst.ungraded.join(', ')}\n`,
    );
  }

  // PRE-FLIGHT sensitivity, before any budget is spent on a dimension the
  // objective is structurally unable to observe.
  const sensitivity = probeSensitivity(job.parameters, identity, idFirst.reward, evaluate);
  process.stdout.write('\n' + sensitivityTable(sensitivity) + '\n\n');
  const searchable = job.parameters.filter(
    (p) => sensitivity.find((s) => s.name === p.name)?.observable,
  );
  const blind = sensitivity.filter((s) => !s.observable).map((s) => s.name);
  if (!searchable.length) {
    failures.push(
      'NOTHING on this parameter surface is observable by the objective — there is no search to run.',
    );
  } else if (blind.length) {
    process.stdout.write(
      `   holding ${blind.join(', ')} at the shipped ${blind.length > 1 ? 'values' : 'value'} — ` +
        `searching an unobservable dimension only adds noise to the others.\n\n`,
    );
  }

  const t0 = process.hrtime.bigint();
  let lastPrinted = -1;
  const result = await searchParameters(
    searchable.length ? searchable : job.parameters,
    async (v) => {
      const e = evaluate(v);
      return e.valid ? e.reward : -Infinity;
    },
    {
      budget: args.budget,
      seed: args.seed,
      initialStep: args.initialStep,
      onStep: (s) => {
        // Progress matters here: at ~200-400 ms an evaluation a 200-budget run is
        // minutes long, and a silent terminal is indistinguishable from a hang.
        if (s.accepted || s.evaluation - lastPrinted >= 10) {
          lastPrinted = s.evaluation;
          const mark = s.accepted ? '✓' : ' ';
          process.stdout.write(
            `   ${mark} ${String(s.evaluation).padStart(4)}  reward ${n4(s.reward).padStart(10)}  best ${n4(s.bestReward).padStart(10)}  step ${n3(s.step)}\n`,
          );
        }
      },
    },
  );
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // The search only carries the searchable coordinates, so put the held ones back
  // before anything scores or prints the winner. Relying on the builder's `?? `
  // defaults to refill them would work by coincidence and read as an omission.
  const bestFull: Vector = { ...identity, ...result.best };

  // (2) DETERMINISM. The same vector, after the whole search has mutated the rig
  // hundreds of times. If this drifts, every reward comparison in the run was
  // between numbers measured under different conditions and the result is void.
  const idSecond = evaluate(identity);
  if (!Object.is(idSecond.reward, idFirst.reward)) {
    failures.push(
      `NON-DETERMINISTIC: the identity vector scored ${n4(idFirst.reward)} before the search and ` +
        `${n4(idSecond.reward)} after it. Rig state is leaking between evaluations; no comparison ` +
        `in this run is trustworthy.`,
    );
  }

  // (3) RE-MEASUREMENT of the winner, from a fresh evaluation.
  const bestEval = evaluate(bestFull);
  if (!Object.is(bestEval.reward, result.bestReward)) {
    failures.push(
      `IRREPRODUCIBLE WINNER: the search recorded ${n4(result.bestReward)} for the best vector; ` +
        `re-measuring it gives ${n4(bestEval.reward)}.`,
    );
  }

  // (4) DYNAMIC RANGE. A search whose objective never moved had no gradient to
  // follow, so its "best" is whichever sample happened to land first.
  const rewards = result.history.map((h) => h.reward).filter((r) => Number.isFinite(r));
  const spread = rewards.length ? Math.max(...rewards) - Math.min(...rewards) : 0;
  if (rewards.length && spread < 1e-6) {
    failures.push(
      `FLAT OBJECTIVE: ${rewards.length} valid candidates all scored within 1e-6. There is no ` +
        `gradient on this surface — any "best" here is noise.`,
    );
  }
  if (!rewards.length) {
    failures.push('EVERY candidate was invalid — the search had nothing to compare.');
  }

  // (5) THE GATE stays the authority.
  const gain = result.bestReward - result.baselineReward;
  const gateOk = bestEval.valid;
  if (!gateOk) failures.push('the winning vector does not PASS the gate; it cannot be recommended.');

  // (6) ATTRIBUTION, then the MINIMAL vector that keeps the gain. Recommending
  // every coordinate the winner happened to land on would overstate the evidence
  // and hand the author a larger diff than the result supports.
  const ablations = ablate(searchable, bestFull, result.bestReward, evaluate);
  const minimal: Vector = { ...identity };
  for (const a of ablations) if (a.attributable) minimal[a.name] = a.best;
  const minimalEval = evaluate(minimal);
  const minimalGain = minimalEval.valid ? minimalEval.reward - result.baselineReward : -Infinity;
  const changed = ablations.filter((a) => a.attributable);

  const recommend =
    failures.length === 0 && gateOk && minimalEval.valid && changed.length > 0 && minimalGain > MEANINGFUL_GAIN;

  process.stdout.write(
    `\n   ${result.evaluations} evaluations in ${(elapsedMs / 1000).toFixed(1)}s ` +
      `(${(elapsedMs / result.evaluations).toFixed(0)} ms each) · ${result.accepted} accepted · stopped by ${result.stoppedBy}\n\n`,
  );
  process.stdout.write(
    table(
      ['', 'reward', 'gate', 'token score'],
      [
        ['identity', n4(result.baselineReward), idFirst.overall, n3(idFirst.score)],
        ['best', n4(result.bestReward), bestEval.overall, n3(bestEval.score)],
        ['Δ', signed(gain), '', signed(bestEval.score - idFirst.score)],
      ],
    ) + '\n\n',
  );
  process.stdout.write(vectorDeltaTable(job.parameters, identity, bestFull) + '\n\n');
  process.stdout.write(termDeltaTable(idFirst.terms, bestEval.terms) + '\n\n');
  process.stdout.write(ablationTable(ablations) + '\n\n');

  // Terms no parameter could move are worth naming: they are where the motion is
  // losing reward that this tuning surface is structurally unable to recover, which
  // is a pointer to the next piece of engine work rather than a tuning result.
  const stuck = idFirst.terms
    .filter((t) => {
      const a = bestEval.terms.find((x) => x.id === t.id);
      return a && Math.abs(a.contribution - t.contribution) < 1e-9 && t.contribution < -0.1;
    })
    .sort((a, b) => a.contribution - b.contribution);
  if (stuck.length) {
    process.stdout.write(
      `   immovable cost (no gain available from these parameters): ${stuck
        .map((t) => `${t.id} ${n3(t.contribution)}`)
        .join(', ')}\n\n`,
    );
  }

  for (const f of failures) process.stdout.write(`   ✗ ${f}\n`);
  if (failures.length) process.stdout.write('\n');

  // A recommendation sitting against a bound is the generalized signature of the
  // failure this harness kept finding: a term that keeps paying past the point of
  // meaning, with the bound as the only thing stopping it. The bound did its job,
  // but "the constraint is what chose this value" is not the same as "the objective
  // chose this value", and only the second is a tuning result. Worth a human's eye
  // every time, so it is stated rather than left to be noticed in the table.
  const atBound = changed.filter((a) => {
    const p = job.parameters.find((q) => q.name === a.name)!;
    const t = (a.best - p.min) / (p.max - p.min);
    return t <= 0.05 || t >= 0.95;
  });

  if (recommend) {
    process.stdout.write(
      `   → RECOMMEND — the MINIMAL change that holds the gain ` +
        `(${signed(minimalGain)} of the search's ${signed(gain)}):\n`,
    );
    for (const a of changed) {
      process.stdout.write(`        ${a.name}: ${n3(a.identity)} → ${n3(a.best)}\n`);
    }
    const rode = ablations.filter((a) => !a.attributable && Math.abs(a.best - a.identity) > 1e-9);
    if (rode.length) {
      process.stdout.write(
        `      (${rode.map((a) => a.name).join(', ')} moved during the search but earn nothing; left alone)\n`,
      );
    }
    if (atBound.length) {
      process.stdout.write(
        `\n      ! ${atBound.map((a) => a.name).join(', ')} landed AGAINST a bound — the search wanted to\n` +
          `        keep going and the constraint stopped it, not the objective. Before applying, check\n` +
          `        which term is still paying at the edge (see the Δ column) and whether it should be.\n`,
      );
    }
    process.stdout.write('\n');
  } else if (!failures.length) {
    const why = !changed.length
      ? 'no coordinate earned its change under ablation'
      : `the attributable gain ${signed(minimalGain)} is under the ${MEANINGFUL_GAIN} floor`;
    process.stdout.write(`   → NO CHANGE — ${why}; the shipped values stand.\n\n`);
  }

  return {
    job: job.id,
    ok: failures.length === 0,
    failures,
    recommend,
    baselineReward: result.baselineReward,
    bestReward: result.bestReward,
    gain,
    evaluations: result.evaluations,
    accepted: result.accepted,
    stoppedBy: result.stoppedBy,
    rewardSpread: spread,
    searchable: searchable.map((p) => p.name),
    blind,
    best: bestFull,
    minimal,
    minimalGain,
    ablations,
    atBound: atBound.map((a) => a.name),
    identity,
    baselineScore: idFirst.score,
    bestScore: bestEval.score,
    baselineOverall: idFirst.overall,
    bestOverall: bestEval.overall,
    terms: { identity: idFirst.terms, best: bestEval.terms },
    ungraded: idFirst.ungraded,
  };
}

// ── Entry ───────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`\n  ${(e as Error).message}\n\n`);
    printUsage();
    return 2;
  }

  const jobs =
    args.motion === 'all' ? JOBS : JOBS.filter((j) => j.id === args.motion);
  if (!jobs.length) {
    process.stderr.write(
      `\n  unknown --motion "${args.motion}". Known: ${JOBS.map((j) => j.id).join(', ')}, all\n\n`,
    );
    return 2;
  }

  const rig = await loadRig();
  const outcomes: JobOutcome[] = [];
  for (const job of jobs) outcomes.push(await runJob(rig, job, args));

  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(
      args.json,
      JSON.stringify({ args, outcomes }, (_k, v) => (v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v), 2),
    );
    process.stdout.write(`   report written to ${args.json}\n\n`);
  }

  const broken = outcomes.filter((o) => !o.ok);
  if (broken.length) {
    process.stdout.write(
      `━━ ${broken.length}/${outcomes.length} job(s) failed an honesty check: ${broken.map((o) => o.job).join(', ')}\n\n`,
    );
    return 1;
  }
  const rec = outcomes.filter((o) => o.recommend);
  process.stdout.write(
    `━━ ${outcomes.length} job(s) clean · ${rec.length} recommendation(s)${rec.length ? `: ${rec.map((o) => o.job).join(', ')}` : ''}\n\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`\n  tune failed: ${(e as Error).stack ?? e}\n\n`);
    process.exit(3);
  },
);
