/**
 * CLINICIAN-AUTHORED MOVEMENT TEMPLATES — the data.
 *
 * The template vocabulary and the MOVEMENT_TEMPLATES library itself, split out of
 * movementTemplates.ts so the ~1,280 lines of clinician-authored content are not
 * interleaved with the motion builders that consume them. Pure declarative data:
 * it references nothing defined elsewhere in the original module, which is what
 * made this the safe cut to make first.
 *
 * Every value is clinician-authored from standard kinesiology (e.g. Neumann,
 * *Kinesiology of the Musculoskeletal System*; scapulohumeral rhythm ~2:1) and is
 * flagged for SME verification, exactly like the ROM registry — a reviewed
 * reference, not mocap.
 *
 * See movementTemplates.ts for how these are rendered into the compose prompt
 * (describeMovementTemplates) and turned into playable motions
 * (templateToComposedMotion).
 */

import type {
  SemanticTravel,
  SequenceKeyframe,
  StanceMode,
} from './motionSequence';


/** One joint's peak angle within a phase (absolute clinical degrees). */
export interface TemplateTarget {
  joint: string;
  motion: string;
  peakDeg: number;
  /** OPTIONAL intra-phase LEAD: the fraction (0..1] of this phase's travel at
   *  which this joint reaches its peak and holds. Default 1 (arrive at the phase
   *  boundary, lockstep). A value < 1 makes the joint LEAD its phase-mates — e.g.
   *  the ankle dorsiflexes to ~0.87 while the knee/hip complete at ~0.99 in a
   *  squat descent. Realized by `expandPeakTiming` (run inside
   *  resolveComposedMotion) as ordered sub-keyframes; the settled peak is
   *  unchanged, so ROM validation and goniometric measurement are untouched. */
  peakAt?: number;
}

/** One timed phase of a movement: the joint peaks reached by its end, how long
 *  the travel into it takes, and how long it dwells there. */
export interface TemplatePhase {
  name: string;
  durationMs: number;
  holdMs?: number;
  stance?: StanceMode;
  targets: TemplateTarget[];
  /** OPTIONAL semantic whole-body travel for this phase (pass-through to the
   *  keyframe's `travel` sugar) — used by the scripted-perturbation balance
   *  strategies to displace the body over its planted feet. Root state persists
   *  forward, so a later phase must re-state travel to return to 0. */
  travel?: SemanticTravel;
  /** OPTIONAL raw root transform for this phase (pass-through to the keyframe's
   *  `root`). The balance strategies use a small `orient.pitchDeg` (a few deg,
   *  well under the lying-posture thresholds) so a scripted sway pivots the whole
   *  body forward rigidly — paired with a matching `travel` so the feet stay at
   *  their floor spots by construction (the ankle-pivot inverted pendulum). */
  root?: SequenceKeyframe['root'];
}

/** A weight-bearing foot-contact window declared by PHASE INDEX (robust to
 *  duration edits): the foot is IK-pinned from the start of `fromPhase` to the
 *  end (incl. hold) of `toPhase`. Omit either bound for motion start/end; omit
 *  both for a whole-motion pin. Converted to absolute-ms {@link StanceContact}
 *  windows by {@link templateToComposedMotion}. */
export interface TemplateContactWindow {
  foot: string;
  fromPhase?: number;
  toPhase?: number;
}

export interface MovementTemplate {
  id: string;
  label: string;
  /** Instruction keywords that select this template (lowercased substrings). */
  aliases: string[];
  /** One-line clinician note on the coordination the template teaches. */
  coordination: string;
  stance: StanceMode;
  /** Cycle the phases until stopped (locomotion / repetitive movements). The
   *  LAST phase must flow back into the FIRST — the loop seam is a real
   *  transition the stage tweens through. Default false (one-shot). */
  loop?: boolean;
  /** COM-driven postural control: run the sampled/staged motion through the
   *  `balanceCoordination` pre-pass, which measures the COM-vs-base offset per
   *  keyframe and adds the RESIDUAL re-centering the authored counterbalance
   *  below doesn't cover. Set on the quasi-static balance-demand templates
   *  (single-leg stance, kick, endpoint reach). */
  balanceAssist?: boolean;
  /** OPTIONAL foot-plant contact windows (phase-indexed; see
   *  {@link TemplateContactWindow}) — the stance foot of a scripted-perturbation
   *  strategy is IK-pinned so nothing slides while the body is displaced. */
  contacts?: TemplateContactWindow[];
  phases: TemplatePhase[];
  source: string;
}

const VERIFY = 'clinician-authored from standard kinesiology; verify with SME';

export const MOVEMENT_TEMPLATES: MovementTemplate[] = [
  {
    id: 'squat',
    label: 'Bodyweight squat',
    aliases: ['squat', 'deep squat', 'bodyweight squat', 'sit back'],
    coordination:
      'Hip and knee flex together (~1:1.2 to a deep/parallel bottom), the ankle dorsiflexes to advance the shin, and the trunk leans forward ~25° to keep the centre of mass over the mid-foot. Bilateral, planted. Sequencing: peak ankle dorsiflexion and pelvic tilt occur slightly EARLIER in the descent (~86-90%) than peak knee/hip/lumbar flexion (~98-99%, at the bottom) [Kim 2020]. Note: a true deep squat demands ~30° weight-bearing dorsiflexion; the engine caps active ankle DF at 20° (a standing-AROM norm), so 20° is the binding constraint here, not the biological target.',
    stance: 'planted',
    phases: [
      {
        name: 'descent-to-bottom',
        durationMs: 1000,
        holdMs: 350,
        // INTRA-PHASE LEAD (Kim 2020: ankle ~86-90% vs knee/hip ~98-99% of the
        // descent): the ankle dorsiflexion peaks EARLIER (~80%) — the shin
        // advances over the foot to carry the COM forward — while the knee/hip/
        // trunk complete at the bottom. Without this the descent is lockstep and
        // reads robotic over its 1 s travel. A single lead keeps the sub-phase gap
        // (~200 ms) above the velocity floor so phase timing stays exact.
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 100 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 100 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 120 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 120 },
          // Weight-bearing dorsiflexion (~32°, closed-chain WB max is 35°): the
          // shin advances over the planted foot so the knees track forward and the
          // pelvis does NOT over-sit-back behind the heels. This is the ROOT-cause
          // fix — the old 20° open-chain cap forced the backward CoM excursion.
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 32, peakAt: 0.8 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 32, peakAt: 0.8 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 27 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 10 },
          // Light arm-forward reach — the natural bodyweight-squat counterweight
          // that trims the CoM the last few cm over the mid-foot.
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 60 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 60 },
        ],
      },
      {
        name: 'ascent-to-stand',
        durationMs: 1000,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'forward-hip-hinge',
    label: 'Forward hip-hinge / toe-touch',
    aliases: ['toe touch', 'touch your toes', 'forward bend', 'hip hinge', 'bend forward', 'reach for the floor'],
    coordination:
      'A hip-dominant hinge: most of the excursion is hip flexion, with the lumbar then thoracic spine flexing to round the reach, and the knees only softly unlocking. Planted.',
    stance: 'planted',
    phases: [
      {
        name: 'bend-down',
        durationMs: 1200,
        holdMs: 350,
        // INTRA-PHASE LEAD: a hip-dominant hinge initiates at the HIPS — the hips
        // (and the soft knee unlock) lead (~80%) while the lumbar then thoracic
        // spine round to reach for the floor at the end of range. Realizes the
        // "hinge first, then round the spine" sequence the coordination note
        // describes, instead of hip and spine folding in lockstep. The ~240 ms
        // sub-phase gap stays above the velocity floor so phase timing is exact.
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 70, peakAt: 0.8 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 70, peakAt: 0.8 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 40 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 20 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 12, peakAt: 0.8 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 12, peakAt: 0.8 },
        ],
      },
      {
        name: 'return-upright',
        durationMs: 1200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'shoulder-flexion-elevation',
    label: 'Shoulder flexion (forward elevation)',
    aliases: ['raise your arm', 'reach overhead', 'shoulder flexion', 'lift your arm forward', 'arm overhead', 'forward elevation'],
    coordination:
      'Humerothoracic (goniometric) forward elevation to ~120° functional — this matches the mean forward elevation used across activities of daily living [Namdari 2012: 121°]; full physiologic range is ~160-170° (AAOS ideal 180°). Scapulohumeral rhythm averages ~2:1 (glenohumeral : scapular upward rotation) BEYOND the first ~30° "setting phase" (in which motion is predominantly glenohumeral and the scapula stabilises); the ratio varies with elevation and load [Inman 1944; Neumann; McQuade & Smidt 1998]. At the full 180° arc this yields ~120° GH + ~60° scapular; at this 120° functional target, ~85° GH + ~35° scapular upward rotation. Do NOT command the scapula separately — the humerothoracic readout already includes it. Shown on the right; mirror for the left or do both.',
    stance: 'floating',
    phases: [
      {
        name: 'elevate',
        durationMs: 1200,
        holdMs: 300,
        targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 120 }],
      },
      {
        name: 'lower',
        durationMs: 1200,
        targets: [{ joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 }],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'shoulder-abduction-elevation',
    label: 'Shoulder abduction (lateral elevation)',
    aliases: ['abduct', 'lateral raise', 'raise your arm out to the side', 'shoulder abduction', 'arm out to the side'],
    coordination:
      'Humerothoracic (goniometric) lateral elevation to ~120° functional — near the mean abduction used across activities of daily living [Namdari 2012: 128°]; full physiologic range is ~160-170° (AAOS ideal 180°). Same scapulohumeral rhythm ~2:1 BEYOND the first ~30° setting phase (predominantly glenohumeral early), varying with elevation and load; at this 120° target ~85° GH + ~35° scapular upward rotation. Do NOT command the scapula separately; the humerothoracic readout already includes it. Shown on the right.',
    stance: 'floating',
    phases: [
      {
        name: 'abduct',
        durationMs: 1200,
        holdMs: 300,
        targets: [{ joint: 'R_UpperArm', motion: 'shoulderAbduction', peakDeg: 120 }],
      },
      {
        name: 'lower',
        durationMs: 1200,
        targets: [{ joint: 'R_UpperArm', motion: 'shoulderAbduction', peakDeg: 0 }],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'high-knee-march',
    label: 'High-knee march (reciprocal, in place)',
    aliases: ['march', 'high knee', 'marching', 'step in place', 'lift your knees'],
    coordination:
      'Reciprocal open-chain stepping, deliberately exaggerated vs normal gait (normal swing peaks ~30° hip / ~60° knee; arm swing ~20-25°): one hip and knee flex to lift the leg while the CONTRALATERAL arm swings forward (~38° — the amplified march arm), then the sides alternate — the cross-body coordination of gait, without travel.',
    stance: 'floating',
    phases: [
      {
        name: 'right-knee-up',
        durationMs: 550,
        holdMs: 120,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 60 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 80 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 38 },
        ],
      },
      {
        name: 'lower-right',
        durationMs: 450,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
        ],
      },
      {
        name: 'left-knee-up',
        durationMs: 550,
        holdMs: 120,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 60 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 80 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 38 },
        ],
      },
      {
        name: 'lower-left',
        durationMs: 450,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'walk',
    label: 'Walk (gait cycle, in place)',
    aliases: ['walk', 'walking', 'gait', 'ambulate', 'stroll'],
    coordination:
      'One full gait cycle authored as 8 phases (both steps), looping. Sagittal peaks per normal free gait [Perry & Burnfield; Neumann]: hip 30° flexion at initial contact → −10° extension at terminal stance; knee ~5° at contact, ~18° loading-response shock absorption, ~40° at pre-swing, ~60° peak in initial swing; ankle rockers — plantarflexion to foot-flat after contact (−8°), dorsiflexion to 10° as the tibia advances over the stance foot, push-off plantarflexion −15° at pre-swing. THIRD (forefoot) rocker: as the heel rises the foot pivots at the MTP joints — toe extension builds through terminal stance (~12°) and peaks at pre-swing push-off (~28°; normative MTP extension in gait ~30° [Perry & Burnfield]), releasing to neutral through swing so the foot is flat again at contact. Reciprocal arm swing ~±20° shoulder flexion, each arm peaking WITH the contralateral leg. The elbows are NOT rigid: they carry ~20° flexion and pump through the swing (overlapping action — more flexion on the backswing, unwinding as the arm comes forward, ~11-30°), so the forearms swing dynamically instead of marching stiff-armed [Elftman 1939; normal arm-swing elbow excursion ~10-20°]. Presented IN PLACE (treadmill convention — no root travel) so the looping cycle stays on stage; the pre-swing knee flexion + push-off happens across the loop seam (last phase flows back into the first). Planted.',
    stance: 'planted',
    loop: true,
    // PERRY PHASE TIMING (wave 4.2): the 8 phase durations follow physiologic
    // gait-cycle fractions instead of a metronomic 8×200 ms. Each phase's
    // duration is the interval ENDING at its named pose, so per half-cycle
    // (800 ms of the 1.6 s cycle, both sums unchanged — cadence/pace gates
    // hold): loading response is BRISK (160 ms ≈ 10% of the cycle — weight
    // acceptance is quick), mid-stance and terminal stance are LONG (236 ms ≈
    // 14.75% each — the slow rollover of single support), and the arrival at
    // the next initial contact is QUICK (168 ms ≈ 10.5% — the contralateral
    // pre-swing push-off). Best 8-keyframe fit to Perry's ~12/19/19/12%
    // stance-phase splits under the half-cycle sum + velocity-governor
    // constraints (the contact keyframe reaches a 40° knee delta from neutral,
    // so its interval must stay ≥167 ms at the 240°/s deliberate cap); the
    // ~60:40 stance:swing rhythm emerges [Perry & Burnfield]. Gated in
    // gaitPerryTiming.test.ts.
    phases: [
      {
        name: 'right-initial-contact',
        durationMs: 168,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 0 }, // foot flat at contact
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 40 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -15 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 28 }, // L push-off: third-rocker MTP extension peak
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 11 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 29 },
        ],
      },
      {
        name: 'right-loading-response',
        durationMs: 160,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 25 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 18 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -8 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 60 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -5 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 5 }, // toes release as the L foot enters swing
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 14 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -14 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 14 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 26 },
        ],
      },
      {
        name: 'right-mid-stance',
        durationMs: 236,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 8 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 5 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 20 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 45 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 20 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 20 },
        ],
      },
      {
        name: 'right-terminal-stance',
        durationMs: 236,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 10 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 12 }, // R heel-off: MTP extension building
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -14 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 14 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 26 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 14 },
        ],
      },
      {
        name: 'left-initial-contact',
        durationMs: 168,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 0 }, // foot flat at contact
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 40 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -15 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 28 }, // R push-off: third-rocker MTP extension peak
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 11 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 29 },
        ],
      },
      {
        name: 'left-loading-response',
        durationMs: 160,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 25 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 18 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -8 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 60 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -5 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 5 }, // toes release as the R foot enters swing
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 14 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -14 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 14 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 26 },
        ],
      },
      {
        name: 'left-mid-stance',
        durationMs: 236,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 8 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 5 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 20 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 45 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 20 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 20 },
        ],
      },
      {
        name: 'left-terminal-stance',
        durationMs: 236,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 10 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 12 }, // L heel-off: MTP extension building (peaks at the loop seam)
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -14 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 14 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 26 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 14 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'sit-to-stand',
    label: 'Sit-to-stand',
    aliases: ['sit to stand', 'stand up from a chair', 'sit-to-stand', 'rise from sitting', 'get up from the chair'],
    coordination:
      'The defining feature is the forward trunk/hip lean ("nose over toes") that brings the centre of mass over the feet BEFORE the hips and knees extend to rise — flexion momentum first, then extension [Schenkman 1990: flexion-momentum → momentum-transfer → extension]. The lean is HIP-DRIVEN with a relatively PRESERVED lumbar lordosis (only slight lumbar flexion) — heavy lumbar flexion is a compensatory/faulty pattern, not the healthy norm. ARM STRATEGY (roadmap 5.6): a natural STS pushes off the thighs — the hands rest on the thighs seated, PRESS into them through the lean (shoulders following the trunk, wrists extending as the trunk pivots over the planted hands), the elbows EXTEND through the push-off as the hips leave the seat, and the arms release to a relaxed hang at upright. The hand targets are AUTHORED here, so the universal relaxedHands transform skips this template (the author owns the hands). Bilateral, planted. (No chair prop; the seated depth is the hip/knee flexion hold.)',
    stance: 'planted',
    phases: [
      {
        name: 'seated',
        durationMs: 700,
        holdMs: 300,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 85 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 85 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 95 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 95 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 12 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 12 },
          // Hands resting on the thighs: the arm hangs slightly forward and
          // ADDUCTS ~20° so the hand comes IN over the thigh (the shoulders are
          // wider than the knees — without the adduction the hand hangs ~25 cm
          // lateral of the femur line, rig-swept); slight elbow bend, wrist
          // extended so the palm lies on the thigh. Rig-calibrated: wrist ~9 cm
          // off the femur AXIS ≈ palm on the thigh surface.
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 10 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 10 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: -20 },
          { joint: 'R_UpperArm', motion: 'shoulderAbduction', peakDeg: -20 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 18 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 18 },
          { joint: 'L_Hand', motion: 'wristFlexion', peakDeg: -18 },
          { joint: 'R_Hand', motion: 'wristFlexion', peakDeg: -18 },
        ],
      },
      {
        name: 'lean-forward',
        durationMs: 500,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 105 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 105 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 95 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 95 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 18 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 18 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 12 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 10 },
          // Hands PRESS into the thighs as the trunk pivots over them: the
          // shoulders follow the lean, the elbows BEND to take the load, the
          // wrists extend a little further. Rig-calibrated ~10 cm off the femur
          // axis (still riding the thigh).
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 15 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 15 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: -20 },
          { joint: 'R_UpperArm', motion: 'shoulderAbduction', peakDeg: -20 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 45 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 45 },
          { joint: 'L_Hand', motion: 'wristFlexion', peakDeg: -24 },
          { joint: 'R_Hand', motion: 'wristFlexion', peakDeg: -24 },
        ],
      },
      {
        // The thigh push-off (Schenkman momentum-transfer): the hips leave the
        // seat and the ELBOWS EXTEND as the hands drive down the thighs.
        name: 'push-off',
        durationMs: 350,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 55 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 55 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 55 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 55 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 10 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 10 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 8 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 6 },
          // The elbows EXTEND (45° → 14°) as the hands drive down the thighs —
          // the visible push. Rig-calibrated ~10 cm off the femur axis.
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 5 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 5 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: -20 },
          { joint: 'R_UpperArm', motion: 'shoulderAbduction', peakDeg: -20 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 14 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 14 },
          { joint: 'L_Hand', motion: 'wristFlexion', peakDeg: -14 },
          { joint: 'R_Hand', motion: 'wristFlexion', peakDeg: -14 },
        ],
      },
      {
        name: 'rise-to-stand',
        durationMs: 450,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
          // Arms RELEASED at upright — a relaxed hang at the sides (slight
          // elbow bend, adduction released), the hands off the thighs.
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderAbduction', peakDeg: 0 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 8 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 8 },
          { joint: 'L_Hand', motion: 'wristFlexion', peakDeg: 0 },
          { joint: 'R_Hand', motion: 'wristFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'forward-lunge',
    label: 'Forward lunge / split squat',
    aliases: ['lunge', 'split squat', 'forward lunge', 'stationary lunge'],
    coordination:
      'Split stance: the LEAD hip and knee flex (~75°/90° at a 90°-knee bottom) while the TRAIL knee flexes ~90° with its hip near-neutral/slightly extended, and the trunk stays close to vertical. Shown with the right leg leading. Planted.',
    stance: 'planted',
    phases: [
      {
        name: 'descend',
        durationMs: 900,
        holdMs: 300,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 75 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 90 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 90 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 8 },
        ],
      },
      {
        name: 'rise',
        durationMs: 900,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'single-leg-stance',
    label: 'Single-leg stance (balance)',
    aliases: ['single leg stance', 'stand on one leg', 'single-leg balance', 'balance on one foot', 'one-legged stance'],
    coordination:
      'Stand on the left leg and lift the right: the lifted hip flexes ~30° and its knee ~45°. ANTICIPATORY POSTURAL ADJUSTMENT (APA) + AUTHORED COUNTERBALANCE — a real person shifts the pelvis laterally OVER the stance foot BEFORE the foot leaves the floor (real APAs lead the limb lift by 200-400 ms): a dedicated first "load the stance side" phase (~350 ms) completes the whole postural set — closed-chain stance-hip abduction leaning the body over the planted foot, a trunk list toward the stance side, the stance-side arm floating out for counterbalance — while BOTH feet are still grounded; only then does the lift phase raise the leg (the lifted leg adducting its mass toward midline). The counterbalance is authored strong enough to project the COM INSIDE the one-foot base on its own (rig-measured mid-hold margin ~+3.8 cm; min one-foot margin −4.2 cm uncounterbalanced → positive), so the balanceAssist pre-pass finds little residual and is essentially IDENTITY here — like the endpoint reach, the authored values carry the balance and stay deterministic. The COM-X shift toward the stance foot completes ≥150 ms before swing-foot lift-off (the temporal-order rig gate, apaLeads.test.ts). Long hold = the balance challenge; a final settle phase re-centres onto both feet. Planted (stance leg).',
    stance: 'planted',
    balanceAssist: true,
    phases: [
      {
        // APA (Wave 3, roadmap 3.1): the weight shift PRECEDES the limb lift.
        // The counterbalance is authored strong (arm float + trunk list + stance-
        // hip abduction) so the COM is over the one-foot base by the authored pose
        // alone — the balanceAssist is (near-)identity, which keeps the motion
        // fully deterministic (its counterbalance channels are a stable movement
        // signature in a chain, not assist-jittered). The shift is COMPLETE at
        // this phase's settle — the point of an APA. The lifted-to-be leg is NOT
        // pre-adducted here (its foot is still planted; adducting a planted foot
        // swings it through the floor) — its mass rides to midline WITH the lift.
        // Closed-chain sign note: with the stance foot planted (foot-rooted),
        // stance-hip ABduction leans the body OVER the stance foot — rig-measured;
        // authoring adduction moves the COM the wrong way.
        name: 'load-stance-side',
        durationMs: 350,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipAbduction', peakDeg: 10 },
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 10 }, // + = toward stance (L)
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 5 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: 32 }, // stance-side arm floats out
        ],
      },
      {
        // The stance side is already loaded — now the foot can leave the floor,
        // and the long hold is the balance challenge. The counterbalance set is
        // re-authored here (held at the same magnitudes through the balance) and
        // the lifted leg adducts toward midline WITH the lift.
        name: 'lift-and-balance',
        durationMs: 700,
        holdMs: 1500,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_UpLeg', motion: 'hipAbduction', peakDeg: -12 }, // lifted leg adducts to midline
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 45 },
          { joint: 'L_UpLeg', motion: 'hipAbduction', peakDeg: 10 },
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 10 },
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 5 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: 32 },
        ],
      },
      {
        // Lower the lifted leg AND re-centre: the foot lands (double support), so
        // the counterbalance eases off WITH it — the postural set is no longer
        // needed once weight is shared. Releasing it here (rather than holding it
        // into a separate phase) keeps the measurement frame upright at this
        // settle. The strong authored lean is essentially assist-identity, so this
        // release is honest kinematics, not fighting a live controller.
        name: 'lower-and-recenter',
        durationMs: 700,
        holdMs: 150,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipAbduction', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_UpLeg', motion: 'hipAbduction', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: 0 },
        ],
      },
      {
        // Quiet double-support stance — a brief settled hold to end on.
        name: 'settle',
        durationMs: 400,
        holdMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'heel-raise',
    label: 'Heel raise (bilateral calf raise)',
    aliases: ['heel raise', 'heel raises', 'calf raise', 'calf raises', 'go up on your toes', 'rise onto your toes', 'up on your toes'],
    coordination:
      'Bilateral ankle plantarflexion: rise up onto the balls of the feet so both heels lift, hold at the top, then lower under control back to flat. A gastrocnemius-soleus screen. The foot HINGES AT THE MTP joints: as the heel rises the toes stay planted and the MTP extends by roughly the plantarflexion angle (~40°), so the pivot is the ball of the foot — NOT en-pointe (toes continuing the foot line, a ballet relevé). Planted (the forefoot/toes stay grounded as the pivot; the closed-chain floor-pin lifts the body so the heels rise). Normative standing plantarflexion AROM ~50°; ~35° is a full functional raise.',
    stance: 'planted',
    phases: [
      {
        name: 'rise-to-toes',
        durationMs: 800,
        holdMs: 500,
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -35 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -35 },
          // MTP extension keeps the toe pads flat on the floor as the heel rises —
          // the third-rocker hinge (≈ plantarflexion + a few degrees; ROM max 70°).
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 40 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 40 },
        ],
      },
      {
        name: 'lower-to-flat',
        durationMs: 800,
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_Toes', motion: 'toeFlexion', peakDeg: 0 },
          { joint: 'R_Toes', motion: 'toeFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'cervical-rotation',
    label: 'Cervical rotation (AROM screen)',
    aliases: ['turn your head', 'cervical rotation', 'rotate your neck', 'look left and right', 'neck rotation'],
    coordination:
      'Pure axial rotation of the neck — rotate fully to one side, return to centre, then the other, keeping flexion and side-bend near zero. AROM ~70° each way (normative ~80°).',
    stance: 'floating',
    phases: [
      {
        name: 'rotate-left',
        durationMs: 700,
        holdMs: 300,
        targets: [{ joint: 'Neck', motion: 'rotation', peakDeg: 70 }],
      },
      {
        name: 'centre-1',
        durationMs: 500,
        targets: [{ joint: 'Neck', motion: 'rotation', peakDeg: 0 }],
      },
      {
        name: 'rotate-right',
        durationMs: 700,
        holdMs: 300,
        targets: [{ joint: 'Neck', motion: 'rotation', peakDeg: -70 }],
      },
      {
        name: 'centre-2',
        durationMs: 500,
        targets: [{ joint: 'Neck', motion: 'rotation', peakDeg: 0 }],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'lumbar-flexion-extension',
    label: 'Lumbar flexion / extension (AROM screen)',
    aliases: ['bend your back', 'lumbar flexion', 'arch your back', 'lumbar extension', 'trunk flexion and extension', 'flex and extend your spine'],
    coordination:
      'Spine-dominant trunk AROM (distinct from the hip-hinge, which is hip-dominant): round forward into flexion through the lumbar then thoracic spine, return, then extend backward. Little hip motion.',
    stance: 'planted',
    phases: [
      {
        name: 'flex-forward',
        durationMs: 1000,
        holdMs: 300,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 55 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 25 },
        ],
      },
      {
        name: 'return-1',
        durationMs: 800,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
        ],
      },
      {
        name: 'extend-back',
        durationMs: 1000,
        holdMs: 300,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: -20 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: -10 },
        ],
      },
      {
        name: 'return-2',
        durationMs: 800,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  // ── Frontal / transverse-plane AROM screens ─────────────────────────────────
  // The command layer already carries these tri-planar DOF; these templates expose
  // them as goniometry screens (the sagittal library was near-complete, the
  // frontal/transverse plane was not). Each is a bidirectional AROM sweep.
  {
    id: 'shoulder-rotation',
    label: 'Shoulder rotation (IR / ER AROM screen)',
    aliases: ['shoulder rotation', 'shoulder internal rotation', 'shoulder external rotation', 'rotate your shoulder', 'shoulder ir and er'],
    coordination:
      'Shoulder held at the side / 90° abducted: rotate the arm internally then externally through the available range, keeping the scapula quiet. AROM ~70° internal, ~90° external (transverse plane).',
    stance: 'floating',
    phases: [
      { name: 'internal', durationMs: 700, holdMs: 300, targets: [{ joint: 'R_UpperArm', motion: 'shoulderRotation', peakDeg: 65 }] },
      { name: 'centre-1', durationMs: 500, targets: [{ joint: 'R_UpperArm', motion: 'shoulderRotation', peakDeg: 0 }] },
      { name: 'external', durationMs: 700, holdMs: 300, targets: [{ joint: 'R_UpperArm', motion: 'shoulderRotation', peakDeg: -80 }] },
      { name: 'centre-2', durationMs: 500, targets: [{ joint: 'R_UpperArm', motion: 'shoulderRotation', peakDeg: 0 }] },
    ],
    source: VERIFY,
  },
  {
    id: 'hip-rotation',
    label: 'Hip rotation (IR / ER AROM screen)',
    aliases: ['hip rotation', 'hip internal rotation', 'hip external rotation', 'rotate your hip', 'rotate the leg inward and outward'],
    coordination:
      'Open-chain hip rotation: turn the thigh internally then externally through the available range, pelvis level. AROM ~45° each way (transverse plane).',
    stance: 'floating',
    phases: [
      { name: 'internal', durationMs: 700, holdMs: 300, targets: [{ joint: 'R_UpLeg', motion: 'hipRotation', peakDeg: 40 }] },
      { name: 'centre-1', durationMs: 500, targets: [{ joint: 'R_UpLeg', motion: 'hipRotation', peakDeg: 0 }] },
      { name: 'external', durationMs: 700, holdMs: 300, targets: [{ joint: 'R_UpLeg', motion: 'hipRotation', peakDeg: -40 }] },
      { name: 'centre-2', durationMs: 500, targets: [{ joint: 'R_UpLeg', motion: 'hipRotation', peakDeg: 0 }] },
    ],
    source: VERIFY,
  },
  {
    id: 'forearm-rotation',
    label: 'Forearm pronation / supination (AROM screen)',
    aliases: ['forearm rotation', 'pronation and supination', 'pronate and supinate', 'turn your palm up and down', 'forearm pronation supination'],
    coordination:
      'Elbow flexed 90° at the side: rotate the forearm to supination (palm up) then pronation (palm down). AROM ~85° supination, ~80° pronation (transverse plane).',
    stance: 'floating',
    phases: [
      { name: 'supinate', durationMs: 700, holdMs: 300, targets: [{ joint: 'R_Forearm', motion: 'forearmRotation', peakDeg: 80 }] },
      { name: 'centre-1', durationMs: 500, targets: [{ joint: 'R_Forearm', motion: 'forearmRotation', peakDeg: 0 }] },
      { name: 'pronate', durationMs: 700, holdMs: 300, targets: [{ joint: 'R_Forearm', motion: 'forearmRotation', peakDeg: -75 }] },
      { name: 'centre-2', durationMs: 500, targets: [{ joint: 'R_Forearm', motion: 'forearmRotation', peakDeg: 0 }] },
    ],
    source: VERIFY,
  },
  {
    id: 'wrist-flexion-extension',
    label: 'Wrist flexion / extension (AROM screen)',
    aliases: ['wrist flexion', 'wrist extension', 'wrist flexion and extension', 'bend your wrist', 'flex and extend your wrist'],
    coordination:
      'Forearm supported, hand free: flex the wrist then extend it through the available range. AROM ~80° flexion, ~70° extension (sagittal plane).',
    stance: 'floating',
    phases: [
      { name: 'flex', durationMs: 600, holdMs: 300, targets: [{ joint: 'R_Hand', motion: 'wristFlexion', peakDeg: 75 }] },
      { name: 'centre-1', durationMs: 450, targets: [{ joint: 'R_Hand', motion: 'wristFlexion', peakDeg: 0 }] },
      { name: 'extend', durationMs: 600, holdMs: 300, targets: [{ joint: 'R_Hand', motion: 'wristFlexion', peakDeg: -65 }] },
      { name: 'centre-2', durationMs: 450, targets: [{ joint: 'R_Hand', motion: 'wristFlexion', peakDeg: 0 }] },
    ],
    source: VERIFY,
  },
  {
    id: 'wrist-deviation',
    label: 'Wrist deviation (radial / ulnar AROM screen)',
    aliases: ['wrist deviation', 'radial deviation', 'ulnar deviation', 'radial and ulnar deviation'],
    coordination:
      'Forearm pronated, hand free: deviate the wrist radially then ulnarly. AROM ~20° radial, ~30° ulnar (frontal plane).',
    stance: 'floating',
    phases: [
      { name: 'radial', durationMs: 550, holdMs: 250, targets: [{ joint: 'R_Hand', motion: 'wristDeviation', peakDeg: 18 }] },
      { name: 'centre-1', durationMs: 400, targets: [{ joint: 'R_Hand', motion: 'wristDeviation', peakDeg: 0 }] },
      { name: 'ulnar', durationMs: 550, holdMs: 250, targets: [{ joint: 'R_Hand', motion: 'wristDeviation', peakDeg: -28 }] },
      { name: 'centre-2', durationMs: 400, targets: [{ joint: 'R_Hand', motion: 'wristDeviation', peakDeg: 0 }] },
    ],
    source: VERIFY,
  },
  {
    id: 'tibial-rotation',
    label: 'Tibial rotation (knee IR / ER AROM screen)',
    aliases: ['tibial rotation', 'knee rotation', 'rotate your shin', 'tibial internal and external rotation'],
    coordination:
      'Knee flexed ~90°, thigh fixed: rotate the tibia internally then externally. AROM ~25° internal, ~35° external (transverse plane).',
    stance: 'floating',
    phases: [
      { name: 'internal', durationMs: 600, holdMs: 250, targets: [{ joint: 'R_Leg', motion: 'kneeRotation', peakDeg: 22 }] },
      { name: 'centre-1', durationMs: 450, targets: [{ joint: 'R_Leg', motion: 'kneeRotation', peakDeg: 0 }] },
      { name: 'external', durationMs: 600, holdMs: 250, targets: [{ joint: 'R_Leg', motion: 'kneeRotation', peakDeg: -30 }] },
      { name: 'centre-2', durationMs: 450, targets: [{ joint: 'R_Leg', motion: 'kneeRotation', peakDeg: 0 }] },
    ],
    source: VERIFY,
  },
  {
    id: 'trunk-side-bend',
    label: 'Trunk lateral flexion (side-bend AROM screen)',
    aliases: ['trunk side bend', 'side bend', 'lateral flexion', 'bend to the side', 'lateral trunk flexion', 'side-bend left and right'],
    coordination:
      'Standing, pelvis level: side-bend the trunk left then right, sliding the hand down the thigh, through the lumbar then thoracic spine. AROM ~25° each way (frontal plane). Planted.',
    stance: 'planted',
    phases: [
      {
        name: 'bend-left',
        durationMs: 800,
        holdMs: 300,
        targets: [
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 22 },
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 12 },
        ],
      },
      {
        name: 'centre-1',
        durationMs: 600,
        targets: [
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 0 },
        ],
      },
      {
        name: 'bend-right',
        durationMs: 800,
        holdMs: 300,
        targets: [
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: -22 },
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: -12 },
        ],
      },
      {
        name: 'centre-2',
        durationMs: 600,
        targets: [
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'cervical-lateral-flexion',
    label: 'Cervical lateral flexion (side-bend AROM screen)',
    aliases: ['cervical lateral flexion', 'neck side bend', 'ear to shoulder', 'tilt your head side to side', 'head side bend'],
    coordination:
      'Bring the ear toward the shoulder on each side, keeping rotation and flexion near zero. AROM ~45° each way (frontal plane).',
    stance: 'floating',
    phases: [
      { name: 'left', durationMs: 700, holdMs: 300, targets: [{ joint: 'Neck', motion: 'lateralTilt', peakDeg: 40 }] },
      { name: 'centre-1', durationMs: 500, targets: [{ joint: 'Neck', motion: 'lateralTilt', peakDeg: 0 }] },
      { name: 'right', durationMs: 700, holdMs: 300, targets: [{ joint: 'Neck', motion: 'lateralTilt', peakDeg: -40 }] },
      { name: 'centre-2', durationMs: 500, targets: [{ joint: 'Neck', motion: 'lateralTilt', peakDeg: 0 }] },
    ],
    source: VERIFY,
  },
  {
    id: 'kick',
    label: 'Forward leg kick (dynamic hip flexion / knee extension)',
    aliases: ['kick', 'kicks', 'kicking', 'leg kick', 'front kick', 'kick forward'],
    coordination:
      'Stand on the left leg and kick the right forward: the kicker FIRST loads the stance side (a dedicated ~320 ms anticipatory weight shift onto the left leg — real APAs precede a limb action by 200-400 ms), then a brief wind-up (hip extends ~15°, knee flexes ~40°) and a powerful strike where the hip flexes ~65° while the knee whips toward extension (~5°), then recover to neutral. The knee LEADS the hip late in the strike (peakAt) — the shank snaps out after the thigh. ANTICIPATORY POSTURAL ADJUSTMENT + AUTHORED COUNTERBALANCE + BALANCE ASSIST — the load phase completes the closed-chain stance-hip abduction (leaning the body over the planted foot), trunk list toward the stance side and stance-side arm float BEFORE the kicking foot leaves the ground (rig-gated: the COM-X shift toward the stance foot completes ≥150 ms before lift-off); held through the strike, released once the foot is back down. The template authors the SHAPE (de-tuned since Wave 2); the balanceCoordination pre-pass measures the residual COM-vs-base offset and tops the same channels up (rig-measured: min margin of stability −4.9 cm uncounterbalanced → positive with assist). Planted (stance leg). Shown kicking with the right leg.',
    stance: 'planted',
    balanceAssist: true,
    phases: [
      {
        // APA (Wave 3, roadmap 3.1): load the stance side BEFORE the kick leg
        // moves — the weight shift precedes the limb action, as in life.
        // COUNTERBALANCE values onto the stance (left) leg (ROM-safe). Wave 2:
        // DE-TUNED from the Wave-1 values (10/8/4/25) — the authored targets
        // carry the shape, balanceCoordination tops up the residual.
        // Closed-chain sign note: stance-hip ABduction leans the planted-foot body
        // over the stance foot (see single-leg-stance).
        name: 'load-stance-side',
        durationMs: 320,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipAbduction', peakDeg: 6 },
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 5 }, // + = toward stance (L)
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 2 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: 15 },
        ],
      },
      {
        name: 'wind-up',
        durationMs: 450,
        holdMs: 120,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: -15 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 40 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: -6 },
          // Re-authored WITH the wind-up trunk extension: mentioning Spine_Lower
          // rebuilds the joint with exactly the commanded motions, so the APA
          // list must ride along or it would be wiped back to 0 here. The other
          // APA channels (L hip, Spine_Upper, L arm) are NOT re-mentioned — they
          // carry (hold) from the load phase.
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 5 },
        ],
      },
      {
        name: 'strike',
        durationMs: 380,
        holdMs: 100,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 65 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5, peakAt: 0.75 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 6 },
          // Counterbalance HELD at full through the strike (re-authored lockstep;
          // same Wave-2 de-tuned values as the wind-up).
          { joint: 'L_UpLeg', motion: 'hipAbduction', peakDeg: 6 },
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 5 },
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 2 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: 15 },
        ],
      },
      {
        // Lower the kicking leg; counterbalance HOLDS (carry-over — still single-
        // support until the foot lands), then releases in the settle phase.
        name: 'recover',
        durationMs: 520,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
        ],
      },
      {
        // Foot is down (double support) — re-centre the weight over both feet.
        name: 'settle',
        durationMs: 400,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipAbduction', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'lateralTilt', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'lateralTilt', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderAbduction', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'endpoint-reach',
    label: 'Functional forward/overhead reach (endpoint reach)',
    aliases: ['reach', 'reaching', 'reach forward', 'reach up', 'functional reach', 'reach for something', 'reach overhead'],
    coordination:
      'Reach the right arm forward and up toward a target: the shoulder flexes ~140° as the elbow extends toward straight (~5°), with a small forward trunk lean (~10°) carrying the reach to its endpoint; hold at the target, then return to rest. AUTHORED COUNTERBALANCE + BALANCE ASSIST — as the trunk and arm go forward the HIPS shift BACKWARD (a slight bilateral closed-chain hip hinge: pelvis travels back over the planted feet) and the free left arm trails behind the trunk line, so the reach does not simply carry the whole body mass forward (rig-measured: the COM ground-projection stays well inside the base, min margin of stability +6.3 cm, and the forward COM excursion is counterweighted by the ~10 cm hips-back shift). The balanceCoordination pre-pass verifies the residual: with the authored hinge the reach measures safely balanced at every keyframe, so the assist is identity here (its gate in balance.test.ts) — the authored values are kept, not de-tuned. Planted. Shown reaching with the right arm.',
    stance: 'planted',
    balanceAssist: true,
    phases: [
      {
        name: 'reach-to-target',
        durationMs: 800,
        holdMs: 500,
        targets: [
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 140 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 5 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 10 },
          // COUNTERBALANCE (rig-tuned, ROM-safe): a small bilateral hip hinge sends
          // the pelvis BACKWARD over the planted feet as the reach goes forward,
          // and the free arm counters behind the trunk line.
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 6 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 6 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -25 },
        ],
      },
      {
        name: 'return',
        durationMs: 800,
        targets: [
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  // ── Balance-strategy library (Wave 3, roadmap 3.4) — core PT teaching content ─
  // The three postural-recovery strategies [Horak & Nashner 1986; Shumway-Cook &
  // Woollacott], each with a SCRIPTED perturbation (deterministic authored
  // keyframes — no physics, no live controller, per the kinematic charter) and a
  // strategy-specific recovery. The forward sway is realized as a rigid whole-body
  // pivot: a small root pitch leans the body forward as an inverted pendulum. The
  // feet are IK-pinned (declared `contacts`), so the base of support stays FIXED
  // while the COM travels forward over it — the margin of stability genuinely
  // narrows — and the ankle goniometry honestly reads the sway angle (the shin
  // rotating forward over the fixed foot = dorsiflexion). Rig-gated
  // (balanceStrategies.test): the margin dips on the perturbation and recovers
  // positive by the settle, with the correct per-strategy joint signature.
  {
    id: 'ankle-strategy',
    label: 'Ankle strategy (balance recovery)',
    aliases: ['ankle strategy', 'balance recovery', 'balance strategy', 'postural sway recovery', 'recover with the ankles'],
    coordination:
      'The FIRST-LINE response to a SMALL perturbation on a firm, broad surface: the body sways forward as a rigid inverted pendulum pivoting at the ANKLES — trunk and hips stay quiet — and is recovered by ankle musculature alone (plantarflexor torque brakes the sway and returns the COM), the ankles rolling dorsiflexion → slight plantarflexion → neutral. The COM stays INSIDE the base of support throughout (that is what makes the ankle strategy sufficient); the margin of stability narrows on the sway (rig-measured ~8.4 cm → ~3.5 cm) and re-centres by the settle. Joint signature: ankle excursion dominates — more than double any hip or spine excursion (trunk/hips stay rigid). Both feet stay flat and planted (IK-pinned); the sway is a rigid root pitch with the ankles dorsiflexing to keep the soles flat.',
    stance: 'planted',
    contacts: [{ foot: 'L_Foot' }, { foot: 'R_Foot' }], // both feet pinned — the base of support stays fixed as the body sways over it
    phases: [
      {
        name: 'quiet-stance',
        durationMs: 400,
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
        ],
      },
      {
        // SCRIPTED PERTURBATION: a forward sway — the whole body pivots ~7°
        // forward (root pitch) over the pinned feet; the ankles dorsiflex by the
        // same amount so the soles stay flat (the shin rotates forward over the
        // fixed foot — the ankle-strategy geometry). Trunk RIGID (no spine/hip).
        name: 'sway-forward',
        durationMs: 450,
        holdMs: 250,
        root: { orient: { pitchDeg: 7 } },
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 7 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 7 },
        ],
      },
      {
        // ANKLE RECOVERY: plantarflexor torque brakes and reverses the sway —
        // the body pivots back upright (pitch returns to 0) with a small
        // plantarflexion overshoot as the calves push the COM back.
        name: 'ankle-recovery',
        durationMs: 550,
        root: { orient: { pitchDeg: 0 } },
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -2 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -2 },
        ],
      },
      {
        name: 'settle',
        durationMs: 450,
        holdMs: 300,
        root: { orient: { pitchDeg: 0 } },
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'hip-strategy',
    label: 'Hip strategy (balance recovery)',
    aliases: ['hip strategy', 'hip balance strategy', 'trunk counter flexion recovery', 'recover with the hips'],
    coordination:
      'The response to a LARGER perturbation (or a narrow/compliant surface, where ankle torque cannot re-centre the COM): the trunk pitches forward — the scripted sway — and the recovery is a RAPID trunk/hip counter-flexion over near-NEUTRAL ankles: the hips flex briskly as the trunk flexes forward, jack-knifing the pelvis BACKWARD over the planted feet (the closed-chain hinge carries the heavy pelvis/thigh mass back, re-centring the COM), then the body settles upright. Joint signature: hip + trunk excursion dominates while the ankles stay near neutral — the frontier between this and a toe-touch is the SPEED and the balance context, not the shape. Margin of stability: dips on the sway (further than the ankle strategy allows), recovers positive through the hinge, re-centres at the settle. Planted (closed-chain foot-rooting places the pelvis).',
    stance: 'planted',
    phases: [
      {
        name: 'quiet-stance',
        durationMs: 400,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
        ],
      },
      {
        // SCRIPTED PERTURBATION: a larger forward sway — the trunk pitches
        // forward (the upper-body mass carries the COM toward the toes) while
        // the ankles stay neutral (the surface context that FORCES the hip
        // strategy: ankle torque is unavailable).
        name: 'sway-forward',
        durationMs: 450,
        holdMs: 200,
        targets: [
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 28 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 14 },
        ],
      },
      {
        // HIP RECOVERY: rapid hip flexion + further trunk flexion — the classic
        // jack-knife. Closed-chain (foot-rooted) hip flexion translates the
        // pelvis BACKWARD over the planted feet, re-centring the COM.
        name: 'hip-recovery',
        durationMs: 350,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 34 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 16 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
        ],
      },
      {
        name: 'settle-upright',
        durationMs: 700,
        holdMs: 300,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
  {
    id: 'stepping-strategy',
    label: 'Stepping strategy (protective step)',
    aliases: ['stepping strategy', 'protective step', 'step to recover', 'step reaction', 'take a step to catch yourself'],
    coordination:
      'The response to the LARGEST perturbation — when the COM is driven OUTSIDE the base of support and no in-place strategy can recover it, the base must be moved UNDER the COM: a quick protective FORWARD step. The scripted push pivots the whole body ~7° forward over the feet and the right leg swings quickly forward (the swing narrows the base to the single stance foot — margin of stability goes NEGATIVE, rig-measured ~−6 cm); the stepping foot then plants well ahead, extending the base forward under the falling COM (margin recovers positive at the brace); the body pushes back off the front foot and the stepping foot returns beside the stance foot, quiet stance resumes (feet re-levelled). The STANCE (left) foot carries a foot-plant contact for the whole motion so it never slides while the body pivots and the step lands. Joint signature: a real step — the stepping foot\'s world position advances ~0.2 m, plants for the brace, and returns. Planted.',
    stance: 'planted',
    contacts: [{ foot: 'L_Foot' }], // stance foot IK-pinned for the whole motion (never slides)
    phases: [
      {
        name: 'quiet-stance',
        durationMs: 350,
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
        ],
      },
      {
        // SCRIPTED PERTURBATION: the big push — a ~7° rigid forward pivot (root
        // pitch) over the planted feet; the ankles dorsiflex to keep the soles
        // flat. The COM is carried toward the front of the base.
        name: 'perturbation-push',
        durationMs: 300,
        root: { orient: { pitchDeg: 7 } },
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 7 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 7 },
        ],
      },
      {
        // PROTECTIVE STEP: the right leg swings quickly forward (rapid
        // hip-flexion/knee-flexion step-through) while the pinned left foot
        // bears alone — the base collapses to one foot and the forward-falling
        // COM leaves it (margin goes negative). Body still pitched forward.
        name: 'protective-step',
        durationMs: 260,
        root: { orient: { pitchDeg: 7 } },
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 35 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 50 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 7 },
        ],
      },
      {
        // PLANT + BRACE: the stepping foot lands well ahead (near-extended knee,
        // the foot reaching the floor), the stance side eases as the body lowers
        // onto the new, forward-extended two-foot base — the COM is back INSIDE
        // the enlarged base and the margin recovers positive. Held (the brace).
        name: 'step-plant',
        durationMs: 260,
        holdMs: 500,
        root: { orient: { pitchDeg: 4 } },
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 14 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 4 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -6 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 8 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 8 },
        ],
      },
      {
        // PUSH BACK: the front foot pushes the body back over the stance foot;
        // the stepping leg lifts and swings back (pitch eases toward upright).
        name: 'push-back',
        durationMs: 450,
        root: { orient: { pitchDeg: 2 } },
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 18 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 30 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 2 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 2 },
        ],
      },
      {
        // FEET RE-LEVEL: the stepping foot sets back down beside the stance
        // foot; quiet stance resumes (body fully upright).
        name: 'settle',
        durationMs: 500,
        holdMs: 350,
        root: { orient: { pitchDeg: 0 } },
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
        ],
      },
    ],
    source: VERIFY,
  },
];
