/**
 * GAIT MODIFIERS — the pure transforms that reshape an ALREADY-BUILT gait.
 *
 * Split out of services/movementTemplates (which authors the motions) so the
 * "what a movement IS" half and the "how it is deviated / graded" half are
 * separable. Every function here is pure: it takes a ComposedMotion and returns
 * a new one, never mutating, and every angle it writes is ROM-clamped and
 * measured by the normal resolve path — a modifier is a real authored angle,
 * not a cosmetic overlay.
 *
 *   • {@link calibrateGaitVertical} / {@link gaitBounce} — vertical COM excursion
 *   • {@link paceGait}                                   — stride × cadence speed
 *   • {@link scaleArmSwing} / {@link applyAsymmetry}     — amplitude + L/R asymmetry
 *   • {@link widenStep} / {@link antalgicLean}           — sustained gait deviations
 *   • {@link spinalGaitCoordination}                     — natural trunk/limb coordination
 *
 * Re-exported from services/movementTemplates so the public surface (and every
 * existing importer) is unchanged.
 */

import {
  SPINE_NECK_MAX,
  SPINE_NECK_LATERAL_MAX,
} from './motionSequence';
import { coordinateLocomotorArms, scaleLocomotorArmSwing } from './locomotorArmSwing';
import { addGaitPhaseTargets } from './gaitFaultPhases';
import type {
  ComposedMotion,
  MovementAsymmetry,
  SequenceKeyframe,
  SequenceTarget,
} from './motionSequence';
import { NORMAL_GAIT_VERTICAL_CM } from './gaitConstants';
import { clampTimeScale } from './motionConstants';

/**
 * CALIBRATE a gait's vertical COM excursion to a centimetre target.
 *
 * The engine grounds a planted walk with a vertical floor-pin, which makes the
 * pelvis a geometric slave of the lowest foot — a COMPASS-GAIT vault whose
 * emergent excursion (~9 cm for the authored walk) is about DOUBLE real free gait
 * (~4-5 cm). The classic *determinants of gait* narrative blames the pelvic
 * rotation/list for the difference, but the modern biomechanics literature shows
 * those contribute little to vertical COM — the excursion is essentially the
 * inverted-pendulum vault, reshaped by stance-knee yield and the ankle/foot
 * rockers [Gard & Childress 2001; Kuo 2007]. Rather than fake a pelvic DOF, this
 * flags the motion so the sampler/stage MEASURE the emergent grounded arc and
 * SCALE it about its mean to `targetCm` — an exact, mean-preserving, ROOT-ONLY
 * reshape that leaves every clinical joint angle exactly as authored (a foot-lock
 * IK, by contrast, corrupts the stance hip). Only takes effect on a planted gait.
 * Pure; returns a new motion.
 */
export function calibrateGaitVertical(motion: ComposedMotion, targetCm: number): ComposedMotion {
  const cm = Math.max(1, Math.min(12, Number.isFinite(targetCm) ? targetCm : NORMAL_GAIT_VERTICAL_CM));
  return { ...motion, verticalCalibrationCm: cm };
}

/**
 * Adjust a gait's VERTICAL BOUNCE — the "spring vs glide" quality. Some people
 * bounce (a springy gait with a large pelvis rise-and-fall per step); others
 * glide (a smooth, level-pelvis walk). This is precisely the COM vertical
 * excursion, so `gaitBounce` sets the calibrated centimetre target
 * ({@link calibrateGaitVertical}): `amount` 0 = a calm ~3 cm glide, 1 = the
 * normal ~5 cm, 2 = a pronounced ~8 cm bounce. Stride and cadence (`paceGait`'s
 * job) and every joint angle are left untouched — bounce is orthogonal to speed
 * and does not distort the clinical readout.
 *
 * (Supersedes the old knee-flexion scaling, which conflated swing-foot CLEARANCE
 * with pelvis bounce: it flung the swing foot to ~30 cm and clipped the stance
 * foot ~5 cm THROUGH the floor while barely moving the COM. The calibrated arc
 * moves the COM by the requested amount and keeps the feet grounded.)
 */
export function gaitBounce(motion: ComposedMotion, amount: number): ComposedMotion {
  const a = Math.max(0, Math.min(2, Number.isFinite(amount) ? amount : 1));
  // Piecewise so amount 1 lands exactly on the normal target: 0→3, 1→5, 2→8 cm.
  const cm = a <= 1 ? 3 + a * (NORMAL_GAIT_VERTICAL_CM - 3) : NORMAL_GAIT_VERTICAL_CM + (a - 1) * 3;
  return calibrateGaitVertical(motion, cm);
}

/** Sagittal joints whose EXCURSION defines stride length — scaled by pace. The
 *  reciprocal arm swing scales with the legs (arm swing grows with gait speed). */
const GAIT_STRIDE_MOTIONS = new Set(['hipFlexion', 'kneeFlexion', 'ankleFlexion', 'shoulderFlexion']);

/**
 * Couple a gait motion's STRIDE and CADENCE to a target walking speed.
 *
 * Real walking speed = stride length × cadence: a faster walk takes longer AND
 * quicker steps, not the same step played faster (which is all a bare `timeScale`
 * did — the Finding 6 gap). This splits the requested `speed` evenly between the
 * two (each ∝ √speed, so stride × cadence = speed exactly): the sagittal leg
 * angles and reciprocal arm swing are scaled by √speed (longer stride), and
 * `modifiers.timeScale` is set to √speed (quicker cadence). Over-range targets
 * are clamped by the normal ROM path on resolve. Pure; returns a new motion.
 * Speed 1 is (near-)identity. Intended for the looping gait template; a movement
 * without a stride (squat, reach) should just use `timeScale`.
 */
export function paceGait(motion: ComposedMotion, speed: number): ComposedMotion {
  const s = clampTimeScale(speed);
  const f = Math.sqrt(s); // even stride/cadence split so stride × cadence = speed
  const keyframes = motion.keyframes.map((kf) => ({
    ...kf,
    ...(kf.targets
      ? {
          targets: kf.targets.map((t) =>
            GAIT_STRIDE_MOTIONS.has(t.motion) ? { ...t, targetDegrees: t.targetDegrees * f } : t,
          ),
        }
      : {}),
  }));
  return { ...motion, keyframes, modifiers: { ...motion.modifiers, timeScale: f } };
}

/** Scale the complete locomotor arm chain about its carry, preserving cadence. */
export function scaleArmSwing(motion: ComposedMotion, amount: number): ComposedMotion {
  return scaleLocomotorArmSwing(motion, amount);
}

/** The involved LEG's sagittal stride joints — scaled by an asymmetry's `stepLength`. */
const ASYMMETRY_STRIDE_MOTIONS = new Set(['hipFlexion', 'kneeFlexion', 'ankleFlexion']);
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));

/**
 * Reshape ONE side's targets for a unilateral (involved-vs-uninvolved) asymmetry —
 * the core of a PT movement exam, where the finding is a between-side comparison.
 * The involved side is `asym.side`; each scale multiplies only that side's targets
 * (matched by the `L_`/`R_` joint-key prefix), leaving the uninvolved side as the
 * authored reference:
 *   - `rom`        → the whole involved side's excursion (a stiff / hypomobile limb)
 *   - `stepLength` → the involved LEG's sagittal stride joints (a short step)
 *   - `armSwing`   → the involved ARM's shoulder swing (reduced arm swing)
 * Scales compose multiplicatively where they overlap. Pure; returns a new motion;
 * ROM-clamped on resolve so the asymmetry is measurable. Identity when nothing applies.
 */
export function applyAsymmetry(motion: ComposedMotion, asym: MovementAsymmetry | undefined): ComposedMotion {
  if (!asym) return motion;
  const prefix = asym.side === 'left' ? 'L_' : 'R_';
  const rom = asym.rom != null && asym.rom < 1 ? clamp01(asym.rom) : null;
  const step = asym.stepLength != null && asym.stepLength < 1 ? clamp01(asym.stepLength) : null;
  const arm = asym.armSwing != null && asym.armSwing < 1 ? clamp01(asym.armSwing) : null;
  if (rom == null && step == null && arm == null) return motion;
  const armed = arm == null ? motion : scaleLocomotorArmSwing(motion, arm, asym.side === 'left' ? 'L' : 'R');
  const keyframes = armed.keyframes.map((kf) => ({
    ...kf,
    ...(kf.targets
      ? {
          targets: kf.targets.map((t) => {
            if (!t.joint.startsWith(prefix)) return t;
            let f = 1;
            if (rom != null) f *= rom;
            if (step != null && ASYMMETRY_STRIDE_MOTIONS.has(t.motion)) f *= step;
            return f === 1 ? t : { ...t, targetDegrees: t.targetDegrees * f };
          }),
        }
      : {}),
  }));
  return { ...motion, keyframes };
}

/** Add a CONSTANT angle to a joint.motion across every keyframe (a sustained
 *  offset held through the whole movement) — additive on an existing target,
 *  else appended. The engine ROM-clamps + measures it on resolve, so the offset
 *  reads back on the goniometry chart. Shared by the gait-deviation transforms. */
export function addSustainedTargets(
  motion: ComposedMotion,
  additions: { joint: string; motion: string; deg: number }[],
): ComposedMotion {
  const keyframes = motion.keyframes.map((kf) => {
    const targets = [...(kf.targets ?? [])];
    for (const a of additions) {
      if (a.deg === 0) continue;
      const i = targets.findIndex((t) => t.joint === a.joint && t.motion === a.motion);
      if (i >= 0) targets[i] = { ...targets[i]!, targetDegrees: targets[i]!.targetDegrees + a.deg };
      else targets.push({ joint: a.joint, motion: a.motion, targetDegrees: a.deg });
    }
    return { ...kf, targets };
  });
  return { ...motion, keyframes };
}

/**
 * WIDER-BASED gait — hold both hips in `deg` of abduction throughout, so the feet
 * plant wider apart (an ataxic / unsteady wide base, or a compensation for poor
 * balance). Pure; ROM-clamped on resolve. Identity at 0.
 */
export function widenStep(motion: ComposedMotion, deg = 12): ComposedMotion {
  const d = Math.max(0, Math.min(30, Number.isFinite(deg) ? deg : 0));
  return addSustainedTargets(motion, [
    { joint: 'L_UpLeg', motion: 'hipAbduction', deg: d },
    { joint: 'R_UpLeg', motion: 'hipAbduction', deg: d },
  ]);
}

/**
 * ANTALGIC / compensated-Trendelenburg trunk lean — add lateral trunk
 * lean TOWARD `side` (over the involved/painful stance limb, shifting the COM to
 * unload it) during its stance phase. Lumbar leads, thoracic follows at half.
 * `lateralTilt` + = left, so a left lean is positive. Pure; ROM-clamped on resolve.
 */
export function antalgicLean(motion: ComposedMotion, side: 'left' | 'right', deg = 12): ComposedMotion {
  const d = Math.max(0, Math.min(25, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const sign = side === 'left' ? 1 : -1;
  return addGaitPhaseTargets(motion, side, 'stance', [
    { joint: 'Spine_Lower', motion: 'lateralTilt', deg: sign * d },
    { joint: 'Spine_Upper', motion: 'lateralTilt', deg: sign * Math.round(d * 0.5) },
  ]);
}

// ─── Natural spinal gait coordination ───────────────────────────────────────
// Physiologic caps (well inside the AROM in romRegistry): the excursions stay in
// the believable-normal band, never near end-range.
const SPINE_AXIAL_MAX = 14; // thoracic rotation cap (ROM ±35)
const SPINE_LUMBAR_AXIAL_MAX = 8; // lumbar rotation cap (tight ROM ±10)
// Cervical caps large enough to FULLY counter the trunk the head inherits (thoracic
// 14 + lumbar 8 = 22 axial; lateral 8 + 8 = 16) so gaze stabilization is never clipped
// short — well within cervical ROM (rotation ±80, lateral flexion ±45). Shared with the
// UNIVERSAL gaze stabilizer (stabilizeGaze) so both correct against the same cervical ROM.
// (SPINE_NECK_MAX / SPINE_NECK_LATERAL_MAX imported from motionSequence.)
const SPINE_LATERAL_MAX = 8; // trunk lateral-tilt cap (ROM ±25)
// SAGITTAL SPINE IN GAIT. This authoring used to be forbidden outright, and the
// comment on spinalGaitCoordination said so: "NEVER sagittal flexion, which would
// shift the world-anchored shoulderFlexion motor (trunkSum)". The coupling was
// real — shoulderFlexion is measured in a WORLD frame, so a flexed trunk moves the
// arm readout by the trunk's own angle. But `trunkSum` (motionSequence) was
// afterwards taught to compensate exactly that, and the ban outlived the problem:
// it left lumbar, thoracic AND cervical flexion reading a flat 0.00° through an
// entire walk, which is the defect this fixes.
//
// Measured cost of lifting it, walk without → with: shoulderFlexion p2p
// 39.88 → 38.88°, head lateral excursion 2.17 → 2.09 cm, worst stance-foot slide
// 2.62 → 2.62 cm. The compensation absorbs it; nothing downstream moves.
//
// THESE CAPS WERE FIRST SET FOUR TIMES TOO HIGH, and the mistake is worth
// keeping written down because the arithmetic error is easy to repeat.
//
// They shipped at 3 / 2.5, quoted as "lumbar ~4-6° p2p, thoracic ~3-5° p2p"
// against approximate bands. Two things were wrong. The bands themselves were
// too generous — the sagittal plane is the one plane in which a walking trunk is
// remarkably STILL, and its whole flexion/extension excursion is a couple of
// degrees, not five. And they STACK: lumbar and thoracic flex in phase, so the
// trunk's total pitch was their SUM, ~11° peak-to-peak twice per stride, with
// the neck's counter pumping on top. Reported from the deployed build as "a LOT
// of excess movement in the whole spine … looks very odd", which it was.
//
// The caps are HALF-excursions about neutral, so peak-to-peak is roughly double,
// and what matters visually is LUMBAR + THORACIC — the number to keep small.
// At 1.0 / 0.75 the whole trunk pitches ~3.5° peak-to-peak, which reads as
// texture on the stride rather than as a bob.
//
// Still declared conventions, not findings: trunk and cervical sagittal
// excursions in walking are not standardised to anything like the precision of
// the lower-limb norms. But a convention should sit at the quiet end of a range
// it cannot pin down, not the loud end — the failure mode of guessing high is
// visible and wrong, and guessing low is merely subtle.
// DAMPENED AGAIN (1.0/0.75 → 0.5/0.4), and for a different reason than the first
// cut, which is the point worth recording. The first cut fixed the trunk's own
// PITCH. This one fixes what that pitch does to the HEAD, which nothing was
// measuring: a trunk that flexes carries the head forward on a ~0.6 m lever, so
// the head slides fore-and-aft even while the neck's counter keeps it perfectly
// level. Reported from the deployed build as cervical protraction/retraction —
// which is exactly what a fore/aft head slide looks like, though the protraction
// CHANNEL measured 0.013° and was innocent.
//
//   head fore/aft carry relative to the pelvis, travel walk, p2p
//     sagittal spine OFF (the floor from pelvis tilt and trunk lean)   2.70 cm
//     at 1.0 / 0.75 as shipped                                         5.34 cm
//     at 0.5 / 0.4                                                     4.03 cm
//
// Damping is the right lever here and a cervical counter is not, which is worth
// stating because the counter is the intuitive fix. Protraction moves the head
// only ~0.066 cm per degree (rig-measured: 20° carries it 1.32 cm), so undoing
// 2.6 cm of carry would need ~40° against a ±20° band — and it would do it by
// ADDING the very cervical motion the report asked to quiet.
//
// The caps are HALF-excursions about neutral, so peak-to-peak is roughly double,
// and what matters visually is LUMBAR + THORACIC: they flex in phase, so the
// trunk's total pitch is their SUM and the head's carry follows that sum.
//
// Still declared conventions, not findings: trunk and cervical sagittal
// excursions in walking are not standardised to anything like the precision of
// the lower-limb norms. A convention should sit at the QUIET end of a range it
// cannot pin down — guessing high is visibly wrong, guessing low is subtle.
const SPINE_SAGITTAL_LUMBAR_MAX = 0.5; // ⇒ ~1° p2p (ROM −25..60)
const SPINE_SAGITTAL_THORACIC_MAX = 0.4; // ⇒ ~0.8° p2p (ROM −25..40)
// Sized to the SUM of the two above, so the neck cancels the trunk's pitch
// completely at rest energy. It under-cancels as the gait gets harder — not by
// a separate rule, but because `headStab` releases with locomotor intensity
// (HEADSTAB_ENERGY_RELAX, floored at 85%), which is the fatigue behaviour a real
// walker shows: gaze stabilisation is the first thing to go.
const SPINE_SAGITTAL_NECK_MAX = 0.9; // gaze counter, not an independent excursion
// Transverse pelvic-rotation cap (root yaw). Real free-gait pelvic rotation is ~±4°; 6°
// leaves a little headroom for speed while staying in a natural range (a bigger pelvic
// yaw reads as a twist/shimmy AND drags the planted foot, since the walk grounds the feet
// with a vertical pin, not a horizontal foot-lock IK — see kPel calibration below).
const PELVIS_YAW_MAX = 6;
// ─── The PELVIS, as a segment rather than a root fake ────────────────────────
// Pelvic rotation used to ride the MODEL ROOT's yaw. That is why all three
// pelvic channels measured hard zeros on a walk: rotateRestReferenceByRoot
// pre-rotates the pelvis reference by the root, so the fake cancelled itself
// out of its own readout. It now rides the Hips BONE, which is the pelvis —
// measurable, ROM-clamped, and reported to the clinical apps that consume it.
//
// The two compensations STAY, and they are not a workaround for the old fake:
// Hips parents both femurs and the spine, so a pelvis that turns carries the
// legs and the trunk with it either way. The hips counter-rotate so the planted
// feet keep pointing down the line of travel; the neck counter-rotates so the
// gaze holds forward. Both are anatomically real (that is what the hip rotators
// and the vestibulo-ocular reflex do in gait), and the rig-measured near-zero
// stance-foot swivel is what says the amount is right.
//
// OBLIQUITY and TILT did not exist at all — not faked, absent. Frontal-plane
// pelvic list is the single most clinically loaded pelvic channel (it is what
// Trendelenburg is), and the engine shipped a normativeGait constant for it
// carrying the caveat "the rig has NO pelvic-list DOF today… obliquity is NOT
// yet measurable". It has one now.
//
// PELVIC DROP is contralateral and that sign is the whole diagnostic value: the
// pelvis drops on the SWING side, controlled eccentrically by the STANCE hip
// abductors. Get it backwards and a normal walk reads as the compensated
// Trendelenburg pattern it is supposed to distinguish. Driven from the same
// hipDiff that drives the yaw, so it is phase-locked to stance by construction.
const PELVIC_OBLIQUITY_MAX = 5; // ~±4-6° peak list in normal free gait
// Sagittal pelvic tilt excursion is SMALL — a few degrees about a mean anterior
// tilt, twice per cycle (Perry). The mean itself is posture, not gait, so only
// the excursion is authored here.
const PELVIC_TILT_MAX = 2.5;
// Head stabilization grades with locomotor intensity.
const HEADSTAB_ENERGY_RELAX = 0.08; // headStabilize fraction released per energy unit — a
const HEADSTAB_ENERGY_FLOOR = 0.85; // runner's head rides a touch more; never below 85%.
/** Locomotor-intensity ceiling: buildRun's 1.6 speed cap × the run's energy
 *  factor of 2 (RUN_ENERGY_FACTOR, authored beside the run builders). */
const ENERGY_MAX = 3.2;
const HIP_ADD_GAIN = 0.18; // the SWING leg ADducts toward the midline (a narrow base) as it
const HIP_FLEX_MEAN = 10; // advances — the feet track near the line of progression, NOT
const HIP_ADD_MAX = 6; // splayed out (abduction, which reads as a wide waddle/circumduction)
const KNEE_ROT_GAIN = 0.08; // the tibia rotates with knee flexion (the screw-home unwinds)
const KNEE_ROT_MAX = 8;
const ANK_INV_GAIN = 0.22; // foot everts at loading (pronation), inverts at push-off (supination)
const ANK_INV_MAX = 8;
// Neck lateral compensation for the roll leaked by the (large) axial neck counter — rig-fit
// so the head's side-to-side tip nulls out. Sign/gain calibrated on the walk (see spinalCoord).
const NECK_AXIAL_ROLL_COMP = 0.28;
// Sharing axial rotation through the curved Mid/Upper thorax translates the
// head laterally as well as turning it. A small lumbar counterbend absorbs that
// translation; the existing neck counter still levels the resulting orientation.
// Rig-calibrated on both bodies, not an anatomical fixed coupling ratio.
const THORACIC_AXIAL_LEAN_COMP = 0.2;

/**
 * NATURAL SPINAL GAIT COORDINATION — the reciprocal trunk motion that makes gait
 * read as a human instead of a rigid torso riding on moving legs. Per keyframe it
 * ADDS three physiologic, ROM-safe spine excursions DERIVED from the motion the
 * keyframe already commands, so they stay phase-locked to the stride and scale with
 * its vigour for free (no cycle clock needed):
 *   • Axial counter-rotation — the thorax/shoulder girdle rotates with the arm
 *     swing (its angular-momentum partner), driven by the reciprocal shoulder-flexion
 *     asymmetry. A damped arm swing (Parkinsonian/hemiplegic) therefore yields a
 *     damped trunk rotation automatically. Lumbar follows at a third; the neck
 *     counter-rotates to hold the gaze forward (vestibulo-collic head stabilisation).
 *   • Lateral trunk sway — a few degrees of lateral flexion TOWARD the stance
 *     (less-flexed) hip each step, damped through any airborne phase.
 *   • Sagittal trunk flexion/extension — twice per stride, flexing around each
 *     double support and extending through mid-stance, with the neck countering
 *     so the gaze stays level. This was BANNED here until the `trunkSum`
 *     compensation in motionSequence made the ban unnecessary; see the note on
 *     SPINE_SAGITTAL_LUMBAR_MAX for what lifting it actually cost (measured:
 *     nothing downstream).
 *   • Scapular upward rotation + posterior tilt with the arm swing — the girdle
 *     channels the scapulohumeral rhythm structurally cannot reach, because that
 *     split models elevation and never engages below 60°. See SCAP_UPROT_GAIN.
 * All three planes of the spine are now authored. Feet, leg angles
 * and every graded driver are untouched (the spine sits above the hips). Additive on
 * any existing spine target (e.g. an antalgic lean), ROM-clamped on resolve. Identity
 * when both gains are 0. Sign of `rotation` follows romRegistry (+ = toward-R); the
 * chosen phase brings the leading arm's shoulder forward — a visual-tuning choice.
 * DISTAL ENERGY (roadmap 5.4): the distal constants (finger curl, wrist drag, elbow
 * pump, head stabilization) grade with locomotor intensity — see `opts.energy`.
 */
export function spinalGaitCoordination(
  motion: ComposedMotion,
  opts: {
    axial?: number;
    lateral?: number;
    headStabilize?: number;
    pelvis?: number;
    /** DISTAL ENERGY (roadmap 5.4): locomotor intensity ≥ 1 grading the distal
     *  constants toward run form — the finger curl opens, the elbow pump and
     *  wrist drag grow, the head stabilization relaxes a touch. When omitted it
     *  is DERIVED from the motion's paceGait cadence (`modifiers.timeScale` =
     *  √speed ⇒ energy = speed); the run builders pass their own (a run ≈ 2×
     *  walking intensity). 1 — a speed-1 walk — is byte-identical. */
    energy?: number;
    /** SHUTTLE ABSORPTION (travel walk): the medio-lateral pelvis shuttle
     *  (`lateralShuttleCm`) translates the whole body toward the stance foot,
     *  and without a counter the head would ride the full excursion. This adds
     *  the thoracic S-curve that absorbs it: a trunk lateral counter-lean, in
     *  phase with the shuttle, split lumbar/thoracic — so the pelvis visibly
     *  shuttles under a quiet, centred head (the vestibular head-steadiness the
     *  rig gates require). `phaseAt(tMs)` is the planned shuttle phase in
     *  [−1, 1] along +X (subject-left) at a keyframe's authored arrival time;
     *  `deg` the total counter-lean at full shuttle. Folded into the SAME
     *  lean/neck terms as the stance sway, so the neck roll compensation keeps
     *  the head level too. */
    shuttleAbsorb?: { phaseAt: (tMs: number) => number; deg: number };
  } = {},
): ComposedMotion {
  const kAx = Math.max(0, opts.axial ?? 0.16);
  // Lateral sway is SMALL in real gait — the trunk stays near-vertical in the frontal
  // plane (~2-4° lean toward the stance limb); a big side-to-side lean reads as a waddle,
  // and the transverse counter-ROTATION (kAx) should dominate the trunk's gait character.
  // (0.09 measured ~13° of thorax lateral roll on the rig — a lurch; 0.03 lands ~4°.)
  const kLat = Math.max(0, opts.lateral ?? 0.03);
  // DISTAL ENERGY (roadmap 5.4): explicit from the caller (the run builders), else
  // derived from a paced gait's cadence (paceGait sets timeScale = √speed, so
  // timeScale² recovers the speed request). Clamped ≥ 1 — a slow walk keeps the
  // walker's hand — so a speed-1 gait has dE = 0 and every term below reduces to
  // its exact pre-energy constant (byte-identical output).
  const tsMod = motion.modifiers?.timeScale;
  const energyRaw =
    opts.energy ?? (typeof tsMod === 'number' && Number.isFinite(tsMod) ? tsMod * tsMod : 1);
  const energy = Math.min(ENERGY_MAX, Math.max(1, Number.isFinite(energyRaw) ? energyRaw : 1));
  const dE = energy - 1;
  const headStab =
    Math.max(0, Math.min(1, opts.headStabilize ?? 1)) *
    Math.max(HEADSTAB_ENERGY_FLOOR, 1 - HEADSTAB_ENERGY_RELAX * dE);
  // PELVIC transverse rotation gain — the hallmark determinant of gait (the pelvis rotates
  // forward on the SWING side). Derived from the same leg asymmetry as the lean, so it is
  // intrinsically in phase with the stride. 0.05 lands ~±2° pelvic yaw for the walk — the
  // most the vertical-pin grounding allows before the planted foot visibly slides (a
  // higher gain skates the stance foot; rig-swept). A real foot-lock IK would let this go
  // to the full physiological ~±4°.
  const kPel = Math.max(0, opts.pelvis ?? 0.05);
  // Obliquity and tilt scale off the SAME pelvis authority as the yaw, so a
  // caller that turns the pelvis off turns all three off together and a motion
  // that never asked for pelvic coordination is byte-identical.
  // kObl lands the measured obliquity peak at ~2.8°, BELOW the 4-6° normative
  // peak, and that is a deliberate trade rather than a miss. A listing pelvis
  // rotates the femurs, and this walk grounds its feet with a vertical pin plus
  // a foot-plant IK — not a horizontal foot-lock — so obliquity buys itself in
  // foot fidelity. Rig-measured as the gain was raised: at the fully physiologic
  // 3.9° the planted stance foot slid 3.3 cm against a 3.0 cm gate, and the
  // termination standstill ramp lost a frame of double support (89.6% against a
  // 90% floor). The amplitude is limited by the rig's GROUNDING, not by
  // physiology; a real horizontal foot-lock IK is what would let it go the rest
  // of the way — the same missing piece the original root-yaw note called out.
  // The channel's diagnostic content is intact at this amplitude: the drop is
  // still contralateral and phase-locked to the swing limb at r = 0.994.
  const kObl = kPel > 0 ? 0.065 : 0;
  const kTilt = kPel > 0 ? 0.05 : 0;
  // Sagittal trunk ON/OFF. There is no gain here on purpose: the amplitude comes
  // from the caps, and the SHAPE from the normalised stride envelope below, so
  // the excursion is the same at walk and sprint energy rather than growing with
  // a driver that has no reason to stay in band. Gated on the SPINE gains rather
  // than the pelvis one, so it rides with the coordination it belongs to and the
  // identity guarantee on the next line stays exact.
  const kSag = kAx > 0 || kLat > 0 ? 1 : 0;
  const shuttleAbsorb = opts.shuttleAbsorb;
  if (kAx === 0 && kLat === 0 && kPel === 0 && !shuttleAbsorb) return motion;
  const cap = (v: number, m: number): number => Math.max(-m, Math.min(m, v));
  const at = (ts: SequenceTarget[], joint: string, mo: string): number =>
    ts.find((t) => t.joint === joint && t.motion === mo)?.targetDegrees ?? 0;
  // Authored arrival time of each keyframe (cumulative travel + holds) — the
  // time base the shuttle-absorb phase function is sampled at.
  const arriveMs: number[] = [];
  {
    let cursor = 0;
    for (const kf of motion.keyframes) {
      cursor += kf.durationMs ?? 0;
      arriveMs.push(cursor);
      cursor += kf.holdMs ?? 0;
    }
  }
  // LOCAL STRIDE AMPLITUDE — the running envelope of |hipDiff| over each
  // keyframe's neighbourhood. This is what lets the sagittal trunk oscillation
  // (below) scale itself instead of carrying a hard-coded amplitude, and it
  // fixes two defects a fixed constant produced, both rig-measured:
  //
  //   • SATURATION. A fixed centre calibrated on the walk (|hipDiff| peaks ~48°)
  //     rails on the run, whose |hipDiff| reaches ~74° — the trace flat-topped at
  //     BOTH ends of every cycle, the same defect protraction already has at run
  //     energy (docs/outstanding-work.md 3.6). Normalising by the envelope makes
  //     the excursion the same shape at any gait energy.
  //   • A FALSE LEAN AT STANDSTILL. |hipDiff| → 0 when the gait terminates, which
  //     against a fixed centre reads as maximum EXTENSION — the walk settled into
  //     a 3.4° backward lean it should never have had. Against the envelope it
  //     reads as "no stride", and the oscillation fades out with the gait.
  //
  // A neighbourhood max rather than the whole motion's, so a gait that starts,
  // travels and stops fades in and out with its own stride rather than being
  // scaled by its most vigorous moment throughout.
  const hipDiffAt: number[] = motion.keyframes.map((kf) =>
    kf.targets
      ? at(kf.targets, 'L_UpLeg', 'hipFlexion') - at(kf.targets, 'R_UpLeg', 'hipFlexion')
      : 0,
  );
  const strideEnvelope: number[] = hipDiffAt.map((_, i) => {
    let m = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(hipDiffAt.length - 1, i + 1); j += 1)
      m = Math.max(m, Math.abs(hipDiffAt[j]!));
    return m;
  });
  // How vigorous this keyframe's stride is against the motion's OWN best. The
  // normalised drive alone is not enough to kill the standstill lean: at the
  // termination |hipDiff| is 0 while a neighbour still carries a full stride, so
  // the ratio reads −1 (maximum extension) instead of "no stride". This fades the
  // whole excursion out with the gait, and is 1 through any steady stretch.
  const strideVigour: number[] = (() => {
    const peakEnv = Math.max(0, ...strideEnvelope);
    return strideEnvelope.map((e) => (peakEnv > 1 ? Math.min(1, e / (peakEnv * 0.6)) : 0));
  })();
  const keyframes = motion.keyframes.map((kf, kfIndex) => {
    const ts = kf.targets;
    if (!ts || !ts.length) return kf;
    // Reciprocal arm-swing asymmetry drives the thoracic axial rotation; loaded-leg
    // asymmetry drives the lateral lean AND the pelvic rotation. All are already present
    // in the keyframe, so the result is intrinsically in phase with the stride.
    const armDiff = at(ts, 'R_UpperArm', 'shoulderFlexion') - at(ts, 'L_UpperArm', 'shoulderFlexion');
    const hipDiff = at(ts, 'L_UpLeg', 'hipFlexion') - at(ts, 'R_UpLeg', 'hipFlexion');
    const airborne = kf.stance === 'floating' ? 0.35 : 1;
    const thoracic = cap(-kAx * armDiff, SPINE_AXIAL_MAX); // thorax rotates with the girdle
    const lumbar = cap(-kAx * 0.3 * armDiff, SPINE_LUMBAR_AXIAL_MAX); // lumbar follows
    const pelvisYaw = cap(kPel * hipDiff, PELVIS_YAW_MAX);
    // PELVIC OBLIQUITY (frontal list). hipDiff > 0 means the LEFT hip is more
    // flexed — left is swinging — so the pelvis drops on the LEFT. lateralTilt is
    // + toward subject-LEFT (romRegistry), so the drop is +hipDiff. Scaled off
    // the same phase signal as the yaw, so it cannot drift out of step with
    // stance. Ramped by the same shuttle/stance authority the trunk lean uses is
    // deliberately NOT done here: obliquity is driven by the swing limb, not by
    // the shuttle.
    const pelvicObliquity = cap(kObl * hipDiff, PELVIC_OBLIQUITY_MAX);
    // SAGITTAL TILT: twice-per-cycle, so it follows |hipDiff| rather than its
    // sign — the pelvis tilts anteriorly around each double-support and settles
    // back through mid-stance.
    const pelvicTilt = cap(kTilt * (Math.abs(hipDiff) - 20), PELVIC_TILT_MAX);
    // TRUNK SAGITTAL — twice per stride, on the same |hipDiff| driver the pelvic
    // tilt uses and for the same reason: the trunk flexes slightly around each
    // DOUBLE SUPPORT (hips maximally split, |hipDiff| peaks) and extends back
    // through each MID-STANCE (hips passing, |hipDiff| ≈ 0). Two flexion peaks
    // per stride, phase-locked to the stride for free — no cycle clock, exactly
    // as everything else derived here.
    // Normalised to [−1, +1] against this keyframe's own stride envelope: +1 at
    // maximum hip split (double support, peak flexion), −1 as the hips pass
    // (mid-stance, peak extension). A keyframe with no stride around it — a
    // standstill, or a spine-only motion run through this coordinator — has no
    // envelope and so contributes nothing, which is the correct answer for both.
    const env = strideEnvelope[kfIndex] ?? 0;
    const sagDrive =
      env > 1 ? ((Math.abs(hipDiff) / env) * 2 - 1) * (strideVigour[kfIndex] ?? 0) : 0;
    // Both segments flex TOGETHER, the thoracic contributing less — the simple
    // claim, and the one worth making without better evidence than I have. An
    // earlier revision counter-phased the thoracic into a sagittal S-curve and
    // justified it as protecting the arms from `trunkSum`; that justification was
    // wrong. The arm regressions it claimed to fix were the per-keyframe target
    // cap silently amputating the right side (see MAX_TARGETS_PER_KEYFRAME), and
    // they survived the S-curve untouched — identical to nine decimal places,
    // which is what an amputation looks like and a perturbation never does.
    //
    // `trunkSum` coupling IS real, just small: it adds lumbar + thoracic to every
    // shoulderFlexion command so the world-anchored arm readout still lands on
    // its commanded value, and at this amplitude that moved the walk's shoulder
    // excursion 39.88 → 38.88°. Measured, not assumed.
    const lumbarFlex = kSag > 0 ? SPINE_SAGITTAL_LUMBAR_MAX * sagDrive : 0;
    const thoracicFlex = kSag > 0 ? SPINE_SAGITTAL_THORACIC_MAX * sagDrive : 0;
    const lean = -kLat * hipDiff * airborne; // lean toward the stance (less-flexed) hip
    // SHUTTLE-ABSORB counter-lean: opposite the pelvis shuttle (phase is +X-ward,
    // lateralTilt + = toward subject-left/+X, so −phase counters it), split
    // lumbar/thoracic so the tilt sits low (long lever, minimal thorax roll).
    const shuttleLean = shuttleAbsorb ? -shuttleAbsorb.deg * shuttleAbsorb.phaseAt(arriveMs[kfIndex]!) : 0;
    // PELVIC-OBLIQUITY ABSORPTION. The pelvis is the BASE of the spine, so a
    // pelvis that lists carries the whole trunk — and the head — with it. In life
    // it does not: the lumbar spine side-bends toward the STANCE limb to keep the
    // trunk upright and the COM over the base, which is the same eccentric
    // control that produced the drop in the first place. Without this, authoring
    // physiologic obliquity on the bone reads as a waddle — rig-measured 13.3° of
    // lateral trunk lean (band <8°) and 9.4 cm of head sway (band <2.5 cm),
    // because the pelvis had never actually moved before and nothing downstream
    // had to answer for it. Counter-sign, and the same lumbar/thoracic split the
    // shuttle absorption already uses.
    const obliquityLean = pelvicObliquity;
    const leanLower = cap(lean + 0.45 * shuttleLean + 1.0 * obliquityLean
      + THORACIC_AXIAL_LEAN_COMP * thoracic, SPINE_LATERAL_MAX);
    // The thoracic COUNTER-lists (an S-curve): the lumbar lists toward the stance limb
    // (the physiologic weight shift), but the upper trunk leans back the other way so the
    // shoulders — and the head above them — stay centred over the base. A person's head
    // barely bobs laterally in gait (vestibular stabilisation); compounding the lean at the
    // top (the old +0.5) threw the head side-to-side. Neck leveling handles the residual.
    const leanUpper = cap(-0.6 * lean + 0.55 * shuttleLean + 0.45 * obliquityLean, SPINE_LATERAL_MAX);
    // PELVIC ROTATION (root yaw): the swing side rotates forward. Counter-phase to the
    // thorax (below), so the pelvis and shoulder girdle COUNTER-ROTATE about the spine —
    // the real transverse-plane engine of gait. The hips counter-rotate by −pelvisYaw so
    // the planted feet keep pointing down the line of travel (no swivel) while the pelvis
    // turns; and the neck cancels the root yaw too, so the gaze still holds forward.
    // GAZE STABILIZATION (vestibulo-ocular): the head hangs off the top of the spine, so
    // without correction it inherits the WHOLE trunk's axial rotation — the pelvic root
    // yaw PLUS the thoracic + lumbar rotation — and the eyes swing off the line of travel.
    // Counter-rotate the neck by exactly what the head would inherit (headStab 1 = fully
    // stable; 0 = head rides the trunk). A motion that drives the neck itself isn't run
    // through here.
    const neckAxial = cap(-headStab * (pelvisYaw + thoracic + lumbar), SPINE_NECK_MAX);
    // The neck's axial counter is large (it cancels the whole trunk's yaw for gaze), and it
    // acts about a slightly forward-inclined cervical axis, so it LEAKS a few degrees of head
    // roll — the head tips side-to-side each stride even though it's not authored to. Cancel
    // that induced roll with a small lateral counter proportional to the axial counter
    // (rig-fit gain), so the head stays level as well as forward.
    // The head hangs off the top of the whole chain, so what it inherits is the
    // PELVIS's list plus both trunk leans — not just the trunk. Before the pelvis
    // was a real segment the first term was identically zero and could be
    // omitted; now it is not, and omitting it leaves the head rolling ~8.8° a
    // stride (band <2.5°) even with the trunk itself upright.
    // The head hangs off the top of the whole chain, so what it inherits is the
    // pelvis's RESIDUAL list plus both trunk leans — not just the trunk. Before
    // the pelvis was a real segment that first term was identically zero and
    // could be omitted; now it is not, and omitting it leaves the head rolling
    // ~8.8° a stride (band <2.5°) even with the trunk itself upright.
    //
    // The sign is −obliquityLean, and getting it wrong is not subtle: leanLower
    // ALREADY carries the absorption, so what is left un-absorbed at the top of
    // the lumbar is the residual, not the raw list. Adding it with the same sign
    // double-counts and over-drives the neck to 9.9° of cervical lateral flexion
    // — past the 8° this coordination authoring caps itself at, and far past
    // anything a walking neck does.
    const neckLateral = cap(
      -headStab * (-obliquityLean + leanLower + leanUpper) + NECK_AXIAL_ROLL_COMP * neckAxial,
      SPINE_NECK_LATERAL_MAX,
    );
    // CERVICAL SAGITTAL — the same gaze logic the axial and lateral counters use,
    // on the third plane. The head sits on top of the trunk, so trunk flexion
    // would pitch the gaze at the ground twice a stride; the neck gives it back.
    // This is a COUNTER, not an independent excursion, which is the honest
    // description: a walking neck's own sagittal contribution is small, and the
    // motion that is actually visible here is the head staying level while the
    // trunk beneath it does not.
    const neckSagittal = cap(-headStab * (lumbarFlex + thoracicFlex), SPINE_SAGITTAL_NECK_MAX);
    const additions: { joint: string; motion: string; deg: number }[] = [
      { joint: 'Spine_Upper', motion: 'rotation', deg: thoracic },
      { joint: 'Spine_Lower', motion: 'rotation', deg: lumbar },
      { joint: 'Neck', motion: 'rotation', deg: neckAxial },
      { joint: 'Spine_Lower', motion: 'flexion', deg: lumbarFlex },
      { joint: 'Spine_Upper', motion: 'flexion', deg: thoracicFlex },
      { joint: 'Neck', motion: 'flexion', deg: neckSagittal },
      { joint: 'Spine_Lower', motion: 'lateralTilt', deg: leanLower },
      { joint: 'Spine_Upper', motion: 'lateralTilt', deg: leanUpper },
      { joint: 'Neck', motion: 'lateralTilt', deg: neckLateral },
      // Hips counter-rotate the pelvic yaw so the femurs (and planted feet) keep facing
      // down the line of travel — the pelvis turns ABOUT the stance leg, the foot barely
      // swivels (rig-measured near-0 on the stance leg). Same sign on both legs (the
      // hipRotation motor is NOT mirrored in world yaw — verified on the rig).
      { joint: 'L_UpLeg', motion: 'hipRotation', deg: -pelvisYaw },
      { joint: 'R_UpLeg', motion: 'hipRotation', deg: -pelvisYaw },
      // THE PELVIS ITSELF — on the bone, so it is measurable.
      { joint: 'Hips', motion: 'rotation', deg: pelvisYaw },
      { joint: 'Hips', motion: 'lateralTilt', deg: pelvicObliquity },
      { joint: 'Hips', motion: 'anteriorTilt', deg: pelvicTilt },
    ];
    // LIMB NON-SAGITTAL COORDINATION — subtle frontal/transverse limb motion so the arms
    // and legs don't swing as flat 2-D pendulums. Per-limb, from that limb's own sagittal
    // phase; each gated on the limb having its sagittal driver (so it only touches a gait
    // keyframe, never a spine-only motion run through here).
    const has = (joint: string, mo: string): boolean => ts.some((t) => t.joint === joint && t.motion === mo);
    for (const S of ['L', 'R'] as const) {
      // LEG: the SWING leg ADducts toward the midline as it advances (the feet track near
      // the line of progression — a narrow base), NOT abducts (a wide, waddling splay); the
      // tibia rotates with knee flexion; the foot everts at loading and inverts at push-off
      // (the subtalar pronation→supination roll). Adduction (−hipAbduction) is SWING-ONLY
      // (0 while the hip is extended) — a frontal target on the planted leg would fight the
      // foot-plant IK and drag the stance foot.
      if (has(`${S}_UpLeg`, 'hipFlexion')) {
        const hip = at(ts, `${S}_UpLeg`, 'hipFlexion');
        additions.push({ joint: `${S}_UpLeg`, motion: 'hipAbduction', deg: cap(-HIP_ADD_GAIN * Math.max(0, hip - HIP_FLEX_MEAN), HIP_ADD_MAX) });
      }
      if (has(`${S}_Leg`, 'kneeFlexion'))
        additions.push({ joint: `${S}_Leg`, motion: 'kneeRotation', deg: cap(-KNEE_ROT_GAIN * at(ts, `${S}_Leg`, 'kneeFlexion'), KNEE_ROT_MAX) });
      if (has(`${S}_Foot`, 'ankleFlexion'))
        additions.push({ joint: `${S}_Foot`, motion: 'ankleInversion', deg: cap(-ANK_INV_GAIN * at(ts, `${S}_Foot`, 'ankleFlexion'), ANK_INV_MAX) });
    }
    const targets = [...ts];
    for (const a of additions) {
      if (Math.abs(a.deg) < 1e-6) continue;
      const i = targets.findIndex((t) => t.joint === a.joint && t.motion === a.motion);
      if (i >= 0) targets[i] = { ...targets[i]!, targetDegrees: targets[i]!.targetDegrees + a.deg };
      else targets.push({ joint: a.joint, motion: a.motion, targetDegrees: a.deg });
    }
    // NO root yaw. Pelvic rotation is a SEGMENT, and it is authored on the Hips
    // bone above. Writing it to the root instead is what made it unmeasurable:
    // the measurement frame removes root orientation by design (a body walking a
    // curve must read its joints relative to its own facing), so a pelvic
    // rotation parked on the root cancels itself out of the pelvic readout.
    return { ...kf, targets };
  });
  return coordinateLocomotorArms({ ...motion, keyframes }, energy);
}
