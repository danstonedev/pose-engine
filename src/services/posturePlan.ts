/**
 * POSTURE TRANSITION GRAPH — the spine of "natural transitions between movements".
 * Movements declare the body posture they START and END in (default 'standing');
 * when a new command's start posture differs from where the body currently is, the
 * executor plays the ordered transition motions this planner returns, so the model
 * physically gets into position (lie down / stand up) instead of teleporting.
 *
 * Phase 2 wires the standing ↔ supine edges (lying on the back). Prone / side-lying
 * rolls and the Phase-3 sitting / quadruped / plank nodes extend the same graph.
 */
import {
  buildLieDown,
  buildGetUp,
  buildSitDown,
  buildStandFromSit,
  buildGetDownToPlank,
  buildStandFromPlank,
  buildGetDownToQuadruped,
  buildStandFromQuadruped,
  buildKneelDown,
  buildStandFromKneel,
  buildPlankFromQuadruped,
  buildQuadrupedFromPlank,
  buildRollSupineToLeft,
  buildRollLeftToSupine,
  buildRollSupineToRight,
  buildRollRightToSupine,
  buildRollLeftToProne,
  buildRollProneToLeft,
  buildRollRightToProne,
  buildRollProneToRight,
} from './movementTemplates';
import type { ComposedMotion, PostureNode } from './motionSequence';

export interface PostureEdge {
  from: PostureNode;
  to: PostureNode;
  /** The authored transition motion (startFrom:'current') that carries the body
   *  from `from` to `to` without a teleport. */
  build: () => ComposedMotion;
}

/** Directed graph of authored posture transitions. */
export const POSTURE_EDGES: PostureEdge[] = [
  { from: 'standing', to: 'supine', build: buildLieDown },
  { from: 'supine', to: 'standing', build: buildGetUp },
  { from: 'standing', to: 'sitting', build: buildSitDown },
  { from: 'sitting', to: 'standing', build: buildStandFromSit },
  { from: 'standing', to: 'plank', build: buildGetDownToPlank },
  { from: 'plank', to: 'standing', build: buildStandFromPlank },
  { from: 'standing', to: 'quadruped', build: buildGetDownToQuadruped },
  { from: 'quadruped', to: 'standing', build: buildStandFromQuadruped },
  { from: 'standing', to: 'kneeling', build: buildKneelDown },
  { from: 'kneeling', to: 'standing', build: buildStandFromKneel },
  { from: 'quadruped', to: 'plank', build: buildPlankFromQuadruped },
  { from: 'plank', to: 'quadruped', build: buildQuadrupedFromPlank },
  // LOG-ROLLS — the lying cluster (all head −Z, roll-consistent). Prone is reached by
  // ROLLING from supine through a side (a real "roll over"), not by a faceplant; this is
  // the single canonical prone orientation. "lie face down" = lie down → roll over.
  { from: 'supine', to: 'sidelying-left', build: buildRollSupineToLeft },
  { from: 'sidelying-left', to: 'supine', build: buildRollLeftToSupine },
  { from: 'supine', to: 'sidelying-right', build: buildRollSupineToRight },
  { from: 'sidelying-right', to: 'supine', build: buildRollRightToSupine },
  { from: 'sidelying-left', to: 'prone', build: buildRollLeftToProne },
  { from: 'prone', to: 'sidelying-left', build: buildRollProneToLeft },
  { from: 'sidelying-right', to: 'prone', build: buildRollRightToProne },
  { from: 'prone', to: 'sidelying-right', build: buildRollProneToRight },
];

/**
 * Shortest ordered list of transition motions to get from `from` to `to` (BFS over
 * {@link POSTURE_EDGES}). Returns `[]` when already there (no bridge needed) and
 * `null` when the target posture is unreachable (the caller declines / falls back).
 */
export function planPosturePath(from: PostureNode, to: PostureNode): ComposedMotion[] | null {
  if (from === to) return [];
  const queue: PostureNode[] = [from];
  const prev = new Map<PostureNode, PostureEdge>();
  const seen = new Set<PostureNode>([from]);
  while (queue.length) {
    const node = queue.shift()!;
    for (const edge of POSTURE_EDGES) {
      if (edge.from !== node || seen.has(edge.to)) continue;
      seen.add(edge.to);
      prev.set(edge.to, edge);
      if (edge.to === to) {
        const edges: PostureEdge[] = [];
        let cur: PostureNode = to;
        while (cur !== from) {
          const e = prev.get(cur)!;
          edges.unshift(e);
          cur = e.from;
        }
        return edges.map((e) => e.build());
      }
      queue.push(edge.to);
    }
  }
  return null;
}

/** The posture a movement STARTS in (default 'standing'). */
export function movementStartPosture(m: { startPosture?: PostureNode }): PostureNode {
  return m.startPosture ?? 'standing';
}

/** The posture a movement ENDS in — defaults to its start posture (posture-preserving),
 *  which itself defaults to 'standing'. */
export function movementEndPosture(m: { endPosture?: PostureNode; startPosture?: PostureNode }): PostureNode {
  return m.endPosture ?? m.startPosture ?? 'standing';
}
