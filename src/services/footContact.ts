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
 * ({@link solveIKChain}) on the leg chain (foot → knee → hip; a forefoot/toe
 * contact adds the ankle: toes → ankle → knee → hip), the knee kept a hinge and
 * every joint ROM-clamped — so an unreachable target settles on a clinically
 * honest best-effort pose instead of dislocating.
 *
 * Pure THREE on a live skeleton — no Svelte/DOM. The offline sampler
 * ({@link sampleComposedMotion}) and the live stage step every declared contact
 * through the ONE per-frame function {@link stepContactPlants} (lockstep);
 * {@link measureContactSlide} scores how well a foot stayed put.
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

/** A prepared limb IK chain that pins one contact effector to a world target. */
export interface FootPlantSolver {
  /** The IK chain effector → … → limb root (e.g. foot → knee → hip). */
  ctx: IKChainContext;
  /** Canonical effector key, e.g. 'L_Foot' or 'L_Toes'. */
  footKey: string;
  /** Canonical key of the chain's HINGE joint (the knee — the elbow for a hand
   *  contact), e.g. 'L_Leg'. Always a joint the solve actually rotates. */
  kneeKey: string;
}

/** Parents of the foot up to the hip: Foot → Leg(knee) → UpLeg(hip). */
const LEG_CHAIN_PARENTS = 2;

/** Parents of the toes up to the hip: Toes → Foot(ankle) → Leg(knee) → UpLeg(hip).
 *  A toe contact (the forefoot pivot of a heel rise / push-off) is a LEG contact
 *  like any other. It used to reuse the foot's two parents, which stopped the
 *  chain at the knee: the hip never helped, and the hinge lookup (a 'Foot'
 *  suffix rewrite) named the toe itself — a bone CCD never rotates — so the knee
 *  was solved as a free ball joint. Every weight shift over the held forefoot
 *  then came out of the knee's frontal plane: 4.6° (left) / 5.0° (right — its
 *  ±5° ROM limit) of varus/valgus through each toe pivot of the DDx walk, 4.8°
 *  on the engine walk with toe pivots, against 0.0° with the foot flat — and
 *  where the ±5° ran out the forefoot let go (1.1 cm of slide). */
const TOE_CHAIN_PARENTS = 3;

/** Parents of the hand up to the shoulder: Hand → Forearm(elbow) → UpperArm. */
const ARM_CHAIN_PARENTS = 2;

/**
 * CCD passes for a stance-foot plant solve (the shared default is 4).
 *
 * The plant target is FIXED for the whole stance window while the FK pose and the
 * root travel keep moving the foot away from it, so each frame's solve starts
 * further from its target the faster the body is moving — and CCD's residual
 * grows with that starting distance. At the walk's old ~75 steps/min the 4-pass
 * budget held the in-window drift near 2.6–3.0 cm; at the normative ~105
 * steps/min the same budget left 4.5 cm, breaking the < 4 cm slide gate. Eight
 * passes hold it at ~2.5–3.5 cm across the whole pace range — tighter than the
 * slow walk ever was (rig-measured, gaitContactSync.test.ts).
 *
 * Scoped to the plant so pose editing and exam-command IK keep the historic
 * 4-pass result byte-for-byte.
 */
export const FOOT_PLANT_IK_ITERATIONS = 8;

/** The knee key for a leg contact key ('L_Foot' / 'L_Toes' → 'L_Leg'). */
export function kneeKeyForFoot(footKey: string): string {
  return footKey.replace(/(Foot|Toes)$/, 'Leg');
}

/** How a contact effector's chain climbs to its limb root, and which joint in
 *  it is the hinge — the knee for the foot and the toes, the elbow for a hand.
 *  Any other key keeps the historic foot-shaped chain. */
function contactChainFor(effectorKey: string): { parents: number; hingeKey: string } {
  if (/Toes$/.test(effectorKey)) {
    return { parents: TOE_CHAIN_PARENTS, hingeKey: kneeKeyForFoot(effectorKey) };
  }
  if (/Hand$/.test(effectorKey)) {
    return { parents: ARM_CHAIN_PARENTS, hingeKey: elbowKeyForHand(effectorKey) };
  }
  return { parents: LEG_CHAIN_PARENTS, hingeKey: kneeKeyForFoot(effectorKey) };
}

/**
 * Build the limb IK chain that will pin a contact effector (`footKey`: 'L_Foot',
 * 'L_Toes', or 'L_Hand' for a declared hand contact) to a world target. Returns
 * null when the effector bone isn't present in the variant, or the chain can't
 * be built.
 */
export function buildFootPlant(
  skinnedMesh: THREE.SkinnedMesh,
  footKey: string,
  variantCfg: BodyVariantConfig,
): FootPlantSolver | null {
  const foot = buildBoneByPoseKey(skinnedMesh.skeleton, variantCfg).get(footKey);
  if (!foot) return null;
  const { parents, hingeKey } = contactChainFor(footKey);
  const ctx = buildIKChainContext(skinnedMesh, foot, parents, variantCfg);
  if (!ctx) return null;
  return { ctx, footKey, kneeKey: hingeKey };
}

/**
 * Solve the limb so its effector returns to `targetWorldPos` — the knee (elbow)
 * constrained to a hinge and every joint ROM-clamped (best-effort when
 * unreachable). Mutates the chain's local quaternions and refreshes their world
 * matrices. Call AFTER the frame's FK pose + root transform are applied.
 *
 * `rest` frames the ROM clamps: the hip/knee clamp strategies decompose bone
 * WORLD quaternions against it, so for a body walking a ROTATED heading the
 * caller must pass the heading-rotated reference (rotateRestReferenceByRoot) —
 * the un-rotated one would read the whole-body yaw as spurious hip
 * abduction/rotation and mangle the solve. When it does, `hingeAxisRest` must
 * carry the ORIGINAL (un-rotated) reference: the knee's hinge axis is a LOCAL
 * axis picked by quantizing the rest-world quat against world +X, which only
 * names the anatomical ML axis in the un-rotated frame. Both default to the
 * legacy behaviour when omitted/equal.
 */
export function solveFootPlant(
  solver: FootPlantSolver,
  targetWorldPos: THREE.Vector3,
  rest: JointAngleRestReference | null | undefined,
  hingeAxisRest?: JointAngleRestReference | null,
): void {
  solveIKChain(solver.ctx, targetWorldPos, {
    rest,
    hinges: new Set([solver.kneeKey]),
    iterations: FOOT_PLANT_IK_ITERATIONS,
    ...(hingeAxisRest ? { hingeAxisRest } : {}),
  });
}

// ── Plant release (SEAM-3) ───────────────────────────────────────────────────

/** How long (ms, trajectory time) a plant takes to let go AFTER its window
 *  ends. Dropping the pin between two frames snapped the released foot to its
 *  FK position (~20 cm + ~17°/frame at every toe-off, worse when paced);
 *  releasing it over this span keeps it continuous. The release does NOT extend
 *  the hold — the effector starts leaving its held point on the first released
 *  frame, so it may move throughout, just never discontinuously.
 *
 *  120 ms, boxed in from both sides (the DDx walk at its 30 Hz, the engine's
 *  walks and run at 60). The release starts from the hold's own joint speeds,
 *  so inside this span it has to turn the leg onto FK's: shorter makes that
 *  turn violent — at 80 ms the DDx walk's centre of mass drops at 1.05 g and
 *  its right knee turns 15.6° a frame (469°/s; normal gait peaks at 450); at
 *  100 the run's knee turns 30.8° a frame against its FK's 22.3 and the DDx
 *  walk's centre of mass drops at 0.96 g (25.3° and 0.90 g at 120). Longer
 *  keeps the released foot where it was held into its swing — at 150 ms the
 *  DDx toes clear the floor by 4.2–5.2 cm instead of 4.9–6.1 and the fast
 *  walk's released left foot comes down to its route late enough to pass above
 *  the landing right foot; at 200 they clear only 3.6–3.9 cm and slide 1.8 cm
 *  along it. Shared by the offline sampler and the live stage (lockstep). */
export const PLANT_RELEASE_BLEND_MS = 120;

/**
 * The release weight `msSinceRelease` ms after a plant window ends: 1 → 0 over
 * {@link PLANT_RELEASE_BLEND_MS} along a smoothstep, 1 − (3u² − 2u³). Its rate is
 * ZERO at both ends, so the release leaves the hold and joins the FK swing
 * without a velocity kink. The old linear ramp had a kink at both: as it ended,
 * the DDx walk's left ankle moved 10.6° in one frame (−10.6° → 0.1°) and then
 * not at all. 1 at or before the window's end (and for a non-finite input — a
 * caller treats that as "not releasing"), 0 once the release is over.
 */
export function plantReleaseWeight(msSinceRelease: number): number {
  const u = msSinceRelease / PLANT_RELEASE_BLEND_MS;
  if (!(u > 0)) return 1;
  if (u >= 1) return 0;
  return 1 - u * u * (3 - 2 * u);
}

/** One declared contact's plant, as the offline sampler and the live stage both
 *  hold it for the motion being played — the state {@link stepContactPlants}
 *  steps. Build one per declared contact; the step owns every field after. */
export interface ContactPlant {
  solver: FootPlantSolver;
  /** Contact window, trajectory ms; ±Infinity = the whole motion. */
  fromMs: number;
  toMs: number;
  /** World target, captured lazily as the effector ENTERS its window (post-FK,
   *  post-root); kept through the release, then reset so the NEXT window re-pins
   *  at its own point. */
  target: THREE.Vector3 | null;
  /** Return to this effector's FIRST captured point instead of where it lands. */
  reuseInitialAnchor: boolean;
  /** Per-window ROM-clamp rest frame (CURVED heading only); absent ⇒ the
   *  caller's shared frame ({@link ContactPlantFrame.rest}). */
  rest?: JointAngleRestReference;
}

/** The per-frame inputs {@link stepContactPlants} needs beyond the plants. */
export interface ContactPlantFrame {
  /** ROM-clamp rest frame for a plant without its own `rest` (heading-rotated
   *  for a rotated walk — see {@link solveFootPlant}). */
  rest: JointAngleRestReference | null | undefined;
  /** The ORIGINAL (un-rotated) rest reference — names the knee hinge axis. */
  hingeAxisRest: JointAngleRestReference | null | undefined;
  /** Root-Y offset of the heel-strike accent this frame (0 outside every
   *  accent): a target captured mid-accent pins at the NATURAL contact point and
   *  the transient dip is absorbed by the leg IK instead of burying the foot. */
  heelStrikeY: number;
  /** Extra height removed from a freshly captured target (0 when absent): a
   *  touchdown-planted gait (ComposedMotion.plantOnTouchdown) captures its
   *  foot in double support, where the calibrated vertical rounds the valley
   *  up by as much as GAIT_VERTICAL_MAX_RISE_M — this frame's lift — so the
   *  target would otherwise pin that far above the floor. */
  captureLiftY?: number;
  /** First captured target per effector, for `reuseInitialAnchor` (per motion). */
  initialTargets: Map<string, THREE.Vector3>;
}

const inPlantWindow = (fp: ContactPlant, tMs: number): boolean =>
  tMs >= fp.fromMs - 1e-6 && tMs <= fp.toMs + 1e-6;

const _releasePre: THREE.Quaternion[] = [];
const _releaseSolved = new THREE.Quaternion();
const _releaseFk = new THREE.Vector3();
const _releaseTarget = new THREE.Vector3();

/**
 * One frame of a plant letting go, `w` (1 → 0, {@link plantReleaseWeight}) of
 * the way from its hold to FK. The limb is solved as it was held, toward a
 * target that leaves the held point, and that solve is blended with the FK pose
 * by `w` (per chain bone, local slerp).
 *
 * C1 LEAVING THE HOLD: while `w` leaves 1 with zero rate the target is still the
 * held point, so the first released frames ARE the hold (the same solve from the
 * same FK pose): every joint carries on at the hold's speed, exactly and at any
 * frame rate. Fading the correction the last held frame applied instead dropped
 * that speed for FK's (the toe-pivot walk's right ankle at 120 Hz: +1.1°/frame
 * where the hold goes on at −6.6; −6.15 here) and sent the toes off at FK's
 * 3 m/s; carrying that correction's last per-frame change on (a Hermite)
 * extrapolates FK too — at DDx's 30 Hz from a frame in which the route's toes
 * were still flying back 4.6 cm a frame, which skidded the released toes 3.4 cm
 * forward along the floor. The price of starting from the hold: its motion
 * carries on before the release turns it (that toe hold ends turning the ankle
 * 5.9°/frame, and it plantarflexes on from −11.6° to −26.5° before FK's −6.7°
 * takes it back).
 *
 * C1 JOINING FK: `w` reaches 0 with zero rate as the target reaches the
 * effector's FK position, so the solve has nothing left to add (the last
 * release frame moves within 0.03°/frame of FK's speed).
 *
 * LIFT, THEN LET GO: the target's height eases to FK's on the release's own
 * smoothstep (1 − w), its horizontal position only on the square of it, so the
 * toes rise with the swing before they travel. Until they have lifted 1 cm the
 * toe-pivot walk's right toes move 3.5 / 2.9 / 2.1 mm at speed 1 / 0.85 / 1.2
 * (horizontal on 1 − w too: 6.4 / 5.4 / 4.2; the linear ramp: 7.2 / 10.1 / 4.8
 * back; the faded correction: 24.6 / 39.7 / 30.1 forward). The horizontal must
 * still reach FK's: left at the held point, the solve keeps reaching back to it
 * and the DDx walk's last release frame drops the left ankle 7.8° into FK.
 */
function releaseContactPlant(
  solver: FootPlantSolver,
  held: THREE.Vector3,
  w: number,
  rest: JointAngleRestReference | null | undefined,
  hingeAxisRest: JointAngleRestReference | null | undefined,
): void {
  const bones = solver.ctx.bones;
  while (_releasePre.length < bones.length) _releasePre.push(new THREE.Quaternion());
  for (let i = 0; i < bones.length; i += 1) _releasePre[i]!.copy(bones[i]!.quaternion);
  // Where the route (FK, plus any release already applied to this limb this
  // frame) puts the effector now: the release target's destination.
  bones[0]!.getWorldPosition(_releaseFk);
  const s = 1 - w;
  const sh = s * s;
  _releaseTarget.set(
    held.x + (_releaseFk.x - held.x) * sh,
    held.y + (_releaseFk.y - held.y) * s,
    held.z + (_releaseFk.z - held.z) * sh,
  );
  solveFootPlant(solver, _releaseTarget, rest, hingeAxisRest);
  for (let i = 0; i < bones.length; i += 1) {
    _releaseSolved.copy(bones[i]!.quaternion);
    bones[i]!.quaternion.copy(_releasePre[i]!).slerp(_releaseSolved, w);
  }
  // The root-most chain link's world refresh cascades to the whole limb.
  bones[bones.length - 1]!.updateMatrixWorld(true);
}

/**
 * Pin every declared contact at time `tMs` — call AFTER the frame's FK pose and
 * root transform. The ONE per-frame plant step the offline sampler and the live
 * stage both run, so a recording is frame-for-frame what the stage shows.
 *
 * In its window a contact's chain is solved fully to the target captured as the
 * effector entered it. For {@link PLANT_RELEASE_BLEND_MS} after the window it
 * lets go through {@link releaseContactPlant}. Neither keeps anything from one
 * frame to the next but the captured target: a frame's pose is a function of
 * that frame's FK pose, the target and `tMs` alone, so no frame rate, repeated
 * call (the stage's settle and parked paths) or skipped frame can change it.
 *
 * Releases run before holds, so a contact in its window always has the last word
 * on its limb — a forefoot hold is not undone by the same leg's ankle contact
 * still letting go, whatever order the two were declared in. A release is
 * skipped once a later window re-pins the same effector (its hold owns the limb).
 * Returns true when any plant moved the skeleton this frame.
 */
export function stepContactPlants(
  plants: readonly ContactPlant[],
  tMs: number,
  frame: ContactPlantFrame,
): boolean {
  let moved = false;
  for (const fp of plants) {
    if (inPlantWindow(fp, tMs)) continue;
    const w = fp.target ? plantReleaseWeight(tMs - fp.toMs) : 0;
    const repinned =
      w > 0 &&
      w < 1 &&
      plants.some((o) => o !== fp && o.solver.footKey === fp.solver.footKey && inPlantWindow(o, tMs));
    if (!fp.target || w <= 0 || w >= 1 || repinned) {
      fp.target = null; // released (or superseded) — the next window re-captures
      continue;
    }
    releaseContactPlant(fp.solver, fp.target, w, fp.rest ?? frame.rest, frame.hingeAxisRest);
    moved = true;
  }
  for (const fp of plants) {
    if (!inPlantWindow(fp, tMs)) continue;
    if (!fp.target) {
      const first = fp.reuseInitialAnchor ? frame.initialTargets.get(fp.solver.footKey) : undefined;
      fp.target = first?.clone() ?? fp.solver.ctx.bones[0]!.getWorldPosition(new THREE.Vector3());
      if (!first) fp.target.y -= frame.heelStrikeY + (frame.captureLiftY ?? 0);
      if (!frame.initialTargets.has(fp.solver.footKey)) {
        frame.initialTargets.set(fp.solver.footKey, fp.target.clone());
      }
    }
    solveFootPlant(fp.solver, fp.target, fp.rest ?? frame.rest, frame.hingeAxisRest);
    moved = true;
  }
  return moved;
}

// ── Hand plant (Phase 3 Tier B) — the arm analog of the foot plant ───────────
// Quadruped / plank / push-up rest on the HANDS. As the body lowers (elbows bend)
// the hand must stay pinned to the floor, exactly as a stance foot stays put while
// the pelvis travels — so the same CCD IK, on the arm chain hand → elbow → shoulder,
// the elbow kept a hinge and every joint ROM-clamped. The hand is already declared
// an ik-effector (chainParentCount 2), so this is a direct mirror of the foot plant.

/** The elbow key for a hand key ('L_Hand' → 'L_Forearm'). */
export function elbowKeyForHand(handKey: string): string {
  return handKey.replace(/Hand$/, 'Forearm');
}

/** Build an arm IK chain that will pin `handKey` to a world target. Returns null
 *  when the hand bone isn't present or the chain can't be built. */
export function buildHandPlant(
  skinnedMesh: THREE.SkinnedMesh,
  handKey: string,
  variantCfg: BodyVariantConfig,
): FootPlantSolver | null {
  const hand = buildBoneByPoseKey(skinnedMesh.skeleton, variantCfg).get(handKey);
  if (!hand) return null;
  const ctx = buildIKChainContext(skinnedMesh, hand, ARM_CHAIN_PARENTS, variantCfg);
  if (!ctx) return null;
  return { ctx, footKey: handKey, kneeKey: elbowKeyForHand(handKey) };
}

/** Solve the arm so its hand returns to `targetWorldPos` — elbow hinge, ROM-clamped
 *  (best-effort when unreachable). Call AFTER the frame's FK + root are applied. */
export function solveHandPlant(
  solver: FootPlantSolver,
  targetWorldPos: THREE.Vector3,
  rest: JointAngleRestReference | null | undefined,
): void {
  solveIKChain(solver.ctx, targetWorldPos, { rest, hinges: new Set([solver.kneeKey]) });
}

/** Latch state for a floor reach — null `target` = still descending, non-null =
 *  planted (frozen) point. Reset `target` to null when the reach contact releases. */
export interface HandReachState {
  target: THREE.Vector3 | null;
}

/** How close (m) the hand must get to the floor plane before it LATCHES to a fixed
 *  planted point. Until then it tracks the floor directly below the (descending)
 *  hand; capturing only ON CONTACT avoids freezing a bad point mid-transition (when
 *  the grounding posture is already active but the body hasn't reached the plank). */
const HAND_LATCH_M = 0.03;

/** CCD passes per frame for a planted hand — a stance hand must hold firm against a
 *  body that moves fast (the chest lowers ~0.3 m in a rep), so it needs more than the
 *  single pass a slow-moving stance foot gets. */
const HAND_REACH_PASSES = 4;

/** Residual (m) past which a LATCHED hand self-heals: if the pinned hand cannot
 *  actually reach its frozen target — e.g. the point was captured mid-transition and
 *  is now out of the arm's reach — the latch is dropped so the hand re-tracks the floor
 *  below it. A genuinely planted hand (a push-up, where the arm just folds to hold the
 *  contact) stays well within this, so it never re-tracks. */
const HAND_RELATCH_M = 0.08;

const _reachLive = new THREE.Vector3();
const _reachTarget = new THREE.Vector3();
const _reachSolved = new THREE.Quaternion();

/** The full (weight-1) reach solve — see {@link solveHandReach}. */
function solveHandReachFull(
  solver: FootPlantSolver,
  state: HandReachState,
  floorY: number,
  rest: JointAngleRestReference | null | undefined,
): void {
  const eff = solver.ctx.bones[0]!;
  if (state.target) {
    // A few CCD passes so the pinned hand holds against the (fast-moving) body as
    // the chest lowers — one pass under-converges and lets the hand punch through
    // the floor at the bottom of a rep.
    for (let i = 0; i < HAND_REACH_PASSES; i += 1) solveHandPlant(solver, state.target, rest);
    // Self-heal a bad latch: a point captured mid-transition can end up out of reach
    // once the body settles elsewhere. If the hand can't hold its target, drop the
    // latch and fall through to re-track the floor below where the hand actually is.
    eff.getWorldPosition(_reachLive);
    if (_reachLive.distanceTo(state.target) <= HAND_RELATCH_M) return;
    state.target = null;
  }
  eff.getWorldPosition(_reachLive);
  _reachTarget.set(_reachLive.x, floorY, _reachLive.z);
  for (let i = 0; i < HAND_REACH_PASSES; i += 1) solveHandPlant(solver, _reachTarget, rest);
  eff.getWorldPosition(_reachLive); // where it ended (best-effort)
  if (_reachLive.y <= floorY + HAND_LATCH_M) {
    state.target = new THREE.Vector3(_reachLive.x, floorY, _reachLive.z);
  }
}

/**
 * FLOOR REACH with latch-on-contact — the hand analog of a stance plant for a
 * secondary (non-height-setting) contact. While the hand is still above the floor
 * (the body descending into a plank), it is pulled straight DOWN toward the floor
 * plane below its live position; the instant it reaches the floor it FREEZES that
 * point, so from then on it stays planted while the body lowers over it and the arm
 * folds — which is exactly the push-up. Mutates `state.target`; call each frame the
 * hand is a reach contact, and reset `state.target = null` when it releases.
 *
 * `weight` (0..1, default 1) is the SEAM-4 engagement ramp: at 1 the solve is the
 * legacy full-correction path, byte-identical; below 1 the solved chain is blended
 * back toward the pre-solve FK arm (per-bone local slerp), so a newly-engaged
 * reach folds in over the caller's ramp instead of snapping the arm to the floor
 * on its first frame. Latch/self-heal decisions read the FULL solve (where the
 * hand CAN reach), so the latched point is weight-independent.
 */
export function solveHandReach(
  solver: FootPlantSolver,
  state: HandReachState,
  floorY: number,
  rest: JointAngleRestReference | null | undefined,
  weight = 1,
): void {
  const w = Math.min(1, Math.max(0, weight));
  if (w >= 1) {
    solveHandReachFull(solver, state, floorY, rest);
    return;
  }
  if (w <= 0) return; // not engaged yet — pure FK arm this frame
  const bones = solver.ctx.bones;
  const pre = bones.map((b) => b.quaternion.clone());
  solveHandReachFull(solver, state, floorY, rest);
  for (let i = 0; i < bones.length; i += 1) {
    const b = bones[i]!;
    _reachSolved.copy(b.quaternion);
    b.quaternion.copy(pre[i]!).slerp(_reachSolved, w);
  }
  // Refresh the chain's world matrices from the top-most solved bone down.
  bones[bones.length - 1]!.updateWorldMatrix(true, true);
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
