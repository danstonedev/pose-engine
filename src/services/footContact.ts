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

/** The BASE time (ms, trajectory time) a plant takes to let go after its
 *  window ends — the shortest release; {@link plantReleaseLengthMs} stretches
 *  it where FK's own motion calls for more. Dropping the pin between two frames
 *  snapped the released foot to its FK position (~20 cm + ~17°/frame at every
 *  toe-off, worse when paced); releasing it over a span keeps it continuous.
 *  The release does NOT extend the hold — the effector starts leaving its held
 *  point on the first released frame, so it may move throughout, just never
 *  discontinuously.
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
 * `lengthMs` (default {@link PLANT_RELEASE_BLEND_MS}) along a smoothstep,
 * 1 − (3u² − 2u³). Its rate is ZERO at both ends, so the release leaves the
 * hold and joins the FK swing without a velocity kink. The old linear ramp had
 * a kink at both: as it ended, the DDx walk's left ankle moved 10.6° in one
 * frame (−10.6° → 0.1°) and then not at all. 1 at or before the window's end
 * (and for a non-finite input — a caller treats that as "not releasing"), 0
 * once the release is over.
 */
export function plantReleaseWeight(msSinceRelease: number, lengthMs = PLANT_RELEASE_BLEND_MS): number {
  const u = msSinceRelease / lengthMs;
  if (!(u > 0)) return 1;
  if (u >= 1) return 0;
  return 1 - u * u * (3 - 2 * u);
}

// ── Forefoot settle ──────────────────────────────────────────────────────────

/** A forefoot (`X_Toes`) hold that opens with its point up to this far (m)
 *  above the floor, and its heel no higher than this above its own floor
 *  height, brings that point down onto the floor ({@link ContactPlant.settle}).
 *  A heel rise pivots on a forefoot on the floor, but the route need not put it
 *  there when the hold opens: with the ankle hold keeping the heel down, DDx's
 *  two-cycle walk has the forefoot 0.2-1.5 cm up at its planned heel rises
 *  (1.3-1.5 cm on the right, that hip stopped at 0°; 1.4-1.8 cm on the
 *  engine's two-cycle walk with the same hip, forefootHoldFloor.test), and the
 *  hold kept it floating there to its end. The 2 cm is the travel's hover band
 *  (rootMotion FOOT_HOVER_M: the other foot of a double support may hover a
 *  centimetre or two up).
 *
 *  A hold that opens with the heel higher is on a foot already in the air (the
 *  toe-pivot walk's braking-step hold in toeContact.test, heel 7.1-9.6 cm and
 *  forefoot 2.0-3.6 cm up as the braking step swings that leg through), and is
 *  held where it is, as an ankle hold opened in the air is: pulled to the floor
 *  there, the forefoot dips 6.8 mm under it as the swing drags the leg on.
 *
 *  A point taken UNDER the floor is held there too. The one-shot calibrated
 *  vertical pushed it under (1.2-1.7 cm below the floor pin as that walk's
 *  right heel rises), as it sinks every stance contact of a single-cycle clip
 *  (the stock walk's stance ankle 2.2 cm), and lifting that forefoot alone
 *  moves the release that follows. */
const FOREFOOT_HOVER_M = 0.02;

/** How long (ms) a forefoot hold takes to settle its point onto the floor: the
 *  base span a plant takes to let go ({@link PLANT_RELEASE_BLEND_MS}), on the
 *  same smoothstep, so the forefoot leaves where the hold found it and meets
 *  the floor at rest. Measured on the DDx walk (30 Hz), whose right forefoot
 *  settles 1.3-1.5 cm: dropped in one frame, its ankle changes speed by
 *  8.1°/frame and lies 3.9° off its smooth path at the drop; over 40 ms, 7.4°
 *  and 3.5°; from 80 to 160 ms the settle is no longer the ankle's worst frame
 *  (5.9° and 1.9°, elsewhere); over 240 ms it outlasts the 237 ms hold and
 *  lets go 1 mm up. */
export const FOREFOOT_SETTLE_MS = PLANT_RELEASE_BLEND_MS;

/** The share of a forefoot's height above the floor still held
 *  `msSinceCapture` ms after the hold took it: 1 → 0 over
 *  {@link FOREFOOT_SETTLE_MS} along a smoothstep. */
function forefootSettleWeight(msSinceCapture: number): number {
  const u = msSinceCapture / FOREFOOT_SETTLE_MS;
  if (!(u > 0)) return 1;
  if (u >= 1) return 0;
  return 1 - u * u * (3 - 2 * u);
}

// ── The release, read from FK's own motion ───────────────────────────────────
// A release starts from the hold's joint speeds, so it lags FK and must move
// faster than FK somewhere to catch up — unless FK slows down while it does.
// The base 120 ms release caught up while FK was still at speed: the default
// run's knee turned 25.4°/frame against its FK's own peak of 22.3 (+14%; +30%
// at 30 Hz), and a foot released after a slow weight shift (the single-leg-
// stance replica) crossed its 9 cm gap to FK in 120 ms, 25 mm/frame against
// FK's ~6. How long a release lasts is therefore read off FK itself, from the
// motion's trajectory — long enough for FK's burst to have passed, and for the
// gap to close no faster than FK moves the limb.
//
// It is read ONCE, on the first frame after the window (readPlantRelease), and
// kept for that window: re-read on every frame, the gap to FK grew as FK moved
// away and the length with it, so the release stalled, ran backwards and then
// lurched (the single-leg stance with a 4 cm shift: 474 → 800 ms mid-release,
// the weight rising again by 0.03, the foot's step jumping 1.4 → 3.7 mm/frame
// in four 120 Hz frames).

/** The FK a release reads its length from: the pose trajectory the frame was
 *  posed from — each joint's LOCAL quaternion by canonical key, at any time
 *  (the motion trajectory the sampler and the stage both play fits). */
export interface ContactPlantTrajectory {
  readonly totalMs: number;
  sampleAt(tMs: number): { pose: { bones: Readonly<Record<string, readonly number[]>> } };
}

/** What {@link planPlantRelease} reads off FK around a window's end. */
export interface PlantReleasePlan {
  /** The release length FK's burst asks for (ms, ≥ {@link PLANT_RELEASE_BLEND_MS}). */
  burstMs: number;
  /** FK's peak effector speed relative to the limb root's parent, world
   *  metres per ms, from one base release before the window's end to two after. */
  effectorSpeed: number;
  /** Each chain joint's FK speed (°/ms, joint i + 1 of the chain) over each
   *  {@link RELEASE_PLAN_STEP_MS} step from one base release before the
   *  window's end to `horizonMs` + one base release after it. */
  jointSpeeds: number[][];
  /** FK's effector in the chain root's PARENT frame (parent-local units) every
   *  step from the window's end to `horizonMs` after it. */
  path: THREE.Vector3[];
  /** How far past the window's end (ms) the read reaches. */
  horizonMs: number;
}

/** Step (ms) of the FK read. */
const RELEASE_PLAN_STEP_MS = 5;
/** A chain joint FK moves slower than this (°/ms) across the read takes no
 *  part in the burst or the slack: a still joint's own peak is noise. */
const RELEASE_STILL_JOINT_DEG_PER_MS = 0.02;
/** A burst counts only if it has halved within this long (ms) of the window's
 *  end; a leg still swinging hard past it (a walk's swing) gains nothing from
 *  a longer release — its FK never slows enough to catch up in. */
const RELEASE_BURST_HALF_MAX_MS = 90;
/** The release is stretched to this many times the burst's half-life, so its
 *  catch-up — the smoothstep's fastest stretch, a half to three quarters in —
 *  falls after the burst, where FK has slack: the run's heel kick halves 55–60
 *  ms after toe-off, and over 156–181 ms its knee peaks at 0.79–0.92 of FK's
 *  own (1.14–1.18 at 120 ms). */
const RELEASE_BURST_STRETCH = 2.7;
/** Peak rate of the release target's horizontal law, s² over a smoothstep s
 *  (at 68% of the way): a gap G closed over L ms moves the target at up to
 *  1.98·G/L. */
const RELEASE_GAP_RATE = 1.98;
/** Where (share of the release) that peak falls: the gap the catch-up closes
 *  is FK's offset from the held point there, not at the window's end — FK
 *  moves on while the release runs. Read at the window's end alone, the single-
 *  leg stance with a 4 cm shift (a 5.7 cm gap then, twice that by the catch-
 *  up) was released over 583 ms and turned its knee 1.10× FK's peak; read at
 *  the catch-up, 780 ms and 0.97×. */
const RELEASE_GAP_AT = 0.68;
/** The gap read is capped (m, smoothly over ±2 cm): past it the lag is the
 *  route's own — a hold kept far beyond where the route lifts the foot (the
 *  toe walk's braking step holds its toes 36 cm behind FK's) — and a release
 *  proportional to it would last seconds. */
const RELEASE_GAP_CAP_M = 0.15;
const RELEASE_GAP_CAP_SOFT_M = 0.02;
/** FK effector speed (m/ms) under which the gap rule stands down, fading in
 *  over the next as much again (0.05–0.1 m/s): past a still FK there is no FK
 *  speed to keep within, and the base release lifts the limb to it. */
const RELEASE_STILL_EFFECTOR_M_PER_MS = 0.00005;
/** A gap stretches the release only as far as FK leaves room to catch up in:
 *  over the middle half of the stretched release (where a smoothstep does its
 *  catching up) no moving joint of the limb may run faster than this share
 *  below its own peak over the release — else the stretch is cut back, to the
 *  burst's length if need be. A limb FK still speeds up past the window only
 *  lets its lag grow before the catch-up: the 0.6× walk's braking step, its
 *  hip already at its plateau, was stretched 123 → 289 ms and turned the hip
 *  1.40× FK's peak (1.15 at 123 ms). The single-leg stance's lift, FK
 *  accelerating slowly from rest, keeps 18–22% of its peak in hand at any
 *  length. */
const RELEASE_SLACK_MIN = 0.18;
/** Width (ms) of the join from the burst's length to the gap's, and of the
 *  smooth cap on the latter. */
const RELEASE_SMOOTH_MAX_MS = 20;
/** No release lasts longer (ms). */
const RELEASE_MAX_MS = 800;
/** The held point is interpolated to the window's end between the last held
 *  frame and the first released one when they are at most this far (ms)
 *  apart (any frame of a playing motion); farther apart (a parked stage's
 *  settle-to-settle jump) it is read on the released frame itself. */
const RELEASE_HELD_MAX_GAP_MS = 100;

const RAD_TO_DEG = 180 / Math.PI;
const _planScale = new THREE.Vector3();

/** The chain effector's FK position in the chain root's PARENT frame for one
 *  sample of local joint rotations (`quats[i - 1]` for chain bone i ≥ 1). */
function chainEffectorInParent(
  chain: readonly THREE.Bone[],
  quats: readonly THREE.Quaternion[],
  out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(chain[0]!.position);
  for (let i = 1; i < chain.length; i += 1) out.applyQuaternion(quats[i - 1]!).add(chain[i]!.position);
  return out;
}

/**
 * Read FK around the end of a contact window (`toMs`) off the motion's
 * trajectory, `horizonMs` past it: how long a release must last for the limb's
 * FK burst to have passed, how fast FK moves the effector relative to the limb
 * root, each chain joint's FK speed and the effector's FK path. A pure
 * function of the trajectory and the chain, so the sampler and the stage read
 * the same plan. A chain joint the trajectory does not pose keeps the base
 * length and an empty read.
 */
export function planPlantRelease(
  solver: FootPlantSolver,
  toMs: number,
  trajectory: ContactPlantTrajectory,
  horizonMs = 2 * PLANT_RELEASE_BLEND_MS,
): PlantReleasePlan {
  const base = PLANT_RELEASE_BLEND_MS;
  const plan: PlantReleasePlan = { burstMs: base, effectorSpeed: 0, jointSpeeds: [], path: [], horizonMs };
  const chain = solver.ctx.bones;
  const keys = solver.ctx.canonicalKeys;
  const step = RELEASE_PLAN_STEP_MS;
  const first = -Math.round(base / step);
  const last = Math.round((Math.max(horizonMs, 2 * base) + base) / step);
  const samples: THREE.Quaternion[][] = [];
  for (let k = first; k <= last; k += 1) {
    const t = Math.min(trajectory.totalMs, Math.max(0, toMs + k * step));
    const bones = trajectory.sampleAt(t).pose.bones;
    const row: THREE.Quaternion[] = [];
    for (let i = 1; i < chain.length; i += 1) {
      const key = keys[i];
      const q = key ? bones[key] : undefined;
      if (!q) return plan;
      row.push(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
    }
    samples.push(row);
  }
  const atEnd = -first; // the sample at toMs
  // The burst and FK's effector speed are read over one base release before
  // the window's end to two after it, whatever the horizon.
  const baseLast = atEnd + Math.round((2 * base) / step);
  const moving: { peak: number; speed: number[] }[] = [];
  for (let j = 0; j < chain.length - 1; j += 1) {
    const speed: number[] = [];
    let peak = 0;
    for (let k = 0; k + 1 < samples.length; k += 1) {
      const v = (samples[k]![j]!.angleTo(samples[k + 1]![j]!) * RAD_TO_DEG) / step;
      speed.push(v);
      if (k < baseLast) peak = Math.max(peak, v);
    }
    plan.jointSpeeds.push(speed);
    if (peak > RELEASE_STILL_JOINT_DEG_PER_MS) moving.push({ peak, speed });
  }
  if (moving.length) {
    // The limb's burst: at each step the fastest joint relative to its own peak.
    const burst = (k: number) => Math.max(...moving.map((m) => m.speed[k]! / m.peak));
    let top = 0;
    let topAt = atEnd;
    for (let k = atEnd; k < baseLast && (k - atEnd) * step <= base; k += 1) {
      const b = burst(k);
      if (b > top) {
        top = b;
        topAt = k;
      }
    }
    for (let k = topAt; k < baseLast; k += 1) {
      if (burst(k) >= 0.5 * top) continue;
      const halfMs = (k - atEnd) * step;
      if (halfMs <= RELEASE_BURST_HALF_MAX_MS) plan.burstMs = Math.max(base, RELEASE_BURST_STRETCH * halfMs);
      break;
    }
  }
  const parent = chain[chain.length - 1]!.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    _planScale.setFromMatrixScale(parent.matrixWorld);
    const scale = Math.max(_planScale.x, _planScale.y, _planScale.z);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    chainEffectorInParent(chain, samples[0]!, a);
    for (let k = 1; k < samples.length; k += 1) {
      chainEffectorInParent(chain, samples[k]!, b);
      if (k <= baseLast) plan.effectorSpeed = Math.max(plan.effectorSpeed, (a.distanceTo(b) * scale) / step);
      if (k - 1 >= atEnd && (k - 1 - atEnd) * step <= horizonMs) plan.path.push(a.clone());
      a.copy(b);
    }
  }
  return plan;
}

const smooth01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** min(x, cap), rounded over ±`soft` so its slope stays continuous. */
function softMin(x: number, cap: number, soft: number): number {
  if (x <= cap - soft) return x;
  if (x >= cap + soft) return cap;
  return x - (x - cap + soft) ** 2 / (4 * soft);
}

/** max(burst, L), joined over the first `soft` ms past the burst by a cubic
 *  with the burst's value and zero slope at one end and L's at the other — so
 *  the length is continuous, with a continuous slope, from the burst up (a
 *  rounded max sat 5 ms above the burst where the stretch set in). */
function joinStretch(burst: number, L: number, soft: number): number {
  const x = L - burst;
  if (!(x > 0)) return burst;
  if (x >= soft) return L;
  return burst + (2 * x * x) / soft - (x * x * x) / (soft * soft);
}

/**
 * The length (ms) the gap asks for: the release target's own travel kept within
 * FK's peak effector speed v (1.98·G/L ≤ v), for the gap `gapAt` reports at
 * {@link RELEASE_GAP_AT} of a candidate length — FK's offset from the held
 * point where the catch-up runs fastest (a number: a fixed gap) — capped at
 * {@link RELEASE_GAP_CAP_M} and at {@link RELEASE_MAX_MS}. A fixed point, from
 * the gap at the window's end up (FK moving away only lengthens it). 0 for a
 * still FK.
 */
export function plantReleaseGapMs(
  plan: Pick<PlantReleasePlan, 'effectorSpeed'>,
  gapAt: number | ((lengthMs: number) => number),
): number {
  const v = plan.effectorSpeed;
  if (!(v > RELEASE_STILL_EFFECTOR_M_PER_MS)) return 0;
  const gapOf = typeof gapAt === 'number' ? () => gapAt : gapAt;
  const lengthFor = (gapM: number) =>
    softMin(
      (RELEASE_GAP_RATE * softMin(Math.max(0, gapM), RELEASE_GAP_CAP_M, RELEASE_GAP_CAP_SOFT_M)) / v,
      RELEASE_MAX_MS,
      RELEASE_SMOOTH_MAX_MS,
    ) * smooth01(v / RELEASE_STILL_EFFECTOR_M_PER_MS - 1);
  let gapMs = lengthFor(gapOf(0));
  for (let i = 0; i < 6; i += 1) gapMs = Math.max(gapMs, lengthFor(gapOf(RELEASE_GAP_AT * gapMs)));
  return gapMs;
}

/**
 * How long (ms) a release lasts: the burst's length, or the gap's
 * ({@link plantReleaseGapMs}) where that is longer — joined with no step
 * — but the gap's only as far as FK's joints leave room to catch up in
 * ({@link RELEASE_SLACK_MIN}) and the plan's read reaches.
 */
export function plantReleaseLengthMs(
  plan: PlantReleasePlan,
  gapAt: number | ((lengthMs: number) => number),
): number {
  const burst = plan.burstMs;
  const step = RELEASE_PLAN_STEP_MS;
  const base = PLANT_RELEASE_BLEND_MS;
  const atEnd = Math.round(base / step);
  const slack = (L: number): number => {
    let worst = 1;
    for (const speed of plan.jointSpeeds) {
      const to = Math.min(speed.length - 1, atEnd + Math.round((L + base) / step));
      let peak = 0;
      for (let k = 0; k <= to; k += 1) peak = Math.max(peak, speed[k]!);
      if (!(peak > RELEASE_STILL_JOINT_DEG_PER_MS)) continue;
      let mid = 0;
      const from = atEnd + Math.round((0.25 * L) / step);
      for (let k = from; k <= Math.min(to, atEnd + Math.round((0.75 * L) / step)); k += 1) mid = Math.max(mid, speed[k]!);
      worst = Math.min(worst, 1 - mid / peak);
    }
    return worst;
  };
  let L = Math.min(plantReleaseGapMs(plan, gapAt), Math.max(burst, plan.horizonMs));
  while (L > burst && slack(L) < RELEASE_SLACK_MIN) L -= 10;
  return joinStretch(burst, L, RELEASE_SMOOTH_MAX_MS);
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
  /** A forefoot hold taken above the floor ({@link FOREFOOT_HOVER_M}): the
   *  target sits on the floor, and the held point eases down to it from where
   *  the forefoot was drawn when the hold took it — `offsetY` above the target,
   *  at `atMs` (trajectory ms) — over {@link FOREFOOT_SETTLE_MS}. Null for every
   *  other hold, and once released. Kept by the step. */
  settle?: { offsetY: number; atMs: number } | null;
  /** Per-window ROM-clamp rest frame (CURVED heading only); absent ⇒ the
   *  caller's shared frame ({@link ContactPlantFrame.rest}). */
  rest?: JointAngleRestReference;
  /** The target in the chain root's PARENT frame on the last frame the window
   *  held it, and when — what the release reads the held point at the window's
   *  end from. Kept by the step. */
  heldInParent?: { tMs: number; point: THREE.Vector3 } | null;
  /** The release read for the window that last ended ({@link PlantRelease}).
   *  Kept by the step. */
  release?: PlantRelease | null;
}

/** How a plant lets go after its window — read once, on the first frame after
 *  it ({@link stepContactPlants}), and kept until the release is over. */
export interface PlantRelease {
  /** The window end it was read for (trajectory ms). */
  toMs: number;
  /** How long the release lasts (ms). */
  lengthMs: number;
  /** The share of the release by which the drawn effector is lifted a
   *  {@link PLANT_RELEASE_FLOOR_BAND_M} off the held point (predicted from FK's
   *  lift); null when FK does not lift it that far within the release. */
  liftAt: number | null;
  /** How strongly the release keeps the drawn effector off the floor-drag
   *  (0..1, {@link RELEASE_PIN_M}). */
  pin: number;
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
  /** Each contact bone's world height with the body standing
   *  (FloorReference.restY) — where a forefoot (`X_Toes`) sits on the floor, so
   *  a forefoot hold taken above it settles onto it ({@link FOREFOOT_HOVER_M}).
   *  Absent ⇒ every hold is held where it was captured. */
  restY?: Readonly<Record<string, number>>;
  /** The trajectory this frame was posed from — the FK every release is read
   *  off ({@link planPlantRelease}). Absent ⇒ every release takes the base
   *  {@link PLANT_RELEASE_BLEND_MS} and nothing else: what a touchdown-planted
   *  gait's travel assumes of its plants. */
  trajectory?: ContactPlantTrajectory | null;
}

const inPlantWindow = (fp: ContactPlant, tMs: number): boolean =>
  tMs >= fp.fromMs - 1e-6 && tMs <= fp.toMs + 1e-6;

const _heel = new THREE.Vector3();

/** The settle a forefoot hold taken now starts ({@link ContactPlant.settle}),
 *  or null: `targetY` is where the hold would otherwise keep the forefoot,
 *  `drawnY` where it is drawn this frame; the chain's next bone is the ankle,
 *  whose height says whether the heel is down. */
function forefootSettle(
  solver: FootPlantSolver,
  targetY: number,
  drawnY: number,
  tMs: number,
  restY: Readonly<Record<string, number>> | undefined,
): { floorY: number; settle: { offsetY: number; atMs: number } } | null {
  const key = solver.footKey;
  if (!/Toes$/.test(key)) return null;
  const floorY = restY?.[key];
  const heelFloorY = restY?.[key.replace(/Toes$/, 'Foot')];
  const ankle = solver.ctx.bones[1];
  if (floorY == null || heelFloorY == null || !ankle) return null;
  const up = targetY - floorY;
  if (!(up > 0) || up > FOREFOOT_HOVER_M) return null;
  if (ankle.getWorldPosition(_heel).y - heelFloorY > FOREFOOT_HOVER_M) return null;
  return { floorY, settle: { offsetY: drawnY - floorY, atMs: tMs } };
}

const _held = new THREE.Vector3();

/** The point a plant holds at `tMs`: its captured target, or a settling
 *  forefoot's way down to it. */
function heldPoint(fp: ContactPlant, tMs: number): THREE.Vector3 {
  if (!fp.settle) return fp.target!;
  const up = fp.settle.offsetY * forefootSettleWeight(tMs - fp.settle.atMs);
  return _held.copy(fp.target!).setY(fp.target!.y + up);
}

/** Each plant's release plan, for the trajectory, window and horizon it was
 *  read for. */
const _releasePlans = new WeakMap<
  ContactPlant,
  { trajectory: ContactPlantTrajectory; toMs: number; plan: PlantReleasePlan }
>();

function releasePlanOf(fp: ContactPlant, trajectory: ContactPlantTrajectory, horizonMs: number): PlantReleasePlan {
  const hit = _releasePlans.get(fp);
  if (hit && hit.trajectory === trajectory && hit.toMs === fp.toMs && hit.plan.horizonMs >= horizonMs) return hit.plan;
  const plan = planPlantRelease(fp.solver, fp.toMs, trajectory, horizonMs);
  _releasePlans.set(fp, { trajectory, toMs: fp.toMs, plan });
  return plan;
}

/** How far (m) the drawn effector must lift off the held point before the
 *  release stops keeping it off the floor-drag ({@link PlantRelease.liftAt}). */
export const PLANT_RELEASE_FLOOR_BAND_M = 0.01;

/** How far (m, smoothly saturating) the release holds the drawn effector back
 *  from the floor-drag of its blend with FK (see {@link releaseContactPlant}):
 *  enough for DDx's toe-offs, dragged 3–11 mm back on their first released
 *  30 Hz frame, and the DDx-like toe-off (12 mm at 60 Hz). */
const RELEASE_PIN_M = 0.025;
/** The share of the release over which that hold lets go once the effector is
 *  lifted: a smoothstep, so it lets go with no kink. */
const RELEASE_PIN_FADE = 0.25;
/** The hold stands down where FK lifts the effector only late in the release
 *  (from 0.4 of it, gone by 0.6): held that long it builds a lag the rest of
 *  the release has to catch up. The single-leg stance's foot, lifted by FK at
 *  0.5–0.6 of its 780 ms, turned the hip 1.09× FK's peak held, 0.96× free; the
 *  held lift at 100 ms of a 600 ms raise 1.19× against 0.94. */
const RELEASE_PIN_LATE_FROM = 0.4;
const RELEASE_PIN_LATE_TO = 0.6;

const _relHeld = new THREE.Vector3();
const _relQuat = new THREE.Quaternion();
const _relOffset = new THREE.Vector3();

/**
 * Read how plant `fp` lets go after its window, on the first frame after it
 * (`tMs`): the release's length ({@link plantReleaseLengthMs}, from FK's own
 * motion and the gap from the held point to FK's effector) and when FK lifts
 * the effector off the floor. The held point is taken in the limb root's
 * PARENT frame at the window's end — interpolated between the last held frame
 * and this one — so the read depends on neither which frames ran nor how the
 * body has moved since; FK's effector comes off the trajectory at any time.
 * The release ends by the motion's end (its last pose is FK's) and by the time
 * another contact of the same leg, holding when it starts, lets go — no two
 * releases act on one leg (the 0.6× toe walk's foot release, stretched to 256
 * ms, outlived the toes' window by 8 ms and ran beside their release).
 */
function readPlantRelease(
  fp: ContactPlant,
  plants: readonly ContactPlant[],
  tMs: number,
  frame: ContactPlantFrame,
): PlantRelease {
  const base = PLANT_RELEASE_BLEND_MS;
  const out: PlantRelease = { toMs: fp.toMs, lengthMs: base, liftAt: null, pin: 0 };
  const chain = fp.solver.ctx.bones;
  const parent = chain[chain.length - 1]!.parent;
  const trajectory = frame.trajectory;
  if (trajectory && parent && fp.target) {
    parent.updateWorldMatrix(true, false);
    _planScale.setFromMatrixScale(parent.matrixWorld);
    const scale = Math.max(_planScale.x, _planScale.y, _planScale.z);
    parent.getWorldQuaternion(_relQuat);
    const held = parent.worldToLocal(_relHeld.copy(heldPoint(fp, tMs)));
    const last = fp.heldInParent;
    if (last && last.tMs <= fp.toMs + 1e-6 && tMs > last.tMs && tMs - last.tMs <= RELEASE_HELD_MAX_GAP_MS) {
      held.lerpVectors(last.point, held.clone(), (fp.toMs - last.tMs) / (tMs - last.tMs));
    }
    const heldAtEnd = held.clone();
    let plan = releasePlanOf(fp, trajectory, 2 * base);
    // FK's effector relative to the held point `ms` after the window, in world
    // axes and metres (FK past the read: its last point).
    const offsetAt = (p: PlantReleasePlan, ms: number): THREE.Vector3 =>
      _relOffset
        .copy(p.path[Math.min(p.path.length - 1, Math.max(0, Math.round(ms / RELEASE_PLAN_STEP_MS)))] ?? heldAtEnd)
        .sub(heldAtEnd)
        .applyQuaternion(_relQuat)
        .multiplyScalar(scale);
    const gapAt = (ms: number) => offsetAt(plan, ms).length();
    if (plantReleaseGapMs(plan, gapAt) > plan.horizonMs) plan = releasePlanOf(fp, trajectory, RELEASE_MAX_MS);
    let lengthMs = Math.min(RELEASE_MAX_MS, plantReleaseLengthMs(plan, gapAt));
    lengthMs = Math.max(base, Math.min(lengthMs, trajectory.totalMs - fp.toMs));
    // When the drawn effector is a band up: the release target rises on the
    // smoothstep s, and the blend with FK lifts it as far again (first order),
    // so s(2 − s) of FK's height above the held point.
    for (let u = 0; u <= 1 + 1e-9; u += 0.005) {
      const s = smooth01(u);
      if (s * (2 - s) * offsetAt(plan, u * lengthMs).y >= PLANT_RELEASE_FLOOR_BAND_M) {
        out.liftAt = u;
        break;
      }
    }
    out.lengthMs = lengthMs;
    if (out.liftAt !== null) {
      out.pin = 1 - smooth01((out.liftAt - RELEASE_PIN_LATE_FROM) / (RELEASE_PIN_LATE_TO - RELEASE_PIN_LATE_FROM));
    }
  }
  for (const o of plants) {
    if (o === fp || o.solver.kneeKey !== fp.solver.kneeKey) continue;
    if (o.fromMs <= fp.toMs + 1e-6 && o.toMs > fp.toMs + 1e-6) out.lengthMs = Math.min(out.lengthMs, o.toMs - fp.toMs);
  }
  return out;
}

const _releasePre: THREE.Quaternion[] = [];
const _releaseSolved = new THREE.Quaternion();
const _releaseFk = new THREE.Vector3();
const _releaseTarget = new THREE.Vector3();
const _releaseAtSolve = new THREE.Vector3();
const _releaseDrawn = new THREE.Vector3();
const _pinRoot = new THREE.Vector3();
const _pinFrom = new THREE.Vector3();
const _pinTo = new THREE.Vector3();
const _pinSwing = new THREE.Quaternion();
const _pinWorld = new THREE.Quaternion();
const _pinIdentity = new THREE.Quaternion();

/**
 * One frame of a plant letting go, `w` (1 → 0, {@link plantReleaseWeight}) of
 * the way from its hold to FK, `u` of the way through `release`. The limb is
 * solved as it was held, toward a target that leaves the held point, and that
 * solve is blended with the FK pose (per chain bone, local slerp) by `w`.
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
 * toes rise with the swing before they travel. The horizontal must still reach
 * FK's: left at the held point, the solve keeps reaching back to it and the DDx
 * walk's last release frame drops the left ankle 7.8° into FK.
 *
 * OFF THE FLOOR-DRAG: the blend with FK is per joint, so it drags the drawn
 * effector off the solve's point toward FK's — and where FK has the toes well
 * behind and above the held point (DDx's walk at 30 Hz: 7–12 cm behind, 2.5–7
 * cm up) that dragged them 3.3–11.3 mm back along the floor on the first
 * released frame, while the target itself had moved under 1 mm. The limb is
 * therefore swung about its root joint (the hip) — one small rotation, which
 * no joint limit can snap — to carry the effector back toward where the solve
 * put it, horizontally, by at most {@link RELEASE_PIN_M} (a smooth
 * saturation). It holds until the drawn effector has lifted a band
 * ({@link PlantRelease.liftAt}, read with the release) and lets go over the
 * next {@link RELEASE_PIN_FADE} of it — on the release's own clock, so how
 * fast the effector happens to rise cannot time it: timed by the target
 * crossing a height band instead, that hand-back came in one or two frames and
 * turned the curved walks' hips 5.2–7.5°/frame at 120 Hz against FK's 1.3.
 * It starts from nothing (the blend has not dragged yet) and ends with the
 * blend's own, so it is C1 at both ends. DDx's released toes now move
 * 0.2–1.9 mm on that frame.
 */
function releaseContactPlant(
  solver: FootPlantSolver,
  held: THREE.Vector3,
  w: number,
  u: number,
  release: PlantRelease,
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
  bones[0]!.getWorldPosition(_releaseAtSolve);
  for (let i = 0; i < bones.length; i += 1) {
    _releaseSolved.copy(bones[i]!.quaternion);
    bones[i]!.quaternion.copy(_releasePre[i]!).slerp(_releaseSolved, w);
  }
  // The root-most chain link's world refresh cascades to the whole limb.
  const root = bones[bones.length - 1]!;
  root.updateMatrixWorld(true);
  const f = release.liftAt === null ? 0 : release.pin * (1 - smooth01((u - release.liftAt) / RELEASE_PIN_FADE));
  if (!(f > 0)) return;
  bones[0]!.getWorldPosition(_releaseDrawn);
  const dx = _releaseAtSolve.x - _releaseDrawn.x;
  const dz = _releaseAtSolve.z - _releaseDrawn.z;
  const d = Math.hypot(dx, dz);
  if (!(d > 1e-7)) return;
  const k = (RELEASE_PIN_M * Math.tanh(d / RELEASE_PIN_M)) / d;
  root.getWorldPosition(_pinRoot);
  _pinFrom.copy(_releaseDrawn).sub(_pinRoot).normalize();
  _pinTo.set(_releaseDrawn.x + dx * k, _releaseDrawn.y, _releaseDrawn.z + dz * k).sub(_pinRoot).normalize();
  _pinSwing.setFromUnitVectors(_pinFrom, _pinTo).slerp(_pinIdentity, 1 - f);
  root.getWorldQuaternion(_pinWorld).premultiply(_pinSwing);
  if (root.parent) root.quaternion.copy(root.parent.getWorldQuaternion(_pinSwing).invert().multiply(_pinWorld));
  else root.quaternion.copy(_pinWorld);
  root.updateMatrixWorld(true);
}

/**
 * Pin every declared contact at time `tMs` — call AFTER the frame's FK pose and
 * root transform. The ONE per-frame plant step the offline sampler and the live
 * stage both run, so a recording is frame-for-frame what the stage shows.
 *
 * In its window a contact's chain is solved fully to the target captured as the
 * effector entered it — for a forefoot taken just above the floor, the floor
 * under it, reached over {@link FOREFOOT_SETTLE_MS} ({@link ContactPlant.settle}).
 * After the window it lets go through {@link releaseContactPlant}, read on the
 * first frame after the window ({@link readPlantRelease}; the base
 * {@link PLANT_RELEASE_BLEND_MS} without a trajectory). Nothing is kept from one
 * frame to the next but what the capture took, the held point in the limb
 * root's frame on the last held frame and the release read off them: a frame's
 * pose is a function of that frame's FK
 * pose, those and `tMs`, so no frame rate, repeated call (the stage's settle
 * and parked paths) or skipped frame after the release is read can change it
 * — and the release is read at the window's end, not at the frame that found
 * it.
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
    const since = tMs - fp.toMs;
    let w = 0;
    if (fp.target && since > 0) {
      if (!fp.release || fp.release.toMs !== fp.toMs) fp.release = readPlantRelease(fp, plants, tMs, frame);
      w = plantReleaseWeight(since, fp.release.lengthMs);
    }
    const repinned =
      w > 0 &&
      w < 1 &&
      plants.some((o) => o !== fp && o.solver.footKey === fp.solver.footKey && inPlantWindow(o, tMs));
    if (!fp.target || w <= 0 || w >= 1 || repinned) {
      fp.target = null; // released (or superseded) — the next window re-captures
      fp.settle = null;
      fp.release = null;
      fp.heldInParent = null;
      continue;
    }
    releaseContactPlant(
      fp.solver,
      heldPoint(fp, tMs),
      w,
      since / fp.release!.lengthMs,
      fp.release!,
      fp.rest ?? frame.rest,
      frame.hingeAxisRest,
    );
    moved = true;
  }
  for (const fp of plants) {
    if (!inPlantWindow(fp, tMs)) continue;
    if (!fp.target) {
      const key = fp.solver.footKey;
      const first = fp.reuseInitialAnchor ? frame.initialTargets.get(key) : undefined;
      const at = fp.solver.ctx.bones[0]!.getWorldPosition(new THREE.Vector3());
      fp.target = first?.clone() ?? at.clone();
      if (!first) fp.target.y -= frame.heelStrikeY + (frame.captureLiftY ?? 0);
      // A forefoot taken just above the floor with its heel down is held on
      // the floor under it, reached from where it is drawn now.
      const onFloor = forefootSettle(fp.solver, fp.target.y, at.y, tMs, frame.restY);
      fp.settle = onFloor?.settle ?? null;
      if (onFloor) fp.target.y = onFloor.floorY;
      if (!frame.initialTargets.has(key)) {
        frame.initialTargets.set(key, fp.target.clone());
      }
      fp.release = null;
    }
    const held = heldPoint(fp, tMs);
    solveFootPlant(fp.solver, held, fp.rest ?? frame.rest, frame.hingeAxisRest);
    const parent = fp.solver.ctx.bones[fp.solver.ctx.bones.length - 1]!.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      fp.heldInParent = { tMs, point: parent.worldToLocal(held.clone()) };
    }
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
 *  planted (frozen) point. Reset `target` and `lastTMs` to null when the reach
 *  contact releases. */
export interface HandReachState {
  target: THREE.Vector3 | null;
  /** The motion time of the last evaluation {@link settleHandReachLatches} settled
   *  this reach at; null before the first. Kept by the settle. */
  lastTMs?: number | null;
  /** Whether the reach was near a change of state then (see
   *  {@link HAND_LATCH_NEAR_M}). Kept by the settle. */
  lastNear?: boolean;
  /** The last {@link HAND_LATCH_GRID_MS} grid time the settle read this
   *  descending hand at: when, its pulled height above the floor and where it
   *  was. Kept by the settle. */
  lastGrid?: { tMs: number; height: number; point: THREE.Vector3 } | null;
}

/**
 * Poses the body at motion time `tMs` exactly as a frame at `tMs` is posed when
 * its reach contacts are solved — the trajectory's FK pose, the root and the
 * grounding pin — so {@link settleHandReachLatches} can read the reach on the
 * motion's own clock, between the frames that happened to run.
 */
export type HandReachProbe = (tMs: number) => void;

/** One reach contact for {@link settleHandReachLatches}: the hand's solver, its
 *  latch state, and when the reach last engaged (trajectory ms; 0 when it has
 *  been engaged since the motion's start). */
export interface HandReachContact {
  solver: FootPlantSolver;
  state: HandReachState;
  engagedAtMs: number;
}

/** How close (m) the hand must get to the floor plane before it may LATCH to a fixed
 *  planted point. Until then it tracks the floor directly below the (descending)
 *  hand; capturing only ON CONTACT avoids freezing a bad point mid-transition (when
 *  the grounding posture is already active but the body hasn't reached the plank).
 *  Settled on the motion's clock ({@link settleHandReachLatches}) a hand latches
 *  inside this band only where it touches ({@link HAND_TOUCH_M}) or stops
 *  descending; a frame-latched one (the legacy path) as soon as it is inside. */
const HAND_LATCH_M = 0.03;

/** How close (m) to the floor the pulled hand counts as touching it: the settle
 *  latches at the moment it gets there. Latched as it first came within
 *  {@link HAND_LATCH_M} instead, a hand still 3 cm up and travelling planted
 *  short of its landing (male rig): the plank from quadruped and the push-up
 *  2.3–2.4 cm behind where the route's own hand comes to rest (1.3–1.7 cm
 *  latched on the first 60 Hz frame inside the band; 0.2 cm at the touch;
 *  female 3.4 → 1.0 cm), the bird-dog's replanted hand 15 cm ahead of it (9 cm
 *  at the touch), and a hand held behind where the route drives it punched
 *  deeper through the floor — the push-up's entry 7.3 cm below it (6.2 on the
 *  frame, 3.9 at the touch). */
const HAND_TOUCH_M = 0.002;

/** How little (m) the pulled hand may still descend over one
 *  {@link HAND_LATCH_GRID_MS} step and count as having stopped: a hand that
 *  comes within {@link HAND_LATCH_M} but not {@link HAND_TOUCH_M} of the floor
 *  (best effort, or the body rises again before it touches) latches at its
 *  lowest grid point, from the grid time that shows it rose no lower. */
const HAND_DESCENT_STALL_M = 1e-5;

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

/** The motion-clock grid (ms) a self-heal falls on: a latched hand lets go at the
 *  first multiple of this at which it can no longer hold its point, whichever
 *  frames ran — not on the frame that happened to find it. */
const HAND_LATCH_GRID_MS = 5;

/** The moment a descending hand touched the floor is solved to this (m of
 *  pulled height, 0.01 mm) — in under 5 µs of motion time where the hand drops
 *  2 mm/ms, the hand then moving 0.01 mm — by regula falsi (Illinois) on the
 *  pulled height, in at most {@link HAND_LATCH_SOLVE_STEPS} probes. Bisected
 *  instead, with a probe ahead for the band's stall, the frame both hands
 *  latched on took 38–46 probes, 40–90 ms on a loaded machine (4–12 probes,
 *  11–17 ms, now). */
const HAND_LATCH_SOLVE_M = 1e-5;
const HAND_LATCH_SOLVE_STEPS = 12;

/** How near (m) its threshold a reach must come — a latched hand's residual
 *  within this of {@link HAND_RELATCH_M}, a descending hand's pulled height
 *  within this of the {@link HAND_LATCH_M} band — at either end of a frame gap for the
 *  settle to read the grid between: a change of state can fall wholly between
 *  two frames. The female chained plank from quadruped let its hands go for a
 *  residual that peaked at 8.1 cm for about 30 ms (7.97 cm at 301 ms, 7.95 at
 *  379: a 30 Hz clock saw it, a coarse one did not, and they settled 54 mm /
 *  16° apart). Farther from both thresholds a frame costs no probe. */
const HAND_LATCH_NEAR_M = 0.03;

/** A frame gap (ms) past which the settle reads the grid between whatever the
 *  two ends show — a parked stage's settle-to-settle jumps. */
const HAND_LATCH_WALK_GAP_MS = 100;

const _reachLive = new THREE.Vector3();
const _reachTarget = new THREE.Vector3();
const _reachSolved = new THREE.Quaternion();
const _reachPrePull: THREE.Quaternion[] = [];

/** Save (`save`) or restore the arm's local rotations around a trial solve. */
function keepArm(bones: readonly THREE.Bone[], save: boolean): void {
  while (_reachPrePull.length < bones.length) _reachPrePull.push(new THREE.Quaternion());
  for (let i = 0; i < bones.length; i += 1) {
    if (save) _reachPrePull[i]!.copy(bones[i]!.quaternion);
    else bones[i]!.quaternion.copy(_reachPrePull[i]!);
  }
  if (!save) bones[bones.length - 1]!.updateMatrixWorld(true);
}

/** Where the hand ends pulled toward the floor below it, and how high above the
 *  floor (`out.y` − floorY) — a trial solve; the arm is left as it was. */
function pulledHand(
  solver: FootPlantSolver,
  floorY: number,
  rest: JointAngleRestReference | null | undefined,
  out: THREE.Vector3,
): THREE.Vector3 {
  const bones = solver.ctx.bones;
  keepArm(bones, true);
  bones[0]!.getWorldPosition(_reachLive);
  _reachTarget.set(_reachLive.x, floorY, _reachLive.z);
  for (let i = 0; i < HAND_REACH_PASSES; i += 1) solveHandPlant(solver, _reachTarget, rest);
  bones[0]!.getWorldPosition(out);
  keepArm(bones, false);
  return out;
}

/** How far (m) the hand stays from its latched point when solved toward it — a
 *  trial solve; the arm is left as it was. */
function heldResidual(
  solver: FootPlantSolver,
  target: THREE.Vector3,
  rest: JointAngleRestReference | null | undefined,
): number {
  const bones = solver.ctx.bones;
  keepArm(bones, true);
  for (let i = 0; i < HAND_REACH_PASSES; i += 1) solveHandPlant(solver, target, rest);
  const d = bones[0]!.getWorldPosition(_reachLive).distanceTo(target);
  keepArm(bones, false);
  return d;
}

const _settlePulled = new THREE.Vector3();

/** Whether motion time `t` falls on the {@link HAND_LATCH_GRID_MS} grid. */
const onLatchGrid = (t: number): boolean =>
  Math.abs(t / HAND_LATCH_GRID_MS - Math.round(t / HAND_LATCH_GRID_MS)) < 1e-9;

/**
 * Settle every reach contact's latch at motion time `tMs`, on the motion's own
 * clock: call it on each frame, with the body posed for `tMs` (FK, root,
 * grounding pin — exactly what `probe(tMs)` poses), before solving the reaches
 * ({@link solveHandReach} with `settled`). It leaves the body posed for `tMs`.
 *
 * A reach changes state at two kinds of moment, and each is found where it
 * happened, not on the frame that found it:
 *  - LATCH: a descending hand latches where its pulled position touched the
 *    floor ({@link HAND_TOUCH_M}) — the moment is solved on the trajectory
 *    between the last evaluation above it (or the reach's engagement) and the
 *    first at it (regula falsi, {@link HAND_LATCH_SOLVE_M}), and the point is
 *    the pulled hand's then. A hand that comes within the {@link HAND_LATCH_M}
 *    band but never touches latches where it was at a grid time, from the
 *    next grid time that shows it descended no further;
 *  - SELF-HEAL: a latched hand that can no longer hold its point within
 *    {@link HAND_RELATCH_M} lets go at the first {@link HAND_LATCH_GRID_MS}
 *    grid time at which it cannot, and re-latches from there as a descending
 *    hand would (the relatch reads the FK arm, not the one the hold solved).
 * Between frames nothing is evaluated unless one of the two frames either side
 * shows the reach near a change of state ({@link HAND_LATCH_NEAR_M}) or they
 * are over {@link HAND_LATCH_WALK_GAP_MS} apart (so a playing motion pays for
 * probes only around its latches and self-heals); then every grid time between
 * is walked with `probe`. So the latch depends on neither the frame rate nor
 * the frame times (a live stage's, a parked stage's settle-to-settle jumps):
 * across the engine's hand-planted motions and chains, on both rigs, 30, 60 and
 * 120 Hz, a jittered 60 Hz display clock and a 40–95 ms one settle identically
 * (latched on the first frame inside the band they settled up to 18 mm / 2.3°
 * apart at 30 and 120 Hz, 59 mm / 6.0° in a chain) — save that a change of
 * state that comes and goes wholly
 * between two frames, both over {@link HAND_LATCH_NEAR_M} from its threshold
 * and under {@link HAND_LATCH_WALK_GAP_MS} apart, is seen only by a clock that
 * samples it.
 */
export function settleHandReachLatches(
  reaches: readonly HandReachContact[],
  tMs: number,
  floorY: number,
  rest: JointAngleRestReference | null | undefined,
  probe: HandReachProbe,
): void {
  // What this frame shows, on its own pose: whether each reach is near a change
  // of state (a latched hand near losing its point, a descending one near the
  // band) — then, or if it was on the last frame, the grid between is read.
  const pending: { r: HandReachContact; from: number; fresh: boolean }[] = [];
  const near = new Map<HandReachContact, boolean>();
  const changed = new Set<HandReachContact>();
  for (const r of reaches) {
    const st = r.state;
    if (st.lastTMs != null && tMs < st.lastTMs - 1e-6) {
      st.target = null; // the clock ran back (a replay): start the reach afresh
      st.lastTMs = null;
    }
    const fresh = st.lastTMs == null;
    if (fresh) st.lastGrid = null;
    const from = fresh ? Math.min(tMs, Math.max(0, r.engagedAtMs)) : st.lastTMs!;
    const nearNow = st.target
      ? heldResidual(r.solver, st.target, rest) > HAND_RELATCH_M - HAND_LATCH_NEAR_M
      : pulledHand(r.solver, floorY, rest, _settlePulled).y - floorY <= HAND_LATCH_M + HAND_LATCH_NEAR_M;
    near.set(r, nearNow);
    const walk = fresh ? from < tMs - 1e-6 || nearNow : nearNow || st.lastNear === true || tMs - from > HAND_LATCH_WALK_GAP_MS;
    if (walk) pending.push({ r, from, fresh });
  }
  /** Where the pulled hand touched the floor between `lo` (above it; `fLoRead`
   *  its height less the touch there, if the walk read it) and `hi` (touching,
   *  `fHi` likewise, `atHi` where it was). */
  const touchBetween = (
    solver: FootPlantSolver,
    lo: number,
    fLoRead: number | null,
    hi: number,
    fHi: number,
    atHi: THREE.Vector3,
  ): THREE.Vector3 => {
    const touchAt = (tt: number): number => {
      probe(tt);
      return pulledHand(solver, floorY, rest, _settlePulled).y - floorY - HAND_TOUCH_M;
    };
    let fLo = fLoRead ?? touchAt(lo);
    let fHiNow = fHi;
    let at = atHi;
    let moved = 0; // which end the last step moved: −1 lo, +1 hi (Illinois: an end kept twice has its height halved)
    for (let k = 0; k < HAND_LATCH_SOLVE_STEPS && fLo > 0 && fHiNow < fLo; k += 1) {
      const c = hi - (fHiNow * (hi - lo)) / (fHiNow - fLo);
      const fc = touchAt(c);
      if (Math.abs(fc) <= HAND_LATCH_SOLVE_M) return _settlePulled.clone();
      if (fc > 0) {
        lo = c;
        fLo = fc;
        if (moved === -1) fHiNow /= 2;
        moved = -1;
      } else {
        hi = c;
        fHiNow = fc;
        at = _settlePulled.clone();
        if (moved === 1) fLo /= 2;
        moved = 1;
      }
    }
    return at;
  };
  if (pending.length) {
    // Walk each pending reach from where it was last known: its engagement (a
    // fresh reach, evaluated there first) or its last evaluation; then every
    // grid time after that, and this frame.
    const first = Math.min(...pending.map((p) => p.from));
    const times: number[] = [];
    for (const p of pending) if (p.fresh) times.push(p.from);
    for (let g = (Math.floor(first / HAND_LATCH_GRID_MS) + 1) * HAND_LATCH_GRID_MS; g < tMs - 1e-6; g += HAND_LATCH_GRID_MS) {
      times.push(g);
    }
    times.push(tMs);
    const walkTimes = [...new Set(times)].sort((a, b) => a - b);
    // Each reach's last evaluation on the walk, and its pulled height there
    // (less the touch) where it was read — the touch solve's upper end.
    const prev = new Map<HandReachContact, number | null>();
    const prevF = new Map<HandReachContact, number>();
    for (const p of pending) prev.set(p.r, p.fresh ? null : p.from);
    for (const t of walkTimes) {
      probe(t);
      let reposed = false;
      for (const p of pending) {
        if (t < p.from - 1e-6 || (!p.fresh && t <= p.from + 1e-6)) continue;
        if (reposed) {
          probe(t);
          reposed = false;
        }
        const st = p.r.state;
        // A latched hand holds, or lets go here (a grid time or this frame; a
        // non-grid frame time lets go only as this frame's own state).
        if (st.target) {
          if (heldResidual(p.r.solver, st.target, rest) <= HAND_RELATCH_M) {
            prev.set(p.r, t);
            prevF.delete(p.r);
            continue;
          }
          if (!onLatchGrid(t)) continue; // it lets go at the next grid time, on a later frame
          st.target = null;
          changed.add(p.r);
          prev.set(p.r, null); // re-latch from here, at this point if it is inside the band
        }
        const pulled = pulledHand(p.r.solver, floorY, rest, _settlePulled);
        const h = pulled.y - floorY;
        let at: THREE.Vector3 | null = null;
        if (h <= HAND_TOUCH_M) {
          // Touching: latch where it touched, between the last time it was
          // above (if any) and now.
          at = pulled.clone();
          const above = prev.get(p.r);
          if (above != null && above < t - 1e-9) {
            at = touchBetween(p.r.solver, above, prevF.get(p.r) ?? null, t, h - HAND_TOUCH_M, at);
            reposed = true;
          }
        } else if (onLatchGrid(t)) {
          // Inside the band but not touching: latch where it was at the last
          // grid time if it has descended no further since.
          const last = st.lastGrid;
          if (
            last &&
            Math.abs(last.tMs - (t - HAND_LATCH_GRID_MS)) < 1e-6 &&
            last.height <= HAND_LATCH_M &&
            h >= last.height - HAND_DESCENT_STALL_M
          ) {
            at = last.point;
          } else {
            st.lastGrid = { tMs: t, height: h, point: pulled.clone() };
          }
        }
        if (!at) {
          prev.set(p.r, t);
          prevF.set(p.r, h - HAND_TOUCH_M);
          continue;
        }
        st.lastGrid = null;
        st.target = new THREE.Vector3(at.x, floorY, at.z);
        changed.add(p.r);
        prev.set(p.r, t);
      }
      if (reposed) probe(t);
    }
    if (walkTimes[walkTimes.length - 1] !== tMs) probe(tMs);
  }
  for (const r of reaches) {
    r.state.lastTMs = tMs;
    // A reach whose state changed on the walk is near its new threshold too:
    // the next frame reads the grid again.
    r.state.lastNear = near.get(r)! || changed.has(r);
  }
}

/** The full (weight-1) reach solve — see {@link solveHandReach}. */
function solveHandReachFull(
  solver: FootPlantSolver,
  state: HandReachState,
  floorY: number,
  rest: JointAngleRestReference | null | undefined,
  settled: boolean,
): void {
  const eff = solver.ctx.bones[0]!;
  if (state.target) {
    // A few CCD passes so the pinned hand holds against the (fast-moving) body as
    // the chest lowers — one pass under-converges and lets the hand punch through
    // the floor at the bottom of a rep.
    for (let i = 0; i < HAND_REACH_PASSES; i += 1) solveHandPlant(solver, state.target, rest);
    if (settled) return;
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
  if (settled) return;
  eff.getWorldPosition(_reachLive); // where it ended (best-effort)
  if (_reachLive.y <= floorY + HAND_LATCH_M) {
    state.target = new THREE.Vector3(_reachLive.x, floorY, _reachLive.z);
  }
}

/**
 * FLOOR REACH with latch-on-contact — the hand analog of a stance plant for a
 * secondary (non-height-setting) contact. While the hand is still above the floor
 * (the body descending into a plank), it is pulled straight DOWN toward the floor
 * plane below its live position; once it reaches the floor it FREEZES the point
 * where it did, so from then on it stays planted while the body lowers over it and
 * the arm folds — which is exactly the push-up. Call each frame the hand is a reach
 * contact, and reset `state.target` and `state.lastTMs` to null when it releases.
 *
 * `settled`: the frame's latch was settled by {@link settleHandReachLatches} — where
 * and when the hand latched is read on the motion's own clock, so it does not
 * depend on which frames ran — and this only solves the arm to it (or pulls it
 * toward the floor while it has not latched). Without it the solve latches on the
 * frame itself, where the first frame inside the band finds the hand (the legacy
 * path: its planted point, and every settled pose after it, moves with the frame
 * rate — the plank from quadruped settled 10.4 mm / 2.0° apart at 30 and 60 Hz).
 *
 * `weight` (0..1, default 1) is the SEAM-4 engagement ramp: at 1 the solve is the
 * full-correction path; below 1 the solved chain is blended back toward the
 * pre-solve FK arm (per-bone local slerp), so a newly-engaged reach folds in over
 * the caller's ramp instead of snapping the arm to the floor on its first frame.
 * Latch/self-heal decisions read the FULL solve (where the hand CAN reach), so the
 * latched point is weight-independent.
 */
export function solveHandReach(
  solver: FootPlantSolver,
  state: HandReachState,
  floorY: number,
  rest: JointAngleRestReference | null | undefined,
  weight = 1,
  settled = false,
): void {
  const w = Math.min(1, Math.max(0, weight));
  if (w >= 1) {
    solveHandReachFull(solver, state, floorY, rest, settled);
    return;
  }
  if (w <= 0) return; // not engaged yet — pure FK arm this frame
  const bones = solver.ctx.bones;
  const pre = bones.map((b) => b.quaternion.clone());
  solveHandReachFull(solver, state, floorY, rest, settled);
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
