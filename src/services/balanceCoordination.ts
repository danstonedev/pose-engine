/**
 * BALANCE COORDINATION — COM-driven postural control (the author-time
 * generalization of the hand-authored counterbalance values).
 *
 * Wave 1 taught three templates to stand on their own base by AUTHORING the
 * physiologic weight shift (stance-hip abduction, trunk list, hips-back hinge)
 * with rig-tuned magnitudes. This module is the universal form of that idea:
 * for any flagged quasi-static motion it MEASURES, per resolved keyframe, where
 * the whole-body centre of mass actually projects relative to the base of
 * support (services/centerOfMass — the same measurement the balance HUD and the
 * rig gates read), and ADDS small, ROM-clamped re-centering targets that lean
 * the body back over its base:
 *
 *   • stance-hip ab/adduction — the closed-chain lateral pelvis shift. With the
 *     stance foot planted (foot-rooted), stance-hip ABduction leans the body
 *     OVER the planted foot (rig-measured in Wave 1; adduction moves the COM
 *     the wrong way).
 *   • stance-hip flexion/extension — the closed-chain sagittal hip hinge (the
 *     pelvis travels back over planted feet as the trunk goes forward).
 *   • Spine_Lower/Spine_Upper lateralTilt + Spine_Lower flexion — the small
 *     trunk counterlean that completes the postural set.
 *
 * Because the measurement is taken on the CURRENT keyframes — including any
 * authored counterbalance — the correction is RESIDUAL by construction: a
 * template that already balances gets (near-)zero additions, and the transform
 * can never double-correct what the author already did.
 *
 * KINEMATIC CHARTER. This runs at BUILD time (sampler + stage pre-pass), not in
 * playback: it iterates measure→add a bounded number of passes with hard caps,
 * emits ordinary keyframe targets through the same ROM clamp as any command,
 * and is a pure function of its inputs — playback stays deterministic and no
 * feedback controller ever runs live. Two builds of the same motion are
 * byte-identical.
 *
 * LOCKSTEP. The offline sampler (services/motionRecording) and the live stage
 * (ExamStage3D) both apply THIS transform at the same pipeline point — after
 * resolution, before the trajectory is built — mirroring the
 * vertical-calibration pre-pass pattern, so a recording is frame-for-frame what
 * the stage shows.
 *
 * OPT-IN + HARD EXCLUSIONS. Only a motion flagged `balanceAssist` is touched,
 * and even then whole classes are excluded because the quasi-static COM model
 * does not apply: foot-driven/travelling gait (momentum, not statics), looping
 * motions (cyclic, not settling), anything with a floating keyframe (airborne
 * ballistics own their COM arc), reoriented/lying postures and grounding
 * postures (already stable by construction on their support surface), declared
 * IK contacts (the plant solver owns the legs).
 *
 * Pure THREE on a live skeleton harness — no Svelte, no DOM.
 */
import * as THREE from 'three';
import type { BodyVariantConfig } from '../anatomy/bodyVariants';
import type { CustomPose } from '../types';
import type { JointAngleRestReference } from './jointAngles';
import { applyCustomPose } from './poseRig';
import { computeBalanceState } from './centerOfMass';
import { resolveCommandTarget } from './movementCommand';
import { buildSequencePoses, type ResolvedComposedMotion } from './motionSequence';
import {
  captureFloorReference,
  captureFootFrames,
  pinRootToFloor,
  plantStanceFoot,
  stanceFootDrift,
  FOOT_ROOT_DRIFT_M,
} from './rootMotion';

// ── Tuning (rig-calibrated against computeBalanceTimeline; see the gates in
//    src/__tests__/balanceCoordination.test.ts) ──────────────────────────────

/** A keyframe whose measured margin of stability is at least this (m) is left
 *  ALONE — it is already safely balanced. This is what makes the transform
 *  RESIDUAL in practice: a healthy quiet stance normally projects its COM
 *  behind the footprint centroid (the toes extend the polygon far forward), so
 *  chasing the centroid there would "correct" an already-stable pose into a
 *  lean. Only a keyframe at/near its stability edge is re-centered. */
export const BALANCE_SAFE_MARGIN_M = 0.03;
/** COM-vs-base-centroid offsets inside this band (m) are left alone — the pose
 *  is already balanced; correcting to the exact centroid would only fidget. */
export const BALANCE_DEADBAND_M = 0.015;
/** Most measure→add passes per motion (deterministic, bounded — no live
 *  feedback). Convergence is typically pass 2; pass 3 is the safety margin. */
const MAX_PASSES = 3;

// Channel gains, deg of added target per meter of desired COM shift, and their
// per-pass steps + cumulative caps. RIG-CALIBRATED, not analytic: the effective
// closed-chain sensitivities are small (the foot-root restore of a stance-leg
// rotation moves the pelvis by only a fraction of the naive lever arm —
// ~0.3 cm/deg for stance-hip abduction, ~0.2 cm/deg for a trunk tilt), so a
// full re-centering needs the whole physiologic SET, exactly like Wave 1's
// authored values: stance-hip shift + lifted-leg adduction + trunk list +
// stance-side arm. The caps are the subtlety contract — each channel is bounded
// at (or under) the magnitude Wave 1 shipped as believable, so the transform
// can complete an authored counterbalance but never exaggerate past it.
const HIP_FRONTAL_GAIN_DEG_PER_M = 100; // stance-hip ab/adduction
const LIFTED_ADD_GAIN_DEG_PER_M = 100; // lifted-leg adduction toward midline
const ARM_ABD_GAIN_DEG_PER_M = 250; // stance-side arm floats out
const SPINE_TILT_GAIN_DEG_PER_M = 60; // Spine_Lower lateralTilt (upper at half)
const HIP_SAGITTAL_GAIN_DEG_PER_M = 80; // stance-hip flexion/extension (hinge)
const SPINE_FLEX_GAIN_DEG_PER_M = 40; // Spine_Lower flexion counterlean

const HIP_STEP_MAX_DEG = 4;
const ARM_STEP_MAX_DEG = 8;
const SPINE_STEP_MAX_DEG = 2;
const HIP_FRONTAL_CAP_DEG = 8; // Wave 1 authored 8-10
const LIFTED_ADD_CAP_DEG = 8; // adduction only, [−8, 0] (Wave 1 authored −8)
const ARM_ABD_CAP_DEG = 20; // float out only, [0, 20] (Wave 1 authored 20-25)
const SPINE_TILT_LOWER_CAP_DEG = 6; // Wave 1 authored 6-8
const SPINE_TILT_UPPER_CAP_DEG = 3;
const HIP_SAGITTAL_CAP_DEG = 8;
const SPINE_FLEX_CAP_DEG = 4;

/** CLOSED-CHAIN DEAD ZONE: a stance-LEG target only moves the PELVIS when the
 *  foot-root engages, which needs the stance foot's FK drift to exceed
 *  FOOT_ROOT_DRIFT_M (≈3.2° of hip angle). Below that the vertical pin leaves
 *  the FK to swing the FOOT itself — the correction would move the BASE, not
 *  the body (measured: a −2.4° residual slid the planted foot ~4 cm). So a
 *  keyframe keeps a leg's hip corrections only when that leg's total merged
 *  hip angle clears this floor (drift ≈ 0.9·sin(4°) ≈ 6.3 cm — safely past the
 *  gate); otherwise the corrections are dropped and the trunk/arm channels
 *  (plain FK, no dead zone) carry the residual. */
const MIN_STANCE_LEG_DEG = 4;

/** Lateral-set channels (stance/lifted hip ab/adduction, trunk list, arm) —
 *  the single-support postural set that must HOLD through a landing keyframe
 *  (see the carry rule in {@link balanceCoordination}). */
const LATERAL_CHANNELS = new Set([
  'L_UpLeg.hipAbduction',
  'R_UpLeg.hipAbduction',
  'L_UpperArm.shoulderAbduction',
  'R_UpperArm.shoulderAbduction',
  'Spine_Lower.lateralTilt',
  'Spine_Upper.lateralTilt',
]);

/** ENTRY/LANDING total caps (deg, |authored + correction|): during the
 *  weight-TRANSFER keyframes — the first single-support keyframe (entry) and
 *  the keyframe that brings the free foot back down (landing) — the lateral set
 *  is bounded at the magnitudes Wave 1 shipped and rig-proved land cleanly. A
 *  full-strength lean there arrives too fast on the way in and (worse) holds
 *  the landing foot off the floor on the way out; the full correction belongs
 *  to the steady single-support keyframes between them. */
const TRANSFER_TOTAL_CAPS_DEG: Record<string, number> = {
  'L_UpLeg.hipAbduction': 8,
  'R_UpLeg.hipAbduction': 8,
  'Spine_Lower.lateralTilt': 6,
  'Spine_Upper.lateralTilt': 3,
  'L_UpperArm.shoulderAbduction': 20,
  'R_UpperArm.shoulderAbduction': 20,
};

/** The rig objects + resolve context the transform measures on — the same
 *  harness pieces the sampler's pre-passes use (motionRecording) and the stage
 *  mirrors. `rootRest` is the grounded rest transform the keyframe root states
 *  ride on; omitted, the root's transform AT CALL TIME is taken as rest (the
 *  offline sampler's contract). The harness is restored on return. */
export interface BalanceCoordinationHarness {
  root: THREE.Object3D;
  skinned: THREE.SkinnedMesh;
  variantCfg: BodyVariantConfig;
  /** Full-skeleton anatomic-rest pose (same contract as buildSequencePoses). */
  baselinePose: CustomPose;
  rest: JointAngleRestReference;
  /** Continuity seeds — mirror what the caller passes to buildSequencePoses so
   *  the measured settle poses are the ones that will actually play. */
  currentPose?: CustomPose | null;
  currentRoot?: {
    quat?: [number, number, number, number];
    translateM?: [number, number, number];
  } | null;
  /** Grounded rest transform override (the live stage's rootRestPos/Quat/Scale;
   *  its model root may be mid-scene when the pre-pass runs). */
  rootRest?: {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  };
}

/**
 * Whether {@link balanceCoordination} applies to a resolved motion: it must
 * OPT IN (`balanceAssist`) and belong to the quasi-static planted class the
 * COM-over-base model is valid for. Exported so tests (and hosts) can assert
 * the exclusions without running the transform.
 */
export function balanceAssistApplies(resolved: ResolvedComposedMotion): boolean {
  if (resolved.status !== 'ok' || resolved.balanceAssist !== true) return false;
  if (resolved.keyframes.length === 0) return false;
  // Gait / travelling / cyclic motions: momentum-driven, not quasi-static.
  if (resolved.loop === true || resolved.footDrivenTravel === true) return false;
  // Declared IK contacts: the plant solver owns the leg placement.
  if (resolved.contacts?.length) return false;
  for (const kf of resolved.keyframes) {
    // Airborne ballistics (jump/hop) own their COM arc — never assisted.
    if (kf.stance === 'floating') return false;
    // Grounding postures (sitting/quadruped/plank) rest on their own contact
    // set — stable by construction, and the feet are not the base.
    if (kf.groundingPosture != null) return false;
    const o = kf.root?.orient;
    // Reoriented / lying postures (same thresholds as stabilizeGaze's upright
    // check): the vertical COM projection over the FEET is meaningless there.
    if (o && (o.quat != null || Math.abs(o.pitchDeg ?? 0) > 20 || Math.abs(o.rollDeg ?? 0) > 20)) {
      return false;
    }
    // Authored horizontal travel: in-place only (a stepping motion places its
    // feet anew; re-centering onto the ORIGINAL base would fight the step).
    const t = kf.root?.translateM;
    if (t && Math.hypot(t[0], t[2]) > 0.02) return false;
  }
  // Something must actually be planted to have a base to re-center over.
  return resolved.keyframes.some((kf) => kf.stance === 'planted');
}

/** ROM-clamp a corrected absolute target through the SAME truth path as any
 *  authored command. Returns null when the registry refuses it outright (the
 *  caller then keeps the authored value — the correction is dropped, never
 *  forced). */
function clampCorrectedTarget(joint: string, motionKey: string, deg: number): number | null {
  const r = resolveCommandTarget({
    action: 'set-joint',
    joint,
    motion: motionKey,
    targetDegrees: deg,
  });
  return r.clampedDegrees ?? null;
}

/** Every registry motion of each joint the transform may write. When a merge
 *  writes ANY motion of a joint, the pose builder REBUILDS that joint from rest
 *  with exactly the commanded group (buildSequencePoses' joint-level replace
 *  semantics) — so the merge must always write the joint's WHOLE effective
 *  motion set, or a carried motion would be silently wiped (and vice versa: a
 *  keyframe that re-commands a joint wipes its other motions, and the merge
 *  must reproduce that wipe, not resurrect the carried value). */
const TOUCHED_JOINT_MOTIONS: Record<string, readonly string[]> = {
  L_UpLeg: ['hipFlexion', 'hipAbduction', 'hipRotation'],
  R_UpLeg: ['hipFlexion', 'hipAbduction', 'hipRotation'],
  L_UpperArm: ['shoulderFlexion', 'shoulderAbduction', 'shoulderRotation'],
  R_UpperArm: ['shoulderFlexion', 'shoulderAbduction', 'shoulderRotation'],
  Spine_Lower: ['flexion', 'lateralTilt', 'rotation'],
  Spine_Upper: ['flexion', 'lateralTilt', 'rotation'],
};

const jointOfChan = (chan: string): string => chan.slice(0, chan.indexOf('.'));
const motionOfChan = (chan: string): string => chan.slice(chan.indexOf('.') + 1);

/** Per keyframe: the authored EFFECTIVE value of every touched joint/motion
 *  under the pose builder's carry/wipe rules (a joint a keyframe doesn't
 *  mention holds its last value; a joint it does mention resets unmentioned
 *  motions to 0). Pure function of the AUTHORED resolved keyframes. */
function authoredEffectivePerKeyframe(resolved: ResolvedComposedMotion): Map<string, number>[] {
  const state = new Map<string, number>();
  return resolved.keyframes.map((kf) => {
    const authoredJoints = new Set(kf.targets.map((t) => t.joint));
    for (const [joint, motions] of Object.entries(TOUCHED_JOINT_MOTIONS)) {
      for (const m of motions) {
        const t = kf.targets.find((x) => x.joint === joint && x.motion === m);
        if (t) state.set(`${joint}.${m}`, t.clampedDegrees);
        else if (authoredJoints.has(joint)) state.set(`${joint}.${m}`, 0); // wiped
      }
    }
    return new Map(state);
  });
}

/** Per keyframe: channels of touched joints WIPED by a joint-level re-command
 *  (the joint is authored at that keyframe but the motion is not — the pose
 *  builder resets it to 0). Pure function of the AUTHORED resolved keyframes;
 *  drives both the merge's carry state and the landing-keyframe carry rule. */
function wipedChannelsPerKeyframe(resolved: ResolvedComposedMotion): Set<string>[] {
  return resolved.keyframes.map((kf) => {
    const authoredJoints = new Set(kf.targets.map((t) => t.joint));
    const wiped = new Set<string>();
    for (const [joint, motions] of Object.entries(TOUCHED_JOINT_MOTIONS)) {
      if (!authoredJoints.has(joint)) continue;
      for (const m of motions) {
        if (!kf.targets.some((t) => t.joint === joint && t.motion === m)) wiped.add(`${joint}.${m}`);
      }
    }
    return wiped;
  });
}

/**
 * Fold the accumulated per-keyframe corrections into the resolved keyframes as
 * ordinary absolute targets — the additive-merge pattern of
 * spinalGaitCoordination, adapted to RESOLVED (clamped) keyframes.
 *
 * CARRY/WIPE FIDELITY: keyframe poses fold from the previous keyframe — a
 * joint a keyframe doesn't mention holds its last pose, and a joint it DOES
 * mention is rebuilt with exactly the commanded motions (unmentioned motions of
 * that joint reset). The merge tracks the authored effective value of every
 * touched joint/motion under those exact semantics, then writes each corrected
 * joint's WHOLE motion set (authored-effective + correction, ROM-clamped) from
 * the first corrected keyframe onward — so corrections neither resurrect a
 * value the author wiped nor wipe a value the author carried.
 */
function mergeCorrections(
  resolved: ResolvedComposedMotion,
  corr: Map<string, number>[],
): ResolvedComposedMotion {
  // First keyframe each channel becomes active at (earliest nonzero correction).
  const activeFrom = new Map<string, number>();
  corr.forEach((m, i) => {
    for (const [chan, deg] of m) {
      if (Math.abs(deg) > 1e-3 && !activeFrom.has(chan)) activeFrom.set(chan, i);
    }
  });
  if (activeFrom.size === 0) return resolved;

  /** Authored EFFECTIVE values per keyframe (carry + wipe applied). */
  const eff = authoredEffectivePerKeyframe(resolved);
  const keyframes = resolved.keyframes.map((kf, i) => {
    const state = eff[i]!;
    // 1. Joints receiving a correction write at this keyframe (once a channel
    // is active, every later keyframe pins its joint explicitly, so a keyframe
    // measured as already-balanced RELEASES the correction rather than
    // silently inheriting the previous keyframe's lean).
    const writing = new Set<string>();
    for (const [chan, fromIdx] of activeFrom) {
      if (i >= fromIdx) writing.add(jointOfChan(chan));
    }
    if (writing.size === 0) return kf;
    // 2. Corrected absolute value for every motion of each written joint.
    const vals = new Map<string, number>();
    for (const joint of writing) {
      for (const m of TOUCHED_JOINT_MOTIONS[joint] ?? []) {
        const chan = `${joint}.${m}`;
        const authored = state.get(chan) ?? 0;
        const from = activeFrom.get(chan);
        const c = from != null && i >= from ? (corr[i]!.get(chan) ?? 0) : 0;
        vals.set(chan, Math.abs(c) > 1e-6 ? (clampCorrectedTarget(joint, m, authored + c) ?? authored) : authored);
      }
    }
    // 3. CLOSED-CHAIN DEAD ZONE (see MIN_STANCE_LEG_DEG): if a leg's merged
    // hip angles are too small to engage the foot-root, its hip corrections
    // would slide the planted FOOT instead of shifting the pelvis — revert
    // that leg's hip channels to their authored effective values.
    for (const side of ['L', 'R'] as const) {
      const abdChan = `${side}_UpLeg.hipAbduction`;
      const flexChan = `${side}_UpLeg.hipFlexion`;
      if (!vals.has(abdChan) && !vals.has(flexChan)) continue;
      const abd = vals.get(abdChan) ?? state.get(abdChan) ?? 0;
      const flex = vals.get(flexChan) ?? state.get(flexChan) ?? 0;
      if (Math.hypot(abd, flex) < MIN_STANCE_LEG_DEG) {
        if (vals.has(abdChan)) vals.set(abdChan, state.get(abdChan) ?? 0);
        if (vals.has(flexChan)) vals.set(flexChan, state.get(flexChan) ?? 0);
      }
    }
    // 4. Rebuild targets: replace written joints' authored targets in place,
    // append the rest of their (nonzero) effective motion set.
    const targets = kf.targets.map((t) =>
      writing.has(t.joint) && vals.has(`${t.joint}.${t.motion}`)
        ? { joint: t.joint, motion: t.motion, clampedDegrees: vals.get(`${t.joint}.${t.motion}`)! }
        : { ...t },
    );
    for (const [chan, v] of vals) {
      const joint = jointOfChan(chan);
      const m = motionOfChan(chan);
      if (kf.targets.some((x) => x.joint === joint && x.motion === m)) continue; // replaced above
      // A zero value on an otherwise-unauthored motion is a no-op either way
      // (the joint rebuild resets unmentioned motions to 0) — skip the noise.
      if (Math.abs(v) < 1e-3) continue;
      targets.push({ joint, motion: m, clampedDegrees: v });
    }
    return { ...kf, targets };
  });
  return { ...resolved, keyframes };
}

const _bcQ = new THREE.Quaternion();

/**
 * COM-driven postural control for a flagged quasi-static motion: per resolved
 * keyframe, pose the harness rig at the keyframe's SETTLE pose (FK + root state
 * + the same planted grounding the sampler/stage use — foot-rooted when the
 * stance foot has drifted, vertical floor-pin otherwise), measure the COM
 * ground-projection against the base-of-support centroid
 * ({@link computeBalanceState}), and ADD capped, ROM-clamped re-centering
 * targets. Iterates measure→add at most {@link MAX_PASSES} passes. Identity
 * (the SAME object) when the motion doesn't opt in, is excluded, or is already
 * balanced within the deadband. The harness rig is restored before returning.
 */
export function balanceCoordination(
  resolved: ResolvedComposedMotion,
  harness: BalanceCoordinationHarness,
): ResolvedComposedMotion {
  if (!balanceAssistApplies(resolved)) return resolved;
  const { root, skinned, variantCfg, baselinePose, rest } = harness;
  const skeleton = skinned.skeleton;

  // Preserve the harness exactly as we found it (sampler + stage both own it).
  const pos0 = root.position.clone();
  const quat0 = root.quaternion.clone();
  const scale0 = root.scale.clone();
  const restPos = harness.rootRest?.position ?? pos0;
  const restQuat = harness.rootRest?.quaternion ?? quat0;
  const restScale = harness.rootRest?.scale ?? scale0;

  // Floor + foot-frame references at anatomic rest — the same derivation the
  // sampler grounds with (vertical-calibration pre-pass pattern).
  root.position.copy(restPos);
  root.quaternion.copy(restQuat);
  root.scale.copy(restScale);
  applyCustomPose(skeleton, variantCfg, baselinePose);
  root.updateMatrixWorld(true);
  const floorRef = captureFloorReference(skeleton, variantCfg);
  const footFrames = captureFootFrames(skeleton, variantCfg);

  /** Cumulative corrections, per keyframe, keyed `joint.motion`. */
  const corr: Map<string, number>[] = resolved.keyframes.map(() => new Map());
  /** Whether each keyframe's SETTLE pose measured as single-support (final pass
   *  wins) — drives the landing-keyframe carry below. */
  const singleSupport: boolean[] = resolved.keyframes.map(() => false);
  let out = resolved;
  let anyCorrection = false;

  const clampAbs = (v: number, m: number): number => Math.max(-m, Math.min(m, v));
  const clampTo = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const built = buildSequencePoses(baselinePose, out, variantCfg, rest, {
      currentPose: harness.currentPose ?? null,
      currentRoot: harness.currentRoot ?? null,
    });
    let adjusted = false;

    for (let i = 0; i < built.poses.length; i += 1) {
      const rs = built.roots[i]!;
      if (rs.stance !== 'planted') continue;

      // Pose the rig at this keyframe's settle state, grounded exactly as the
      // sampler/stage ground a planted frame of this motion class: re-root at
      // the stance foot when the FK swung it off its plant, vertical pin else.
      applyCustomPose(skeleton, variantCfg, built.poses[i]!);
      _bcQ.set(rs.quat[0], rs.quat[1], rs.quat[2], rs.quat[3]);
      root.quaternion.copy(restQuat).multiply(_bcQ);
      root.position.set(
        restPos.x + rs.translateM[0],
        restPos.y + rs.translateM[1],
        restPos.z + rs.translateM[2],
      );
      root.scale.copy(restScale);
      root.updateMatrixWorld(true);
      if ((stanceFootDrift(root, skeleton, variantCfg, footFrames) ?? 0) > FOOT_ROOT_DRIFT_M) {
        plantStanceFoot(root, skeleton, variantCfg, footFrames);
      } else {
        pinRootToFloor(root, skeleton, variantCfg, floorRef);
      }

      const st = computeBalanceState(skeleton, variantCfg, { floorY: floorRef.floorY });
      if (st.base.airborne || st.base.polygon.length < 3) continue;
      const single = st.base.contacts.length === 1;
      singleSupport[i] = single;
      // Already safely balanced → leave the keyframe exactly as authored (the
      // residual contract — never lean a stable pose toward the centroid).
      if ((st.marginM ?? -Infinity) >= BALANCE_SAFE_MARGIN_M) continue;
      // Offset of the COM ground-projection from the base centroid (world m;
      // +x = subject-left, +z = the way the body faces).
      const ox = st.comGround[0] - st.base.center[0];
      const oz = st.comGround[1] - st.base.center[1];
      const m = corr[i]!;

      /** Step one channel toward `wantDeg`, bounded by the per-pass step and
       *  the channel's cumulative [lo, hi] band. */
      const step = (chan: string, wantDeg: number, stepMax: number, lo: number, hi: number): void => {
        const cur = m.get(chan) ?? 0;
        const next = clampTo(cur + clampAbs(wantDeg, stepMax), lo, hi);
        if (Math.abs(next - cur) > 0.01) {
          m.set(chan, next);
          adjusted = true;
        }
      };

      // LATERAL (frontal plane) — the single-support postural set. The stance
      // hip is unambiguous only on one foot, so the leg/arm channels are
      // single-support-only; the trunk list applies on any base.
      if (Math.abs(ox) > BALANCE_DEADBAND_M) {
        const dx = -ox; // desired COM shift, m (+x = subject-left)
        if (single) {
          const side = st.base.contacts[0] === 'L_Foot' ? 'L' : 'R';
          const lifted = side === 'L' ? 'R' : 'L';
          const towardStance = side === 'L' ? dx : -dx; // + = toward the stance foot
          // Stance-hip ABduction leans the foot-rooted body over the planted
          // foot (Wave 1's rig-measured closed-chain sign).
          step(`${side}_UpLeg.hipAbduction`, towardStance * HIP_FRONTAL_GAIN_DEG_PER_M, HIP_STEP_MAX_DEG, -HIP_FRONTAL_CAP_DEG, HIP_FRONTAL_CAP_DEG);
          // The LIFTED leg adducts toward midline — its mass swings over the
          // stance side (adduction only; never splay the free leg outward).
          step(`${lifted}_UpLeg.hipAbduction`, -towardStance * LIFTED_ADD_GAIN_DEG_PER_M, HIP_STEP_MAX_DEG, -LIFTED_ADD_CAP_DEG, 0);
          // The stance-side arm floats out (float only; never pinned across).
          step(`${side}_UpperArm.shoulderAbduction`, towardStance * ARM_ABD_GAIN_DEG_PER_M, ARM_STEP_MAX_DEG, 0, ARM_ABD_CAP_DEG);
        }
        // Trunk list: lateralTilt + = toward subject-left (+x) — Wave 1's sign.
        step('Spine_Lower.lateralTilt', dx * SPINE_TILT_GAIN_DEG_PER_M, SPINE_STEP_MAX_DEG, -SPINE_TILT_LOWER_CAP_DEG, SPINE_TILT_LOWER_CAP_DEG);
        step('Spine_Upper.lateralTilt', dx * SPINE_TILT_GAIN_DEG_PER_M * 0.5, SPINE_STEP_MAX_DEG, -SPINE_TILT_UPPER_CAP_DEG, SPINE_TILT_UPPER_CAP_DEG);
      }

      // SAGITTAL. + stance-hip flexion (closed chain, foot-rooted) sends the
      // pelvis BACKWARD over the planted feet (the endpoint-reach's authored
      // hinge); + spine flexion carries the trunk mass forward. Both push the
      // COM toward the centroid from their own end.
      if (Math.abs(oz) > BALANCE_DEADBAND_M) {
        const dz = -oz; // desired COM shift, m (+z = forward)
        for (const c of st.base.contacts) {
          const side = c === 'L_Foot' ? 'L' : 'R';
          step(`${side}_UpLeg.hipFlexion`, -dz * HIP_SAGITTAL_GAIN_DEG_PER_M, HIP_STEP_MAX_DEG, -HIP_SAGITTAL_CAP_DEG, HIP_SAGITTAL_CAP_DEG);
        }
        step('Spine_Lower.flexion', dz * SPINE_FLEX_GAIN_DEG_PER_M, SPINE_STEP_MAX_DEG, -SPINE_FLEX_CAP_DEG, SPINE_FLEX_CAP_DEG);
      }
    }

    if (!adjusted) break;
    anyCorrection = true;
    out = mergeCorrections(resolved, corr);
  }

  // LANDING-KEYFRAME CARRY (Wave 1's authored pattern): a keyframe that brings
  // the free foot DOWN is still single-support for most of its incoming tween,
  // so releasing the lateral postural set at ITS settle would fade the lean
  // mid-air — and worse, ease the stance hip through the closed-chain dead zone
  // while the body still stands on one foot. Hold the previous (single-support)
  // keyframe's lateral corrections through the landing keyframe; they release
  // at the NEXT keyframe, standing on both feet (exactly like the authored
  // kick/single-leg 'settle' phases). A channel the AUTHOR releases at the
  // landing keyframe (its joint is re-commanded there without it — e.g. the
  // landing leg's hip, whose adduction must release so the foot can reach the
  // floor) is released with the author, never carried.
  if (anyCorrection) {
    const wiped = wipedChannelsPerKeyframe(resolved);
    let restaged = false;
    for (let i = 1; i < resolved.keyframes.length; i += 1) {
      if (!singleSupport[i - 1] || singleSupport[i]) continue;
      for (const chan of LATERAL_CHANNELS) {
        if (wiped[i]!.has(chan)) continue;
        const prev = corr[i - 1]!.get(chan) ?? 0;
        const cur = corr[i]!.get(chan) ?? 0;
        if (Math.abs(prev) > Math.abs(cur)) {
          corr[i]!.set(chan, prev);
          restaged = true;
        }
      }
    }
    // WEIGHT-TRANSFER STAGING: bound the lateral set at the entry and landing
    // keyframes to the Wave-1-proven totals (TRANSFER_TOTAL_CAPS_DEG) — the
    // full correction belongs to the steady single-support keyframes between
    // them, arriving/releasing through a bounded intermediate lean.
    const eff = authoredEffectivePerKeyframe(resolved);
    for (let i = 0; i < resolved.keyframes.length; i += 1) {
      const isEntry = singleSupport[i] && (i === 0 || !singleSupport[i - 1]);
      const isLanding = i > 0 && singleSupport[i - 1] && !singleSupport[i];
      if (!isEntry && !isLanding) continue;
      for (const [chan, cap] of Object.entries(TRANSFER_TOTAL_CAPS_DEG)) {
        const c = corr[i]!.get(chan);
        if (c == null || Math.abs(c) < 1e-6) continue;
        const a = eff[i]!.get(chan) ?? 0;
        const bounded = clampAbs(a + c, cap) - a;
        if (Math.abs(bounded - c) > 1e-6) {
          corr[i]!.set(chan, bounded);
          restaged = true;
        }
      }
    }
    if (restaged) out = mergeCorrections(resolved, corr);
  }

  // Leave the harness as we found it (pose + root), so the caller's own
  // pipeline (floor capture, first frame) starts from clean state.
  root.position.copy(pos0);
  root.quaternion.copy(quat0);
  root.scale.copy(scale0);
  applyCustomPose(skeleton, variantCfg, harness.currentPose ?? baselinePose);
  root.updateMatrixWorld(true);
  return anyCorrection ? out : resolved;
}
