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
import { buildLieDown, buildGetUp } from './movementTemplates';
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
