/**
 * DIRECT POLICY SEARCH over movement-shaping parameters.
 *
 * WHAT THIS IS, precisely. A (1+1) evolution strategy with Rechenberg's 1/5th
 * success rule: propose a Gaussian perturbation of the current parameter vector,
 * keep it if it scores better, and adapt the step size from the recent acceptance
 * rate. Evolution strategies are a policy-search method in the reinforcement-
 * learning family (Salimans et al. 2017, "Evolution Strategies as a Scalable
 * Alternative to Reinforcement Learning") and they are the RIGHT member of that
 * family here, because this problem has:
 *   • no dynamics to control — the engine is kinematic, there is no state
 *     transition function and therefore no policy over actions to learn;
 *   • no differentiable path from a parameter to the score — the score comes out
 *     of a rig sampler, so gradients are unavailable;
 *   • an expensive but cheap-ENOUGH evaluation (~90-480 ms) and a low-dimensional
 *     vector, which is exactly the regime where (1+1)-ES beats both gradient
 *     methods and full CMA-ES.
 *
 * Value-function or policy-gradient RL would need an episode structure and a
 * transition model that do not exist in a kinematic engine. Building one would
 * mean inventing a physics layer first.
 *
 * DETERMINISTIC BY CONSTRUCTION. The engine forbids Math.random (it would break
 * resume and byte-identity), so this carries its own seeded PRNG. Same seed and
 * same objective ⇒ same trajectory, every run. That is not a nicety: a tuning
 * result nobody can reproduce is not evidence about a clinical product.
 *
 * The search never sees the engine. It is a pure function of
 * `(vector) => Promise<number>`, so the caller owns rig setup, sampling and
 * scoring — which keeps this module testable against synthetic objectives and
 * keeps the expensive part swappable.
 */

/** One tunable coordinate: a name, its bounds, and where it starts. */
export interface Parameter {
  name: string;
  min: number;
  max: number;
  /** The shipped value. The search MUST be able to return here exactly. */
  identity: number;
}

export type Vector = Record<string, number>;

export interface SearchOptions {
  /** Evaluations to spend. Wall-clock is this × the objective's cost. */
  budget: number;
  /** PRNG seed — same seed, same search. */
  seed?: number;
  /** Initial step as a fraction of each parameter's range. */
  initialStep?: number;
  /** Stop early once the best reward has improved by less than this for
   *  `patience` consecutive evaluations AND the step size has already collapsed
   *  (see the stopping rule in {@link searchParameters}). */
  minImprovement?: number;
  patience?: number;
  /** Relative step below which the search is considered to have localized. */
  convergedStep?: number;
  /** Called after every evaluation, for progress reporting. */
  onStep?: (s: SearchStep) => void;
}

export interface SearchStep {
  evaluation: number;
  candidate: Vector;
  reward: number;
  accepted: boolean;
  bestReward: number;
  step: number;
}

export interface SearchResult {
  best: Vector;
  bestReward: number;
  /** The identity vector's reward, so the gain is always attributable. */
  baselineReward: number;
  evaluations: number;
  accepted: number;
  history: SearchStep[];
  /** Why the search stopped — budget, or convergence. */
  stoppedBy: 'budget' | 'converged';
}

/** Mulberry32 — small, fast, and good enough for search perturbations. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so perturbations are Gaussian rather than uniform — a uniform
 *  proposal in N dimensions concentrates on the corners of the box. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** The shipped values as a vector — the point the search starts from and must be
 *  able to return to exactly. */
export function identityVector(params: readonly Parameter[]): Vector {
  const v: Vector = {};
  for (const p of params) v[p.name] = p.identity;
  return v;
}

/**
 * Run the search. `evaluate` returns the reward to MAXIMIZE; a rejected candidate
 * (one the caller deems invalid) should return `-Infinity` rather than throwing,
 * so the search treats it as a bad step instead of aborting.
 *
 * The identity vector is always evaluated first, so `baselineReward` is measured
 * rather than assumed and any reported gain is attributable to the search.
 */
export async function searchParameters(
  params: readonly Parameter[],
  evaluate: (v: Vector) => Promise<number>,
  opts: SearchOptions,
): Promise<SearchResult> {
  const rng = makeRng(opts.seed ?? 1);
  const patience = opts.patience ?? 40;
  const convergedStep = opts.convergedStep ?? 0.01;
  const minImprovement = opts.minImprovement ?? 1e-4;
  let step = opts.initialStep ?? 0.15;

  let best = identityVector(params);
  let bestReward = await evaluate(best);
  const baselineReward = bestReward;

  const history: SearchStep[] = [];
  let accepted = 0;
  let sinceImprovement = 0;
  let recentAccepts = 0;
  let sinceAdapt = 0;
  let stoppedBy: 'budget' | 'converged' = 'budget';

  for (let i = 1; i < opts.budget; i += 1) {
    const candidate: Vector = {};
    for (const p of params) {
      const sigma = step * (p.max - p.min);
      candidate[p.name] = clamp(best[p.name]! + gaussian(rng) * sigma, p.min, p.max);
    }
    const reward = await evaluate(candidate);
    const better = reward > bestReward;
    if (better) {
      const gain = reward - bestReward;
      best = candidate;
      bestReward = reward;
      accepted += 1;
      recentAccepts += 1;
      sinceImprovement = gain > minImprovement ? 0 : sinceImprovement + 1;
    } else {
      sinceImprovement += 1;
    }
    const s: SearchStep = { evaluation: i, candidate, reward, accepted: better, bestReward, step };
    history.push(s);
    opts.onStep?.(s);

    // RECHENBERG'S 1/5th RULE: accepting more than a fifth of proposals means the
    // step is too timid to be exploring; accepting fewer means it is overshooting.
    sinceAdapt += 1;
    if (sinceAdapt >= 10) {
      step = recentAccepts / sinceAdapt > 0.2 ? Math.min(step * 1.5, 0.5) : Math.max(step * 0.75, 1e-4);
      recentAccepts = 0;
      sinceAdapt = 0;
    }

    // STOPPING RULE — both conditions, not either. Near an optimum a (1+1)-ES
    // rejects MOST proposals; that is the 1/5th rule doing its job, not
    // convergence. Stopping on rejections alone quit at a third of the way to the
    // target in testing, and quit after 13 evaluations when a hard constraint made
    // most proposals invalid. Only a search that has BOTH stopped improving and
    // shrunk its step has actually localized.
    if (sinceImprovement >= patience && step <= convergedStep) {
      stoppedBy = 'converged';
      break;
    }
  }

  return {
    best,
    bestReward,
    baselineReward,
    evaluations: history.length + 1,
    accepted,
    history,
    stoppedBy,
  };
}
