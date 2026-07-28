/**
 * POSTURE MOTION FACTORIES — the non-locomotor half of the authored movement
 * library: the standing ↔ sitting ↔ kneeling ↔ quadruped ↔ plank ↔ lying
 * transfers, the floor/closed-chain postures held there (push-up, bird-dog,
 * squat), and the supine/prone log rolls.
 *
 * Split out of services/movementTemplates so the locomotor family (walk / run /
 * jump / turn) and the posture family stop sharing one very large file. Transfers
 * and floor postures stay TOGETHER here because they share the same private pose
 * helpers (`bilatLeg`, `trunkFlex`, `plankLimbs`, `quadLegs`, `kneelLegs`) and the
 * line between "a transfer INTO a posture" and "the posture itself" is arbitrary
 * — buildGetDownToPlank is both.
 *
 * Every factory is pure and self-contained: it authors keyframes over the
 * movement-command vocabulary and is ROM-clamped + measured by the normal resolve
 * path. Nothing here touches the template library or the gait modifiers, so this
 * module is a leaf. Re-exported from services/movementTemplates so the public
 * surface (and every existing importer) is unchanged.
 */

import * as THREE from 'three';
import type {
  ComposedMotion,
  PostureNode,
  SequenceKeyframe,
  SequenceTarget,
} from './motionSequence';

// ─── Posture transfers: standing ↔ supine (Phase 2) ─────────────────────────
// Kinematic transfers between standing and lying on the back, using the engine's
// SemanticPosture root reorientation (supine = root pitch −90). Feet stay the ONLY
// ground contact (the engine models foot contact only), so the supine body rests on
// the feet-pin's co-planar geometry and the transitions read as "get down and lie
// back" / "curl up and stand". A truly natural sit-down-then-recline (via ischial /
// hand contact) awaits the Phase-3 multi-contact rework. All `startFrom:'current'`
// so they continue from the live posture with no teleport.

const bilatLeg = (hip: number, knee: number, ankle: number): SequenceTarget[] => [
  { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: hip },
  { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: hip },
  { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: knee },
  { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: knee },
  { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: ankle },
  { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: ankle },
];
const trunkFlex = (lower: number, upper: number): SequenceTarget[] => [
  { joint: 'Spine_Lower', motion: 'flexion', targetDegrees: lower },
  { joint: 'Spine_Upper', motion: 'flexion', targetDegrees: upper },
];

/** LIE DOWN — standing → supine. Lower into a deep crouch (feet planted, the
 *  floor-pin drops the pelvis), then recline the trunk to horizontal and settle the
 *  legs out flat. Ends 'supine'. The get-DOWN crouch is a weighted lower —
 *  gravity-shaped descent re-timing applies (see {@link buildSitDown}). */
export function buildLieDown(): ComposedMotion {
  return {
    name: 'lie down',
    startFrom: 'current',
    stance: 'planted',
    endPosture: 'supine',
    weightedDescent: true,
    keyframes: [
      { durationMs: 800, stance: 'planted', targets: [...bilatLeg(95, 115, 20), ...trunkFlex(25, 15)] },
      {
        durationMs: 900,
        holdMs: 200,
        stance: 'planted',
        posture: 'supine',
        targets: [...bilatLeg(5, 8, 0), ...trunkFlex(0, 0)],
      },
    ],
  };
}

/** STAND UP — supine → standing. Curl/tuck up from lying, then rise through a
 *  crouch to a quiet stand (posture back upright). Ends 'standing'. */
export function buildGetUp(): ComposedMotion {
  return {
    name: 'stand up',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'supine',
    endPosture: 'standing',
    keyframes: [
      { durationMs: 700, stance: 'planted', posture: 'supine', targets: [...bilatLeg(95, 115, 20), ...trunkFlex(25, 15)] },
      {
        durationMs: 900,
        holdMs: 150,
        stance: 'planted',
        posture: 'upright',
        targets: [...bilatLeg(0, 0, 0), ...trunkFlex(0, 0)],
      },
    ],
  };
}

/** SUPINE STRAIGHT-LEG RAISE — a supine exercise: lying on the back, raise one
 *  straight leg (hip flexion, knee extended), hold, lower. Starts + ends 'supine'
 *  (carries the supine orientation on every keyframe so it is self-contained). */
export function buildSupineLegRaise(opts: { side?: 'L' | 'R'; reps?: number } = {}): ComposedMotion {
  const side = opts.side === 'L' ? 'L' : 'R';
  const reps = Math.max(1, Math.min(20, Math.round(opts.reps ?? 1)));
  const raise = (hip: number, knee: number): SequenceTarget[] => [
    { joint: `${side}_UpLeg`, motion: 'hipFlexion', targetDegrees: hip },
    { joint: `${side}_Leg`, motion: 'kneeFlexion', targetDegrees: knee },
  ];
  return {
    name: reps > 1 ? `supine straight-leg raise ×${reps}` : 'supine straight-leg raise',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'supine',
    endPosture: 'supine',
    ...(reps > 1 ? { reps } : {}),
    keyframes: [
      { durationMs: 400, stance: 'planted', posture: 'supine', targets: raise(0, 0) },
      { durationMs: 800, holdMs: 300, stance: 'planted', posture: 'supine', targets: raise(70, 0) },
      { durationMs: 700, stance: 'planted', posture: 'supine', targets: raise(0, 0) },
    ],
  };
}

// ─── Posture transfers: standing ↔ sitting (Phase 3 Tier A) ─────────────────
// Sitting is grounded on the PELVIS at seat height (groundingPosture 'sitting' →
// pinContactsToFloor Hips@seatY) — NOT a foot-grounded squat. The transfer lowers
// into a deep flex whose pelvis is already near seat height (feet-pinned), then the
// SEATED keyframe switches the grounding to the pelvis (both are Y-only pins, so the
// swap stays smooth). A chair/bed prop is placed app-side at the measured pelvis.

/** SIT DOWN — standing → sitting. Reach the hips back and lower to the seat, then
 *  settle onto it (pelvis grounded at seat height). Ends 'sitting'.
 *
 *  WEIGHTED DESCENT (roadmap 3.3): the sit-DOWN direction is a bodyweight
 *  lower — gravity does the work and the seat provides the catch — so it opts
 *  into the gravity-shaped descent re-timing (slow early, accelerating into
 *  the seat; the authored knee flexion at the bottom is the yield). The
 *  stand-UP direction ({@link buildStandFromSit}) is a concentric RISE and
 *  stays unflagged, as does the clinical squat template: a squat is a
 *  CONTROLLED ECCENTRIC whose deliberate symmetric tempo is the clinically
 *  correct behaviour, not a defect. */
export function buildSitDown(): ComposedMotion {
  return {
    name: 'sit down',
    startFrom: 'current',
    stance: 'planted',
    endPosture: 'sitting',
    weightedDescent: true,
    keyframes: [
      // Reach back + begin to lower (feet grounded).
      { durationMs: 600, stance: 'planted', targets: [...bilatLeg(45, 55, 12), ...trunkFlex(15, 8)] },
      // Descend so the pelvis arrives at ~seat height (still feet-grounded).
      { durationMs: 600, stance: 'planted', targets: [...bilatLeg(85, 95, 12), ...trunkFlex(12, 6)] },
      // Settle onto the seat — grounding switches to the pelvis; trunk comes upright.
      {
        durationMs: 400,
        holdMs: 300,
        stance: 'planted',
        groundingPosture: 'sitting',
        targets: [...bilatLeg(85, 95, 8), ...trunkFlex(0, 0)],
      },
    ],
  };
}

/** STAND UP FROM SITTING — sitting → standing. Lean forward to bring the COM over
 *  the feet, then rise to a quiet stand (grounding hands back to the feet). Ends
 *  'standing'. (The clinical sit-to-stand.) */
export function buildStandFromSit(): ComposedMotion {
  return {
    name: 'stand up',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'sitting',
    endPosture: 'standing',
    keyframes: [
      // Seated, lean forward (nose over toes) — COM shifts over the feet.
      {
        durationMs: 500,
        stance: 'planted',
        groundingPosture: 'sitting',
        targets: [...bilatLeg(100, 95, 12), ...trunkFlex(28, 12)],
      },
      // Rise to a quiet stand — weight is on the feet now (feet grounding).
      {
        durationMs: 800,
        holdMs: 150,
        stance: 'planted',
        targets: [...bilatLeg(0, 0, 0), ...trunkFlex(0, 0)],
      },
    ],
  };
}

/** SEATED KNEE EXTENSION — a sitting exercise: seated, extend one knee to straight,
 *  hold, lower. Starts + ends 'sitting' (grounded on the pelvis throughout). */
export function buildSeatedKneeExtension(opts: { side?: 'L' | 'R'; reps?: number } = {}): ComposedMotion {
  const side = opts.side === 'L' ? 'L' : 'R';
  const reps = Math.max(1, Math.min(20, Math.round(opts.reps ?? 1)));
  const knee = (deg: number): SequenceTarget[] => [
    { joint: `${side}_UpLeg`, motion: 'hipFlexion', targetDegrees: 85 },
    { joint: `${side}_Leg`, motion: 'kneeFlexion', targetDegrees: deg },
  ];
  return {
    name: reps > 1 ? `seated knee extension ×${reps}` : 'seated knee extension',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'sitting',
    endPosture: 'sitting',
    ...(reps > 1 ? { reps } : {}),
    keyframes: [
      { durationMs: 400, stance: 'planted', groundingPosture: 'sitting', targets: knee(90) },
      { durationMs: 700, holdMs: 300, stance: 'planted', groundingPosture: 'sitting', targets: knee(5) },
      { durationMs: 600, stance: 'planted', groundingPosture: 'sitting', targets: knee(90) },
    ],
  };
}

// ─── Posture transfers: standing ↔ plank + push-up (Phase 3 Tier B) ──────────
// A PLANK is a straight PRONE-FRAME line held on the TOES (behind) and the HANDS
// (front). It grounds on groundingPosture 'plank' → the toes are the vertical pin
// (they set the whole-body height, like the feet standing) and each hand is a REACH
// contact the hand-plant IK keeps FIXED on the floor. The push-up rep is authored as
// a body-PITCH oscillation about the toe pivot (chest down/up); the hand-plant IK
// folds the arms to keep the hands planted, so the elbow bend is emergent — no per-rep
// arm authoring. The get-down/-up rotate the whole body between upright and the prone
// frame via a raw root pitch (SQUAD-interpolated). All startFrom:'current'.

/** Body pitch (deg) of the plank TOP — near-level, shoulders ~an arm-length up so
 *  the straight arms drop to the floor (empirically hands ≈ coplanar with the toes). */
const PLANK_TOP_PITCH = 76;
/** Body pitch (deg) of the push-up BOTTOM — the body flattened toward horizontal so
 *  the chest lowers toward the floor about the toe pivot. */
const PLANK_LOW_PITCH = 86;

/** Prone-frame arms reaching down to the floor (a seed for the hand-plant IK, which
 *  overrides the arm while grounded) + straight legs with the toes tucked under (the
 *  toe vertical pin). */
const plankLimbs = (shoulder: number, elbow: number): SequenceTarget[] => [
  { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: shoulder },
  { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: shoulder },
  { joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: elbow },
  { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: elbow },
  // Wrist EXTENDED so the palm lays flat on the floor (fingers forward) instead of
  // the hand hanging fingers-down and resting on the fingertips. Preserved through the
  // hand-plant IK, which rotates only the shoulder/elbow. (Neg wristFlexion = extension.)
  { joint: 'L_Hand', motion: 'wristFlexion', targetDegrees: -45 },
  { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: -45 },
  // Ankle plantarflexed so the toes tuck under for the toe pin — authored AT the
  // 20° ankleFlexion ROM limit (DET-RES-02: the old 40° was silently clamped to
  // 20 at resolution, so intent and outcome disagreed; 20 is what actually plays).
  ...bilatLeg(0, 0, 20),
];

// ─── Bodyweight squat with limited-dorsiflexion compensation (physics-informed
//     balance seed) ────────────────────────────────────────────────────────────
//
// A bodyweight squat's balance failure mode under LIMITED ankle dorsiflexion (DF)
// is BACKWARD: capping DF stops the shin advancing, so the pelvis over-sits behind
// the heels and the whole-body CoM falls behind the base of support. A real person
// compensates by inclining the TRUNK FORWARD — realized here, over the SHIPPED
// closed-chain foot-root path, as extra bilateral HIP FLEXION (the hip-hinge about
// the plant-fixed hip — the "good-morning" squat), with a bounded secondary SPINE
// increment. That forward incline carries the CoM back over the mid-foot. When the
// restriction is too severe for the hip+spine ROM budget to cover, the CoM stays
// behind the base and the squat genuinely LOSES balance (margin < 0) — the
// compensate-else-fall behaviour this seed is built around.
//
// PURE AUTHORING. No engine changes: no root.orient (would slide the feet or
// distort the base), no contacts[] (would trigger the IK base-of-support
// distortion), no balanceAssist (its generic re-centre would silently mask the
// intended failure and its foot-rooted HIP_SAGITTAL sign is inverted). The motion
// rides the exact same plant-fixed, base-honest path the shipped 'squat' template
// scores +2.8 cm on, so at full DF the solver reproduces that baseline.
//
// FUTURE FLAVOUR (documented, NOT built here): the complementary limited-DF
// phenotype is the FOREFOOT ROCKER / toe-root ("coming up on the balls of the
// feet"). It is more iconic but requires editing the re-root core — plantStanceFoot
// / captureFootFrames / stanceFootDrift all hard-filter key.endsWith('Foot') — plus
// an ExamStage3D lockstep mirror, so it ships as a flagged engine follow-up, not in
// this pure-authoring change.

/** DF-keyed compensation solver: given the realized (weight-bearing-clamped) ankle
 *  dorsiflexion cap, return the descent-pose angles that incline the trunk forward
 *  enough to keep the CoM over the mid-foot. Hip is the PRIMARY lever (~3× the CoM
 *  effect of the spine per degree and ROM-headroomed), the spine a bounded
 *  secondary; every channel is hard-clamped at its verified ROM ceiling. At full WB
 *  DF (≥ the value where deficit → 0) it yields the shipped squat angles exactly. */
function squatCompensation(dfCap: number): {
  hip: number;
  knee: number;
  ankle: number;
  sl: number;
  su: number;
  arm: number;
} {
  const df = clampSquatDorsiflexionCap(dfCap);
  // Forward CoM shift (cm) needed for a safe margin, as a linear function of the DF
  // deficit. CALIBRATED on the real balanceBaseOfSupport harness (fresh GLB per df,
  // reset pos+quat only). Measured minMargin sweep with these constants:
  //   df 32→+3.4 · 26→+2.2 · 20→+2.7 · 18→+1.9 · 16→+0.3 · 14→−1.4 · 12→−3.0 ·
  //   10→−4.7 · 6→−8.1 cm. Balanced (margin>0, balancedFraction 1.0) down to
  //   df≈16; the hip+spine ROM budget is exhausted below that and the CoM stays
  //   behind the base (backward loss) — the compensate-else-fall crossover ≈ df 15.
  const DEFICIT_A = 32.2;
  const DEFICIT_B = 1.006; // 32.2 - 1.006*32 ≈ 0 at the full WB-DF squat
  // Per-lever CoM gains (cm forward per deg), rig-fit on the harness sweep. Hip is
  // the primary lever (closed-chain hip-hinge, ~3× the spine and ROM-headroomed);
  // the lumbar spine is the weaker secondary.
  const HIP_GAIN = 0.30;
  const LUM_GAIN = 0.22;
  const deficit = Math.max(0, DEFICIT_A - DEFICIT_B * df);
  // Hip carries the deficit first, up to its ROM ceiling (100 → 120).
  const dHip = Math.min(20, deficit / HIP_GAIN);
  const rem = Math.max(0, deficit - dHip * HIP_GAIN);
  // The lumbar spine takes the remainder, up to its ceiling (27 → 60).
  const dLum = Math.min(33, rem / LUM_GAIN);
  const hip = 100 + dHip; // ≤ 120 (verified hipFlexion max 120)
  const sl = 27 + dLum; // ≤ 60 (verified Spine_Lower flexion max 60)
  const su = Math.min(40, 10 + 0.9 * dLum); // thoracic rides at 0.9× (≤ 40, verified)
  return { hip, knee: 120, ankle: df, sl, su, arm: 60 };
}

/** Floor of {@link buildSquat}'s weight-bearing dorsiflexion domain. ZERO is a
 *  legitimate clinical ask (a fused or fully blocked ankle) — the compensation
 *  solver models it, and the resulting backward loss of balance IS the finding. */
export const SQUAT_DF_CAP_MIN_DEG = 0;

/** Ceiling of {@link buildSquat}'s weight-bearing dorsiflexion domain. */
export const SQUAT_DF_CAP_MAX_DEG = 35;

/** Clamp a requested weight-bearing DF cap into buildSquat's real domain.
 *  EXPORTED because hosts report the cap the builder actually received: simMOVE's
 *  instruction parser used to re-inline these bounds with a 4° floor, so an ask
 *  below 4° was silently rewritten AND the on-screen readout asserted a domain
 *  the builder does not have. */
export function clampSquatDorsiflexionCap(requested: number): number {
  return Math.max(SQUAT_DF_CAP_MIN_DEG, Math.min(SQUAT_DF_CAP_MAX_DEG, requested));
}

/**
 * BODYWEIGHT SQUAT with automatic limited-DF balance compensation.
 *
 * `dorsiflexionCapDeg` is the realized weight-bearing ankle DF for this squat
 * (default 32 = the shipped balanced WB-DF squat with a 60° arm-forward reach).
 * Pass the SAME number a scenario constraint (the `constraints` passed to
 * `resolveComposedMotion`) will clamp the ankle to, so the authored forward
 * incline matches the ankle that is actually realized. The solver keys a forward hip-hinge trunk incline (+ bounded spine) off
 * that cap: moderate restriction stays balanced via visible compensation, severe
 * restriction exhausts the hip+spine ROM budget and the CoM stays behind the base
 * (margin < 0 — a backward loss of balance).
 *
 * Same builder shape the shipped 'squat' template emits (startFrom:'neutral',
 * planted, descent+ascent, ankle leads at peakAt 0.8). NO balanceAssist / contacts[]
 * / root.orient / weightedDescent — the motion stays on the plant-fixed, base-honest
 * foot-root path so the balance measurement is undistorted.
 */
export function buildSquat(opts: { dorsiflexionCapDeg?: number } = {}): ComposedMotion {
  const dfCap = typeof opts.dorsiflexionCapDeg === 'number' && Number.isFinite(opts.dorsiflexionCapDeg)
    ? opts.dorsiflexionCapDeg
    : 32;
  const c = squatCompensation(dfCap);
  return {
    name: 'squat',
    startFrom: 'neutral',
    stance: 'planted',
    keyframes: [
      {
        durationMs: 1000,
        holdMs: 350,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: c.hip },
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: c.hip },
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: c.knee },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: c.knee },
          // Ankle leads the descent (peakAt 0.8) — the shin advances over the
          // planted foot first, exactly as the shipped squat authors it.
          { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: c.ankle, peakAt: 0.8 },
          { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: c.ankle, peakAt: 0.8 },
          { joint: 'Spine_Lower', motion: 'flexion', targetDegrees: c.sl },
          { joint: 'Spine_Upper', motion: 'flexion', targetDegrees: c.su },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: c.arm },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: c.arm },
        ],
      },
      {
        durationMs: 1000,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', targetDegrees: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', targetDegrees: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', targetDegrees: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', targetDegrees: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', targetDegrees: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 0 },
        ],
      },
    ],
  };
}

/** GET INTO A PLANK — standing → plank. Crouch and hinge forward with the hands
 *  reaching to the floor, then pitch the body to the prone-frame plank line (weight
 *  on the toes + hands). Ends 'plank'. Flagged as a weighted lower with the rest
 *  of the get-down family; today its root-Y descent lives almost entirely in the
 *  pitch transfer (a grounding-switch step, which the span detector correctly
 *  refuses to reshape), so the flag is an identity until a real crouch descent
 *  is authored — asserted in the rig gates. */
export function buildGetDownToPlank(): ComposedMotion {
  return {
    name: 'get into a plank',
    startFrom: 'current',
    stance: 'planted',
    endPosture: 'plank',
    weightedDescent: true,
    keyframes: [
      // Crouch + hinge forward, reaching the hands toward the floor (feet grounded).
      { durationMs: 700, stance: 'planted', targets: [...bilatLeg(75, 100, 15), ...trunkFlex(35, 20), ...plankLimbs(120, 15)] },
      // Pitch to the plank line; grounding switches to the toes+hands as they reach
      // the floor (the toe vertical pin + the hand-plant IK take over from the feet).
      {
        durationMs: 800,
        holdMs: 150,
        stance: 'planted',
        groundingPosture: 'plank',
        root: { orient: { pitchDeg: PLANK_TOP_PITCH } },
        targets: [...plankLimbs(90, 5), ...trunkFlex(0, 0)],
      },
    ],
  };
}

/** PUSH-UP — plank → plank. Lower the chest toward the floor (flatten the body about
 *  the toe pivot; the hand-plant IK folds the arms to keep the hands planted) and
 *  press back up. Starts + ends 'plank' (grounded on toes+hands throughout). */
export function buildPushUp(opts: { reps?: number } = {}): ComposedMotion {
  const reps = Math.max(1, Math.min(20, Math.round(opts.reps ?? 3)));
  const top = (): SequenceTarget[] => plankLimbs(90, 5);
  return {
    name: reps > 1 ? `push-up ×${reps}` : 'push-up',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'plank',
    endPosture: 'plank',
    ...(reps > 1 ? { reps } : {}),
    keyframes: [
      { durationMs: 350, stance: 'planted', groundingPosture: 'plank', root: { orient: { pitchDeg: PLANK_TOP_PITCH } }, targets: top() },
      // Lower: flatten the body; the chest descends toward the floor.
      { durationMs: 550, holdMs: 120, stance: 'planted', groundingPosture: 'plank', root: { orient: { pitchDeg: PLANK_LOW_PITCH } }, targets: plankLimbs(90, 90) },
      // Press back up to the top.
      { durationMs: 450, stance: 'planted', groundingPosture: 'plank', root: { orient: { pitchDeg: PLANK_TOP_PITCH } }, targets: top() },
    ],
  };
}

/** STAND UP FROM A PLANK — plank → standing. Pike the hips up and back to bring the
 *  feet under the body, then rise to a quiet stand. Ends 'standing'. */
export function buildStandFromPlank(): ComposedMotion {
  return {
    name: 'stand up',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'plank',
    endPosture: 'standing',
    keyframes: [
      // Pike up: hips back and up, trunk folding, feet regain the ground.
      { durationMs: 700, stance: 'planted', root: { orient: { pitchDeg: 35 } }, targets: [...bilatLeg(80, 95, 15), ...trunkFlex(40, 20), ...plankLimbs(150, 5)] },
      // Rise to a quiet stand (upright, feet grounding).
      { durationMs: 800, holdMs: 150, stance: 'planted', posture: 'upright', targets: [...bilatLeg(0, 0, 0), ...trunkFlex(0, 0), ...plankLimbs(0, 0)] },
    ],
  };
}

// ─── Posture transfers: standing ↔ quadruped + bird-dog (Phase 3 Tier B) ─────
// QUADRUPED (hands-and-knees) is a prone-frame trunk held on the SHINS (the knee bone
// `Leg`, the vertical pin) behind and the HANDS (reach-IK) in front — the pelvis rides
// elevated at thigh height. groundingPosture 'quadruped' grounds both knees + both
// hands. The bird-dog raise switches to 'quadruped-hand-L/R' so ONE hand releases and
// the opposite arm can reach out (the lifted knee simply rises — the max-lift pin uses
// the planted knee). All startFrom:'current'.

/** Body pitch (deg) of the quadruped trunk — horizontal (prone frame). */
const QUAD_PITCH = 90;
/** Hands-and-knees limbs: shins folded to lie on the floor (hip 95 / knee 100 /
 *  ankle −45 lands the knee + toes at the floor with the shin flat), arms straight
 *  down to the hands (the hand-plant IK plants them), palms flat (wrist −45). */
const quadLegs = (): SequenceTarget[] => bilatLeg(95, 100, -45);
const quadArms = (): SequenceTarget[] => [
  { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90 },
  { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 90 },
  { joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: 5 },
  { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 5 },
  { joint: 'L_Hand', motion: 'wristFlexion', targetDegrees: -45 },
  { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: -45 },
];

/** GET ONTO HANDS AND KNEES — standing → quadruped. Crouch and hinge forward with the
 *  hands reaching to the floor, then lower to the prone-frame quadruped (knees + hands
 *  grounded). Ends 'quadruped'. The get-DOWN crouch is a weighted lower —
 *  gravity-shaped descent re-timing applies (see {@link buildSitDown}); the
 *  quadruped grounding-switch step is a discontinuity the span detector never
 *  crosses, so only the real crouch is reshaped. */
export function buildGetDownToQuadruped(): ComposedMotion {
  return {
    name: 'get onto hands and knees',
    startFrom: 'current',
    stance: 'planted',
    endPosture: 'quadruped',
    weightedDescent: true,
    keyframes: [
      // Crouch + hinge forward, reaching the hands toward the floor (feet grounded).
      { durationMs: 700, stance: 'planted', targets: [...bilatLeg(95, 115, 15), ...trunkFlex(40, 25), { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 115 }, { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 115 }] },
      // Onto hands and knees: trunk to horizontal, knees + hands to the floor.
      {
        durationMs: 700,
        holdMs: 150,
        stance: 'planted',
        groundingPosture: 'quadruped',
        root: { orient: { pitchDeg: QUAD_PITCH } },
        targets: [...quadLegs(), ...quadArms(), ...trunkFlex(0, 0)],
      },
    ],
  };
}

/** STAND UP FROM HANDS AND KNEES — quadruped → standing. Push the hips up and back over
 *  the feet, then rise to a quiet stand. Ends 'standing'. */
export function buildStandFromQuadruped(): ComposedMotion {
  return {
    name: 'stand up',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'quadruped',
    endPosture: 'standing',
    keyframes: [
      // Tuck the feet under and pike the hips up and back (feet regain the ground).
      { durationMs: 700, stance: 'planted', root: { orient: { pitchDeg: 35 } }, targets: [...bilatLeg(90, 100, 15), ...trunkFlex(40, 25), { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 150 }, { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 150 }] },
      // Rise to a quiet stand (upright, feet grounding).
      { durationMs: 800, holdMs: 150, stance: 'planted', posture: 'upright', targets: [...bilatLeg(0, 0, 0), ...trunkFlex(0, 0), ...plankLimbs(0, 0)] },
    ],
  };
}

/** BIRD-DOG — a quadruped exercise: from hands-and-knees, raise one arm forward and the
 *  OPPOSITE leg back to horizontal, hold, return. `side` = the raised ARM (default 'R',
 *  raising the R arm + L leg). The raised hand releases its floor contact (grounding
 *  switches to the planted hand), and the raised knee lifts off (the pin uses the
 *  planted knee). Starts + ends 'quadruped'. */
export function buildBirdDog(opts: { side?: 'L' | 'R'; reps?: number } = {}): ComposedMotion {
  const arm = opts.side === 'L' ? 'L' : 'R';
  const leg = arm === 'R' ? 'L' : 'R';
  const supportHand = arm === 'R' ? 'L' : 'R';
  const grounding = supportHand === 'L' ? 'quadruped-hand-L' : 'quadruped-hand-R';
  const reps = Math.max(1, Math.min(20, Math.round(opts.reps ?? 1)));
  const raise: SequenceTarget[] = [
    // Arm reaches straight forward to ~horizontal (shoulder height); in the prone frame
    // shoulder flexion sweeps the arm from down (90) toward forward (180).
    { joint: `${arm}_UpperArm`, motion: 'shoulderFlexion', targetDegrees: 175 },
    { joint: `${arm}_Forearm`, motion: 'elbowFlexion', targetDegrees: 5 },
    // WRIST RELEASE (roadmap 5.6): without this the raised hand CARRIES FORWARD the
    // quadruped's −45° floor-palm wrist extension through the whole reach — a hand
    // still cocked for a floor that isn't there. The lifted wrist releases to
    // neutral (the hand continues the forearm line); the return keyframe re-authors
    // the floor palm via quadArms.
    { joint: `${arm}_Hand`, motion: 'wristFlexion', targetDegrees: 0 },
    // Leg extends straight back to ~horizontal (hip height); from the quadruped's 95°
    // flexion, ~5° leaves the thigh level with the trunk (−20° over-raised it ~31°).
    { joint: `${leg}_UpLeg`, motion: 'hipFlexion', targetDegrees: 5 },
    { joint: `${leg}_Leg`, motion: 'kneeFlexion', targetDegrees: 5 },
  ];
  return {
    name: reps > 1 ? `bird-dog ×${reps}` : 'bird-dog',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'quadruped',
    endPosture: 'quadruped',
    ...(reps > 1 ? { reps } : {}),
    keyframes: [
      // Settle on all fours (all four grounded).
      { durationMs: 400, stance: 'planted', groundingPosture: 'quadruped', root: { orient: { pitchDeg: QUAD_PITCH } }, targets: [...quadLegs(), ...quadArms()] },
      // Raise the opposite arm + leg to horizontal and hold (raised hand released).
      { durationMs: 800, holdMs: 400, stance: 'planted', groundingPosture: grounding, root: { orient: { pitchDeg: QUAD_PITCH } }, targets: raise },
      // Return to all fours.
      { durationMs: 700, stance: 'planted', groundingPosture: 'quadruped', root: { orient: { pitchDeg: QUAD_PITCH } }, targets: [...quadLegs(), ...quadArms()] },
    ],
  };
}

// ─── Posture transfers: standing ↔ kneeling (Phase 3 Tier B) ─────────────────
// KNEELING is upright on the knees (torso vertical, identity orient) — the SHINS bear
// the body (groundingPosture 'kneeling' → knee vertical pin) and the pelvis rides at
// thigh height. A tall quadruped without the hands.

/** Upright-kneel legs: shins folded to lie on the floor (hip 15 / knee 110 / ankle −50
 *  lands the knee + toes at the floor), torso stacked vertically over the thighs.
 *  Ankle authored AT the −50° ankleFlexion (dorsiflexion) ROM min: the old −60° was
 *  silently clamped to −50 at resolution (DET-RES-02 sibling — the plank toe-tuck had
 *  the same silent clamp in the +plantarflexion direction), so authored intent and what
 *  actually played disagreed; −50 is what resolves + plays. */
const kneelLegs = (): SequenceTarget[] => bilatLeg(15, 110, -50);

/** KNEEL DOWN — standing → kneeling. Lower straight down onto the knees, torso staying
 *  tall. Ends 'kneeling'. */
export function buildKneelDown(): ComposedMotion {
  return {
    name: 'kneel down',
    startFrom: 'current',
    stance: 'planted',
    endPosture: 'kneeling',
    keyframes: [
      // Descend, knees leading, torso tall (feet grounded).
      { durationMs: 700, stance: 'planted', targets: [...bilatLeg(60, 95, 15), ...trunkFlex(12, 6)] },
      // Knees to the floor, torso upright (kneeling grounding).
      { durationMs: 700, holdMs: 200, stance: 'planted', groundingPosture: 'kneeling', targets: [...kneelLegs(), ...trunkFlex(0, 0)] },
    ],
  };
}

/** STAND UP FROM KNEELING — kneeling → standing. Bring the feet under and rise to a
 *  quiet stand. Ends 'standing'. */
export function buildStandFromKneel(): ComposedMotion {
  return {
    name: 'stand up',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'kneeling',
    endPosture: 'standing',
    keyframes: [
      // Bring the feet under, weight transferring forward — held on the KNEE grounding
      // so the whole motion is exempt from foot-rooting (which would otherwise re-root
      // the tucked-back kneeling feet to their standing rest frame and teleport). The
      // standing keyframe then grounds on the plain feet pin.
      { durationMs: 700, stance: 'planted', groundingPosture: 'kneeling', targets: [...bilatLeg(75, 100, 10), ...trunkFlex(18, 9)] },
      // Rise to a quiet stand (feet).
      { durationMs: 800, holdMs: 150, stance: 'planted', posture: 'upright', targets: [...bilatLeg(0, 0, 0), ...trunkFlex(0, 0)] },
    ],
  };
}

// ─── Floor-posture connectors: quadruped ↔ prone, quadruped ↔ plank ──────────
// These knit the floor postures together so "lie face down" routes DOWN through
// hands-and-knees (no faceplant) and the plank/quadruped family interconnects. Prone
// grounds on the existing SemanticPosture foot-pin (feet co-planar with the front,
// the supine mechanism face-down); the others on their groundingPosture contact set.

/** LIE FACE DOWN — quadruped → prone. From hands-and-knees, extend the legs back and
 *  lower the whole front to the floor, the arms coming alongside. Ends 'prone'. */
export function buildLowerToProne(): ComposedMotion {
  return {
    name: 'lie face down',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'quadruped',
    endPosture: 'prone',
    keyframes: [
      {
        durationMs: 900,
        holdMs: 200,
        stance: 'planted',
        posture: 'prone',
        targets: [
          ...bilatLeg(2, 2, 20),
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', targetDegrees: 12 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', targetDegrees: 12 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', targetDegrees: 8 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', targetDegrees: 8 },
          { joint: 'L_Hand', motion: 'wristFlexion', targetDegrees: 0 },
          { joint: 'R_Hand', motion: 'wristFlexion', targetDegrees: 0 },
          ...trunkFlex(0, 0),
        ],
      },
    ],
  };
}

/** PRESS ONTO HANDS AND KNEES — prone → quadruped. Push up off the floor back onto all
 *  fours. Ends 'quadruped'. */
export function buildPressUpToQuadruped(): ComposedMotion {
  return {
    name: 'onto hands and knees',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'prone',
    endPosture: 'quadruped',
    keyframes: [
      { durationMs: 900, holdMs: 150, stance: 'planted', groundingPosture: 'quadruped', root: { orient: { pitchDeg: QUAD_PITCH } }, targets: [...quadLegs(), ...quadArms()] },
    ],
  };
}

/** EXTEND TO A PLANK — quadruped → plank. From hands-and-knees, extend the legs back
 *  onto the toes to a straight plank (hands stay planted). Ends 'plank'. */
export function buildPlankFromQuadruped(): ComposedMotion {
  return {
    name: 'extend to a plank',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'quadruped',
    endPosture: 'plank',
    keyframes: [
      { durationMs: 700, holdMs: 150, stance: 'planted', groundingPosture: 'plank', root: { orient: { pitchDeg: PLANK_TOP_PITCH } }, targets: [...plankLimbs(90, 5)] },
    ],
  };
}

/** DROP TO HANDS AND KNEES — plank → quadruped. Lower the knees to the floor. Ends
 *  'quadruped'. */
export function buildQuadrupedFromPlank(): ComposedMotion {
  return {
    name: 'onto hands and knees',
    startFrom: 'current',
    stance: 'planted',
    startPosture: 'plank',
    endPosture: 'quadruped',
    keyframes: [
      { durationMs: 700, holdMs: 150, stance: 'planted', groundingPosture: 'quadruped', root: { orient: { pitchDeg: QUAD_PITCH } }, targets: [...quadLegs(), ...quadArms()] },
    ],
  };
}

// ─── Log-rolls: supine ↔ side-lying ↔ prone (raw-quat orient) ─────────────────
// A natural "roll over" rotates the whole body about its LONG axis while the head stays
// put — the Euler pitch/roll/yaw can't express this (it gimbal-locks at supine/prone and
// rolls in the body frame, so a supine→prone slerp sits the body UP through vertical and
// dives forward). We author the roll-consistent orientations as RAW quaternions instead:
// the supine body rolled `rollDeg` about its world long axis (Z). The head stays −Z at
// every roll angle, so a startFrom:'current' SQUAD between them is a clean log-roll.

const _SUPINE_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
const _ROLL_AXIS = new THREE.Vector3(0, 0, 1);

/** Roll-consistent lying orientation: supine rolled `rollDeg` about the world long axis.
 *  0 = supine (face up), −90 = left side, +90 = right side, ±180 = prone (face down);
 *  the head stays put throughout. Returns a raw orient quaternion [x,y,z,w]. */
function rollOrientQuat(rollDeg: number): [number, number, number, number] {
  const q = new THREE.Quaternion()
    .setFromAxisAngle(_ROLL_AXIS, (rollDeg * Math.PI) / 180)
    .multiply(_SUPINE_Q);
  return [q.x, q.y, q.z, q.w];
}

/** One log-roll edge: from `from` (lying) to `to` (lying), rotating the root to the
 *  target roll orientation. startFrom:'current' so it rolls from the live pose; the
 *  optional `viaRollDeg` inserts a mid-roll waypoint so a 180° roll can't slerp the
 *  wrong way (through supine). Feet stay the ground contact (the lying foot-pin). */
function buildLogRoll(
  name: string,
  from: PostureNode,
  to: PostureNode,
  toRollDeg: number,
  viaRollDeg?: number,
): ComposedMotion {
  const keyframes: SequenceKeyframe[] = [];
  if (viaRollDeg != null) {
    keyframes.push({ durationMs: 450, stance: 'planted', root: { orient: { quat: rollOrientQuat(viaRollDeg) } } });
  }
  keyframes.push({ durationMs: 550, holdMs: 200, stance: 'planted', root: { orient: { quat: rollOrientQuat(toRollDeg) } } });
  return { name, startFrom: 'current', stance: 'planted', startPosture: from, endPosture: to, keyframes };
}

// Supine ↔ each side. (−90 = left side, +90 = right side — measured on the rig.)
export const buildRollSupineToLeft = (): ComposedMotion => buildLogRoll('roll onto your left side', 'supine', 'sidelying-left', -90);
export const buildRollLeftToSupine = (): ComposedMotion => buildLogRoll('roll onto your back', 'sidelying-left', 'supine', 0);
export const buildRollSupineToRight = (): ComposedMotion => buildLogRoll('roll onto your right side', 'supine', 'sidelying-right', 90);
export const buildRollRightToSupine = (): ComposedMotion => buildLogRoll('roll onto your back', 'sidelying-right', 'supine', 0);
// Side ↔ prone (continue the roll to face-down; a mid-waypoint disambiguates the 180°).
export const buildRollLeftToProne = (): ComposedMotion => buildLogRoll('roll onto your front', 'sidelying-left', 'prone', -180, -135);
export const buildRollProneToLeft = (): ComposedMotion => buildLogRoll('roll onto your left side', 'prone', 'sidelying-left', -90, -135);
export const buildRollRightToProne = (): ComposedMotion => buildLogRoll('roll onto your front', 'sidelying-right', 'prone', 180, 135);
export const buildRollProneToRight = (): ComposedMotion => buildLogRoll('roll onto your right side', 'prone', 'sidelying-right', 90, 135);
