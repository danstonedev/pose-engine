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

import type { ComposedMotion, MovementAsymmetry, SequenceKeyframe, StanceMode } from './motionSequence';

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
      'One full gait cycle authored as 8 phases (both steps), looping. Sagittal peaks per normal free gait [Perry & Burnfield; Neumann]: hip 30° flexion at initial contact → −10° extension at terminal stance; knee ~5° at contact, ~18° loading-response shock absorption, ~40° at pre-swing, ~60° peak in initial swing; ankle rockers — plantarflexion to foot-flat after contact (−8°), dorsiflexion to 10° as the tibia advances over the stance foot, push-off plantarflexion −15° at pre-swing. Reciprocal arm swing ~±20° shoulder flexion, each arm peaking WITH the contralateral leg. The elbows are NOT rigid: they carry ~20° flexion and pump through the swing (overlapping action — more flexion on the backswing, unwinding as the arm comes forward, ~11-30°), so the forearms swing dynamically instead of marching stiff-armed [Elftman 1939; normal arm-swing elbow excursion ~10-20°]. Presented IN PLACE (treadmill convention — no root travel) so the looping cycle stays on stage; the pre-swing knee flexion + push-off happens across the loop seam (last phase flows back into the first). Planted.',
    stance: 'planted',
    loop: true,
    phases: [
      {
        name: 'right-initial-contact',
        durationMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 40 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -15 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 11 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 29 },
        ],
      },
      {
        name: 'right-loading-response',
        durationMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 25 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 18 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -8 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 60 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -5 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 12 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -12 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 15 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 25 },
        ],
      },
      {
        name: 'right-mid-stance',
        durationMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 8 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 5 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 20 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 45 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 20 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 20 },
        ],
      },
      {
        name: 'right-terminal-stance',
        durationMs: 200,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 10 },
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 29 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 11 },
        ],
      },
      {
        name: 'left-initial-contact',
        durationMs: 200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 40 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -15 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 11 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 29 },
        ],
      },
      {
        name: 'left-loading-response',
        durationMs: 200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 25 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 18 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -8 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 60 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -5 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 12 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: -12 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 15 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 25 },
        ],
      },
      {
        name: 'left-mid-stance',
        durationMs: 200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: 5 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 8 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 5 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 20 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 45 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 0 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 20 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 20 },
        ],
      },
      {
        name: 'left-terminal-stance',
        durationMs: 200,
        targets: [
          { joint: 'L_UpLeg', motion: 'hipFlexion', peakDeg: -10 },
          { joint: 'L_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 10 },
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 5 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_UpperArm', motion: 'shoulderFlexion', peakDeg: -20 },
          { joint: 'L_UpperArm', motion: 'shoulderFlexion', peakDeg: 20 },
          { joint: 'R_Forearm', motion: 'elbowFlexion', peakDeg: 29 },
          { joint: 'L_Forearm', motion: 'elbowFlexion', peakDeg: 11 },
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
      'Stand on the left leg and lift the right: the lifted hip flexes ~30° and its knee ~45°, while the trunk stays quiet and level over the stance foot. Long hold = the balance challenge. Planted (stance leg).',
    stance: 'planted',
    phases: [
      {
        name: 'lift-and-balance',
        durationMs: 700,
        holdMs: 1500,
        targets: [
          { joint: 'R_UpLeg', motion: 'hipFlexion', peakDeg: 30 },
          { joint: 'R_Leg', motion: 'kneeFlexion', peakDeg: 45 },
        ],
      },
      {
        name: 'lower',
        durationMs: 700,
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
      'Bilateral ankle plantarflexion: rise up onto the balls of the feet so both heels lift, hold at the top, then lower under control back to flat. A gastrocnemius-soleus screen. Planted (the forefoot/toes stay grounded as the pivot; the closed-chain floor-pin lifts the body so the heels rise). Normative standing plantarflexion AROM ~50°; ~35° is a full functional raise.',
    stance: 'planted',
    phases: [
      {
        name: 'rise-to-toes',
        durationMs: 800,
        holdMs: 500,
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: -35 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: -35 },
        ],
      },
      {
        name: 'lower-to-flat',
        durationMs: 800,
        targets: [
          { joint: 'L_Foot', motion: 'ankleFlexion', peakDeg: 0 },
          { joint: 'R_Foot', motion: 'ankleFlexion', peakDeg: 0 },
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
  }));
  return {
    name: t.id,
    startFrom: 'neutral',
    stance: t.stance,
    ...(t.loop ? { loop: true } : {}),
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
export function buildTravelWalk(opts: { speed?: number } = {}): ComposedMotion {
  const walk = MOVEMENT_TEMPLATES.find((t) => t.id === 'walk');
  if (!walk) throw new Error('walk template missing');
  const speed = opts.speed;
  const base =
    speed != null && speed !== 1
      ? paceGait(templateToComposedMotion(walk), speed)
      : templateToComposedMotion(walk);
  return {
    name: 'walk-forward',
    startFrom: 'current',
    stance: 'planted',
    ...(base.modifiers ? { modifiers: base.modifiers } : {}),
    keyframes: base.keyframes,
    footDrivenTravel: true,
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
export function buildJump(opts: { heightM?: number; reps?: number } = {}): ComposedMotion {
  const apexM = Math.max(0.1, Math.min(0.7, opts.heightM ?? 0.4));
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
    targets: [...legs(0, 0, -25), ...arms(150), ...trunk(0)],
  });
  const apex = (): SequenceKeyframe => ({
    durationMs: 260, holdMs: 110, velocityClass: 'ballistic', stance: 'floating',
    travel: { direction: 'up', meters: apexM },
    targets: [...legs(5, 25, 0), ...arms(150)],
  });
  const descent = (): SequenceKeyframe => ({
    durationMs: 200, velocityClass: 'ballistic', stance: 'floating',
    travel: { direction: 'up', meters: 0.03 },
    targets: [...legs(0, 12, -5), ...arms(45)],
  });
  const landing = (): SequenceKeyframe => ({
    durationMs: 240, holdMs: 80, velocityClass: 'functional', stance: 'planted',
    travel: { direction: 'up', meters: 0 },
    targets: [...legs(45, 65, 15), ...arms(20), ...trunk(10)],
  });
  const recovery = (): SequenceKeyframe => ({
    durationMs: 340, stance: 'planted',
    targets: [...legs(0, 0, 0), ...arms(0), ...trunk(0)],
  });

  // REPS via the playback-time `reps` field — the 6-keyframe cycle replays N
  // times at trajectory time, so the plan stays tiny regardless of N (no
  // keyframe duplication, no MAX_KEYFRAMES ceiling). Clamped to a sane set size.
  const reps = Math.max(1, Math.min(50, Math.round(opts.reps ?? 1)));

  return {
    name: reps > 1 ? `vertical jump ×${reps}` : 'vertical jump',
    startFrom: 'neutral',
    stance: 'planted',
    ...(reps > 1 ? { reps } : {}),
    keyframes: [load(), propulsion(), apex(), descent(), landing(), recovery()],
  };
}

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
