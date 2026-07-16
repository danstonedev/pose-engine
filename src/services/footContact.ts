/**
 * FOOT CONTACT / IK PLANT (simMOVE Phase 3) — closed-chain ground contact for
 * travel, so a stance foot stays put while the body moves over it.
 *
 * WHY. `pinRootToFloor` (rootMotion) is a VERTICAL closed-chain trick: it drops
 * the whole model so the lowest foot sits on the floor. It cannot keep a foot
 * horizontally FIXED while the pelvis travels — so a "planted" foot slides along
 * the ground as the root translates (the moonwalk). Real stance is the opposite:
 * the foot is pinned in the world and the hip/knee flex/extend to carry the
 * pelvis over and past it. This module solves that with the engine's own CCD IK
 * ({@link solveIKChain}) on the leg chain (foot → knee → hip), the knee kept a
 * hinge and every joint ROM-clamped — so an unreachable target settles on a
 * clinically honest best-effort pose instead of dislocating.
 *
 * Pure THREE on a live skeleton — no Svelte/DOM. The sampler
 * ({@link sampleComposedMotion}) applies plants per frame when a motion declares
 * `contacts`; {@link measureContactSlide} scores how well a foot stayed put.
 */
import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { JointAngleRestReference } from './jointAngles';
import {
  buildBoneByPoseKey,
  buildIKChainContext,
  solveIKChain,
  type IKChainContext,
} from './poseRig';

/** A prepared leg IK chain that pins one foot to a world target. */
export interface FootPlantSolver {
  /** The IK chain foot(effector) → knee → hip. */
  ctx: IKChainContext;
  /** Canonical foot key (effector), e.g. 'L_Foot'. */
  footKey: string;
  /** Canonical knee key kept as a hinge during the solve, e.g. 'L_Leg'. */
  kneeKey: string;
}

/** Parents of the foot up to the hip: Foot → Leg(knee) → UpLeg(hip). */
const LEG_CHAIN_PARENTS = 2;

/** The knee key for a foot key ('L_Foot' → 'L_Leg', 'R_Foot' → 'R_Leg'). */
export function kneeKeyForFoot(footKey: string): string {
  return footKey.replace(/Foot$/, 'Leg');
}

/**
 * Build a leg IK chain that will pin `footKey` to a world target. Returns null
 * when the foot bone isn't present in the variant, or the chain can't be built.
 */
export function buildFootPlant(
  skinnedMesh: THREE.SkinnedMesh,
  footKey: string,
  variantCfg: BodyVariantConfig,
): FootPlantSolver | null {
  const foot = buildBoneByPoseKey(skinnedMesh.skeleton, variantCfg).get(footKey);
  if (!foot) return null;
  const ctx = buildIKChainContext(skinnedMesh, foot, LEG_CHAIN_PARENTS, variantCfg);
  if (!ctx) return null;
  return { ctx, footKey, kneeKey: kneeKeyForFoot(footKey) };
}

/**
 * Solve the leg so its foot returns to `targetWorldPos` — the knee constrained
 * to a hinge and every joint ROM-clamped (best-effort when unreachable). Mutates
 * the leg's local quaternions and refreshes their world matrices. Call AFTER the
 * frame's FK pose + root transform are applied.
 */
export function solveFootPlant(
  solver: FootPlantSolver,
  targetWorldPos: THREE.Vector3,
  rest: JointAngleRestReference | null | undefined,
): void {
  solveIKChain(solver.ctx, targetWorldPos, { rest, hinges: new Set([solver.kneeKey]) });
}

// ── slide measurement ────────────────────────────────────────────────────────

/** Structural view of a recording the slide validator needs (decoupled from
 *  motionRecording, same convention as the other Phase-2/3 validators). */
export interface ContactSlideSource {
  frames: { tMs: number; worldTracks?: Record<string, [number, number, number]> }[];
}

export interface ContactSlideResult {
  /** Max HORIZONTAL (XZ) deviation of the bone from its window-start position, m —
   *  how far the "planted" foot drifted along the ground. */
  horizontalM: number;
  /** Max vertical (Y) deviation, m — a plant may still lift/lower slightly. */
  verticalM: number;
  /** Number of frames considered in the window. */
  frames: number;
}

const _a = new THREE.Vector2();
const _b = new THREE.Vector2();

/**
 * Measure how far a tracked bone drifted from its position at the START of the
 * window [fromMs, toMs] — the foot-SLIDE metric. A well-planted stance foot
 * keeps `horizontalM` ≈ 0 while the body travels; a rigidly-translated (un-IK'd)
 * foot drifts by the full travel distance. `verticalM` is reported separately
 * because a best-effort plant may lift the foot slightly as the leg extends —
 * check it too when "stays grounded" matters, don't just trust `horizontalM`.
 * The window baseline is its FIRST frame, so pass a window that starts at the
 * plant instant (default full-clip does); a window beginning mid-slide measures
 * drift from that mid-point, not from the plant origin. Pure.
 */
export function measureContactSlide(
  rec: ContactSlideSource,
  boneKey: string,
  fromMs = -Infinity,
  toMs = Infinity,
): ContactSlideResult {
  const pts: [number, number, number][] = [];
  for (const f of rec.frames) {
    if (f.tMs < fromMs - 1e-6 || f.tMs > toMs + 1e-6) continue;
    const p = f.worldTracks?.[boneKey];
    if (p) pts.push(p);
  }
  if (pts.length < 2) return { horizontalM: 0, verticalM: 0, frames: pts.length };
  const base = pts[0]!;
  _a.set(base[0], base[2]);
  let horizontalM = 0;
  let verticalM = 0;
  for (const p of pts) {
    horizontalM = Math.max(horizontalM, _b.set(p[0], p[2]).distanceTo(_a));
    verticalM = Math.max(verticalM, Math.abs(p[1] - base[1]));
  }
  return { horizontalM, verticalM, frames: pts.length };
}
