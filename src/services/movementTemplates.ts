/**
 * CLINICIAN-AUTHORED MOVEMENT TEMPLATES — reference material for the *content*
 * of core clinical movements.
 *
 * WHY. The composer's ROM limits are sourced (AAOS / Norkin & White) and every
 * frame is measured, but the SHAPE of a movement — which joints participate, to
 * what peak angles, in what timing and coordination — was previously left to the
 * language model's own knowledge. These templates encode that shape explicitly,
 * as a small library of the core movements, so the model has an authored anchor
 * to fill the blanks around instead of guessing from scratch.
 *
 * Each template captures the three things that make a movement recognizable:
 *   • PEAK ANGLES     — the magnitude each joint reaches (per phase).
 *   • TIMING          — phase durations + which phases hold (the tempo).
 *   • COORDINATION    — which joints move together and in what ratio.
 *
 * Two uses, from ONE source of truth:
 *   1. {@link describeMovementTemplates} renders the library into the compose
 *      tool's prompt, so the planner anchors on real coordination.
 *   2. {@link templateToComposedMotion} turns a template into a playable,
 *      measurable ComposedMotion — which lets the test-suite RESOLVE each
 *      template through the real ROM path (proving every peak is within
 *      normative range) and SAMPLE it on the rig (proving the authored
 *      coordination is achievable and measures back to the authored peaks).
 *
 * These values are clinician-authored from standard kinesiology (e.g. Neumann,
 * *Kinesiology of the Musculoskeletal System*; scapulohumeral rhythm ~2:1) and
 * are flagged for SME verification, exactly like the ROM registry — they are a
 * reviewed reference, not mocap.
 */

import * as THREE from 'three';
import { SPINE_NECK_MAX, SPINE_NECK_LATERAL_MAX } from './motionSequence';
import type { ComposedMotion, MovementAsymmetry, PostureNode, SemanticTravel, SequenceKeyframe, SequenceTarget, StanceContact, StanceMode } from './motionSequence';

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
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 20, peakAt: 0.8 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 20, peakAt: 0.8 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 27 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 10 },
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
      'The defining feature is the forward trunk/hip lean ("nose over toes") that brings the centre of mass over the feet BEFORE the hips and knees extend to rise — flexion momentum first, then extension [Schenkman 1990: flexion-momentum → momentum-transfer → extension]. The lean is HIP-DRIVEN with a relatively PRESERVED lumbar lordosis (only slight lumbar flexion) — heavy lumbar flexion is a compensatory/faulty pattern, not the healthy norm. Bilateral, planted. (No chair prop; the seated depth is the hip/knee flexion hold.)',
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
        ],
      },
      {
        name: 'rise-to-stand',
        durationMs: 800,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 0 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 0 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'Spine_Lower', motion: 'flexion', peakDeg: 0 },
          { joint: 'Spine_Upper', motion: 'flexion', peakDeg: 0 },
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

/** Turn a template into a playable, measurable ComposedMotion (starts from
 *  anatomic neutral). The engine then clamps + measures it like any motion. */
export function templateToComposedMotion(t: MovementTemplate): ComposedMotion {
  const keyframes: SequenceKeyframe[] = t.phases.map((p) => ({
    targets: p.targets.map((x) => ({
      joint: x.joint,
      motion: x.motion,
      targetDegrees: x.peakDeg,
      ...(x.peakAt != null ? { peakAt: x.peakAt } : {}),
    })),
    durationMs: p.durationMs,
    ...(p.holdMs ? { holdMs: p.holdMs } : {}),
    ...(p.stance ? { stance: p.stance } : {}),
    ...(p.travel ? { travel: p.travel } : {}),
    ...(p.root ? { root: p.root } : {}),
  }));
  // Phase-indexed contact windows → absolute-ms StanceContact windows (a phase's
  // window covers its travel AND its hold). Phase boundaries are preserved by
  // peakAt expansion, so the ms windows stay exact through resolve.
  let contacts: StanceContact[] | undefined;
  if (t.contacts?.length) {
    const startOf: number[] = [];
    const endOf: number[] = [];
    let acc = 0;
    for (const p of t.phases) {
      startOf.push(acc);
      acc += p.durationMs + (p.holdMs ?? 0);
      endOf.push(acc);
    }
    contacts = t.contacts.map((c) => ({
      foot: c.foot,
      ...(c.fromPhase != null ? { fromMs: startOf[c.fromPhase] ?? 0 } : {}),
      ...(c.toPhase != null ? { toMs: endOf[c.toPhase] ?? acc } : {}),
    }));
  }
  return {
    name: t.id,
    startFrom: 'neutral',
    stance: t.stance,
    ...(t.loop ? { loop: true } : {}),
    ...(t.balanceAssist ? { balanceAssist: true } : {}),
    ...(contacts ? { contacts } : {}),
    keyframes,
  };
}

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

export function buildTravelWalk(opts: { speed?: number; headingDeg?: number } = {}): ComposedMotion {
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
  const coordinated = spinalGaitCoordination(
    { ...base, keyframes: kfs },
    { shuttleAbsorb: { phaseAt: shuttlePhaseAt, deg: GAIT_SHUTTLE_ABSORB_DEG } },
  );
  // TRAVEL HEADING FOLD: add the heading yaw to EVERY keyframe's root orient —
  // AFTER the coordination pass, whose per-keyframe pelvic rotation writes its
  // own yawDeg (folding before it would let the ±2° pelvis yaw overwrite the
  // heading). The initiation (pelvic yaw 0) lands at exactly headingDeg, so the
  // entry slerp IS the pre-walk pivot; the cycle then carries heading + pelvic
  // yaw. Explicit on every keyframe — carry-forward is never relied on.
  // Heading 0 skips the fold entirely (byte-identical keyframes).
  const headed =
    headingDeg === 0
      ? coordinated.keyframes
      : coordinated.keyframes.map((kf) => ({
          ...kf,
          root: {
            ...(kf.root ?? {}),
            orient: { ...(kf.root?.orient ?? {}), yawDeg: (kf.root?.orient?.yawDeg ?? 0) + headingDeg },
          },
        }));
  return {
    name: 'walk-forward',
    startFrom: 'current',
    stance: 'planted',
    ...(coordinated.modifiers ? { modifiers: coordinated.modifiers } : {}),
    keyframes: headed,
    footDrivenTravel: true,
    // The heading the derived travel rides along (and the shuttle stays
    // perpendicular to) — omitted at 0 so the straight walk is byte-identical.
    ...(headingDeg !== 0 ? { headingDeg } : {}),
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
    travel: { direction: 'up', meters: 0.06 },
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
    travel: { direction: 'up', meters: apexM },
    // Toes reset to neutral in flight (the push-off MTP extension releases at toe-off).
    targets: [...legs(5, 25, 0), ...toes(0), ...arms(150)],
  });
  const descent = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.3), velocityClass: 'ballistic', stance: 'floating',
    travel: { direction: 'up', meters: apexM * 0.5 },
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
    travel: { direction: 'up', meters: 0 },
    targets: [...legs(10, 18, 0), ...arms(30)],
  });
  const absorb = (): SequenceKeyframe => ({
    durationMs: 180, holdMs: 70, velocityClass: 'functional', stance: 'planted',
    travel: { direction: 'up', meters: 0 },
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

/**
 * A real kinematic RUN — a looping, in-place running gait with a genuine FLIGHT
 * phase (both feet off the ground between steps, unlike walk's double-support).
 * Each cycle: stance-drive on one leg (deep knee absorption + toe push) → FLIGHT
 * (floating, the body rises ~12 cm and BOTH feet are airborne) → stance on the
 * other leg → flight. Higher hip/knee flexion + a forward trunk lean give running
 * form; arms pump reciprocally (opposite the swinging leg). `speed` couples stride
 * amplitude and cadence (√speed each, like paceGait). Loops seamlessly. The floating
 * phases are NOT floor-pinned, so the up-travel genuinely lifts the body — the feet
 * leave the ground (contrast the in-place walk, which keeps one foot planted).
 */
export function buildRun(opts: { speed?: number } = {}): ComposedMotion {
  const s = Math.min(1.6, Math.max(0.6, Number.isFinite(opts.speed ?? 1) ? opts.speed ?? 1 : 1));
  const f = Math.sqrt(s);
  const RISE_M = 0.12; // COM rise during flight — both feet clear the ground
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
  const durStance = Math.round(150 / f);
  // Flight duration derives from the physical airtime of the rise (half the full
  // 2√(2h/g) — the flight keyframe is half the airborne interval, the stance
  // transitions carry the rest), then speed-scaled. The trajectory shapes the arc
  // as a constant-g parabola.
  const durFlight = Math.round((ballisticFlightMs(RISE_M) * 0.5) / f);

  // Stance on `st`: that leg supports (mild flex + toe push); the other swings with
  // a high knee; the arm OPPOSITE the swing leg drives forward (reciprocal).
  const stance = (st: 'L' | 'R'): SequenceKeyframe => {
    const sw = st === 'L' ? 'R' : 'L'; // swing leg
    return {
      durationMs: durStance,
      holdMs: 20,
      stance: 'planted',
      velocityClass: 'functional',
      travel: { direction: 'up', meters: 0 },
      targets: [
        ...leg(st, 14, 38, -8), // support leg: absorb + push off
        ...leg(sw, 58, 95, 0), // swing leg: high knee
        ...arm(st, 48), // arm opposite the swing leg (= the stance side) forward
        ...arm(sw, -18), // the other arm back
        ...trunk,
      ],
    };
  };
  // Flight after `pushed` leg drove off: it trails behind (hip extension), the other
  // leads and descends toward the next contact. FLOATING + up-travel → airborne.
  const flight = (pushed: 'L' | 'R'): SequenceKeyframe => {
    const lead = pushed === 'L' ? 'R' : 'L';
    return {
      durationMs: durFlight,
      velocityClass: 'ballistic',
      stance: 'floating',
      travel: { direction: 'up', meters: RISE_M },
      targets: [
        ...leg(pushed, -18, 28, -15), // trailing leg: extended behind, plantarflexed
        ...leg(lead, 45, 55, 0), // leading leg: descending from the high-knee
        ...arm(pushed, 18),
        ...arm(lead, 5),
        ...trunk,
      ],
    };
  };

  // Natural trunk coordination — thoracic counter-rotation with the pumping arms +
  // lateral sway toward the stance leg. Bigger arm swing at speed ⇒ bigger trunk
  // rotation, for free. Root/feet untouched (spine is above the hips).
  return spinalGaitCoordination({
    name: 'run',
    startFrom: 'neutral',
    stance: 'planted',
    loop: true,
    keyframes: [stance('R'), flight('R'), stance('L'), flight('L')],
  });
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
    travel: { direction: 'up', meters: 0.05 },
    targets: [...supLeg(5, 12, -25), ...held(), ...arms(60), ...trunk(2), ...counter()],
  });
  const apex = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.5), velocityClass: 'ballistic', stance: 'floating',
    travel: { direction: 'up', meters: apexM },
    targets: [...supLeg(18, 32, -5), ...held(), ...arms(40), ...counter()],
  });
  const descent = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.3), velocityClass: 'ballistic', stance: 'floating',
    travel: { direction: 'up', meters: apexM * 0.5 },
    targets: [...supLeg(15, 20, 0), ...held(), ...arms(25), ...counter()], // reaching DOWN toward contact
  });
  // TOUCHDOWN: near-extended support leg so the foot reaches the floor where the
  // parabola lands (root Y≈0), THEN absorb — else the pin snaps the body down to
  // ground a deep-crouch contact (see buildJump). Trunk leans forward over the
  // landing foot (counterbalance: the crouch pulls the pelvis behind the heel).
  const touchdown = (): SequenceKeyframe => ({
    durationMs: Math.round(flightMs * 0.2), velocityClass: 'ballistic', stance: 'planted',
    travel: { direction: 'up', meters: 0 },
    targets: [...supLeg(20, 24, 0), ...held(), ...arms(18), ...trunk(8), ...counter()],
  });
  const absorb = (): SequenceKeyframe => ({
    durationMs: 170, holdMs: 60, velocityClass: 'functional', stance: 'planted',
    travel: { direction: 'up', meters: 0 },
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
  ...bilatLeg(0, 0, 40),
];

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

/** Upright-kneel legs: shins folded to lie on the floor (hip 15 / knee 110 / ankle −60
 *  lands the knee + toes at the floor), torso stacked vertically over the thighs. */
const kneelLegs = (): SequenceTarget[] => bilatLeg(15, 110, -60);

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

/** Real free-gait COM vertical excursion is ~4-5 cm peak-to-peak at a comfortable
 *  cadence [Perry & Burnfield; Gard & Childress]. This is the calibrated NORMAL
 *  target; {@link gaitBounce} scales around it. */
export const NORMAL_GAIT_VERTICAL_CM = 5;

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
  const s = Math.min(1.5, Math.max(0.4, Number.isFinite(speed) ? speed : 1));
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

/** The joints whose amplitude IS the arm swing — scaled by {@link scaleArmSwing}. */
const ARM_SWING_MOTIONS = new Set(['shoulderFlexion']);

/**
 * Scale a gait motion's ARM SWING amplitude by `amount` (0..1), holding cadence
 * and every leg/trunk angle. `amount` 1 = the authored reciprocal swing;
 * 0 = arms held still at the side (the reduced/absent arm swing of Parkinsonian
 * or hemiplegic gait). Multiplies only the `shoulderFlexion` targets — so unlike
 * `paceGait` it sets NO `timeScale` (the walk keeps its speed; only the arms
 * quiet down) and leaves the reciprocal elbow pump and every leg angle untouched.
 * Pure; returns a new motion; over/under-range values are clamped by the normal
 * ROM path on resolve, so the clinical readout stays honest.
 */
export function scaleArmSwing(motion: ComposedMotion, amount: number): ComposedMotion {
  const a = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 1));
  if (a === 1) return motion; // identity — keep it byte-for-byte
  const keyframes = motion.keyframes.map((kf) => ({
    ...kf,
    ...(kf.targets
      ? {
          targets: kf.targets.map((t) =>
            ARM_SWING_MOTIONS.has(t.motion) ? { ...t, targetDegrees: t.targetDegrees * a } : t,
          ),
        }
      : {}),
  }));
  return { ...motion, keyframes };
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
  const keyframes = motion.keyframes.map((kf) => ({
    ...kf,
    ...(kf.targets
      ? {
          targets: kf.targets.map((t) => {
            if (!t.joint.startsWith(prefix)) return t;
            let f = 1;
            if (rom != null) f *= rom;
            if (step != null && ASYMMETRY_STRIDE_MOTIONS.has(t.motion)) f *= step;
            if (arm != null && ARM_SWING_MOTIONS.has(t.motion)) f *= arm;
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
function addSustainedTargets(
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
 * ANTALGIC / compensated-Trendelenburg trunk lean — hold a sustained lateral trunk
 * lean TOWARD `side` (over the involved/painful stance limb, shifting the COM to
 * unload it) through the whole movement. Lumbar leads, thoracic follows at half.
 * `lateralTilt` + = left, so a left lean is positive. Pure; ROM-clamped on resolve.
 */
export function antalgicLean(motion: ComposedMotion, side: 'left' | 'right', deg = 12): ComposedMotion {
  const d = Math.max(0, Math.min(25, Number.isFinite(deg) ? deg : 0));
  const sign = side === 'left' ? 1 : -1;
  return addSustainedTargets(motion, [
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
// Transverse pelvic-rotation cap (root yaw). Real free-gait pelvic rotation is ~±4°; 6°
// leaves a little headroom for speed while staying in a natural range (a bigger pelvic
// yaw reads as a twist/shimmy AND drags the planted foot, since the walk grounds the feet
// with a vertical pin, not a horizontal foot-lock IK — see kPel calibration below).
const PELVIS_YAW_MAX = 6;
// Step-off entry duration (ms) for a travelling walk: the neutral→first-gait-pose
// transition covers a big limb delta (~40° knee), so give it ~2 gait phases of time so
// the limbs ease in at stride cadence instead of whipping (a normal 200 ms phase would
// demand ~300°/s). ~natural gait initiation; the cycle phases themselves stay 200 ms.
const GAIT_STEP_OFF_MS = 400;
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
/** The R ankle's rest offset from the root axis, m (rig-measured on the male
 *  runtime GLB at anatomic stance) — the pivot centre of a headed walk's
 *  initiation: the root translate t = p_R − R(heading)·p_R re-centres the
 *  entry yaw on the planted stance foot so it doesn't arc sideways. */
const GAIT_STANCE_FOOT_X_M = -0.083;
const GAIT_STANCE_FOOT_Z_M = -0.029;
const GAIT_APA_SHIFT_M = 0.012; // authored pelvis shift toward the stance (R) foot, m (−X)
const GAIT_APA_LUMBAR_DEG = -1.2; // lumbar list over the stance foot (lateralTilt + = left)
const GAIT_APA_THORACIC_DEG = 2.0; // thoracic counter-list keeps the head centred
const GAIT_APA_NECK_DEG = -0.8; // levels the head against the authored S-curve's residual
const GAIT_APA_KNEE_DEG = 5; // future swing (L) knee unweights
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
// ─── Limb non-sagittal gait coordination ─────────────────────────────────────
// Real gait limbs move in all THREE planes; a purely sagittal swing (flexion only) reads
// as a robotic 2-D walker. These add SUBTLE frontal + transverse components — physiologic
// amounts, well inside ROM — derived per-limb from that limb's own sagittal phase, so the
// arms and legs carry natural out-of-plane motion. ROM-clamped on resolve.
const ARM_ADD_BASE = 5; // shoulder ADduction: the arm hangs IN close to the body…
const ARM_ADD_SWING = 0.1; // …and comes a touch more across on the forward swing
const ARM_ADD_MAX = 12; // (not winged OUT — abduction reads as a stiff gunslinger carriage)
const ARM_PRO_BASE = 12; // forearm pronation: palm toward the thigh, not a rigid stick
const ARM_PRO_SWING = 0.12;
const ARM_PRO_MAX = 28;
const SCAP_PROT_GAIN = 0.35; // scapular protraction/retraction: the shoulder GIRDLE glides
const SCAP_PROT_MAX = 10; // fore/aft on the ribcage WITH the arm swing (protract on the
// forward swing, retract on the backswing) — arm swing isn't purely glenohumeral. Coupled
// to the same arm's flexion, so the two scapulae counter-phase like a real girdle.
const WRIST_FLEX_BASE = 10; // a relaxed swinging hand isn't a rigid paddle: the wrist carries
const WRIST_DRAG = 0.28; // a slight resting flexion and DRAGS behind the forearm — trailing
const WRIST_FLEX_MAX = 22; // (less flexion on the forward swing, more on the backswing).
const FINGER_CURL_DEG = 32; // the fingers rest gently CURLED (a loose relaxed hand), not
// splayed straight. Constant posture (carried across the cycle), applied per digit.
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
 * Only `rotation` + `lateralTilt` on the spine — NEVER sagittal `flexion`, which
 * would shift the world-anchored shoulderFlexion motor (trunkSum). Feet, leg angles
 * and every graded driver are untouched (the spine sits above the hips). Additive on
 * any existing spine target (e.g. an antalgic lean), ROM-clamped on resolve. Identity
 * when both gains are 0. Sign of `rotation` follows romRegistry (+ = toward-R); the
 * chosen phase brings the leading arm's shoulder forward — a visual-tuning choice.
 */
export function spinalGaitCoordination(
  motion: ComposedMotion,
  opts: {
    axial?: number;
    lateral?: number;
    headStabilize?: number;
    pelvis?: number;
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
  const headStab = Math.max(0, Math.min(1, opts.headStabilize ?? 1));
  // PELVIC transverse rotation gain — the hallmark determinant of gait (the pelvis rotates
  // forward on the SWING side). Derived from the same leg asymmetry as the lean, so it is
  // intrinsically in phase with the stride. 0.05 lands ~±2° pelvic yaw for the walk — the
  // most the vertical-pin grounding allows before the planted foot visibly slides (a
  // higher gain skates the stance foot; rig-swept). A real foot-lock IK would let this go
  // to the full physiological ~±4°.
  const kPel = Math.max(0, opts.pelvis ?? 0.05);
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
    const lean = -kLat * hipDiff * airborne; // lean toward the stance (less-flexed) hip
    // SHUTTLE-ABSORB counter-lean: opposite the pelvis shuttle (phase is +X-ward,
    // lateralTilt + = toward subject-left/+X, so −phase counters it), split
    // lumbar/thoracic so the tilt sits low (long lever, minimal thorax roll).
    const shuttleLean = shuttleAbsorb ? -shuttleAbsorb.deg * shuttleAbsorb.phaseAt(arriveMs[kfIndex]!) : 0;
    const leanLower = cap(lean + 0.45 * shuttleLean, SPINE_LATERAL_MAX);
    // The thoracic COUNTER-lists (an S-curve): the lumbar lists toward the stance limb
    // (the physiologic weight shift), but the upper trunk leans back the other way so the
    // shoulders — and the head above them — stay centred over the base. A person's head
    // barely bobs laterally in gait (vestibular stabilisation); compounding the lean at the
    // top (the old +0.5) threw the head side-to-side. Neck leveling handles the residual.
    const leanUpper = cap(-0.6 * lean + 0.55 * shuttleLean, SPINE_LATERAL_MAX);
    // PELVIC ROTATION (root yaw): the swing side rotates forward. Counter-phase to the
    // thorax (below), so the pelvis and shoulder girdle COUNTER-ROTATE about the spine —
    // the real transverse-plane engine of gait. The hips counter-rotate by −pelvisYaw so
    // the planted feet keep pointing down the line of travel (no swivel) while the pelvis
    // turns; and the neck cancels the root yaw too, so the gaze still holds forward.
    const pelvisYaw = cap(kPel * hipDiff, PELVIS_YAW_MAX);
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
    const neckLateral = cap(
      -headStab * (leanLower + leanUpper) + NECK_AXIAL_ROLL_COMP * neckAxial,
      SPINE_NECK_LATERAL_MAX,
    );
    const additions: { joint: string; motion: string; deg: number }[] = [
      { joint: 'Spine_Upper', motion: 'rotation', deg: thoracic },
      { joint: 'Spine_Lower', motion: 'rotation', deg: lumbar },
      { joint: 'Neck', motion: 'rotation', deg: neckAxial },
      { joint: 'Spine_Lower', motion: 'lateralTilt', deg: leanLower },
      { joint: 'Spine_Upper', motion: 'lateralTilt', deg: leanUpper },
      { joint: 'Neck', motion: 'lateralTilt', deg: neckLateral },
      // Hips counter-rotate the pelvic yaw so the femurs (and planted feet) keep facing
      // down the line of travel — the pelvis turns ABOUT the stance leg, the foot barely
      // swivels (rig-measured near-0 on the stance leg). Same sign on both legs (the
      // hipRotation motor is NOT mirrored in world yaw — verified on the rig).
      { joint: 'L_UpLeg', motion: 'hipRotation', deg: -pelvisYaw },
      { joint: 'R_UpLeg', motion: 'hipRotation', deg: -pelvisYaw },
    ];
    // LIMB NON-SAGITTAL COORDINATION — subtle frontal/transverse limb motion so the arms
    // and legs don't swing as flat 2-D pendulums. Per-limb, from that limb's own sagittal
    // phase; each gated on the limb having its sagittal driver (so it only touches a gait
    // keyframe, never a spine-only motion run through here).
    const has = (joint: string, mo: string): boolean => ts.some((t) => t.joint === joint && t.motion === mo);
    for (const S of ['L', 'R'] as const) {
      // ARM: hangs IN close to the body — a slight ADduction (−shoulderAbduction), a touch
      // more across on the forward swing — NOT winged out; and semi-PRONATED (palm toward
      // the thigh). The resting arm carriage a rigid straight swing lacks.
      if (has(`${S}_UpperArm`, 'shoulderFlexion')) {
        const sh = at(ts, `${S}_UpperArm`, 'shoulderFlexion');
        additions.push({ joint: `${S}_UpperArm`, motion: 'shoulderAbduction', deg: cap(-(ARM_ADD_BASE + ARM_ADD_SWING * sh), ARM_ADD_MAX) });
        if (has(`${S}_Forearm`, 'elbowFlexion'))
          additions.push({ joint: `${S}_Forearm`, motion: 'forearmRotation', deg: cap(ARM_PRO_BASE + ARM_PRO_SWING * sh, ARM_PRO_MAX) });
        // Scapular girdle glides fore/aft WITH the arm: protract on the forward swing
        // (sh > 0), retract on the backswing (sh < 0). + protraction = Pro (romRegistry).
        additions.push({ joint: `${S}_Shoulder`, motion: 'protraction', deg: cap(SCAP_PROT_GAIN * sh, SCAP_PROT_MAX) });
        // WRIST: a relaxed hand isn't a rigid paddle — it holds a slight resting flexion and
        // DRAGS behind the forearm (less flexion as the arm swings forward, more on the
        // backswing), so the hand passively wobbles with the swing instead of locking stiff.
        additions.push({ joint: `${S}_Hand`, motion: 'wristFlexion', deg: cap(WRIST_FLEX_BASE - WRIST_DRAG * sh, WRIST_FLEX_MAX) });
        // FINGERS: rest gently curled (a loose relaxed hand), not splayed rigid-straight.
        for (const fk of ['Thumb1', 'Index1', 'Mid1', 'Ring1', 'Pinky1'] as const)
          additions.push({ joint: `${S}_${fk}`, motion: 'fingerFlexion', deg: FINGER_CURL_DEG });
      }
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
    // Root transverse yaw = the pelvic rotation (merged with any existing root directive).
    const kfOut: SequenceKeyframe = { ...kf, targets };
    if (Math.abs(pelvisYaw) >= 1e-6) {
      kfOut.root = { ...(kf.root ?? {}), orient: { ...(kf.root?.orient ?? {}), yawDeg: pelvisYaw } };
    }
    return kfOut;
  });
  return { ...motion, keyframes };
}

// ─── Compensatory-fault taxonomy ────────────────────────────────────────────
// A buildable set of movement FAULTS a clinician can request as a deviation to
// overlay on any movement. Each writes SUSTAINED, ROM-clamped targets on
// live-commandable DOF (via addSustainedTargets), so the fault reads back on the
// goniometry chart — it is a real authored angle, not a cosmetic overlay. Faults
// on DOF without a large commandable frontal/rotary axis (e.g. knee valgus) are
// authored at their true PROXIMAL driver (the hip). Pure; compose freely.

/** A named compensatory fault the interpreter maps to one of the transforms below. */
export type CompensatoryFault =
  | 'knee-valgus'
  | 'forward-head'
  | 'circumduction'
  | 'compensated-trendelenburg'
  | 'genu-recurvatum';

const sidePrefix = (side: 'left' | 'right') => (side === 'left' ? 'L_' : 'R_');

/**
 * DYNAMIC KNEE VALGUS via the hip (medial knee collapse). The knee has no large
 * commandable frontal DOF (`kneeDeviation` is a ±5° readout), so valgus is authored
 * at its true proximal driver: the femur ADDUCTS and INTERNALLY ROTATES, carrying
 * the knee medially. Sustained on the given side, or BOTH legs when omitted (the
 * classic bilateral squat/landing collapse). `hipAbduction` − = adduction;
 * `hipRotation` + = internal. Pure; ROM-clamped on resolve.
 */
export function kneeValgus(motion: ComposedMotion, side?: 'left' | 'right', deg = 12): ComposedMotion {
  const d = Math.max(0, Math.min(25, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const legs = side ? [sidePrefix(side)] : ['L_', 'R_'];
  const add = legs.flatMap((p) => [
    { joint: `${p}UpLeg`, motion: 'hipAbduction', deg: -d }, // adduction
    { joint: `${p}UpLeg`, motion: 'hipRotation', deg: Math.round(d * 0.8) }, // internal
  ]);
  return addSustainedTargets(motion, add);
}

/**
 * FORWARD-HEAD posture — sustained cervical flexion with a rounded upper back, so
 * the head juts anteriorly. Neck flexion `deg`, thoracic flexion at half. Pure;
 * ROM-clamped on resolve. A postural fault to overlay on any movement.
 */
export function forwardHead(motion: ComposedMotion, deg = 15): ComposedMotion {
  const d = Math.max(0, Math.min(35, Number.isFinite(deg) ? deg : 0));
  return addSustainedTargets(motion, [
    { joint: 'Neck', motion: 'flexion', deg: d },
    { joint: 'Spine_Upper', motion: 'flexion', deg: Math.round(d * 0.5) },
  ]);
}

/**
 * CIRCUMDUCTION + contralateral VAULT — a swing-phase gait deviation compensating
 * for a functionally long / stiff swing leg (reduced knee flexion): the swing hip
 * ABDUCTS to arc the foot around and clear the floor, while the STANCE side vaults
 * (plantarflexes to lift the body over the planted foot). `side` = the swinging /
 * involved leg. Sustained hip abduction on `side` + plantarflexion (negative
 * ankleFlexion) on the contralateral ankle. Pure; ROM-clamped on resolve. Best over
 * a gait (needs a swing leg).
 */
export function circumduction(motion: ComposedMotion, side: 'left' | 'right' = 'right', deg = 15): ComposedMotion {
  const d = Math.max(0, Math.min(30, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const swing = sidePrefix(side);
  const stance = side === 'left' ? 'R_' : 'L_';
  return addSustainedTargets(motion, [
    { joint: `${swing}UpLeg`, motion: 'hipAbduction', deg: d }, // arc the swing leg out
    { joint: `${stance}Foot`, motion: 'ankleFlexion', deg: -Math.round(d * 0.6) }, // vault (plantarflex)
  ]);
}

/**
 * GENU RECURVATUM — sustained knee HYPEREXTENSION (the knee bows backward past 0).
 * Adds a negative `kneeFlexion` on the given knee, or BOTH when omitted. Relies on
 * the widened `kneeFlexion` ROM min (romRegistry) so the hyperextension isn't
 * clamped away. Pure; ROM-clamped on resolve. A stance / gait posture fault.
 */
export function genuRecurvatum(motion: ComposedMotion, side?: 'left' | 'right', deg = 10): ComposedMotion {
  const d = Math.max(0, Math.min(15, Number.isFinite(deg) ? deg : 0));
  if (d === 0) return motion;
  const legs = side ? [sidePrefix(side)] : ['L_', 'R_'];
  return addSustainedTargets(
    motion,
    legs.map((p) => ({ joint: `${p}Leg`, motion: 'kneeFlexion', deg: -d })),
  );
}

/**
 * Apply a named compensatory fault to a motion. `compensated-trendelenburg` reuses
 * {@link antalgicLean} (the trunk lean over the involved stance limb). `side` steers
 * the unilateral faults (circumduction, compensated-trendelenburg); knee-valgus and
 * genu-recurvatum go BILATERAL when `side` is omitted. Pure; ROM-clamped on resolve.
 */
export function applyFault(
  motion: ComposedMotion,
  fault: CompensatoryFault,
  side?: 'left' | 'right',
  deg?: number,
): ComposedMotion {
  switch (fault) {
    case 'knee-valgus':
      return kneeValgus(motion, side, deg);
    case 'forward-head':
      return forwardHead(motion, deg);
    case 'circumduction':
      return circumduction(motion, side ?? 'right', deg);
    case 'compensated-trendelenburg':
      return antalgicLean(motion, side ?? 'right', deg ?? 12);
    case 'genu-recurvatum':
      return genuRecurvatum(motion, side, deg);
    default:
      return motion;
  }
}

/** Select the template whose aliases best match a free-text instruction, or null. */
export function findMovementTemplate(instruction: string): MovementTemplate | null {
  const text = instruction.toLowerCase();
  let best: MovementTemplate | null = null;
  let bestLen = 0;
  for (const t of MOVEMENT_TEMPLATES) {
    for (const a of t.aliases) {
      if (text.includes(a) && a.length > bestLen) {
        best = t;
        bestLen = a.length;
      }
    }
  }
  return best;
}

/** Render the whole library as a compact reference block for the planner prompt:
 *  each movement's phases (timing), peak angles, and coordination. */
export function describeMovementTemplates(): string {
  const lines: string[] = [];
  for (const t of MOVEMENT_TEMPLATES) {
    const phases = t.phases
      .map((p) => {
        const peaks = p.targets
          .map((x) => `${x.joint}.${x.motion} ${x.peakDeg}°`)
          .join(', ');
        const hold = p.holdMs ? ` hold ${p.holdMs}ms` : '';
        return `${p.name} (${p.durationMs}ms${hold}): ${peaks}`;
      })
      .join(' | ');
    lines.push(
      `• ${t.label} [${t.stance}${t.loop ? ', loops' : ''}] — ${t.coordination} PHASES: ${phases}`,
    );
  }
  return lines.join('\n');
}
