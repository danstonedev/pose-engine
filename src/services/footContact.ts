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
import { clampBoneToRom } from './poseRomClamp';

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
 * How a release's weight runs from 1 to 0 over its length:
 *  - `smoothstep`: 1 − (3u² − 2u³), its rate peaking at 1.5/length mid-way;
 *  - `cruise`: the same C1 start and finish, but it reaches its full rate by a
 *    fifth of the way ({@link RELEASE_CRUISE_RAMP}) and holds it to the last
 *    fifth — a rate of 1.25/length at most, a sixth under the smoothstep's.
 *    An ankle release that turns the leg onto FK's swing turns it no faster
 *    than it must: on the smoothstep, 26 of the curved walks' and the
 *    figure-eight's 72 foot releases (both rigs, 30/60/120 Hz) turned the hip
 *    faster than both 5c1c9ac's release and FK's own peak, by up to 21% (with
 *    the forefoot-only pin, {@link RELEASE_PIN_M}; 31, by up to 24%, with it
 *    on every release); cruising, 8, at 30 Hz only and by 10% at most
 *    (plantReleaseMain.test). A long release (a slow weight shift) has no
 *    fast swing to meet, and the cruise's sharper corners lift its foot
 *    harder than the smoothstep does (the 3 cm single-leg stance at 120 Hz,
 *    780 ms: 1.15× FK's acceleration against 1.13 allowed), so from
 *    {@link RELEASE_CRUISE_FROM_MS} to {@link RELEASE_CRUISE_TO_MS} it turns
 *    into the smoothstep (a smoothstep blend of the two, still C1).
 * Both have ZERO rate at both ends, so the release leaves the hold and joins
 * the FK swing without a velocity kink. The old linear ramp had a kink at
 * both: as it ended, the DDx walk's left ankle moved 10.6° in one frame
 * (−10.6° → 0.1°) and then not at all.
 */
export type PlantReleaseShape = 'smoothstep' | 'cruise';

/** The share of a `cruise` release spent reaching its full rate (and again
 *  leaving it). */
const RELEASE_CRUISE_RAMP = 0.2;
/** Release lengths (ms) over which the `cruise` shape turns into the
 *  smoothstep. */
const RELEASE_CRUISE_FROM_MS = 300;
const RELEASE_CRUISE_TO_MS = 500;

/**
 * The release weight `msSinceRelease` ms after a plant window ends: 1 → 0 over
 * `lengthMs` (default {@link PLANT_RELEASE_BLEND_MS}) along `shape`
 * ({@link PlantReleaseShape}; the smoothstep by default). 1 at or before the
 * window's end (and for a non-finite input — a caller treats that as "not
 * releasing"), 0 once the release is over.
 */
export function plantReleaseWeight(
  msSinceRelease: number,
  lengthMs = PLANT_RELEASE_BLEND_MS,
  shape: PlantReleaseShape = 'smoothstep',
): number {
  const u = msSinceRelease / lengthMs;
  if (!(u > 0)) return 1;
  if (u >= 1) return 0;
  const smooth = 1 - u * u * (3 - 2 * u);
  if (shape !== 'cruise') return smooth;
  const toSmooth = smooth01((lengthMs - RELEASE_CRUISE_FROM_MS) / (RELEASE_CRUISE_TO_MS - RELEASE_CRUISE_FROM_MS));
  if (toSmooth >= 1) return smooth;
  // Distance covered (0 → 1) at a rate rising linearly over the first ramp,
  // flat, then falling linearly over the last: C1, its rate 1 / (1 − ramp).
  const r = RELEASE_CRUISE_RAMP;
  const rate = 1 / (1 - r);
  const done = u < r ? (rate * u * u) / (2 * r) : u <= 1 - r ? rate * (u - r / 2) : 1 - (rate * (1 - u) * (1 - u)) / (2 * r);
  return (1 - toSmooth) * (1 - done) + toSmooth * smooth;
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
   *  (0..1, {@link RELEASE_PIN_M}; a forefoot's alone). */
  pin: number;
  /** How its weight runs from 1 to 0 ({@link plantReleaseWeight}). */
  shape: PlantReleaseShape;
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

/** How far (m, smoothly saturating) the release holds a released forefoot back
 *  from the floor-drag of its blend with FK (see {@link releaseContactPlant}):
 *  enough for DDx's toe-offs, dragged 3–11 mm back on their first released
 *  30 Hz frame, and the DDx-like toe-off (12 mm at 60 Hz). */
const RELEASE_PIN_M = 0.025;
/** The share of the release over which that hold lets go once the effector is
 *  lifted: a smoothstep, so it lets go with no kink. */
const RELEASE_PIN_FADE = 0.25;
/** The hold stands down where FK lifts the effector only late in the release
 *  (from 0.4 of it, gone by 0.6): held that long it builds a lag the rest of
 *  the release has to catch up. Measured when ankle releases were held too:
 *  the single-leg stance's foot, lifted by FK at 0.5–0.6 of its 780 ms,
 *  turned the hip 1.09× FK's peak held, 0.96× free; the held lift at 100 ms
 *  of a 600 ms raise 1.19× against 0.94. */
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
 *
 * Its shape ({@link PlantReleaseShape}): an ankle release cruises; a forefoot's
 * keeps the smoothstep — the cruise, reaching its full rate sooner, turned the
 * toe-pivot walk's braking-step knee 1.40× FK's local peak at 60 Hz against
 * 1.23 (1.3 allowed) — and so does a release another contact of the same leg
 * holds over (a heel rise into a forefoot hold): that hold has the last word
 * on the leg, so the release draws nothing and only seeds the hold's solve,
 * and cruising it moved the braking step's first released ankle frame, the
 * hold carried on, 24.35 → 24.44°/frame at 30 Hz.
 */
function readPlantRelease(
  fp: ContactPlant,
  plants: readonly ContactPlant[],
  tMs: number,
  frame: ContactPlantFrame,
): PlantRelease {
  const base = PLANT_RELEASE_BLEND_MS;
  // A forefoot lets go on the smoothstep, and so does a release another
  // contact of the same leg holds over (see below).
  const forefoot = /Toes$/.test(fp.solver.footKey);
  const covered = plants.some(
    (o) => o !== fp && o.solver.kneeKey === fp.solver.kneeKey && o.fromMs <= fp.toMs + 1e-6 && o.toMs > fp.toMs + 1e-6,
  );
  const shape: PlantReleaseShape = forefoot || covered ? 'smoothstep' : 'cruise';
  const out: PlantRelease = { toMs: fp.toMs, lengthMs: base, liftAt: null, pin: 0, shape };
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
    // release's own s = 1 − w, and the blend with FK lifts it as far again
    // (first order), so s(2 − s) of FK's height above the held point.
    for (let u = 0; u <= 1 + 1e-9; u += 0.005) {
      const s = 1 - plantReleaseWeight(u * lengthMs, lengthMs, shape);
      if (s * (2 - s) * offsetAt(plan, u * lengthMs).y >= PLANT_RELEASE_FLOOR_BAND_M) {
        out.liftAt = u;
        break;
      }
    }
    out.lengthMs = lengthMs;
    if (forefoot && out.liftAt !== null) {
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
 * progress (1 − w), its horizontal position only on the square of it, so the
 * toes rise with the swing before they travel. The horizontal must still reach
 * FK's: left at the held point, the solve keeps reaching back to it and the DDx
 * walk's last release frame drops the left ankle 7.8° into FK.
 *
 * OFF THE FLOOR-DRAG: the blend with FK is per joint, so it drags the drawn
 * effector off the solve's point toward FK's — and where FK has the toes well
 * behind and above the held point (DDx's walk at 30 Hz: 7–12 cm behind, 2.5–7
 * cm up) that dragged them 3.3–11.3 mm back along the floor on the first
 * released frame, while the target itself had moved under 1 mm. A released
 * FOREFOOT is therefore swung about its root joint (the hip) — one small
 * rotation, which no joint limit can snap — to carry it back toward where the
 * solve put it, horizontally, by at most {@link RELEASE_PIN_M} (a smooth
 * saturation). It holds until the drawn toes have lifted a band
 * ({@link PlantRelease.liftAt}, read with the release) and lets go over the
 * next {@link RELEASE_PIN_FADE} of it — on the release's own clock, so how
 * fast the effector happens to rise cannot time it: timed by the target
 * crossing a height band instead, that hand-back came in one or two frames and
 * turned the curved walks' hips 5.2–7.5°/frame at 120 Hz against FK's 1.3.
 * It starts from nothing (the blend has not dragged yet) and ends with the
 * blend's own, so it is C1 at both ends. DDx's released toes now move
 * 0.2–1.9 mm on that frame. An ankle release is not held so: it leaves the
 * floor heel first, and handing its hold back, even on the release's clock,
 * turned the 45° walk's right hip 1.11–1.13°/frame at 120 Hz on both rigs
 * against 5c1c9ac's 0.71–0.73 (0.76 now).
 *
 * OFF THE FLOOR: a released forefoot is never drawn below the lower of its
 * held point and FK's toes ({@link liftReleasedForefoot}).
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
  if (/Toes$/.test(solver.footKey)) liftReleasedForefoot(solver, Math.min(held.y, _releaseFk.y), rest);
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

/** How far (m) under its floor level a released forefoot is drawn before
 *  {@link liftReleasedForefoot} lifts it all the way back: a smoothstep over
 *  this depth, so the lift starts from nothing. */
const RELEASE_FLOOR_EASE_M = 0.005;
/** The chain joints (indices into the toe chain toes → ankle → knee → hip)
 *  that lift a released forefoot, and how many passes they take. */
const RELEASE_FLOOR_JOINTS = [1, 3] as const;
const RELEASE_FLOOR_PASSES = 4;

const _floorPre: THREE.Quaternion[] = [];
const _floorTarget = new THREE.Vector3();
const _floorJoint = new THREE.Vector3();
const _floorFrom = new THREE.Vector3();
const _floorTo = new THREE.Vector3();
const _floorSwing = new THREE.Quaternion();
const _floorWorld = new THREE.Quaternion();
const _floorParent = new THREE.Quaternion();

/**
 * Keep a released forefoot from being drawn under `levelY` — the lower of its
 * held point and FK's own toes this frame, so never higher than the route puts
 * them. The blend of the held leg with FK's is per joint, and where the route
 * has left the held toes far behind (the toe-pivot walk's braking step: FK's
 * toes 38–68 cm ahead, the knee at 30°) the blended leg passes under the body
 * with less knee than FK's, so at 60 Hz the toes went 2.8 cm under the floor
 * at speed 1 and 3.6 at 1.5 (5c1c9ac 2.5 and 2.4), and at 60–120 Hz stayed
 * more than 3 mm under it for 6–12 frames at speed 1 (5c1c9ac 5–8); now 0.7
 * and 1.2 cm, 2–4 frames (plantReleaseMain.test).
 *
 * It turns the ANKLE, then the hip, toward the drawn toes put back at that
 * level (CCD, ROM-clamped), eased in over {@link RELEASE_FLOOR_EASE_M} of
 * depth. Not the knee: the knee is what the blend is short of, but turning it
 * faster is exactly the joint speed the release keeps down (the whole chain's
 * lift turned the braking step's knee 1.50× and 1.58× FK's local peak at 30
 * and 60 Hz, against 1.22× and 1.23× without, 1.3 allowed at 60 Hz).
 * Mid-swing the hip alone cannot lift the toes — a turn about it moves them
 * along the floor — but it lets the ankle's dorsiflexion (what a real swing
 * clears the floor with) reach. The ankle pays for it: at speeds 1.2 and 1.5
 * it turns up to 1.56× as fast as 5c1c9ac's (female, 1.5, 120 Hz: 8.44
 * against 5.42°/frame). A function of the frame alone, like the rest of the
 * release.
 */
function liftReleasedForefoot(
  solver: FootPlantSolver,
  levelY: number,
  rest: JointAngleRestReference | null | undefined,
): void {
  const bones = solver.ctx.bones;
  const toes = bones[0]!;
  toes.getWorldPosition(_releaseDrawn);
  const depth = levelY - _releaseDrawn.y;
  if (!(depth > 0)) return;
  while (_floorPre.length < bones.length) _floorPre.push(new THREE.Quaternion());
  for (let i = 0; i < bones.length; i += 1) _floorPre[i]!.copy(bones[i]!.quaternion);
  _floorTarget.set(_releaseDrawn.x, levelY, _releaseDrawn.z);
  for (let pass = 0; pass < RELEASE_FLOOR_PASSES; pass += 1) {
    for (const j of RELEASE_FLOOR_JOINTS) {
      const joint = bones[j];
      if (!joint?.parent) continue;
      joint.getWorldPosition(_floorJoint);
      _floorFrom.copy(toes.getWorldPosition(_floorFrom)).sub(_floorJoint);
      _floorTo.copy(_floorTarget).sub(_floorJoint);
      if (_floorFrom.lengthSq() < 1e-10 || _floorTo.lengthSq() < 1e-10) continue;
      _floorSwing.setFromUnitVectors(_floorFrom.normalize(), _floorTo.normalize());
      joint.getWorldQuaternion(_floorWorld).premultiply(_floorSwing);
      joint.quaternion.copy(joint.parent.getWorldQuaternion(_floorParent).invert().multiply(_floorWorld));
      const key = solver.ctx.canonicalKeys[j];
      if (rest && key) clampBoneToRom(joint, key, rest);
      joint.updateMatrixWorld(true);
    }
  }
  const g = smooth01(depth / RELEASE_FLOOR_EASE_M);
  for (let i = 0; i < bones.length; i += 1) {
    _releaseSolved.copy(bones[i]!.quaternion);
    bones[i]!.quaternion.copy(_floorPre[i]!).slerp(_releaseSolved, g);
  }
  bones[bones.length - 1]!.updateMatrixWorld(true);
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
      w = plantReleaseWeight(since, fp.release.lengthMs, fp.release.shape);
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
  /** The motion time of the last frame {@link settleHandReachLatches} settled
   *  this reach at; null before the first (and after a release). Kept by the
   *  settle. */
  lastTMs?: number | null;
  /** The reach's latch timeline on the motion's own clock
   *  ({@link settleHandReachLatches}). Kept by the settle. */
  timeline?: HandReachTimeline | null;
}

/**
 * Where and when a reach latches and lets go, on the motion's own clock: a pure
 * function of the motion (its trajectory, from the engagement on), read as far
 * as the frames have asked. Kept by {@link settleHandReachLatches}.
 */
export interface HandReachTimeline {
  /** What the timeline was read for: the caller's key (the trajectory) and the
   *  engagement time it starts from. */
  key: unknown;
  engagedAtMs: number;
  /** Every change of state so far, in time order: from `tMs` on the hand is
   *  planted at `target` (null: descending). The first is the engagement. */
  events: { tMs: number; target: THREE.Vector3 | null }[];
  /** How far the timeline has been read (motion ms), and the reach there. */
  cursorMs: number;
  /** The pulled height above the floor (descending) or the held residual
   *  (planted) at the cursor, m. */
  value: number;
  /** The evaluation before the cursor in the same state (for the rate the
   *  next step is sized by); null right after a change of state. */
  prev: { tMs: number; value: number } | null;
  /** A descending hand's last {@link HAND_LATCH_GRID_MS} grid evaluation inside
   *  the band: when, its pulled height and where it was (the stall latch). */
  lastGrid: { tMs: number; height: number; point: THREE.Vector3 } | null;
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

/** The motion-clock grid (ms) the timeline is read on: a self-heal falls on
 *  it (the first grid time at which the hand can no longer hold its point),
 *  and so does a stall inside the band; every read of the timeline is on it
 *  but the engagement's own. */
const HAND_LATCH_GRID_MS = 5;

/** The moment a descending hand touched the floor is solved to this (m of
 *  pulled height, 0.01 mm) — in under 5 µs of motion time where the hand drops
 *  2 mm/ms, the hand then moving 0.01 mm — off the pulled height's falling
 *  side ({@link nextTouchProbe}), in at most {@link HAND_LATCH_SOLVE_STEPS}
 *  reads. */
const HAND_LATCH_SOLVE_M = 1e-5;
const HAND_LATCH_SOLVE_STEPS = 12;

/**
 * How far apart (ms) the timeline reads a reach: as far as its distance from
 * the next change of state (the band for a descending hand, the self-heal
 * residual for a planted one) could be covered at the fastest of
 * {@link HAND_LATCH_MIN_RATE_M_PER_MS} and {@link HAND_LATCH_RATE_MARGIN}× the
 * rate between its last two reads — on the grid, and no farther than this.
 * Read every 5 ms grid time instead (the frame-gap walk this replaced), a
 * parked stage paid 1.3–1.5 s per push-up command (5c1c9ac: 10 ms, latching
 * on whichever frames ran); read so, with a planted hand read farther apart
 * ({@link HAND_LATCH_PLANTED_MAX_STEP_MS}) and two hands touching together
 * sharing their touch solve, 11–14 ms. The timeline lands within 0.015 mm of
 * the every-5-ms one on every hand-planted motion and chain, both rigs, at 60
 * Hz, on a jittered clock, a 40–95 ms clock and one jump (the touch moments
 * move inside their own solve tolerance). A reach whose state
 * comes and goes wholly between two reads — covering twice its distance from
 * the threshold inside one step, so moving at over twice the rate the step was
 * sized for — is missed by every clock alike.
 */
const HAND_LATCH_MAX_STEP_MS = 200;
/** Rate floor (m/ms) and margin on the observed rate the steps are sized by. */
const HAND_LATCH_MIN_RATE_M_PER_MS = 0.0003;
const HAND_LATCH_RATE_MARGIN = 1.5;
/** The same for a PLANTED hand, read for its self-heal: its residual sits at
 *  a fraction of a millimetre while its arm folds over the point (the push-up)
 *  and moves only once the body has carried the shoulder out of the arm's
 *  reach, so it is read up to 600 ms apart at a 0.1 m/s floor. Read 200 ms
 *  apart at the descending hand's 0.3 m/s, one parked push-up cost 1.7–2.1×
 *  5c1c9ac's jump (male / female), and the bird-dog two reps 1.6–2.0×; the
 *  settled hands of all twelve hand-planted motions and three chains are
 *  unchanged, both rigs. */
const HAND_LATCH_PLANTED_MAX_STEP_MS = 600;
const HAND_LATCH_PLANTED_MIN_RATE_M_PER_MS = 0.0001;

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

/** The first grid time after `t`. */
const nextLatchGrid = (t: number): number => (Math.floor(t / HAND_LATCH_GRID_MS + 1e-9) + 1) * HAND_LATCH_GRID_MS;

/** When the timeline reads its reach next: the next grid time inside the band
 *  (or right after a change of state), else as far as the distance to the next
 *  change of state allows at the rate it has been moving (see
 *  {@link HAND_LATCH_MAX_STEP_MS}). */
function nextLatchRead(tl: HandReachTimeline, planted: boolean): number {
  const first = nextLatchGrid(tl.cursorMs);
  const margin = planted ? HAND_RELATCH_M - tl.value : tl.value - HAND_LATCH_M;
  if (!(margin > 0) || !tl.prev) return first;
  const rate = Math.max(
    planted ? HAND_LATCH_PLANTED_MIN_RATE_M_PER_MS : HAND_LATCH_MIN_RATE_M_PER_MS,
    (HAND_LATCH_RATE_MARGIN * Math.abs(tl.value - tl.prev.value)) / Math.max(1e-9, tl.cursorMs - tl.prev.tMs),
  );
  const step = Math.min(planted ? HAND_LATCH_PLANTED_MAX_STEP_MS : HAND_LATCH_MAX_STEP_MS, margin / rate);
  return Math.max(first, Math.floor((tl.cursorMs + step) / HAND_LATCH_GRID_MS + 1e-9) * HAND_LATCH_GRID_MS);
}

/** One descending hand's touch being solved ({@link settleHandReachLatches}):
 *  the bracket — `lo`, the last read above the touch (pulled height less
 *  {@link HAND_TOUCH_M} there `fLo` > 0), and `hi`, the first at or below it
 *  (`fHi` ≤ 0, the hand then `at`) — and the reads above it so far. */
interface TouchSolve {
  r: HandReachContact;
  tl: HandReachTimeline;
  lo: number;
  fLo: number;
  hi: number;
  fHi: number;
  at: { tMs: number; point: THREE.Vector3 };
  /** Reads above the touch, oldest first (the last three are kept). */
  above: { tMs: number; f: number }[];
  /** Whether the last read came from the line through the last two reads
   *  above and landed below the touch. */
  overshot: boolean;
  reads: number;
  done: boolean;
}

/**
 * Where a touch solve reads next. The pulled height is a hinge: it falls with
 * the body and is flat once the arm reaches the floor (the hand solved onto
 * it), so a secant through a read on the flat side lands next to that read
 * (regula falsi took 8–11 reads per push-up hand). The touch is read off the
 * falling side instead: the secant through both ends while the hand at the
 * upper end is not yet on the floor, else the curve through its last three
 * reads above it (the line through two, where there are only two), and
 * halfway across the bracket where there is only one, or where the last such
 * read overshot onto the flat side.
 */
function nextTouchProbe(x: TouchSolve): number {
  const width = x.hi - x.lo;
  let c = x.lo + 0.5 * width;
  const n = x.above.length;
  if (x.fHi > HAND_LATCH_SOLVE_M - HAND_TOUCH_M) {
    // The hand at `hi` is not on the floor yet: both ends are on the falling
    // side, and the secant through them is the better read.
    c = x.hi - (x.fHi * width) / (x.fHi - x.fLo);
  } else if (n >= 2 && !x.overshot) {
    const a = x.above[n - 2]!;
    const b = x.above[n - 1]!;
    if (a.f > b.f) {
      const line = b.tMs + (b.f * (b.tMs - a.tMs)) / (a.f - b.f);
      if (line > x.lo && line < x.hi) c = line;
    }
    const z = n >= 3 ? x.above[n - 3]! : null;
    if (z && z.f > a.f && a.f > b.f) {
      // Three reads above it: the time as a quadratic in the height through
      // them, read at the touch — a landing hand slows as it comes down, and
      // the line through the last two falls short of it read after read.
      const quad =
        (z.tMs * a.f * b.f) / ((z.f - a.f) * (z.f - b.f)) +
        (a.tMs * z.f * b.f) / ((a.f - z.f) * (a.f - b.f)) +
        (b.tMs * z.f * a.f) / ((b.f - z.f) * (b.f - a.f));
      if (quad > x.lo && quad < x.hi) c = quad;
    }
  }
  // Keep the read strictly inside the bracket.
  const edge = 1e-3 * width;
  return Math.min(x.hi - edge, Math.max(x.lo + edge, c));
}

/** Take a touch solve's read at `c` (pulled height less the touch `fc`, the
 *  hand then at `point`). */
function readTouch(x: TouchSolve, c: number, fc: number, point: THREE.Vector3): void {
  x.reads += 1;
  const fromLine = x.above.length >= 2 && !x.overshot;
  if (Math.abs(fc) <= HAND_LATCH_SOLVE_M) {
    x.at = { tMs: c, point: point.clone() };
    x.done = true;
    return;
  }
  if (fc > 0) {
    x.lo = c;
    x.fLo = fc;
    x.above.push({ tMs: c, f: fc });
    if (x.above.length > 3) x.above.shift();
    x.overshot = false;
  } else {
    x.hi = c;
    x.fHi = fc;
    x.at = { tMs: c, point: point.clone() };
    x.overshot = fromLine;
  }
  if (x.reads >= HAND_LATCH_SOLVE_STEPS || x.hi - x.lo < 1e-6) x.done = true;
}

/** Latch a descending timeline at `tMs`, on the floor (`floorY`) under `point`. */
function latchTimeline(tl: HandReachTimeline, tMs: number, point: THREE.Vector3, floorY: number): void {
  tl.events.push({ tMs, target: new THREE.Vector3(point.x, floorY, point.z) });
  tl.lastGrid = null;
  tl.prev = null;
  tl.cursorMs = tMs;
  tl.value = 0;
}

/** The latched point (null: descending) the timeline has at `tMs`. */
function latchAt(tl: HandReachTimeline, tMs: number): THREE.Vector3 | null {
  let at: THREE.Vector3 | null = null;
  for (const e of tl.events) {
    if (e.tMs > tMs + 1e-9) break;
    at = e.target;
  }
  return at;
}

/**
 * Settle every reach contact's latch at motion time `tMs`, on the motion's own
 * clock: call it on each frame, with the body posed for `tMs` (FK, root,
 * grounding pin — exactly what `probe(tMs)` poses), before solving the reaches
 * ({@link solveHandReach} with `settled`). It leaves the body posed for `tMs`.
 * `key` names what `probe` samples (the trajectory): a reach's timeline is read
 * afresh for another key or another engagement.
 *
 * Each reach keeps a TIMELINE of where and when it latches, read on the
 * motion's clock from its engagement — never on the frames that ran — as far
 * as the frames ask (one read past the latest frame). A reach changes state at
 * two kinds of moment, and each is found where it happened:
 *  - LATCH: a descending hand latches where its pulled position touched the
 *    floor ({@link HAND_TOUCH_M}) — the moment is solved on the trajectory
 *    between the read above it (or the engagement) and the first at it
 *    ({@link HAND_LATCH_SOLVE_M}; hands touching between the same two reads
 *    are solved together, sharing each probe), and the point is the pulled
 *    hand's then. A hand that comes within the {@link HAND_LATCH_M} band but
 *    never touches latches where it was at a grid time, from the next grid time
 *    that shows it descended no further (inside the band it is read on every
 *    grid time);
 *  - SELF-HEAL: a planted hand that can no longer hold its point within
 *    {@link HAND_RELATCH_M} lets go at the first {@link HAND_LATCH_GRID_MS}
 *    grid time at which it cannot (every grid time back to the last read that
 *    held is checked), and re-latches from there as a descending hand would.
 * The reads are spaced by how far the reach is from its next change of state
 * ({@link HAND_LATCH_MAX_STEP_MS}), so where they fall is a function of the
 * motion alone: 30, 60 and 120 Hz, a jittered clock, a 40–95 ms clock and a
 * parked stage's settle-to-settle jumps all read the same timeline and settle
 * identically, and none pays for reads the timeline does not need (the frame-
 * gap walk this replaced read every 5 ms of any gap over 100 ms: 1.3–1.5 s for
 * a parked push-up command).
 */
export function settleHandReachLatches(
  reaches: readonly HandReachContact[],
  tMs: number,
  floorY: number,
  rest: JointAngleRestReference | null | undefined,
  probe: HandReachProbe,
  key: unknown = null,
): void {
  /** Solve, together, the moment each of `touches` touched the floor inside
   *  its bracket (see {@link TouchSolve}): every probe of one hand's solve also
   *  reads every other hand whose bracket holds it — two hands landing
   *  together (the push-up) share every probe. Each lands within
   *  {@link HAND_LATCH_SOLVE_M} of the touch in pulled height, or on the end of
   *  its bracket at or below it after {@link HAND_LATCH_SOLVE_STEPS} reads. */
  const solveTouches = (touches: TouchSolve[]): void => {
    for (let n = 0; n < HAND_LATCH_SOLVE_STEPS * touches.length; n += 1) {
      const s = touches.find((x) => !x.done);
      if (!s) return;
      const c = nextTouchProbe(s);
      probe(c);
      for (const x of touches) {
        if (x.done || !(c > x.lo && c < x.hi)) continue;
        const fc = pulledHand(x.r.solver, floorY, rest, _settlePulled).y - floorY - HAND_TOUCH_M;
        readTouch(x, c, fc, _settlePulled);
      }
    }
  };
  /** Read reach `r` descending at `t` (the body posed there): latch it if it
   *  stalled inside the band, or — collected into `touches` for
   *  {@link solveTouches} — if it touched since the last read above the floor;
   *  a hand touching on its first read latches there. */
  const readDescending = (r: HandReachContact, tl: HandReachTimeline, t: number, touches: TouchSolve[] | null): void => {
    const pulled = pulledHand(r.solver, floorY, rest, _settlePulled);
    const h = pulled.y - floorY;
    if (h <= HAND_TOUCH_M) {
      if (touches && tl.cursorMs < t - 1e-9 && Number.isFinite(tl.value) && tl.value > HAND_TOUCH_M) {
        // Touching: latch where it touched, between the last read above it
        // (the cursor) and now — solved with every other hand touching now.
        touches.push({
          r,
          tl,
          lo: tl.cursorMs,
          fLo: tl.value - HAND_TOUCH_M,
          hi: t,
          fHi: h - HAND_TOUCH_M,
          at: { tMs: t, point: pulled.clone() },
          above: [{ tMs: tl.cursorMs, f: tl.value - HAND_TOUCH_M }],
          overshot: false,
          reads: 0,
          done: false,
        });
        return;
      }
      latchTimeline(tl, t, pulled, floorY);
      return;
    }
    if (onLatchGrid(t) && h <= HAND_LATCH_M) {
      // Inside the band but not touching: latch where it was at the last grid
      // time if it has descended no further since.
      const last = tl.lastGrid;
      if (last && Math.abs(last.tMs - (t - HAND_LATCH_GRID_MS)) < 1e-6 && h >= last.height - HAND_DESCENT_STALL_M) {
        latchTimeline(tl, t, last.point, floorY);
        return;
      }
      tl.lastGrid = { tMs: t, height: h, point: pulled.clone() };
    } else {
      tl.lastGrid = null;
    }
    tl.prev = Number.isFinite(tl.value) && tl.cursorMs < t - 1e-9 ? { tMs: tl.cursorMs, value: tl.value } : null;
    tl.cursorMs = t;
    tl.value = h;
  };
  /** Read reach `r` planted at `t` (the body posed there): let it go at the
   *  first grid time since the last read at which it could not hold its point,
   *  and read it descending from there. Returns whether the body was re-posed
   *  off `t`. */
  const readPlanted = (r: HandReachContact, tl: HandReachTimeline, target: THREE.Vector3, t: number): boolean => {
    const res = heldResidual(r.solver, target, rest);
    if (res <= HAND_RELATCH_M) {
      tl.prev = { tMs: tl.cursorMs, value: tl.value };
      tl.cursorMs = t;
      tl.value = res;
      return false;
    }
    // It could not hold it here: find the first grid time since the last read
    // at which it could not (every one between, back to the read that held).
    let heal = t;
    let reposed = false;
    for (let g = nextLatchGrid(tl.cursorMs); g < t - 1e-6; g += HAND_LATCH_GRID_MS) {
      probe(g);
      reposed = true;
      if (heldResidual(r.solver, target, rest) > HAND_RELATCH_M) {
        heal = g;
        break;
      }
    }
    if (heal !== t) {
      probe(heal);
      reposed = true;
    }
    tl.events.push({ tMs: heal, target: null });
    tl.prev = null;
    tl.lastGrid = null;
    tl.cursorMs = heal;
    tl.value = Infinity; // no read above the floor yet: a touch here latches here
    // Re-latch from here, at this point if it is already touching.
    readDescending(r, tl, heal, null);
    return reposed;
  };

  // Bring each reach's timeline up to date (read afresh for another motion or
  // engagement), and find which must be read past this frame.
  const pending: { r: HandReachContact; tl: HandReachTimeline }[] = [];
  for (const r of reaches) {
    const st = r.state;
    const from = Math.min(tMs, Math.max(0, r.engagedAtMs));
    let tl = st.timeline;
    if (!tl || tl.key !== key || Math.abs(tl.engagedAtMs - from) > 1e-6) {
      tl = { key, engagedAtMs: from, events: [{ tMs: from, target: null }], cursorMs: from, value: Infinity, prev: null, lastGrid: null };
      st.timeline = tl;
      pending.push({ r, tl });
    } else if (tl.cursorMs < tMs - 1e-9) {
      pending.push({ r, tl });
    }
  }
  let posedOff = false;
  // A fresh timeline is read at the engagement first; then each is read on
  // its own schedule until it has been read at or past this frame. Reads that
  // fall on one time share one pose.
  const fresh = pending.filter((p) => p.tl.value === Infinity && p.tl.events.length === 1 && p.tl.cursorMs === p.tl.engagedAtMs);
  for (const p of fresh) {
    if (Math.abs(p.tl.cursorMs - tMs) > 1e-9 || posedOff) {
      probe(p.tl.cursorMs);
      posedOff = Math.abs(p.tl.cursorMs - tMs) > 1e-9;
    }
    readDescending(p.r, p.tl, p.tl.cursorMs, null);
  }
  const nextOf = (p: { tl: HandReachTimeline }): number => nextLatchRead(p.tl, latchAt(p.tl, p.tl.cursorMs) !== null);
  for (;;) {
    const open = pending.filter((p) => p.tl.cursorMs < tMs - 1e-9);
    if (!open.length) break;
    const t = Math.min(...open.map(nextOf));
    probe(t);
    posedOff = Math.abs(t - tMs) > 1e-9;
    let reposed = false;
    const touches: TouchSolve[] = [];
    for (const p of open) {
      if (Math.abs(nextOf(p) - t) > 1e-9) continue;
      if (reposed) probe(t);
      const target = latchAt(p.tl, p.tl.cursorMs);
      if (target) reposed = readPlanted(p.r, p.tl, target, t);
      else {
        reposed = false;
        readDescending(p.r, p.tl, t, touches);
      }
      if (reposed) posedOff = true;
    }
    if (touches.length) {
      solveTouches(touches);
      for (const x of touches) latchTimeline(x.tl, x.at.tMs, x.at.point, floorY);
      posedOff = true;
    }
  }
  if (posedOff) probe(tMs);
  for (const r of reaches) {
    r.state.target = latchAt(r.state.timeline!, tMs);
    r.state.lastTMs = tMs;
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
