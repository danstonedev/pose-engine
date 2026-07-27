/**
 * LOCOMOTION MOTION FACTORIES — the travelling half of the authored movement
 * library: the walk (in-place cycle → travelling walk → arc walk → figure-eight),
 * the step turn, the ballistic family (jump, single-leg hop) and the run
 * (in-place + travelling), plus the foot-plant contact windows a gait cycle
 * publishes.
 *
 * Split out of services/movementTemplates so the locomotor family and the posture
 * family (services/movementPostures) stop sharing one very large file. Each
 * builder's own tuning constants sit directly above it, so no builder reads a
 * `const` declared further down the module.
 *
 * Pure: every factory authors keyframes over the movement-command vocabulary and
 * is ROM-clamped + measured by the normal resolve path. Re-exported from
 * services/movementTemplates so the public surface (and every existing importer)
 * is unchanged.
 */

import { minKeyframeMsFor } from './motionSequence';
import type {
  ComposedMotion,
  SemanticTravel,
  SequenceKeyframe,
  SequenceTarget,
  StanceContact,
  StanceMode,
} from './motionSequence';
import { healthySignature } from './healthySignature';
import { MOVEMENT_TEMPLATES } from './movementTemplates.data';
import { templateToComposedMotion } from './movementTemplateMotion';
import { NORMAL_GAIT_VERTICAL_CM } from './gaitConstants';
import { paceGait, spinalGaitCoordination } from './gaitModifiers';

/**
 * Build a FORWARD-TRAVELING gait from the authored walk cycle — the same 8-phase
 * kinematics as the in-place `walk`, but advancing across the floor with
 * **ground-true feet via root motion FROM foot placement** (`footDrivenTravel`).
 *
 * The earlier version authored an INDEPENDENT stride (a guessed 0.35 m/step) and
 * IK-locked the feet to it. That is the classic "two sources of truth" bug: the FK
 * sweeps the foot ~1 m while the root advanced only 0.35 m, so the planted foot was
 * dragged and — worse — the foot-lock captured each foot at its window start, when
 * the swing foot was still airborne (heel-strike hadn't happened), leaving it
 * sliding ~7-18 cm vertically. Increasing the stride made it worse.
 *
 * Now there is ONE source of truth. The sampler/stage measure the FK foot sweep
 * and advance the root to cancel the planted (lower) foot's backward motion, so the
 * stance foot is world-fixed BY CONSTRUCTION (no capture timing, no IK) and the
 * swing foot rides the body forward. The **stride emerges from the authored hip/
 * knee ROM** — and from `paceGait` for a faster walk (bigger swing → longer stride
 * AND quicker cadence). Vertical grounding stays with the floor-pin.
 *
 * Reuses the walk phases verbatim (ROM-validated, coordination-gated, incl. the
 * elbow follow-through). Non-looping, `startFrom:'current'`, so repeating it walks
 * further from wherever the body already is.
 */
/**
 * FOOT-PLANT CONTACTS for a symmetric two-step gait cycle: the RIGHT foot is the stance
 * (pinned) foot through the first half of the cycle, the LEFT through the second — so each
 * foot's stance window is [0, mid] / [mid, total]. The sampler pins each stance foot's
 * world position by leg IK for its window, so the pelvis can rotate ABOUT the planted leg
 * (the foot never swivels or slides). For a walk template whose two steps split the cycle
 * in half (the standard 8-phase, R-stance × 4 → L-stance × 4).
 */
export function gaitFootContacts(motion: ComposedMotion): StanceContact[] {
  const kfs = motion.keyframes;
  const dur = (k: (typeof kfs)[number]): number => (k.durationMs ?? 0) + (k.holdMs ?? 0);
  const total = kfs.reduce((s, k) => s + dur(k), 0);
  // The RIGHT foot bears through the first half of the cycle's keyframes (R
  // initial-contact → terminal-stance), the LEFT through the second — so the R↔L
  // stance boundary is the cumulative time at the half-keyframe mark, NOT total/2.
  // (They differ once a keyframe is non-uniform, e.g. a lengthened step-off entry;
  // using total/2 would release the stance foot early and let it slide.)
  const half = Math.ceil(kfs.length / 2);
  let mid = 0;
  for (let i = 0; i < half; i += 1) mid += dur(kfs[i]!);
  return [
    { foot: 'R_Foot', fromMs: 0, toMs: mid },
    { foot: 'L_Foot', fromMs: mid, toMs: total },
  ];
}

// ─── Travel-walk shaping constants ───────────────────────────────────────────
// Tuning for the TRAVELLING WALK builders below (buildTravelWalk /
// buildFigureEightWalk) — step-off entry, gait initiation (APA), heading pivot,
// arc clamp, braking termination and the medio-lateral shuttle it publishes.
// They live HERE, above their only callers, so the builders never depend on a
// declaration further down the module.
// Step-off entry duration (ms) for a travelling walk: the neutral→first-gait-pose
// transition covers a big limb delta (~40° knee), so give it ~2 gait phases of time so
// the limbs ease in at stride cadence instead of whipping. Scaled WITH the walk's
// normative-cadence retime (400 ms was ~2 phases of the old 1600 ms cycle; 285 ms is
// ~2 phases of the 1144 ms cycle), so the entry stays proportionate to the stride
// instead of dragging for three phases and stretching the walk's one cycle.
const GAIT_STEP_OFF_MS = 285;
// ─── Gait initiation / termination / weight transfer (travel walk) ───────────
// REAL GAIT INITIATION — the anticipatory postural adjustment (APA): before the
// first swing foot ever leaves the floor, the pelvis/COM shifts over the future
// STANCE foot (the walk enters on R stance — the L foot is the first swing) and
// the future swing knee unweights slightly [Winter; Jian 1993]. Authored as a
// short lead keyframe ahead of the first gait pose, replacing the old bare
// time-stretch (which eased the limbs in but shifted no weight at all).
const GAIT_INITIATION_MS = 300; // APA lead keyframe travel time
/** Extra initiation time per degree of travel-heading re-orientation (ms/°):
 *  a headed walk pivots toward its new line of travel DURING the initiation
 *  keyframe, and the pivot should read as a calm weight-shifted turn, not a
 *  whip (90° ⇒ ~315 ms, 180° ⇒ ~630 ms). Heading 0 is unaffected. */
const GAIT_HEADING_TURN_MS_PER_DEG = 3.5;
/** ARC-WALK clamp (roadmap 6.2): the most a single travel walk may CURVE over
 *  its cycle (deg; sign = direction, + toward the subject's left). ±120 over
 *  the stock ~4.6 s cycle is ≤ ~26°/s — the gentle guided curve of a walking
 *  track / figure-of-eight lobe. Beyond it a "walk" is really a pivot: the
 *  per-stance heading change outgrows what the stance leg can absorb (the
 *  planted foot would have to swivel), so sharper re-orientation belongs to
 *  buildTurnInPlace's step turn instead. */
const GAIT_TURN_MAX_DEG = 120;
/** The R ankle's rest offset from the root axis, m (rig-measured on the male
 *  runtime GLB at anatomic stance) — the pivot centre of a headed walk's
 *  initiation: the root translate t = p_R − R(heading)·p_R re-centres the
 *  entry yaw on the planted stance foot so it doesn't arc sideways. */
const GAIT_STANCE_FOOT_X_M = -0.083;
const GAIT_STANCE_FOOT_Z_M = -0.029;
// GAIT INITIATION lateral lead — HALVED from the original (0.012/−1.2/2.0/−0.8):
// the pre-step weight shift read as a distinct "lean to the right, THEN walk"
// beat. Softening the initiation makes the walk step off more directly; the
// IN-STRIDE weight transfer (the medio-lateral shuttle) is unchanged, so real
// gait sway is preserved — only the standing-start lead is quieter.
const GAIT_APA_SHIFT_M = 0.006; // authored pelvis shift toward the stance (R) foot, m (−X)
const GAIT_APA_LUMBAR_DEG = -0.6; // lumbar list over the stance foot (lateralTilt + = left)
const GAIT_APA_THORACIC_DEG = 1.0; // thoracic counter-list keeps the head centred
const GAIT_APA_NECK_DEG = -0.4; // levels the head against the authored S-curve's residual
const GAIT_APA_KNEE_DEG = 5; // future swing (L) knee unweights (unchanged — sagittal)
// REAL GAIT TERMINATION — a braking final step: the lead (R) foot accepts weight
// with a loading-response knee yield while the trailing (L) foot swings UP NEXT
// TO it (feet together), then the body levels out to quiet standing (arms
// settle, the spinal coordination fades as its sagittal drivers go to 0).
const GAIT_TERMINATION_STEP_MS = 250; // weight acceptance onto the lead foot
const GAIT_TERMINATION_SETTLE_MS = 450; // trailing foot steps up beside; level-out
const GAIT_TERMINATION_HOLD_MS = 200; // settle dwell at quiet standing
const GAIT_BRAKE_REACH_SCALE = 0.8; // the last step is SHORTER (terminal reach damped)
const GAIT_BRAKE_ARM_SCALE = 0.7; // …and the arm swing starts dying with it
// MEDIO-LATERAL SHUTTLE — the per-step weight transfer: the pelvis rides this
// many cm toward the planted foot each stance (crossing centre at the
// double-support transitions), derived at sample time from the measured feet
// (services/rootMotion deriveGaitLateralShuttle). Real free-gait pelvis ML
// excursion is ~±2-3 cm at comfortable speed [Perry & Burnfield].
const GAIT_SHUTTLE_CM = 2.5;
// Trunk counter-lean (deg at full shuttle) absorbing the shuttle so the head
// stays centred — rig-tuned against the head-steadiness gate (<2.5 cm lateral).
const GAIT_SHUTTLE_ABSORB_DEG = 2.4;

export function buildTravelWalk(
  opts: { speed?: number; headingDeg?: number; turnDeg?: number; asymmetry?: number | false } = {},
): ComposedMotion {
  const walk = MOVEMENT_TEMPLATES.find((t) => t.id === 'walk');
  if (!walk) throw new Error('walk template missing');
  const speed = opts.speed;
  // TRAVEL HEADING (roadmap 4.1): rotate the whole walk about the vertical axis
  // (0 = straight ahead +Z; + toward the subject's left, matching root yawDeg).
  // The body ORIENTS FIRST — the initiation keyframe carries the heading yaw, so
  // the entry slerp pivots the body toward the new line of travel before the
  // step-off — then every keyframe rides heading + its own pelvic yaw, and the
  // sampler/stage travel/shuttle derivations follow the same angle
  // (`ComposedMotion.headingDeg`). Heading 0 takes the EXACT legacy path —
  // byte-identical output (asserted in gaitHeading.test.ts).
  const headingDeg =
    typeof opts.headingDeg === 'number' && Number.isFinite(opts.headingDeg) ? opts.headingDeg : 0;
  // ARC WALK (roadmap 6.2): a gentle CONSTANT-RATE curve over the CYCLE portion
  // — the authored root yaw progresses linearly from the initiation heading to
  // heading + turnDeg across the 8 cycle keyframes (the braking step and the
  // settle HOLD the final heading), and the same progression is published as a
  // piecewise heading profile (`ComposedMotion.headingProfileMs`) so the
  // sampler/stage travel derivation advances along the heading AT EACH TIME
  // (an arc, +90 ≈ a quarter-circle to the subject's left) with the shuttle on
  // the instantaneous perpendicular. Clamped to the gentle-arc band (±120°:
  // ≤ ~26°/s at the stock ~4.6 s cycle — a guided curve, never a spin; sharper
  // re-orientation is buildTurnInPlace's job). turnDeg 0 takes the EXACT
  // straight/constant-heading path — byte-identical (gaitCurvedWalk.test.ts).
  const turnDegRaw =
    typeof opts.turnDeg === 'number' && Number.isFinite(opts.turnDeg) ? opts.turnDeg : 0;
  const turnDeg = Math.max(-GAIT_TURN_MAX_DEG, Math.min(GAIT_TURN_MAX_DEG, turnDegRaw));
  const hRad = (headingDeg * Math.PI) / 180;
  const hSin = Math.sin(hRad);
  const hCos = Math.cos(hRad);
  // Magnitude of the actual re-orientation (the entry slerp takes the short
  // way, so 270 turns 90; used only to pace the initiation pivot).
  const headingWrapped = Math.abs(headingDeg) % 360;
  const headingTurnMag = Math.min(headingWrapped, 360 - headingWrapped);
  // PIVOT ABOUT THE STANCE FOOT: the root yaw rotates about the ROOT AXIS,
  // which would arc the planted (R) initiation foot sideways through the
  // pivot — over-stretching its pinned leg and sliding the foot. Author the
  // compensating root translate t = p_R − R(H)·p_R (p_R = the R ankle's
  // rig-measured rest offset from the root axis) so the initiation rotation is
  // effectively centred ON the stance foot; carried through the whole walk
  // (the straight path is simply offset by t, and the feet plant along it).
  // Exact zeros at heading 0 — the un-headed walk is untouched.
  const pivotTx =
    GAIT_STANCE_FOOT_X_M - (GAIT_STANCE_FOOT_X_M * hCos + GAIT_STANCE_FOOT_Z_M * hSin);
  const pivotTz =
    GAIT_STANCE_FOOT_Z_M - (-GAIT_STANCE_FOOT_X_M * hSin + GAIT_STANCE_FOOT_Z_M * hCos);
  const base =
    speed != null && speed !== 1
      ? paceGait(templateToComposedMotion(walk), speed)
      : templateToComposedMotion(walk);
  // ONE GAIT CYCLE (8 phases), plus a real initiation ahead of it and a real
  // termination after it — the walk starts and stops like a person, not a
  // cross-fade into/out of mid-stride.
  const cycle: SequenceKeyframe[] = base.keyframes.map((kf) => ({
    ...kf,
    ...(kf.targets ? { targets: kf.targets.map((t) => ({ ...t })) } : {}),
  }));
  // STEP-OFF ENTRY: the first gait pose is a full stride (~30° hip / 40° knee,
  // the arm at its ±20° extreme); reaching it in one 200 ms phase whips the
  // limbs in at several times the steady cadence, so the entry keeps its own
  // longer duration (the cycle phases stay steady).
  cycle[0] = {
    ...cycle[0]!,
    durationMs: Math.max(cycle[0]!.durationMs ?? 0, GAIT_STEP_OFF_MS),
    // The initiation keyframe below authors a root shift; explicitly return the
    // root to centre here so the APA shift resolves into the derived shuttle
    // (root state persists forward until overridden). "Centre" for a headed
    // walk keeps the stance-foot pivot offset (exact [0,0,0] at heading 0).
    root: { translateM: [pivotTx, 0, pivotTz] },
  };
  // BRAKING CUE on the final cycle keyframe: the LAST step is shorter — the
  // terminal (R) reach and the arm swing are damped, so the body is already
  // decelerating as it enters the termination step.
  const lastCycle = cycle[cycle.length - 1]!;
  lastCycle.targets = lastCycle.targets?.map((t) => {
    if (t.joint === 'R_UpLeg' && t.motion === 'hipFlexion')
      return { ...t, targetDegrees: t.targetDegrees * GAIT_BRAKE_REACH_SCALE };
    if (t.motion === 'shoulderFlexion')
      return { ...t, targetDegrees: t.targetDegrees * GAIT_BRAKE_ARM_SCALE };
    return t;
  });
  // REAL GAIT INITIATION (APA): the walk enters on R stance — the L foot is the
  // first to leave the floor — so BEFORE any limb lifts, shift the pelvis over
  // the future stance (R) foot with a small lumbar list (thoracic counter-list
  // keeps the head centred) and unweight the future swing knee. The shift is
  // authored root-X; it hands over to the derived medio-lateral shuttle (which
  // rises toward the same R stance through the first half-cycle).
  const initiation: SequenceKeyframe = {
    // A non-zero heading RE-ORIENTS the body during this keyframe (the pivot
    // toward the new line of travel), so the APA lead lengthens with the turn
    // magnitude — a 90° pivot inside the stock 300 ms would whip. Heading 0
    // keeps the stock duration exactly.
    durationMs: Math.max(GAIT_INITIATION_MS, Math.round(headingTurnMag * GAIT_HEADING_TURN_MS_PER_DEG)),
    targets: [
      { joint: 'Spine_Lower', motion: 'lateralTilt', targetDegrees: GAIT_APA_LUMBAR_DEG },
      { joint: 'Spine_Upper', motion: 'lateralTilt', targetDegrees: GAIT_APA_THORACIC_DEG },
      { joint: 'Neck', motion: 'lateralTilt', targetDegrees: GAIT_APA_NECK_DEG },
      { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: GAIT_APA_KNEE_DEG },
    ],
    // Toward the stance (R) foot — in the HEADING frame (heading 0: exactly the
    // legacy world −X) — plus the stance-foot pivot offset so the initiation
    // yaw rotates about the planted foot, not the root axis. The heading yaw
    // itself is folded onto every keyframe after the coordination pass below.
    root: {
      translateM: [
        -GAIT_APA_SHIFT_M * hCos + pivotTx,
        0,
        GAIT_APA_SHIFT_M * hSin + pivotTz,
      ],
    },
  };
  // REAL GAIT TERMINATION: the R foot (which reached forward at the last cycle
  // keyframe) accepts weight with a loading-response knee yield while the L
  // releases its push-off into a short swing…
  const terminationStep: SequenceKeyframe = {
    durationMs: GAIT_TERMINATION_STEP_MS,
    targets: [
      { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 12 },
      { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 14 },
      { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: 3 },
      { joint: 'R_Toes', motion: 'toeFlexion', targetDegrees: 0 },
      { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 15 },
      { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 30 },
      { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
      { joint: 'L_Toes', motion: 'toeFlexion', targetDegrees: 5 },
      { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 6 },
      { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: -6 },
      { joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: 18 },
      { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 18 },
    ],
  };
  // …then the L steps up NEXT TO the R (feet together) and the body levels out
  // to quiet standing. Every sagittal driver goes to 0, so the spinal gait
  // coordination (counter-rotation, sway, pelvic yaw) fades out with it; the
  // relaxed arm carriage (slight elbow bend, adducted hang) remains.
  const terminationSettle: SequenceKeyframe = {
    durationMs: GAIT_TERMINATION_SETTLE_MS,
    holdMs: GAIT_TERMINATION_HOLD_MS,
    targets: [
      { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
      { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
      { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
      { joint: 'R_Toes', motion: 'toeFlexion', targetDegrees: 0 },
      { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
      { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
      { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
      { joint: 'L_Toes', motion: 'toeFlexion', targetDegrees: 0 },
      { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 0 },
      { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 0 },
      { joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: 8 },
      { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 8 },
      // Explicit zeros: unmentioned joints CARRY FORWARD across keyframes, so
      // without these the quiet stand would keep the braking step's residual
      // trunk rotation / lean / neck counters frozen on the body.
      { joint: 'Spine_Lower', motion: 'lateralTilt', targetDegrees: 0 },
      { joint: 'Spine_Upper', motion: 'lateralTilt', targetDegrees: 0 },
      { joint: 'Spine_Lower', motion: 'rotation', targetDegrees: 0 },
      { joint: 'Spine_Upper', motion: 'rotation', targetDegrees: 0 },
      { joint: 'Neck', motion: 'rotation', targetDegrees: 0 },
      { joint: 'Neck', motion: 'lateralTilt', targetDegrees: 0 },
    ],
  };
  const kfs: SequenceKeyframe[] = [initiation, ...cycle, terminationStep, terminationSettle];

  // STANCE SCHEDULE (authored ms): R bears through the initiation + the first
  // four cycle phases, L through the second four; the termination adds a final
  // R stance (the braking step) and, once the L lands beside it, a terminal
  // double support. The same windows drive the foot-plant contacts AND the
  // planned shuttle phase the trunk absorb counter-leans against.
  const dur = (k: SequenceKeyframe): number => (k.durationMs ?? 0) + (k.holdMs ?? 0);
  const endOf = (idx: number): number => kfs.slice(0, idx + 1).reduce((s, k) => s + dur(k), 0);
  const rStanceEnd = endOf(4); // initiation + R initial-contact … R terminal-stance
  const lStanceEnd = endOf(8); // L initial-contact … L terminal-stance
  const rLandsAt = endOf(9); // braking-step arrival: R has accepted weight
  const lLandsAt = endOf(9) + (terminationSettle.durationMs ?? 0); // L arrives beside R
  const total = endOf(kfs.length - 1);
  // The terminal plant windows begin at each foot's LANDING keyframe (weight
  // acceptance / feet-together) — a window opening while the foot is still
  // airborne would lazily capture an in-flight position and pin the foot there.
  const contacts: StanceContact[] = [
    { foot: 'R_Foot', fromMs: 0, toMs: rStanceEnd },
    { foot: 'L_Foot', fromMs: rStanceEnd, toMs: lStanceEnd },
    { foot: 'R_Foot', fromMs: rLandsAt, toMs: total },
    { foot: 'L_Foot', fromMs: lLandsAt, toMs: total },
  ];
  // Planned shuttle phase (+1 = toward subject-left/+X): toward the R foot (−X)
  // through R stance windows, toward the L (+X) through L stance — a half-sine
  // per window, zero at the double-support boundaries. The SAME schedule is
  // passed to the sample-time derivations (`gaitStanceWindowsMs`), so the
  // authored trunk absorb, the ridden root shuttle AND the foot-driven travel
  // all follow one stance truth. The final window ends where the trailing L
  // foot LANDS beside the R — the terminal double support and settle dwell
  // hold the pelvis centred.
  // Only the TERMINAL window travel-locks the forward derivation: the cycle
  // windows stay on the measured-feet heuristic (its entry-reach cancellation
  // is what keeps the pinned stance foot reachable), but through the braking
  // step the heuristic tracks the trailing push-off foot and freezes the
  // advance, so the schedule keeps it on the weight-accepting R.
  const windows: { t0: number; t1: number; dir: number; foot: string; travelLock?: boolean }[] = [
    { t0: 0, t1: rStanceEnd, dir: -1, foot: 'R_Foot' },
    { t0: rStanceEnd, t1: lStanceEnd, dir: 1, foot: 'L_Foot' },
    { t0: lStanceEnd, t1: lLandsAt, dir: -1, foot: 'R_Foot', travelLock: true },
  ];
  const shuttlePhaseAt = (tMs: number): number => {
    for (const w of windows) {
      if (tMs < w.t0 || tMs > w.t1 || w.t1 <= w.t0) continue;
      return w.dir * Math.sin((Math.PI * (tMs - w.t0)) / (w.t1 - w.t0));
    }
    return 0;
  };

  // Natural trunk + limb coordination (counter-rotation, sway, pelvic rotation, and the
  // non-sagittal limb motion). The pelvic yaw stays the default ~±2° — the same amount as
  // the in-place walk — even though the feet are foot-planted below: a bigger travelling
  // yaw wags the whole body too much (a full ~±4° reads clean in place but not in travel).
  // The foot-plant contacts still hold each stance foot fixed so nothing slides. The
  // shuttle absorb adds the trunk counter-lean that keeps the head centred over the
  // shuttling pelvis.
  // HEALTHY-ASYMMETRY SIGNATURE (roadmap 5.3): the seed-derived 2–4% L/R
  // arm-swing amplitude difference of a real healthy walker — amplitude-only
  // (durations and the stance schedule above stay byte-exact; see
  // healthySignature.ts for the documented timing rejection). Applied BEFORE
  // the coordination pass; the sum-preserving split keeps the reciprocal
  // arm-swing difference — the thoracic-rotation driver — exactly intact.
  // `asymmetry: false` = the clean, textbook-symmetric reference gait.
  const signed =
    opts.asymmetry === false
      ? { ...base, keyframes: kfs }
      : healthySignature({ ...base, keyframes: kfs }, opts.asymmetry);
  const coordinated = spinalGaitCoordination(signed, {
    shuttleAbsorb: { phaseAt: shuttlePhaseAt, deg: GAIT_SHUTTLE_ABSORB_DEG },
  });
  // TRAVEL HEADING FOLD: add the heading yaw to EVERY keyframe's root orient —
  // AFTER the coordination pass, whose per-keyframe pelvic rotation writes its
  // own yawDeg (folding before it would let the ±2° pelvis yaw overwrite the
  // heading). The initiation (pelvic yaw 0) lands at exactly headingDeg, so the
  // entry slerp IS the pre-walk pivot; the cycle then carries heading + pelvic
  // yaw. Explicit on every keyframe — carry-forward is never relied on.
  // Heading 0 skips the fold entirely (byte-identical keyframes).
  //
  // ARC WALK (turnDeg): the folded yaw PROGRESSES across the cycle instead of
  // holding constant — each keyframe carries the heading at its own ARRIVAL
  // time (linear in cumulative authored ms across the cycle keyframes: a
  // constant turn rate), with the braking step and settle holding the exit
  // heading. The trajectory's inter-knot slerp then approximates the same
  // linear progression the published heading profile describes, so the derived
  // travel and the authored body yaw stay collinear (same wave-4 contract,
  // per-time). turnDeg 0 reduces headingAtKf to the constant headingDeg
  // exactly (0·u adds nothing), keeping heading-only walks byte-identical.
  const cycleStartMs = endOf(0);
  const cycleEndMs = endOf(8);
  const headingAtKf = (k: number): number => {
    if (turnDeg === 0) return headingDeg;
    const u = Math.min(1, Math.max(0, (endOf(k) - cycleStartMs) / (cycleEndMs - cycleStartMs)));
    return headingDeg + turnDeg * u;
  };
  const headed =
    headingDeg === 0 && turnDeg === 0
      ? coordinated.keyframes
      : coordinated.keyframes.map((kf, k) => ({
          ...kf,
          root: {
            ...(kf.root ?? {}),
            orient: { ...(kf.root?.orient ?? {}), yawDeg: (kf.root?.orient?.yawDeg ?? 0) + headingAtKf(k) },
          },
        }));
  return {
    name: 'walk-forward',
    startFrom: 'current',
    stance: 'planted',
    // PERSISTENT HEADING (SEAM-1): the walk's yaw plan is authored relative to
    // its entry heading (`headingDeg`), so when it starts from the current pose
    // with the live root threaded, resolution rebases the whole plan onto the
    // body's actual facing — a walk chained after a turn walks off the way the
    // body faces instead of whipping back to the authored world yaw.
    inheritHeading: true,
    ...(coordinated.modifiers ? { modifiers: coordinated.modifiers } : {}),
    keyframes: headed,
    footDrivenTravel: true,
    // The heading the derived travel rides along (and the shuttle stays
    // perpendicular to) — omitted at 0 so the straight walk is byte-identical.
    ...(headingDeg !== 0 ? { headingDeg } : {}),
    // ARC WALK: the per-time heading curve — flat at the entry heading through
    // the initiation, linear (constant turn rate) across the cycle, holding
    // heading + turnDeg through the braking step and settle. EXACTLY the
    // per-keyframe yaw progression folded above, so the sampler/stage
    // derivations (which ride this profile) and the authored body orientation
    // can never diverge. Omitted at turnDeg 0 (byte-identical).
    ...(turnDeg !== 0
      ? {
          headingProfileMs: [
            { tMs: 0, headingDeg },
            { tMs: cycleStartMs, headingDeg },
            { tMs: cycleEndMs, headingDeg: headingDeg + turnDeg },
            { tMs: total, headingDeg: headingDeg + turnDeg },
          ],
        }
      : {}),
    // The walk now authors its own initiation/termination ramps, so the
    // trajectory ends are REAL stops (ease from standstill, brake to quiet
    // standing) instead of the steady-cadence fly-throughs.
    settleEnds: true,
    contacts,
    // Per-step weight transfer: the pelvis rides toward the planted foot,
    // phase-locked to the SAME planned stance schedule the trunk absorb above
    // was authored against (and the travel derivation follows).
    lateralShuttleCm: GAIT_SHUTTLE_CM,
    gaitStanceWindowsMs: windows.map((w) => ({
      foot: w.foot,
      fromMs: w.t0,
      toMs: w.t1,
      ...(w.travelLock ? { travelLock: true } : {}),
    })),
    // Calibrate the COM vertical: the raw floor-pin vault of the travelling walk is
    // ~13 cm — far more than real free gait (~5 cm) — and it drops abruptly into
    // double support. The vertical calibration calms the excursion AND (in the
    // sampler) smooths the sharp valley into a glide; the foot-plant contacts below
    // re-pin the stance foot after, so the feet stay grounded while the pelvis arc
    // is reshaped. (The in-place walk gets the same target via gaitBounce.)
    verticalCalibrationCm: NORMAL_GAIT_VERTICAL_CM,
  };
}

/**
 * A FIGURE-OF-EIGHT walk as a SEQUENCE of two arc walks (roadmap 6.2).
 *
 * CONTRACT: play the segments IN ORDER, threading cross-motion continuity the
 * way any chain does (`sampleMotionChain` / the stage's composed playback —
 * each later segment `startFrom:'current'` with the previous end pose + root).
 * Segment 1 curves `+lobe` (toward the subject's left); segment 2 ENTERS at
 * segment 1's exit heading (`headingDeg: lobe` — the body is already facing
 * it, so its initiation pivot is a no-op at the seam) and REVERSES the turn
 * (`turnDeg: −lobe`), ending back at heading 0. Each segment is a complete,
 * self-grounding walk (own APA initiation, braking step and settle), so the
 * crossover between lobes is a genuine quiet-standing weight transfer — the
 * clinical figure-of-eight's midpoint — not a mid-stride hairpin.
 *
 * WHY A SEQUENCE, NOT ONE MOTION: both segments' 22 keyframes would fit
 * MAX_KEYFRAMES (48), but a single ComposedMotion carries ONE heading profile,
 * ONE stance-window schedule and ONE initiation/termination pair — fusing two
 * opposite lobes would mean authoring a non-monotonic profile plus a doubled
 * schedule for no gain over the composition primitives the engine already
 * gates (movementChain). And WHY ±120, not the half-circle ±180: the
 * gentle-arc clamp (see GAIT_TURN_MAX_DEG) caps a single cycle's curve at the
 * rate a stance leg can absorb, so the figure-of-eight's lobes are the maximal
 * gentle arcs — the walked path still crosses into two opposite loops, just
 * with straighter entries/exits than a compass-drawn 8.
 */
export type FigureEightWalk = [ComposedMotion, ComposedMotion];

/** Build the two-segment figure-of-eight walk (see {@link FigureEightWalk} for
 *  the playback contract). `lobeDeg` (default the maximal gentle arc, 120)
 *  sets each lobe's curve magnitude; `speed`/`asymmetry` pass to both
 *  segments. */
export function buildFigureEightWalk(
  opts: { speed?: number; asymmetry?: number | false; lobeDeg?: number } = {},
): FigureEightWalk {
  const lobeRaw =
    typeof opts.lobeDeg === 'number' && Number.isFinite(opts.lobeDeg)
      ? Math.abs(opts.lobeDeg)
      : GAIT_TURN_MAX_DEG;
  const lobe = Math.max(15, Math.min(GAIT_TURN_MAX_DEG, lobeRaw));
  const base: { speed?: number; asymmetry?: number | false } = {
    ...(opts.speed != null ? { speed: opts.speed } : {}),
    ...(opts.asymmetry !== undefined ? { asymmetry: opts.asymmetry } : {}),
  };
  return [
    { ...buildTravelWalk({ ...base, turnDeg: lobe }), name: 'figure-eight-a' },
    { ...buildTravelWalk({ ...base, headingDeg: lobe, turnDeg: -lobe }), name: 'figure-eight-b' },
  ];
}

// ─── Turn-in-place (step turn) — roadmap 4.1 ─────────────────────────────────
// The engine's first turning vocabulary: a STEP TURN — the clinically normal
// pattern (multiple small steps around the vertical axis, weight transferred
// each step), NOT a one-shot spin. Authored on the root `yawDeg` primitive per
// keyframe; planted stance (the floor-pin grounds every frame); deterministic.

const TURN_LIFT_MS = 380; // stepping foot up while the body pivots on the stance foot
const TURN_PLACE_MS = 320; // stepping foot down + weight transfer
const TURN_SETTLE_MS = 420; // level out to quiet standing at the new heading
const TURN_SETTLE_HOLD_MS = 240; // settle dwell
const TURN_STEP_HIP_DEG = 14; // stepping hip flexion — a small clearance step
const TURN_STEP_KNEE_DEG = 32; // stepping knee flexion
const TURN_STEP_ANKLE_DEG = 4; // slight dorsiflexion for swing clearance
const TURN_STANCE_KNEE_DEG = 7; // the stance knee softens while pivoting (never a stiff peg)
const TURN_ARM_SWING_DEG = 6; // subtle reciprocal arm swing (contralateral arm forward)
const TURN_ELBOW_DEG = 14; // relaxed elbow carry through the turn
const TURN_SETTLE_ELBOW_DEG = 8; // the resting elbow bend at quiet standing (mirrors the walk settle)
const TURN_TRUNK_ROT_DEG = 5; // thorax rotates INTO the turn ahead of the pelvis
const TURN_WEIGHT_SHIFT_M = 0.03; // pelvis shift over the stance foot while the other steps
const TURN_LIFT_YAW_FRACTION = 0.6; // portion of each step's yaw taken while the foot is up

/**
 * Build a TURN-IN-PLACE — a step turn about the vertical axis (roadmap 4.1; the
 * audit's "the engine cannot turn" F). `degrees` is the total heading change:
 * default 180 ("turn around"), sign = direction (+ = toward the subject's LEFT,
 * matching root `yawDeg`), clamped to ±360; |degrees| < 1 falls back to the
 * default (a "turn" that doesn't turn isn't one). The turn is 2-4 SMALL STEPS —
 * the clinically normal step-turn strategy, never a spin: each step LIFTS one
 * foot (hip/knee/ankle clearance flexion), pivots the root yaw a portion of the
 * total on the softened stance leg (with the pelvis shifted over it — the
 * weight transfer), PLACES the foot and re-centres, alternating feet — the
 * outside foot leads (turning left steps L first). The trunk rotates a few
 * degrees into the turn ahead of the pelvis (gaze counters ride the standard
 * stabilizeGaze path on resolve), the arms carry a subtle reciprocal swing, and
 * a final settle keyframe levels everything to quiet standing facing the new
 * heading. Pivot feet DO rotate about their own contact (as in life); the
 * planted floor-pin keeps every frame grounded. Pure + deterministic —
 * rig-gated in turnInPlace.test.ts.
 */
export function buildTurnInPlace(opts: { degrees?: number } = {}): ComposedMotion {
  const raw = typeof opts.degrees === 'number' && Number.isFinite(opts.degrees) ? opts.degrees : 180;
  const total = Math.abs(raw) < 1 ? 180 : Math.max(-360, Math.min(360, raw));
  const dir = total > 0 ? 1 : -1; // +1 = toward subject-left, −1 = toward subject-right
  // 2-4 steps of ≤ ~90° each — the step-turn pattern.
  const nSteps = Math.min(4, Math.max(2, Math.ceil(Math.abs(total) / 60)));
  const stepDeg = total / nSteps;
  const keyframes: SequenceKeyframe[] = [];
  for (let k = 0; k < nSteps; k += 1) {
    // The OUTSIDE foot leads and the feet alternate: turning left steps L, R, L…
    const S = (k % 2 === 0) === (dir > 0) ? 'L' : 'R'; // stepping side
    const O = S === 'L' ? 'R' : 'L'; // stance side
    const yaw0 = stepDeg * k;
    const yawLift = yaw0 + TURN_LIFT_YAW_FRACTION * stepDeg; // pivot most of the step while the foot is up
    const yaw1 = stepDeg * (k + 1);
    // Weight shift over the STANCE foot, in the CURRENT heading frame (the
    // body-frame lateral rotated by the yaw the keyframe arrives at).
    const bx = (O === 'R' ? -1 : 1) * TURN_WEIGHT_SHIFT_M; // body-frame: +X = subject-left
    const c = Math.cos((yawLift * Math.PI) / 180);
    const s = Math.sin((yawLift * Math.PI) / 180);
    keyframes.push({
      // LIFT: the stepping foot rises for clearance while the body pivots on
      // the softened stance leg, pelvis shifted over it; contralateral arm
      // swings gently forward; thorax leads the turn.
      durationMs: TURN_LIFT_MS,
      targets: [
        { joint: `${S}_UpLeg`, motion: 'hipFlexion', targetDegrees: TURN_STEP_HIP_DEG },
        { joint: `${S}_Leg`, motion: 'kneeFlexion', targetDegrees: TURN_STEP_KNEE_DEG },
        { joint: `${S}_Foot`, motion: 'ankleFlexion', targetDegrees: TURN_STEP_ANKLE_DEG },
        { joint: `${O}_UpLeg`, motion: 'hipFlexion', targetDegrees: 0 },
        { joint: `${O}_Leg`, motion: 'kneeFlexion', targetDegrees: TURN_STANCE_KNEE_DEG },
        { joint: `${O}_Foot`, motion: 'ankleFlexion', targetDegrees: 0 },
        { joint: `${O}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: TURN_ARM_SWING_DEG },
        { joint: `${S}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: -TURN_ARM_SWING_DEG },
        { joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: TURN_ELBOW_DEG },
        { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: TURN_ELBOW_DEG },
        // Trunk rotation sign: + = toward-R (romRegistry), so INTO a left (+yaw)
        // turn is negative. The lumbar follows the thorax at half.
        { joint: 'Spine_Upper', motion: 'rotation', targetDegrees: -dir * TURN_TRUNK_ROT_DEG },
        { joint: 'Spine_Lower', motion: 'rotation', targetDegrees: -dir * TURN_TRUNK_ROT_DEG * 0.5 },
      ],
      root: { orient: { yawDeg: yawLift }, translateM: [bx * c, 0, -bx * s] },
    });
    keyframes.push({
      // PLACE: the foot lands at the new bearing, the remaining yaw completes
      // through the transfer, and the weight re-centres between the feet.
      durationMs: TURN_PLACE_MS,
      targets: [
        { joint: `${S}_UpLeg`, motion: 'hipFlexion', targetDegrees: 0 },
        { joint: `${S}_Leg`, motion: 'kneeFlexion', targetDegrees: 0 },
        { joint: `${S}_Foot`, motion: 'ankleFlexion', targetDegrees: 0 },
        { joint: `${O}_Leg`, motion: 'kneeFlexion', targetDegrees: 0 },
        { joint: `${O}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: 0 },
        { joint: `${S}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: 0 },
      ],
      root: { orient: { yawDeg: yaw1 }, translateM: [0, 0, 0] },
    });
  }
  keyframes.push({
    // SETTLE: quiet standing at the new heading — every sagittal driver and the
    // trunk rotation return to zero (carry-forward would otherwise freeze the
    // last step's twist on the body); the relaxed elbow carry remains.
    durationMs: TURN_SETTLE_MS,
    holdMs: TURN_SETTLE_HOLD_MS,
    targets: [
      { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
      { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
      { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
      { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
      { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
      { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
      { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 0 },
      { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 0 },
      { joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: TURN_SETTLE_ELBOW_DEG },
      { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: TURN_SETTLE_ELBOW_DEG },
      { joint: 'Spine_Upper', motion: 'rotation', targetDegrees: 0 },
      { joint: 'Spine_Lower', motion: 'rotation', targetDegrees: 0 },
    ],
    root: { orient: { yawDeg: total }, translateM: [0, 0, 0] },
  });
  return {
    name: 'turn-in-place',
    startFrom: 'current',
    stance: 'planted',
    // Persistent heading (SEAM-1): the step turn's yaw keys are authored from
    // an assumed entry of 0, so a turn chained after another motion (turn →
    // turn, walk → turn) carries the LIVE facing forward — 180 then 180 again
    // goes 0→180→360, not 0→180, snap, 0→180.
    inheritHeading: true,
    keyframes,
  };
}

/**
 * Build a real COUNTERMOVEMENT VERTICAL JUMP — the physics the old "jump"
 * lacked (it was a quick squat that rose and never landed). Full ballistic
 * sequence with a genuine airborne peak and a landing absorption:
 *   1. LOAD — countermovement dip (hip/knee flex, ankle dorsiflex, arms swing
 *      back), COM drops. Planted.
 *   2. PROPULSION — explosive triple extension (hip/knee to 0, ankle
 *      plantarflexes into a toe push-off) + arms drive UP. Ballistic, planted
 *      (feet still driving the ground).
 *   3. APEX — the body leaves the floor: root travels UP to the peak with a
 *      brief hang time, legs tuck for clearance. FLOATING (no floor pin — the
 *      whole body, feet included, rises). Ballistic.
 *   4. DESCENT — the fall: root comes back down, legs extend to reach for the
 *      ground. Floating.
 *   5. LANDING — feet contact and ABSORB (hip/knee/ankle flex to cushion), COM
 *      dips. Planted (the pin re-grounds the feet).
 *   6. RECOVERY — extend back to a quiet stand. Planted.
 * Non-looping, `startFrom:'neutral'` (jump from standing). `heightM` sets the
 * apex COM rise (ROM-clamped joints, honest vertical via root translate).
 */

/** Standard gravity (m/s²) — the one physical constant the kinematic realism
 *  layer uses. It shapes timing/arcs; it is NOT a force integrator. */
export const GRAVITY_M_S2 = 9.81;

/**
 * PHYSICAL AIRTIME for a projectile that rises to `apexM` and falls back — the
 * total time feet-off to feet-on, `t = 2·√(2h/g)`. Used to set a ballistic
 * motion's floating-phase durations so airtime SCALES with height (a taller jump
 * hangs longer) and, paired with the trajectory's gravity parabola, the vertical
 * acceleration equals real g. Kinematic: it derives a duration from a height, no
 * forces. Returns ms.
 */
export function ballisticFlightMs(apexM: number): number {
  const h = Math.max(0.02, Number.isFinite(apexM) ? apexM : 0.4);
  return Math.round(2 * Math.sqrt((2 * h) / GRAVITY_M_S2) * 1000);
}

export function buildJump(opts: { heightM?: number; reps?: number } = {}): ComposedMotion {
  const apexM = Math.max(0.1, Math.min(0.7, opts.heightM ?? 0.4));
  // Airborne interval (propulsion push-off → landing contact) is a real projectile:
  // its duration is set from the apex height so airtime scales with height, and the
  // trajectory shapes the rise/fall as a constant-g parabola (no authored hang).
  // Symmetric rise:fall so the apex POSE sits at the vertical peak.
  const flightMs = ballisticFlightMs(apexM);
  const legs = (hip: number, knee: number, ankle: number) => [
    { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: hip },
    { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: hip },
    { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: knee },
    { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: knee },
    { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: ankle },
    { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: ankle },
  ];
  const arms = (sh: number) => [
    { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: sh },
    { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: sh },
  ];
  const toes = (deg: number) => [
    { joint: 'L_Toes', motion: 'toeFlexion', targetDegrees: deg },
    { joint: 'R_Toes', motion: 'toeFlexion', targetDegrees: deg },
  ];
  const trunk = (deg: number) => [{ joint: 'Spine_Lower', motion: 'flexion', targetDegrees: deg }];
  // One jump = 5 driving phases (load → propulsion → apex → descent → landing);
  // a fresh factory per keyframe so repeated reps never share a mutable object.
  const load = (): SequenceKeyframe => ({
    durationMs: 380, holdMs: 90, stance: 'planted',
    targets: [...legs(40, 60, 15), ...arms(-25), ...trunk(15)],
  });
  // TAKEOFF CONTINUITY: propulsion is planted (the feet drive the ground), so
  // its rendered pelvis is floor-pinned — and the toe push-off (ankle −25°) heel-
  // raises the body ~6 cm above standing. The apex that follows is FLOATING, so
  // without this its authored `travel.up` lerp would start from 0 and the pelvis
  // would DROP ~6 cm at the planted→floating pin toggle (a visible takeoff hitch).
  // Seeding the propulsion knot with that ~6 cm up makes the floating rise start
  // where the pin left the body — a continuous launch. (Planted rendering is
  // unaffected: the pin cancels this on the propulsion frames themselves; it only
  // seeds the interpolation INTO the floating apex.)
  const propulsion = (): SequenceKeyframe => ({
    durationMs: 160, velocityClass: 'ballistic', stance: 'planted',
    // ABSOLUTE pin-height seed → raw root (raw translate = absolute position;
    // `travel` sugar is a DELTA step per AI-SUGAR-01 and no longer fits here).
    root: { translateM: [0, 0.06, 0] },
    // TOE ROCKER: the final push before takeoff rolls over the MTP joints (heels
    // up, toe pads driving the ground) — MTP extension ~30°, not a rigid flat foot.
    targets: [...legs(0, 0, -25), ...toes(30), ...arms(150), ...trunk(0)],
  });
  // No authored hold at the apex — the gravity parabola's near-zero vertical
  // velocity near the top IS the hang. Rise = flight/2 (propulsion→apex) so the
  // apex pose lands at the vertical peak; the fall (apex→descent→landing) takes
  // the other half. `descent`'s travel.up stays below apexM so the apex remains the
  // peak the trajectory reshapes toward.
  const apex = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.5), velocityClass: 'ballistic', stance: 'floating',
    root: { translateM: [0, apexM, 0] }, // ABSOLUTE apex height (raw root)
    // Toes reset to neutral in flight (the push-off MTP extension releases at toe-off).
    targets: [...legs(5, 25, 0), ...toes(0), ...arms(150)],
  });
  const descent = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.3), velocityClass: 'ballistic', stance: 'floating',
    root: { translateM: [0, apexM * 0.5, 0] }, // ABSOLUTE mid-fall height (raw root)
    targets: [...legs(3, 15, -5), ...arms(45)], // legs reaching DOWN toward contact
  });
  // TOUCHDOWN is the contact instant: legs NEAR-EXTENDED so the feet reach the floor
  // at root Y≈0, where the ballistic parabola lands the body. If the contact pose
  // were the deep absorption crouch (knees bent → feet pulled UP), the floor-pin
  // would have to yank the body down ~17 cm to ground it on contact — a hard snap.
  // Landing extended, THEN absorbing (below) lets the pin lower the body SMOOTHLY as
  // the knees bend, which is also the correct landing mechanics (reach → absorb).
  const touchdown = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.2), velocityClass: 'ballistic', stance: 'planted',
    root: { translateM: [0, 0, 0] }, // ABSOLUTE ground height (raw root)
    targets: [...legs(10, 18, 0), ...arms(30)],
  });
  const absorb = (): SequenceKeyframe => ({
    durationMs: 180, holdMs: 70, velocityClass: 'functional', stance: 'planted',
    root: { translateM: [0, 0, 0] }, // ABSOLUTE ground height (raw root)
    targets: [...legs(45, 65, 15), ...arms(20), ...trunk(10)],
  });
  const recovery = (): SequenceKeyframe => ({
    durationMs: 340, stance: 'planted',
    targets: [...legs(0, 0, 0), ...arms(0), ...trunk(0)],
  });

  // REPS via the playback-time `reps` field — the 7-keyframe cycle replays N
  // times at trajectory time, so the plan stays tiny regardless of N (no
  // keyframe duplication, no MAX_KEYFRAMES ceiling). Clamped to a sane set size.
  const reps = Math.max(1, Math.min(50, Math.round(opts.reps ?? 1)));

  return {
    name: reps > 1 ? `vertical jump ×${reps}` : 'vertical jump',
    startFrom: 'neutral',
    stance: 'planted',
    ...(reps > 1 ? { reps } : {}),
    keyframes: [load(), propulsion(), apex(), descent(), touchdown(), absorb(), recovery()],
  };
}

// ─── The RUN cycle (shared by the in-place buildRun and buildTravelRun) ──────
// RUN GROUNDING PARITY (roadmap 4.3): each landing gets a real TOUCHDOWN →
// ABSORPTION → recoil-into-DRIVE sequence, so the run absorbs its own impacts
// instead of landing pre-posed. One STEP of the cycle is four keyframes:
//   touchdown — the CONTACT instant: the landing leg reaches near-extended,
//               foot down in front (the tail half of the ballistic descent);
//   absorb    — the loading response AND midstance: the landing knee yields an
//               extra ~RUN_ABSORB_EXTRA_KNEE_DEG (+ hip yield) UNDER LOAD right
//               after contact, the shank rides over the planted foot — then
//               recoils…
//   push      — …into TOE-OFF: the thigh has swept BEHIND the body (hip
//               extension), the knee re-extends out of the yield and the ankle
//               drives into plantarflexion. This keyframe closes the stance
//               window, so it must be the pose the foot actually leaves the
//               ground in.
//   flight    — both feet airborne; the trajectory shapes root-Y as a
//               constant-g parabola between the flanking planted knots.
//
// WHY THE THIRD KEYFRAME IS TOE-OFF AND NOT A "STANCE DRIVE". The travel
// derivation measures the stance foot's body-space sweep across the stance
// WINDOW and advances the root to cancel it, so — once the flight gap coasts
// ballistically — the run's speed is exactly (stance sweep)/(ground contact
// time). Nothing else enters: cadence cancels out. This keyframe used to hold
// the landing leg at hip +14°/knee 38° — still flexed, still under the body —
// and the hip extension to −18° appeared only in the FLIGHT keyframe, i.e.
// AFTER the window had closed. The whole propulsive half of stance was
// therefore invisible to the derivation: a ~16° measured hip sweep instead of
// ~50°, which is why the run travelled at 1.1 m/s — below the engine's own
// walk. The sweep must live inside the window, so toe-off must be a knot.

// ── The run's VERTICAL, and why these numbers are one system ─────────────────
// WHO OWNS ROOT-Y, rig-verified by moving a knot to +30 cm and re-measuring:
//   • PLANTED frames — the GROUNDING SOLVE owns them absolutely. The authored
//     knot is inert: at speed 1 the toe-off knot rendered at −4.6 cm whether it
//     was authored at +0.4 cm or +30 cm.
//   • FLOATING frames — the authored knot owns them, shaped into a constant-g
//     parabola by motionTrajectory's `ballistic()`.
// The parabola is ENDPOINT-PRESERVING between the authored Y of the flanking
// PLANTED knots. So those two knots do nothing for the planted frames and
// everything for the flight arc: if they disagree with what the grounding solve
// actually produces, the body steps vertically at every take-off and landing
// (measured: a 7.6 cm single-frame jump at 120 Hz). They are therefore authored
// AT the solved heights — rig-measured, which is what makes them constants
// rather than choices.
//
// The knots over one step are: touchdown → (midstance trough) → toe-off →
// (flight apex) → touchdown. Toe-off sits ~2.6 cm ABOVE touchdown (the body
// leaves the ground taller than it lands), so the arc is ASYMMETRIC and its two
// halves get different durations — see runStepTiming.
//
// This replaced a single RUN_RISE_M = 0.12 m apex paired with a touchdown knot
// 6.8 cm below it. That pairing was doubly wrong: 12 cm is ~7× a runner's
// ballistic COM rise, and an 8.4 cm net drop across flight makes the descent
// alone take 144 ms — so the airborne interval could not be brought under
// ~200 ms at any speed, which is what pinned the cadence at 97 spm.
//
// KNOWN LIMIT: the solved heights drift with the speed request (the amplitude
// scaling deepens the stance geometry), so these constants close the seam at
// speed 1 and leave a residual step at the extremes. The real fix is to anchor
// the arc's endpoints to the solve at sample time instead of hand-measuring
// them — the same latent defect buildJump and buildSingleLegHop carry.

/** Rig-measured COM height (m, relative to anatomic standing) at TOE-OFF and at
 *  TOUCHDOWN under the grounding solve, speed 1 — the flight arc's endpoints.
 *  See the block comment: these are measurements, not preferences. */
const RUN_TOEOFF_Y_M = 0.005;
const RUN_TOUCHDOWN_Y_M = -0.037;
/** MIDSTANCE trough (m, relative to standing) — the knee-yield low point.
 *  Running COM oscillation is ~6-10 cm peak-to-peak and this is the bulk of it
 *  (runParity gates the MEASURED grounded arc, which the solve owns). */
const RUN_MIDSTANCE_Y_M = -0.063;
/** Ballistic COM rise above TOE-OFF during flight (m, at speed 1). A runner's
 *  COM rises ~1.5-3 cm above toe-off in flight — the flight looks long because
 *  the LEGS travel, not because the body goes up. Scales with the speed factor:
 *  a faster run bounces higher and floats longer. */
const RUN_BALLISTIC_RISE_M = 0.018;
/** Ground contact time (ms, both stance keyframes together, at speed 1).
 *  Shortens as 1/f with pace — the single biggest lever on the run's speed,
 *  which is (stance sweep)/(ground contact time) once flight coasts. */
const RUN_GCT_MS = 200;
/** MIDSTANCE sagittal base (deg, speed-1) — the value the loading-response
 *  yield is authored on top of (see RUN_ABSORB_EXTRA_*). */
const RUN_STANCE_HIP_DEG = 12;
const RUN_STANCE_KNEE_DEG = 38;
/** TOE-OFF sagittal pose (deg, speed-1). The thigh trails BEHIND the body — a
 *  running toe-off sits ~15-25° into hip extension [Novacheck, running gait] —
 *  and the knee has re-extended out of the absorption yield to ~20-25°, from
 *  where it folds up into the flight recovery. Together with the touchdown hip
 *  these two numbers ARE the run's step length (see the block comment above):
 *  the stance sweep is touchdown-hip → toe-off-hip. */
const RUN_TOEOFF_HIP_DEG = -12;
const RUN_TOEOFF_KNEE_DEG = 26;
/** LOADING-RESPONSE yield authored on top of the midstance base (deg, speed-1),
 *  for the ~100 ms after contact. Running's loading response is ~20-25° of knee
 *  flexion measured FROM THE KNEE AT CONTACT [Novacheck; Dugan & Bhat] — not
 *  from the toe-off knee, which is a different and much larger number. Authored
 *  a little deeper than the target because the stance foot-plant IK straightens
 *  the landing knee several degrees (rig-measured); runParity.test.ts gates the
 *  MEASURED yield, which lands at ~24° from contact. */
const RUN_ABSORB_EXTRA_KNEE_DEG = 10;
const RUN_ABSORB_EXTRA_HIP_DEG = 10;
/** Touchdown hip flexion (deg, speed-1) — the front half of the stance sweep. */
const RUN_TOUCHDOWN_HIP_DEG = 24;
/** Toe-off plantarflexion (deg; negative = plantar in romRegistry's convention).
 *  The ankle is NOT amplitude-scaled — plantarflexion ROM is a hard −50°. */
const RUN_TOEOFF_ANKLE_DEG = -15;
/** A run's energy per unit of its speed request (a run ≈ 2× walking intensity) —
 *  the locomotor intensity buildRun / buildTravelRun hand to the spinal gait
 *  coordinator, whose own ENERGY_MAX ceiling is this × buildRun's 1.6 speed cap. */
const RUN_ENERGY_FACTOR = 2;

interface RunStepTiming {
  touchMs: number;
  absorbMs: number;
  /** TOE-OFF keyframe — closes the stance window. */
  pushMs: number;
  flightMs: number;
  /** One full step (all four keyframes), ms. */
  stepMs: number;
  /** Flight-apex COM height (m, relative to standing) — the knot the ballistic
   *  half-durations above are the free-fall time for. */
  apexM: number;
}

/** Authored per-keyframe durations for one run step at speed factor f = √speed.
 *  The airborne interval is split half/half across the FLIGHT keyframe and the
 *  TOUCHDOWN travel (the descent into contact) — buildJump's apex/descent/
 *  touchdown split — so airtime ≈ 2√(2h/g) and the parabola stays ~g-true.
 *  Every duration is floored at the floor for ITS OWN velocity class so the
 *  resolver never re-times a keyframe: buildTravelRun computes its foot-contact
 *  windows from these SAME numbers, and a resolver bump would desync them.
 *
 *  The class matters. These keyframes declare themselves 'ballistic' (flight,
 *  touchdown) and 'functional' (absorb, drive), but every one of them used to be
 *  floored at the engine's DELIBERATE floor, 150 ms. Four of those per
 *  step puts a hard 600 ms on the step and a 100 spm ceiling on the cadence, which
 *  is BELOW the engine's own walk. The walk hit this exact wall and escaped it by
 *  authoring functional phases; the run declared its classes and then ignored
 *  them. Class-aware, the floor is 60+90+90+60 = 300 ms, so the ceiling is 200 spm
 *  and a real running cadence is reachable. */
function runStepTiming(f: number): RunStepTiming {
  // The arc is ASYMMETRIC — toe-off sits above touchdown — so each half gets the
  // free-fall time for ITS OWN drop: ballisticFlightMs(h)/2 = √(2h/g), the
  // one-way time. Spending a symmetric half on each side (what the old timing
  // did) renders the descent at an implied acceleration that is not g.
  const riseM = RUN_BALLISTIC_RISE_M * f;
  const apexM = RUN_TOEOFF_Y_M + riseM;
  const rise = Math.max(minKeyframeMsFor('ballistic'), Math.round(ballisticFlightMs(riseM) * 0.5));
  const fall = Math.max(
    minKeyframeMsFor('ballistic'),
    Math.round(ballisticFlightMs(apexM - RUN_TOUCHDOWN_Y_M) * 0.5),
  );
  const ground = Math.max(minKeyframeMsFor('functional'), Math.round(RUN_GCT_MS * 0.5 / f));
  return {
    touchMs: fall, // the DESCENT into contact
    absorbMs: ground,
    pushMs: ground,
    flightMs: rise, // toe-off up to the apex
    stepMs: fall + ground + ground + rise,
    apexM,
  };
}

/** One STEP of the run cycle — `land` is the leg that touches down; the flight
 *  after ITS push-off closes the step (so steps chain L/R seamlessly and the
 *  loop wrap flight→touchdown is the landing transition). Fresh objects per
 *  call. `s` is the speed request (stride amplitude and cadence each ∝ √s). */
function runStepKeyframes(land: 'L' | 'R', s: number): SequenceKeyframe[] {
  const f = Math.sqrt(s);
  const t = runStepTiming(f);
  const A = (deg: number) => Math.round(deg * f); // stride/amplitude scale
  const leg = (side: 'L' | 'R', hip: number, knee: number, ankle: number) => [
    { joint: `${side}_UpLeg`, motion: 'hipFlexion', targetDegrees: A(hip) },
    { joint: `${side}_Leg`, motion: 'kneeFlexion', targetDegrees: A(knee) },
    { joint: `${side}_Foot`, motion: 'ankleFlexion', targetDegrees: ankle },
  ];
  const arm = (side: 'L' | 'R', sh: number) => [
    { joint: `${side}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: A(sh) },
    { joint: `${side}_Forearm`, motion: 'elbowFlexion', targetDegrees: 85 },
  ];
  const trunk = [{ joint: 'Spine_Lower', motion: 'flexion', targetDegrees: 8 }];
  const other: 'L' | 'R' = land === 'L' ? 'R' : 'L';
  // TOUCHDOWN — the contact instant. The landing leg is near-extended, reaching
  // down/forward for the floor exactly where the ballistic parabola lands the
  // body (landing pre-crouched would make the floor-pin yank the body down —
  // see buildJump's touchdown note); the push-off leg releases behind and
  // begins folding forward to recover.
  const touchdown: SequenceKeyframe = {
    durationMs: t.touchMs, velocityClass: 'ballistic', stance: 'planted',
    // Landing continuity: the flight parabola ends HERE — seed the knot with the
    // pose's rig-measured pin height so the arc lands where the pin grounds it.
    // ABSOLUTE pin-height seed → raw root (raw translate = absolute position;
    // `travel` sugar is a DELTA step per AI-SUGAR-01 and no longer fits here).
    root: { translateM: [0, RUN_TOUCHDOWN_Y_M, 0] },
    targets: [
      ...leg(land, RUN_TOUCHDOWN_HIP_DEG, 18, -8),
      // The OTHER leg toe-off'd two keyframes ago: it is behind and folding, the
      // heel flicking up toward the buttock (the run's knee peak is in EARLY
      // swing, right after toe-off — not at the high knee, which is where it has
      // already begun to unfold).
      ...leg(other, 4, 98, -8),
      ...arm(land, 20), ...arm(other, 0), ...trunk,
    ],
  };
  // ABSORPTION / MIDSTANCE — the loading response, ~one engine-floor keyframe
  // after contact: the landing knee YIELDS past its midstance value
  // (+RUN_ABSORB_EXTRA_KNEE_DEG) with a hip yield, the ankle dorsiflexes as
  // the shank rides over the planted foot; the swing leg comes through.
  const absorb: SequenceKeyframe = {
    durationMs: t.absorbMs, velocityClass: 'functional', stance: 'planted',
    root: { translateM: [0, RUN_MIDSTANCE_Y_M, 0] }, // ABSOLUTE midstance trough
    targets: [
      ...leg(land, RUN_STANCE_HIP_DEG + RUN_ABSORB_EXTRA_HIP_DEG, RUN_STANCE_KNEE_DEG + RUN_ABSORB_EXTRA_KNEE_DEG, 12),
      ...leg(other, 32, 88, 0),
      ...arm(land, 35), ...arm(other, -10), ...trunk,
    ],
  };
  // PUSH — TOE-OFF, and the knot that closes the stance window. The landing
  // thigh has swept behind the body, the knee has recoiled out of the yield and
  // the ankle drives into plantarflexion; the swing leg is at its high knee.
  // Arms at their reciprocal extremes (the arm opposite the swing leg forward).
  const push: SequenceKeyframe = {
    durationMs: t.pushMs, velocityClass: 'ballistic', stance: 'planted',
    // Takeoff continuity: the flight parabola starts HERE — seed the knot with
    // the toe-driving pose's rig-measured pin height (ABOVE standing).
    root: { translateM: [0, RUN_TOEOFF_Y_M, 0] }, // ABSOLUTE toe-off height (raw root)
    targets: [
      ...leg(land, RUN_TOEOFF_HIP_DEG, RUN_TOEOFF_KNEE_DEG, RUN_TOEOFF_ANKLE_DEG),
      ...leg(other, 55, 68, 5),
      ...arm(land, 48), ...arm(other, -18), ...trunk,
    ],
  };
  // FLIGHT — the landing leg has left the ground and folds into its recovery
  // (heel toward the buttock); the other leg leads, its shank unfolding from the
  // high knee toward ITS contact. FLOATING + up-travel → genuinely airborne.
  const flight: SequenceKeyframe = {
    durationMs: t.flightMs, velocityClass: 'ballistic', stance: 'floating',
    root: { translateM: [0, t.apexM, 0] }, // ABSOLUTE flight-apex height (raw root)
    targets: [
      ...leg(land, -8, 88, -12),
      ...leg(other, 42, 35, 5),
      ...arm(land, 18), ...arm(other, 5), ...trunk,
    ],
  };
  return [touchdown, absorb, push, flight];
}

/**
 * A real kinematic RUN — a looping, in-place running gait with a genuine FLIGHT
 * phase (both feet off the ground between steps, unlike walk's double-support)
 * AND real touchdown grounding (roadmap 4.3): each landing runs touchdown →
 * absorption (an extra ~10° knee yield + hip yield right after contact) →
 * recoil into TOE-OFF → flight (see {@link runStepKeyframes}). Higher
 * hip/knee flexion + a forward trunk lean give running form; arms pump
 * reciprocally (opposite the swinging leg). `speed` couples stride amplitude
 * and cadence (√speed each, like paceGait). Loops seamlessly — the wrap
 * (flight → touchdown) is itself the landing transition. The floating phases
 * are NOT floor-pinned, so the up-travel genuinely lifts the body — the feet
 * leave the ground (contrast the in-place walk, which keeps one foot planted).
 */
export function buildRun(opts: { speed?: number; asymmetry?: number | false } = {}): ComposedMotion {
  const s = Math.min(1.6, Math.max(0.6, Number.isFinite(opts.speed ?? 1) ? opts.speed ?? 1 : 1));
  // Healthy-asymmetry signature (roadmap 5.3): 2–4% L/R arm-swing amplitude
  // difference, amplitude-only (see healthySignature.ts); `asymmetry: false`
  // keeps the textbook-symmetric reference run.
  const base: ComposedMotion = {
    name: 'run',
    startFrom: 'neutral',
    stance: 'planted',
    loop: true,
    keyframes: [...runStepKeyframes('R', s), ...runStepKeyframes('L', s)],
  };
  // Natural trunk coordination — thoracic counter-rotation with the pumping arms +
  // lateral sway toward the stance leg. Bigger arm swing at speed ⇒ bigger trunk
  // rotation, for free. Root/feet untouched (spine is above the hips). The distal
  // ENERGY (roadmap 5.4) is explicit: a run is ~2× walking intensity, so the finger
  // curl opens, the elbow pump and wrist drag grow, and the head rides a touch more.
  return spinalGaitCoordination(
    opts.asymmetry === false ? base : healthySignature(base, opts.asymmetry),
    { energy: RUN_ENERGY_FACTOR * s },
  );
}

/**
 * Build a FORWARD-TRAVELING run — the running sibling of {@link buildTravelWalk}
 * (roadmap 4.3): the same touchdown → absorption → drive → flight step cycle as
 * the in-place {@link buildRun}, advancing across the floor with ground-true
 * feet via root motion FROM foot placement (`footDrivenTravel`).
 *
 * The travel derivation measures the FK stance-foot sweep and advances the root
 * to cancel it; through each FLIGHT gap (both feet airborne — no grounded
 * reference) it COASTS at the last grounded advance rate — the body is a
 * projectile, and freezing it there cost the run two thirds of its speed —
 * (services/rootMotion `deriveFootDrivenTravel`, FeetZ.bothAirborne). Foot-plant
 * contact windows pin each stance foot from ITS touchdown until its drive
 * (toe-off) — flight phases carry no contact by definition — and the SAME
 * windows travel-lock the derivation onto the weight-bearing foot (the measured
 * lower-foot heuristic would track the recovering swing foot through a step).
 *
 * TWO full cycles (4 steps) plus a closing touchdown, so the motion covers a
 * measurable travel distance (>1 m) and ENDS grounded at a contact rather than
 * hovering mid-flight. Ends are CYCLIC fly-throughs (the pre-Wave-3 travel-walk
 * pattern): the run enters at stride velocity and exits mid-cadence for the
 * next chained command — it does NOT author a braking multi-step deceleration
 * (the travel walk's settleEnds machinery; a 2-3 step run-down is future work).
 * Non-looping, `startFrom:'current'`, so repeating it runs further from
 * wherever the body already is.
 *
 * VERTICAL: deliberately NO `verticalCalibrationCm`. The calibration's smoothed
 * phase table is derived from an always-grounded cycle (the walk); on a flight
 * gait its whole-arc smoothing bridges the stance dips with the ballistic highs,
 * which (rig-measured) holds the pelvis up through the absorption — the
 * foot-plant IK then straightens the landing knee and erases the touchdown
 * yield — and steps ~5 cm at the touchdown boundary. The run's grounded pelvis
 * arc is instead AUTHORED in the physiologic running band (~7-9 cm across its
 * stance windows — rig-gated in runParity.test.ts); the airborne vertical stays
 * with the constant-g flight parabola.
 */
export function buildTravelRun(
  opts: { speed?: number; asymmetry?: number | false } = {},
): ComposedMotion {
  const s = Math.min(1.6, Math.max(0.6, Number.isFinite(opts.speed ?? 1) ? opts.speed ?? 1 : 1));
  const f = Math.sqrt(s);
  const t = runStepTiming(f);
  const steps: ('L' | 'R')[] = ['R', 'L', 'R', 'L'];
  const kfs: SequenceKeyframe[] = steps.flatMap((land) => runStepKeyframes(land, s));
  // Closing touchdown (R): the final flight lands — a complete ballistic arc
  // and a grounded finish.
  kfs.push(runStepKeyframes('R', s)[0]!);
  // STANCE WINDOWS (authored ms — identical in trajectory time: every duration
  // above is at/above the engine floor and no timeScale is set, so the resolver
  // passes them through verbatim): each landing foot bears weight from its
  // TOUCHDOWN arrival to its DRIVE arrival (toe-off). ONLY the first window
  // travel-locks, and it extends back to t=0: through the standing→first-
  // touchdown ENTRY the lower-foot heuristic would track the reaching (future
  // stance) R foot's forward sweep and walk the root BACKWARD — the lock floors
  // its advance at 0. The STEADY-STATE stances deliberately stay on the
  // measured-feet heuristic: a lock's max(0,·) floor turns every small
  // within-stance reversal into phantom forward advance (~4-5 cm/stance,
  // rig-measured), which over-runs the pinned foot and makes the plant IK
  // straighten the landing knee — eating the absorption yield. The flight gaps
  // between stances are handled by the derivation's bothAirborne hold.
  const windows = steps.map((land, i) => ({
    foot: `${land}_Foot`,
    fromMs: i === 0 ? 0 : i * t.stepMs + t.touchMs,
    toMs: i * t.stepMs + t.touchMs + t.absorbMs + t.pushMs,
    ...(i === 0 ? { travelLock: true } : {}),
  }));
  // FOOT-PLANT CONTACTS pin each stance foot from its LANDING (touchdown
  // arrival — a window opening earlier would capture the still-airborne foot
  // and pin it mid-air) until its toe-off. Flight phases carry no contact.
  const contacts: StanceContact[] = steps.map((land, i) => ({
    foot: `${land}_Foot`,
    fromMs: i * t.stepMs + t.touchMs,
    toMs: i * t.stepMs + t.touchMs + t.absorbMs + t.pushMs,
  }));
  // Healthy-asymmetry signature (roadmap 5.3): amplitude-only, so the authored
  // stance windows / contacts above stay byte-exact (see healthySignature.ts).
  const base: ComposedMotion = {
    name: 'run-forward',
    startFrom: 'current',
    stance: 'planted',
    // Persistent heading (SEAM-1): rebase onto the live entry facing when the
    // run starts from the current pose (same contract as buildTravelWalk).
    inheritHeading: true,
    keyframes: kfs,
    footDrivenTravel: true,
    contacts,
    gaitStanceWindowsMs: windows,
  };
  // Distal energy (roadmap 5.4): same run intensity as the in-place buildRun.
  return spinalGaitCoordination(
    opts.asymmetry === false ? base : healthySignature(base, opts.asymmetry),
    { energy: RUN_ENERGY_FACTOR * s },
  );
}

/**
 * A single-leg HOP — hop in place ON one leg while the other stays lifted. Like
 * {@link buildJump} but single-support: the SUPPORT leg loads (hip/knee flex,
 * ankle dorsiflex) → drives off (toe push) → the body goes FLOATING and rises
 * (~15 cm) so its foot leaves the ground too → lands back on the same foot. The
 * OTHER leg is held flexed (hip ~30° / knee ~45°) throughout, so at the airborne
 * apex BOTH feet are clear of the floor. A return-to-sport / hop-test screen.
 * `reps` replays the cycle at playback time (no keyframe duplication).
 *
 * AUTHORED COUNTERBALANCE (rig-tuned vs computeBalanceTimeline): a one-leg hop is
 * a sustained single-support posture, so every keyframe carries a postural set
 * over the support foot — trunk listed toward the support side, the held leg
 * adducted to midline, the support-side arm floated out — and the crouched
 * load/touchdown/absorb/recovery frames lean the trunk FORWARD so the COM stays
 * over the foot instead of behind its heel (the hop is airborne-class, so no
 * foot-rooting: the lean must be authored). Rig-measured: min margin of
 * stability −4.6 cm uncounterbalanced → +0.4 cm.
 */
export function buildSingleLegHop(
  opts: { stance?: 'L' | 'R'; heightM?: number; reps?: number } = {},
): ComposedMotion {
  const sup = opts.stance === 'R' ? 'R' : 'L'; // support / hopping leg
  const up = sup === 'L' ? 'R' : 'L'; // the leg held up throughout
  const apexM = Math.max(0.08, Math.min(0.4, opts.heightM ?? 0.15));
  // Airborne interval derived from apex height (see buildJump); the trajectory
  // shapes the rise/fall as a constant-g parabola, so no authored apex hold.
  const flightMs = ballisticFlightMs(apexM);
  // Lateral counterbalance sign: spine lateralTilt + = toward subject-LEFT
  // (romRegistry), so lean toward the support side.
  const latSign = sup === 'L' ? 1 : -1;
  const held = () => [
    { joint: `${up}_UpLeg`, motion: 'hipFlexion', targetDegrees: 30 },
    // Held leg ADDUCTS toward midline — its mass rides nearer the support line.
    { joint: `${up}_UpLeg`, motion: 'hipAbduction', targetDegrees: -12 },
    { joint: `${up}_Leg`, motion: 'kneeFlexion', targetDegrees: 45 },
  ];
  // Sustained lateral postural set over the support foot (every keyframe — the
  // whole hop is single-support, airborne phases included).
  const counter = () => [
    { joint: 'Spine_Lower', motion: 'lateralTilt', targetDegrees: 10 * latSign },
    { joint: 'Spine_Upper', motion: 'lateralTilt', targetDegrees: 5 * latSign },
    { joint: `${sup}_UpperArm`, motion: 'shoulderAbduction', targetDegrees: 25 },
  ];
  const supLeg = (hip: number, knee: number, ankle: number) => [
    { joint: `${sup}_UpLeg`, motion: 'hipFlexion', targetDegrees: hip },
    { joint: `${sup}_Leg`, motion: 'kneeFlexion', targetDegrees: knee },
    { joint: `${sup}_Foot`, motion: 'ankleFlexion', targetDegrees: ankle },
  ];
  const arms = (sh: number) => [
    { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: sh },
    { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: sh },
  ];
  const trunk = (deg: number) => [{ joint: 'Spine_Lower', motion: 'flexion', targetDegrees: deg }];

  const load = (): SequenceKeyframe => ({
    durationMs: 360, holdMs: 80, stance: 'planted',
    targets: [...supLeg(28, 50, 15), ...held(), ...arms(-20), ...trunk(12), ...counter()],
  });
  // Toe push-off while still planted seeds the floating rise (see buildJump).
  const propulsion = (): SequenceKeyframe => ({
    durationMs: 150, velocityClass: 'ballistic', stance: 'planted',
    // ABSOLUTE pin-height seed → raw root (raw translate = absolute position;
    // `travel` sugar is a DELTA step per AI-SUGAR-01 and no longer fits here).
    root: { translateM: [0, 0.05, 0] },
    targets: [...supLeg(5, 12, -25), ...held(), ...arms(60), ...trunk(2), ...counter()],
  });
  const apex = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.5), velocityClass: 'ballistic', stance: 'floating',
    root: { translateM: [0, apexM, 0] }, // ABSOLUTE apex height (raw root)
    targets: [...supLeg(18, 32, -5), ...held(), ...arms(40), ...counter()],
  });
  const descent = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.3), velocityClass: 'ballistic', stance: 'floating',
    root: { translateM: [0, apexM * 0.5, 0] }, // ABSOLUTE mid-fall height (raw root)
    targets: [...supLeg(15, 20, 0), ...held(), ...arms(25), ...counter()], // reaching DOWN toward contact
  });
  // TOUCHDOWN: near-extended support leg so the foot reaches the floor where the
  // parabola lands (root Y≈0), THEN absorb — else the pin snaps the body down to
  // ground a deep-crouch contact (see buildJump). Trunk leans forward over the
  // landing foot (counterbalance: the crouch pulls the pelvis behind the heel).
  const touchdown = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.2), velocityClass: 'ballistic', stance: 'planted',
    root: { translateM: [0, 0, 0] }, // ABSOLUTE ground height (raw root)
    targets: [...supLeg(20, 24, 0), ...held(), ...arms(18), ...trunk(8), ...counter()],
  });
  const absorb = (): SequenceKeyframe => ({
    durationMs: 170, holdMs: 60, velocityClass: 'functional', stance: 'planted',
    root: { translateM: [0, 0, 0] }, // ABSOLUTE ground height (raw root)
    targets: [...supLeg(32, 52, 12), ...held(), ...arms(15), ...trunk(18), ...counter()],
  });
  // Recovery HOLDS a slight forward trunk lean — the end state is still a one-leg
  // crouched ready stance, so the postural counterbalance stays on.
  const recovery = (): SequenceKeyframe => ({
    durationMs: 300, stance: 'planted',
    targets: [...supLeg(20, 40, 0), ...held(), ...arms(0), ...trunk(8), ...counter()],
  });

  const reps = Math.max(1, Math.min(50, Math.round(opts.reps ?? 1)));
  return {
    name: reps > 1 ? `single-leg hop ×${reps}` : 'single-leg hop',
    startFrom: 'neutral',
    stance: 'planted',
    ...(reps > 1 ? { reps } : {}),
    keyframes: [load(), propulsion(), apex(), descent(), touchdown(), absorb(), recovery()],
  };
}
